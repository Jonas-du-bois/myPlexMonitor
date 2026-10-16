require("dotenv").config();
const net = require("net");

const role = (process.env.ROLE || "LOCAL").toUpperCase() === "BACKUP" ? "BACKUP" : "LOCAL";
const plexIp = process.env.PLEX_IP || "127.0.0.1";
const plexPort = Number.parseInt(process.env.PLEX_PORT || "32400", 10);

const telegramToken = process.env.TELEGRAM_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;

console.log("╔══════════════════════════════════════════════════════╗");
console.log("║            MyPlexMonitor Config Test                ║");
console.log("╚══════════════════════════════════════════════════════╝\n");

let errors = 0;

function check(name, value, required = true) {
    if (!value && required) {
        console.log(`❌ ${name} manquant`);
        errors += 1;
        return;
    }
    console.log(`✅ ${name}: ${value ?? "(vide)"}`);
}

check("ROLE", role);
check("TELEGRAM_TOKEN", telegramToken);
check("TELEGRAM_CHAT_ID", telegramChatId);
check("PLEX_IP", plexIp, role === "BACKUP");
check("PLEX_PORT", plexPort);

console.log("\n🔍 Test TCP Plex...");

const targetHost = role === "LOCAL" ? "127.0.0.1" : plexIp;
const socket = new net.Socket();
socket.setTimeout(5000);

socket.on("connect", () => {
    console.log(`✅ Plex joignable sur ${targetHost}:${plexPort}`);
    socket.destroy();
    finish();
});

socket.on("timeout", () => {
    console.log(`⚠️ Timeout vers ${targetHost}:${plexPort}`);
    socket.destroy();
    finish();
});

socket.on("error", (err) => {
    console.log(`⚠️ Erreur TCP ${targetHost}:${plexPort} (${err.code || err.message})`);
    finish();
});

socket.connect(plexPort, targetHost);

function finish() {
    console.log("\nRésumé:");
    if (errors > 0) {
        console.log(`❌ ${errors} erreur(s) de configuration.`);
        process.exit(1);
    }
    console.log("✅ Configuration minimale valide.");
    process.exit(0);
}
