module.exports = {
  apps: [
    {
      // The ONLY Baileys owner. Transport + routing, zero business logic.
      // fork mode is mandatory: cluster would fork multiple sockets and
      // re-create the device conflict this gateway exists to eliminate.
      name: 'wa-gateway',
      script: 'dist/index.js',
      cwd: '/home/azureuser/wa-gateway',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '160M',
      watch: false,
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        WA_SOCKET_PATH: '/run/wa-gateway.sock',
        WA_AUTH_DIR: './auth_state',
        WA_FLASHPEAK_GROUP_JID: '120363412423738009@g.us',
        WA_LOG_LEVEL: 'warn',
      },
    },
    {
      // Omak — no Baileys; consumes the gateway socket.
      name: 'bot-prime',
      script: 'dist/index.js',
      cwd: '/home/azureuser/bot-prime',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '200M',
      watch: false,
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        WA_TRANSPORT: 'gateway',
        WA_GATEWAY_SOCKET: '/run/wa-gateway.sock',
      },
    },
    {
      // Flash Peak TMS — no Baileys; consumes the gateway socket.
      name: 'flashpeak-bot',
      script: 'src/cli/start.ts',
      cwd: '/home/azureuser/flashpeak-tms',
      interpreter: 'node',
      node_args: '--import tsx',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '200M',
      watch: false,
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        WA_TRANSPORT: 'gateway',
        WA_SOCKET_PATH: '/run/wa-gateway.sock',
      },
    },
  ],
};
