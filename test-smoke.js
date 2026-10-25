const assert = require("assert");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/`, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ response, body }));
    });
    request.setTimeout(1000, () => request.destroy(new Error("Healthcheck timeout")));
    request.once("error", reject);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function main() {
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, "monitor.js")], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      NODE_ENV: "test",
      CONTAINERIZED: "0",
      ROLE: "BACKUP",
      TELEGRAM_TOKEN: "000000:offline-test-token",
      TELEGRAM_CHAT_ID: "123456789",
      PLEX_IP: "127.0.0.1",
      PLEX_PORT: "1",
      CHECK_INTERVAL: "3600000",
      PORT: String(port),
      QBITTORRENT_HOST: "127.0.0.1",
      QBITTORRENT_PORT: "1",
      QBITTORRENT_USERNAME: "offline-test",
      QBITTORRENT_PASSWORD: "offline-test",
      QBITTORRENT_CATEGORY_MOVIE: "test-movies",
      QBITTORRENT_CATEGORY_SERIES: "test-series",
      QBITTORRENT_CATEGORY_OTHER: "test-other",
      MOVIES_PATH: "/tmp/myplexmonitor-test/movies",
      SERIES_PATH: "/tmp/myplexmonitor-test/series",
      OTHER_PATH: "/tmp/myplexmonitor-test/other",
    },
  });

  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));

  try {
    const deadline = Date.now() + 8000;
    let result;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Application exited early.\n${output}`);
      }
      try {
        result = await getHealth(port);
        break;
      } catch {
        await delay(100);
      }
    }

    assert(result, `Health endpoint did not become ready.\n${output}`);
    assert.strictEqual(result.response.statusCode, 200);
    const health = JSON.parse(result.body);
    assert.strictEqual(health.status, "running");
    assert.strictEqual(health.role, "BACKUP");
    assert.strictEqual(typeof health.failureCount, "number");
    console.log("Smoke test passed: GET / returned a healthy BACKUP response.");
  } finally {
    await stopChild(child);
  }
}

main().catch((error) => {
  console.error(`Smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
