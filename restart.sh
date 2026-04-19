#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

npm --prefix design/template/vite-app run build

wait_for_api() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS http://127.0.0.1:5177/api/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "store-api did not answer on http://127.0.0.1:5177/api/health" >&2
  pm2 status >&2 || true
  pm2 logs store-api --lines 80 --nostream >&2 || true
  return 1
}

PORT=5177 NODE_ENV=production pm2 restart store-api --update-env || PORT=5177 NODE_ENV=production pm2 start apps/api/index.js --name store-api --cwd "$PWD" --update-env
wait_for_api
PORT=5176 NODE_ENV=production API_TARGET=http://127.0.0.1:5177 pm2 restart store --update-env || PORT=5176 NODE_ENV=production API_TARGET=http://127.0.0.1:5177 pm2 start server.js --name store --cwd "$PWD" --update-env
