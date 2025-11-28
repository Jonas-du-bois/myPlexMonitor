const net = require('net');
const axios = require('axios');

// --- CONFIGURATION ---
const CONFIG = {
    serverIp: process.env.IP_SERVER,
    serverPort: 32400,                  // Port par défaut de Plex
    checkInterval: 30000,               // 30 secondes en millisecondes
    telegramToken: process.env.TOKEN_TELEGRAM,
    telegramChatId: process.env.ID_CHAT
};

// Variable pour mémoriser l'état précédent (pour ne pas spammer)
let isServerOnline = true; // On part du principe qu'il est en ligne au démarrage

// Fonction pour envoyer le message Telegram
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

// Fonction qui teste la connexion
function checkServer() {
    const socket = new net.Socket();
    
    // Timeout de 5 secondes : si pas de réponse, on considère que c'est down
    socket.setTimeout(5000);

    socket.on('connect', () => {
        if (!isServerOnline) {
            // Le serveur était DOWN, il est maintenant UP
            sendAlert(`✅ Le serveur Plex est de retour en ligne !`);
            isServerOnline = true;
        }
        socket.destroy(); // On ferme la connexion, tout va bien
    });

    socket.on('timeout', () => {
        handleDown('Timeout (Pas de réponse)');
        socket.destroy();
    });

    socket.on('error', (err) => {
        handleDown(`Erreur (${err.code})`);
    });

    socket.connect(CONFIG.serverPort, CONFIG.serverIp);
}

// Gestion de la panne
function handleDown(reason) {
    if (isServerOnline) {
        // Le serveur était UP, il vient de passer DOWN
        sendAlert(`🚨 ALERTE: Le serveur Plex est HORS LIGNE !\nRaison: ${reason}`);
        isServerOnline = false;
    }
}

// Démarrage du script
console.log(`Monitoring de ${CONFIG.serverIp}:${CONFIG.serverPort} démarré...`);
// Premier check immédiat
checkServer();
// Puis boucle infinie
setInterval(checkServer, CONFIG.checkInterval);