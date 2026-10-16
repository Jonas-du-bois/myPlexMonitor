module.exports = {
    apps: [
        {
            name: "myplexmonitor-local",
            script: "monitor.js",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "300M",
            env: {
                NODE_ENV: "production",
                ROLE: "LOCAL",
                PLEX_IP: "127.0.0.1",
                PLEX_PORT: "32400",
                CHECK_INTERVAL: "30000",
                PORT: "3000",
            },
        },
    ],
};
