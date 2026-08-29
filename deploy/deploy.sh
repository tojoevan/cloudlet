#!/usr/bin/env bash
# 构建前端 → 上传 VPS → 以 systemd 重启网关（无 Docker，对齐微家事裸机部署）
#
# 用法：
#   VPS=user@1.2.3.4 INTERNAL_KEY=... JWT_SECRET=... ADMIN_TOKEN=... ./deploy/deploy.sh
#
# 部署目标结构：
#   /opt/cloudlet/
#     dist/            前端静态产物（nginx root）
#     server/index.mjs 网关
#     deploy/          nginx.conf / systemd unit / .env / 本脚本
#
# 依赖：node >= 18（网关零依赖）、nginx、systemd（或 pm2）
set -euo pipefail

: "${VPS:?请设置 VPS，例如 user@1.2.3.4}"
: "${INTERNAL_KEY:?请设置 INTERNAL_KEY（数据湖内部密钥）}"
: "${JWT_SECRET:?请设置 JWT_SECRET（openssl rand -hex 32）}"
: "${ADMIN_TOKEN:?请设置 ADMIN_TOKEN（openssl rand -hex 16）}"

REMOTE_DIR="${REMOTE_DIR:-/opt/cloudlet}"
RUNNER="${RUNNER:-www-data}"        # systemd 运行用户，需对 REMOTE_DIR 有读权限
MODE="${MODE:-systemd}"             # systemd | pm2

cd "$(dirname "$0")/.."

echo "→ 构建前端"
npm ci
npm run build

echo "→ 上传产物到 ${VPS}:${REMOTE_DIR}"
ssh "$VPS" "mkdir -p ${REMOTE_DIR}/dist ${REMOTE_DIR}/server ${REMOTE_DIR}/deploy/logs"
rsync -avz --delete dist/ "${VPS}:${REMOTE_DIR}/dist/"
rsync -avz server/index.mjs "${VPS}:${REMOTE_DIR}/server/"
rsync -avz \
  deploy/nginx.conf \
  deploy/cloudlet-api.service \
  deploy/ecosystem.config.cjs \
  deploy/.env.example \
  "${VPS}:${REMOTE_DIR}/deploy/"

echo "→ 写环境变量并启动网关（${MODE}）"
ssh "$VPS" bash -s <<EOF
set -euo pipefail
cat > ${REMOTE_DIR}/deploy/.env <<ENV
INTERNAL_KEY='${INTERNAL_KEY}'
JWT_SECRET='${JWT_SECRET}'
ADMIN_TOKEN='${ADMIN_TOKEN}'
LAKE_BASE='${LAKE_BASE:-https://your-data-lake.example.com}'
LAKE_TENANT='${LAKE_TENANT:-cloudlet}'
PORT=8787
ALLOWED_ORIGIN='${ALLOWED_ORIGIN:-}'
ENV
chmod 600 ${REMOTE_DIR}/deploy/.env
chown -R ${RUNNER}:${RUNNER} ${REMOTE_DIR}

if [ "${MODE}" = "pm2" ]; then
  pm2 restart ${REMOTE_DIR}/deploy/ecosystem.config.cjs || pm2 start ${REMOTE_DIR}/deploy/ecosystem.config.cjs
  pm2 save
else
  install -m 644 ${REMOTE_DIR}/deploy/cloudlet-api.service /etc/systemd/system/cloudlet-api.service
  sed -i "s/^User=.*/User=${RUNNER}/" /etc/systemd/system/cloudlet-api.service
  systemctl daemon-reload
  systemctl enable cloudlet-api
  systemctl restart cloudlet-api
fi
EOF

echo "完成。访问站点，管理后台在 /admin"
