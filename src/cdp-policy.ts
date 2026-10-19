/**
 * Filters Chrome DevTools Protocol commands that a remote client sends to a session.
 *
 * A remote client gets broad control of its own browser, which is the point of a session.
 * What it must not get is a way to reach the host: local files, the server's network, or
 * a CDP channel that skips this filter. Each command is either passed through, rewritten
 * to a safe equivalent, or answered with an error without reaching the browser.
 */

export interface CdpCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export type PolicyDecision =
  | { action: "forward"; command: CdpCommand }
  | { action: "reject"; message: string };

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:", "about:", "data:", "blob:"]);

/** Commands that are never forwarded. */
const BLOCKED_METHODS = new Map<string, string>([
  ["Target.exposeDevToolsProtocol", "exposes an unfiltered CDP channel to page scripts"],
  ["Target.setRemoteLocations", "connects the browser to other DevTools hosts"],
  ["DOM.setFileInputFiles", "reads files from the server"],
  ["Browser.executeBrowserCommand", "runs browser-level commands"],
]);

/** Whole domains that are never forwarded. */
const BLOCKED_DOMAINS = new Map<string, string>([
  ["Extensions", "loads extensions from the server's disk"],
  ["Tethering", "opens listening ports on the server"],
  ["PWA", "installs apps into the browser profile"],
]);

/** Commands whose `url` parameter is restricted to web schemes. */
const URL_METHODS = new Set([
  "Page.navigate",
  "Target.createTarget",
  "Network.loadNetworkResource",
  "Fetch.continueRequest",
  "Network.continueInterceptedRequest",
]);

function urlAllowed(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  if (value === "") return true;
  try {
    return ALLOWED_URL_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function parseCommand(raw: string): CdpCommand | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (!Number.isInteger(value.id) || typeof value.method !== "string") return undefined;
  if (value.params !== undefined && (typeof value.params !== "object" || value.params === null || Array.isArray(value.params))) {
    return undefined;
  }
  if (value.sessionId !== undefined && typeof value.sessionId !== "string") return undefined;
  return {
    id: value.id as number,
    method: value.method,
    params: value.params as Record<string, unknown> | undefined,
    sessionId: value.sessionId as string | undefined,
  };
}

export function applyPolicy(command: CdpCommand): PolicyDecision {
  const { method } = command;
  const params = command.params ?? {};
  const domain = method.split(".", 1)[0] ?? "";

  const blockedDomain = BLOCKED_DOMAINS.get(domain);
  if (blockedDomain) return { action: "reject", message: `${method} is blocked by BrowserDock: it ${blockedDomain}` };
  const blockedMethod = BLOCKED_METHODS.get(method);
  if (blockedMethod) return { action: "reject", message: `${method} is blocked by BrowserDock: it ${blockedMethod}` };

  if (URL_METHODS.has(method) && !urlAllowed(params.url)) {
    return { action: "reject", message: `${method} only accepts http, https, about, data and blob URLs` };
  }

  if (method === "Target.createBrowserContext" && (params.proxyServer !== undefined || params.proxyBypassList !== undefined)) {
    return { action: "reject", message: "Per-context proxies are not allowed; sessions use BrowserDock's egress policy" };
  }

  if (method === "Input.dispatchDragEvent") {
    const data = params.data as { files?: unknown } | undefined;
    if (Array.isArray(data?.files) && data.files.length > 0) {
      return { action: "reject", message: "Dragging server files into a page is not allowed" };
    }
  }

  if (method === "Page.setDownloadBehavior") {
    return { action: "forward", command: { ...command, params: { behavior: "deny" } } };
  }

  if (method === "Browser.setDownloadBehavior") {
    // Clients such as Playwright set this for every new context. Downloads would write to
    // the server's disk, so the command is kept but downloads are always denied.
    const rewritten: Record<string, unknown> = { behavior: "deny" };
    if (params.browserContextId !== undefined) rewritten.browserContextId = params.browserContextId;
    if (params.eventsEnabled !== undefined) rewritten.eventsEnabled = params.eventsEnabled;
    return { action: "forward", command: { ...command, params: rewritten } };
  }

  return { action: "forward", command };
}
