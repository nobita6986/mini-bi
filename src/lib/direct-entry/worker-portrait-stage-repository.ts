import "server-only";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkerPortraitStage = {
  stage_id: string;
  document_type: "WORKER_PORTRAIT" | "CCCD_FRONT" | "CCCD_BACK" | "EMPLOYMENT_CONTRACT";
  mime_type: "image/jpeg" | "image/png" | "application/pdf";
  size_bytes: number;
  checksum_sha256: string;
  status: "STAGED" | "CLAIMED" | "ATTACHED" | "CANCELLED";
  claim_idempotency_key: string | null;
  entry_id: string | null;
  document_id: string | null;
};

export type StageOperation<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; kind: "conflict" | "denied" | "invalid" | "unavailable" };

export type CreateWorkerPortraitStageResult = {
  stage: WorkerPortraitStage;
  replayed: boolean;
};

export type SubmissionObjectCleanup = {
  cleanup_id: string;
  object_kind: "PORTRAIT_STAGE" | "DOCUMENT_STAGED" | "DOCUMENT_FINAL";
  stage_id: string | null;
  storage_key: string | null;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

function classify(error: { code?: string }): StageOperation<never> {
  if (error.code === "42501") return { ok: false, kind: "denied" };
  if (error.code === "PT409" || error.code === "40001") return { ok: false, kind: "conflict" };
  if (error.code === "22023" || error.code === "23514") return { ok: false, kind: "invalid" };
  return { ok: false, kind: "unavailable" };
}

function projectStage(value: unknown): WorkerPortraitStage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const stage = value as Record<string, unknown>;
  const keys = [
    "stage_id", "document_type", "mime_type", "size_bytes", "checksum_sha256", "status",
    "claim_idempotency_key", "entry_id", "document_id",
  ];
  if (Object.keys(stage).sort().join(",") !== keys.sort().join(",") ||
      typeof stage.stage_id !== "string" ||
      (stage.document_type !== "WORKER_PORTRAIT" && stage.document_type !== "CCCD_FRONT" &&
        stage.document_type !== "CCCD_BACK" && stage.document_type !== "EMPLOYMENT_CONTRACT") ||
      (stage.mime_type !== "image/jpeg" && stage.mime_type !== "image/png" &&
        stage.mime_type !== "application/pdf") ||
      (stage.document_type === "WORKER_PORTRAIT" && stage.mime_type === "application/pdf") ||
      typeof stage.size_bytes !== "number" || !Number.isSafeInteger(stage.size_bytes) ||
      stage.size_bytes < 1 || typeof stage.checksum_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(stage.checksum_sha256) ||
      (stage.status !== "STAGED" && stage.status !== "CLAIMED" &&
        stage.status !== "ATTACHED" && stage.status !== "CANCELLED") ||
      (stage.claim_idempotency_key !== null && typeof stage.claim_idempotency_key !== "string") ||
      (stage.entry_id !== null && typeof stage.entry_id !== "string") ||
      (stage.document_id !== null && typeof stage.document_id !== "string")) return null;
  return stage as WorkerPortraitStage;
}

export function createWorkerPortraitStageRepository(rpc?: Rpc) {
  let resolvedRpc = rpc;
  async function call(name: string, args: Record<string, unknown>): Promise<StageOperation<unknown>> {
    try {
      resolvedRpc ??= serviceRoleRpc();
      const result = await resolvedRpc(name, args);
      return result.error ? classify(result.error) : { ok: true, data: result.data };
    } catch {
      console.error("[direct-entry] portrait stage RPC failed");
      return { ok: false, kind: "unavailable" };
    }
  }
  return {
    async create(input: ActorRef & {
      stage_id: string;
      document_type: WorkerPortraitStage["document_type"];
      mime_type: WorkerPortraitStage["mime_type"];
      size_bytes: number; checksum_sha256: string; idempotency_key: string;
    }): Promise<StageOperation<CreateWorkerPortraitStageResult>> {
      const result = await call("direct_entry_create_worker_document_stage_idempotent", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_stage_id: input.stage_id,
        p_document_type: input.document_type,
        p_mime_type: input.mime_type,
        p_size_bytes: input.size_bytes,
        p_checksum_sha256: input.checksum_sha256,
        p_idempotency_key: input.idempotency_key,
      });
      if (!result.ok) return result;
      if (typeof result.data !== "object" || result.data === null || Array.isArray(result.data)) {
        return { ok: false, kind: "unavailable" };
      }
      const response = result.data as Record<string, unknown>;
      const stage = projectStage(response.stage);
      return typeof response.replayed === "boolean" && stage !== null
        ? { ok: true, data: { stage, replayed: response.replayed } }
        : { ok: false, kind: "unavailable" };
    },
    async claim(input: ActorRef & {
      stage_id: string; idempotency_key: string;
    }): Promise<StageOperation<WorkerPortraitStage>> {
      const result = await call("direct_entry_claim_worker_portrait_stage", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_stage_id: input.stage_id,
        p_idempotency_key: input.idempotency_key,
      });
      if (!result.ok) return result;
      const data = await readStage(input);
      return data ? { ok: true, data } : { ok: false, kind: "unavailable" };
    },
    release(input: ActorRef & { stage_id: string; idempotency_key: string }) {
      return call("direct_entry_release_worker_portrait_stage", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_stage_id: input.stage_id,
        p_idempotency_key: input.idempotency_key,
      });
    },
    complete(input: ActorRef & {
      stage_id: string; idempotency_key: string; entry_id: string; document_id: string;
    }) {
      return call("direct_entry_complete_worker_document_stage", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_stage_id: input.stage_id,
        p_idempotency_key: input.idempotency_key,
        p_entry_id: input.entry_id,
        p_document_id: input.document_id,
      });
    },
    cancel(input: ActorRef & { stage_id: string }) {
      return call("direct_entry_cancel_worker_portrait_stage", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_stage_id: input.stage_id,
      });
    },
    async recover(input: ActorRef & { stage_id: string }) {
      const result = await call("direct_entry_recover_worker_portrait_stage", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_stage_id: input.stage_id,
      });
      if (!result.ok) return result;
      const data = await readStage(input);
      return data ? { ok: true as const, data } : { ok: false as const, kind: "unavailable" as const };
    },
    async claimExpiredCleanup(input: { claim_token: string; limit: number }) {
      const result = await call("direct_entry_claim_expired_worker_portrait_stage_cleanup", {
        p_claim_token: input.claim_token,
        p_limit: input.limit,
      });
      if (!result.ok) return result;
      return Array.isArray(result.data) && result.data.every((stageId) =>
        typeof stageId === "string" && UUID.test(stageId)
      )
        ? { ok: true as const, data: result.data as string[] }
        : { ok: false as const, kind: "unavailable" as const };
    },
    async completeCleanup(input: { stage_id: string; claim_token: string }) {
      const result = await call("direct_entry_complete_worker_portrait_stage_cleanup", {
        p_stage_id: input.stage_id,
        p_claim_token: input.claim_token,
      });
      return result.ok && result.data === true
        ? { ok: true as const, data: true as const }
        : { ok: false as const, kind: "unavailable" as const };
    },
    async claimSubmissionObjectCleanup(input: { claim_token: string; limit: number }) {
      const result = await call("direct_entry_claim_submission_object_cleanup", {
        p_claim_token: input.claim_token,
        p_limit: input.limit,
      });
      if (!result.ok) return result;
      if (!Array.isArray(result.data)) return { ok: false as const, kind: "unavailable" as const };
      const rows: SubmissionObjectCleanup[] = [];
      for (const value of result.data) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return { ok: false as const, kind: "unavailable" as const };
        }
        const row = value as Record<string, unknown>;
        if (typeof row.cleanup_id !== "string" || !UUID.test(row.cleanup_id) ||
            (row.object_kind !== "PORTRAIT_STAGE" &&
             row.object_kind !== "DOCUMENT_STAGED" && row.object_kind !== "DOCUMENT_FINAL") ||
            (row.stage_id !== null && (typeof row.stage_id !== "string" || !UUID.test(row.stage_id))) ||
            (row.storage_key !== null && typeof row.storage_key !== "string") ||
            (row.object_kind === "PORTRAIT_STAGE"
              ? typeof row.stage_id !== "string" || row.storage_key !== null
              : row.stage_id !== null || typeof row.storage_key !== "string")) {
          return { ok: false as const, kind: "unavailable" as const };
        }
        rows.push({
          cleanup_id: row.cleanup_id,
          object_kind: row.object_kind,
          stage_id: row.stage_id,
          storage_key: row.storage_key,
        });
      }
      return { ok: true as const, data: rows };
    },
    async completeSubmissionObjectCleanup(input: { cleanup_id: string; claim_token: string }) {
      const result = await call("direct_entry_complete_submission_object_cleanup", {
        p_cleanup_id: input.cleanup_id,
        p_claim_token: input.claim_token,
      });
      return result.ok && result.data === true
        ? { ok: true as const, data: true as const }
        : { ok: false as const, kind: "unavailable" as const };
    },
  };

  async function readStage(input: ActorRef & { stage_id: string }): Promise<WorkerPortraitStage | null> {
    const result = await call("direct_entry_get_worker_document_stage", {
      p_auth_subject: input.auth_subject,
      p_app_user_id: input.app_user_id,
      p_stage_id: input.stage_id,
    });
    return result.ok ? projectStage(result.data) : null;
  }
}
