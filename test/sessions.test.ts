import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import sparticuzChromium from "@sparticuz/chromium";
import { chromium } from "playwright";
import WebSocket from "ws";
import { applyPolicy } from "../src/cdp-policy.js";
import { loadConfig } from "../src/config.js";
import { BrowserGateway } from "../src/gateway.js";
import type { AddressPolicy } from "../src/security.js";

const apiKey = "session-test-key-which-is-long-enough";
const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
let executablePath: string;
let siteServer: Server;
let siteUrl: string;
let secretServer: Server;
let secretUrl: string;
let secretHits = 0;
const running: Array<{ gateway: BrowserGateway; server: Server }> = [];

interface SessionResponse {
  id: string;
  status: string;
  connectUrl: string;
  closeReason?: string;
  keepAlive: boolean;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function startGateway(env: Record<string, string>, addressPolicy?: AddressPolicy): Promise<string> {
  const gateway = new BrowserGateway({
    config: loadConfig({ BROWSERDOCK_API_KEY: apiKey, BROWSERDOCK_LOG_LEVEL: "silent", ...env }),
    addressPolicy,
    sessionLaunch: { executablePath, args: ["--headless=shell"] },
  });
  const server = createServer((req, res) => void gateway.handle(req, res));
  server.on("upgrade", (req, socket, head) => gateway.handleUpgrade(req, socket, head));
  running.push({ gateway, server });
  return `http://127.0.0.1:${await listen(server)}`;
}

async function createSession(base: string, body: object = {}): Promise<Response> {
  return fetch(`${base}/v1/sessions`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function getSession(base: string, id: string): Promise<SessionResponse> {
  return await (await fetch(`${base}/v1/sessions/${id}`, { headers })).json() as SessionResponse;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Condition was not met in time");
}

/** Sends raw CDP commands over a session's WebSocket and collects the replies by id. */
async function rawCdp(connectUrl: string, commands: object[]): Promise<Map<number, Record<string, unknown>>> {
  const ws = new WebSocket(connectUrl);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const replies = new Map<number, Record<string, unknown>>();
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    if (typeof message.id === "number") replies.set(message.id, message);
  });
  for (const command of commands) ws.send(JSON.stringify(command));
  await waitFor(async () => replies.size === commands.length);
  ws.close();
  return replies;
}

before(async () => {
  executablePath = await sparticuzChromium.executablePath();
  secretServer = createServer((_req, res) => {
    secretHits += 1;
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
    res.end("internal-secret");
  });
  secretUrl = `http://127.0.0.1:${await listen(secretServer)}/latest/meta-data`;
  siteServer = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: secretUrl });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>BrowserDock session fixture</title><main>Hello from a live session</main>");
  });
  siteUrl = `http://127.0.0.1:${await listen(siteServer)}`;
});

after(async () => {
  for (const { gateway, server } of running) {
    await gateway.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await new Promise<void>((resolve) => siteServer.close(() => resolve()));
  await new Promise<void>((resolve) => secretServer.close(() => resolve()));
});

test("Playwright drives a live session over CDP, and disconnecting ends it", async () => {
  const base = await startGateway({ BROWSERDOCK_ALLOW_PRIVATE_NETWORKS: "true" });
  const response = await createSession(base);
  assert.equal(response.status, 201, await response.clone().text());
  const session = await response.json() as SessionResponse;
  assert.equal(session.status, "running");
  assert.match(session.connectUrl, /^ws:\/\/127\.0\.0\.1:\d+\/v1\/sessions\/[0-9a-f-]{36}\/connect\?token=/);

  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(siteUrl);
  assert.equal(await page.title(), "BrowserDock session fixture");
  assert.equal((await page.screenshot()).subarray(1, 4).toString(), "PNG");

  const listed = await (await fetch(`${base}/v1/sessions`, { headers })).json() as { sessions: SessionResponse[] };
  assert.deepEqual(listed.sessions.map((item) => item.id), [session.id]);

  await browser.close();
  await waitFor(async () => (await getSession(base, session.id)).status === "closed");
  assert.equal((await getSession(base, session.id)).closeReason, "client_disconnected");
  const usage = await (await fetch(`${base}/v1/usage`, { headers })).json() as Record<string, number>;
  assert.equal(usage.totalSessions, 1);
  assert.equal(usage.activeSessions, 0);
});

test("sessions require the API key and the session token", async () => {
  const base = await startGateway({ BROWSERDOCK_ALLOW_PRIVATE_NETWORKS: "true" });
  const unauthenticated = await fetch(`${base}/v1/sessions`, { method: "POST" });
  assert.equal(unauthenticated.status, 401);

  const session = await (await createSession(base)).json() as SessionResponse;
  const forged = session.connectUrl.replace(/token=[^&]+/, "token=wrong");
  await assert.rejects(() => chromium.connectOverCDP(forged, { timeout: 5000 }));
  await fetch(`${base}/v1/sessions/${session.id}`, { method: "DELETE", headers });
});

test("the concurrent session limit is enforced and freed on delete", async () => {
  const base = await startGateway({ BROWSERDOCK_ALLOW_PRIVATE_NETWORKS: "true", BROWSERDOCK_MAX_SESSIONS: "1" });
  const first = await (await createSession(base)).json() as SessionResponse;
  assert.equal((await createSession(base)).status, 429);
  const deleted = await fetch(`${base}/v1/sessions/${first.id}`, { method: "DELETE", headers });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json() as SessionResponse).status, "closed");
  const third = await createSession(base);
  assert.equal(third.status, 201);
  await fetch(`${base}/v1/sessions/${(await third.json() as SessionResponse).id}`, { method: "DELETE", headers });
});

test("keepAlive sessions survive disconnects and close at their timeout", async () => {
  const base = await startGateway({ BROWSERDOCK_ALLOW_PRIVATE_NETWORKS: "true" });
  const session = await (await createSession(base, { keepAlive: true, timeoutSeconds: 5 })).json() as SessionResponse;
  const browser = await chromium.connectOverCDP(session.connectUrl);
  await browser.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await getSession(base, session.id)).status, "running");
  await waitFor(async () => (await getSession(base, session.id)).status === "closed", 10_000);
  assert.equal((await getSession(base, session.id)).closeReason, "timeout");
});

test("the CDP filter blocks commands that reach the server", async () => {
  const base = await startGateway({ BROWSERDOCK_ALLOW_PRIVATE_NETWORKS: "true" });
  const session = await (await createSession(base)).json() as SessionResponse;
  const replies = await rawCdp(session.connectUrl, [
    { id: 1, method: "Target.createTarget", params: { url: "file:///etc/passwd" } },
    { id: 2, method: "Target.exposeDevToolsProtocol", params: { targetId: "x" } },
    { id: 3, method: "Target.createBrowserContext", params: { proxyServer: "direct://" } },
    { id: 4, method: "DOM.setFileInputFiles", params: { files: ["/etc/passwd"] } },
    { id: 5, method: "Extensions.loadUnpacked", params: { path: "/tmp" } },
    { id: 6, method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: "/tmp" } },
    { id: 7, method: "Browser.getVersion" },
  ]);
  for (const id of [1, 2, 3, 4, 5]) {
    assert.ok(replies.get(id)?.error, `command ${id} should be rejected`);
  }
  assert.ok(replies.get(6)?.result, "download behaviour is rewritten to deny, not rejected");
  assert.ok(replies.get(7)?.result, "ordinary commands pass through");
});

test("pages in a session cannot navigate to local files", async () => {
  const base = await startGateway({ BROWSERDOCK_ALLOW_PRIVATE_NETWORKS: "true" });
  const session = await (await createSession(base)).json() as SessionResponse;
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const page = await (await browser.newContext()).newPage();
  await page.goto(siteUrl);
  await page.evaluate(() => { location.href = "file:///etc/hostname"; }).catch(() => undefined);
  await page.waitForTimeout(500);
  assert.ok(page.url().startsWith("http://"), `page navigated to ${page.url()}`);
  await browser.close();
});

test("session traffic goes through the egress policy, including redirects and fetch()", async () => {
  const sitePort = Number(new URL(siteUrl).port);
  const policy: AddressPolicy = (address, port) => address === "127.0.0.1" && port === sitePort;
  const base = await startGateway({}, policy);
  const session = await (await createSession(base)).json() as SessionResponse;
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const page = await (await browser.newContext()).newPage();
  const before = secretHits;

  await page.goto(siteUrl);
  assert.equal(await page.title(), "BrowserDock session fixture");

  await page.goto(`${siteUrl}/redirect`).catch(() => undefined);
  assert.doesNotMatch(await page.content(), /internal-secret/);

  await page.goto(siteUrl);
  const fetched = await page.evaluate(async (url) => {
    try {
      return await (await fetch(url)).text();
    } catch {
      return "blocked";
    }
  }, secretUrl);
  assert.notEqual(fetched, "internal-secret");
  assert.equal(secretHits, before);
  await browser.close();
});

test("CDP policy unit checks", () => {
  assert.equal(applyPolicy({ id: 1, method: "Page.navigate", params: { url: "https://example.com" } }).action, "forward");
  assert.equal(applyPolicy({ id: 1, method: "Page.navigate", params: { url: "chrome://settings" } }).action, "reject");
  assert.equal(applyPolicy({ id: 1, method: "Network.loadNetworkResource", params: { url: "file:///etc/passwd" } }).action, "reject");
  assert.equal(applyPolicy({ id: 1, method: "Tethering.bind", params: { port: 9222 } }).action, "reject");
  assert.equal(applyPolicy({ id: 1, method: "Input.dispatchDragEvent", params: { data: { files: ["/etc/passwd"] } } }).action, "reject");
  const rewritten = applyPolicy({ id: 1, method: "Page.setDownloadBehavior", params: { behavior: "allow", downloadPath: "/" } });
  assert.deepEqual(rewritten.action === "forward" && rewritten.command.params, { behavior: "deny" });
});
