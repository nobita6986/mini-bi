import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { resolveActor, type ActorRepository } from "../../auth/direct-entry-v2.ts";

export const HRP_SYNC_PRINCIPAL = "hrp_sync_m2m" as const;
export const MIN_HRP_API_KEY_LENGTH = 32;
export const HRP_SYNC_RATE_LIMIT_MAX_REQUESTS = 60;
export const HRP_SYNC_RATE_LIMIT_WINDOW_MS = 60_000;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type HrpSyncAuthEnvInput = {
  HRP_SYNC_API_ENABLED?: string | undefined;
  HRP_SYNC_API_KEY?: string | undefined;
  HRP_SYNC_API_KEY_NEXT?: string | undefined;
  HRP_SYNC_AUTH_SUBJECT?: string | undefined;
};

export type HrpSyncAuthErrorCode =
  | "SERVICE_DISABLED"
  | "SERVICE_MISCONFIGURED"
  | "MISSING_BEARER_TOKEN"
  | "INVALID_BEARER_TOKEN"
  | "INVALID_REQUEST_ID"
  | "RATE_LIMITED";

export type HrpSyncAuthResult =
  | {
      ok: true;
      principal: typeof HRP_SYNC_PRINCIPAL;
      requestId: string;
      keyFingerprint: string;
      usedRotatedKey: boolean;
    }
  | {
      ok: false;
      status: 400 | 401 | 429 | 503;
      code: HrpSyncAuthErrorCode;
      message: string;
      retryAfterSeconds?: number;
    };

export type HrpSyncActorRef = {
  auth_subject: string | null;
  app_user_id: string | null;
};

const rateLimitBuckets = new Map<string, number[]>();

export function resetHrpSyncRateLimiterForTests(): void {
  rateLimitBuckets.clear();
}

function sha256Buffer(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeStringEquals(expected: string, candidate: string): boolean {
  const expectedDigest = sha256Buffer(expected);
  const candidateDigest = sha256Buffer(candidate);
  const digestsMatch = timingSafeEqual(expectedDigest, candidateDigest);
  return digestsMatch && expected.length === candidate.length;
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  const match = /^Bearer\s+([^\s]+)$/i.exec(trimmed);
  if (!match) return null;
  const token = match[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

function consumeRateLimitSlot(
  keyFingerprint: string,
  nowMs: number,
  maxRequests: number,
  windowMs: number,
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const cutoff = nowMs - windowMs;
  const existing = rateLimitBuckets.get(keyFingerprint) ?? [];
  const active = existing.filter((ts) => ts > cutoff);
  if (active.length >= maxRequests) {
    const oldest = active[0] ?? nowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
    rateLimitBuckets.set(keyFingerprint, active);
    return { allowed: false, retryAfterSeconds };
  }
  active.push(nowMs);
  rateLimitBuckets.set(keyFingerprint, active);
  return { allowed: true };
}

export function authenticateHrpSyncRequest(
  request: Pick<Request, "headers">,
  options: {
    env?: HrpSyncAuthEnvInput;
    nowMs?: number;
    maxRequestsPerMinute?: number;
    windowMs?: number;
  } = {},
): HrpSyncAuthResult {
  const env = options.env ?? process.env;
  const enabledRaw = (env.HRP_SYNC_API_ENABLED ?? "").trim().toLowerCase();
  if (enabledRaw !== "true") {
    return {
      ok: false,
      status: 503,
      code: "SERVICE_DISABLED",
      message: "API đồng bộ HRP hiện đang tắt.",
    };
  }

  const configuredPrimaryKey = (env.HRP_SYNC_API_KEY ?? "").trim();
  const configuredNextKey = (env.HRP_SYNC_API_KEY_NEXT ?? "").trim();

  if (configuredPrimaryKey.length < MIN_HRP_API_KEY_LENGTH) {
    return {
      ok: false,
      status: 503,
      code: "SERVICE_MISCONFIGURED",
      message: "Khóa xác thực HRP_SYNC_API_KEY chưa được cấu hình hợp lệ.",
    };
  }

  if (
    configuredNextKey.length > 0 &&
    configuredNextKey.length < MIN_HRP_API_KEY_LENGTH
  ) {
    return {
      ok: false,
      status: 503,
      code: "SERVICE_MISCONFIGURED",
      message: "Khóa xoay vòng HRP_SYNC_API_KEY_NEXT chưa đủ độ dài tối thiểu.",
    };
  }

  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: "MISSING_BEARER_TOKEN",
      message: "Thiếu header Authorization: Bearer <token>.",
    };
  }

  const matchesPrimary = constantTimeStringEquals(configuredPrimaryKey, token);
  const matchesNext =
    configuredNextKey.length >= MIN_HRP_API_KEY_LENGTH
      ? constantTimeStringEquals(configuredNextKey, token)
      : false;

  if (!matchesPrimary && !matchesNext) {
    return {
      ok: false,
      status: 401,
      code: "INVALID_BEARER_TOKEN",
      message: "Bearer token không hợp lệ.",
    };
  }

  const rawRequestId = request.headers.get("x-request-id");
  let requestId: string;
  if (rawRequestId !== null && rawRequestId.trim() !== "") {
    const trimmed = rawRequestId.trim();
    if (!UUID_REGEX.test(trimmed)) {
      return {
        ok: false,
        status: 400,
        code: "INVALID_REQUEST_ID",
        message: "Header X-Request-Id phải là UUID hợp lệ.",
      };
    }
    requestId = trimmed.toLowerCase();
  } else {
    requestId = randomUUID();
  }

  const keyFingerprint = sha256Hex(token).slice(0, 16);
  const rateCheck = consumeRateLimitSlot(
    keyFingerprint,
    options.nowMs ?? Date.now(),
    options.maxRequestsPerMinute ?? HRP_SYNC_RATE_LIMIT_MAX_REQUESTS,
    options.windowMs ?? HRP_SYNC_RATE_LIMIT_WINDOW_MS,
  );
  if (!rateCheck.allowed) {
    return {
      ok: false,
      status: 429,
      code: "RATE_LIMITED",
      message: "Vượt quá giới hạn tần suất gọi API đồng bộ HRP.",
      retryAfterSeconds: rateCheck.retryAfterSeconds,
    };
  }

  return {
    ok: true,
    principal: HRP_SYNC_PRINCIPAL,
    requestId,
    keyFingerprint,
    usedRotatedKey: !matchesPrimary && matchesNext,
  };
}

export async function resolveHrpSyncServiceActor(options: {
  env?: HrpSyncAuthEnvInput;
  repository?: ActorRepository;
  now?: Date;
} = {}): Promise<
  | { ok: true; actor: HrpSyncActorRef }
  | { ok: false; code: "SERVICE_ACTOR_MISCONFIGURED" | "SERVICE_ACTOR_UNAVAILABLE"; message: string }
> {
  const env = options.env ?? process.env;
  const authSubject = (env.HRP_SYNC_AUTH_SUBJECT ?? "").trim();

  if (!authSubject) {
    return {
      ok: true,
      actor: { auth_subject: null, app_user_id: null },
    };
  }

  if (!UUID_REGEX.test(authSubject)) {
    return {
      ok: false,
      code: "SERVICE_ACTOR_MISCONFIGURED",
      message: "HRP_SYNC_AUTH_SUBJECT phải là UUID hợp lệ khi được cấu hình.",
    };
  }

  try {
    const repo =
      options.repository ??
      (
        await import("../../direct-entry/actor-context-repository.ts")
      ).createDirectEntryActorRepository();
    const at = (options.now ?? new Date()).toISOString();

    const resolved = await resolveActor({
      session: {
        auth_subject: authSubject,
        provider: "supabase",
        authenticated_at: at,
      },
      repository: repo,
      at,
    });

    if (!resolved.ok) {
      return {
        ok: false,
        code: "SERVICE_ACTOR_UNAVAILABLE",
        message: `Tài khoản dịch vụ HRP (${resolved.reason}) không hợp lệ hoặc đã bị vô hiệu hóa.`,
      };
    }

    return {
      ok: true,
      actor: {
        auth_subject: resolved.actor.auth_subject,
        app_user_id: resolved.actor.app_user_id,
      },
    };
  } catch {
    return {
      ok: false,
      code: "SERVICE_ACTOR_UNAVAILABLE",
      message: "Không thể xác minh tài khoản dịch vụ HRP_SYNC_AUTH_SUBJECT.",
    };
  }
}
