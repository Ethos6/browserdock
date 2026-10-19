# Security policy

## Safe defaults

- The server binds to `127.0.0.1` by default.
- A cryptographically random API key is generated if `BROWSERDOCK_API_KEY` is not set.
- Browser routes require an API key; only `/healthz` is public.
- Each request gets a new browser context, with downloads and service workers disabled.
- Navigation and subresource requests are limited to HTTP(S). Local, private, link-local,
  loopback, and reserved IP ranges are blocked unless explicitly enabled for development.
- Every connection the browser makes, including each redirect hop, passes through a loopback-only
  egress proxy that checks the resolved IP address and connects to that exact address.
- WebSocket connections opened by pages are closed.
- Browser concurrency, request size, and navigation time are bounded.

## Deployment guidance

Keep the service behind a trusted network boundary. Do not expose it directly to the public
internet without TLS, network egress controls, and an API key managed by a secret store. The
egress proxy blocks SSRF through redirects and DNS rebinding, but it is not a substitute for
firewall or container network policy.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not publish
unpatched security issues in a public issue.
