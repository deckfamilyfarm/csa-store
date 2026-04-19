#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

npm --prefix design/template/vite-app run build

wait_for_store() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS http://127.0.0.1:5176/api/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "store did not answer on http://127.0.0.1:5176/api/health" >&2
  pm2 status >&2 || true
  pm2 logs store --lines 80 --nostream >&2 || true
  return 1
}

pm2 delete store-api >/dev/null 2>&1 || true
pm2 delete store >/dev/null 2>&1 || true
PORT=5176 NODE_ENV=production STORE_SERVE_FRONTEND=true pm2 start apps/api/index.js --name store --cwd "$PWD" --update-env
wait_for_store
