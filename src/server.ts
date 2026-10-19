import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { BrowserGateway } from "./gateway.js";

const config = loadConfig();
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const gateway = new BrowserGateway({
  config,
  launchOptions: executablePath ? { executablePath } : undefined,
  sessionLaunch: executablePath ? { executablePath } : undefined,
});

await gateway.start();
const server = createServer((req, res) => {
  void gateway.handle(req, res);
});

server.on("upgrade", (req, socket, head) => gateway.handleUpgrade(req, socket, head));
server.requestTimeout = config.maxTimeoutMs + 5000;
server.headersTimeout = 10000;
server.listen(config.port, config.host, () => {
  process.stdout.write(`BrowserDock listening on http://${config.host}:${config.port}\n`);
  if (!process.env.BROWSERDOCK_API_KEY) {
    process.stdout.write(`Generated API key (shown once): ${config.apiKey}\n`);
  }
});

async function shutdown(): Promise<void> {
  server.close();
  await gateway.stop();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
