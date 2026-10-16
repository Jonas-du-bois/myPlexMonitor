# MyPlexMonitor (HA LOCAL/BACKUP)

Surveillance hybride haute disponibilité pour Plex Media Server avec Telegram et gestion avancée des torrents qBittorrent.

## Architecture

- **LOCAL (Ubuntu)**: instance maître, surveillance locale de Plex (`127.0.0.1:PLEX_PORT`), polling Telegram actif.
- **BACKUP (Render)**: sentinelle distante, surveillance Internet (`PLEX_IP:PLEX_PORT`), polling Telegram inactif tant que LOCAL est en ligne.
- **Failover anti-409 Telegram**:
  - LOCAL écoute normalement les commandes.
  - BACKUP passe en écoute uniquement après panne confirmée.
  - BACKUP arrête immédiatement le polling au retour du serveur Ubuntu.

## Fonctionnalités

### Monitoring Plex
- Vérification TCP toutes les `CHECK_INTERVAL` ms.
- Tolérance micro-coupures: 2 échecs consécutifs avant alerte.
- Endpoint keep-alive / healthcheck: `GET /`.

### Telegram
- `/start`, `/help`, `/check`, `/restart_plex`
- `/torrent`, `/movie`, `/series` avec assistant interactif:
  - type de contenu
  - dossier de destination
  - catégorie qBittorrent
  - priorité (haute/normale/basse)
  - démarrage immédiat ou en pause
  - confirmation + actions rapides
- `/downloads [all|active|paused|completed]`
- `/pause [nom]`, `/resume [nom]`, `/delete <nom>`

### Diagnostic Ubuntu (LOCAL)
- Rapport de démarrage (uptime, loadavg, RAM, analyse `last -x`).
- Notification d’extinction propre sur `SIGINT`/`SIGTERM`.

---

## Installation rapide

```bash
git clone https://github.com/Jonas-du-bois/myPlexMonitor.git
cd myPlexMonitor
npm install
cp .env.example .env
```

Renseigne ensuite les variables dans `.env`.

## Variables minimales obligatoires

- `TELEGRAM_TOKEN`
- `TELEGRAM_CHAT_ID`
- `ROLE` (`LOCAL` ou `BACKUP`)

Variables Plex recommandées:
- `PLEX_IP` (surtout en BACKUP)
- `PLEX_PORT`

Variables qBittorrent recommandées:
- `QBITTORRENT_HOST`, `QBITTORRENT_PORT`
- `QBITTORRENT_USERNAME`, `QBITTORRENT_PASSWORD`
- `MOVIES_PATH`, `SERIES_PATH`, `OTHER_PATH`

---

## Déploiement LOCAL sur Ubuntu avec PM2

1. Installer PM2:
```bash
npm install -g pm2
```

2. Vérifier `.env` avec `ROLE=LOCAL`.

3. Lancer:
```bash
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup
```

4. Vérifier:
```bash
pm2 logs myplexmonitor-local
curl http://127.0.0.1:3000/
```

### Autoriser `/restart_plex` sans mot de passe

Éditer sudoers avec `visudo`:
```bash
sudo visudo
```

Ajouter (adapter l’utilisateur Linux):
```text
myuser ALL=NOPASSWD: /bin/systemctl restart plexmediaserver
```

> Important: garde la commande exacte pour limiter les droits.

---

## Déploiement BACKUP sur Render

1. Créer un **Web Service** sur Render.
2. Build command: `npm install`
3. Start command: `npm start`
4. Variables Render:
   - `ROLE=BACKUP`
   - `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`
   - `PLEX_IP=<IP publique ou DDNS de ton Ubuntu>`
   - `PLEX_PORT=32400`
   - `CHECK_INTERVAL=30000`
   - `PORT=3000`

Le service BACKUP reste silencieux tant que LOCAL est en ligne.

---

## Healthcheck

`GET /` retourne:
- `status`
- `role`
- `isServerOnline`
- `failureCount`
- `lastDownTime`
- `timestamp`

Utilisable avec Render Health Checks et services externes (cron-job.org, UptimeRobot, etc.).

---

## Lancement local

```bash
npm start
```

## Test configuration

```bash
npm run test-config
```
