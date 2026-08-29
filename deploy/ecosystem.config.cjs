// pm2 部署配置（不使用 Docker 时）
// 用法：在 VPS 上 `pm2 start deploy/ecosystem.config.cjs`
// 注意：必须通过 deploy/start.sh 包装脚本来加载 .env，
// 因为 pm2 守护进程不继承交互 shell 的环境，env_file 解析也不可靠。
module.exports = {
  apps: [
    {
      name: 'cloudlet-api',
      cwd: '/opt/cloudlet-api',
      script: '/opt/cloudlet-api/start.sh',
      interpreter: '/bin/bash',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      error_file: '/opt/cloudlet-api/logs/err.log',
      out_file: '/opt/cloudlet-api/logs/out.log',
      merge_logs: true,
    },
  ],
};
