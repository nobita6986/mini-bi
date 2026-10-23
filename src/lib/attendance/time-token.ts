import "server-only";

import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isUuid } from "../http/direct-entry-api-guard.ts";
import { ATTENDANCE_TIME_TOKEN_TTL_MS } from "./attendance-contract.ts";

export { ATTENDANCE_TIME_TOKEN_TTL_MS };
export const ATTENDANCE_TIME_TOKEN_VERSION = "att-time/1" as const;
export const ATTENDANCE_TIME_TOKEN_WIRE_PREFIX = "at1" as const;

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const NONCE_HEX = /^[0-9a-f]{32}$/;
const HMAC_DOMAIN_PREFIX = "attendance-time-token/1.";
const SIGNATURE_B64URL_LENGTH = 43;
const MIN_TOKEN_LENGTH = 64;
const MAX_TOKEN_LENGTH = 1024;
const EXACT_PAYLOAD_KEYS = ["exp", "iat", "n", "u", "v"] as const;

type WireTokenPayload = {
  v: typeof ATTENDANCE_TIME_TOKEN_VERSION;
  u: string;
  iat: number;
  exp: number;
  n: string;
};

export type IssuedAttendanceTimeToken = {
  server_time: string;
  expires_at: string;
  time_token: string;
  issued_at_ms: number;
  expires_at_ms: number;
};

export type VerifiedAttendanceTimeToken =
  | {
      ok: true;
      issued_at_ms: number;
      expires_at_ms: number;
      issued_at_iso: string;
      expires_at_iso: string;
      ttl_ms: number;
      nonce: string;
      token_digest: string;
    }
  | {
      ok: false;
      code:
        | "ATTENDANCE_TIME_TOKEN_INVALID"
        | "ATTENDANCE_TIME_TOKEN_ACTOR_MISMATCH"
        | "ATTENDANCE_TIME_TOKEN_EXPIRED";
    };

function computeHmacSignature(secret: Buffer, payloadB64Url: string): Buffer {
  return createHmac("sha256", secret)
    .update(HMAC_DOMAIN_PREFIX, "ascii")
    .update(payloadB64Url, "ascii")
    .digest();
}

export function computeTimeTokenDigest(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function issueAttendanceTimeToken(input: {
  secret: Buffer;
  app_user_id: string;
  now_ms?: number;
  nonce_hex?: string;
}): IssuedAttendanceTimeToken {
  if (!Buffer.isBuffer(input.secret) || input.secret.byteLength < 32) {
    throw new Error("ATTENDANCE_CONFIG_REQUIRED");
  }
  const normalizedUserId = input.app_user_id.trim().toLowerCase();
  if (!isUuid(normalizedUserId)) {
    throw new Error("ACTOR_NOT_AVAILABLE");
  }
  const rawNow = input.now_ms ?? Date.now();
  if (!Number.isFinite(rawNow) || rawNow <= 0) {
    throw new Error("ATTENDANCE_TIME_INVALID");
  }
  const issuedAtMs = Math.trunc(rawNow);
  const expiresAtMs = issuedAtMs + ATTENDANCE_TIME_TOKEN_TTL_MS;
  const nonce = input.nonce_hex ?? randomBytes(16).toString("hex");
  if (!NONCE_HEX.test(nonce)) {
    throw new Error("ATTENDANCE_NONCE_INVALID");
  }

  const payload: WireTokenPayload = {
    v: ATTENDANCE_TIME_TOKEN_VERSION,
    u: normalizedUserId,
    iat: issuedAtMs,
    exp: expiresAtMs,
    n: nonce,
  };
  const payloadB64Url = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sigB64Url = computeHmacSignature(input.secret, payloadB64Url).toString("base64url");

  return {
    server_time: new Date(issuedAtMs).toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    time_token: `${ATTENDANCE_TIME_TOKEN_WIRE_PREFIX}.${payloadB64Url}.${sigB64Url}`,
    issued_at_ms: issuedAtMs,
    expires_at_ms: expiresAtMs,
  };
}

export function verifyAttendanceTimeToken(input: {
  secret: Buffer;
  token: string;
  expected_app_user_id: string;
  now_ms?: number;
}): VerifiedAttendanceTimeToken {
  if (!Buffer.isBuffer(input.secret) || input.secret.byteLength < 32) {
    return { ok: false, code: "ATTENDANCE_TIME_TOKEN_INVALID" };
  }
  const expectedActor = input.expected_app_user_id.trim().toLowerCase();
  if (!isUuid(expectedActor)) {
    return { ok: false, code: "ATTENDANCE_TIME_TOKEN_ACTOR_MISMATCH" };
  }
  const rawToken = input.token;
  if (
    typeof rawToken !== "string" ||
    rawToken.length < MIN_TOKEN_LENGTH ||
    rawToken.length > MAX_TOKEN_LENGTH
  ) {
    return { ok: false, code: "ATTENDANCE_TIME_TOKEN_INVALID" };
  }

  const parts = rawToken.split(".");
  if (parts.length !== 3) {
    return { ok: false, code: "ATTENDANCE_TIME_TOKEN_INVALID" };
  }
  const [prefix, payloadB64Url, sigB64Url] = parts;
  if (
    prefix !== ATTENDANCE_TIME_TOKEN_WIRE_PREFIX ||
    !payloadB64Url ||
    sigB64Url.length !== SIGNATURE_B64URL_LENGTH ||
    !BASE64URL_SEGMENT.test(payloadB64Url) ||
    !BASE64URL_SEGMENT.test(sigB64Url)
  ) {
    return { ok: false, code: "ATTENDANCE_TIME_TOKEN_INVALID" };
  }

  const providedSig = Buffer.from(sigB64Url, "base64url");
  if (
    providedSig.byteLength !== 32 ||
    providedSig.toString("base64url") !== sigB64Url
  ) {
    return { ok: false, code: "ATTENDANCE_TIME_TOKEN_INVALID" };
  }

  const expectedSig = computeHmacSignature(input.secret, payloadB64Url);
  if (
    expectedSig.byteLength !== providedSig.byteLength ||
    !timingSafeEqual(providedSig, expectedSig)
  ) {
    return { ok: false, code: "ATTENDANCE_TIME_TOKEN_INVALID" };
  }

  const payloadBytes = Buffer.from(payloadB64Url, "base64url");
  if (
    payloadBytes.byteLength === 0 ||
    payloadBytes.toString("base64url") !== payloadB64Url
  ) {
    return { ok: false, code: "ATTENDANCE_TIME_TOKEN_INVALID" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return { ok: false, code: "ATTENDANCE_TIME_TOKEN_INVALID" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: "ATTENDANCE_TIME_TOKEN_INVALID" };
  }
  const ownKeys = Object.getOwnPropertyNames(parsed).sort();
  if (
    ownKeys.length !== EXACT_PAYLOAD_KEYS.length ||
    ownKeys.some((key, idx) => key !== EXACT_PAYLOAD_KEYS[idx])
  ) {
    return { ok: false, code: "ATTENDANCE_TIME_TOKEN_INVALID" };
  }

  const record = parsed as Record<string, unknown>;
  const version = record.v;
  const tokenUserId = record.u;
  const issuedAtMs = record.iat;
  const expiresAtMs = record.exp;
  const nonce = record.n;

  if (
    version !== ATTENDANCE_TIME_TOKEN_VERSION ||
    typeof tokenUserId !== "string" ||
    tokenUserId !== tokenUserId.toLowerCase() ||
    !isUuid(tokenUserId) ||
    typeof issuedAtMs !== "number" ||
    !Number.isSafeInteger(issuedAtMs) ||
    issuedAtMs <= 0 ||
    typeof expiresAtMs !== "number" ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs !== ATTENDANCE_TIME_TOKEN_TTL_MS ||
    typeof nonce !== "string" ||
    !NONCE_HEX.test(nonce)
  ) {
    return { ok: false, code: "ATTENDANCE_TIME_TOKEN_INVALID" };
  }

  if (tokenUserId !== expectedActor) {
    return { ok: false, code: "ATTENDANCE_TIME_TOKEN_ACTOR_MISMATCH" };
  }

  const nowMs = Math.trunc(input.now_ms ?? Date.now());
  if (nowMs > expiresAtMs) {
    return { ok: false, code: "ATTENDANCE_TIME_TOKEN_EXPIRED" };
  }

  return {
    ok: true,
    issued_at_ms: issuedAtMs,
    expires_at_ms: expiresAtMs,
    issued_at_iso: new Date(issuedAtMs).toISOString(),
    expires_at_iso: new Date(expiresAtMs).toISOString(),
    ttl_ms: expiresAtMs - issuedAtMs,
    nonce,
    token_digest: computeTimeTokenDigest(rawToken),
  };
}
