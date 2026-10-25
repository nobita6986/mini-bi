import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

export const N8N_BOD_READONLY_PRINCIPAL = "n8n_bod_readonly" as const;
export const N8N_BOD_READONLY_SCOPE = "all" as const;

export type N8nBodPrincipalContext = {
  principal: typeof N8N_BOD_READONLY_PRINCIPAL;
  scope: typeof N8N_BOD_READONLY_SCOPE;
};

export type N8nInternalActorRef = {
  auth_subject: string;
  app_user_id: string;
};

export type N8nAuthFailureCode =
  | "N8N_INTEGRATION_DISABLED"
  | "N8N_INTEGRATION_NOT_CONFIGURED"
  | "CREDENTIAL_IN_QUERY_FORBIDDEN"
  | "CLIENT_AUTHORITY_HEADER_FORBIDDEN"
  | "UNAUTHORIZED";

export type N8nAuthResult =
  | {
      ok: true;
      principal: N8nBodPrincipalContext;
    }
  | {
      ok: false;
      status: 400 | 401 | 503;
      code: N8nAuthFailureCode;
      message: string;
    };

export type N8nAuthEnvInput = {
  apiEnabled?: string | undefined;
  apiKey?: string | undefined;
  authSubject?: string | undefined;
  appUserId?: string | undefined;
};

const MIN_API_KEY_LENGTH = 32;
const MAX_API_KEY_LENGTH = 512;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FORBIDDEN_QUERY_CREDENTIAL_PARAMS = new Set([
  "api_key",
  "apikey",
  "token",
  "access_token",
  "secret",
  "bearer",
  "key",
  "authorization",
]);

const FORBIDDEN_AUTHORITY_HEADERS = [
  "x-actor",
  "x-actor-id",
  "x-app-user-id",
  "x-auth-subject",
  "x-role",
  "x-roles",
  "x-scope",
  "x-scopes",
  "x-team-id",
  "x-capabilities",
] as const;

function sha256Digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeTokenMatch(expected: string, provided: string): boolean {
  const expectedDigest = sha256Digest(expected);
  const providedDigest = sha256Digest(provided);
  return timingSafeEqual(expectedDigest, providedDigest);
}

function isValidConfiguredApiKey(value: string | undefined): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (
    trimmed.length < MIN_API_KEY_LENGTH ||
    trimmed.length > MAX_API_KEY_LENGTH
  ) {
    return false;
  }
  // Reject whitespace or control characters in machine-to-machine secret.
  if (/[\s\x00-\x1F\x7F]/.test(trimmed)) {
    return false;
  }
  return true;
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  const match = /^Bearer\s+(\S+)$/i.exec(trimmed);
  if (!match) return null;
  const token = match[1];
  if (
    !token ||
    token.length < 1 ||
    token.length > MAX_API_KEY_LENGTH ||
    /[\s\x00-\x1F\x7F]/.test(token)
  ) {
    return null;
  }
  return token;
}

function readDefaultEnv(): N8nAuthEnvInput {
  return {
    apiEnabled: process.env.N8N_BOD_API_ENABLED,
    apiKey: process.env.N8N_BOD_READONLY_API_KEY,
    authSubject: process.env.N8N_BOD_READONLY_AUTH_SUBJECT,
    appUserId: process.env.N8N_BOD_READONLY_APP_USER_ID,
  };
}

/**
 * Authenticates a machine-to-machine request from n8n and binds it to the
 * fixed principal `n8n_bod_readonly` (`all` scope).
 *
 * Security invariants:
 * - Secret is compared in constant time via SHA-256 digests.
 * - Never accepts credentials in URL query parameters.
 * - Never accepts caller-supplied actor/role/scope/team headers.
 * - Never logs the bearer token.
 */
export function authenticateN8nBodRequest(
  request: Request,
  envInput: N8nAuthEnvInput = readDefaultEnv(),
): N8nAuthResult {
  const enabledRaw = envInput.apiEnabled?.trim().toLowerCase();
  if (enabledRaw === "false" || enabledRaw === "0") {
    return {
      ok: false,
      status: 503,
      code: "N8N_INTEGRATION_DISABLED",
      message: "Tích hợp n8n BoD read-only API hiện đang tắt trên server.",
    };
  }

  if (!isValidConfiguredApiKey(envInput.apiKey)) {
    return {
      ok: false,
      status: 503,
      code: "N8N_INTEGRATION_NOT_CONFIGURED",
      message:
        "Server chưa cấu hình N8N_BOD_READONLY_API_KEY hợp lệ (tối thiểu 32 ký tự ASCII).",
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return {
      ok: false,
      status: 400,
      code: "UNAUTHORIZED",
      message: "URL yêu cầu không hợp lệ.",
    };
  }

  for (const key of parsedUrl.searchParams.keys()) {
    const normalizedKey = key.trim().toLowerCase();
    if (FORBIDDEN_QUERY_CREDENTIAL_PARAMS.has(normalizedKey)) {
      return {
        ok: false,
        status: 400,
        code: "CREDENTIAL_IN_QUERY_FORBIDDEN",
        message:
          "Không được truyền credential hoặc token qua URL query string; chỉ dùng header Authorization: Bearer.",
      };
    }
  }

  for (const headerName of FORBIDDEN_AUTHORITY_HEADERS) {
    if (request.headers.has(headerName)) {
      return {
        ok: false,
        status: 400,
        code: "CLIENT_AUTHORITY_HEADER_FORBIDDEN",
        message: `Không được gửi header tự khai quyền hoặc danh tính (${headerName}); principal cố định là n8n_bod_readonly.`,
      };
    }
  }

  const providedToken = extractBearerToken(
    request.headers.get("authorization"),
  );
  if (
    !providedToken ||
    !constantTimeTokenMatch(envInput.apiKey.trim(), providedToken)
  ) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: "Bearer credential không hợp lệ hoặc bị thiếu.",
    };
  }

  return {
    ok: true,
    principal: {
      principal: N8N_BOD_READONLY_PRINCIPAL,
      scope: N8N_BOD_READONLY_SCOPE,
    },
  };
}

type ActorContextResolutionPayload = {
  auth_subject?: unknown;
  app_user_id?: unknown;
  enabled?: unknown;
  capabilities?: unknown;
  all_scope_grants?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scoreCandidateActor(payload: ActorContextResolutionPayload): number {
  if (payload.enabled !== true) return -1;
  if (
    typeof payload.auth_subject !== "string" ||
    !UUID_REGEX.test(payload.auth_subject) ||
    typeof payload.app_user_id !== "string" ||
    !UUID_REGEX.test(payload.app_user_id)
  ) {
    return -1;
  }
  const allScopeGrants = Array.isArray(payload.all_scope_grants)
    ? payload.all_scope_grants
    : [];
  if (allScopeGrants.length === 0) return -1;

  const caps = new Set<string>(
    Array.isArray(payload.capabilities)
      ? payload.capabilities.filter((item): item is string => typeof item === "string")
      : [],
  );

  let score = 10;
  if (
    caps.has("entry_admin") &&
    caps.has("recruiter_master_manage") &&
    caps.has("team_master_manage")
  ) {
    score += 100;
  }
  if (caps.has("catalog_master_manage")) score += 30;
  if (caps.has("entry_privileged_edit")) score += 25;
  if (caps.has("report_view")) score += 15;
  if (caps.has("report_analytics_view")) score += 15;
  if (caps.has("vendor_finance_view")) score += 15;
  if (caps.has("change_review")) score += 10;
  return score;
}

let cachedServiceActor: {
  actor: N8nInternalActorRef;
  expiresAtMs: number;
} | null = null;

const ACTOR_CACHE_TTL_MS = 5 * 60 * 1000;

export function clearN8nServiceActorCache(): void {
  cachedServiceActor = null;
}

export type N8nActorResolverDependencies = {
  env?: N8nAuthEnvInput;
  resolveActorContextRpc?: (authSubject: string) => Promise<{
    data: unknown;
    error: unknown;
  }>;
  listAuthUserIds?: () => Promise<readonly string[]>;
  nowMs?: () => number;
};

/**
 * Resolves the internal `(auth_subject, app_user_id)` binding used ONLY on the
 * server to invoke existing `service_role` read RPCs on behalf of the fixed
 * principal `n8n_bod_readonly`.
 *
 * Resolution order:
 * 1. Explicit `N8N_BOD_READONLY_AUTH_SUBJECT` + `N8N_BOD_READONLY_APP_USER_ID` env vars.
 * 2. Explicit `N8N_BOD_READONLY_AUTH_SUBJECT` env var resolved via `direct_entry_resolve_actor_context`.
 * 3. Auto-discovery of the highest-authority enabled `all`-scope actor via `direct_entry_resolve_actor_context`.
 */
export async function resolveN8nBodServiceActor(
  deps: N8nActorResolverDependencies = {},
): Promise<
  | { ok: true; actor: N8nInternalActorRef }
  | { ok: false; code: "SERVICE_PRINCIPAL_ACTOR_UNAVAILABLE"; message: string }
> {
  const env = deps.env ?? readDefaultEnv();
  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();

  const explicitAuthSubject = env.authSubject?.trim();
  const explicitAppUserId = env.appUserId?.trim();

  if (
    explicitAuthSubject &&
    UUID_REGEX.test(explicitAuthSubject) &&
    explicitAppUserId &&
    UUID_REGEX.test(explicitAppUserId)
  ) {
    return {
      ok: true,
      actor: {
        auth_subject: explicitAuthSubject,
        app_user_id: explicitAppUserId,
      },
    };
  }

  if (cachedServiceActor && cachedServiceActor.expiresAtMs > nowMs) {
    return { ok: true, actor: cachedServiceActor.actor };
  }

  const callActorContextRpc =
    deps.resolveActorContextRpc ??
    (async (authSubject: string) => {
      const { createServiceSupabaseClient } = await import(
        "../../supabase/server.ts"
      );
      const client = createServiceSupabaseClient();
      const { data, error } = await client.rpc(
        "direct_entry_resolve_actor_context",
        { p_auth_subject: authSubject },
      );
      return { data, error };
    });

  if (explicitAuthSubject && UUID_REGEX.test(explicitAuthSubject)) {
    try {
      const { data, error } = await callActorContextRpc(explicitAuthSubject);
      if (!error && isRecord(data) && scoreCandidateActor(data) >= 10) {
        const actor: N8nInternalActorRef = {
          auth_subject: data.auth_subject as string,
          app_user_id: data.app_user_id as string,
        };
        cachedServiceActor = {
          actor,
          expiresAtMs: nowMs + ACTOR_CACHE_TTL_MS,
        };
        return { ok: true, actor };
      }
    } catch {
      // Fall through to fail-closed error below.
    }
    return {
      ok: false,
      code: "SERVICE_PRINCIPAL_ACTOR_UNAVAILABLE",
      message:
        "Không thể xác thực tài khoản đại diện N8N_BOD_READONLY_AUTH_SUBJECT với quyền đọc toàn miền (all scope).",
    };
  }

  const listAuthUserIds =
    deps.listAuthUserIds ??
    (async () => {
      const { createServiceSupabaseClient } = await import(
        "../../supabase/server.ts"
      );
      const client = createServiceSupabaseClient();
      const userIds: string[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const { data, error } = await client.auth.admin.listUsers({
          page,
          perPage: 200,
        });
        if (error || !data?.users?.length) break;
        for (const user of data.users) {
          if (typeof user.id === "string" && UUID_REGEX.test(user.id)) {
            userIds.push(user.id);
          }
        }
        if (data.users.length < 200) break;
      }
      return userIds;
    });

  try {
    const candidateUserIds = await listAuthUserIds();
    let bestScore = -1;
    let bestActor: N8nInternalActorRef | null = null;

    for (const authSubject of candidateUserIds) {
      const { data, error } = await callActorContextRpc(authSubject);
      if (error || !isRecord(data)) continue;
      const score = scoreCandidateActor(data);
      if (score > bestScore) {
        bestScore = score;
        bestActor = {
          auth_subject: data.auth_subject as string,
          app_user_id: data.app_user_id as string,
        };
        if (score >= 180) {
          break;
        }
      }
    }

    if (bestActor) {
      cachedServiceActor = {
        actor: bestActor,
        expiresAtMs: nowMs + ACTOR_CACHE_TTL_MS,
      };
      return { ok: true, actor: bestActor };
    }
  } catch {
    // Fall through to fail-closed error.
  }

  return {
    ok: false,
    code: "SERVICE_PRINCIPAL_ACTOR_UNAVAILABLE",
    message:
      "Không tìm thấy actor nội bộ có quyền toàn miền (all scope) cho principal n8n_bod_readonly. Hãy cấu hình N8N_BOD_READONLY_AUTH_SUBJECT và N8N_BOD_READONLY_APP_USER_ID.",
  };
}
