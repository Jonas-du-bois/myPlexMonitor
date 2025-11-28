# MyPlexMonitor

MyPlexMonitor is a simple Telegram bot that monitors the status of your Plex server and alerts you in case of unavailability.

## Features

- Periodically checks if your Plex server port is open.
- Sends an alert to Telegram if the server becomes unreachable.
- Sends a notification when the server is back online.
- Uses a `.env` file for secure and portable configuration.

## Prerequisites

- Node.js
- A Plex server to monitor
- A Telegram bot and your chat ID

## Installation

1. Clone this repository or download the files.
2. Install the dependencies listed in `package.json`:
   ```bash
   npm install
   ```

## Configuration

This script uses a `.env` file to load environment variables.

1.  Copy the `.env.example` file and rename it to `.env`.
2.  Modify the `.env` file with your own information:

- `IP_SERVER`: The IP address of your Plex server.
- `TOKEN_TELEGRAM`: Your Telegram bot's authentication token.
- `ID_CHAT`: The ID of the Telegram chat where alerts should be sent.

## Usage

To start monitoring, run the following command:

```bash
node monitor.js
```

The script will automatically load the variables from the `.env` file and start monitoring your server.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
