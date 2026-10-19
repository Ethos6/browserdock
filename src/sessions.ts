import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex, Readable, Writable } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { applyPolicy, parseCommand } from "./cdp-policy.js";
import type { Config } from "./config.js";
import { EgressProxy } from "./egress-proxy.js";
import type { AddressPolicy } from "./security.js";

export type SessionStatus = "starting" | "running" | "closed";
export type CloseReason = "requested" | "timeout" | "client_disconnected" | "browser_exited" | "shutdown" | "start_failed";

export interface SessionLaunchOptions {
  /** Chromium executable. Defaults to Playwright's bundled Chromium. */
  executablePath?: string;
  /** Extra Chromium flags. Include a --headless flag here to override the default mode. */
  args?: string[];
}

export interface SessionView {
  id: string;
  status: SessionStatus;
  keepAlive: boolean;
  createdAt: string;
  expiresAt: string;
  closedAt?: string;
  closeReason?: CloseReason;
  durationMs: number;
  connectUrl?: string;
}

/** Environment variables Chromium may inherit. Everything else, including secrets, is dropped. */
const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TZ", "FONTCONFIG_PATH", "FONTCONFIG_FILE", "LD_LIBRARY_PATH", "XDG_RUNTIME_DIR"];
const START_TIMEOUT_MS = 30_000;
const MAX_CLIENT_MESSAGE = 32 * 1024 * 1024;
const STARTUP_COMMAND_ID = 1;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

class BrowserSession {
  readonly id = randomUUID();
  readonly token = randomBytes(32).toString("base64url");
  readonly createdAt = Date.now();
  readonly expiresAt: number;
  status: SessionStatus = "starting";
  closedAt?: number;
  closeReason?: CloseReason;

  private process?: ChildProcess;
  private toBrowser?: Writable;
  private proxy?: EgressProxy;
  private userDataDir?: string;
  private client?: WebSocket;
  private timer?: NodeJS.Timeout;
  private stderrTail = "";
  private readonly pending: Buffer[] = [];
  private startup?: { resolve: () => void; reject: (error: Error) => void };

  constructor(
    readonly keepAlive: boolean,
    timeoutSeconds: number,
    private readonly onClosed: (session: BrowserSession) => void,
  ) {
    this.expiresAt = this.createdAt + timeoutSeconds * 1000;
  }

  get durationMs(): number {
    return (this.closedAt ?? Date.now()) - this.createdAt;
  }

  async start(launch: Required<SessionLaunchOptions>, sandbox: boolean, policy: AddressPolicy | undefined): Promise<void> {
    this.userDataDir = await mkdtemp(join(tmpdir(), "browserdock-session-"));
    const args = [
      "--remote-debugging-pipe",
      `--user-data-dir=${this.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--password-store=basic",
      "--use-mock-keychain",
      "--window-size=1280,720",
      // Keep WebRTC on the proxy so UDP cannot reach internal hosts.
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ];
    if (policy) {
      this.proxy = new EgressProxy(policy, { requireAuth: false });
      await this.proxy.start();
      args.push(`--proxy-server=${this.proxy.url}`, "--proxy-bypass-list=<-loopback>");
    }
    if (!sandbox) args.push("--no-sandbox");
    if (!launch.args.some((arg) => arg.startsWith("--headless"))) args.push("--headless");
    args.push(...launch.args, "about:blank");

    const env: NodeJS.ProcessEnv = { HOME: this.userDataDir };
    for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];

    const child = spawn(launch.executablePath, args, {
      env,
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    });
    this.process = child;
    this.toBrowser = child.stdio[3] as Writable;
    const fromBrowser = child.stdio[4] as Readable;
    this.toBrowser.on("error", () => undefined);
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    fromBrowser.on("data", (chunk: Buffer) => this.receive(chunk));
    child.once("exit", () => {
      const lastLines = this.stderrTail.trim().split("\n").slice(-3).join(" | ");
      this.startup?.reject(new Error(`Chromium exited during startup (code ${child.exitCode ?? child.signalCode}): ${lastLines}`));
      void this.close("browser_exited");
    });
    child.once("error", (error) => {
      this.startup?.reject(error);
      void this.close("start_failed");
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Chromium did not start in time")), START_TIMEOUT_MS);
      this.startup = {
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      };
      this.write(JSON.stringify({ id: STARTUP_COMMAND_ID, method: "Browser.getVersion" }));
    });
    this.startup = undefined;
    this.status = "running";
    this.timer = setTimeout(() => void this.close("timeout"), Math.max(0, this.expiresAt - Date.now()));
    this.timer.unref();
  }

  private write(message: string): void {
    if (!this.toBrowser || this.toBrowser.destroyed) return;
    this.toBrowser.write(message);
    this.toBrowser.write("\0");
  }

  private receive(chunk: Buffer): void {
    let start = 0;
    let end = chunk.indexOf(0, start);
    while (end !== -1) {
      this.pending.push(chunk.subarray(start, end));
      const message = Buffer.concat(this.pending).toString("utf8");
      this.pending.length = 0;
      this.deliver(message);
      start = end + 1;
      end = chunk.indexOf(0, start);
    }
    if (start < chunk.length) this.pending.push(chunk.subarray(start));
  }

  private deliver(message: string): void {
    if (this.startup) {
      this.startup.resolve();
      return;
    }
    if (this.client?.readyState === 1) this.client.send(message);
  }

  attach(ws: WebSocket): void {
    if (this.status !== "running" || this.client) {
      ws.close(1008, this.client ? "Session already has a connected client" : "Session is not running");
      return;
    }
    this.client = ws;
    ws.on("message", (data: RawData, isBinary: boolean) => {
      const text = isBinary ? Buffer.from(data as Buffer).toString("utf8") : data.toString();
      const command = parseCommand(text);
      if (!command) {
        ws.close(1007, "Expected a CDP command with an integer id and a method");
        return;
      }
      const decision = applyPolicy(command);
      if (decision.action === "reject") {
        ws.send(JSON.stringify({
          id: command.id,
          ...(command.sessionId ? { sessionId: command.sessionId } : {}),
          error: { code: -32000, message: decision.message },
        }));
        return;
      }
      this.write(JSON.stringify(decision.command));
    });
    ws.on("close", () => {
      if (this.client === ws) this.client = undefined;
      if (!this.keepAlive) void this.close("client_disconnected");
    });
    ws.on("error", () => ws.terminate());
  }

  tokenMatches(candidate: string): boolean {
    const supplied = Buffer.from(candidate);
    const expected = Buffer.from(this.token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  async close(reason: CloseReason): Promise<void> {
    if (this.status === "closed") return;
    this.status = "closed";
    this.closedAt = Date.now();
    this.closeReason = reason;
    if (this.timer) clearTimeout(this.timer);
    this.client?.close(1000, `Session closed: ${reason}`);
    this.client = undefined;
    const child = this.process;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(killTimer);
    }
    await this.proxy?.stop();
    if (this.userDataDir) await rm(this.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    this.onClosed(this);
  }

  view(baseUrl?: string): SessionView {
    return {
      id: this.id,
      status: this.status,
      keepAlive: this.keepAlive,
      createdAt: new Date(this.createdAt).toISOString(),
      expiresAt: new Date(this.expiresAt).toISOString(),
      ...(this.closedAt ? { closedAt: new Date(this.closedAt).toISOString(), closeReason: this.closeReason } : {}),
      durationMs: this.durationMs,
      ...(baseUrl && this.status !== "closed"
        ? { connectUrl: `${baseUrl}/v1/sessions/${this.id}/connect?token=${this.token}` }
        : {}),
    };
  }
}

export interface SessionManagerOptions {
  config: Config;
  launch?: SessionLaunchOptions;
  /** Address policy for session traffic; undefined disables the egress proxy. */
  addressPolicy?: AddressPolicy;
  resolveExecutable: () => string;
}

export class SessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly recent: BrowserSession[] = [];
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE });
  private readonly startedAt = Date.now();
  private totalSessions = 0;
  private closedBrowserMs = 0;

  constructor(private readonly options: SessionManagerOptions) {}

  private get config(): Config {
    return this.options.config;
  }

  async create(input: Record<string, unknown>): Promise<BrowserSession> {
    if (this.config.maxSessions === 0) throw new HttpError(404, "Sessions are disabled on this server");
    const keepAlive = input.keepAlive === true;
    const timeoutSeconds = input.timeoutSeconds ?? this.config.sessionTimeoutSeconds;
    if (!Number.isInteger(timeoutSeconds) || Number(timeoutSeconds) < 5 || Number(timeoutSeconds) > this.config.maxSessionTimeoutSeconds) {
      throw new HttpError(400, `timeoutSeconds must be an integer from 5 to ${this.config.maxSessionTimeoutSeconds}`);
    }
    if (this.sessions.size >= this.config.maxSessions) {
      throw new HttpError(429, `All ${this.config.maxSessions} browser sessions are in use; close one or retry later`);
    }
    const session = new BrowserSession(keepAlive, Number(timeoutSeconds), (closed) => this.closed(closed));
    this.sessions.set(session.id, session);
    this.totalSessions += 1;
    try {
      await session.start(
        {
          executablePath: this.options.launch?.executablePath ?? this.options.resolveExecutable(),
          args: this.options.launch?.args ?? [],
        },
        this.config.chromiumSandbox,
        this.config.allowPrivateNetworks ? undefined : this.options.addressPolicy,
      );
    } catch (error) {
      await session.close("start_failed");
      throw new HttpError(503, `Browser session failed to start: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    return session;
  }

  private closed(session: BrowserSession): void {
    if (!this.sessions.delete(session.id)) return;
    this.closedBrowserMs += session.durationMs;
    this.recent.unshift(session);
    this.recent.length = Math.min(this.recent.length, 50);
  }

  get(id: string): BrowserSession | undefined {
    return this.sessions.get(id) ?? this.recent.find((session) => session.id === id);
  }

  /** Sessions that have not closed. A closing session keeps its slot until cleanup finishes. */
  list(): BrowserSession[] {
    return [...this.sessions.values()].filter((session) => session.status !== "closed");
  }

  usage(): Record<string, unknown> {
    const activeMs = this.list().reduce((sum, session) => sum + session.durationMs, 0);
    const browserSeconds = Math.round((this.closedBrowserMs + activeMs) / 1000);
    return {
      since: new Date(this.startedAt).toISOString(),
      activeSessions: this.list().length,
      maxSessions: this.config.maxSessions,
      totalSessions: this.totalSessions,
      browserSeconds,
      browserHours: Math.round((browserSeconds / 3600) * 1000) / 1000,
    };
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.close("shutdown")));
    this.wss.close();
  }

  /** Handles `GET /v1/sessions/:id/connect?token=...` WebSocket upgrades. Returns false for other paths. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url || "/", "http://localhost");
    const match = /^\/v1\/sessions\/([0-9a-f-]{36})\/connect$/.exec(url.pathname);
    if (!match) return false;
    const session = this.sessions.get(match[1] ?? "");
    const token = url.searchParams.get("token") ?? "";
    if (!session || !session.tokenMatches(token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => session.attach(ws));
    return true;
  }
}

export { BrowserSession, HttpError };
