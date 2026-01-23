#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/design/template/vite-app"

npm install
npm run build

pm2 start npm --name store -- run preview -- --host 0.0.0.0 --port 5176
