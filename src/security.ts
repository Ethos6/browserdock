import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

export class UnsafeTargetError extends Error {
  constructor(message = "Target is blocked by the network policy") {
    super(message);
    this.name = "UnsafeTargetError";
  }
}

/** Decides whether the browser may connect to a resolved address and port. */
export type AddressPolicy = (address: string, port: number) => boolean;

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      return (parsed as ipaddr.IPv6).toIPv4Address().range() === "unicast";
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export const publicAddressPolicy: AddressPolicy = (address) => isPublicAddress(address);

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/**
 * Resolves a hostname and returns one address the policy allows. Every resolved
 * address must be allowed, so a name that mixes public and private records is rejected.
 * Callers should connect to the returned address, not re-resolve the name.
 */
export async function resolveAllowedAddress(
  rawHostname: string,
  port: number,
  policy: AddressPolicy = publicAddressPolicy,
): Promise<string> {
  const hostname = stripBrackets(rawHostname);
  if (policy === publicAddressPolicy
    && (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local"))) {
    throw new UnsafeTargetError();
  }
  if (ipaddr.isValid(hostname)) {
    if (!policy(hostname, port)) throw new UnsafeTargetError();
    return hostname;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UnsafeTargetError("Target hostname could not be resolved");
  }
  const first = addresses[0];
  if (!first || addresses.some(({ address }) => !policy(address, port))) {
    throw new UnsafeTargetError();
  }
  return first.address;
}

export function defaultPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

export async function assertSafeUrl(
  raw: string,
  allowPrivateNetworks = false,
  policy: AddressPolicy = publicAddressPolicy,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeTargetError("A valid absolute URL is required");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeTargetError("Only HTTP and HTTPS targets are allowed");
  }
  if (url.username || url.password) {
    throw new UnsafeTargetError("Credentials in target URLs are not allowed");
  }
  if (allowPrivateNetworks) return url;

  await resolveAllowedAddress(url.hostname, defaultPort(url), policy);
  return url;
}
