import "server-only";

import { isIP } from "node:net";
import { SecurityError } from "./errors.ts";

const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data.ec2.internal",
]);

export type UrlPolicyOptions = {
  environment: "development" | "preview" | "production";
  nodeEnv?: string;
  allowDevLocalHttp?: boolean;
  allowedHosts?: readonly string[];
  allowedPorts?: readonly number[];
};

export type ValidatedProviderUrl = {
  url: URL;
  sanitizedHost: string;
  allowDevPrivateAddresses: boolean;
};

function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function normalizeHostname(hostname: string): string {
  return unbracket(hostname).toLowerCase().replace(/\.+$/, "");
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".test") ||
    hostname === "host.docker.internal";
}

function isLocalHostAddress(hostname: string): boolean {
  const version = isIP(hostname);
  if (version === 4) {
    const [a, b] = hostname.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  if (version !== 6) return false;
  const parts = parseIPv6(hostname);
  return parts !== null && (
    parts.slice(0, 15).every((byte) => byte === 0) && parts[15] === 1 ||
    (parts[0] & 0xfe) === 0xfc
  );
}

export function validateProviderUrl(
  rawUrl: string,
  options: UrlPolicyOptions,
): ValidatedProviderUrl {
  if (typeof rawUrl !== "string" || rawUrl.length > 2_048) {
    throw new SecurityError("URL_REJECTED");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SecurityError("URL_REJECTED");
  }

  const hostname = normalizeHostname(url.hostname);
  const ipVersion = isIP(hostname);
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const allowDevLocalHttp = options.allowDevLocalHttp ??
    process.env.AI_CONFIG_ALLOW_LOCAL_HTTP === "true";
  const devLocalOverride = options.environment === "development" &&
    nodeEnv === "development" &&
    allowDevLocalHttp;
  const localHost = isLocalHostname(hostname) || (ipVersion !== 0 && isLocalHostAddress(hostname));
  const localHttp = devLocalOverride && localHost && url.protocol === "http:";
  const authority = rawUrl.trim().match(/^[a-z]+:\/\/([^/?#]*)/i)?.[1] ?? "";

  if (
    url.protocol !== "https:" && !localHttp ||
    url.username !== "" || url.password !== "" ||
    authority.includes("@") || url.href.includes("#") || url.href.includes("?") ||
    hostname === "" || METADATA_HOSTS.has(hostname) ||
    hostname.endsWith(".metadata.google.internal") ||
    ipVersion !== 0 && !(localHttp && isLocalHostAddress(hostname)) ||
    isLocalHostname(hostname) && !localHttp
  ) {
    throw new SecurityError("URL_REJECTED");
  }

  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  const allowedPorts = options.allowedPorts ?? [443];
  if (!allowedPorts.includes(port)) throw new SecurityError("URL_REJECTED");

  const allowedHosts = (options.allowedHosts ??
    (process.env.AI_PROVIDER_ALLOWED_HOSTS ?? "").split(","))
    .map(normalizeHostname)
    .map((host) => host.trim())
    .filter(Boolean);
  if (!localHttp && !allowedHosts.includes(hostname)) {
    throw new SecurityError("URL_REJECTED");
  }

  url.hostname = hostname;
  return {
    url,
    sanitizedHost: url.host,
    allowDevPrivateAddresses: localHttp,
  };
}

function parseIPv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

function inIPv4Range(address: string, base: string, prefix: number): boolean {
  const octets = parseIPv4(address);
  const start = parseIPv4(base);
  if (!octets || !start) return false;
  const value = octets.reduce((out, octet) => (out * 256 + octet) >>> 0, 0);
  const network = start.reduce((out, octet) => (out * 256 + octet) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

function parseIPv6(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  const source = address.toLowerCase();
  if (source.includes(".")) {
    const splitAt = source.lastIndexOf(":");
    const ipv4 = parseIPv4(source.slice(splitAt + 1));
    if (!ipv4) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    return parseIPv6(`${source.slice(0, splitAt)}:${high}:${low}`);
  }

  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (halves.length === 1 && left.length !== 8 || halves.length === 2 && fill < 1) return null;
  const words = [...left, ...Array(fill).fill("0"), ...right];
  if (words.length !== 8 || words.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return words.flatMap((part) => {
    const word = Number.parseInt(part, 16);
    return [word >>> 8, word & 0xff];
  });
}

function isMappedIPv4(parts: number[]): boolean {
  return parts.slice(0, 10).every((byte) => byte === 0) &&
    parts[10] === 0xff && parts[11] === 0xff;
}

function ipv6InRange(parts: number[], base: number[], prefix: number): boolean {
  for (let bit = 0; bit < prefix; bit += 1) {
    const byte = Math.floor(bit / 8);
    const mask = 1 << (7 - bit % 8);
    if ((parts[byte] & mask) !== (base[byte] & mask)) return false;
  }
  return true;
}

const IPV6_SPECIAL_RANGES = [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const;

function parseIPv6Base(base: string): number[] {
  const expanded = parseIPv6(base);
  if (!expanded) throw new Error("Invalid internal IPv6 range");
  return expanded;
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const blocked: readonly [string, number][] = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
      ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
      ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
      ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
      ["168.63.129.16", 32],
    ];
    return !blocked.some(([base, prefix]) => inIPv4Range(address, base, prefix));
  }
  if (version !== 6) return false;
  const parts = parseIPv6(address);
  if (!parts || isMappedIPv4(parts)) return false;
  if (!ipv6InRange(parts, parseIPv6Base("2000::"), 3)) return false;
  return !IPV6_SPECIAL_RANGES.some(([base, prefix]) =>
    ipv6InRange(parts, parseIPv6Base(base), prefix));
}

function isAllowedDevAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return inIPv4Range(address, "10.0.0.0", 8) ||
      inIPv4Range(address, "172.16.0.0", 12) ||
      inIPv4Range(address, "192.168.0.0", 16) ||
      inIPv4Range(address, "127.0.0.0", 8);
  }
  const parts = parseIPv6(address);
  return Boolean(parts && (
    parts.slice(0, 15).every((byte) => byte === 0) && parts[15] === 1 ||
    (parts[0] & 0xfe) === 0xfc
  ));
}

export function assertResolvedAddresses(
  hostname: string,
  addresses: readonly string[],
  allowDevPrivateAddresses = false,
): void {
  const normalizedHost = normalizeHostname(hostname);
  if (addresses.length === 0) throw new SecurityError("DNS_REJECTED");
  for (const address of addresses) {
    if (isPublicAddress(address)) continue;
    if (
      allowDevPrivateAddresses &&
      (isLocalHostname(normalizedHost) || isIP(normalizedHost) !== 0) &&
      isAllowedDevAddress(address)
    ) continue;
    throw new SecurityError("DNS_REJECTED");
  }
}
