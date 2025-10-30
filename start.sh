#!/usr/bin/env bash
set -e
mkdir -p /data/wwebjs
# opcional: permissões mais abertas se rodar como root
chmod -R 700 /data || true
node index.js
