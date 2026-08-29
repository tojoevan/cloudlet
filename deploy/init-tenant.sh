#!/usr/bin/env bash
# 在数据湖里为云上小镇登记 app 与租户。幂等，可重复执行。
set -euo pipefail

: "${INTERNAL_KEY:?请设置 INTERNAL_KEY（数据湖内部密钥）}"

LAKE="${LAKE_BASE:-https://your-data-lake.example.com}"
APP="${LAKE_TENANT:-cloudlet}"
NAME="${LAKE_NAME:-云上小镇}"

post() {
  local path="$1" data="$2"
  local code body
  body="$(curl -sS -o /tmp/cloudlet-init.json -w '%{http_code}' \
    -X POST "${LAKE}${path}" \
    -H "X-Sync-Key: ${INTERNAL_KEY}" \
    -H 'Content-Type: application/json' \
    -d "${data}")"
  code="${body}"
  if [ "$code" != "200" ] && [ "$code" != "201" ]; then
    echo "[✗] POST ${path} → HTTP ${code}"
    cat /tmp/cloudlet-init.json
    echo
    exit 1
  fi
  echo "[✓] POST ${path} → $(cat /tmp/cloudlet-init.json)"
}

echo "→ 登记 app: ${APP}"
post "/v1/a" "{\"app_id\":\"${APP}\",\"name\":\"${NAME}\"}"

echo "→ 登记租户: ${APP}"
post "/v1/a/${APP}/tenants" "{\"tenant_id\":\"${APP}\",\"name\":\"${NAME}\"}"

echo
echo "完成。本网关用到三个按 id 存储的集合（首次写入时自动建好，无需显式创建）："
echo "  /t/${APP}/c/saves      —— 玩家存档（owner = 设备UUID 或 账号ID）"
echo "  /t/${APP}/c/accounts   —— 账号档案（含 pbkdf2 密码哈希、等级、会员等级）"
echo "  /t/${APP}/c/usernames  —— 用户名→账号ID 的唯一索引（用于登录解析与查重）"
echo "注意：租户必须建在 ${APP} 这个 app 下，才能与微家事的 jiashiben 数据隔离。"
