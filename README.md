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
- Envoi direct d'un fichier `.torrent` dans Telegram avec le même assistant
  (le fichier est envoyé à qBittorrent via multipart puis supprimé du dossier temporaire)
- Le choix Film/Série applique automatiquement le dossier et la catégorie correspondants.
- Le bouton de renommage intelligent utilise Gemini Flash via Google AI Studio
  (`GEMINI_API_KEY`) et revient à un nettoyage local si l'API est indisponible.
  Gemini conserve uniquement le titre officiel, l'année et l'épisode éventuel :
  les langues (VF, VOSTFR, MULTI, etc.) et les tags techniques sont supprimés.
- `/downloads [all|active|paused|completed]`
- `/disk` (ou `/space`) pour voir l'espace libre des dossiers Films, Séries et Autre
- `/pause [id|nom]`, `/resume [id|nom]`, `/delete [id|nom]`
- Sans argument sur `/pause`, `/resume`, `/delete`: affichage des torrents actionnables avec boutons Telegram
- Alias lisibles `[T001]`, `[T002]`... utilisables directement dans les commandes
- `/random` (film aléatoire depuis `MOVIES_PATH`)
- `/movies [az|za|recent]` ouvre un catalogue interactif avec pagination et tri
  A-Z, Z-A ou par date récente
- `/search <titre>` recherche un film dans `MOVIES_PATH`; le bouton de recherche
  du catalogue permet aussi une recherche guidée directement dans Telegram
- Les boutons du catalogue ouvrent une fiche détaillée avec fichier, taille,
  date de modification et format.
- `/film [magnet|url]` propose un assistant rapide avec le dossier Films et
  les options avancées uniquement sur demande.
- `/status` affiche le tableau de bord Plex, qBittorrent, vitesse et disque.
- `/notifications` permet d'activer ou désactiver les notifications de fin de
  téléchargement et les alertes Plex/qBittorrent pour le chat courant.
- `/export_torrents` (export CSV des torrents)

### C411

Le guide C411 fourni documente les identifiants de catégories et d'options,
notamment la catégorie Film (`subcategoryId=6`) et Série TV (`subcategoryId=8`).
Le fichier fourni ne contient toutefois pas les routes de recherche,
l'authentification ou le format de téléchargement. Le bot réserve donc
`C411_API_URL` et `C411_API_KEY` dans `.env`, mais n'appelle pas encore de route
non vérifiée. Il faudra le guide API/authentification complet pour ajouter une
recherche C411 fiable sans exposer de clé ni casser le bot.

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
- `MAX_TORRENT_FILE_SIZE_MB` (optionnel, 20 Mo par défaut)
- `GEMINI_API_KEY` (optionnel, Google AI Studio)
- `GEMINI_MODEL`, `GEMINI_TIMEOUT_MS`, `TELEGRAM_DOWNLOAD_TIMEOUT_MS` (optionnels)

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

## Déploiement Docker Compose sur Ubuntu

Le conteneur utilise le réseau hôte Linux pour joindre Plex et qBittorrent via
`127.0.0.1`. Les dossiers montés sont configurés par `MOVIES_PATH`,
`SERIES_PATH` et `OTHER_PATH` dans `.env`.

1. Crée `.env` depuis `.env.example` et renseigne les identifiants et chemins
   propres au serveur. Ne committe pas `.env` ni `myPlexMonitor.env`.
2. Construis et démarre le service :

```bash
docker compose up -d --build
```

3. Vérifie son état, son endpoint de santé et ses journaux :

```bash
docker compose ps
curl http://127.0.0.1:3000/
docker compose logs -f myplexmonitor
```

Pour mettre à jour après un `git pull --ff-only` sur `main`, relance
`docker compose up -d --build`. Pour arrêter le service, lance
`docker compose down`.

La commande Telegram `/restart_plex` ne redémarre pas l'hôte depuis Docker
Compose. Elle indique de redémarrer Plex directement sur Ubuntu. Elle reste
disponible quand le bot fonctionne directement sur l'hôte avec PM2.

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
