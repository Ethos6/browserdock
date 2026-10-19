import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { Config } from "./config.js";
import { assertSafeUrl, UnsafeTargetError } from "./security.js";

const VERSION = "0.1.0";
const BODY_LIMIT = 64 * 1024;
const TEXT_LIMIT = 250_000;
const WAIT_STATES = new Set(["load", "domcontentloaded", "networkidle"]);
const PDF_FORMATS = new Set(["A4", "Letter", "Legal", "A3", "A5", "Tabloid"]);

export interface BrowserGatewayOptions {
  config: Config;
  browser?: Browser;
  launchOptions?: Parameters<typeof chromium.launch>[0];
}

export class BrowserGateway {
  readonly config: Config;
  private browser?: Browser;
  private readonly injectedBrowser?: Browser;
  private readonly launchOptions?: Parameters<typeof chromium.launch>[0];
  private active = 0;

  constructor(options: BrowserGatewayOptions) {
    this.config = options.config;
    this.browser = options.browser;
    this.injectedBrowser = options.browser;
    this.launchOptions = options.launchOptions;
  }

  async start(): Promise<void> {
    if (!this.browser) {
      const inheritedEnv = this.launchOptions?.env ?? process.env;
      const browserEnv: NodeJS.ProcessEnv = { ...inheritedEnv };
      for (const key of Object.keys(browserEnv)) {
        if (["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].includes(key.toUpperCase())) {
          delete browserEnv[key];
        }
      }
      this.browser = await chromium.launch({ headless: true, ...this.launchOptions, env: browserEnv });
    }
  }

  async stop(): Promise<void> {
    if (this.browser && !this.injectedBrowser) await this.browser.close();
  }

  private authorized(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    const candidate = auth?.startsWith("Bearer ")
      ? auth.slice(7)
      : req.headers["x-api-key"];
    if (typeof candidate !== "string" || candidate.length !== this.config.apiKey.length) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(this.config.apiKey));
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > BODY_LIMIT) throw Object.assign(new Error("Request body is too large"), { status: 413 });
      chunks.push(buffer);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw Object.assign(new Error("Request body must be a JSON object"), { status: 400 });
    }
    return parsed as Record<string, unknown>;
  }

  private timeout(body: Record<string, unknown>): number {
    const value = body.timeoutMs ?? 15000;
    if (!Number.isInteger(value) || Number(value) < 1000 || Number(value) > this.config.maxTimeoutMs) {
      throw Object.assign(new Error(`timeoutMs must be between 1000 and ${this.config.maxTimeoutMs}`), { status: 400 });
    }
    return Number(value);
  }

  private async withPage<T>(body: Record<string, unknown>, work: (page: Page) => Promise<T>): Promise<T> {
    if (this.active >= this.config.maxConcurrent) {
      throw Object.assign(new Error("Browser capacity is full; retry shortly"), { status: 429 });
    }
    if (!this.browser) throw Object.assign(new Error("Browser is starting"), { status: 503 });
    const target = body.url;
    if (typeof target !== "string" || target.length > 4096) {
      throw Object.assign(new Error("url must be a string of at most 4096 characters"), { status: 400 });
    }
    const timeout = this.timeout(body);
    await assertSafeUrl(target, this.config.allowPrivateNetworks);
    const waitUntil = typeof body.waitUntil === "string" && WAIT_STATES.has(body.waitUntil)
      ? body.waitUntil as "load" | "domcontentloaded" | "networkidle"
      : "domcontentloaded";

    this.active += 1;
    let context: BrowserContext | undefined;
    try {
      context = await this.browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
      await context.route("**/*", async (route) => {
        try {
          await assertSafeUrl(route.request().url(), this.config.allowPrivateNetworks);
          await route.continue();
        } catch {
          await route.abort("blockedbyclient").catch(() => undefined);
        }
      });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      page.setDefaultNavigationTimeout(timeout);
      const response = await page.goto(target, { waitUntil, timeout });
      if (!response) throw Object.assign(new Error("Navigation did not return a response"), { status: 502 });
      if (response.status() >= 400) {
        throw Object.assign(new Error(`Target returned HTTP ${response.status()}`), { status: 502 });
      }
      return await work(page);
    } finally {
      await context?.close().catch(() => undefined);
      this.active -= 1;
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const start = Date.now();
    const method = req.method || "GET";
    const path = new URL(req.url || "/", "http://localhost").pathname;
    try {
      if (method === "GET" && path === "/healthz") {
        this.json(res, 200, { status: "ok", version: VERSION });
        return;
      }
      if (!this.authorized(req)) {
        this.json(res, 401, { error: "unauthorized", message: "Provide a valid Bearer token or X-API-Key" });
        return;
      }
      if (method === "GET" && path === "/v1/capabilities") {
        this.json(res, 200, { version: VERSION, browser: "chromium", endpoints: ["/v1/content", "/v1/screenshot", "/v1/pdf"] });
        return;
      }
      if (method !== "POST" || !["/v1/content", "/v1/screenshot", "/v1/pdf"].includes(path)) {
        this.json(res, 404, { error: "not_found" });
        return;
      }
      const body = await this.body(req);
      if (path === "/v1/content") {
        const result = await this.withPage(body, async (page) => {
          const title = await page.title();
          const text = (await page.locator("body").innerText().catch(() => "")).slice(0, TEXT_LIMIT);
          const html = (await page.content()).slice(0, TEXT_LIMIT);
          return { url: page.url(), title, text, html, status: 200 };
        });
        this.json(res, 200, result);
        return;
      }
      if (path === "/v1/screenshot") {
        const result = await this.withPage(body, async (page) => {
          const format = body.type === "jpeg" ? "jpeg" : "png";
          const quality = body.quality;
          if (format === "jpeg" && quality !== undefined && (!Number.isInteger(quality) || Number(quality) < 1 || Number(quality) > 100)) {
            throw Object.assign(new Error("quality must be an integer from 1 to 100"), { status: 400 });
          }
          const options = {
            type: format,
            quality: format === "jpeg" && typeof quality === "number" ? quality : undefined,
            animations: "disabled",
          } as const;
          if (typeof body.selector === "string") {
            const target = page.locator(body.selector);
            await target.waitFor({ state: "visible" });
            return page.screenshot({ ...options, clip: await target.boundingBox() ?? undefined });
          }
          return page.screenshot({ ...options, fullPage: body.fullPage === true });
        });
        res.writeHead(200, {
          "content-type": body.type === "jpeg" ? "image/jpeg" : "image/png",
          "content-length": result.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(result);
        return;
      }
      const result = await this.withPage(body, async (page) => {
        const format = typeof body.format === "string" && PDF_FORMATS.has(body.format) ? body.format : "A4";
        return page.pdf({
          format: format as "A4" | "Letter" | "Legal" | "A3" | "A5" | "Tabloid",
          landscape: body.landscape === true,
          printBackground: body.printBackground !== false,
        });
      });
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": result.length,
        "content-disposition": "attachment; filename=\"browserdock.pdf\"",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(result);
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status: unknown }).status)
        : error instanceof UnsafeTargetError ? 403 : 502;
      const message = error instanceof UnsafeTargetError
        ? error.message
        : status < 500 && error instanceof Error ? error.message : "Browser request failed";
      if (!res.headersSent) this.json(res, status, { error: status === 429 ? "busy" : "request_failed", message });
    } finally {
      if (this.config.logLevel === "info") {
        process.stdout.write(JSON.stringify({ method, path, status: res.statusCode, durationMs: Date.now() - start }) + "\n");
      }
    }
  }
}
