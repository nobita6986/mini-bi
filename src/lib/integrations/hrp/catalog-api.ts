import {
  authenticateHrpSyncRequest,
  resolveHrpSyncServiceActor,
  type HrpSyncActorRef,
  type HrpSyncAuthEnvInput,
} from "./auth.ts";
import {
  projectHrpSyncCatalog,
  type HrpSyncCatalogPayload,
} from "./catalog-contract.ts";

export type HrpCatalogRpcCaller = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type HrpCatalogRepositoryResult =
  | { ok: true; data: HrpSyncCatalogPayload }
  | { ok: false; status: 403 | 503; code: string; message: string };

export type HrpCatalogRepository = {
  getCatalog(input: {
    auth_subject: string | null;
    app_user_id: string | null;
    request_id: string;
  }): Promise<HrpCatalogRepositoryResult>;
};

const COMMON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, no-cache, must-revalidate",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});

function jsonResponse(
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...COMMON_HEADERS,
      ...(extraHeaders ?? {}),
    },
  });
}

function createDefaultServiceRpcCaller(): HrpCatalogRpcCaller {
  return async (name, args) => {
    const { createServiceSupabaseClient } = await import("../../supabase/server.ts");
    const supabase = createServiceSupabaseClient();
    const { data, error } = await supabase.rpc(name, args);
    return {
      data,
      error: error
        ? {
            code: typeof error.code === "string" ? error.code : undefined,
            message: typeof error.message === "string" ? error.message : undefined,
          }
        : null,
    };
  };
}

export function createServiceHrpCatalogRepository(
  rpc: HrpCatalogRpcCaller = createDefaultServiceRpcCaller(),
): HrpCatalogRepository {
  return {
    async getCatalog(input): Promise<HrpCatalogRepositoryResult> {
      try {
        const { data, error } = await rpc("hrp_sync_catalog", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_request_id: input.request_id,
        });

        if (error) {
          if (error.code === "42501") {
            return {
              ok: false,
              status: 403,
              code: "HRP_SYNC_ACTOR_DENIED",
              message: "Tài khoản dịch vụ đồng bộ HRP không có quyền truy cập.",
            };
          }
          return {
            ok: false,
            status: 503,
            code: "HRP_SYNC_CATALOG_UNAVAILABLE",
            message: "Không thể truy vấn danh mục đồng bộ HRP lúc này.",
          };
        }

        const projected = projectHrpSyncCatalog(data);
        if (!projected) {
          return {
            ok: false,
            status: 503,
            code: "HRP_SYNC_CATALOG_UNAVAILABLE",
            message: "Dữ liệu danh mục đồng bộ HRP không khớp schema chuẩn.",
          };
        }

        return { ok: true, data: projected };
      } catch {
        return {
          ok: false,
          status: 503,
          code: "HRP_SYNC_CATALOG_UNAVAILABLE",
          message: "Không thể truy vấn danh mục đồng bộ HRP lúc này.",
        };
      }
    },
  };
}

export async function handleHrpSyncCatalogGet(
  request: Request,
  options: {
    env?: HrpSyncAuthEnvInput;
    nowMs?: number;
    maxRequestsPerMinute?: number;
    windowMs?: number;
    resolveActor?: () => Promise<
      | { ok: true; actor: HrpSyncActorRef }
      | { ok: false; code: string; message: string }
    >;
    repository?: HrpCatalogRepository;
  } = {},
): Promise<Response> {
  const auth = authenticateHrpSyncRequest(request, {
    env: options.env,
    nowMs: options.nowMs,
    maxRequestsPerMinute: options.maxRequestsPerMinute,
    windowMs: options.windowMs,
  });

  if (!auth.ok) {
    const extraHeaders: Record<string, string> = {};
    if (auth.status === 401) {
      extraHeaders["www-authenticate"] = 'Bearer realm="hrp-sync-v1"';
    }
    if (auth.status === 429 && auth.retryAfterSeconds !== undefined) {
      extraHeaders["retry-after"] = String(auth.retryAfterSeconds);
    }
    return jsonResponse(
      auth.status,
      {
        ok: false,
        error: {
          code: auth.code,
          message: auth.message,
        },
      },
      extraHeaders,
    );
  }

  const resolveActor =
    options.resolveActor ?? (() => resolveHrpSyncServiceActor({ env: options.env }));
  const actorOutcome = await resolveActor();
  if (!actorOutcome.ok) {
    return jsonResponse(
      503,
      {
        ok: false,
        error: {
          code: actorOutcome.code,
          message: actorOutcome.message,
        },
      },
      { "x-request-id": auth.requestId },
    );
  }

  const repository = options.repository ?? createServiceHrpCatalogRepository();
  const result = await repository.getCatalog({
    auth_subject: actorOutcome.actor.auth_subject,
    app_user_id: actorOutcome.actor.app_user_id,
    request_id: auth.requestId,
  });

  if (!result.ok) {
    return jsonResponse(
      result.status,
      {
        ok: false,
        error: {
          code: result.code,
          message: result.message,
        },
      },
      { "x-request-id": auth.requestId },
    );
  }

  return jsonResponse(200, result.data, { "x-request-id": auth.requestId });
}
