#!/usr/bin/env bash

docker build --rm -t maxkueng/ipfs-vhosts-proxy:latest --build-arg ARCH=amd64/ .

