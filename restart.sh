#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

npm --prefix design/template/vite-app run build
pm2 restart store-api --update-env || PORT=5177 pm2 start apps/api/index.js --name store-api --update-env
pm2 restart store --update-env || PORT=5176 API_TARGET=http://127.0.0.1:5177 pm2 start server.js --name store --update-env
