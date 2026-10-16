require("dotenv").config();

const net = require("net");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const os = require("os");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────
function parseIntEnv(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

const CONFIG = {
    role: (process.env.ROLE || "LOCAL").toUpperCase() === "BACKUP" ? "BACKUP" : "LOCAL",
    plexIp: process.env.PLEX_IP || "127.0.0.1",
    plexPort: parseIntEnv(process.env.PLEX_PORT, 32400),
    checkInterval: parseIntEnv(process.env.CHECK_INTERVAL, 30000),
    telegramToken: process.env.TELEGRAM_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    port: parseIntEnv(process.env.PORT, 3000),
    qbit: {
        host: process.env.QBITTORRENT_HOST || "127.0.0.1",
        port: parseIntEnv(process.env.QBITTORRENT_PORT, 8080),
        username: process.env.QBITTORRENT_USERNAME || "admin",
        password: process.env.QBITTORRENT_PASSWORD || "adminadmin",
        categoryMovie: process.env.QBITTORRENT_CATEGORY_MOVIE || "movies",
        categorySeries: process.env.QBITTORRENT_CATEGORY_SERIES || "series",
        categoryOther: process.env.QBITTORRENT_CATEGORY_OTHER || "other",
        pathMovie: process.env.MOVIES_PATH || "/mnt/films",
        pathSeries: process.env.SERIES_PATH || "/mnt/films/series",
        pathOther: process.env.OTHER_PATH || "/mnt/films/downloads",
    },
};

if (!CONFIG.telegramToken) {
    console.error("❌ TELEGRAM_TOKEN est obligatoire.");
    process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// État global
// ─────────────────────────────────────────────────────────────────────────────
const state = {
    isServerOnline: true,
    failureCount: 0,
    lastDownTime: null,
    lastDownReason: null,
    lastCheckReason: "Aucune vérification encore effectuée",
    telegramPollingActive: CONFIG.role === "LOCAL",
    torrentSessions: new Map(),
    awaitingCustomPath: new Set(),
    downloadsView: new Map(),
    qbitSid: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires généraux
// ─────────────────────────────────────────────────────────────────────────────
function pad(number) {
    return String(number).padStart(2, "0");
}

function getFormattedDate() {
    const parts = new Intl.DateTimeFormat("fr-CH", {
        timeZone: "Europe/Zurich",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(new Date());

    const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
    return `[${map.year}-${map.month}-${map.day}] ${map.hour}:${map.minute}:${map.second} CEST`;
}

function logInfo(message) {
    console.log(`${getFormattedDate()} ${message}`);
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function getTorrentStatusLabel(qbitState) {
    if (["pausedDL", "pausedUP"].includes(qbitState)) return "⏸️ Pause";
    if (["uploading", "forcedUP", "stalledUP"].includes(qbitState)) return "⬆️ Seed";
    if (["queuedDL", "metaDL", "checkingDL", "checkingResumeData"].includes(qbitState)) return "🕓 Attente";
    if (["error", "missingFiles"].includes(qbitState)) return "❌ Erreur";
    if (["stalledDL"].includes(qbitState)) return "⚠️ Bloqué";
    return "⬇️ Téléchargement";
}

function createProgressBar(percent, length = 10) {
    const safePercent = Math.max(0, Math.min(100, percent));
    const filled = Math.round((safePercent / 100) * length);
    return `${"█".repeat(filled)}${"░".repeat(length - filled)}`;
}

async function safeSendMessage(chatId, text, options = {}) {
    try {
        await bot.sendMessage(chatId, text, options);
    } catch (error) {
        logInfo(`⚠️ Envoi Telegram échoué: ${error.message}`);
    }
}

async function sendAlert(text, options = {}) {
    if (!CONFIG.telegramChatId) {
        logInfo("⚠️ TELEGRAM_CHAT_ID absent: alerte ignorée.");
        return;
    }
    await safeSendMessage(CONFIG.telegramChatId, text, options);
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram bot + failover anti-409
// ─────────────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(CONFIG.telegramToken, { polling: CONFIG.role === "LOCAL" });

bot.on("polling_error", (error) => {
    logInfo(`⚠️ polling_error: ${error.message}`);
});

function isPollingActive() {
    try {
        if (typeof bot.isPolling === "function") {
            return bot.isPolling();
        }
    } catch (error) {
        // no-op
    }
    return state.telegramPollingActive;
}

async function startPollingSafely() {
    if (isPollingActive()) return;
    try {
        await bot.startPolling();
        state.telegramPollingActive = true;
        logInfo("✅ Polling Telegram activé.");
    } catch (error) {
        logInfo(`❌ Impossible d'activer le polling: ${error.message}`);
    }
}

async function stopPollingSafely() {
    if (!isPollingActive()) return;
    try {
        await bot.stopPolling();
        state.telegramPollingActive = false;
        logInfo("✅ Polling Telegram arrêté.");
    } catch (error) {
        logInfo(`❌ Impossible d'arrêter le polling: ${error.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Express (healthcheck/keep-alive)
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        status: "running",
        role: CONFIG.role,
        isServerOnline: state.isServerOnline,
        failureCount: state.failureCount,
        lastDownTime: state.lastDownTime,
        timestamp: getFormattedDate(),
    });
});

app.listen(CONFIG.port, () => {
    logInfo(`🌐 API HTTP prête sur le port ${CONFIG.port} (ROLE=${CONFIG.role})`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Vérification serveur Plex (TCP)
// ─────────────────────────────────────────────────────────────────────────────
function pingServer() {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const targetHost = CONFIG.role === "LOCAL" ? "127.0.0.1" : CONFIG.plexIp;

        socket.setTimeout(5000);

        socket.on("connect", () => {
            socket.destroy();
            resolve({ online: true, reason: "Connexion TCP établie" });
        });

        socket.on("timeout", () => {
            socket.destroy();
            resolve({ online: false, reason: "Timeout TCP (5s)" });
        });

        socket.on("error", (err) => {
            socket.destroy();
            resolve({ online: false, reason: `Erreur TCP: ${err.code || err.message}` });
        });

        socket.connect(CONFIG.plexPort, targetHost);
    });
}

async function autoCheck() {
    try {
        const result = await pingServer();
        state.lastCheckReason = result.reason;

        if (result.online) {
            if (!state.isServerOnline) {
                state.isServerOnline = true;
                state.failureCount = 0;

                if (CONFIG.role === "BACKUP") {
                    await stopPollingSafely();
                    await sendAlert(
                        `✅ *RETOUR EN LIGNE*\n\nLe serveur Ubuntu répond de nouveau.\nRender repasse en veille silencieuse.\n🕒 ${getFormattedDate()}`,
                        { parse_mode: "Markdown" }
                    );
                } else {
                    await sendAlert(
                        `✅ *Plex de nouveau opérationnel*\n\nLe service Plex répond à nouveau en local.\n🕒 ${getFormattedDate()}`,
                        { parse_mode: "Markdown" }
                    );
                }
            } else {
                state.failureCount = 0;
            }
            return;
        }

        state.failureCount += 1;

        if (state.failureCount < 2) {
            return;
        }

        if (state.isServerOnline) {
            state.isServerOnline = false;
            state.lastDownTime = getFormattedDate();
            state.lastDownReason = result.reason;

            if (CONFIG.role === "LOCAL") {
                await sendAlert(
                    `⚠️ *Plex ne répond plus en local*\n\nLe serveur Ubuntu est allumé mais le service Plex ne répond pas.\nCause: ${result.reason}\n💡 Essayez /restart_plex\n🕒 ${state.lastDownTime}`,
                    { parse_mode: "Markdown" }
                );
            } else {
                await sendAlert(
                    `🚨 *ALERTE CRITIQUE BACKUP*\n\nLe serveur Ubuntu est injoignable depuis Internet.\nCause probable: coupure électrique, réseau ou câble.\nCause TCP: ${result.reason}\n🕒 ${state.lastDownTime}`,
                    { parse_mode: "Markdown" }
                );
                await startPollingSafely();
            }
        }
    } catch (error) {
        logInfo(`❌ Erreur autoCheck: ${error.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic Ubuntu (LOCAL uniquement)
// ─────────────────────────────────────────────────────────────────────────────
async function getUbuntuDiagnostics() {
    if (CONFIG.role !== "LOCAL") {
        return "Mode BACKUP: diagnostics système Ubuntu non disponibles.";
    }

    const uptimeMin = Math.floor(os.uptime() / 60);
    const loadAvg = os.loadavg().map((v) => v.toFixed(2)).join(" / ");
    const freeRamMb = Math.round(os.freemem() / 1024 / 1024);
    const totalRamMb = Math.round(os.totalmem() / 1024 / 1024);

    let shutdownStatus = "Impossible de déterminer l'état du dernier arrêt.";

    try {
        const { stdout } = await execAsync("last -x -n 2 shutdown reboot", { timeout: 6000 });
        const lines = stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => line.startsWith("shutdown") || line.startsWith("reboot"));

        const hasShutdown = lines.some((line) => line.startsWith("shutdown"));
        const hasReboot = lines.some((line) => line.startsWith("reboot"));

        if (hasShutdown) {
            shutdownStatus = "✅ Dernier arrêt détecté comme propre (shutdown trouvé).";
        } else if (hasReboot) {
            shutdownStatus = "⚠️ Redémarrage sans trace de shutdown: possible coupure brutale.";
        }
    } catch (error) {
        shutdownStatus = `⚠️ Analyse du journal d'arrêt indisponible (${error.message}).`;
    }

    return [
        "🖥️ *Diagnostic Ubuntu*",
        `- Uptime: ${uptimeMin} min`,
        `- LoadAvg: ${loadAvg}`,
        `- RAM: ${freeRamMb} Mo libres / ${totalRamMb} Mo`,
        `- Arrêt précédent: ${shutdownStatus}`,
    ].join("\n");
}

async function handleShutdownSignal(signal) {
    if (CONFIG.role === "LOCAL") {
        await sendAlert(
            `🛑 *Extinction propre du système Ubuntu détectée*\nSignal reçu: ${signal}\n🕒 ${getFormattedDate()}`,
            { parse_mode: "Markdown" }
        );
    }
    process.exit(0);
}

process.on("SIGINT", () => {
    handleShutdownSignal("SIGINT");
});

process.on("SIGTERM", () => {
    handleShutdownSignal("SIGTERM");
});

process.on("uncaughtException", (error) => {
    logInfo(`❌ Uncaught Exception: ${error.message}`);
});

process.on("unhandledRejection", (reason) => {
    logInfo(`❌ Unhandled Rejection: ${reason}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Intégration qBittorrent
// ─────────────────────────────────────────────────────────────────────────────
const qbitHttp = axios.create({
    baseURL: `http://${CONFIG.qbit.host}:${CONFIG.qbit.port}/api/v2`,
    timeout: 10000,
});

async function qbitLogin() {
    const body = new URLSearchParams({
        username: CONFIG.qbit.username,
        password: CONFIG.qbit.password,
    }).toString();

    const response = await qbitHttp.post("/auth/login", body, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const cookies = response.headers["set-cookie"] || [];
    const sidCookie = cookies.find((c) => c.startsWith("SID="));

    if (!sidCookie && response.data !== "Ok.") {
        throw new Error("Authentification qBittorrent échouée");
    }

    state.qbitSid = sidCookie ? sidCookie.split(";")[0] : null;
}

async function qbitRequest(path, method = "GET", data = null, retry = true) {
    try {
        if (!state.qbitSid) {
            await qbitLogin();
        }

        const response = await qbitHttp.request({
            url: path,
            method,
            headers: state.qbitSid ? { Cookie: state.qbitSid } : {},
            data: data ? new URLSearchParams(data).toString() : undefined,
        });

        return response.data;
    } catch (error) {
        if (retry && [401, 403].includes(error.response?.status || 0)) {
            state.qbitSid = null;
            return qbitRequest(path, method, data, false);
        }
        throw error;
    }
}

async function listTorrents(filter = "all") {
    const torrents = await qbitRequest(`/torrents/info?filter=${encodeURIComponent(filter)}`);
    return Array.isArray(torrents) ? torrents : [];
}

async function addTorrentWithOptions(options) {
    const payload = {
        urls: options.source,
        savepath: options.savePath,
        category: options.category || "",
        paused: options.startPaused ? "true" : "false",
        autoTMM: "false",
    };

    await qbitRequest("/torrents/add", "POST", payload);

    if (options.priority && options.priority !== "normal") {
        await applyPriorityBestEffort(options);
    }
}

async function applyPriorityBestEffort(options) {
    try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const torrents = await listTorrents("all");
        const candidates = torrents
            .filter((torrent) => torrent.save_path?.startsWith(options.savePath))
            .sort((a, b) => (b.added_on || 0) - (a.added_on || 0));

        if (candidates.length === 0) return;

        const hash = candidates[0].hash;
        if (options.priority === "high") {
            await qbitRequest("/torrents/topPrio", "POST", { hashes: hash });
        }
        if (options.priority === "low") {
            await qbitRequest("/torrents/bottomPrio", "POST", { hashes: hash });
        }
    } catch (error) {
        logInfo(`⚠️ Priorité non appliquée: ${error.message}`);
    }
}

async function pauseAllTorrents() {
    await qbitRequest("/torrents/pause", "POST", { hashes: "all" });
}

async function resumeAllTorrents() {
    await qbitRequest("/torrents/resume", "POST", { hashes: "all" });
}

async function pauseTorrentByName(name) {
    const torrents = await listTorrents("all");
    const torrent = torrents.find((t) => t.name.toLowerCase().includes(name.toLowerCase()));
    if (!torrent) throw new Error("Torrent introuvable");
    await qbitRequest("/torrents/pause", "POST", { hashes: torrent.hash });
    return torrent.name;
}

async function resumeTorrentByName(name) {
    const torrents = await listTorrents("all");
    const torrent = torrents.find((t) => t.name.toLowerCase().includes(name.toLowerCase()));
    if (!torrent) throw new Error("Torrent introuvable");
    await qbitRequest("/torrents/resume", "POST", { hashes: torrent.hash });
    return torrent.name;
}

async function deleteTorrentByName(name) {
    const torrents = await listTorrents("all");
    const torrent = torrents.find((t) => t.name.toLowerCase().includes(name.toLowerCase()));
    if (!torrent) throw new Error("Torrent introuvable");
    await qbitRequest("/torrents/delete", "POST", { hashes: torrent.hash, deleteFiles: "false" });
    return torrent.name;
}

async function deleteCompletedTorrents() {
    const completed = await listTorrents("completed");
    if (completed.length === 0) return 0;
    const hashes = completed.map((torrent) => torrent.hash).join("|");
    await qbitRequest("/torrents/delete", "POST", { hashes, deleteFiles: "false" });
    return completed.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// UI Telegram torrents
// ─────────────────────────────────────────────────────────────────────────────
function initializeTorrentSession(chatId, source, mediaType = "movie") {
    const defaults = {
        movie: { savePath: CONFIG.qbit.pathMovie, category: CONFIG.qbit.categoryMovie },
        series: { savePath: CONFIG.qbit.pathSeries, category: CONFIG.qbit.categorySeries },
        other: { savePath: CONFIG.qbit.pathOther, category: CONFIG.qbit.categoryOther },
    };

    const selected = defaults[mediaType] || defaults.movie;

    state.torrentSessions.set(chatId, {
        source,
        mediaType,
        savePath: selected.savePath,
        category: selected.category,
        priority: "normal",
        startPaused: false,
    });
}

async function askMediaType(chatId) {
    await safeSendMessage(chatId, "🎯 Choisis le type de contenu:", {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🎬 Film", callback_data: "tw:type:movie" },
                    { text: "📺 Série", callback_data: "tw:type:series" },
                ],
                [{ text: "📦 Autre", callback_data: "tw:type:other" }],
                [{ text: "❌ Annuler", callback_data: "tw:cancel" }],
            ],
        },
    });
}

async function askSavePath(chatId) {
    await safeSendMessage(chatId, "📂 Choisis le dossier de destination:", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🎬 Dossier Films", callback_data: "tw:path:movie" }],
                [{ text: "📺 Dossier Séries", callback_data: "tw:path:series" }],
                [{ text: "📦 Dossier Autre", callback_data: "tw:path:other" }],
                [{ text: "✍️ Saisir un chemin personnalisé", callback_data: "tw:path:custom" }],
            ],
        },
    });
}

async function askCategory(chatId) {
    await safeSendMessage(chatId, "🏷️ Choisis une catégorie qBittorrent:", {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🎬 movies", callback_data: "tw:cat:movie" },
                    { text: "📺 series", callback_data: "tw:cat:series" },
                ],
                [
                    { text: "📦 other", callback_data: "tw:cat:other" },
                    { text: "➖ Aucune", callback_data: "tw:cat:none" },
                ],
            ],
        },
    });
}

async function askPriority(chatId) {
    await safeSendMessage(chatId, "⚡ Choisis la priorité de file:", {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🔺 Haute", callback_data: "tw:prio:high" },
                    { text: "⏺️ Normale", callback_data: "tw:prio:normal" },
                    { text: "🔻 Basse", callback_data: "tw:prio:low" },
                ],
            ],
        },
    });
}

async function askStartMode(chatId) {
    await safeSendMessage(chatId, "▶️ Démarrage du torrent:", {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "▶️ Démarrer tout de suite", callback_data: "tw:paused:false" },
                    { text: "⏸️ Ajouter en pause", callback_data: "tw:paused:true" },
                ],
            ],
        },
    });
}

function buildTorrentSummary(session) {
    return [
        "✅ *Récapitulatif du torrent*",
        `- Type: ${session.mediaType}`,
        `- Dossier: \`${session.savePath}\``,
        `- Catégorie: ${session.category || "aucune"}`,
        `- Priorité: ${session.priority}`,
        `- Démarrage: ${session.startPaused ? "en pause" : "immédiat"}`,
    ].join("\n");
}

async function askConfirmation(chatId, session) {
    await safeSendMessage(chatId, buildTorrentSummary(session), {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "✅ Confirmer l'ajout", callback_data: "tw:confirm" },
                    { text: "✏️ Modifier dossier", callback_data: "tw:path:custom" },
                ],
                [{ text: "❌ Annuler", callback_data: "tw:cancel" }],
            ],
        },
    });
}

function parseFilterArg(rawArg) {
    const normalized = (rawArg || "all").toLowerCase();
    if (["active", "actif", "actifs"].includes(normalized)) return "downloading";
    if (["paused", "pause"].includes(normalized)) return "paused";
    if (["completed", "done", "termine", "terminé", "finished"].includes(normalized)) return "completed";
    return "all";
}

async function renderDownloads(chatId, filter = "all", page = 0, editMeta = null) {
    const torrents = await listTorrents(filter);
    const pageSize = 5;
    const totalPages = Math.max(1, Math.ceil(torrents.length / pageSize));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const startIndex = safePage * pageSize;
    const pageItems = torrents.slice(startIndex, startIndex + pageSize);

    state.downloadsView.set(chatId, { filter, page: safePage });

    let message = `📥 *Téléchargements* (${filter})\nPage ${safePage + 1}/${totalPages}\n\n`;

    if (pageItems.length === 0) {
        message += "Aucun torrent pour ce filtre.";
    }

    for (const torrent of pageItems) {
        const percent = Math.round((torrent.progress || 0) * 100);
        const eta = torrent.eta > 0 ? formatDuration(torrent.eta) : "n/a";
        message += [
            `*${torrent.name.replace(/\*/g, "")}*`,
            `${getTorrentStatusLabel(torrent.state)} ${createProgressBar(percent)} ${percent}%`,
            `⬇️ ${formatBytes(torrent.dlspeed || 0)}/s | ⬆️ ${formatBytes(torrent.upspeed || 0)}/s | ETA ${eta}`,
            "",
        ].join("\n");
    }

    const keyboard = {
        inline_keyboard: [
            [
                { text: "⬅️", callback_data: "dl:page:prev" },
                { text: "🔄 Rafraîchir", callback_data: "dl:refresh" },
                { text: "➡️", callback_data: "dl:page:next" },
            ],
            [
                { text: "Actifs", callback_data: "dl:filter:downloading" },
                { text: "En pause", callback_data: "dl:filter:paused" },
                { text: "Terminés", callback_data: "dl:filter:completed" },
            ],
            [
                { text: "⏸️ Tout pause", callback_data: "dl:batch:pause" },
                { text: "▶️ Tout reprendre", callback_data: "dl:batch:resume" },
            ],
            [{ text: "🗑️ Supprimer terminés", callback_data: "dl:batch:cleanup" }],
        ],
    };

    if (editMeta) {
        await bot.editMessageText(message, {
            chat_id: editMeta.chatId,
            message_id: editMeta.messageId,
            parse_mode: "Markdown",
            reply_markup: keyboard,
        });
        return;
    }

    await safeSendMessage(chatId, message, { parse_mode: "Markdown", reply_markup: keyboard });
}

// ─────────────────────────────────────────────────────────────────────────────
// Commandes Telegram
// ─────────────────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await safeSendMessage(
        chatId,
        `👋 *MyPlexMonitor prêt*\n\nRôle actif: *${CONFIG.role}*\n\nUtilise /help pour voir toutes les commandes.`,
        { parse_mode: "Markdown" }
    );
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const text = [
        `📚 *Commandes disponibles* (rôle: ${CONFIG.role})`,
        "",
        "📡 Monitoring",
        "- /check",
        "- /restart_plex",
        "",
        "📥 Torrents",
        "- /torrent <magnet|url>",
        "- /movie <magnet|url>",
        "- /series <magnet|url>",
        "- /downloads [all|active|paused|completed]",
        "- /pause [nom]",
        "- /resume [nom]",
        "- /delete <nom>",
        "",
        "💡 Le mode BACKUP n'écoute Telegram que pendant une panne Ubuntu.",
    ].join("\n");
    await safeSendMessage(chatId, text, { parse_mode: "Markdown" });
});

bot.onText(/\/check/, async (msg) => {
    const chatId = msg.chat.id;

    try {
        const result = await pingServer();
        const statusLine = result.online ? "🟢 ONLINE" : "🔴 OFFLINE";

        if (CONFIG.role === "LOCAL") {
            const diagnostics = await getUbuntuDiagnostics();
            await safeSendMessage(
                chatId,
                `🔎 *Vérification immédiate*\nStatut Plex: ${statusLine}\nCause technique: ${result.reason}\n🕒 ${getFormattedDate()}\n\n${diagnostics}`,
                { parse_mode: "Markdown" }
            );
            return;
        }

        await safeSendMessage(
            chatId,
            [
                "🔎 *Vérification BACKUP*",
                `Statut distant Plex: ${statusLine}`,
                `Cause technique: ${result.reason}`,
                `Dernière panne mémorisée: ${state.lastDownTime || "inconnue"}`,
                `Raison mémorisée: ${state.lastDownReason || "non déterminée"}`,
                `Horodatage: ${getFormattedDate()}`,
            ].join("\n"),
            { parse_mode: "Markdown" }
        );
    } catch (error) {
        await safeSendMessage(chatId, `❌ Erreur pendant /check: ${error.message}`);
    }
});

bot.onText(/\/restart_plex/, async (msg) => {
    const chatId = msg.chat.id;

    if (CONFIG.role === "BACKUP") {
        await safeSendMessage(
            chatId,
            "❌ Impossible: redémarrage logiciel indisponible car le serveur Ubuntu physique est hors ligne."
        );
        return;
    }

    try {
        await safeSendMessage(chatId, "♻️ Redémarrage de plexmediaserver en cours...");
        await execAsync("sudo systemctl restart plexmediaserver", { timeout: 20000 });
        await safeSendMessage(chatId, "✅ Commande systemctl exécutée. Vérification dans 5 secondes...");

        setTimeout(async () => {
            const result = await pingServer();
            await safeSendMessage(
                chatId,
                result.online
                    ? `✅ Plex répond à nouveau après redémarrage. (${getFormattedDate()})`
                    : `⚠️ Plex ne répond toujours pas: ${result.reason} (${getFormattedDate()})`
            );
        }, 5000);
    } catch (error) {
        await safeSendMessage(chatId, `❌ Échec du redémarrage: ${error.message}`);
    }
});

bot.onText(/\/torrent(?:\s+(.+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const source = (match?.[1] || "").trim();

    if (!source) {
        await safeSendMessage(chatId, "Usage: /torrent <magnet|url>");
        return;
    }

    initializeTorrentSession(chatId, source, "movie");
    await askMediaType(chatId);
});

bot.onText(/\/movie(?:\s+(.+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const source = (match?.[1] || "").trim();
    if (!source) {
        await safeSendMessage(chatId, "Usage: /movie <magnet|url>");
        return;
    }
    initializeTorrentSession(chatId, source, "movie");
    await askSavePath(chatId);
});

bot.onText(/\/series(?:\s+(.+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const source = (match?.[1] || "").trim();
    if (!source) {
        await safeSendMessage(chatId, "Usage: /series <magnet|url>");
        return;
    }
    initializeTorrentSession(chatId, source, "series");
    await askSavePath(chatId);
});

bot.onText(/\/downloads?(?:\s+(\S+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const filter = parseFilterArg(match?.[1]);

    try {
        await renderDownloads(chatId, filter, 0);
    } catch (error) {
        await safeSendMessage(chatId, `❌ Impossible de charger les torrents: ${error.message}`);
    }
});

bot.onText(/\/pause(?:\s+(.+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const name = (match?.[1] || "").trim();

    try {
        if (!name) {
            await pauseAllTorrents();
            await safeSendMessage(chatId, "⏸️ Tous les torrents sont en pause.");
            return;
        }

        const pausedName = await pauseTorrentByName(name);
        await safeSendMessage(chatId, `⏸️ Torrent en pause: ${pausedName}`);
    } catch (error) {
        await safeSendMessage(chatId, `❌ /pause: ${error.message}`);
    }
});

bot.onText(/\/resume(?:\s+(.+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const name = (match?.[1] || "").trim();

    try {
        if (!name) {
            await resumeAllTorrents();
            await safeSendMessage(chatId, "▶️ Tous les torrents reprennent.");
            return;
        }

        const resumedName = await resumeTorrentByName(name);
        await safeSendMessage(chatId, `▶️ Torrent repris: ${resumedName}`);
    } catch (error) {
        await safeSendMessage(chatId, `❌ /resume: ${error.message}`);
    }
});

bot.onText(/\/delete(?:\s+(.+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const name = (match?.[1] || "").trim();

    if (!name) {
        await safeSendMessage(chatId, "Usage: /delete <nom_du_torrent>");
        return;
    }

    try {
        const deletedName = await deleteTorrentByName(name);
        await safeSendMessage(chatId, `🗑️ Torrent supprimé (fichiers conservés): ${deletedName}`);
    } catch (error) {
        await safeSendMessage(chatId, `❌ /delete: ${error.message}`);
    }
});

bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.text || msg.text.startsWith("/")) return;

    if (!state.awaitingCustomPath.has(chatId)) return;

    const session = state.torrentSessions.get(chatId);
    if (!session) {
        state.awaitingCustomPath.delete(chatId);
        return;
    }

    session.savePath = msg.text.trim();
    state.awaitingCustomPath.delete(chatId);
    await askCategory(chatId);
});

bot.on("callback_query", async (query) => {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const data = query.data;

    if (!chatId || !data) return;

    await bot.answerCallbackQuery(query.id).catch(() => null);

    try {
        if (data.startsWith("tw:")) {
            const session = state.torrentSessions.get(chatId);
            if (!session && data !== "tw:cancel") {
                await safeSendMessage(chatId, "⚠️ Session expirée, relance /torrent.");
                return;
            }

            if (data === "tw:cancel") {
                state.torrentSessions.delete(chatId);
                state.awaitingCustomPath.delete(chatId);
                await safeSendMessage(chatId, "❌ Ajout du torrent annulé.");
                return;
            }

            if (data.startsWith("tw:type:")) {
                const mediaType = data.split(":")[2];
                initializeTorrentSession(chatId, session.source, mediaType);
                await askSavePath(chatId);
                return;
            }

            if (data.startsWith("tw:path:")) {
                const pathType = data.split(":")[2];
                if (pathType === "custom") {
                    state.awaitingCustomPath.add(chatId);
                    await safeSendMessage(chatId, "✍️ Envoie maintenant le chemin complet (ex: /mnt/films/custom).", {
                        reply_markup: { force_reply: true },
                    });
                    return;
                }

                if (pathType === "movie") session.savePath = CONFIG.qbit.pathMovie;
                if (pathType === "series") session.savePath = CONFIG.qbit.pathSeries;
                if (pathType === "other") session.savePath = CONFIG.qbit.pathOther;
                await askCategory(chatId);
                return;
            }

            if (data.startsWith("tw:cat:")) {
                const cat = data.split(":")[2];
                session.category = cat === "none"
                    ? ""
                    : cat === "movie"
                        ? CONFIG.qbit.categoryMovie
                        : cat === "series"
                            ? CONFIG.qbit.categorySeries
                            : CONFIG.qbit.categoryOther;
                await askPriority(chatId);
                return;
            }

            if (data.startsWith("tw:prio:")) {
                session.priority = data.split(":")[2];
                await askStartMode(chatId);
                return;
            }

            if (data.startsWith("tw:paused:")) {
                const pausedFlag = data.split(":")[2] === "true";
                session.startPaused = pausedFlag;
                await askConfirmation(chatId, session);
                return;
            }

            if (data === "tw:confirm") {
                await addTorrentWithOptions(session);
                state.torrentSessions.delete(chatId);
                state.awaitingCustomPath.delete(chatId);

                await safeSendMessage(chatId, "✅ Torrent ajouté avec succès.", {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: "📥 Voir les torrents", callback_data: "dl:refresh" },
                                { text: "⏸️ Pause tout", callback_data: "dl:batch:pause" },
                            ],
                            [
                                { text: "▶️ Reprendre tout", callback_data: "dl:batch:resume" },
                                { text: "🗑️ Nettoyer terminés", callback_data: "dl:batch:cleanup" },
                            ],
                        ],
                    },
                });
                return;
            }
        }

        if (data.startsWith("dl:")) {
            const view = state.downloadsView.get(chatId) || { filter: "all", page: 0 };

            if (data === "dl:refresh") {
                await renderDownloads(chatId, view.filter, view.page, { chatId, messageId });
                return;
            }

            if (data === "dl:page:next") {
                await renderDownloads(chatId, view.filter, view.page + 1, { chatId, messageId });
                return;
            }

            if (data === "dl:page:prev") {
                await renderDownloads(chatId, view.filter, view.page - 1, { chatId, messageId });
                return;
            }

            if (data.startsWith("dl:filter:")) {
                const filter = data.split(":")[2] || "all";
                await renderDownloads(chatId, filter, 0, { chatId, messageId });
                return;
            }

            if (data === "dl:batch:pause") {
                await pauseAllTorrents();
                await safeSendMessage(chatId, "⏸️ Action lot: tous les torrents en pause.");
                return;
            }

            if (data === "dl:batch:resume") {
                await resumeAllTorrents();
                await safeSendMessage(chatId, "▶️ Action lot: reprise de tous les torrents.");
                return;
            }

            if (data === "dl:batch:cleanup") {
                const deletedCount = await deleteCompletedTorrents();
                await safeSendMessage(chatId, `🗑️ ${deletedCount} torrent(s) terminés supprimé(s).`);
                return;
            }
        }
    } catch (error) {
        await safeSendMessage(chatId, `❌ Erreur action bouton: ${error.message}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
    logInfo(`🚀 MyPlexMonitor démarré en mode ${CONFIG.role}.`);

    if (CONFIG.role === "LOCAL") {
        const diagnostics = await getUbuntuDiagnostics();
        await sendAlert(
            `✅ *Démarrage MyPlexMonitor (LOCAL)*\n\n${diagnostics}\n\n🕒 ${getFormattedDate()}`,
            { parse_mode: "Markdown" }
        );
    }

    await autoCheck();
    setInterval(autoCheck, CONFIG.checkInterval);
})();
