#!/usr/bin/env bash
# 构建前端 → 上传 VPS → 用 pm2 启动网关（无 Docker，对齐微家事裸机部署）
#
# 拓扑：
#   静态前端  →  /www/wwwroot/cloudlet   （宝塔站点根目录，由宝塔 nginx 直接托管）
#   网关网关  →  /opt/cloudlet-api        （pm2 常驻，监听 127.0.0.1:8787）
#   宝塔反向代理把 /api 与 /admin 指向 127.0.0.1:8787
#
# 用法：
#   VPS=user@1.2.3.4 INTERNAL_KEY=... JWT_SECRET=... ADMIN_TOKEN=... ./deploy/deploy.sh
#
# 依赖：node >= 18（网关零依赖）、pm2（已装在 VPS 上）
set -euo pipefail

: "${VPS:?请设置 VPS，例如 user@1.2.3.4}"
: "${INTERNAL_KEY:?请设置 INTERNAL_KEY（数据湖内部密钥 X-Sync-Key）}"
: "${JWT_SECRET:?请设置 JWT_SECRET（openssl rand -hex 32）}"
: "${ADMIN_TOKEN:?请设置 ADMIN_TOKEN（openssl rand -hex 16，管理后台登录令牌）}"

WEB_DIR="${WEB_DIR:-/www/wwwroot/cloudlet}"   # 宝塔站点根目录
API_DIR="${API_DIR:-/opt/cloudlet-api}"       # 网关目录

cd "$(dirname "$0")/.."

echo "→ 构建前端"
npm ci
npm run build

echo "→ 上传静态前端到 ${VPS}:${WEB_DIR}"
ssh "$VPS" "mkdir -p ${WEB_DIR}"
rsync -avz --delete dist/ "${VPS}:${WEB_DIR}/"

echo "→ 上传网关到 ${VPS}:${API_DIR}"
ssh "$VPS" "mkdir -p ${API_DIR}/logs"
rsync -avz --delete \
  server/index.mjs \
  deploy/admin.html \
  deploy/start.sh \
  deploy/ecosystem.config.cjs \
  "${VPS}:${API_DIR}/"

echo "→ 写环境变量（含真实数据湖密钥）"
ssh "$VPS" bash -s <<ENV
set -euo pipefail
cat > ${API_DIR}/.env <<DOTENV
PORT=8787
LAKE_BASE='${LAKE_BASE:-https://your-data-lake.example.com}'
LAKE_TENANT='${LAKE_TENANT:-cloudlet}'
JWT_SECRET='${JWT_SECRET}'
ADMIN_TOKEN='${ADMIN_TOKEN}'
INTERNAL_KEY='${INTERNAL_KEY}'
ADMIN_HTML=${API_DIR}/admin.html
NODE_ENV=production
DOTENV
chmod 600 ${API_DIR}/.env
chmod +x ${API_DIR}/start.sh
ENV

echo "→ pm2 启动/重启网关"
ssh "$VPS" "cd ${API_DIR} && (pm2 restart ${API_DIR}/ecosystem.config.cjs || pm2 start ${API_DIR}/ecosystem.config.cjs) && pm2 save"

echo "完成。"
echo "  · 站点根目录：${WEB_DIR}（宝塔建站时填这个目录）"
echo "  · 宝塔反向代理：把 /api 与 /admin 指向 http://127.0.0.1:8787"
echo "  · 管理后台：域名/admin （用 ADMIN_TOKEN 登录）"
