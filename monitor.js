require("dotenv").config();

const net = require("net");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");
const FormData = require("form-data");
const os = require("os");
const fs = require("fs/promises");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);


// ─────────────────────────────────────────────────────────────────────────────
// Formatage Plex via Gemini (IA)
// ─────────────────────────────────────────────────────────────────────────────
async function formatPlexNameWithGemini(rawName, mediaType) {
  if (!CONFIG.geminiApiKey) {
    logInfo("⚠️ GEMINI_API_KEY non configurée, fallback sur simplifyTorrentName");
    return simplifyTorrentName(rawName);
  }

  try {
    const ai = new GoogleGenAI({ apiKey: CONFIG.geminiApiKey });
    const prompt = `
Tu es un assistant expert pour renommer des fichiers multimédias selon les conventions de Plex.
Tu dois analyser ce nom de fichier brut et le nettoyer pour qu'il soit parfaitement reconnu par Plex.
Type de média attendu : ${mediaType === "series" ? "Série TV" : mediaType === "movie" ? "Film" : "Inconnu"}

Règles de formatage strictes:
1. Retire tous les tags parasites (1080p, 2160p, 4K, MULTi, FRENCH, TRUEFRENCH, WEB-DL, BluRay, x264, x265, HEVC, team, etc.).
2. Garde l'extension du fichier s'il y en a une (ex: .mkv, .mp4, .avi). Sinon, ne mets pas d'extension.
3. Remplace les points (.) et tirets bas (_) dans le titre par des espaces.
4. Si c'est un FILM (détection possible via une année ou le contexte) : Formate en "Titre du Film (Année).ext". S'il n'y a pas d'année, formate juste en "Titre du Film.ext".
5. Si c'est une SÉRIE (détection de S01E01, 1x01, Saison X, etc.) : Formate en "Nom de la Série - SXXEXX.ext". (Exemple : "Nom de la Série - S01E03.mkv").
6. Renvoie UNIQUEMENT le nom formaté, sans aucun autre texte, explication, ni guillemet autour de ta réponse.

Nom de fichier brut à analyser: "${rawName}"
`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
    });

    let formattedName = response.text.trim();

    // Fallback minimal au cas où le modèle renverrait une réponse vide ou des erreurs
    if (!formattedName || formattedName.length > 200 || formattedName.includes('\n')) {
       return simplifyTorrentName(rawName);
    }

    return formattedName;
  } catch (error) {
    logInfo(`⚠️ Erreur Gemini API: ${error.message}`);
    return simplifyTorrentName(rawName); // fallback
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────
function parseIntEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseChatIds(rawValue) {
  if (!rawValue) return [];
  return rawValue
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

const CONFIG = {
  role:
    (process.env.ROLE || "LOCAL").toUpperCase() === "BACKUP"
      ? "BACKUP"
      : "LOCAL",
  plexIp: process.env.PLEX_IP || "127.0.0.1",
  plexPort: parseIntEnv(process.env.PLEX_PORT, 32400),
  checkInterval: parseIntEnv(process.env.CHECK_INTERVAL, 30000),
  isContainer: process.env.CONTAINERIZED === "1",
  telegramToken: process.env.TELEGRAM_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  telegramChatIds: parseChatIds(process.env.TELEGRAM_CHAT_ID),
  geminiApiKey: process.env.GEMINI_API_KEY,
  port: parseIntEnv(process.env.PORT, 3000),
  qbit: {
    host: process.env.QBITTORRENT_HOST || "127.0.0.1",
    port: parseIntEnv(process.env.QBITTORRENT_PORT, 8080),
    username: process.env.QBITTORRENT_USERNAME || "admin",
    password: process.env.QBITTORRENT_PASSWORD || "",
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
  awaitingCustomName: new Set(),
  downloadsView: new Map(),
  qbitSid: null,
  torrentAliasesByHash: new Map(),
  torrentHashesByAlias: new Map(),
  nextTorrentAlias: 1,
  trackedTorrents: new Map(),
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

  const map = Object.fromEntries(
    parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
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
  if (["uploading", "forcedUP", "stalledUP"].includes(qbitState))
    return "⬆️ Seed";
  if (
    ["queuedDL", "metaDL", "checkingDL", "checkingResumeData"].includes(
      qbitState,
    )
  )
    return "🕓 Attente";
  if (["error", "missingFiles"].includes(qbitState)) return "❌ Erreur";
  if (["stalledDL"].includes(qbitState)) return "⚠️ Bloqué";
  return "⬇️ Téléchargement";
}

function createProgressBar(percent, length = 10) {
  const safePercent = Math.max(0, Math.min(100, percent));
  const filled = Math.round((safePercent / 100) * length);
  return `${"█".repeat(filled)}${"░".repeat(length - filled)}`;
}

function buildAliasId(index) {
  return `T${String(index).padStart(3, "0")}`;
}

function getOrCreateTorrentAlias(hash) {
  if (state.torrentAliasesByHash.has(hash)) {
    return state.torrentAliasesByHash.get(hash);
  }
  const alias = buildAliasId(state.nextTorrentAlias);
  state.nextTorrentAlias += 1;
  state.torrentAliasesByHash.set(hash, alias);
  state.torrentHashesByAlias.set(alias.toLowerCase(), hash);
  return alias;
}

function simplifyTorrentName(name) {
  if (!name) return "Sans nom";
  const cleaned = name
    .replace(/[._]+/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(
      /\([^)]*(1080p|2160p|720p|x264|x265|h\.?264|h\.?265|bluray|webrip|web-dl|dvdrip)[^)]*\)/gi,
      " ",
    )
    .replace(
      /\b(1080p|2160p|720p|x264|x265|h\.?264|h\.?265|bluray|webrip|web-dl|dvdrip|proper|repack|multi|french|vostfr)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || name;
}

function formatTorrentDisplayName(torrent) {
  const alias = getOrCreateTorrentAlias(torrent.hash);
  return `[${alias}] ${simplifyTorrentName(torrent.name)}`;
}

function isPausedState(qbitState) {
  return ["pausedDL", "pausedUP"].includes(qbitState);
}

function isChatAuthorized(chatId) {
  if (CONFIG.telegramChatIds.length === 0) return true;
  return CONFIG.telegramChatIds.includes(String(chatId));
}

async function denyUnauthorized(chatId) {
  await safeSendMessage(chatId, "❌ Accès refusé: chat non autorisé.");
}

async function withAuthorizedChat(chatId, handler) {
  if (!isChatAuthorized(chatId)) {
    await denyUnauthorized(chatId);
    return;
  }
  await handler();
}

async function safeSendMessage(chatId, text, options = {}) {
  try {
    await bot.sendMessage(chatId, text, options);
  } catch (error) {
    logInfo(`⚠️ Envoi Telegram échoué: ${error.message}`);
  }
}

async function sendAlert(text, options = {}) {
  const recipients =
    CONFIG.telegramChatIds.length > 0
      ? CONFIG.telegramChatIds
      : [CONFIG.telegramChatId].filter(Boolean);
  if (recipients.length === 0) {
    logInfo("⚠️ TELEGRAM_CHAT_ID absent: alerte ignorée.");
    return;
  }
  await Promise.all(
    recipients.map((chatId) => safeSendMessage(chatId, text, options)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram bot + failover anti-409
// ─────────────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(CONFIG.telegramToken, {
  polling: CONFIG.role === "LOCAL",
});

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
      resolve({
        online: false,
        reason: `Erreur TCP: ${err.code || err.message}`,
      });
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
            { parse_mode: "Markdown" },
          );
        } else {
          await sendAlert(
            `✅ *Plex de nouveau opérationnel*\n\nLe service Plex répond à nouveau en local.\n🕒 ${getFormattedDate()}`,
            { parse_mode: "Markdown" },
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
          { parse_mode: "Markdown" },
        );
      } else {
        await sendAlert(
          `🚨 *ALERTE CRITIQUE BACKUP*\n\nLe serveur Ubuntu est injoignable depuis Internet.\nCause probable: coupure électrique, réseau ou câble.\nCause TCP: ${result.reason}\n🕒 ${state.lastDownTime}`,
          { parse_mode: "Markdown" },
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
  const loadAvg = os
    .loadavg()
    .map((v) => v.toFixed(2))
    .join(" / ");
  const freeRamMb = Math.round(os.freemem() / 1024 / 1024);
  const totalRamMb = Math.round(os.totalmem() / 1024 / 1024);

  let shutdownStatus = "Impossible de déterminer l'état du dernier arrêt.";

  try {
    const { stdout } = await execAsync("last -x -n 2 shutdown reboot", {
      timeout: 6000,
    });
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter(
        (line) => line.startsWith("shutdown") || line.startsWith("reboot"),
      );

    const hasShutdown = lines.some((line) => line.startsWith("shutdown"));
    const hasReboot = lines.some((line) => line.startsWith("reboot"));

    if (hasShutdown) {
      shutdownStatus =
        "✅ Dernier arrêt détecté comme propre (shutdown trouvé).";
    } else if (hasReboot) {
      shutdownStatus =
        "⚠️ Redémarrage sans trace de shutdown: possible coupure brutale.";
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
  ]
    .filter(Boolean)
    .join("\n");
}

async function handleShutdownSignal(signal) {
  if (CONFIG.role === "LOCAL") {
    await sendAlert(
      `🛑 *Extinction propre du système Ubuntu détectée*\nSignal reçu: ${signal}\n🕒 ${getFormattedDate()}`,
      { parse_mode: "Markdown" },
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
  const torrents = await qbitRequest(
    `/torrents/info?filter=${encodeURIComponent(filter)}`,
  );
  return Array.isArray(torrents) ? torrents : [];
}


async function addTorrentWithOptions(options) {
  let payload;
  let headers = {};

  if (options.fileBuffer) {
    // Si c'est un fichier .torrent
    const form = new FormData();
    form.append("torrents", options.fileBuffer, options.fileName || "download.torrent");
    form.append("savepath", options.savePath);
    if (options.category) form.append("category", options.category);
    form.append("paused", options.startPaused ? "true" : "false");
    form.append("autoTMM", "false");
    if (options.customName) form.append("rename", options.customName);

    payload = form;
    headers = form.getHeaders();
  } else {
    // Si c'est un lien URL/Magnet
    payload = {
      urls: options.source,
      savepath: options.savePath,
      category: options.category || "",
      paused: options.startPaused ? "true" : "false",
      autoTMM: "false",
      ...(options.customName ? { rename: options.customName } : {}),
    };
  }

  // Effectuer la requête à qBittorrent
  if (!state.qbitSid) {
    await qbitLogin();
  }

  try {
    const config = {
      method: 'POST',
      url: `/torrents/add`,
      data: payload,
      headers: {
        ...(state.qbitSid ? { Cookie: state.qbitSid } : {}),
        ...headers
      }
    };

    // On utilise directement l'instance axios qbitHttp car on veut modifier les headers
    await qbitHttp.request(config);
  } catch (error) {
    if (error.response && (error.response.status === 403 || error.response.status === 401)) {
       // retry login
       await qbitLogin();
       const retryConfig = {
         method: 'POST',
         url: `/torrents/add`,
         data: payload,
         headers: {
           ...(state.qbitSid ? { Cookie: state.qbitSid } : {}),
           ...headers
         }
       };
       await qbitHttp.request(retryConfig);
    } else {
       throw error;
    }
  }

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
  const torrent = resolveTorrentTarget(torrents, name);
  if (!torrent) throw new Error("Torrent introuvable");
  await qbitRequest("/torrents/pause", "POST", { hashes: torrent.hash });
  return torrent.name;
}

async function resumeTorrentByName(name) {
  const torrents = await listTorrents("all");
  const torrent = resolveTorrentTarget(torrents, name);
  if (!torrent) throw new Error("Torrent introuvable");
  await qbitRequest("/torrents/resume", "POST", { hashes: torrent.hash });
  return torrent.name;
}

async function deleteTorrentByName(name) {
  const torrents = await listTorrents("all");
  const torrent = resolveTorrentTarget(torrents, name);
  if (!torrent) throw new Error("Torrent introuvable");
  await qbitRequest("/torrents/delete", "POST", {
    hashes: torrent.hash,
    deleteFiles: "false",
  });
  return torrent.name;
}

async function deleteCompletedTorrents() {
  const completed = await listTorrents("completed");
  if (completed.length === 0) return 0;
  const hashes = completed.map((torrent) => torrent.hash).join("|");
  await qbitRequest("/torrents/delete", "POST", {
    hashes,
    deleteFiles: "false",
  });
  return completed.length;
}

function selectTorrentsForAction(torrents, action) {
  if (action === "pause")
    return torrents.filter((torrent) => !isPausedState(torrent.state));
  if (action === "resume")
    return torrents.filter((torrent) => isPausedState(torrent.state));
  return torrents;
}

function getActionTitle(action) {
  if (action === "pause") return "⏸️ Torrents pouvant être mis en pause";
  if (action === "resume") return "▶️ Torrents pouvant être repris";
  return "🗑️ Torrents pouvant être supprimés";
}

function getActionVerb(action) {
  if (action === "pause") return "mis en pause";
  if (action === "resume") return "repris";
  return "supprimé";
}

function buildActionCallback(action, hash) {
  return `ta:${action}:${hash}`;
}

function resolveTorrentTarget(torrents, rawInput) {
  const input = (rawInput || "").trim();
  if (!input) return null;

  const normalized = input.toLowerCase();
  const hashFromAlias = state.torrentHashesByAlias.get(normalized);
  if (hashFromAlias) {
    return torrents.find((torrent) => torrent.hash === hashFromAlias) || null;
  }

  const exactHash = torrents.find(
    (torrent) => torrent.hash.toLowerCase() === normalized,
  );
  if (exactHash) return exactHash;

  const exactAlias = torrents.find(
    (torrent) =>
      getOrCreateTorrentAlias(torrent.hash).toLowerCase() === normalized,
  );
  if (exactAlias) return exactAlias;

  const partial = torrents.find((torrent) =>
    torrent.name.toLowerCase().includes(normalized),
  );
  return partial || null;
}

async function renderTorrentActionPicker(chatId, action) {
  const torrents = await listTorrents("all");
  const candidates = selectTorrentsForAction(torrents, action);
  if (candidates.length === 0) {
    await safeSendMessage(
      chatId,
      "ℹ️ Aucun torrent disponible pour cette action.",
    );
    return;
  }

  const maxItems = 20;
  const items = candidates.slice(0, maxItems);
  const lines = [
    getActionTitle(action),
    "",
    ...items.map((torrent) => `• ${formatTorrentDisplayName(torrent)}`),
  ];

  if (candidates.length > maxItems) {
    lines.push(
      "",
      `… ${candidates.length - maxItems} autres torrents non affichés.`,
    );
  }

  const keyboardRows = items.map((torrent) => [
    {
      text: `${action === "delete" ? "🗑️" : action === "pause" ? "⏸️" : "▶️"} ${getOrCreateTorrentAlias(torrent.hash)}`,
      callback_data: buildActionCallback(action, torrent.hash),
    },
  ]);

  if (action === "pause") {
    keyboardRows.push([
      { text: "⏸️ Tout mettre en pause", callback_data: "dl:batch:pause" },
    ]);
  }
  if (action === "resume") {
    keyboardRows.push([
      { text: "▶️ Tout reprendre", callback_data: "dl:batch:resume" },
    ]);
  }

  await safeSendMessage(chatId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: keyboardRows,
    },
  });
}

async function applyTorrentAction(action, hash) {
  const torrents = await listTorrents("all");
  const torrent = torrents.find((item) => item.hash === hash);
  if (!torrent) {
    throw new Error("Torrent introuvable");
  }

  if (action === "pause") {
    await qbitRequest("/torrents/pause", "POST", { hashes: hash });
  } else if (action === "resume") {
    await qbitRequest("/torrents/resume", "POST", { hashes: hash });
  } else {
    await qbitRequest("/torrents/delete", "POST", {
      hashes: hash,
      deleteFiles: "false",
    });
  }

  return torrent;
}

async function buildMoviesCatalog(rootPath, options = {}) {
  const maxResults = options.maxResults || 200;
  const maxDepth = options.maxDepth || 3;
  const videos = [];
  const queue = [{ currentPath: rootPath, depth: 0 }];
  const allowedExtensions = new Set([".mkv", ".mp4", ".avi", ".mov", ".m4v"]);

  while (queue.length > 0 && videos.length < maxResults) {
    const { currentPath, depth } = queue.shift();
    let entries = [];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      continue;
    }

    for (const entry of entries) {
      if (videos.length >= maxResults) break;
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory() && depth < maxDepth) {
        queue.push({ currentPath: fullPath, depth: depth + 1 });
        continue;
      }

      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(extension)) continue;

      let stat = null;
      try {
        stat = await fs.stat(fullPath);
      } catch (error) {
        continue;
      }

      videos.push({
        fileName: entry.name,
        simpleName: simplifyTorrentName(entry.name.replace(extension, "")),
        updatedAt: stat.mtimeMs || 0,
      });
    }
  }

  return videos;
}

function toCsvLine(values) {
  return values
    .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
    .join(",");
}

// ─────────────────────────────────────────────────────────────────────────────
// UI Telegram torrents
// ─────────────────────────────────────────────────────────────────────────────
function initializeTorrentSession(chatId, source, mediaType = "movie") {
  const defaults = {
    movie: {
      savePath: CONFIG.qbit.pathMovie,
      category: CONFIG.qbit.categoryMovie,
    },
    series: {
      savePath: CONFIG.qbit.pathSeries,
      category: CONFIG.qbit.categorySeries,
    },
    other: {
      savePath: CONFIG.qbit.pathOther,
      category: CONFIG.qbit.categoryOther,
    },
  };

  const selected = defaults[mediaType] || defaults.movie;

  state.torrentSessions.set(chatId, {
    source,
    mediaType,
    savePath: selected.savePath,
    category: selected.category,
    priority: "normal",
    startPaused: false,
    customName: null,
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
        [
          {
            text: "✍️ Saisir un chemin personnalisé",
            callback_data: "tw:path:custom",
          },
        ],
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
          {
            text: "▶️ Démarrer tout de suite",
            callback_data: "tw:paused:false",
          },
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
    session.customName ? `- Nom: ${session.customName}` : null,
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
        [
          {
            text: "✏️ Renommer (intelligent)",
            callback_data: "tw:rename:smart",
          },
          { text: "✍️ Renommer (manuel)", callback_data: "tw:rename:manual" },
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
  if (
    ["completed", "done", "termine", "terminé", "finished"].includes(normalized)
  )
    return "completed";
  return "all";
}

async function renderDownloads(
  chatId,
  filter = "all",
  page = 0,
  editMeta = null,
) {
  const torrents = await listTorrents(filter);
  const pageSize = 5;
  const totalPages = Math.max(1, Math.ceil(torrents.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const startIndex = safePage * pageSize;
  const pageItems = torrents.slice(startIndex, startIndex + pageSize);

  state.downloadsView.set(chatId, { filter, page: safePage });

  let message = `📥 *Téléchargements* (${filter})\nPage ${safePage + 1}/${totalPages}\n💡 Utilise les IDs \\[Txxx\\] avec /pause /resume /delete\n\n`;

  if (pageItems.length === 0) {
    message += "Aucun torrent pour ce filtre.";
  }

  for (const torrent of pageItems) {
    const percent = Math.round((torrent.progress || 0) * 100);
    const eta = torrent.eta > 0 ? formatDuration(torrent.eta) : "n/a";
    message += [
      `*${formatTorrentDisplayName(torrent).replace(/\*/g, "")}*`,
      `${getTorrentStatusLabel(torrent.state)} ${createProgressBar(percent)} ${percent}%`,
      `⬇️ ${formatBytes(torrent.dlspeed || 0)}/s | ⬆️ ${formatBytes(torrent.upspeed || 0)}/s | ETA ${eta}`,
      "",
    ].join("\n");
  }

  message += `\n🕒 Actualisé à : ${getFormattedDate()}`;

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

  await safeSendMessage(chatId, message, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Commandes Telegram
// ─────────────────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    await safeSendMessage(
      chatId,
      `👋 *MyPlexMonitor prêt*\n\nRôle actif: *${CONFIG.role}*\n\nUtilise /help pour voir toutes les commandes.`,
      { parse_mode: "Markdown" },
    );
  });
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
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
      "- /pause [id|nom] (sans argument: bouton de sélection)",
      "- /resume [id|nom] (sans argument: bouton de sélection)",
      "- /delete [id|nom] (sans argument: bouton de sélection)",
      "- /export_torrents",
      "",
      "🎬 Médias",
      "- /random",
      "- /movies [az|za|recent]",
      "",
      "💡 Le mode BACKUP n'écoute Telegram que pendant une panne Ubuntu.",
    ].join("\n");
    await safeSendMessage(chatId, text, { parse_mode: "Markdown" });
  });
});

bot.onText(/\/check/, async (msg) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    try {
      const result = await pingServer();
      const statusLine = result.online ? "🟢 ONLINE" : "🔴 OFFLINE";

      if (CONFIG.role === "LOCAL") {
        const diagnostics = await getUbuntuDiagnostics();
        await safeSendMessage(
          chatId,
          `🔎 *Vérification immédiate*\nStatut Plex: ${statusLine}\nCause technique: ${result.reason}\n🕒 ${getFormattedDate()}\n\n${diagnostics}`,
          { parse_mode: "Markdown" },
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
        { parse_mode: "Markdown" },
      );
    } catch (error) {
      await safeSendMessage(
        chatId,
        `❌ Erreur pendant /check: ${error.message}`,
      );
    }
  });
});

bot.onText(/\/restart_plex/, async (msg) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    if (CONFIG.isContainer) {
      await safeSendMessage(
        chatId,
        "❌ /restart_plex n'est pas disponible avec Docker Compose. Redémarre Plex directement sur l'hôte Ubuntu.",
      );
      return;
    }

    if (CONFIG.role === "BACKUP") {
      await safeSendMessage(
        chatId,
        "❌ Impossible: redémarrage logiciel indisponible car le serveur Ubuntu physique est hors ligne.",
      );
      return;
    }

    try {
      await safeSendMessage(
        chatId,
        "♻️ Redémarrage de plexmediaserver en cours...",
      );
      await execAsync("sudo systemctl restart plexmediaserver", {
        timeout: 20000,
      });
      await safeSendMessage(
        chatId,
        "✅ Commande systemctl exécutée. Vérification dans 5 secondes...",
      );

      setTimeout(async () => {
        const result = await pingServer();
        await safeSendMessage(
          chatId,
          result.online
            ? `✅ Plex répond à nouveau après redémarrage. (${getFormattedDate()})`
            : `⚠️ Plex ne répond toujours pas: ${result.reason} (${getFormattedDate()})`,
        );
      }, 5000);
    } catch (error) {
      await safeSendMessage(
        chatId,
        `❌ Échec du redémarrage: ${error.message}`,
      );
    }
  });
});

bot.onText(/\/torrent(?:\s+(.+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    const source = (match?.[1] || "").trim();

    if (!source) {
      await safeSendMessage(chatId, "Usage: /torrent <magnet|url>");
      return;
    }

    initializeTorrentSession(chatId, source, "movie");
    await askMediaType(chatId);
  });
});

bot.onText(/\/movie(?:\s+(.+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    const source = (match?.[1] || "").trim();
    if (!source) {
      await safeSendMessage(chatId, "Usage: /movie <magnet|url>");
      return;
    }
    initializeTorrentSession(chatId, source, "movie");
    await askSavePath(chatId);
  });
});

bot.onText(/\/series(?:\s+(.+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    const source = (match?.[1] || "").trim();
    if (!source) {
      await safeSendMessage(chatId, "Usage: /series <magnet|url>");
      return;
    }
    initializeTorrentSession(chatId, source, "series");
    await askSavePath(chatId);
  });
});

bot.onText(/\/downloads?(?:\s+(\S+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    const filter = parseFilterArg(match?.[1]);

    try {
      await renderDownloads(chatId, filter, 0);
    } catch (error) {
      await safeSendMessage(
        chatId,
        `❌ Impossible de charger les torrents: ${error.message}`,
      );
    }
  });
});

bot.onText(/\/pause(?:\s+(.+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    const name = (match?.[1] || "").trim();

    try {
      if (!name) {
        await renderTorrentActionPicker(chatId, "pause");
        return;
      }

      const pausedName = await pauseTorrentByName(name);
      await safeSendMessage(
        chatId,
        `⏸️ Torrent en pause: ${simplifyTorrentName(pausedName)}`,
      );
    } catch (error) {
      await safeSendMessage(chatId, `❌ /pause: ${error.message}`);
    }
  });
});

bot.onText(/\/resume(?:\s+(.+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    const name = (match?.[1] || "").trim();

    try {
      if (!name) {
        await renderTorrentActionPicker(chatId, "resume");
        return;
      }

      const resumedName = await resumeTorrentByName(name);
      await safeSendMessage(
        chatId,
        `▶️ Torrent repris: ${simplifyTorrentName(resumedName)}`,
      );
    } catch (error) {
      await safeSendMessage(chatId, `❌ /resume: ${error.message}`);
    }
  });
});

bot.onText(/\/delete(?:\s+(.+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    const name = (match?.[1] || "").trim();

    if (!name) {
      await renderTorrentActionPicker(chatId, "delete");
      return;
    }

    try {
      const deletedName = await deleteTorrentByName(name);
      await safeSendMessage(
        chatId,
        `🗑️ Torrent supprimé (fichiers conservés): ${simplifyTorrentName(deletedName)}`,
      );
    } catch (error) {
      await safeSendMessage(chatId, `❌ /delete: ${error.message}`);
    }
  });
});

bot.onText(/\/random/i, async (msg) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    try {
      const movies = await buildMoviesCatalog(CONFIG.qbit.pathMovie, {
        maxResults: 400,
        maxDepth: 4,
      });
      if (movies.length === 0) {
        await safeSendMessage(
          chatId,
          "ℹ️ Aucun film trouvé dans le dossier MOVIES_PATH.",
        );
        return;
      }
      const selected = movies[Math.floor(Math.random() * movies.length)];
      await safeSendMessage(
        chatId,
        `🎲 Film du soir: *${selected.simpleName}*`,
        { parse_mode: "Markdown" },
      );
    } catch (error) {
      await safeSendMessage(chatId, `❌ /random: ${error.message}`);
    }
  });
});

bot.onText(/\/movies(?:\s+(\S+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    const mode = (match?.[1] || "az").toLowerCase();
    try {
      const movies = await buildMoviesCatalog(CONFIG.qbit.pathMovie, {
        maxResults: 500,
        maxDepth: 4,
      });
      if (movies.length === 0) {
        await safeSendMessage(
          chatId,
          "ℹ️ Aucun film trouvé dans le dossier MOVIES_PATH.",
        );
        return;
      }

      if (mode === "recent") {
        movies.sort((a, b) => b.updatedAt - a.updatedAt);
      } else if (mode === "za") {
        movies.sort((a, b) => b.simpleName.localeCompare(a.simpleName, "fr"));
      } else {
        movies.sort((a, b) => a.simpleName.localeCompare(b.simpleName, "fr"));
      }

      const preview = movies.slice(0, 30);
      const lines = [
        `🎬 Liste films (${mode})`,
        ...preview.map((movie, index) => `${index + 1}. ${movie.simpleName}`),
      ];

      if (movies.length > preview.length) {
        lines.push(
          `… ${movies.length - preview.length} film(s) supplémentaire(s).`,
        );
      }

      await safeSendMessage(chatId, lines.join("\n"));
    } catch (error) {
      await safeSendMessage(chatId, `❌ /movies: ${error.message}`);
    }
  });
});

bot.onText(/\/disk/i, async (msg) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    try {
      const pathToCheck = CONFIG.qbit.pathMovie || "/mnt/films";
      const { stdout } = await execAsync(`df -h ${pathToCheck}`);
      const lines = stdout.trim().split("\n");

      if (lines.length > 1) {
        const parts = lines[1].split(/\s+/);
        const size = parts[1];
        const used = parts[2];
        const avail = parts[3];
        const usePercent = parts[4];

        const message = [
          "💾 *Espace Disque*",
          "📍 Dossier: `" + pathToCheck + "`",
          "Total: `" + size + "`",
          "Utilisé: `" + used + "` (" + usePercent + ")",
          "Libre: `" + avail + "`",
        ].join("\n");

        await safeSendMessage(chatId, message, { parse_mode: "Markdown" });
      } else {
        await safeSendMessage(chatId, "⚠️ Impossible de lire l'espace disque.");
      }
    } catch (error) {
      await safeSendMessage(
        chatId,
        "❌ Erreur espace disque: " + error.message,
      );
    }
  });
});

bot.onText(/\/export_torrents/i, async (msg) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    try {
      const torrents = await listTorrents("all");
      const csvRows = [
        toCsvLine([
          "alias",
          "name",
          "status",
          "progress_percent",
          "size_bytes",
          "dl_speed",
          "up_speed",
        ]),
        ...torrents.map((torrent) =>
          toCsvLine([
            getOrCreateTorrentAlias(torrent.hash),
            simplifyTorrentName(torrent.name),
            torrent.state || "",
            Math.round((torrent.progress || 0) * 100),
            torrent.size || 0,
            torrent.dlspeed || 0,
            torrent.upspeed || 0,
          ]),
        ),
      ];

      await bot.sendDocument(
        chatId,
        Buffer.from(`${csvRows.join("\n")}\n`, "utf8"),
        {
          filename: `torrents-${Date.now()}.csv`,
          contentType: "text/csv",
        },
      );
    } catch (error) {
      await safeSendMessage(chatId, `❌ /export_torrents: ${error.message}`);
    }
  });
});


bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  if (!isChatAuthorized(chatId)) return;

  const doc = msg.document;
  if (!doc) return;

  if (!doc.file_name?.endsWith('.torrent') && doc.mime_type !== 'application/x-bittorrent') {
    return;
  }

  try {
    const fileLink = await bot.getFileLink(doc.file_id);
    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);

    // Initialiser une session avec le buffer
    const source = doc.file_name; // On garde le nom original du fichier comme source
    initializeTorrentSession(chatId, source, "movie"); // Par défaut, on va demander le type de toute façon

    // On met à jour la session avec le buffer
    const session = state.torrentSessions.get(chatId);
    if (session) {
      session.fileBuffer = buffer;
      session.fileName = doc.file_name;
    }

    await askMediaType(chatId);
  } catch (error) {
    await safeSendMessage(chatId, `❌ Erreur lors du téléchargement du fichier torrent: ${error.message}`);
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.text || msg.text.startsWith("/")) return;
  if (!isChatAuthorized(chatId)) return;

  if (state.awaitingCustomName.has(chatId)) {
    const session = state.torrentSessions.get(chatId);
    if (!session) {
      state.awaitingCustomName.delete(chatId);
      return;
    }

    session.customName = msg.text.trim();
    state.awaitingCustomName.delete(chatId);
    await askConfirmation(chatId, session);
    return;
  }

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
  if (!isChatAuthorized(chatId)) return;

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
          await safeSendMessage(
            chatId,
            "✍️ Envoie maintenant le chemin complet (ex: /mnt/films/custom).",
            {
              reply_markup: { force_reply: true },
            },
          );
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
        session.category =
          cat === "none"
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

      if (data === "tw:rename:manual") {
        state.awaitingCustomName.add(chatId);
        await safeSendMessage(
          chatId,
          "✍️ Envoie maintenant le nouveau nom du fichier ou dossier.",
          {
            reply_markup: { force_reply: true },
          },
        );
        return;
      }

      if (data === "tw:rename:smart") {
        // Essayer de simplifier le nom basé sur le nom existant
        const matchName = session.source.match(/dn=([^&]+)/);
        if (matchName && matchName[1]) {
          const originalName = decodeURIComponent(matchName[1]);
          const smartName = simplifyTorrentName(originalName);

          state.awaitingCustomName.add(chatId);
          await safeSendMessage(
            chatId,
            `🤖 Proposition: "${smartName}"\n\nSi cela te convient, copie/colle ou tape un autre nom.`,
            {
              reply_markup: { force_reply: true },
            },
          );
        } else if (!session.source.startsWith("magnet:")) {
          const parts = session.source.split("/");
          let fileName = parts[parts.length - 1];
          if (fileName) {
            fileName = fileName.replace(".torrent", "");
            const smartName = simplifyTorrentName(fileName);
            state.awaitingCustomName.add(chatId);
            await safeSendMessage(
              chatId,
              `🤖 Proposition: "${smartName}"\n\nSi cela te convient, copie/colle ou tape un autre nom.`,
              {
                reply_markup: { force_reply: true },
              },
            );
          } else {
            state.awaitingCustomName.add(chatId);
            await safeSendMessage(
              chatId,
              "⚠️ Impossible de déduire le nom depuis le lien. Tape manuellement le nouveau nom:",
              {
                reply_markup: { force_reply: true },
              },
            );
          }
        } else {
          state.awaitingCustomName.add(chatId);
          await safeSendMessage(
            chatId,
            "⚠️ Impossible de déduire le nom depuis le lien magnet. Tape manuellement le nouveau nom:",
            {
              reply_markup: { force_reply: true },
            },
          );
        }
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
                {
                  text: "🗑️ Nettoyer terminés",
                  callback_data: "dl:batch:cleanup",
                },
              ],
            ],
          },
        });
        return;
      }
    }

    if (data.startsWith("dl:")) {
      const view = state.downloadsView.get(chatId) || {
        filter: "all",
        page: 0,
      };

      if (data === "dl:refresh") {
        await renderDownloads(chatId, view.filter, view.page, {
          chatId,
          messageId,
        });
        return;
      }

      if (data === "dl:page:next") {
        await renderDownloads(chatId, view.filter, view.page + 1, {
          chatId,
          messageId,
        });
        return;
      }

      if (data === "dl:page:prev") {
        await renderDownloads(chatId, view.filter, view.page - 1, {
          chatId,
          messageId,
        });
        return;
      }

      if (data.startsWith("dl:filter:")) {
        const filter = data.split(":")[2] || "all";
        await renderDownloads(chatId, filter, 0, { chatId, messageId });
        return;
      }

      if (data === "dl:batch:pause") {
        await pauseAllTorrents();
        await safeSendMessage(
          chatId,
          "⏸️ Action lot: tous les torrents en pause.",
        );
        return;
      }

      if (data === "dl:batch:resume") {
        await resumeAllTorrents();
        await safeSendMessage(
          chatId,
          "▶️ Action lot: reprise de tous les torrents.",
        );
        return;
      }

      if (data === "dl:batch:cleanup") {
        const deletedCount = await deleteCompletedTorrents();
        await safeSendMessage(
          chatId,
          `🗑️ ${deletedCount} torrent(s) terminés supprimé(s).`,
        );
        return;
      }
    }

    if (data.startsWith("ta:")) {
      const [, action, hash] = data.split(":");
      if (!action || !hash) return;
      const torrent = await applyTorrentAction(action, hash);
      await safeSendMessage(
        chatId,
        `✅ Torrent ${getActionVerb(action)}: ${formatTorrentDisplayName(torrent)}`,
      );
      return;
    }
  } catch (error) {
    if (error.message && error.message.includes("message is not modified")) {
      return;
    }
    await safeSendMessage(chatId, `❌ Erreur action bouton: ${error.message}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Notifications de fin de téléchargement
// ─────────────────────────────────────────────────────────────────────────────

async function checkTorrentCompletions() {
  try {
    if (!state.qbitSid) await qbitLogin();
    const torrents = await listTorrents("all");

    for (const torrent of torrents) {
      const wasTracked = state.trackedTorrents.has(torrent.hash);
      const prevState = wasTracked
        ? state.trackedTorrents.get(torrent.hash).state
        : null;

      // Si le torrent est nouveau, l'ajouter au suivi
      if (!wasTracked) {
        state.trackedTorrents.set(torrent.hash, {
          state: torrent.state,
          name: torrent.name,
        });
        continue;
      }

      // Vérifier si le statut est passé à complété (100%)
      const isCompletedNow =
        torrent.progress === 1 ||
        ["uploading", "stalledUP", "forcedUP", "pausedUP"].includes(
          torrent.state,
        );
      const wasCompletedBefore =
        prevState &&
        ["uploading", "stalledUP", "forcedUP", "pausedUP"].includes(prevState);

      if (isCompletedNow && !wasCompletedBefore) {
        try {
          let mediaType = "other";
          if (torrent.category === CONFIG.qbit.categoryMovie || torrent.save_path?.includes(CONFIG.qbit.pathMovie)) mediaType = "movie";
          if (torrent.category === CONFIG.qbit.categorySeries || torrent.save_path?.includes(CONFIG.qbit.pathSeries)) mediaType = "series";

          // Obtenir le nouveau nom
          const oldName = torrent.name;
          const newName = await formatPlexNameWithGemini(oldName, mediaType);

          if (newName && newName !== oldName && newName !== simplifyTorrentName(oldName)) {
             logInfo(`Renommage automatique: ${oldName} -> ${newName}`);

             // Renommer le dossier principal / fichier dans qBittorrent
             await qbitRequest("/torrents/rename", "POST", {
                hash: torrent.hash,
                name: newName
             });

             // Mettre à jour torrent.name pour la notification
             torrent.name = newName;
          }

          // Notifier tous les chats autorisés
          const recipients =
            CONFIG.telegramChatIds.length > 0
              ? CONFIG.telegramChatIds
              : [CONFIG.telegramChatId].filter(Boolean);

          for (const chatId of recipients) {
            await safeSendMessage(
              chatId,
              `✅ *Téléchargement terminé:*
${torrent.name}

_Nom d'origine: ${oldName}_`,
              {
                parse_mode: "Markdown",
              }
            );
          }
        } catch(renameError) {
           logInfo(`⚠️ Erreur lors du renommage automatique de ${torrent.name}: ${renameError.message}`);
        }
      }

      // Mettre à jour l'état suivi
      state.trackedTorrents.set(torrent.hash, {
        state: torrent.state,
        name: torrent.name,
      });
    }

    // Nettoyer les torrents supprimés
    for (const hash of state.trackedTorrents.keys()) {
      if (!torrents.find((t) => t.hash === hash)) {
        state.trackedTorrents.delete(hash);
      }
    }
  } catch (error) {
    // Ignorer les erreurs silencieusement pour ne pas spammer les logs
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  logInfo(`🚀 MyPlexMonitor démarré en mode ${CONFIG.role}.`);

  if (CONFIG.role === "LOCAL") {
    const diagnostics = await getUbuntuDiagnostics();
    await sendAlert(
      `✅ *Démarrage MyPlexMonitor (LOCAL)*\n\n${diagnostics}\n\n🕒 ${getFormattedDate()}`,
      { parse_mode: "Markdown" },
    );
  }

  await autoCheck();
  setInterval(autoCheck, CONFIG.checkInterval);
  setInterval(checkTorrentCompletions, 60000); // Check every minute
  checkTorrentCompletions(); // Initial check
})();
