import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import sparticuzChromium from "@sparticuz/chromium";
import { chromium, type Browser } from "playwright";
import { loadConfig } from "../src/config.js";
import { BrowserGateway } from "../src/gateway.js";
import { assertSafeUrl, type AddressPolicy } from "../src/security.js";

let browser: Browser;
let pageServer: Server;
let gatewayServer: Server;
let baseUrl: string;
let gatewayUrl: string;
let secretServer: Server;
let secretUrl: string;
let secretHits = 0;
let strictGateway: BrowserGateway;
let strictServer: Server;
let strictUrl: string;
const apiKey = "test-key-which-is-long-enough";

before(async () => {
  const executablePath = await sparticuzChromium.executablePath();
  browser = await chromium.launch({
    args: sparticuzChromium.args.filter((arg) => arg !== "--single-process" && arg !== "--no-zygote"),
    executablePath,
    headless: true,
  });

  secretServer = createServer((_req, res) => {
    secretHits += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("internal-secret");
  });
  await new Promise<void>((resolve) => secretServer.listen(0, "127.0.0.1", resolve));
  secretUrl = `http://127.0.0.1:${(secretServer.address() as AddressInfo).port}/latest/meta-data`;

  pageServer = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: secretUrl });
      res.end();
      return;
    }
    if (req.url === "/embeds-secret") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>embed</title><img src="${secretUrl}"><iframe src="/redirect"></iframe>`);
      return;
    }
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

  // A gateway with the network policy enforced. The page fixture stands in for a public
  // website; every other address, including the "secret" internal service, is blocked.
  const allowedPort = pagePort;
  const policy: AddressPolicy = (address, port) => address === "127.0.0.1" && port === allowedPort;
  strictGateway = new BrowserGateway({
    config: loadConfig({ BROWSERDOCK_API_KEY: apiKey, BROWSERDOCK_LOG_LEVEL: "silent" }),
    browser,
    addressPolicy: policy,
  });
  await strictGateway.start();
  strictServer = createServer((req, res) => void strictGateway.handle(req, res));
  await new Promise<void>((resolve) => strictServer.listen(0, "127.0.0.1", resolve));
  strictUrl = `http://127.0.0.1:${(strictServer.address() as AddressInfo).port}`;
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => pageServer?.close(() => resolve()));
  await new Promise<void>((resolve) => gatewayServer?.close(() => resolve()));
  await new Promise<void>((resolve) => strictServer?.close(() => resolve()));
  await new Promise<void>((resolve) => secretServer?.close(() => resolve()));
  await strictGateway?.stop();
});

async function call(path: string, body?: object, auth = true, base = gatewayUrl): Promise<Response> {
  return fetch(`${base}${path}`, {
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
  assert.deepEqual(await response.json(), { status: "ok", version: "0.1.1" });
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

test("policy-enforced gateway renders allowed targets through the egress proxy", async () => {
  const response = await call("/v1/content", { url: baseUrl }, true, strictUrl);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json() as { title: string };
  assert.equal(result.title, "BrowserDock local smoke");
});

test("blocks redirects to internal addresses without contacting them", async () => {
  const before = secretHits;
  const response = await call("/v1/content", { url: `${baseUrl}/redirect` }, true, strictUrl);
  assert.equal(response.status, 403, await response.clone().text());
  assert.doesNotMatch(await response.text(), /internal-secret/);
  assert.equal(secretHits, before);
});

test("blocks subresources and framed redirects to internal addresses", async () => {
  const before = secretHits;
  const response = await call("/v1/content", { url: `${baseUrl}/embeds-secret`, waitUntil: "load" }, true, strictUrl);
  assert.equal(response.status, 200, await response.clone().text());
  assert.doesNotMatch(await response.text(), /internal-secret/);
  assert.equal(secretHits, before);
});

test("blocks direct requests to internal addresses", async () => {
  const response = await call("/v1/content", { url: secretUrl }, true, strictUrl);
  assert.equal(response.status, 403);
});

test("concurrency limit holds when requests arrive together", async () => {
  const responses = await Promise.all(Array.from({ length: 6 }, () => call("/v1/content", { url: baseUrl })));
  const ok = responses.filter((response) => response.status === 200).length;
  const busy = responses.filter((response) => response.status === 429).length;
  assert.ok(ok >= 1 && ok <= 2, `expected at most 2 concurrent successes, got ${ok}`);
  assert.equal(ok + busy, 6);
});

test("non-ASCII API keys are rejected with 401", async () => {
  const response = await fetch(`${gatewayUrl}/v1/capabilities`, { headers: { "x-api-key": "\u00e9".repeat(apiKey.length) } });
  assert.equal(response.status, 401);
});
