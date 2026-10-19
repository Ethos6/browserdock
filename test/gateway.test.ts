import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import sparticuzChromium from "@sparticuz/chromium";
import { chromium, type Browser } from "playwright";
import { loadConfig } from "../src/config.js";
import { BrowserGateway } from "../src/gateway.js";
import { assertSafeUrl } from "../src/security.js";

let browser: Browser;
let pageServer: Server;
let gatewayServer: Server;
let baseUrl: string;
let gatewayUrl: string;
const apiKey = "test-key-which-is-long-enough";

before(async () => {
  const executablePath = await sparticuzChromium.executablePath();
  browser = await chromium.launch({
    args: sparticuzChromium.args.filter((arg) => arg !== "--single-process" && arg !== "--no-zygote"),
    executablePath,
    headless: true,
  });

  pageServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>BrowserDock local smoke</title><main id='content'>Rendered locally</main>");
  });
  await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
  const pagePort = (pageServer.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${pagePort}`;

  const config = loadConfig({
    BROWSERDOCK_API_KEY: apiKey,
    BROWSERDOCK_HOST: "127.0.0.1",
    BROWSERDOCK_MAX_CONCURRENT: "2",
    BROWSERDOCK_ALLOW_PRIVATE_NETWORKS: "true",
    BROWSERDOCK_LOG_LEVEL: "silent",
  });
  const gateway = new BrowserGateway({ config, browser });
  gatewayServer = createServer((req, res) => void gateway.handle(req, res));
  await new Promise<void>((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));
  const gatewayPort = (gatewayServer.address() as AddressInfo).port;
  gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => pageServer?.close(() => resolve()));
  await new Promise<void>((resolve) => gatewayServer?.close(() => resolve()));
});

async function call(path: string, body?: object, auth = true): Promise<Response> {
  return fetch(`${gatewayUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(auth ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("health is public and does not expose the browser key", async () => {
  const response = await call("/healthz", undefined, false);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", version: "0.1.0" });
});

test("automation routes require authentication", async () => {
  const response = await call("/v1/capabilities", undefined, false);
  assert.equal(response.status, 401);
});

test("content endpoint returns rendered title, text, and URL", async () => {
  const response = await call("/v1/content", { url: baseUrl });
  assert.equal(response.status, 200);
  const result = await response.json() as { title: string; text: string; url: string; html: string };
  assert.equal(result.title, "BrowserDock local smoke");
  assert.match(result.text, /Rendered locally/);
  assert.match(result.html, /<main/);
  assert.equal(result.url, `${baseUrl}/`);
});

test("screenshot and PDF endpoints return the expected binary formats", async () => {
  const image = await call("/v1/screenshot", { url: baseUrl });
  assert.equal(image.status, 200, await image.clone().text());
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const pdf = await call("/v1/pdf", { url: baseUrl, format: "A4" });
  assert.equal(pdf.status, 200, await pdf.clone().text());
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
});

test("rejects loopback, link-local, and non-HTTP targets by default", async () => {
  for (const target of ["http://127.0.0.1", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd"]) {
    await assert.rejects(() => assertSafeUrl(target), { name: "UnsafeTargetError" });
  }
});

test("rejects malformed request bodies", async () => {
  const response = await fetch(`${gatewayUrl}/v1/content`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: "not-json",
  });
  assert.equal(response.status, 400);
});
