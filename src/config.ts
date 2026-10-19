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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const suppliedKey = env.BROWSERDOCK_API_KEY?.trim();
  const apiKey = suppliedKey || randomBytes(32).toString("base64url");
  return {
    host: env.BROWSERDOCK_HOST || "127.0.0.1",
    port: integer(env.BROWSERDOCK_PORT, 3000, 1, 65535),
    apiKey,
    maxConcurrent: integer(env.BROWSERDOCK_MAX_CONCURRENT, 3, 1, 64),
    maxTimeoutMs: integer(env.BROWSERDOCK_MAX_TIMEOUT_MS, 30000, 1000, 120000),
    allowPrivateNetworks: env.BROWSERDOCK_ALLOW_PRIVATE_NETWORKS === "true",
    logLevel: env.BROWSERDOCK_LOG_LEVEL === "silent" ? "silent" : "info",
  };
}
