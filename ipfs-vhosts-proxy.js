#!/usr/bin/env node

const { URL } = require('url');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const isIP = require('is-ip');
const express = require('express');
const asyncHandler = require('express-async-handler');
const { asyncMiddleware } = require('middleware-async')
const cors = require('cors');
const httpProxy = require('http-proxy');
const yargs = require('yargs');
const yaml = require('yaml');
const axios = require('axios');
const CID = require('cids')
const IpfsClient = require('ipfs-http-client');
const toBuffer = require('it-to-buffer')
const all = require('it-all');
const uint8ArrayConcat = require('uint8arrays/concat')

const NAME_DENY_LIST = [
  'api',
  'content',
  'localhost',
];

const state = {
  vhosts: {
    'hello': 'bafybeictjmxvlw7xuzubam2wuzjruwknbdmnprehzlliba4azjhan7f2fa',
    'alexa': 'QmUZLYaz4tPP61PBVRXAz8awzrPpauHkXRjseQu6TsKgrr',
  },
};

const argv = yargs
  .option('config', {
    alias: 'c',
    describe: 'Path to config file in YAML or JSON',
    type: 'string',
    default: '.ipfs-vhosts-proxy.conf',
  })
  .argv;

const defaultConfig = {
  proxy: {
    hostname: 'localhost',
    address: '0.0.0.0',
    port: null,
    ssl: false,
    keyfile: 'privkey.pem',
    certfile: 'fullchain.pem',
    target: null,
  },
};

function isFile(filePath) {
  try {
    const stat = fs.statSync(path.resolve(filePath));
    return stat.isFile();
  } catch (err) {
    return false;
  }
}

function checkConfig({ proxy, ipfs }) {
  if (!proxy) throw new Error('Missing proxy configuration');

  if (proxy.ssl) {
    if (!isFile(proxy.keyfile)) throw new Error(`proxy.keyfile not found at '${proxy.keyfile}'`);
    if (!isFile(proxy.certfile)) throw new Error(`proxy.certfile not found at '${proxy.certfile}'`);
  }

  if (!ipfs) throw new Error('Missing ipfs configuration');
  if (!ipfs.gateway) throw new Error('Missing ipfs.gateway configuration');
  if (!ipfs.gateway.address) throw new Error('Missing ipfs.gateway.address configuration');

  if (!ipfs.api) throw new Error('Missing ipfs.api configuration');
  if (!ipfs.api.host) throw new Error('Missing ipfs.api.host configuration');
  if (!ipfs.api.port) throw new Error('Missing ipfs.api.port configuration');

  if (!ipfs.ipns) throw new Error('Missing ipfs.ipns configuration');
  if (!ipfs.ipns.key) throw new Error('Missing ipfs.ipns.key configuration');
  if (!ipfs.ipns.name) throw new Error('Missing ipfs.ipns.name configuration');
}

function getConfig() {
  const configPath = path.resolve(argv.config);
  try {
    const stat = fs.statSync(configPath);
    if (!stat.isFile()) {
      throw new Error(`Config path is not a file`);
    }
  } catch (err) {
    console.error(`Config file does not exist at '${configPath}'`);
    process.exit(1);
  }

  const contents = fs.readFileSync(configPath, 'utf-8');

  let values;
  try {
    values = yaml.parse(contents);
  } catch (err) {
    console.log(err);
    try {
      values = JSON.parse(contents);
    } catch (err) {
      console.error('Config file must be in YAML or JSON format');
      process.exit(1);
    }
  }

  const config = {
    debug: values.debug || false,
    proxy: {
      ...defaultConfig.proxy,
      ...(values.proxy || {}),
    },
    ipfs: {
      ...defaultConfig.ipfs,
      ...(values.ipfs || {}),
    },
  };

  try {
    checkConfig(config);
  } catch (err) {
    console.error(`Config error: ${err.message}`)
    process.exit(1);
  }

  return config;
}

function getPort(config) {
  if (config.proxy.port) {
    return config.proxy.port;
  }
  if (config.proxy.ssl) {
    return 443;
  }
  return 80;
}

function createServer(config, requestListener) {
  if (config.proxy.ssl) {
    const keyfilePath = path.resolve(config.proxy.keyfile);
    const certfilePath = path.resolve(config.proxy.certfile);

    return https.createServer({
      key: fs.readFileSync(keyfilePath, 'utf-8'),
      cert: fs.readFileSync(certfilePath, 'utf-8'),
    }, requestListener);
  }

  return http.createServer(requestListener);
}

function isTargetSubdomainsSupported(target) {
  const urlObj = new URL(target);
  return !isIP(urlObj.hostname);
}

async function start() {
  const config = getConfig();
  const app = express();

  const debug = (...args) => {
    if (config.debug) {
      console.log('debug', ...args);
    }
  }

  const ipfs = IpfsClient.create({
    host: config.ipfs.api.host,
    port: config.ipfs.api.port,
  });

  const refreshVhosts = async () => {
    const data = uint8ArrayConcat(await all(ipfs.cat(`/ipns/${config.ipfs.ipns.name}`)))
    const json = new TextDecoder().decode(data);
    state.vhosts = JSON.parse(json);
  };

  const publishVhosts = async () => {
    const { cid } = await ipfs.add(JSON.stringify(state.vhosts));
    await ipfs.name.publish(cid, {
      lifetime: `${365 * 24}h`,
      key: config.ipfs.ipns.key,
    });
  };

  await refreshVhosts();
  const refreshInterval = setInterval(refreshVhosts, 10000);

  const getCIDKeyFromPath = (pathName) => {
    const cidKey = Object.keys(state.vhosts).find((key) => {
      return pathName.match(new RegExp(`^/${key}($|/)`)) !== null;
    });
    if (cidKey) {
      return cidKey;
    }
    return null;
  }

  const getCIDKeyFromHost = (host) => {
    debug('getCIDKeyFromHost.host', host)
    const [hostName] = host.split(':');
    if (isIP(hostName)) {
      return null;
    }

    const [subdomain] = hostName.split('.');
    debug('getCIDKeyFromHost.subdomain', subdomain, Object.keys(state.vhosts).includes(subdomain))
    if (Object.keys(state.vhosts).includes(subdomain)) {
      return subdomain;
    }

    return null;
  };

  const replaceIPFSPath = (pathName, cidKey) => {
    const cid = state.vhosts[cidKey];
    if (cid) {
      return pathName.replace(`/${cidKey}`, `/ipfs/${cid}`)
    }
    return null;
  };

  const getIPFSPathFromCIDKey = (pathName, cidKey) => {
    const cid = state.vhosts[cidKey];
    if (cid) {
      return `/ipfs/${cid}${pathName}`
    }
    return null;
  }

  const getIPFSPathFromPath = (pathName) => {
    const cidKey = getCIDKeyFromPath(pathName);
    return replaceIPFSPath(pathName, cidKey);
  };

  const getIPFSHostFromCIDKey = (host, cidKey) => {
    const cid = state.vhosts[cidKey];
    if (!cid) {
       return null;
    }

    const cidObj = new CID(cid);
    const isV1B32CID = cidObj.version === 1 && cidObj.multibaseName === 'base32';

    const subdomain = isV1B32CID ? cidObj.toString() : cidObj.toV1().toBaseEncodedString('base32');
    return `${subdomain}.ipfs.${host}`;
  }

  const proxy = httpProxy.createProxyServer({});

  proxy.on('proxyReq', (proxyReq, req, res, options) => {
    debug('proxyReq.host', proxyReq.getHeader('host'));
    const cidKey = getCIDKeyFromHost(proxyReq.getHeader('host'));
    debug('proxyReq.host cidKey', cidKey);
    debug('proxyReq.isTargetSubdomainsSupported', isTargetSubdomainsSupported(config.ipfs.gateway.address));
    if (cidKey) {
      if (!isTargetSubdomainsSupported(config.ipfs.gateway.address)) {
        debug('proxyReq.host.newPath', getIPFSPathFromCIDKey(proxyReq.path, cidKey));
        proxyReq.path = getIPFSPathFromCIDKey(proxyReq.path, cidKey);
      }
      return;
    }

    const newPath = getIPFSPathFromPath(proxyReq.path);
    debug('proxyReq.newPath', newPath);
    if (newPath) {
      proxyReq.path = newPath;
    }
  });

  proxy.on('error', (err, req, res) => {
    console.error(err);
    res.writeHead(500, {
      'Content-Type': 'text/plain',
    });
    res.end('Something went wrong.');
  });

  const isValidCID = (str) => {
    try {
      return CID.isCID(new CID(str));
    } catch (err) {
      console.log(err);
      return false;
    }
  };

  const getVhosts = async () => {
    await refreshVhosts();
    return Object.keys(state.vhosts).map((name) => ({
      name,
      cid: state.vhosts[name],
    }));
  };

  const getVhostByName = async (name) => {
    await refreshVhosts();
    if (!state.vhosts[name]) {
      return null;
    }
    return {
      name,
      cid: state.vhosts[name],
    };
  };

  const addVhost = async (name, cid) => {
    await refreshVhosts();
    state.vhosts = {
      ...state.vhosts,
      [name]: cid,
    };
    await publishVhosts();
  }

  const deleteVhostByName = async (name) => {
    await refreshVhosts();
    const copy = { ...state.vhosts };
    delete copy[name];
    state.vhosts = {
      ...copy,
    };
    await publishVhosts();
  };

  app.use('/api', express.json());

  app.get('/api/v1/vhosts', asyncHandler(async (req, res) => {
    const vhosts = await getVhosts();
    res.send(vhosts);
  }));

  app.get('/api/v1/vhosts/:name', asyncHandler(async (req, res) => {
    const { name } = req.params;
    const vhost = await getVhostByName(name);
    if (!vhost) {
      res.status(404).send({
        error: 'not_found',
      });
      return;
    }
    res.send(vhost);
  }));

  app.post('/api/v1/vhosts', asyncHandler(async (req, res) => {
    const {
      name,
      cid,
    } = req.body;

    if (NAME_DENY_LIST.includes(name)) {
      res.status(401).send({
        error: 'name_not_allowed',
      });
      return;
    }

    if (!isValidCID(cid)) {
      res.status(400).send({
        error: 'invalid_cid',
      });
      return;
    }
    await addVhost(name, cid);

    res.status(201).send();
  }));

  app.put('/api/v1/vhosts/:name', asyncHandler(async (req, res) => {
    const { name } = req.params;
    const { cid } = req.body;

    const vhost = getVhostByName(name);
    if (!vhost) {
      res.status(404).send({
        error: 'not_found',
      });
      return;
    }

    if (!isValidCID(cid)) {
      res.status(400).send({
        error: 'invalid_cid',
      });
      return;
    }

    await addVhost(name, cid);

    res.status(201).send();
  }));

  app.delete('/api/v1/vhosts/:name', asyncHandler(async (req, res) => {
    const { name } = req.params;

    const vhost = getVhostByName(name);
    if (!vhost) {
      res.status(404).send({
        error: 'not_found',
      });
      return;
    }

    await deleteVhostByName(name);

    res.send();
  }));

  app.use((req, res) => {
    let target = config.ipfs.gateway.address;
    debug('req.target1', target);
    debug('req.host', req.headers.host);
    const cidKey = getCIDKeyFromHost(req.headers.host);
    debug('req.cidKey', cidKey);
    if (cidKey) {
      debug('req.isTargetSubdomainsSupported', isTargetSubdomainsSupported(config.ipfs.gateway.address));
      if (isTargetSubdomainsSupported(config.ipfs.gateway.address)) {
        const targetURLObj = new URL(config.ipfs.gateway.address);
        const host = getIPFSHostFromCIDKey(targetURLObj.host, cidKey);
        debug('req.newHost', host);
        if (host) {
          targetURLObj.host = host;
          target = targetURLObj.toString();
          debug('req.target2', host);
          req.headers.host = host;
        }
      }
    }

    proxy.web(req, res, {
      target,
      changeOrigin: true,
      secure: false,
    });
  });

  const server = createServer(config, app);
  const port = getPort(config);

  server.listen(port, config.proxy.address, () => {
    console.info(`Listening at ${config.proxy.ssl ? 'https:' : 'http:'}//${config.proxy.address}:${port}`);
    const publicURL = [
      config.proxy.ssl ? 'https://' : 'http://',
      config.proxy.hostname,
      config.proxy.ssl && port !== 443 ? `:${port}` : '',
      !config.proxy.ssl && port !== 80 ? `:${port}` : '',
      '/',
    ].join('');
    console.info(`Open ${publicURL}`);
  });

  const shutdown = (signal, value) => {
    clearInterva(refreshInterval);
    server.close(() => {
      proxy.close(() => {
        console.log(`Server stopped by ${signal} with value ${value}`);
        process.exit(128 + value);
      });
    });
  };

  const signals = {
    'SIGHUP': 1,
    'SIGINT': 2,
    'SIGTERM': 15,
  };

  Object.entries(signals).forEach(([signal, value]) => {
    process.on(signal, () => {
      console.log(`process received a ${signal} signal`);
      shutdown(signal, value);
    });
  });
}

start();
