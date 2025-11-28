# Ìæ¨ MyPlexMonitor

<p align="center">
  <img src="https://img.shields.io/badge/version-2.0.0-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen.svg" alt="Node">
</p>

A powerful Telegram bot to monitor your Plex server and manage qBittorrent downloads. Get real-time alerts when your server goes down, browse your library, and add torrents directly from Telegram!

## ‚ú® Features

### Ì≥° Server Monitoring
- **Real-time Status Checks** - Periodically monitors your Plex server's availability
- **Automatic Alerts** - Get notified instantly when your server goes down or comes back online
- **Downtime Tracking** - See how long your server was offline

### Ìæ¨ Plex Integration
- **Recently Added** - View the latest movies and shows added to your library
- **Library Search** - Search your entire Plex library directly from Telegram
- **Statistics** - Get detailed stats about your library (movies, shows, music, etc.)

### Ì≥• qBittorrent Integration
- **Add Torrents** - Send magnet links directly to your qBittorrent
- **Smart Paths** - Automatically sorts movies and series to different folders
- **Download Progress** - Track all your active downloads with progress bars
- **Completion Alerts** - Get notified when downloads finish
- **Torrent Management** - Pause, resume, or delete torrents from Telegram

### Ì¥í Security
- **User Authorization** - Restrict bot access to specific Telegram users
- **Secure Credentials** - All sensitive data stored in environment variables

### Ìºê Hosting Ready
- Built-in web server for platforms like Render
- Health check endpoints for monitoring

## Ì≥ã Commands

| Command | Description |
|---------|-------------|
| \`/start\` | Welcome message and bot introduction |
| \`/check\` | Check Plex server status |
| \`/server\` | Show server system information |
| \`/stats\` | Library statistics |
| \`/recent [n]\` | Recently added items (optional: number of items) |
| \`/search <query>\` | Search your Plex library |
| \`/torrent <magnet>\` | Add torrent (interactive mode) |
| \`/movie <magnet>\` | Add torrent as movie |
| \`/series <magnet>\` | Add torrent as series |
| \`/downloads\` | View active downloads |
| \`/pause [name]\` | Pause all or specific torrent |
| \`/resume [name]\` | Resume all or specific torrent |
| \`/delete <name>\` | Delete a torrent |
| \`/help\` | Show all commands |

## Ì∫Ä Installation

### Prerequisites

- Node.js >= 16.0.0
- A Plex server
- A Telegram bot (create one with [@BotFather](https://t.me/BotFather))
- qBittorrent with WebUI enabled (optional, for torrent features)

### Setup

1. **Clone the repository**
   \`\`\`bash
   git clone https://github.com/Jonas-du-bois/myPlexMonitor.git
   cd myPlexMonitor
   \`\`\`

2. **Install dependencies**
   \`\`\`bash
   npm install
   \`\`\`

3. **Configure environment variables**
   \`\`\`bash
   cp .env.example .env
   \`\`\`
   Edit \`.env\` with your configuration (see [Configuration](#-configuration))

4. **Start the bot**
   \`\`\`bash
   npm start
   \`\`\`

## ‚öôÔ∏è Configuration

Copy \`.env.example\` to \`.env\` and fill in your values:

### Required Settings

| Variable | Description |
|----------|-------------|
| \`TELEGRAM_TOKEN\` | Your Telegram bot token from @BotFather |
| \`TELEGRAM_CHAT_ID\` | Your Telegram chat ID for automatic alerts |
| \`PLEX_IP\` | Your Plex server IP address |
| \`PLEX_TOKEN\` | Your Plex authentication token ([How to find](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)) |

### Optional Settings

| Variable | Default | Description |
|----------|---------|-------------|
| \`PLEX_PORT\` | \`32400\` | Plex server port |
| \`CHECK_INTERVAL\` | \`30000\` | Server check interval (ms) |
| \`QBITTORRENT_HOST\` | \`localhost\` | qBittorrent WebUI host |
| \`QBITTORRENT_PORT\` | \`8080\` | qBittorrent WebUI port |
| \`QBITTORRENT_USERNAME\` | \`admin\` | qBittorrent username |
| \`QBITTORRENT_PASSWORD\` | \`adminadmin\` | qBittorrent password |
| \`MOVIES_PATH\` | \`/mnt/films\` | Download path for movies |
| \`SERIES_PATH\` | \`/mnt/films/series\` | Download path for series |
| \`AUTHORIZED_USERS\` | (empty) | Comma-separated Telegram user IDs |
| \`PORT\` | \`3000\` | Web server port |

## Ì¥ß qBittorrent Setup

1. **Enable WebUI** in qBittorrent:
   - Go to \`Tools\` > \`Options\` > \`Web UI\`
   - Check "Web User Interface (Remote control)"
   - Set your port (default: 8080)
   - Set username and password
   - Optional: Enable "Bypass authentication for clients on localhost"

2. **Configure download paths** in your \`.env\`:
   \`\`\`env
   MOVIES_PATH=/mnt/films
   SERIES_PATH=/mnt/films/series
   \`\`\`

## Ì∞≥ Docker (Optional)

\`\`\`dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD ["npm", "start"]
\`\`\`

\`\`\`bash
docker build -t myplexmonitor .
docker run -d --env-file .env myplexmonitor
\`\`\`

## Ìºê Deploying to Render

1. Create a new Web Service on Render
2. Connect your GitHub repository
3. Set the build command: \`npm install\`
4. Set the start command: \`npm start\`
5. Add your environment variables in the Render dashboard

## Ì≥∏ Screenshots

### Download Management
\`\`\`
Ì≥• Downloads

‚¨áÔ∏è 5.2 MB/s | ‚¨ÜÔ∏è 1.1 MB/s

‚¨áÔ∏è Movie.Name.2024.1080p.mkv
‚ñà‚ñà‚ñà‚ñà‚ñà‚ñà‚ñà‚ñà‚ñà‚ñë 90% | ‚¨áÔ∏è 5.2 MB/s | ‚è±Ô∏è 2m 30s

Ì≥§ Another.Movie.2023.mkv
‚ñà‚ñà‚ñà‚ñà‚ñà‚ñà‚ñà‚ñà‚ñà‚ñà 100%
\`\`\`

### Server Status
\`\`\`
Ìø¢ Server Status: ONLINE

Ì≥° Server: 192.168.1.100:32400
‚è∞ Last check: 11/28/2025, 2:30:00 PM
\`\`\`

## Ì¥ù Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (\`git checkout -b feature/AmazingFeature\`)
3. Commit your changes (\`git commit -m 'Add some AmazingFeature'\`)
4. Push to the branch (\`git push origin feature/AmazingFeature\`)
5. Open a Pull Request

## Ì≥ù License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Ìπè Acknowledgments

- [node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api) - Telegram Bot API
- [plex-api](https://github.com/phillipj/node-plex-api) - Plex API wrapper
- [qBittorrent](https://www.qbittorrent.org/) - Amazing torrent client with WebUI

---

<p align="center">Made with ‚ù§Ô∏è by <a href="https://github.com/Jonas-du-bois">jonas_du_bois</a></p>
