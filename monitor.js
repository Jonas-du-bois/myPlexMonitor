require('dotenv').config();
const net = require('net');
const axios = require('axios');

// --- CONFIGURATION ---
const CONFIG = {
    serverIp: process.env.IP_SERVER,
    serverPort: 32400,                  // Default Plex port
    checkInterval: 30000,               // 30 seconds in milliseconds
    telegramToken: process.env.TOKEN_TELEGRAM,
    telegramChatId: process.env.ID_CHAT
};

// Variable to store the previous server state (to avoid spamming)
let isServerOnline = true; // Assume the server is online at startup

// Function to send a Telegram message
async function sendAlert(message) {
    const url = `https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: CONFIG.telegramChatId,
            text: message
        });
        console.log('Alert sent:', message);
    } catch (error) {
        console.error('Failed to send Telegram alert:', error.message);
    }
}

// Function to check the server connection
function checkServer() {
    const socket = new net.Socket();
    
    // 5-second timeout: if no response, consider it down
    socket.setTimeout(5000);

    socket.on('connect', () => {
        if (!isServerOnline) {
            // The server was DOWN, it is now UP
            sendAlert(`✅ The Plex server is back online!`);
            isServerOnline = true;
        }
        socket.destroy(); // Close the connection, everything is fine
    });

    socket.on('timeout', () => {
        handleDown('Timeout (No response)');
        socket.destroy();
    });

    socket.on('error', (err) => {
        handleDown(`Error (${err.code})`);
    });

    socket.connect(CONFIG.serverPort, CONFIG.serverIp);
}

// Function to handle the server down state
function handleDown(reason) {
    if (isServerOnline) {
        // The server was UP, it just went DOWN
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