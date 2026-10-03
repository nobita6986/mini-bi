import "server-only";

import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, RequestOptions } from "node:http";
import { isIP } from "node:net";
import { SecurityError } from "./errors.ts";
import {
  assertResolvedAddresses,
  validateProviderUrl,
  type UrlPolicyOptions,
} from "./provider-url-policy.ts";

export type PinnedRequest = {
  url: URL;
  addresses: readonly string[];
  method: "GET" | "POST";
  headers: Readonly<Record<string, string>>;
  body?: Buffer | string;
  timeoutMs: number;
  maxResponseBytes: number;
  signal: AbortSignal;
};

export type PinnedResponse = {
  statusCode: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Buffer;
};

export type SafeOutboundOptions = {
  url_policy: UrlPolicyOptions;
  resolve?: (hostname: string) => Promise<readonly string[]>;
  request?: (input: PinnedRequest) => Promise<PinnedResponse>;
  method?: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  body?: Buffer | string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  maxRedirects?: number;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Phải khớp trần provider_timeout_ms của gateway policy; lệch trần sẽ chặn
// request hợp lệ trước network (ví dụ policy 60s nhưng outbound chỉ nhận 30s).
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

async function resolveAll(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(({ address }) => address);
}

export function createPinnedLookup(
  addresses: readonly string[],
): NonNullable<RequestOptions["lookup"]> {
  if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0)) {
    throw new SecurityError("DNS_REJECTED");
  }
  let index = 0;
  return (_hostname, options, callback) => {
    if (options && typeof options === "object" && "all" in options && options.all) {
      callback(null, addresses.map((address) => ({ address, family: isIP(address) })));
      return;
    }
    const address = addresses[index % addresses.length];
    index += 1;
    callback(null, address, isIP(address));
  };
}

export function buildPinnedRequestOptions(
  input: PinnedRequest,
): RequestOptions & { servername?: string; rejectUnauthorized?: boolean } {
  const { url, addresses } = input;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return {
    protocol: url.protocol,
    hostname,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    path: `${url.pathname}${url.search}`,
    method: input.method,
    headers: { ...input.headers, host: url.host },
    lookup: createPinnedLookup(addresses),
    signal: input.signal,
    ...(url.protocol === "https:"
      ? { servername: hostname, rejectUnauthorized: true }
      : {}),
  };
}

function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new SecurityError("TIMEOUT");
  return value;
}

function safeHeaders(input: Readonly<Record<string, string>>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (
      !HEADER_NAME.test(name) ||
      /[\r\n]/.test(value) ||
      name.toLowerCase() === "host" ||
      name.toLowerCase() === "connection" ||
      name.toLowerCase() === "proxy-authorization"
    ) {
      throw new SecurityError("INVALID_INPUT");
    }
    headers[name] = value;
  }
  return headers;
}

export function collectResponse(
  response: IncomingMessage,
  maxResponseBytes: number,
  request: ReturnType<typeof httpsRequest> | ReturnType<typeof httpRequest>,
): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(response.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
      response.destroy();
      request.destroy();
      reject(new SecurityError("RESPONSE_TOO_LARGE"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxResponseBytes) {
        response.destroy();
        request.destroy();
        reject(new SecurityError("RESPONSE_TOO_LARGE"));
        return;
      }
      chunks.push(bytes);
    });
    response.on("end", () => resolve({
      statusCode: response.statusCode ?? 0,
      headers: response.headers,
      body: Buffer.concat(chunks, size),
    }));
    response.on("error", () => reject(new SecurityError("OUTBOUND_FAILED")));
  });
}

function requestPinned(input: PinnedRequest): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const requestOptions = buildPinnedRequestOptions(input);
    const transport = input.url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(requestOptions, (response) => {
      collectResponse(response, input.maxResponseBytes, request).then(resolve, reject);
    });
    request.setTimeout(input.timeoutMs, () => {
      request.destroy(new SecurityError("TIMEOUT"));
    });
    request.on("error", (error: unknown) => {
      reject(error instanceof SecurityError ? error : new SecurityError("OUTBOUND_FAILED"));
    });
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

function responseHeader(
  response: PinnedResponse,
  name: string,
): string | undefined {
  const value = response.headers[name] ?? response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export async function safeOutboundRequest(
  rawUrl: string,
  options: SafeOutboundOptions,
): Promise<PinnedResponse> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
  const maxRequestBytes = options.maxRequestBytes ?? 256 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  if (
    options.body !== undefined &&
    typeof options.body !== "string" &&
    !Buffer.isBuffer(options.body)
  ) {
    throw new SecurityError("INVALID_INPUT");
  }
  const requestBytes = options.body === undefined
    ? 0
    : Buffer.isBuffer(options.body)
      ? options.body.length
      : Buffer.byteLength(options.body, "utf8");
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS ||
    !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 ||
    maxResponseBytes > MAX_RESPONSE_BYTES ||
    !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 0 ||
    maxRequestBytes > MAX_REQUEST_BYTES ||
    !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5
  ) {
    throw new SecurityError("INVALID_INPUT");
  }
  if (requestBytes > maxRequestBytes) {
    throw new SecurityError("REQUEST_TOO_LARGE");
  }

  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new SecurityError("TIMEOUT"));
    }, timeoutMs);
  });

  const perform = async (): Promise<PinnedResponse> => {
    let currentUrl = rawUrl;
    let method = options.method ?? "POST";
    let body = options.body;
    let headers = safeHeaders(options.headers ?? {});
    let redirects = 0;

    while (true) {
      if (controller.signal.aborted) throw new SecurityError("TIMEOUT");
      const validated = validateProviderUrl(currentUrl, options.url_policy);
      let addresses: readonly string[];
      try {
        addresses = await (options.resolve ?? resolveAll)(
          validated.url.hostname.replace(/^\[|\]$/g, ""),
        );
      } catch {
        throw new SecurityError("DNS_REJECTED");
      }
      assertResolvedAddresses(
        validated.url.hostname,
        addresses,
        validated.allowDevPrivateAddresses,
      );
      if (controller.signal.aborted) throw new SecurityError("TIMEOUT");

      let response: PinnedResponse;
      try {
        response = await (options.request ?? requestPinned)({
          url: validated.url,
          addresses,
          method,
          headers,
          body,
          timeoutMs: remaining(deadline),
          maxResponseBytes,
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof SecurityError) throw error;
        if (controller.signal.aborted) throw new SecurityError("TIMEOUT");
        throw new SecurityError("OUTBOUND_FAILED");
      }
      if (response.body.length > maxResponseBytes) {
        throw new SecurityError("RESPONSE_TOO_LARGE");
      }

      if (
        !response ||
        !Number.isInteger(response.statusCode) ||
        !Buffer.isBuffer(response.body)
      ) {
        throw new SecurityError("OUTBOUND_FAILED");
      }
      const location = responseHeader(response, "location");
      if (!REDIRECT_STATUSES.has(response.statusCode) || !location) return response;
      if (redirects >= maxRedirects) throw new SecurityError("REDIRECT_REJECTED");

      let nextUrl: string;
      try {
        nextUrl = new URL(location, validated.url).href;
      } catch {
        throw new SecurityError("REDIRECT_REJECTED");
      }
      if (new URL(nextUrl).origin !== validated.url.origin) {
        throw new SecurityError("REDIRECT_REJECTED");
      }
      const nextValidated = validateProviderUrl(nextUrl, options.url_policy);
      if (
        response.statusCode === 303 ||
        ((response.statusCode === 301 || response.statusCode === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
        headers = Object.fromEntries(
          Object.entries(headers).filter(([name]) =>
            !/^content-|^transfer-encoding$/i.test(name)),
        );
      }
      currentUrl = nextValidated.url.href;
      redirects += 1;
    }
  };

  try {
    return await Promise.race([perform(), timeoutPromise]);
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    throw new SecurityError(controller.signal.aborted ? "TIMEOUT" : "OUTBOUND_FAILED");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
