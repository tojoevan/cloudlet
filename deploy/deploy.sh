#!/usr/bin/env bash
# 构建前端 → 上传 VPS → 用 pm2 启动网关（无 Docker，对齐微家事裸机部署）
#
# 拓扑：
#   静态前端  →  /www/wwwroot/cloudlet   （宝塔站点根目录，由宝塔 nginx 直接托管）
#   网关网关  →  /opt/cloudlet-api        （pm2 常驻，监听 127.0.0.1:8787）
#   宝塔反向代理把 /api 与 /admin 指向 127.0.0.1:8787
#
# 用法：
#   # 路C（推荐）：
#   VPS=user@<YOUR_SERVER_IP> GATEWAY_KEY='<GATEWAY_PRIVATE_KEY>' \
#     GATEWAY_APP_ID=weijiashi GATEWAY_AUD=data.example.com \
#     JWT_SECRET=... ADMIN_TOKEN=... ./deploy/deploy.sh
#   # 或路B 直连：
#   VPS=user@<YOUR_SERVER_IP> INTERNAL_KEY=... JWT_SECRET=... ADMIN_TOKEN=... ./deploy/deploy.sh
#
# 依赖：node >= 18（网关零依赖）、pm2（已装在 VPS 上）
set -euo pipefail

: "${VPS:?请设置 VPS，例如 user@<YOUR_SERVER_IP>}"
: "${JWT_SECRET:?请设置 JWT_SECRET（openssl rand -hex 32）}"
: "${ADMIN_TOKEN:?请设置 ADMIN_TOKEN（openssl rand -hex 16，管理后台登录令牌）}"
# 数据湖凭证：路C(GATEWAY_KEY) / 路A(T4_KEY) / 路B(INTERNAL_KEY) 至少其一
if [ -z "${GATEWAY_KEY:-}" ] && [ -z "${T4_KEY:-}" ] && [ -z "${INTERNAL_KEY:-}" ]; then
  echo "错误：请至少设置 GATEWAY_KEY / T4_KEY / INTERNAL_KEY 之一" >&2
  exit 1
fi

# 路C 的两个 T2 身份声明没有安全默认值（历史上 aid 的 'jiashiben' 默认值
# 导致数据湖 403 app mismatch，表现为「登录始终失败」）。这里提前校验，
# 缺了就直接失败，不要等上线后才发现。
if [ -n "${GATEWAY_KEY:-}" ]; then
  : "${GATEWAY_APP_ID:?路C 需要 GATEWAY_APP_ID：填该租户在数据湖 tenants 表里的 app_id（cloudlet 租户为 weijiashi）}"
  # GATEWAY_AUD 未显式设置时从 LAKE_BASE 推导域名，避免回落到占位符
  if [ -z "${GATEWAY_AUD:-}" ]; then
    GATEWAY_AUD="$(printf '%s' "${LAKE_BASE:-}" | sed -E 's#^[a-zA-Z]+://##; s#/.*$##')"
  fi
  if [ -z "${GATEWAY_AUD:-}" ]; then
    echo "错误：路C 需要 GATEWAY_AUD（数据湖域名，如 data.example.com）" >&2
    exit 1
  fi
fi

WEB_DIR="${WEB_DIR:-/www/wwwroot/cloudlet}"   # 宝塔站点根目录
API_DIR="${API_DIR:-/opt/cloudlet-api}"       # 网关目录

# .env 是整份重建的，CLOUD_READONLY 这类手工开关不在模板里 —— 必须先继承远端现值，
# 否则一次普通部署就会静默解除云端只读冻结。显式传 CLOUD_READONLY=1/0 可覆盖。
if [ -z "${CLOUD_READONLY:-}" ]; then
  CLOUD_READONLY="$(
    ssh "$VPS" "grep -E '^CLOUD_READONLY=' ${API_DIR}/.env 2>/dev/null | tail -1 | cut -d= -f2-" \
      | tr -d "'\"[:space:]" || true
  )"
fi
CLOUD_READONLY="${CLOUD_READONLY:-0}"

cd "$(dirname "$0")/.."

echo "→ 构建前端"
npm ci
npm run build

echo "→ 上传静态前端到 ${VPS}:${WEB_DIR}"
ssh "$VPS" "mkdir -p ${WEB_DIR}"
# --delete 会清掉目标目录里 dist/ 没有的一切，而站点根目录还放着宝塔的 .user.ini
# 与证书续期校验用的 .well-known/ —— 必须排除，否则一次部署就把它们删了。
rsync -avz --delete \
  --exclude='.user.ini' \
  --exclude='.well-known/' \
  dist/ "${VPS}:${WEB_DIR}/"

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
# .env 每次都是整份重建：先备份，避免手工加过的开关（如 CLOUD_READONLY）被静默丢掉
if [ -f ${API_DIR}/.env ]; then
  cp -a ${API_DIR}/.env ${API_DIR}/.env.bak.\$(date +%s)
  echo "  已备份旧 .env"
fi
cat > ${API_DIR}/.env <<DOTENV
PORT=8787
LAKE_BASE='${LAKE_BASE:-https://your-data-lake.example.com}'
LAKE_TENANT='${LAKE_TENANT:-cloudlet}'
JWT_SECRET='${JWT_SECRET}'
ADMIN_TOKEN='${ADMIN_TOKEN}'
GATEWAY_KEY='${GATEWAY_KEY:-}'
GATEWAY_BASE='${GATEWAY_BASE:-https://your-gateway.example.com}'
GATEWAY_APP_ID='${GATEWAY_APP_ID:-}'
GATEWAY_AUD='${GATEWAY_AUD:-}'
T4_KEY='${T4_KEY:-}'
INTERNAL_KEY='${INTERNAL_KEY:-}'
CLOUD_READONLY='${CLOUD_READONLY}'
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
if [ -n "${GATEWAY_KEY:-}" ]; then
  echo "  · 部署自检：curl https://<域名>/api/health 应返回 \"app\":\"${GATEWAY_APP_ID}\""
  echo "    若 app 为空或与数据湖 tenants.app_id 不一致，所有登录都会失败（403 app mismatch）"
fi
