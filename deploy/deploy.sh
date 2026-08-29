#!/usr/bin/env bash
# 构建前端 → 上传 VPS → 重启容器
set -euo pipefail

: "${VPS:?请设置 VPS，例如 user@1.2.3.4}"
REMOTE_DIR="${REMOTE_DIR:-/opt/cloudlet}"

cd "$(dirname "$0")/.."

echo "→ 构建前端"
npm ci
npm run build

echo "→ 上传产物"
ssh "$VPS" "mkdir -p ${REMOTE_DIR}"
rsync -avz --delete \
  dist/ "${VPS}:${REMOTE_DIR}/dist/"
rsync -avz \
  server/index.mjs server/Dockerfile "${VPS}:${REMOTE_DIR}/server/"
rsync -avz \
  deploy/nginx.conf deploy/docker-compose.yml "${VPS}:${REMOTE_DIR}/deploy/"

echo "→ 重启服务"
ssh "$VPS" "cd ${REMOTE_DIR}/deploy && INTERNAL_KEY='${INTERNAL_KEY:?请设置 INTERNAL_KEY}' docker compose up -d --build"

echo "完成"
