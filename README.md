# BrowserDock

**A self-hosted Chromium automation gateway with secure defaults and an MIT license.**

BrowserDock turns a local headless Chromium browser into a small HTTP service. Send a URL and
get back rendered page content, a screenshot, or a PDF. It is designed for developers who want
the browser on their own machine or server without a hosted account, usage meter, or proprietary
license.

## Why BrowserDock

- **Permissive MIT license.** Use it in personal, open-source, or commercial projects.
- **Safe by default.** It binds to localhost, generates an API key at startup, blocks private and
  link-local network targets, and limits concurrency and request time.
- **Isolated requests.** Every API call gets a fresh browser context; cookies and storage do not
  carry over.
- **Simple interface.** Three documented HTTP endpoints work from curl, Python, or any backend.
- **No arbitrary-code endpoint.** BrowserDock accepts a URL and bounded options; it never runs
  JavaScript supplied in the request body.

BrowserDock is deliberately a small, single-browser gateway. It does not provide Browserless's
Playwright/Puppeteer WebSocket protocol, Firefox/WebKit/Edge, stealth, CAPTCHA solving, persistent
profiles, crawling, or hosted cloud service. It is a better fit when a small, permissively licensed
local service and restrictive defaults matter more than those features.

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

## API

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

All three endpoints accept `timeoutMs` (default 15 seconds, maximum 30 seconds by default) and
`waitUntil` (`domcontentloaded`, `load`, or `networkidle`). The service rejects work above its
concurrency limit with HTTP 429. `GET /v1/capabilities` lists the running API version and routes.

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

Tests launch a local Chromium build and exercise real content, screenshot, and PDF requests against
a local fixture page. No third-party site or API is contacted by the test suite.

## License

BrowserDock is released under the [MIT License](LICENSE).
