// Smoke-tests a running BrowserDock container: render endpoint, then a live CDP session.
// Usage: BROWSERDOCK_URL=http://127.0.0.1:3000 BROWSERDOCK_API_KEY=... node scripts/docker-smoke.mjs
import { chromium } from "playwright";

const base = process.env.BROWSERDOCK_URL ?? "http://127.0.0.1:3000";
const key = process.env.BROWSERDOCK_API_KEY;
if (!key) throw new Error("BROWSERDOCK_API_KEY is required");
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("BrowserDock did not become healthy");
}

await waitForHealth();

const blocked = await fetch(`${base}/v1/content`, {
  method: "POST", headers, body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data" }),
});
if (blocked.status !== 403) throw new Error(`Metadata address was not blocked: HTTP ${blocked.status}`);

const created = await fetch(`${base}/v1/sessions`, { method: "POST", headers, body: "{}" });
if (created.status !== 201) throw new Error(`Session create failed: HTTP ${created.status} ${await created.text()}`);
const session = await created.json();

const browser = await chromium.connectOverCDP(session.connectUrl);
const page = await (await browser.newContext()).newPage();
await page.goto("data:text/html,<title>docker smoke</title>");
const title = await page.title();
await browser.close();
if (title !== "docker smoke") throw new Error(`Unexpected title: ${title}`);

const usage = await (await fetch(`${base}/v1/usage`, { headers })).json();
if (usage.totalSessions !== 1) throw new Error(`Unexpected usage: ${JSON.stringify(usage)}`);
console.log("Docker smoke test passed: render policy, live session and usage all work.");
