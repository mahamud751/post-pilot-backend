module.exports = {
  apps: [
    {
      name: 'post-pilot-backend',
      script: 'dist/main.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 9001
      },
      error_file: '/var/log/pm2/post-pilot-backend-error.log',
      out_file: '/var/log/pm2/post-pilot-backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true
    }
  ]
};
