require('dotenv').config();
const net = require('net');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// --- CONFIGURATION ---
const CONFIG = {
    serverIp: process.env.IP_SERVER,
    serverPort: 32400,
    checkInterval: 30000, // 30 seconds
    telegramToken: process.env.TOKEN_TELEGRAM,
    telegramChatId: process.env.ID_CHAT // Still useful for automatic alerts
};

// --- BOT INITIALIZATION ---
// polling: true allows the bot to listen for incoming messages
const bot = new TelegramBot(CONFIG.telegramToken, { polling: true });

// --- WEB PART (to keep Render alive) ---
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Plex monitor is active and listening to Telegram!');
});

app.listen(port, () => {
    console.log(`Web server for Render started on port ${port}`);
});

// --- MONITORING LOGIC ---

let isServerOnline = true; // Stored state

// Universal function to test the port
// callback = function to run after the test is finished (with the result true/false)
function pingServer(callback) {
    const socket = new net.Socket();
    socket.setTimeout(5000); // 5 seconds max to respond

    socket.on('connect', () => {
        callback(true); // Success
        socket.destroy();
    });

    socket.on('timeout', () => {
        callback(false, 'Timeout (No response)');
        socket.destroy();
    });

    socket.on('error', (err) => {
        callback(false, `Error (${err.code})`);
    });

    socket.connect(CONFIG.serverPort, CONFIG.serverIp);
}

// 1. AUTOMATIC LOOP (Every 30 sec)
function autoCheck() {
    pingServer((isOnline, reason) => {
        if (isOnline && !isServerOnline) {
            // It was DOWN, it is now UP
            bot.sendMessage(CONFIG.telegramChatId, `✅ The Plex server is back online!`);
            isServerOnline = true;
        } else if (!isOnline && isServerOnline) {
            // It was UP, it is now DOWN
            bot.sendMessage(CONFIG.telegramChatId, `🚨 ALERT: Plex is OFFLINE!\nReason: ${reason}`);
            isServerOnline = false;
        }
    });
}

// 2. RESPONSE TO THE /check COMMAND
bot.onText(/\/check/, (msg) => {
    const chatId = msg.chat.id;
    
    // A little message to say "I understood, I'm checking..."
    bot.sendMessage(chatId, "🔎 Checking the server status...");

    pingServer((isOnline, reason) => {
        if (isOnline) {
            bot.sendMessage(chatId, "🟢 Everything is fine! The Plex server is ONLINE and accessible.");
            // We update the internal state just in case
            isServerOnline = true;
        } else {
            bot.sendMessage(chatId, `🔴 The server seems to be OFFLINE.\nReason: ${reason}`);
            isServerOnline = false;
        }
    });
});

// Start of the auto loop
setInterval(autoCheck, CONFIG.checkInterval);
console.log("Bot started and monitoring is active!");