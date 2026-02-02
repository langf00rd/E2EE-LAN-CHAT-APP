#!/usr/bin/env bash
set -e

# trap Ctrl+C to clean up
trap "echo 'interrupted! cleaning up...'; rm -rf node-v24.13.0-darwin-arm64; exit 1" SIGINT

# extract the node binary
tar -xzf node.tar.gz

# set the node binary path to the variable NODE
NODE="./node-v24.13.0-darwin-arm64/bin/node"

# use node binary to start the server
"$NODE" index.js
