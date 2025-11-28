/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                           🎬 MyPlexMonitor 🎬                                ║
 * ║                                                                              ║
 * ║  A powerful Telegram bot to monitor your Plex server and manage downloads   ║
 * ║                                                                              ║
 * ║  Features:                                                                   ║
 * ║  • Real-time Plex server monitoring with automatic alerts                   ║
 * ║  • qBittorrent integration for torrent management                           ║
 * ║  • Plex library statistics and recently added content                       ║
 * ║  • Server health monitoring (CPU, RAM, Disk)                                ║
 * ║  • Download progress tracking with notifications                            ║
 * ║  • User authorization system for security                                   ║
 * ║                                                                              ║
 * ║  Author: jonas_du_bois                                                       ║
 * ║  License: MIT                                                                ║
 * ║  Repository: https://github.com/Jonas-du-bois/myPlexMonitor                 ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

require("dotenv").config();
const net = require("net");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const PlexAPI = require("plex-api");
const axios = require("axios");
const os = require("os");

// ═══════════════════════════════════════════════════════════════════════════════
// ║                              CONFIGURATION                                   ║
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
    // --- Server IP Configuration ---
    // Single IP for both Plex and qBittorrent (they run on the same server)
    serverIp: process.env.SERVER_IP || process.env.PLEX_IP || process.env.IP_SERVER,
    
    // --- Plex Server Configuration ---
    plexPort: parseInt(process.env.PLEX_PORT) || 32400,
    plexToken: process.env.PLEX_TOKEN,
    
    // --- Telegram Bot Configuration ---
    telegramToken: process.env.TELEGRAM_TOKEN || process.env.TOKEN_TELEGRAM,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || process.env.ID_CHAT,
    webhookUrl: process.env.WEBHOOK_URL, // For production (Render)
    
    // --- Monitoring Configuration ---
    checkInterval: parseInt(process.env.CHECK_INTERVAL) || 30000, // 30 seconds
    downloadCheckInterval: parseInt(process.env.DOWNLOAD_CHECK_INTERVAL) || 60000, // 1 minute
    
    // --- qBittorrent Configuration ---
    // Uses the same SERVER_IP by default (same machine as Plex)
    qbittorrent: {
        host: process.env.QBITTORRENT_HOST || process.env.SERVER_IP || process.env.PLEX_IP || process.env.IP_SERVER || "localhost",
        port: parseInt(process.env.QBITTORRENT_PORT) || 8080,
        username: process.env.QBITTORRENT_USERNAME || "admin",
        password: process.env.QBITTORRENT_PASSWORD || "adminadmin",
    },
    
    // --- Download Paths Configuration ---
    paths: {
        movies: process.env.MOVIES_PATH || "/mnt/films",
        series: process.env.SERIES_PATH || "/mnt/films/series",
    },
    
    // --- Security Configuration ---
    // Comma-separated list of authorized Telegram user IDs
    // Leave empty to allow all users (not recommended for production)
    authorizedUsers: process.env.AUTHORIZED_USERS 
        ? process.env.AUTHORIZED_USERS.split(",").map(id => parseInt(id.trim()))
        : [],
    
    // --- Web Server Configuration (for Render/hosting) ---
    webPort: process.env.PORT || 3000,
    
    // --- Environment Detection ---
    isProduction: process.env.NODE_ENV === "production" || !!process.env.PORT,
};

// ═══════════════════════════════════════════════════════════════════════════════
// ║                           BOT INITIALIZATION                                 ║
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize the Telegram bot
 * - Uses webhooks in production (Render) to avoid 409 conflicts
 * - Uses polling in development for easier testing
 */
const bot = CONFIG.isProduction && CONFIG.webhookUrl
    ? new TelegramBot(CONFIG.telegramToken, { webHook: true })
    : new TelegramBot(CONFIG.telegramToken, { polling: true });

/**
 * Initialize the Plex API client
 * Used to query library information and recently added content
 */
const plexClient = new PlexAPI({
    hostname: CONFIG.serverIp,
    token: CONFIG.plexToken,
});

// ═══════════════════════════════════════════════════════════════════════════════
// ║                              STATE MANAGEMENT                                ║
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Global state object to track various states across the application
 * This helps maintain consistency and enables features like notifications
 */
const state = {
    // Server status tracking
    isServerOnline: true,
    lastCheck: null,
    
    // qBittorrent session tracking
    qbCookie: null,
    qbConnected: false,
    
    // User state for multi-step commands (like torrent type selection)
    userStates: new Map(),
    
    // Download tracking for completion notifications
    activeDownloads: new Map(),
    
    // Statistics
    stats: {
        checksPerformed: 0,
        alertsSent: 0,
        torrentsAdded: 0,
        botStartTime: new Date(),
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ║                         WEB SERVER (Keep-Alive)                              ║
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Express web server to keep the bot alive on hosting platforms like Render
 * Provides basic health check endpoints and status information
 */
const app = express();
app.use(express.json());

// Health check endpoint - useful for monitoring services
app.get("/", (req, res) => {
    const uptime = Math.floor((Date.now() - state.stats.botStartTime.getTime()) / 1000);
    res.json({
        status: "running",
        service: "MyPlexMonitor",
        version: "2.0.0",
        uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`,
        plex: {
            online: state.isServerOnline,
            lastCheck: state.lastCheck,
        },
        qbittorrent: {
            connected: state.qbConnected,
        },
        stats: state.stats,
    });
});

// Detailed health endpoint for monitoring
app.get("/health", (req, res) => {
    res.json({
        healthy: state.isServerOnline,
        timestamp: new Date().toISOString(),
    });
});

// Webhook endpoint for Telegram (production mode)
if (CONFIG.isProduction && CONFIG.webhookUrl) {
    const webhookPath = `/bot${CONFIG.telegramToken}`;
    app.post(webhookPath, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
    
    // Set webhook
    bot.setWebHook(`${CONFIG.webhookUrl}${webhookPath}`).then(() => {
        console.log(`✅ Webhook configured: ${CONFIG.webhookUrl}${webhookPath}`);
    }).catch((err) => {
        console.error("❌ Failed to set webhook:", err.message);
    });
}

app.listen(CONFIG.webPort, () => {
    console.log(`🌐 Web server started on port ${CONFIG.webPort}`);
    if (CONFIG.isProduction && CONFIG.webhookUrl) {
        console.log(`📡 Using Telegram webhooks (production mode)`);
    } else {
        console.log(`📡 Using Telegram polling (development mode)`);
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ║                          UTILITY FUNCTIONS                                   ║
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a user is authorized to use the bot
 * @param {number} userId - Telegram user ID to check
 * @returns {boolean} - True if authorized, false otherwise
 */
function isAuthorized(userId) {
    // If no authorized users are configured, allow everyone (for easy setup)
    if (CONFIG.authorizedUsers.length === 0) return true;
    return CONFIG.authorizedUsers.includes(userId);
}

/**
 * Format bytes to human readable format
 * @param {number} bytes - Number of bytes
 * @param {number} decimals - Number of decimal places
 * @returns {string} - Formatted string (e.g., "1.5 GB")
 */
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i];
}

/**
 * Format seconds to human readable duration
 * @param {number} seconds - Duration in seconds
 * @returns {string} - Formatted duration (e.g., "2h 30m")
 */
function formatDuration(seconds) {
    if (seconds < 0 || !isFinite(seconds)) return "∞";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
}

/**
 * Create a progress bar string
 * @param {number} progress - Progress percentage (0-100)
 * @param {number} length - Length of the progress bar
 * @returns {string} - Progress bar string
 */
function createProgressBar(progress, length = 10) {
    const filled = Math.round((progress / 100) * length);
    const empty = length - filled;
    return "█".repeat(filled) + "░".repeat(empty);
}

/**
 * Send an unauthorized message to the user
 * @param {number} chatId - Telegram chat ID
 */
function sendUnauthorizedMessage(chatId) {
    bot.sendMessage(
        chatId,
        "🚫 *Unauthorized*\n\nYou are not authorized to use this bot.\nContact the administrator to get access.",
        { parse_mode: "Markdown" }
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ║                        PLEX SERVER MONITORING                                ║
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Test if the Plex server port is accessible
 * Uses a TCP socket connection with timeout
 * @param {function} callback - Callback function(isOnline, reason)
 */
function pingServer(callback) {
    const socket = new net.Socket();
    socket.setTimeout(5000); // 5 seconds timeout

    socket.on("connect", () => {
        callback(true);
        socket.destroy();
    });

    socket.on("timeout", () => {
        callback(false, "Timeout (No response)");
        socket.destroy();
    });

    socket.on("error", (err) => {
        callback(false, `Error (${err.code})`);
    });

    socket.connect(CONFIG.plexPort, CONFIG.serverIp);
}

/**
 * Automatic monitoring loop
 * Checks server status periodically and sends alerts on state changes
 */
function autoCheck() {
    pingServer((isOnline, reason) => {
        state.lastCheck = new Date().toISOString();
        state.stats.checksPerformed++;
        
        if (isOnline && !state.isServerOnline) {
            // Server came back online
            const downtime = state.lastDownTime 
                ? formatDuration((Date.now() - state.lastDownTime) / 1000)
                : "unknown";
            bot.sendMessage(
                CONFIG.telegramChatId,
                `✅ *Plex Server is BACK ONLINE!*\n\n📡 Server: \`${CONFIG.serverIp}:${CONFIG.plexPort}\`\n⏱️ Downtime: ${downtime}`,
                { parse_mode: "Markdown" }
            );
            state.isServerOnline = true;
            state.stats.alertsSent++;
        } else if (!isOnline && state.isServerOnline) {
            // Server went offline
            state.lastDownTime = Date.now();
            bot.sendMessage(
                CONFIG.telegramChatId,
                `🚨 *ALERT: Plex Server is OFFLINE!*\n\n📡 Server: \`${CONFIG.serverIp}\`\n❌ Reason: ${reason}\n⏰ Time: ${new Date().toLocaleString()}`,
                { parse_mode: "Markdown" }
            );
            state.isServerOnline = false;
            state.stats.alertsSent++;
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ║                        QBITTORRENT INTEGRATION                               ║
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Authenticate with qBittorrent WebUI
 * @returns {Promise<boolean>} - True if authentication successful
 */
async function qbLogin() {
    try {
        const url = `http://${CONFIG.qbittorrent.host}:${CONFIG.qbittorrent.port}/api/v2/auth/login`;
        console.log(`🔐 Attempting qBittorrent login at ${url}`);
        
        const response = await axios.post(
            url,
            `username=${encodeURIComponent(CONFIG.qbittorrent.username)}&password=${encodeURIComponent(CONFIG.qbittorrent.password)}`,
            {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                withCredentials: true,
                timeout: 5000,
            }
        );
        
        // Extract the SID cookie from the response
        const cookies = response.headers["set-cookie"];
        if (cookies) {
            const sidCookie = cookies.find(c => c.startsWith("SID="));
            if (sidCookie) {
                state.qbCookie = sidCookie.split(";")[0];
                state.qbConnected = true;
                console.log("✅ qBittorrent authentication successful");
                return true;
            }
        }
        
        // Some versions return "Ok." in the body
        if (response.data === "Ok.") {
            state.qbConnected = true;
            console.log("✅ qBittorrent authentication successful");
            return true;
        }
        
        console.log("⚠️  qBittorrent authentication failed - unexpected response");
        return false;
    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            console.error(`❌ qBittorrent connection refused at ${CONFIG.qbittorrent.host}:${CONFIG.qbittorrent.port}`);
        } else if (error.code === 'ETIMEDOUT') {
            console.error(`❌ qBittorrent connection timeout at ${CONFIG.qbittorrent.host}:${CONFIG.qbittorrent.port}`);
        } else {
            console.error(`❌ qBittorrent login error: ${error.message}`);
        }
        state.qbConnected = false;
        return false;
    }
}

/**
 * Make an authenticated request to qBittorrent API
 * @param {string} endpoint - API endpoint
 * @param {string} method - HTTP method
 * @param {object} data - Request data
 * @returns {Promise<object>} - API response
 */
async function qbRequest(endpoint, method = "GET", data = null) {
    // Ensure we're logged in
    if (!state.qbConnected) {
        const loggedIn = await qbLogin();
        if (!loggedIn) throw new Error("Failed to authenticate with qBittorrent");
    }
    
    const config = {
        method,
        url: `http://${CONFIG.qbittorrent.host}:${CONFIG.qbittorrent.port}/api/v2${endpoint}`,
        headers: {},
    };
    
    if (state.qbCookie) {
        config.headers.Cookie = state.qbCookie;
    }
    
    if (data) {
        if (method === "POST") {
            config.headers["Content-Type"] = "application/x-www-form-urlencoded";
            config.data = new URLSearchParams(data).toString();
        } else {
            config.params = data;
        }
    }
    
    try {
        const response = await axios(config);
        return response.data;
    } catch (error) {
        // If forbidden, try to re-login
        if (error.response?.status === 403) {
            state.qbConnected = false;
            return qbRequest(endpoint, method, data);
        }
        throw error;
    }
}

/**
 * Add a torrent to qBittorrent
 * @param {string} magnetOrUrl - Magnet link or torrent URL
 * @param {string} savePath - Download destination path
 * @returns {Promise<boolean>} - True if torrent was added successfully
 */
async function addTorrent(magnetOrUrl, savePath) {
    try {
        await qbRequest("/torrents/add", "POST", {
            urls: magnetOrUrl,
            savepath: savePath,
            autoTMM: "false", // Disable automatic torrent management to use our path
        });
        state.stats.torrentsAdded++;
        return true;
    } catch (error) {
        console.error("Error adding torrent:", error.message);
        return false;
    }
}

/**
 * Get list of all torrents with their status
 * @returns {Promise<Array>} - List of torrent objects
 */
async function getTorrents() {
    try {
        return await qbRequest("/torrents/info");
    } catch (error) {
        if (error.message.includes("authenticate")) {
            throw new Error("Failed to authenticate with qBittorrent");
        }
        console.error("Error getting torrents:", error.message);
        return [];
    }
}

/**
 * Get qBittorrent transfer info (global speeds)
 * @returns {Promise<object>} - Transfer info object
 */
async function getTransferInfo() {
    try {
        return await qbRequest("/transfer/info");
    } catch (error) {
        console.error("Error getting transfer info:", error.message);
        return null;
    }
}

/**
 * Pause a torrent
 * @param {string} hash - Torrent hash
 */
async function pauseTorrent(hash) {
    await qbRequest("/torrents/pause", "POST", { hashes: hash });
}

/**
 * Resume a torrent
 * @param {string} hash - Torrent hash
 */
async function resumeTorrent(hash) {
    await qbRequest("/torrents/resume", "POST", { hashes: hash });
}

/**
 * Delete a torrent
 * @param {string} hash - Torrent hash
 * @param {boolean} deleteFiles - Whether to delete downloaded files
 */
async function deleteTorrent(hash, deleteFiles = false) {
    await qbRequest("/torrents/delete", "POST", { 
        hashes: hash, 
        deleteFiles: deleteFiles.toString() 
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ║                       DOWNLOAD MONITORING                                    ║
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check for completed downloads and send notifications
 * Runs periodically to track download progress
 */
async function checkDownloads() {
    try {
        const torrents = await getTorrents();
        
        for (const torrent of torrents) {
            const wasActive = state.activeDownloads.has(torrent.hash);
            const isComplete = torrent.progress === 1;
            
            if (wasActive && isComplete) {
                // Download just completed!
                bot.sendMessage(
                    CONFIG.telegramChatId,
                    `✅ *Download Complete!*\n\n📁 ${torrent.name}\n📦 Size: ${formatBytes(torrent.size)}\n📂 Location: \`${torrent.save_path}\``,
                    { parse_mode: "Markdown" }
                );
                state.activeDownloads.delete(torrent.hash);
            } else if (!isComplete && torrent.state !== "pausedDL" && torrent.state !== "pausedUP") {
                // Track active downloads
                state.activeDownloads.set(torrent.hash, torrent.name);
            }
        }
    } catch (error) {
        // Silently fail - qBittorrent might not be running
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ║                         TELEGRAM COMMANDS                                    ║
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * /start - Welcome message and bot introduction
 */
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(msg.from.id)) {
        return sendUnauthorizedMessage(chatId);
    }
    
    const welcomeMessage = `
🎬 *Welcome to MyPlexMonitor!*

I'm your personal Plex server assistant. Here's what I can do:

📡 *Monitoring*
• Real-time server status monitoring
• Automatic alerts when server goes down/up

🎬 *Plex Features*
• View recently added movies and shows
• Browse your library statistics
• Get server information

📥 *Download Management*
• Add torrents directly via magnet links
• Track download progress
• Get notified when downloads complete

Type /help to see all available commands!

_Your Chat ID: \`${chatId}\`_
_Your User ID: \`${msg.from.id}\`_
    `;
    
    bot.sendMessage(chatId, welcomeMessage, { parse_mode: "Markdown" });
});

/**
 * /check - Manual server status check
 */
bot.onText(/\/check/, (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(msg.from.id)) {
        return sendUnauthorizedMessage(chatId);
    }
    
    bot.sendMessage(chatId, "🔎 Checking server status...");
    
    pingServer((isOnline, reason) => {
        state.lastCheck = new Date().toISOString();
        state.stats.checksPerformed++;
        
        if (isOnline) {
            bot.sendMessage(
                chatId,
                `🟢 *Server Status: ONLINE*\n\n📡 Server: \`${CONFIG.serverIp}:${CONFIG.plexPort}\`\n⏰ Last check: ${new Date().toLocaleString()}`,
                { parse_mode: "Markdown" }
            );
            state.isServerOnline = true;
        } else {
            bot.sendMessage(
                chatId,
                `🔴 *Server Status: OFFLINE*\n\n📡 Server: \`${CONFIG.serverIp}:${CONFIG.plexPort}\`\n❌ Reason: ${reason}`,
                { parse_mode: "Markdown" }
            );
            state.isServerOnline = false;
        }
    });
});

/**
 * /recent - Show recently added content from Plex
 */
bot.onText(/\/recent(?:\s+(\d+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(msg.from.id)) {
        return sendUnauthorizedMessage(chatId);
    }
    
    const limit = parseInt(match[1]) || 10; // Default to 10 items
    bot.sendMessage(chatId, "🔎 Retrieving recently added items...");
    
    plexClient
        .query("/library/recentlyAdded")
        .then((result) => {
            const items = result.MediaContainer.Metadata;
            
            if (items && items.length > 0) {
                const limitedItems = items.slice(0, Math.min(limit, 20)); // Max 20 items
                let message = `🆕 *Recently Added* (${limitedItems.length}/${items.length}):\n\n`;
                
                limitedItems.forEach((item, index) => {
                    if (item.type === "movie") {
                        const rating = item.rating ? ` ⭐ ${item.rating.toFixed(1)}` : "";
                        message += `${index + 1}. 🎬 *${item.title}* (${item.year || "N/A"})${rating}\n`;
                    } else if (item.type === "episode") {
                        const episode = `S${String(item.parentIndex).padStart(2, "0")}E${String(item.index).padStart(2, "0")}`;
                        message += `${index + 1}. 📺 *${item.grandparentTitle}* - ${episode}\n   └─ _${item.title}_\n`;
                    } else if (item.type === "season") {
                        message += `${index + 1}. 📺 *${item.parentTitle}* - ${item.title}\n`;
                    } else {
                        message += `${index + 1}. ✨ *${item.title}*\n`;
                    }
                });
                
                message += `\n_Use /recent <number> to see more items_`;
                bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
            } else {
                bot.sendMessage(chatId, "📭 No recently added items found.");
            }
        })
        .catch((err) => {
            console.error("Plex API error:", err);
            bot.sendMessage(
                chatId,
                "🔴 *Error*\n\nFailed to retrieve recently added items.\nCheck your PLEX_TOKEN and server connection.",
                { parse_mode: "Markdown" }
            );
        });
});

/**
 * /stats - Show Plex library statistics
 */
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(msg.from.id)) {
        return sendUnauthorizedMessage(chatId);
    }
    
    bot.sendMessage(chatId, "📊 Gathering library statistics...");
    
    try {
        const libraries = await plexClient.query("/library/sections");
        let message = "📊 *Plex Library Statistics*\n\n";
        
        for (const section of libraries.MediaContainer.Directory) {
            const details = await plexClient.query(`/library/sections/${section.key}/all`);
            const count = details.MediaContainer.size || 0;
            
            let icon = "📁";
            if (section.type === "movie") icon = "🎬";
            else if (section.type === "show") icon = "📺";
            else if (section.type === "artist") icon = "🎵";
            else if (section.type === "photo") icon = "📷";
            
            message += `${icon} *${section.title}*: ${count} items\n`;
        }
        
        // Add bot statistics
        const uptime = Math.floor((Date.now() - state.stats.botStartTime.getTime()) / 1000);
        message += `\n🤖 *Bot Statistics*\n`;
        message += `├ Uptime: ${formatDuration(uptime)}\n`;
        message += `├ Checks: ${state.stats.checksPerformed}\n`;
        message += `├ Alerts: ${state.stats.alertsSent}\n`;
        message += `└ Torrents added: ${state.stats.torrentsAdded}`;
        
        bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    } catch (err) {
        console.error("Plex API error:", err);
        bot.sendMessage(
            chatId,
            "🔴 *Error*\n\nFailed to retrieve library statistics.",
            { parse_mode: "Markdown" }
        );
    }
});

/**
 * /torrent or /download - Add a torrent with interactive type selection
 */
bot.onText(/\/(torrent|download|dl)(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAuthorized(userId)) {
        return sendUnauthorizedMessage(chatId);
    }
    
    const magnetLink = match[2];
    
    if (!magnetLink) {
        bot.sendMessage(
            chatId,
            "📥 *Add Torrent*\n\nUsage: `/torrent <magnet_link>`\nor `/dl <magnet_link>`\n\nYou can also use:\n• `/movie <magnet>` - Download as movie\n• `/series <magnet>` - Download as series",
            { parse_mode: "Markdown" }
        );
        return;
    }
    
    // Validate it's a magnet link
    if (!magnetLink.startsWith("magnet:")) {
        bot.sendMessage(
            chatId,
            "❌ *Invalid Link*\n\nPlease provide a valid magnet link starting with `magnet:`",
            { parse_mode: "Markdown" }
        );
        return;
    }
    
    // Store the magnet link and ask for content type
    state.userStates.set(userId, { magnetLink, step: "select_type" });
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "🎬 Movie", callback_data: "torrent_movie" },
                { text: "📺 Series", callback_data: "torrent_series" },
            ],
            [
                { text: "❌ Cancel", callback_data: "torrent_cancel" },
            ],
        ],
    };
    
    // Try to extract name from magnet link
    let torrentName = "Unknown";
    const dnMatch = magnetLink.match(/dn=([^&]+)/);
    if (dnMatch) {
        torrentName = decodeURIComponent(dnMatch[1].replace(/\+/g, " "));
    }
    
    bot.sendMessage(
        chatId,
        `📥 *New Download*\n\n📁 *Name:* ${torrentName}\n\nWhere should this be saved?`,
        { parse_mode: "Markdown", reply_markup: keyboard }
    );
});

/**
 * /movie - Quick add torrent as movie
 */
bot.onText(/\/movie(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(msg.from.id)) {
        return sendUnauthorizedMessage(chatId);
    }
    
    const magnetLink = match[1];
    
    if (!magnetLink || !magnetLink.startsWith("magnet:")) {
        bot.sendMessage(
            chatId,
            "🎬 *Add Movie*\n\nUsage: `/movie <magnet_link>`",
            { parse_mode: "Markdown" }
        );
        return;
    }
    
    await handleTorrentAdd(chatId, magnetLink, "movie");
});

/**
 * /series - Quick add torrent as series
 */
bot.onText(/\/series(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(msg.from.id)) {
        return sendUnauthorizedMessage(chatId);
    }
    
    const magnetLink = match[1];
    
    if (!magnetLink || !magnetLink.startsWith("magnet:")) {
        bot.sendMessage(
            chatId,
            "📺 *Add Series*\n\nUsage: `/series <magnet_link>`",
            { parse_mode: "Markdown" }
        );
        return;
    }
    
    await handleTorrentAdd(chatId, magnetLink, "series");
});

/**
 * Handle torrent addition with path selection
 * @param {number} chatId - Telegram chat ID
 * @param {string} magnetLink - Magnet link
 * @param {string} type - Content type ("movie" or "series")
 */
async function handleTorrentAdd(chatId, magnetLink, type) {
    const savePath = type === "movie" ? CONFIG.paths.movies : CONFIG.paths.series;
    const emoji = type === "movie" ? "🎬" : "📺";
    
    bot.sendMessage(chatId, `${emoji} Adding ${type} to download queue...`);
    
    try {
        const success = await addTorrent(magnetLink, savePath);
        
        if (success) {
            // Extract name from magnet
            let torrentName = "Unknown";
            const dnMatch = magnetLink.match(/dn=([^&]+)/);
            if (dnMatch) {
                torrentName = decodeURIComponent(dnMatch[1].replace(/\+/g, " "));
            }
            
            bot.sendMessage(
                chatId,
                `✅ *Download Started!*\n\n${emoji} *Type:* ${type.charAt(0).toUpperCase() + type.slice(1)}\n📁 *Name:* ${torrentName}\n📂 *Path:* \`${savePath}\`\n\nUse /downloads to check progress.`,
                { parse_mode: "Markdown" }
            );
        } else {
            throw new Error("Failed to add torrent");
        }
    } catch (error) {
        bot.sendMessage(
            chatId,
            `❌ *Error*\n\nFailed to add torrent. Make sure qBittorrent is running.\n\n_Error: ${error.message}_`,
            { parse_mode: "Markdown" }
        );
    }
}

/**
 * /downloads - Show current downloads
 */
bot.onText(/\/downloads?/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(msg.from.id)) {
        return sendUnauthorizedMessage(chatId);
    }
    
    bot.sendMessage(chatId, "📥 Fetching download status...");
    
    try {
        const torrents = await getTorrents();
        const transferInfo = await getTransferInfo();
        
        if (!torrents || torrents.length === 0) {
            bot.sendMessage(chatId, "📭 No active downloads.");
            return;
        }
        
        // Sort by progress (active first)
        torrents.sort((a, b) => {
            if (a.progress === 1 && b.progress !== 1) return 1;
            if (a.progress !== 1 && b.progress === 1) return -1;
            return b.progress - a.progress;
        });
        
        let message = "📥 *Downloads*\n\n";
        
        // Global speeds
        if (transferInfo) {
            message += `⬇️ ${formatBytes(transferInfo.dl_info_speed)}/s | ⬆️ ${formatBytes(transferInfo.up_info_speed)}/s\n\n`;
        }
        
        // Show first 10 torrents
        const displayTorrents = torrents.slice(0, 10);
        
        for (const torrent of displayTorrents) {
            const progress = Math.round(torrent.progress * 100);
            const progressBar = createProgressBar(progress);
            const status = getStatusEmoji(torrent.state);
            
            // Truncate name if too long
            const name = torrent.name.length > 35 
                ? torrent.name.substring(0, 35) + "..." 
                : torrent.name;
            
            message += `${status} *${name}*\n`;
            message += `${progressBar} ${progress}%`;
            
            if (torrent.progress < 1 && torrent.dlspeed > 0) {
                message += ` | ⬇️ ${formatBytes(torrent.dlspeed)}/s`;
                if (torrent.eta > 0) {
                    message += ` | ⏱️ ${formatDuration(torrent.eta)}`;
                }
            }
            
            message += `\n\n`;
        }
        
        if (torrents.length > 10) {
            message += `_...and ${torrents.length - 10} more torrents_`;
        }
        
        bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    } catch (error) {
        bot.sendMessage(
            chatId,
            `❌ *Error*\n\nFailed to get download status.\nMake sure qBittorrent is running on \`${CONFIG.qbittorrent.host}:${CONFIG.qbittorrent.port}\``,
            { parse_mode: "Markdown" }
        );
    }
});

/**
 * Get status emoji based on torrent state
 * @param {string} state - Torrent state string
 * @returns {string} - Emoji representing the state
 */
function getStatusEmoji(state) {
    const stateMap = {
        downloading: "⬇️",
        uploading: "⬆️",
        stalledDL: "⏳",
        stalledUP: "📤",
        pausedDL: "⏸️",
        pausedUP: "⏸️",
        queuedDL: "📋",
        queuedUP: "📋",
        checkingDL: "🔍",
        checkingUP: "🔍",
        checkingResumeData: "🔍",
        moving: "📦",
        error: "❌",
        missingFiles: "⚠️",
        allocating: "📝",
        metaDL: "🔎",
        forcedDL: "⏬",
        forcedUP: "⏫",
    };
    return stateMap[state] || "❓";
}

/**
 * /pause - Pause all or specific torrent
 */
bot.onText(/\/pause(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(msg.from.id)) {
        return sendUnauthorizedMessage(chatId);
    }
    
    try {
        if (match[1]) {
            // Pause specific torrent by name
            const torrents = await getTorrents();
            const torrent = torrents.find(t => 
                t.name.toLowerCase().includes(match[1].toLowerCase())
            );
            
            if (torrent) {
                await pauseTorrent(torrent.hash);
                bot.sendMessage(chatId, `⏸️ Paused: *${torrent.name}*`, { parse_mode: "Markdown" });
            } else {
                bot.sendMessage(chatId, "❌ Torrent not found.");
            }
        } else {
            // Pause all
            await qbRequest("/torrents/pause", "POST", { hashes: "all" });
            bot.sendMessage(chatId, "⏸️ All downloads paused.");
        }
    } catch (error) {
        bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

/**
 * /resume - Resume all or specific torrent
 */
bot.onText(/\/resume(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(msg.from.id)) {
        return sendUnauthorizedMessage(chatId);
    }
    
    try {
        if (match[1]) {
            // Resume specific torrent by name
            const torrents = await getTorrents();
            const torrent = torrents.find(t => 
                t.name.toLowerCase().includes(match[1].toLowerCase())
            );
            
            if (torrent) {
                await resumeTorrent(torrent.hash);
                bot.sendMessage(chatId, `▶️ Resumed: *${torrent.name}*`, { parse_mode: "Markdown" });
            } else {
                bot.sendMessage(chatId, "❌ Torrent not found.");
            }
        } else {
            // Resume all
            await qbRequest("/torrents/resume", "POST", { hashes: "all" });
            bot.sendMessage(chatId, "▶️ All downloads resumed.");
        }
    } catch (error) {
        bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

/**
 * /delete - Delete a torrent
 */
bot.onText(/\/delete(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAuthorized(userId)) {
        return sendUnauthorizedMessage(chatId);
    }
    
    if (!match[1]) {
        bot.sendMessage(
            chatId,
            "🗑️ *Delete Torrent*\n\nUsage: `/delete <torrent_name>`\n\n_Use /downloads to see torrent names_",
            { parse_mode: "Markdown" }
        );
        return;
    }
    
    try {
        const torrents = await getTorrents();
        const torrent = torrents.find(t => 
            t.name.toLowerCase().includes(match[1].toLowerCase())
        );
        
        if (torrent) {
            // Store for confirmation
            state.userStates.set(userId, { 
                hash: torrent.hash, 
                name: torrent.name,
                step: "confirm_delete" 
            });
            
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: "🗑️ Delete (keep files)", callback_data: "delete_keep" },
                        { text: "🔥 Delete with files", callback_data: "delete_files" },
                    ],
                    [
                        { text: "❌ Cancel", callback_data: "delete_cancel" },
                    ],
                ],
            };
            
            bot.sendMessage(
                chatId,
                `🗑️ *Delete Torrent?*\n\n📁 *${torrent.name}*\n📦 Size: ${formatBytes(torrent.size)}`,
                { parse_mode: "Markdown", reply_markup: keyboard }
            );
        } else {
            bot.sendMessage(chatId, "❌ Torrent not found.");
        }
    } catch (error) {
        bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

/**
 * /server - Show server system information
 */
bot.onText(/\/server/, (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(msg.from.id)) {
        return sendUnauthorizedMessage(chatId);
    }
    
    // Get local system info (where bot is running)
    const uptime = os.uptime();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);
    const cpuCores = os.cpus().length;
    const loadAvg = os.loadavg()[0].toFixed(2);
    
    const message = `
🖥️ *Server Information*

📡 *Plex Server:* \`${CONFIG.serverIp}:${CONFIG.plexPort}\`
🟢 Status: ${state.isServerOnline ? "Online" : "Offline"}

📥 *qBittorrent:* \`${CONFIG.qbittorrent.host}:${CONFIG.qbittorrent.port}\`
${state.qbConnected ? "🟢" : "🔴"} Status: ${state.qbConnected ? "Connected" : "Disconnected"}

💾 *Memory Usage*
├ Used: ${formatBytes(usedMem)} / ${formatBytes(totalMem)}
├ Free: ${formatBytes(freeMem)}
└ Usage: ${createProgressBar(memPercent)} ${memPercent}%

⚙️ *CPU*
├ Cores: ${cpuCores}
└ Load: ${loadAvg}

⏱️ *Bot Uptime:* ${formatDuration(Math.floor((Date.now() - state.stats.botStartTime.getTime()) / 1000))}
🖥️ *System Uptime:* ${formatDuration(uptime)}
    `;
    
    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
});

/**
 * /search - Search on your Plex library
 */
bot.onText(/\/search(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(msg.from.id)) {
        return sendUnauthorizedMessage(chatId);
    }
    
    const query = match[1];
    
    if (!query) {
        bot.sendMessage(
            chatId,
            "🔍 *Search Library*\n\nUsage: `/search <movie or show name>`",
            { parse_mode: "Markdown" }
        );
        return;
    }
    
    bot.sendMessage(chatId, `🔍 Searching for "${query}"...`);
    
    try {
        const result = await plexClient.query(`/search?query=${encodeURIComponent(query)}`);
        const items = result.MediaContainer.Metadata;
        
        if (items && items.length > 0) {
            let message = `🔍 *Search Results for "${query}":*\n\n`;
            
            const limitedItems = items.slice(0, 10);
            
            for (const item of limitedItems) {
                if (item.type === "movie") {
                    const rating = item.rating ? ` ⭐ ${item.rating.toFixed(1)}` : "";
                    message += `🎬 *${item.title}* (${item.year || "N/A"})${rating}\n`;
                } else if (item.type === "show") {
                    message += `📺 *${item.title}* (${item.year || "N/A"})\n`;
                } else if (item.type === "episode") {
                    const episode = `S${String(item.parentIndex).padStart(2, "0")}E${String(item.index).padStart(2, "0")}`;
                    message += `📺 *${item.grandparentTitle}* - ${episode}: ${item.title}\n`;
                }
            }
            
            if (items.length > 10) {
                message += `\n_...and ${items.length - 10} more results_`;
            }
            
            bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
        } else {
            bot.sendMessage(chatId, `📭 No results found for "${query}".`);
        }
    } catch (error) {
        console.error("Search error:", error);
        bot.sendMessage(chatId, "❌ Error searching library.");
    }
});

/**
 * /help - Show all available commands
 */
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(msg.from.id)) {
        return sendUnauthorizedMessage(chatId);
    }
    
    const helpMessage = `
📚 *MyPlexMonitor Commands*

📡 *Monitoring*
├ /check - Check Plex server status
├ /server - Show server system info
└ /stats - Library statistics

🎬 *Plex Library*
├ /recent [n] - Recently added (n items)
└ /search <query> - Search library

📥 *Downloads (qBittorrent)*
├ /torrent <magnet> - Add torrent (interactive)
├ /movie <magnet> - Add as movie
├ /series <magnet> - Add as series
├ /downloads - View active downloads
├ /pause [name] - Pause all/one
├ /resume [name] - Resume all/one
└ /delete <name> - Delete torrent

ℹ️ *Other*
├ /start - Welcome message
└ /help - This help message

📂 *Download Paths*
├ Movies: \`${CONFIG.paths.movies}\`
└ Series: \`${CONFIG.paths.series}\`
    `;
    
    bot.sendMessage(chatId, helpMessage, { parse_mode: "Markdown" });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ║                         CALLBACK HANDLERS                                    ║
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle inline keyboard button callbacks
 */
bot.on("callback_query", async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;
    
    // Acknowledge the callback
    bot.answerCallbackQuery(callbackQuery.id);
    
    // Get user state
    const userState = state.userStates.get(userId);
    
    // Handle torrent type selection
    if (data.startsWith("torrent_")) {
        if (!userState || userState.step !== "select_type") {
            bot.editMessageText("❌ Session expired. Please try again.", {
                chat_id: chatId,
                message_id: messageId,
            });
            return;
        }
        
        if (data === "torrent_cancel") {
            state.userStates.delete(userId);
            bot.editMessageText("❌ Download cancelled.", {
                chat_id: chatId,
                message_id: messageId,
            });
            return;
        }
        
        const type = data === "torrent_movie" ? "movie" : "series";
        const magnetLink = userState.magnetLink;
        
        state.userStates.delete(userId);
        
        bot.editMessageText(`⏳ Adding ${type} to download queue...`, {
            chat_id: chatId,
            message_id: messageId,
        });
        
        await handleTorrentAdd(chatId, magnetLink, type);
    }
    
    // Handle delete confirmation
    if (data.startsWith("delete_")) {
        if (!userState || userState.step !== "confirm_delete") {
            bot.editMessageText("❌ Session expired. Please try again.", {
                chat_id: chatId,
                message_id: messageId,
            });
            return;
        }
        
        if (data === "delete_cancel") {
            state.userStates.delete(userId);
            bot.editMessageText("❌ Deletion cancelled.", {
                chat_id: chatId,
                message_id: messageId,
            });
            return;
        }
        
        const deleteFiles = data === "delete_files";
        
        try {
            await deleteTorrent(userState.hash, deleteFiles);
            state.userStates.delete(userId);
            
            const msg = deleteFiles 
                ? `🔥 Deleted with files: *${userState.name}*`
                : `🗑️ Deleted: *${userState.name}*`;
            
            bot.editMessageText(msg, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
            });
        } catch (error) {
            bot.editMessageText(`❌ Error: ${error.message}`, {
                chat_id: chatId,
                message_id: messageId,
            });
        }
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ║                           ERROR HANDLING                                     ║
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle polling errors gracefully
 */
bot.on("polling_error", (error) => {
    if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
        console.error("⚠️  Telegram 409 Conflict: Another bot instance is running!");
        console.error("   💡 Solution: Stop all other instances or use webhooks in production");
    } else {
        console.error("Telegram polling error:", error.message);
    }
});

/**
 * Handle uncaught errors
 */
process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ║                              STARTUP                                         ║
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate configuration before starting
 */
function validateConfig() {
    const errors = [];
    const warnings = [];
    
    // Critical checks
    if (!CONFIG.telegramToken) {
        errors.push("❌ TELEGRAM_TOKEN is not configured!");
    }
    if (!CONFIG.serverIp) {
        errors.push("❌ SERVER_IP is not configured!");
    }
    if (!CONFIG.plexToken) {
        warnings.push("⚠️  PLEX_TOKEN is not configured - Plex features will be limited");
    }
    if (!CONFIG.telegramChatId) {
        warnings.push("⚠️  TELEGRAM_CHAT_ID is not configured - automatic alerts disabled");
    }
    
    // qBittorrent host check
    if (CONFIG.qbittorrent.host === "localhost" && CONFIG.isProduction) {
        warnings.push("⚠️  qBittorrent host is 'localhost' but SERVER_IP might not be configured");
        warnings.push("   💡 Set SERVER_IP environment variable to your server's IP address");
    }
    
    // Webhook check for production
    if (CONFIG.isProduction && !CONFIG.webhookUrl) {
        warnings.push("⚠️  WEBHOOK_URL not configured - falling back to polling (may cause 409 errors)");
        warnings.push("   💡 Set WEBHOOK_URL to https://myplexmonitor.onrender.com for production");
    }
    
    // Display results
    if (errors.length > 0) {
        console.log("\n🚨 CONFIGURATION ERRORS:");
        errors.forEach(err => console.log(err));
        console.log("\n⚠️  Bot may not work correctly!\n");
    }
    
    if (warnings.length > 0) {
        console.log("\n⚠️  CONFIGURATION WARNINGS:");
        warnings.forEach(warn => console.log(warn));
        console.log();
    }
    
    return errors.length === 0;
}

// Validate configuration
const configValid = validateConfig();

// Start the automatic monitoring loop
setInterval(autoCheck, CONFIG.checkInterval);

// Start the download completion checker
setInterval(checkDownloads, CONFIG.downloadCheckInterval);

// Initial qBittorrent connection attempt
qbLogin().then((success) => {
    if (success) {
        console.log("✅ Connected to qBittorrent");
    } else {
        console.log("⚠️  Could not connect to qBittorrent - torrent features will be limited");
    }
});

// Test Plex connection
pingServer((isOnline, reason) => {
    if (isOnline) {
        console.log("✅ Plex server is reachable");
    } else {
        console.log(`⚠️  Plex server is not reachable: ${reason}`);
    }
});

// Startup complete message
console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                         🎬 MyPlexMonitor Started! 🎬                         ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Mode: ${CONFIG.isProduction ? "PRODUCTION" : "DEVELOPMENT"}                                                   
║  Server IP: ${CONFIG.serverIp || "NOT SET"}                                            
║  Plex Port: ${CONFIG.plexPort}                                                  
║  qBittorrent: ${CONFIG.qbittorrent.host}:${CONFIG.qbittorrent.port}                                      
║  Check Interval: ${CONFIG.checkInterval / 1000}s                                                  
║  Web Port: ${CONFIG.webPort}                                                        
╚══════════════════════════════════════════════════════════════════════════════╝
`);
