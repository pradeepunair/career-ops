#!/bin/zsh
cd "$(dirname "$0")/.." || exit 1
node resume-lab/server.mjs
