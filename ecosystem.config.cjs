module.exports = {
  apps: [
    {
      name: "pagepocket-frontend",
      script: "npm",
      args: "run start",
      cwd: "./pagepocket/frontend",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        HOSTNAME: "0.0.0.0"
      },
      instances: "max",
      exec_mode: "cluster",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./pagepocket/frontend/logs/err.log",
      out_file: "./pagepocket/frontend/logs/out.log",
      merge_logs: true
    }
  ]
};
