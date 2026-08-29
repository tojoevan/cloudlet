// pm2 部署配置（不使用 Docker 时的备选方案）
// 用法：在 VPS 上 `pm2 start deploy/ecosystem.config.cjs`
module.exports = {
  apps: [
    {
      name: 'cloudlet-api',
      cwd: '/opt/cloudlet/server',
      script: '/opt/cloudlet/server/index.mjs',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      env_file: '/opt/cloudlet/deploy/.env',
      error_file: '/opt/cloudlet/deploy/logs/err.log',
      out_file: '/opt/cloudlet/deploy/logs/out.log',
      merge_logs: true,
    },
  ],
};
