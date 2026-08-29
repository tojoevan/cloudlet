#!/usr/bin/env bash
# pm2 启动包装：pm2 守护进程不会继承交互 shell 的环境变量，
# 因此不能用 `source .env && pm2 start`，也不能靠 ecosystem 的 env_file（解析不稳）。
# 这里在脚本内 source .env 再 exec node，环境变量必定生效。
set -a
source "$(dirname "$0")/.env"
set +a
exec node "$(dirname "$0")/index.mjs"
