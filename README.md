# BrowserDock

**Self-hosted headless browsers as a service, with secure defaults and an MIT license.**

BrowserDock runs headless Chromium on your own machine or server and offers it two ways:

- **Live sessions.** Create a browser with one API call and drive it remotely from Playwright,
  Puppeteer or any Chrome DevTools Protocol (CDP) client, the same way you would use a hosted
  browser service.
- **One-shot rendering.** Send a URL and get back rendered page content, a screenshot or a PDF.

## Why BrowserDock

- **Permissive MIT license.** Use it in personal, open-source, or commercial projects.
- **Safe by default.** It binds to localhost, generates an API key at startup, and limits concurrent
  browsers, session length and request time.
- **SSRF protection on every hop.** All browser traffic passes through a built-in egress proxy that
  blocks private, loopback, link-local and cloud-metadata addresses, including after redirects and
  for requests made by page scripts.
- **Isolated browsers.** Each live session is its own Chromium process with a throwaway profile, and
  each render request gets a fresh browser context.
- **Usage metering.** Concurrent sessions and browser-hours are tracked and exposed at `/v1/usage`.

BrowserDock is deliberately small. It supports Chromium only and does not do stealth
fingerprinting, CAPTCHA solving, residential proxies, persistent profiles or crawling.

## Quick start with Docker

```bash
git clone https://github.com/Ethos6/browserdock.git
cd browserdock
docker compose up --build
```

The service listens on `127.0.0.1:3000`. The startup logs show a randomly generated API key once.
Copy it for your requests. For a fixed key, set `BROWSERDOCK_API_KEY` in your environment before
starting the container. Keep the API key private.

Check the service:

```bash
curl http://127.0.0.1:3000/healthz
```

The health endpoint is public and returns only status and version.

## Rendering API

Pass the key with `Authorization: Bearer YOUR_KEY` or `X-API-Key: YOUR_KEY`.

### Render page content

```bash
curl http://127.0.0.1:3000/v1/content \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
```

Returns the final URL, page title, rendered text, and rendered HTML. Text and HTML are each
capped at 250,000 characters.

### Take a screenshot

```bash
curl http://127.0.0.1:3000/v1/screenshot \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","fullPage":true}' \
  --output page.png
```

Options: `type` (`png` or `jpeg`), `quality` (1–100 for JPEG), `fullPage`, and `selector`.

### Create a PDF

```bash
curl http://127.0.0.1:3000/v1/pdf \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","format":"A4","printBackground":true}' \
  --output page.pdf
```

Options: `format` (`A4`, `A3`, `A5`, `Letter`, `Legal`, or `Tabloid`), `landscape`, and
`printBackground`.

All three rendering endpoints accept `timeoutMs` (default 15 seconds, maximum 30 seconds by default) and
`waitUntil` (`domcontentloaded`, `load`, or `networkidle`). The service rejects work above its
concurrency limit with HTTP 429. `GET /v1/capabilities` lists the running API version and routes.

## Live browser sessions

A session is a dedicated Chromium process that you control over CDP. Create one, connect with your
automation library, and the session ends when you disconnect (or at its timeout).

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"timeoutSeconds": 600}'
```

```json
{
  "id": "6f1c…",
  "status": "running",
  "keepAlive": false,
  "createdAt": "2026-10-19T12:00:00.000Z",
  "expiresAt": "2026-10-19T12:10:00.000Z",
  "durationMs": 212,
  "connectUrl": "ws://127.0.0.1:3000/v1/sessions/6f1c…/connect?token=…"
}
```

Connect with Playwright:

```js
import { chromium } from "playwright";

const session = await fetch("http://127.0.0.1:3000/v1/sessions", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.BROWSERDOCK_API_KEY}` },
}).then((response) => response.json());

const browser = await chromium.connectOverCDP(session.connectUrl);
const page = await (await browser.newContext()).newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.close(); // ends the session
```

Or Puppeteer: `await puppeteer.connect({ browserWSEndpoint: session.connectUrl })`.

| Request | Purpose |
|---|---|
| `POST /v1/sessions` | Start a session. Options: `timeoutSeconds` (5 to the server maximum) and `keepAlive` (keep running after the client disconnects, until timeout or delete). |
| `GET /v1/sessions` | List running sessions. |
| `GET /v1/sessions/{id}` | Session status, timing and close reason. |
| `DELETE /v1/sessions/{id}` | Stop a session and its browser. |
| `GET /v1/usage` | Active and total sessions and browser-hours since the server started. |

The `connectUrl` contains a per-session token, so treat it like a password. One client can be
connected to a session at a time. Behind a reverse proxy, set `BROWSERDOCK_PUBLIC_URL` so connect
URLs use your public address (`https://` becomes `wss://`).

Sessions give the client full control of its own browser, with a few limits that protect the
server: downloads are denied, and CDP commands that would read server files, load extensions,
open ports, change the browser's proxy or navigate to non-web URLs (`file:`, `chrome:`) are
rejected.

## Run without Docker

Requirements: Node.js 22 or later, npm, and a compatible local Chromium installation.

```bash
npm ci
npx playwright install chromium
npm run build
npm start
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` only if Chromium is installed somewhere other than the
Playwright-managed browser directory:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm start
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BROWSERDOCK_HOST` | `127.0.0.1` | Listen address. Use `0.0.0.0` inside a container only. |
| `BROWSERDOCK_PORT` | `3000` | HTTP port. |
| `BROWSERDOCK_API_KEY` | generated on startup | Fixed API key. If omitted, a random key is printed once to logs. |
| `BROWSERDOCK_MAX_CONCURRENT` | `3` | Maximum simultaneous browser contexts; range 1–64. |
| `BROWSERDOCK_MAX_TIMEOUT_MS` | `30000` | Maximum allowed request timeout; range 1,000–120,000 ms. |
| `BROWSERDOCK_ALLOW_PRIVATE_NETWORKS` | `false` | Development-only opt-in for local targets. Keep disabled in production. |
| `BROWSERDOCK_MAX_SESSIONS` | `3` | Maximum live sessions at once; range 0–256. `0` disables sessions. |
| `BROWSERDOCK_SESSION_TIMEOUT_SECONDS` | `900` | Default session length when a request does not set `timeoutSeconds`. |
| `BROWSERDOCK_MAX_SESSION_TIMEOUT_SECONDS` | `3600` | Longest session a client may request; range 5–86,400. |
| `BROWSERDOCK_PUBLIC_URL` | derived from the request | Public base URL used in session `connectUrl`s. |
| `BROWSERDOCK_CHROMIUM_SANDBOX` | `false` | Run session browsers with Chromium's sandbox. Needs a host or container that supports it. |
| `BROWSERDOCK_LOG_LEVEL` | `info` | Set to `silent` to disable request summaries. URLs and secrets are never logged. |

## Security notes

BrowserDock is a browser runtime: anyone who can call it can make it visit public websites. Keep
it on localhost or a trusted private network. If you expose it remotely, use HTTPS, a strong
secret managed outside source control, firewall rules, and a container/network policy that blocks
private and metadata IP ranges.

All browser traffic goes through a built-in egress proxy that listens only on loopback. The proxy
resolves every destination itself, checks the resolved address, and connects to exactly that
address. Because Chromium makes a fresh proxy request for each redirect hop, subresource, frame and
WebSocket, private, loopback, link-local, reserved and cloud-metadata addresses are blocked at every
step, not only for the first URL, and a DNS answer cannot change between the check and the
connection. BrowserDock also disables service workers and downloads, closes page-created WebSockets,
rejects non-HTTP(S) URLs, and strips proxy environment variables from the browser process. Network
egress rules are still recommended as a second layer.

`BROWSERDOCK_ALLOW_PRIVATE_NETWORKS=true` disables destination IP blocking. Use it only for local
development and never on an exposed service.

## Development

```bash
npm ci
npm run typecheck
npm test
```

Tests launch a local Chromium build and exercise real rendering requests and live sessions (driven
by Playwright over CDP) against local fixture pages, including redirect and CDP-filter attacks. No third-party site or API is contacted by the test suite.

## Self-hosted and hosted

BrowserDock is open core. Everything in this repository, including live sessions, limits and usage
metering, is MIT-licensed and free to run yourself. A hosted BrowserDock service with accounts,
plans and billing is planned as a separate offering on top of it.

If you run BrowserDock as a service for other people, give each customer their own deployment or
put each session in its own container or VM with network egress rules. The built-in limits and CDP
filter protect a single trusted operator's server; they are not a substitute for tenant isolation.

## License

BrowserDock is released under the [MIT License](LICENSE).
