import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";

export function isSameOriginAuthRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (typeof origin !== "string" || typeof host !== "string") return false;

  const result = checkSameOriginRequest({
    origin,
    host,
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!result.ok) return false;

  try {
    const requestUrl = new URL(request.url);
    const forwardedProto = request.headers.get("x-forwarded-proto");
    // Caddy terminates TLS; Next may see the HTTP upstream URL. Caddy overwrites this header on the public path.
    const protocol = forwardedProto === null
      ? requestUrl.protocol.slice(0, -1)
      : forwardedProto.toLowerCase();
    if (protocol !== "http" && protocol !== "https") return false;

    return new URL(origin).origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}
