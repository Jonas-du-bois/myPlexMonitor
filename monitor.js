require("dotenv").config();

const net = require("net");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");
const os = require("os");
const fs = require("fs/promises");
const crypto = require("crypto");
const path = require("path");
const { exec, execFile } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);


// ─────────────────────────────────────────────────────────────────────────────
// Formatage Plex via Gemini (IA)
// ─────────────────────────────────────────────────────────────────────────────
const MEDIA_NOISE_PATTERN =
  /\b(?:multi|multi audio|french|truefrench|vf2|vff|vostfr|vo|dubbed|dub|english|german|spanish|italian|japanese|korean|russian|polish|original|dual audio|5\.1|7\.1|1080p|2160p|720p|4k|uhd|hdr10?\+?|web[- ]?dl|web[- ]?rip|blu[- ]?ray|brrip|dvdrip|x264|x265|h\.?264|h\.?265|hevc|avc|aac|dts|truehd|atmos|proper|repack|remux|limited|internal)\b/gi;

function normalizeMediaName(name, rawName) {
  const rawExtension = path.extname(rawName || "").toLowerCase();
  let normalized = String(name || "")
    .replace(/```(?:text|plaintext)?/gi, "")
    .replace(/```/g, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(MEDIA_NOISE_PATTERN, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+-\s+(?:MULTI|FRENCH|VOSTFR|WEB[- ]?DL).*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return "";
  const generatedExtension = path.extname(normalized).toLowerCase();
  const extension = generatedExtension || rawExtension;
  const stem = (
    generatedExtension
      ? normalized.slice(0, -generatedExtension.length)
      : normalized
  )
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${stem}${extension}`;
}

async function formatPlexNameWithGemini(rawName, mediaType) {
  if (!CONFIG.geminiApiKey) {
    logInfo("⚠️ GEMINI_API_KEY non configurée, fallback sur simplifyTorrentName");
    return simplifyTorrentName(rawName);
  }

  try {
    let ai;
    try {
      ai = new GoogleGenAI({ apiKey: CONFIG.geminiApiKey });
    } catch (e) {
      logInfo(`⚠️ Impossible d'initialiser GoogleGenAI : ${e.message}`);
      return simplifyTorrentName(rawName);
    }
    const prompt = `
Tu es un assistant expert pour renommer des fichiers multimédias selon les conventions de Plex.
Tu dois analyser ce nom de fichier brut et le nettoyer pour qu'il soit parfaitement reconnu par Plex.
Type de média attendu : ${mediaType === "series" ? "Série TV" : mediaType === "movie" ? "Film" : "Inconnu"}

Règles de formatage strictes:
1. Identifie le titre officiel le plus courant, tel qu'il est écrit sur IMDb ou dans les bases de données publiques. Ne traduis pas le titre et ne l'invente pas.
2. Supprime absolument toute langue et tout tag technique ou commercial : FRENCH, VF, VFF, VOSTFR, MULTI, VO, ENGLISH, GERMAN, DUBBED, TRUEFRENCH, 1080p, 2160p, WEB-DL, BluRay, x264, x265, HEVC, HDR, codecs, audio, groupe, édition et qualité.
3. La réponse ne doit contenir que le titre, l'année et l'épisode lorsque celui-ci existe. Ne renvoie jamais la langue, même si elle apparaît dans le nom brut.
4. Pour un FILM : "Titre officiel (Année).ext". Si l'année est inconnue, utilise "Titre officiel.ext". L'année doit être l'année de sortie du film, pas une année de qualité ou de téléchargement.
5. Pour une SÉRIE : "Titre officiel - SXXEXX.ext" (exemple : "Breaking Bad - S01E03.mkv"). Conserve également un numéro d'épisode spécial si présent.
6. Garde l'extension du fichier s'il y en a une. Sinon, ne mets pas d'extension.
7. Utilise des espaces normaux, sans points ni tirets bas dans le titre. N'ajoute aucun texte autour.
8. Renvoie UNIQUEMENT le nom final, sans explication, sans préfixe, sans Markdown et sans guillemets.

Nom de fichier brut à analyser: "${rawName}"
`;

    const response = await Promise.race([
      ai.models.generateContent({
        model: CONFIG.geminiModel,
        contents: prompt,
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("délai Gemini dépassé")),
          CONFIG.geminiTimeoutMs,
        ),
      ),
    ]);

    let formattedName = normalizeMediaName(response.text.trim(), rawName);

    // Fallback minimal au cas où le modèle renverrait une réponse vide ou des erreurs
    if (
      !formattedName ||
      formattedName.length > 200 ||
      formattedName.includes("\n") ||
      /[\\/\0-\x1f]/.test(formattedName)
    ) {
      return simplifyTorrentName(rawName);
    }

    return formattedName;
  } catch (error) {
    logInfo(`⚠️ Erreur Gemini API: ${error.message}`);
    return simplifyTorrentName(rawName); // fallback
  }
}

function getTorrentSourceName(source) {
  if (!source) return "torrent";
  if (source.startsWith("magnet:")) {
    const displayName = source.match(/[?&]dn=([^&]+)/i)?.[1];
    return displayName ? decodeURIComponent(displayName) : "torrent";
  }
  return path.basename(source).replace(/\.torrent$/i, "");
}

function magnetHasDisplayName(source) {
  return /^magnet:/i.test(source || "") && Boolean(source.match(/[?&]dn=/i));
}

async function prepareSmartTorrentName(chatId, session) {
  if (
    session.sourceType !== "file" &&
    /^magnet:/i.test(session.source) &&
    !magnetHasDisplayName(session.source)
  ) {
    session.renameWithGeminiAfterAdd = true;
    session.customName = null;
    await safeSendMessage(
      chatId,
      "ℹ️ Ce magnet n'a pas encore de nom. Il sera ajouté d'abord, puis Gemini analysera son nom dès que qBittorrent aura reçu ses métadonnées.",
    );
    return;
  }

  await safeSendMessage(chatId, "🤖 Gemini analyse le nom du torrent…");
  const sourceName = getTorrentSourceName(session.source);
  const proposedName = await formatPlexNameWithGemini(
    sourceName,
    session.mediaType,
  );
  session.customName = proposedName;

  if (CONFIG.geminiApiKey) {
    await safeSendMessage(chatId, `✅ Nom proposé : ${proposedName}`);
  } else {
    await safeSendMessage(
      chatId,
      `ℹ️ Gemini n'est pas configuré. Nettoyage local proposé : ${proposedName}`,
    );
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
    maxTorrentFileSizeMb: parseIntEnv(
      process.env.MAX_TORRENT_FILE_SIZE_MB,
      20,
    ),
  },
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  geminiTimeoutMs: parseIntEnv(process.env.GEMINI_TIMEOUT_MS, 10000),
  telegramDownloadTimeoutMs: parseIntEnv(
    process.env.TELEGRAM_DOWNLOAD_TIMEOUT_MS,
    30000,
  ),
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
  torrentUploads: new Map(),
  awaitingCustomPath: new Set(),
  awaitingCustomName: new Set(),
  awaitingMovieSearch: new Set(),
  awaitingQuickTorrent: new Map(),
  downloadsView: new Map(),
  movieCatalogView: new Map(),
  notificationPreferences: new Map(),
  qbitSid: null,
  torrentAliasesByHash: new Map(),
  torrentHashesByAlias: new Map(),
  nextTorrentAlias: 1,
  trackedTorrents: new Map(),
  lastQbitErrorAlertAt: 0,
};

const NOTIFICATION_TYPES = {
  completion: "Téléchargements terminés",
  system: "Plex et qBittorrent",
};

function getNotificationPreferences(chatId) {
  if (!state.notificationPreferences.has(String(chatId))) {
    state.notificationPreferences.set(String(chatId), {
      completion: true,
      system: true,
    });
  }
  return state.notificationPreferences.get(String(chatId));
}

function isNotificationEnabled(chatId, type) {
  return getNotificationPreferences(chatId)[type] !== false;
}

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
    .replace(MEDIA_NOISE_PATTERN, " ")
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
  const notificationType = options.notificationType || "system";
  const messageOptions = { ...options };
  delete messageOptions.notificationType;
  const recipients =
    CONFIG.telegramChatIds.length > 0
      ? CONFIG.telegramChatIds
      : [CONFIG.telegramChatId].filter(Boolean);
  if (recipients.length === 0) {
    logInfo("⚠️ TELEGRAM_CHAT_ID absent: alerte ignorée.");
    return;
  }
  await Promise.all(
    recipients
      .filter((chatId) => isNotificationEnabled(chatId, notificationType))
      .map((chatId) => safeSendMessage(chatId, text, messageOptions)),
  );
}

async function sendCompletionNotification(chatId, text, options = {}) {
  if (isNotificationEnabled(chatId, "completion")) {
    await safeSendMessage(chatId, text, options);
  }
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
}).on('error', (err) => {
  logInfo(`⚠️ Erreur de démarrage du serveur HTTP sur le port ${CONFIG.port}: ${err.message}`);
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

async function qbitRequest(
  path,
  method = "GET",
  data = null,
  retry = true,
  signal = undefined,
) {
  try {
    if (!state.qbitSid) {
      await qbitLogin();
    }

    const response = await qbitHttp.request({
      url: path,
      method,
      headers: state.qbitSid ? { Cookie: state.qbitSid } : {},
      data: data ? new URLSearchParams(data).toString() : undefined,
      signal,
    });

    return response.data;
  } catch (error) {
    if (retry && [401, 403].includes(error.response?.status || 0)) {
      state.qbitSid = null;
      return qbitRequest(path, method, data, false, signal);
    }
    throw error;
  }
}

async function qbitMultipartRequest(
  filePath,
  options,
  retry = true,
  signal = undefined,
) {
  try {
    if (!state.qbitSid) {
      await qbitLogin();
    }

    const boundary = `--------------------------${crypto.randomBytes(12).toString("hex")}`;
    const fields = {
      savepath: options.savePath,
      category: options.category || "",
      paused: options.startPaused ? "true" : "false",
      autoTMM: "false",
      ...(options.customName ? { rename: options.customName } : {}),
    };
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      const safeValue = String(value).replace(/[\r\n]/g, " ");
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${safeValue}\r\n`,
        ),
      );
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="upload.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`,
      ),
      await fs.readFile(filePath),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );

    const response = await qbitHttp.post("/torrents/add", Buffer.concat(parts), {
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        ...(state.qbitSid ? { Cookie: state.qbitSid } : {}),
      },
      maxBodyLength: Infinity,
      signal,
    });

    return validateTorrentAddResponse(response.data);
  } catch (error) {
    if (retry && [401, 403].includes(error.response?.status || 0)) {
      state.qbitSid = null;
      return qbitMultipartRequest(filePath, options, false, signal);
    }
    throw error;
  }
}

function validateTorrentAddResponse(responseData) {
  if (typeof responseData === "string" && responseData.trim() !== "Ok.") {
    throw new Error(`qBittorrent a refusé le torrent (${responseData.trim()})`);
  }
  return responseData;
}

async function listTorrents(filter = "all") {
  const torrents = await qbitRequest(
    `/torrents/info?filter=${encodeURIComponent(filter)}`,
  );
  return Array.isArray(torrents) ? torrents : [];
}


async function addTorrentWithOptions(options) {
  const payload = {
    urls: options.source,
    savepath: options.savePath,
    category: options.category || "",
    paused: options.startPaused ? "true" : "false",
    autoTMM: "false",
    ...(options.customName ? { rename: options.customName } : {}),
  };

  let existingHashes = new Set();
  try {
    existingHashes = new Set(
      (await listTorrents("all")).map((torrent) => torrent.hash),
    );
  } catch (error) {
    logInfo(`⚠️ Identification du torrent ajouté différée: ${error.message}`);
  }
  if (options.priority && options.priority !== "normal") {
    logInfo("ℹ️ Recherche du torrent ajouté pour appliquer sa priorité.");
  }

  if (options.sourceType === "file") {
    await qbitMultipartRequest(options.source, options, true, options.signal);
  } else {
    validateTorrentAddResponse(
      await qbitRequest(
        "/torrents/add",
        "POST",
        payload,
        true,
        options.signal,
      ),
    );
  }

  if (options.priority && options.priority !== "normal") {
    await applyPriorityBestEffort({ ...options, existingHashes });
  }

  return findAddedTorrent(existingHashes, options.savePath);
}

async function findAddedTorrent(existingHashes, savePath) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const torrents = await listTorrents("all");
      const added = torrents
        .filter(
          (torrent) =>
            !existingHashes.has(torrent.hash) &&
            torrent.save_path?.startsWith(savePath),
        )
        .sort((a, b) => (b.added_on || 0) - (a.added_on || 0))[0];
      if (added) return added;
    } catch (error) {
      logInfo(`⚠️ Identification du torrent ajouté impossible: ${error.message}`);
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

async function renameAddedMagnetWithGemini(chatId, session, torrent) {
  if (!session.renameWithGeminiAfterAdd) return;
  if (!torrent?.hash) {
    await safeSendMessage(
      chatId,
      "⚠️ Le magnet est ajouté, mais qBittorrent n'a pas encore fourni son identité. Utilise le bouton de renommage depuis les téléchargements.",
    );
    return;
  }

  await safeSendMessage(chatId, "⏳ qBittorrent récupère les métadonnées du magnet…");
  let resolvedTorrent = torrent;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = (await listTorrents("all")).find(
      (item) => item.hash === torrent.hash,
    );
    if (current?.name && current.name !== "magnet" && current.name !== torrent.hash) {
      resolvedTorrent = current;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const sourceName = resolvedTorrent.name;
  if (!sourceName || sourceName === "magnet") {
    await safeSendMessage(chatId, "⚠️ Métadonnées non disponibles. Le torrent reste ajouté.");
    return;
  }
  await safeSendMessage(chatId, "🤖 Gemini analyse le nom réel du magnet…");
  const newName = await formatPlexNameWithGemini(sourceName, session.mediaType);
  if (newName && newName !== sourceName) {
    await qbitRequest("/torrents/rename", "POST", {
      hash: resolvedTorrent.hash,
      name: newName,
    });
    await safeSendMessage(chatId, `✅ Magnet renommé par Gemini : ${newName}`);
  } else {
    await safeSendMessage(chatId, "ℹ️ Gemini n'a pas proposé de changement.");
  }
}

async function applyPriorityBestEffort(options) {
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const torrents = await listTorrents("all");
    const candidates = torrents
      .filter(
        (torrent) =>
          !options.existingHashes?.has(torrent.hash) &&
          torrent.save_path?.startsWith(options.savePath),
      )
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
        directory: currentPath,
        simpleName: simplifyTorrentName(entry.name.replace(extension, "")),
        updatedAt: stat.mtimeMs || 0,
      });
    }
  }

  return videos;
}

async function renderMovieCatalog(chatId, options = {}) {
  const previous = state.movieCatalogView.get(chatId) || {};
  const sort = options.sort || previous.sort || "az";
  const query = (options.query ?? previous.query ?? "").trim();
  const page = options.page ?? previous.page ?? 0;
  const movies = await buildMoviesCatalog(CONFIG.qbit.pathMovie, {
    maxResults: 1000,
    maxDepth: 4,
  });
  const filtered = query
    ? movies.filter((movie) =>
        movie.simpleName.toLocaleLowerCase("fr").includes(query.toLocaleLowerCase("fr")),
      )
    : movies;

  if (sort === "recent") {
    filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  } else if (sort === "za") {
    filtered.sort((a, b) => b.simpleName.localeCompare(a.simpleName, "fr"));
  } else {
    filtered.sort((a, b) => a.simpleName.localeCompare(b.simpleName, "fr"));
  }

  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const items = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);
  state.movieCatalogView.set(chatId, { sort, query, page: safePage });

  const title = query ? `🔎 Films : « ${query} »` : "🎬 Bibliothèque de films";
  const lines = [
    `*${title}*`,
    `${filtered.length} résultat(s) · page ${safePage + 1}/${totalPages}`,
    "",
    ...(items.length
      ? items.map((movie, index) => `${safePage * pageSize + index + 1}. ${movie.simpleName}`)
      : ["Aucun film trouvé."]),
  ];
  const keyboard = [
    [
      { text: "🔤 A-Z", callback_data: "mc:sort:az" },
      { text: "🔤 Z-A", callback_data: "mc:sort:za" },
      { text: "🕘 Récents", callback_data: "mc:sort:recent" },
    ],
    [
      { text: "🔎 Rechercher", callback_data: "mc:search" },
      { text: "🔄 Actualiser", callback_data: "mc:refresh" },
    ],
    [
      { text: "⬅️", callback_data: "mc:page:prev" },
      { text: `Page ${safePage + 1}/${totalPages}`, callback_data: "mc:noop" },
      { text: "➡️", callback_data: "mc:page:next" },
    ],
    ...items.map((movie, index) => [
      {
        text: `🎬 ${movie.simpleName.slice(0, 38)}`,
        callback_data: `mc:item:${safePage * pageSize + index}`,
      },
    ]),
    [{ text: "🏠 Menu", callback_data: "menu:home" }],
  ];
  const messageOptions = {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  };
  if (options.editMeta) {
    await bot.editMessageText(lines.join("\n"), {
      chat_id: options.editMeta.chatId,
      message_id: options.editMeta.messageId,
      ...messageOptions,
    });
  } else {
    await safeSendMessage(chatId, lines.join("\n"), messageOptions);
  }
}

async function renderMovieDetails(chatId, movie, editMeta = null) {
  const extension = path.extname(movie.fileName);
  const fullPath = path.join(movie.directory, movie.fileName);
  let size = "inconnue";
  try {
    size = formatBytes((await fs.stat(fullPath)).size);
  } catch (error) {
    logInfo(`⚠️ Taille du film indisponible: ${error.message}`);
  }
  const text = [
    `🎬 *${movie.simpleName}*`,
    "",
    `📁 Fichier: \`${movie.fileName}\``,
    `💾 Taille: ${size}`,
    `🗓️ Modifié: ${new Date(movie.updatedAt).toLocaleDateString("fr-FR")}`,
    `📦 Format: ${extension.replace(".", "").toUpperCase() || "inconnu"}`,
  ].join("\n");
  const options = {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⬅️ Retour aux films", callback_data: "mc:back" },
          { text: "🏠 Menu", callback_data: "menu:home" },
        ],
      ],
    },
  };
  if (editMeta) {
    await bot.editMessageText(text, {
      chat_id: editMeta.chatId,
      message_id: editMeta.messageId,
      ...options,
    });
  } else {
    await safeSendMessage(chatId, text, options);
  }
}

function toCsvLine(values) {
  return values
    .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
    .join(",");
}

// ─────────────────────────────────────────────────────────────────────────────
// UI Telegram torrents
// ─────────────────────────────────────────────────────────────────────────────
function initializeTorrentSession(
  chatId,
  source,
  mediaType = "movie",
  sourceType = "url",
) {
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

  const previous = state.torrentSessions.get(chatId);
  if (previous && previous.source !== source) {
    cleanupTorrentSource(previous).catch((error) =>
      logInfo(`⚠️ Nettoyage session torrent impossible: ${error.message}`),
    );
  }
  state.awaitingCustomPath.delete(chatId);
  state.awaitingCustomName.delete(chatId);
  state.torrentSessions.set(chatId, {
    source,
    sourceType,
    mediaType,
    savePath: selected.savePath,
    category: selected.category,
    priority: "normal",
    startPaused: false,
    customName: null,
    renameWithGeminiAfterAdd: false,
    updatedAt: Date.now(),
    operationController: new AbortController(),
    signal: null,
  });
  const session = state.torrentSessions.get(chatId);
  session.signal = session.operationController.signal;
}

async function cleanupTorrentSource(session) {
  if (session?.sourceType !== "file") return;
  await fs.rm(path.dirname(session.source), { recursive: true, force: true });
}

async function cleanupExpiredTorrentSessions() {
  const expirationMs = 15 * 60 * 1000;
  const now = Date.now();
  for (const [chatId, session] of state.torrentSessions) {
    if (now - (session.updatedAt || now) <= expirationMs) continue;
    await cleanupTorrentSource(session);
    state.torrentSessions.delete(chatId);
    state.awaitingQuickTorrent.delete(chatId);
    state.awaitingCustomPath.delete(chatId);
    state.awaitingCustomName.delete(chatId);
    await safeSendMessage(chatId, "⌛ Ajout annulé après 15 min d'inactivité.");
  }
}

async function cleanupStaleTorrentUploads() {
  const entries = await fs.readdir(os.tmpdir(), { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith("myplexmonitor-torrent-"),
      )
      .map((entry) =>
        fs.rm(path.join(os.tmpdir(), entry.name), {
          recursive: true,
          force: true,
        }),
      ),
  );
}

async function downloadTelegramDocument(
  fileId,
  destinationPath,
  maxBytes,
  signal,
) {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const fileResponse = await axios.get(
        `https://api.telegram.org/bot${CONFIG.telegramToken}/getFile`,
        {
          params: { file_id: fileId },
          timeout: CONFIG.telegramDownloadTimeoutMs,
          signal,
        },
      );
      const filePath = fileResponse.data?.result?.file_path;
      if (!filePath) {
        throw new Error("Telegram n'a pas retourné le chemin du fichier");
      }
      const fileUrl = `https://api.telegram.org/file/bot${CONFIG.telegramToken}/${filePath}`;
      const response = await axios.get(fileUrl, {
        responseType: "arraybuffer",
        timeout: CONFIG.telegramDownloadTimeoutMs,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        signal,
        validateStatus: (status) => status >= 200 && status < 300,
      });
      const content = Buffer.from(response.data);
      if (content.length > maxBytes) {
        throw new Error("fichier téléchargé trop volumineux");
      }
      await fs.writeFile(destinationPath, content, { flag: "wx" });
      return;
    } catch (error) {
      lastError = error;
      await fs.rm(destinationPath, { force: true });
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  throw new Error(
    `téléchargement Telegram interrompu (${lastError?.message || "erreur inconnue"})`,
  );
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
  session.updatedAt = Date.now();
  await safeSendMessage(chatId, buildTorrentSummary(session), {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "▶️ Démarrer", callback_data: "tw:paused:false" },
          { text: "⏸️ En pause", callback_data: "tw:paused:true" },
        ],
        [
          { text: "🔺 Haute", callback_data: "tw:prio:high" },
          { text: "⏺️ Normale", callback_data: "tw:prio:normal" },
          { text: "🔻 Basse", callback_data: "tw:prio:low" },
        ],
        [
          { text: "📂 Dossier avancé", callback_data: "tw:path:custom" },
          {
            text: "✏️ Renommer (intelligent)",
            callback_data: "tw:rename:smart",
          },
          { text: "✍️ Renommer (manuel)", callback_data: "tw:rename:manual" },
        ],
        [
          { text: "✅ Ajouter", callback_data: "tw:confirm" },
          { text: "❌ Annuler", callback_data: "tw:cancel" },
        ],
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

async function getDiskUsage(targetPath) {
  const { stdout } = await execFileAsync("df", ["-P", "-h", targetPath]);
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) {
    throw new Error(`aucune information disque pour ${targetPath}`);
  }

  const parts = lines[lines.length - 1].split(/\s+/);
  if (parts.length < 6) {
    throw new Error(`réponse df invalide pour ${targetPath}`);
  }

  return {
    path: targetPath,
    total: parts[1],
    used: parts[2],
    available: parts[3],
    usage: parts[4],
  };
}

async function sendDiskUsage(chatId) {
  const paths = [
    ["🎬 Films", CONFIG.qbit.pathMovie],
    ["📺 Séries", CONFIG.qbit.pathSeries],
    ["📦 Autre", CONFIG.qbit.pathOther],
  ];
  const uniquePaths = [
    ...new Map(paths.map(([, targetPath]) => [targetPath, targetPath])).values(),
  ];
  const results = await Promise.all(
    uniquePaths.map(async (targetPath) => {
      try {
        return { usage: await getDiskUsage(targetPath) };
      } catch (error) {
        return { targetPath, error };
      }
    }),
  );
  const labelsByPath = new Map(
    paths.map(([label, targetPath]) => [targetPath, label]),
  );
  const lines = ["💾 *Espace disque*"];

  for (const result of results) {
    if (result.error) {
      lines.push(
        `❌ ${labelsByPath.get(result.targetPath)}: ${result.error.message}`,
      );
      continue;
    }

    const { usage } = result;
    lines.push(
      `${labelsByPath.get(usage.path)}: *${usage.available} libres* / ${usage.total} (${usage.usage} utilisés)`,
      `└ \`${usage.path}\``,
    );
  }

  lines.push("", "Utilise /disk pour actualiser.");
  await safeSendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
}

async function renderDashboard(chatId, editMeta = null) {
  const [plex, qbitResult] = await Promise.all([
    pingServer(),
    listTorrents("all")
      .then((torrents) => ({ torrents, error: null }))
      .catch((error) => ({ torrents: [], error })),
  ]);
  const torrents = qbitResult.torrents;
  const active = torrents.filter((torrent) =>
    ["downloading", "stalledDL", "metaDL", "forcedDL"].includes(torrent.state),
  );
  const speed = active.reduce((total, torrent) => total + (torrent.dlspeed || 0), 0);
  let disk = "indisponible";
  try {
    disk = (await getDiskUsage(CONFIG.qbit.pathMovie)).available;
  } catch (error) {
    logInfo(`⚠️ Espace disque du tableau de bord indisponible: ${error.message}`);
  }
  const text = [
    "📊 *Tableau de bord*",
    "",
    `Plex: ${plex.online ? "🟢 En ligne" : "🔴 Hors ligne"}`,
    qbitResult.error
      ? `qBittorrent: 🔴 Indisponible (${qbitResult.error.message})`
      : `qBittorrent: 🟢 Connecté\nTéléchargements actifs: *${active.length}*\nVitesse totale: *${formatBytes(speed)}/s*`,
    `Espace libre Films: *${disk}*`,
    `Dernière mise à jour: ${getFormattedDate()}`,
  ].join("\n");
  const options = {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔄 Actualiser", callback_data: "dash:refresh" },
          { text: "📥 Torrents", callback_data: "menu:downloads" },
        ],
        [
          { text: "🎬 Films", callback_data: "menu:movies" },
          { text: "💾 Disque", callback_data: "menu:disk" },
        ],
        [{ text: "🏠 Menu", callback_data: "menu:home" }],
      ],
    },
  };
  if (editMeta) {
    await bot.editMessageText(text, {
      chat_id: editMeta.chatId,
      message_id: editMeta.messageId,
      ...options,
    });
  } else {
    await safeSendMessage(chatId, text, options);
  }
}

async function renderNotificationSettings(chatId, editMeta = null) {
  const preferences = getNotificationPreferences(chatId);
  const text = [
    "🔔 *Notifications*",
    "",
    `${preferences.completion ? "✅" : "❌"} Téléchargements terminés`,
    `${preferences.system ? "✅" : "❌"} Plex et qBittorrent`,
    "",
    "Les réglages sont appliqués immédiatement pour ce chat.",
  ].join("\n");
  const options = {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: `${preferences.completion ? "🔕" : "🔔"} Téléchargements`, callback_data: "notif:toggle:completion" }],
        [{ text: `${preferences.system ? "🔕" : "🔔"} Plex/qBittorrent`, callback_data: "notif:toggle:system" }],
        [{ text: "🏠 Menu", callback_data: "menu:home" }],
      ],
    },
  };
  if (editMeta) {
    await bot.editMessageText(text, {
      chat_id: editMeta.chatId,
      message_id: editMeta.messageId,
      ...options,
    });
  } else {
    await safeSendMessage(chatId, text, options);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commandes Telegram
// ─────────────────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    await safeSendMessage(
      chatId,
      `👋 *MyPlexMonitor*\nRôle: *${CONFIG.role}*\n\nChoisis une action:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🎬 Ajouter un film", callback_data: "menu:movie" },
              { text: "📺 Ajouter une série", callback_data: "menu:series" },
            ],
            [
              { text: "📥 Téléchargements", callback_data: "menu:downloads" },
              { text: "🎬 Films", callback_data: "menu:movies" },
            ],
            [
              { text: "💾 Espace disque", callback_data: "menu:disk" },
              { text: "📊 Tableau de bord", callback_data: "menu:dashboard" },
            ],
            [
              { text: "🔔 Notifications", callback_data: "menu:notifications" },
              { text: "❓ Aide", callback_data: "menu:help" },
            ],
          ],
        },
      },
    );
  });
});

bot.onText(/\/cancel/i, async (msg) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    const upload = state.torrentUploads.get(chatId);
    if (upload) {
      upload.controller.abort();
      await safeSendMessage(chatId, "🛑 Annulation de la réception…");
    }
    const session = state.torrentSessions.get(chatId);
    await cleanupTorrentSource(session);
    state.torrentSessions.delete(chatId);
    state.awaitingQuickTorrent.delete(chatId);
    state.awaitingCustomPath.delete(chatId);
    state.awaitingCustomName.delete(chatId);
    state.awaitingMovieSearch.delete(chatId);
    await safeSendMessage(chatId, "❌ Annulé.");
  });

  bot.onText(/\/film(?:\s+(.+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    await withAuthorizedChat(chatId, async () => {
      const source = (match?.[1] || "").trim();
      if (!source) {
        state.awaitingQuickTorrent.set(chatId, "movie");
        await safeSendMessage(chatId, "🎬 Envoie maintenant le lien magnet ou l’URL du torrent.", {
          reply_markup: { force_reply: true },
        });
        return;
      }
      initializeTorrentSession(chatId, source, "movie");
      await askConfirmation(chatId, state.torrentSessions.get(chatId));
    });
  });

  bot.onText(/\/status/i, async (msg) => {
    const chatId = msg.chat.id;
    await withAuthorizedChat(chatId, async () => {
      try {
        await renderDashboard(chatId);
      } catch (error) {
        await safeSendMessage(chatId, `❌ Tableau de bord indisponible: ${error.message}`);
      }
    });
  });

  bot.onText(/\/notifications/i, async (msg) => {
    const chatId = msg.chat.id;
    await withAuthorizedChat(chatId, async () => {
      await renderNotificationSettings(chatId);
    });
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
      "- /movies [az|za|recent] (catalogue interactif)",
      "- /search <titre> (chercher un film)",
      "- /film [magnet|url] (assistant rapide)",
      "- /status (tableau de bord)",
      "- /notifications (préférences d'alertes)",
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
    await askConfirmation(chatId, state.torrentSessions.get(chatId));
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
    await askConfirmation(chatId, state.torrentSessions.get(chatId));
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
    await renderMovieCatalog(chatId, {
      sort: ["az", "za", "recent"].includes(mode) ? mode : "az",
    });
    } catch (error) {
    await safeSendMessage(chatId, `❌ /movies: ${error.message}`);
    }
  });
});

bot.onText(/\/search(?:\s+(.+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    const query = (match?.[1] || "").trim();
    if (!query) {
    state.awaitingMovieSearch.add(chatId);
    await safeSendMessage(chatId, "🔎 Quel film cherches-tu ?", {
      reply_markup: { force_reply: true },
    });
    return;
    }
    try {
    await renderMovieCatalog(chatId, { query, page: 0 });
    } catch (error) {
    await safeSendMessage(chatId, `❌ /search: ${error.message}`);
    }
  });
});

bot.onText(/\/(?:disk|space|storage)(?:@\w+)?$/i, async (msg) => {
  const chatId = msg.chat.id;
  await withAuthorizedChat(chatId, async () => {
    try {
      await safeSendMessage(chatId, "🔎 Vérification de l'espace disque…");
      await sendDiskUsage(chatId);
    } catch (error) {
      await safeSendMessage(
        chatId,
        `❌ Impossible de vérifier l'espace disque: ${error.message}`,
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

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  if (!isChatAuthorized(chatId)) {
    await denyUnauthorized(chatId);
    logInfo(`⚠️ Document/message refusé pour le chat ${chatId}`);
    return;
  }

  if (msg.document) {
    let uploadDirectory = null;
    let keepUpload = false;
    const uploadController = new AbortController();
    state.torrentUploads.set(chatId, {
      controller: uploadController,
      directory: null,
    });
    try {
      const isTorrent =
        msg.document.file_name?.toLowerCase().endsWith(".torrent") ||
        msg.document.mime_type === "application/x-bittorrent";
      if (!isTorrent) {
        await safeSendMessage(chatId, "❌ Envoie un fichier .torrent.");
        return;
      }

      const maxSize = CONFIG.qbit.maxTorrentFileSizeMb * 1024 * 1024;
      if (msg.document.file_size && msg.document.file_size > maxSize) {
        await safeSendMessage(
          chatId,
          `❌ Fichier trop volumineux (maximum ${CONFIG.qbit.maxTorrentFileSizeMb} Mo).`,
        );
        return;
      }

      await safeSendMessage(chatId, "⏳ Réception du fichier torrent…");
      uploadDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), "myplexmonitor-torrent-"),
      );
      state.torrentUploads.get(chatId).directory = uploadDirectory;
      await safeSendMessage(chatId, "📥 Téléchargement depuis Telegram…", {
        reply_markup: {
          inline_keyboard: [[
            { text: "❌ Annuler", callback_data: "upload:cancel" },
          ]],
        },
      });
      const uploadedPath = path.join(
        uploadDirectory,
        path.basename(msg.document.file_name || "upload.torrent"),
      );
      await downloadTelegramDocument(
        msg.document.file_id,
        uploadedPath,
        maxSize,
        uploadController.signal,
      );
      const downloadedStat = await fs.stat(uploadedPath);
      if (downloadedStat.size > maxSize) {
        throw new Error(
          `fichier téléchargé trop volumineux (maximum ${CONFIG.qbit.maxTorrentFileSizeMb} Mo)`,
        );
      }
      initializeTorrentSession(chatId, uploadedPath, "movie", "file");
      keepUpload = true;
      await safeSendMessage(chatId, "✅ Fichier reçu. Choisis son type :", {
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
    } catch (error) {
      if (error.code === "ERR_CANCELED" || error.name === "CanceledError") {
        await safeSendMessage(chatId, "❌ Réception du fichier annulée.");
      } else {
      logInfo(`❌ Upload Telegram échoué: ${error.message}`);
      await safeSendMessage(
        chatId,
        `❌ Impossible de télécharger le fichier torrent: ${error.message}`,
      );
      }
    } finally {
      state.torrentUploads.delete(chatId);
      if (uploadDirectory && !keepUpload) {
        await fs.rm(uploadDirectory, { recursive: true, force: true });
      }
    }
    return;
  }

  if (!msg.text || msg.text.startsWith("/")) return;

  if (state.awaitingQuickTorrent.has(chatId)) {
    const mediaType = state.awaitingQuickTorrent.get(chatId);
    state.awaitingQuickTorrent.delete(chatId);
    initializeTorrentSession(chatId, msg.text.trim(), mediaType);
    await askConfirmation(chatId, state.torrentSessions.get(chatId));
    return;
  }

  if (state.awaitingMovieSearch.has(chatId)) {
    state.awaitingMovieSearch.delete(chatId);
    try {
      await renderMovieCatalog(chatId, { query: msg.text, page: 0 });
    } catch (error) {
      await safeSendMessage(chatId, `❌ Recherche impossible: ${error.message}`);
    }
    return;
  }

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
  await askConfirmation(chatId, session);
});

bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = query.data;

  if (!chatId || !data) return;
  if (!isChatAuthorized(chatId)) {
    await bot
      .answerCallbackQuery(query.id, {
        text: "Accès refusé",
        show_alert: true,
      })
      .catch(() => null);
    return;
  }

  await bot.answerCallbackQuery(query.id).catch(() => null);

  try {
    if (data === "upload:cancel") {
    const upload = state.torrentUploads.get(chatId);
    if (!upload) {
      await safeSendMessage(chatId, "ℹ️ Aucun téléchargement en cours.");
      return;
    }
    upload.controller.abort();
    await bot
      .answerCallbackQuery(query.id, {
        text: "Annulation en cours…",
      })
      .catch(() => null);
    return;
    }

    if (data === "menu:movie" || data === "menu:series") {
      const mediaType = data.endsWith("movie") ? "movie" : "series";
      const label = mediaType === "movie" ? "🎬 film" : "📺 série";
      state.awaitingQuickTorrent.set(chatId, mediaType);
      await safeSendMessage(
        chatId,
        `Envoie le lien magnet ou l’URL du torrent pour ${label}.`,
        { reply_markup: { force_reply: true } },
      );
      return;
    }
    if (data === "menu:downloads") {
      await renderDownloads(chatId);
      return;
    }
    if (data === "menu:movies") {
      await renderMovieCatalog(chatId);
      return;
    }
    if (data === "menu:disk") {
      await sendDiskUsage(chatId);
      return;
    }
    if (data === "menu:dashboard") {
      await renderDashboard(chatId);
      return;
    }
    if (data === "menu:notifications") {
      await renderNotificationSettings(chatId);
      return;
    }
    if (data === "menu:home") {
      state.awaitingQuickTorrent.delete(chatId);
      state.awaitingMovieSearch.delete(chatId);
      await safeSendMessage(chatId, "🏠 Menu principal :", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🎬 Ajouter un film", callback_data: "menu:movie" },
              { text: "📺 Ajouter une série", callback_data: "menu:series" },
            ],
            [
              { text: "📥 Téléchargements", callback_data: "menu:downloads" },
              { text: "🎬 Films", callback_data: "menu:movies" },
            ],
            [
              { text: "💾 Espace disque", callback_data: "menu:disk" },
              { text: "📊 Tableau de bord", callback_data: "menu:dashboard" },
            ],
            [
              { text: "🔔 Notifications", callback_data: "menu:notifications" },
              { text: "❓ Aide", callback_data: "menu:help" },
            ],
          ],
        },
      });
      return;
    }

    if (data.startsWith("notif:toggle:")) {
      const type = data.split(":")[2];
      if (!NOTIFICATION_TYPES[type]) return;
      const preferences = getNotificationPreferences(chatId);
      preferences[type] = !preferences[type];
      await renderNotificationSettings(chatId, { chatId, messageId });
      return;
    }

    if (data === "dash:refresh") {
      await renderDashboard(chatId, { chatId, messageId });
      return;
    }
    if (data === "menu:help") {
      await safeSendMessage(chatId, "Utilise /movie, /series ou envoie un fichier .torrent.");
      return;
    }

    if (data.startsWith("tw:")) {
      const session = state.torrentSessions.get(chatId);
      if (!session && data !== "tw:cancel") {
        await safeSendMessage(chatId, "⚠️ Session expirée, relance /torrent.");
        return;
      }

      if (data === "tw:cancel") {
        session?.operationController.abort();
        await cleanupTorrentSource(session);
        state.torrentSessions.delete(chatId);
        state.awaitingCustomPath.delete(chatId);
        state.awaitingCustomName.delete(chatId);
        await safeSendMessage(chatId, "❌ Ajout du torrent annulé.");
        return;
      }

      if (data.startsWith("tw:type:")) {
        const mediaType = data.split(":")[2];
        initializeTorrentSession(
          chatId,
          session.source,
          mediaType,
          session.sourceType,
        );
        const selectedSession = state.torrentSessions.get(chatId);
        if (selectedSession.sourceType === "file") {
          await prepareSmartTorrentName(chatId, selectedSession);
        }
        await askConfirmation(chatId, selectedSession);
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
        await askConfirmation(chatId, session);
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
        await askConfirmation(chatId, session);
        return;
      }

      if (data.startsWith("tw:prio:")) {
        session.priority = data.split(":")[2];
        await askConfirmation(chatId, session);
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
        await prepareSmartTorrentName(chatId, session);
        await askConfirmation(chatId, session);
        return;
      }

      if (data === "tw:confirm") {
        let added = false;
        try {
          await safeSendMessage(chatId, "⏳ Ajout à qBittorrent en cours…");
          const addedTorrent = await addTorrentWithOptions(session);
          added = true;
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
          await renameAddedMagnetWithGemini(chatId, session, addedTorrent);
        } catch (error) {
          if (error.code === "ERR_CANCELED" || error.name === "CanceledError") {
            await safeSendMessage(chatId, "❌ Ajout annulé.");
          } else {
          await safeSendMessage(
            chatId,
            `❌ Échec de l'ajout du torrent: ${error.message}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "🔁 Réessayer", callback_data: "tw:confirm" },
                    { text: "❌ Annuler", callback_data: "tw:cancel" },
                  ],
                ],
              },
            },
          );
          }
        } finally {
          if (!added) return;
          await cleanupTorrentSource(session);
          state.torrentSessions.delete(chatId);
          state.awaitingCustomPath.delete(chatId);
          state.awaitingCustomName.delete(chatId);
        }
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

    if (data.startsWith("mc:")) {
      const view = state.movieCatalogView.get(chatId) || {
        sort: "az",
        query: "",
        page: 0,
      };
      if (data === "mc:noop") return;
      if (data === "mc:back") {
        await renderMovieCatalog(chatId, { editMeta: { chatId, messageId } });
        return;
      }
      if (data.startsWith("mc:item:")) {
        const index = Number.parseInt(data.split(":")[2], 10);
        const catalog = await buildMoviesCatalog(CONFIG.qbit.pathMovie, {
          maxResults: 1000,
          maxDepth: 4,
        });
        const sorted = catalog
          .filter((movie) =>
            view.query
              ? movie.simpleName.toLocaleLowerCase("fr").includes(view.query.toLocaleLowerCase("fr"))
              : true,
          )
          .sort((a, b) =>
            view.sort === "recent"
              ? b.updatedAt - a.updatedAt
              : view.sort === "za"
                ? b.simpleName.localeCompare(a.simpleName, "fr")
                : a.simpleName.localeCompare(b.simpleName, "fr"),
          );
        if (sorted[index]) {
          await renderMovieDetails(chatId, sorted[index], { chatId, messageId });
        }
        return;
      }
      if (data === "mc:search") {
        state.awaitingMovieSearch.add(chatId);
        await safeSendMessage(chatId, "🔎 Quel film cherches-tu ?", {
          reply_markup: { force_reply: true },
        });
        return;
      }
      if (data === "mc:refresh") {
        await renderMovieCatalog(chatId, {
          ...view,
          editMeta: { chatId, messageId },
        });
        return;
      }
      if (data.startsWith("mc:sort:")) {
        await renderMovieCatalog(chatId, {
          ...view,
          sort: data.split(":")[2],
          page: 0,
          editMeta: { chatId, messageId },
        });
        return;
      }
      if (data === "mc:page:next" || data === "mc:page:prev") {
        await renderMovieCatalog(chatId, {
          ...view,
          page: view.page + (data.endsWith("next") ? 1 : -1),
          editMeta: { chatId, messageId },
        });
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
          const oldName = torrent.name;

          // Notifier tous les chats autorisés
          const recipients =
            CONFIG.telegramChatIds.length > 0
              ? CONFIG.telegramChatIds
              : [CONFIG.telegramChatId].filter(Boolean);

          for (const chatId of recipients) {
            await sendCompletionNotification(
              chatId,
              `✅ *Téléchargement terminé:*
${torrent.name}

_Nom d'origine: ${oldName}_`,
              {
                parse_mode: "Markdown",
              },
            );
          }
        } catch(renameError) {
           logInfo(`⚠️ Erreur notification fin de téléchargement de ${torrent.name}: ${renameError.message}`);
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
    logInfo(`⚠️ Vérification qBittorrent impossible: ${error.message}`);
    const now = Date.now();
    if (now - state.lastQbitErrorAlertAt > 5 * 60 * 1000) {
      state.lastQbitErrorAlertAt = now;
      await sendAlert(
        `⚠️ *qBittorrent indisponible*\n${error.message}\n\nLe bot réessaiera automatiquement.`,
        { parse_mode: "Markdown" },
      );
    }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  logInfo(
    `🚀 MyPlexMonitor démarré en mode ${CONFIG.role} (polling Telegram: ${
      CONFIG.role === "LOCAL" ? "actif" : "en attente d'un failover"
    }).`,
  );
  await cleanupStaleTorrentUploads().catch((error) =>
    logInfo(`⚠️ Nettoyage temporaire impossible: ${error.message}`),
  );
  await bot
    .setMyCommands([
      { command: "start", description: "Ouvrir le menu principal" },
      { command: "movie", description: "Ajouter un film" },
      { command: "series", description: "Ajouter une série" },
      { command: "torrent", description: "Ajouter un torrent" },
      { command: "film", description: "Assistant rapide pour un film" },
      { command: "downloads", description: "Voir les téléchargements" },
      { command: "movies", description: "Parcourir la bibliothèque de films" },
      { command: "search", description: "Rechercher un film" },
      { command: "status", description: "Tableau de bord serveur" },
      { command: "notifications", description: "Gérer les notifications" },
      { command: "disk", description: "Voir l'espace disque disponible" },
      { command: "cancel", description: "Annuler l'action en cours" },
      { command: "help", description: "Afficher l'aide" },
    ])
    .catch((error) =>
      logInfo(`⚠️ Commandes Telegram non enregistrées: ${error.message}`),
    );

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
  setInterval(cleanupExpiredTorrentSessions, 60000);
  checkTorrentCompletions(); // Initial check
})();
