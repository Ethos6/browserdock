import { randomBytes } from "node:crypto";

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected an integer between ${min} and ${max}`);
  }
  return parsed;
}

export interface Config {
  host: string;
  port: number;
  apiKey: string;
  maxConcurrent: number;
  maxTimeoutMs: number;
  allowPrivateNetworks: boolean;
  logLevel: "silent" | "info";
  /** Maximum live browser sessions at once. 0 disables the sessions API. */
  maxSessions: number;
  sessionTimeoutSeconds: number;
  maxSessionTimeoutSeconds: number;
  /** Public base URL used in session connect URLs, for example https://browsers.example.com. */
  publicUrl?: string;
  chromiumSandbox: boolean;
}

function publicUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("BROWSERDOCK_PUBLIC_URL must be http or https");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const suppliedKey = env.BROWSERDOCK_API_KEY?.trim();
  const apiKey = suppliedKey || randomBytes(32).toString("base64url");
  const maxSessions = integer(env.BROWSERDOCK_MAX_SESSIONS, 3, 0, 256);
  const maxSessionTimeoutSeconds = integer(env.BROWSERDOCK_MAX_SESSION_TIMEOUT_SECONDS, 3600, 5, 86400);
  return {
    host: env.BROWSERDOCK_HOST || "127.0.0.1",
    port: integer(env.BROWSERDOCK_PORT, 3000, 1, 65535),
    apiKey,
    maxConcurrent: integer(env.BROWSERDOCK_MAX_CONCURRENT, 3, 1, 64),
    maxTimeoutMs: integer(env.BROWSERDOCK_MAX_TIMEOUT_MS, 30000, 1000, 120000),
    allowPrivateNetworks: env.BROWSERDOCK_ALLOW_PRIVATE_NETWORKS === "true",
    logLevel: env.BROWSERDOCK_LOG_LEVEL === "silent" ? "silent" : "info",
    maxSessions,
    sessionTimeoutSeconds: integer(env.BROWSERDOCK_SESSION_TIMEOUT_SECONDS, Math.min(900, maxSessionTimeoutSeconds), 5, maxSessionTimeoutSeconds),
    maxSessionTimeoutSeconds,
    publicUrl: publicUrl(env.BROWSERDOCK_PUBLIC_URL),
    chromiumSandbox: env.BROWSERDOCK_CHROMIUM_SANDBOX === "true",
  };
}
