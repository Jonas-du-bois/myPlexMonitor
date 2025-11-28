require('dotenv').config();
const net = require('net');
const axios = require('axios');
const express = require('express');

// --- CONFIGURATION ---
const CONFIG = {
    serverIp: process.env.IP_SERVER,
    serverPort: 32400,                  // Default Plex port
    checkInterval: 30000,               // 30 seconds in milliseconds
    telegramToken: process.env.TOKEN_TELEGRAM,
    telegramChatId: process.env.ID_CHAT
};

// --- WEB PART (to keep Render alive) ---
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Plex monitor is active!');
});

app.listen(port, () => {
    console.log(`Web server started on port ${port}`);
});

// --- MONITORING PART (Your old code) ---
let isServerOnline = true; // Assume the server is online at startup

async function sendAlert(message) {
    const url = `https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`;
    try {
        await axios.post(url, { chat_id: CONFIG.telegramChatId, text: message });
        console.log('Alert sent:', message);
    } catch (error) { console.error('Telegram error:', error.message); }
}

function checkServer() {
    const socket = new net.Socket();
    socket.setTimeout(5000);

    socket.on('connect', () => {
        if (!isServerOnline) {
            sendAlert(`✅ The Plex server is back online!`);
            isServerOnline = true;
        }
        socket.destroy();
    });

    socket.on('timeout', () => { handleDown('Timeout (No response)'); socket.destroy(); });
    socket.on('error', (err) => { handleDown(`Error (${err.code})`); });

    socket.connect(CONFIG.serverPort, CONFIG.serverIp);
}

function handleDown(reason) {
    if (isServerOnline) {
        sendAlert(`🚨 ALERT: The Plex server is OFFLINE!\nReason: ${reason}`);
        isServerOnline = false;
    }
}

// Script startup
console.log(`Monitoring of ${CONFIG.serverIp}:${CONFIG.serverPort} started...`);
// Immediate first check
checkServer();
// Then infinite loop
setInterval(checkServer, CONFIG.checkInterval);