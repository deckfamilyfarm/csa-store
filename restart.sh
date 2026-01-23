#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/design/template/vite-app"

pm2 restart full-farm-csa
