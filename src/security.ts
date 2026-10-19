import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

export class UnsafeTargetError extends Error {
  constructor(message = "Target is blocked by the network policy") {
    super(message);
    this.name = "UnsafeTargetError";
  }
}

function isPublicAddress(address: string): boolean {
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

export async function assertSafeUrl(raw: string, allowPrivateNetworks = false): Promise<URL> {
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

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new UnsafeTargetError();
  }

  if (ipaddr.isValid(hostname)) {
    if (!isPublicAddress(hostname)) throw new UnsafeTargetError();
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UnsafeTargetError("Target hostname could not be resolved");
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new UnsafeTargetError();
  }
  return url;
}
