import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { publicAddressPolicy, resolveAllowedAddress, type AddressPolicy } from "./security.js";

export const BLOCKED_HEADER = "x-browserdock-blocked";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

/**
 * A loopback-only forward proxy that every browser context uses. It resolves each
 * destination itself, checks the resolved address against the policy, and connects to
 * that exact address. Because the browser makes a new proxy request for every redirect
 * hop, subresource and WebSocket, the policy applies to all of them and DNS rebinding
 * between the check and the connection is not possible.
 */
export class EgressProxy {
  readonly username = "browserdock";
  readonly password = randomBytes(24).toString("base64url");
  private readonly expectedAuth: Buffer;
  private readonly policy: AddressPolicy;
  private readonly sockets = new Set<Socket | Duplex>();
  private server?: Server;
  private serverUrl?: string;

  constructor(policy: AddressPolicy = publicAddressPolicy) {
    this.policy = policy;
    this.expectedAuth = Buffer.from(
      "Basic " + Buffer.from(`${this.username}:${this.password}`).toString("base64"),
    );
  }

  get url(): string {
    if (!this.serverUrl) throw new Error("Egress proxy is not running");
    return this.serverUrl;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.forward(req, res));
    server.on("connect", (req, socket, head) => void this.tunnel(req, socket, head));
    server.on("connection", (socket) => this.track(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    this.serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }

  private track(socket: Socket | Duplex): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers["proxy-authorization"];
    if (typeof header !== "string") return false;
    const candidate = Buffer.from(header);
    return candidate.length === this.expectedAuth.length && timingSafeEqual(candidate, this.expectedAuth);
  }

  private async tunnel(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    this.track(client);
    client.on("error", () => client.destroy());
    if (!this.authorized(req)) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"browserdock\"\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    let target: URL;
    try {
      target = new URL(`http://${req.url ?? ""}`);
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const port = Number(target.port || 443);
    let address: string;
    try {
      address = await resolveAllowedAddress(target.hostname, port, this.policy);
    } catch {
      client.end(`HTTP/1.1 403 Forbidden\r\n${BLOCKED_HEADER}: 1\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const upstream = connect({ host: address, port });
    this.track(upstream);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => {
      if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    });
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  }

  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      res.writeHead(407, { "proxy-authenticate": "Basic realm=\"browserdock\"", "content-length": 0 });
      res.end();
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? "");
      if (target.protocol !== "http:") throw new Error("unsupported");
    } catch {
      res.writeHead(400, { "content-length": 0 });
      res.end();
      return;
    }
    const port = Number(target.port || 80);
    let address: string;
    try {
      address = await resolveAllowedAddress(target.hostname, port, this.policy);
    } catch {
      res.writeHead(403, { [BLOCKED_HEADER]: "1", "content-length": 0 });
      res.end();
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
    }
    headers.host = target.host;
    const upstream = httpRequest({
      host: address,
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (upstreamRes) => {
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name)) responseHeaders[name] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-length": 0 });
      res.end();
    });
    req.pipe(upstream);
  }
}
