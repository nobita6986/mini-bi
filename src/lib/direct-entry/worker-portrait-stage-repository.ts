import "server-only";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export type WorkerPortraitStage = {
  stage_id: string;
  mime_type: "image/jpeg" | "image/png";
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

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

function classify(error: { code?: string }): StageOperation<never> {
  if (error.code === "42501") return { ok: false, kind: "denied" };
  if (error.code === "40001") return { ok: false, kind: "conflict" };
  if (error.code === "22023" || error.code === "23514") return { ok: false, kind: "invalid" };
  return { ok: false, kind: "unavailable" };
}

function projectStage(value: unknown): WorkerPortraitStage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const stage = value as Record<string, unknown>;
  const keys = [
    "stage_id", "mime_type", "size_bytes", "checksum_sha256", "status",
    "claim_idempotency_key", "entry_id", "document_id",
  ];
  if (Object.keys(stage).sort().join(",") !== keys.sort().join(",") ||
      typeof stage.stage_id !== "string" ||
      (stage.mime_type !== "image/jpeg" && stage.mime_type !== "image/png") ||
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
      stage_id: string; mime_type: "image/jpeg" | "image/png";
      size_bytes: number; checksum_sha256: string;
    }): Promise<StageOperation<WorkerPortraitStage>> {
      const result = await call("direct_entry_create_worker_portrait_stage", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_stage_id: input.stage_id,
        p_mime_type: input.mime_type,
        p_size_bytes: input.size_bytes,
        p_checksum_sha256: input.checksum_sha256,
      });
      if (!result.ok) return result;
      const data = projectStage(result.data);
      return data ? { ok: true, data } : { ok: false, kind: "unavailable" };
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
      const data = projectStage(result.data);
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
      return call("direct_entry_complete_worker_portrait_stage", {
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
      const data = projectStage(result.data);
      return data ? { ok: true as const, data } : { ok: false as const, kind: "unavailable" as const };
    },
  };
}
