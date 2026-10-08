/**
 * P2.5-HF-R3 - repository boundary cho sua truc tiep ho so da gui.
 *
 * - Chi goi MOT RPC duoc grant: direct_entry_privileged_edit.
 * - Khong doc/ghi table truc tiep, khong tu danh gia quyen: capability + scope do DB quyet dinh.
 * - Actor lay tu server session mapping, khong bao gio tu client.
 * - Raw DB message khong bao gio duoc forward; ma loi an toan duoc anh xa o day.
 */
import "server-only";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export type PrivilegedEditResult = { entry_id: string; version: number };

export type PrivilegedEditOutcome =
  | { ok: true; data: PrivilegedEditResult }
  | { ok: false; kind: "conflict" | "denied" | "invalid" | "not-found" | "unavailable"; code: string };

export const PRIVILEGED_EDIT_RPC_NAMES: readonly string[] = Object.freeze([
  "direct_entry_privileged_edit",
]);

/** Episode guard messages (#58-#60) keep their public codes on this path too. */
const SAFE_GUARD_CODES: Record<string, string> = {
  worker_active_episode_exists: "WORKER_ACTIVE_EPISODE_EXISTS",
  worker_episode_reopen_forbidden: "WORKER_EPISODE_REOPEN_FORBIDDEN",
};

export function classifyPrivilegedEditError(
  error: { code?: string; message?: string },
): PrivilegedEditOutcome {
  if (error.code === "42501") {
    const stateLock = typeof error.message === "string" &&
      error.message.includes("draft or submitted");
    return { ok: false, kind: "denied",
      code: stateLock ? "PRIVILEGED_EDIT_STATE_LOCKED" : "PRIVILEGED_EDIT_DENIED" };
  }
  if (error.code === "40001") return { ok: false, kind: "conflict", code: "VERSION_CONFLICT" };
  if (error.code === "22023" || error.code === "23514" || error.code === "22008") {
    return { ok: false, kind: "invalid", code: "PRIVILEGED_EDIT_INVALID" };
  }
  if (error.code === "23505") {
    const alias = typeof error.message === "string" ? SAFE_GUARD_CODES[error.message] : undefined;
    return { ok: false, kind: "conflict", code: alias ?? "PRIVILEGED_EDIT_CONFLICT" };
  }
  if (error.code === "P0002") return { ok: false, kind: "not-found", code: "ENTRY_NOT_FOUND" };
  return { ok: false, kind: "unavailable", code: "PRIVILEGED_EDIT_UNAVAILABLE" };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Strict result projection: exact keys, exact types, matching entry. */
function projectResult(value: unknown, entryId: string): PrivilegedEditResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("entry_id") || !keys.includes("version")) return null;
  if (typeof record.entry_id !== "string" || record.entry_id !== entryId) return null;
  if (typeof record.version !== "number" || !Number.isInteger(record.version) ||
      record.version < 1) return null;
  return { entry_id: record.entry_id, version: record.version };
}

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

export type PrivilegedEditRepository = {
  edit(input: ActorRef & {
    entry_id: string; expected_version: number; patch: Record<string, unknown>;
    reason: string; idempotency_key: string;
  }): Promise<PrivilegedEditOutcome>;
};

export function createPrivilegedEditRepository(rpc?: Rpc): PrivilegedEditRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async edit(input) {
      if (!UUID.test(input.entry_id) || !UUID.test(input.auth_subject) ||
          !UUID.test(input.app_user_id)) {
        return { ok: false, kind: "invalid", code: "PRIVILEGED_EDIT_INVALID" };
      }
      try {
        const { data, error } = await callRpc("direct_entry_privileged_edit", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
          p_expected_version: input.expected_version,
          p_patch: input.patch,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        });
        if (error) return classifyPrivilegedEditError(error);
        const result = projectResult(data, input.entry_id);
        return result
          ? { ok: true, data: result }
          : { ok: false, kind: "unavailable", code: "PRIVILEGED_EDIT_UNAVAILABLE" };
      } catch {
        console.error("[direct-entry] privileged edit RPC failed");
        return { ok: false, kind: "unavailable", code: "PRIVILEGED_EDIT_UNAVAILABLE" };
      }
    },
  };
}
