/**
 * Test script to validate MyPlexMonitor configuration
 * Run this BEFORE deploying to Render to check everything is OK
 */

require("dotenv").config();
const net = require("net");
const axios = require("axios");

console.log("╔══════════════════════════════════════════════════════════════════════════════╗");
console.log("║                   MyPlexMonitor Configuration Test                           ║");
console.log("╚══════════════════════════════════════════════════════════════════════════════╝\n");

// Configuration check
const config = {
    serverIp: process.env.SERVER_IP || process.env.PLEX_IP || process.env.IP_SERVER,
    plexPort: parseInt(process.env.PLEX_PORT) || 32400,
    plexToken: process.env.PLEX_TOKEN,
    telegramToken: process.env.TELEGRAM_TOKEN || process.env.TOKEN_TELEGRAM,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || process.env.ID_CHAT,
    webhookUrl: process.env.WEBHOOK_URL,
    qbittorrent: {
        host: process.env.QBITTORRENT_HOST || process.env.SERVER_IP || process.env.PLEX_IP || process.env.IP_SERVER || "localhost",
        port: parseInt(process.env.QBITTORRENT_PORT) || 8080,
        username: process.env.QBITTORRENT_USERNAME || "admin",
        password: process.env.QBITTORRENT_PASSWORD || "adminadmin",
    },
};

let errors = 0;
let warnings = 0;

// Test functions
function testRequired(name, value) {
    if (!value) {
        console.log(`❌ ERREUR: ${name} n'est pas configuré!`);
        errors++;
        return false;
    }
    console.log(`✅ ${name}: ${value}`);
    return true;
}

function testOptional(name, value) {
    if (!value) {
        console.log(`⚠️  AVERTISSEMENT: ${name} n'est pas configuré`);
        warnings++;
        return false;
    }
    console.log(`✅ ${name}: ${value}`);
    return true;
}

// Check critical settings
console.log("📋 Configuration obligatoire:");
testRequired("SERVER_IP", config.serverIp);
testRequired("TELEGRAM_TOKEN", config.telegramToken);
testRequired("PLEX_TOKEN", config.plexToken);

console.log("\n📋 Configuration optionnelle:");
testOptional("TELEGRAM_CHAT_ID", config.telegramChatId);
testOptional("WEBHOOK_URL", config.webhookUrl);
testOptional("PLEX_PORT", config.plexPort);

console.log("\n📋 Configuration qBittorrent:");
console.log(`   Host: ${config.qbittorrent.host}${config.qbittorrent.host === "localhost" ? " ⚠️  (utilise localhost!)" : " ✅"}`);
console.log(`   Port: ${config.qbittorrent.port}`);
console.log(`   Username: ${config.qbittorrent.username}`);
console.log(`   Password: ${"*".repeat(config.qbittorrent.password.length)}`);

if (config.qbittorrent.host === "localhost" && config.serverIp) {
    console.log(`\n⚠️  qBittorrent utilise "localhost" mais SERVER_IP est défini!`);
    console.log(`   💡 Vérifiez que QBITTORRENT_HOST n'est pas défini sur "localhost"`);
    warnings++;
}

// Test Plex connection
async function testPlex() {
    console.log("\n🔍 Test de connexion Plex...");
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);

        socket.on("connect", () => {
            console.log(`✅ Plex server accessible sur ${config.serverIp}:${config.plexPort}`);
            socket.destroy();
            resolve(true);
        });

        socket.on("timeout", () => {
            console.log(`❌ Timeout: Plex ne répond pas sur ${config.serverIp}:${config.plexPort}`);
            socket.destroy();
            errors++;
            resolve(false);
        });

        socket.on("error", (err) => {
            console.log(`❌ Erreur Plex: ${err.code} - Impossible de joindre ${config.serverIp}:${config.plexPort}`);
            errors++;
            resolve(false);
        });

        socket.connect(config.plexPort, config.serverIp);
    });
}

// Test qBittorrent connection
async function testQBittorrent() {
    console.log("\n🔍 Test de connexion qBittorrent...");
    try {
        const url = `http://${config.qbittorrent.host}:${config.qbittorrent.port}/api/v2/auth/login`;
        console.log(`   Tentative: ${url}`);
        
        const response = await axios.post(
            url,
            `username=${encodeURIComponent(config.qbittorrent.username)}&password=${encodeURIComponent(config.qbittorrent.password)}`,
            {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                timeout: 5000,
            }
        );

        if (response.data === "Ok." || response.headers["set-cookie"]) {
            console.log(`✅ qBittorrent accessible et authentification réussie`);
            return true;
        } else {
            console.log(`⚠️  qBittorrent répond mais authentification échouée`);
            warnings++;
            return false;
        }
    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            console.log(`❌ Connexion refusée: qBittorrent n'est pas accessible sur ${config.qbittorrent.host}:${config.qbittorrent.port}`);
            console.log(`   💡 Vérifiez que qBittorrent est démarré et que WebUI est activé`);
        } else if (error.code === 'ETIMEDOUT') {
            console.log(`❌ Timeout: qBittorrent ne répond pas`);
        } else if (error.response?.status === 401) {
            console.log(`❌ Authentification refusée: mauvais username/password`);
        } else {
            console.log(`❌ Erreur qBittorrent: ${error.message}`);
        }
        errors++;
        return false;
    }
}

// Run all tests
async function runTests() {
    if (config.serverIp) {
        await testPlex();
        await testQBittorrent();
    }

    console.log("\n╔══════════════════════════════════════════════════════════════════════════════╗");
    console.log("║                              Résumé du test                                  ║");
    console.log("╚══════════════════════════════════════════════════════════════════════════════╝");
    console.log(`Erreurs: ${errors}`);
    console.log(`Avertissements: ${warnings}`);

    if (errors > 0) {
        console.log("\n❌ Des erreurs ont été détectées. Corrigez-les avant de déployer sur Render!");
        console.log("📖 Consultez RENDER_SETUP.md pour les instructions de configuration.");
        process.exit(1);
    } else if (warnings > 0) {
        console.log("\n⚠️  Configuration fonctionnelle mais avec des avertissements.");
        console.log("📖 Consultez RENDER_SETUP.md pour optimiser votre configuration.");
        process.exit(0);
    } else {
        console.log("\n✅ Tout est configuré correctement! Vous pouvez déployer sur Render.");
        process.exit(0);
    }
}

runTests();
