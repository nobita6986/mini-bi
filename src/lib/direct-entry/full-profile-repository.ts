import "server-only";

import type { FullProfilePayload } from "./full-profile-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export type FullProfileRepositoryResult =
  | { ok: true; data: unknown }
  | { ok: false; kind: "conflict" | "denied" | "invalid" | "unavailable"; code?: string };

const SAFE_INVALID_CODES = new Set([
  "BANK_NOT_ACTIVE",
  "BATCH_INVALID",
  "EMPLOYEE_CODE_DUPLICATE",
  "EMPLOYEE_CODE_SEQUENCE_EXHAUSTED",
  "EMPLOYEE_CODE_LEGACY_QUARANTINE",
  "EMPLOYEE_CODE_YEAR",
  "GENERAL_NOTE_TOO_LONG",
  "NATIONAL_ID_DUPLICATE",
  "NATIONAL_ID_INVALID",
  "OFF_REQUIRES_DATE_AND_REASON",
  "PROJECT_NOT_ACTIVE",
  "RECRUITER_NOT_ACTIVE",
  "RECRUITER_MEMBERSHIP_INVALID",
  "PAYMENT_DETAILS_INVALID",
  "PROFILE_DATE_INVALID",
]);

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

function classify(error: { code?: string; message?: string }): FullProfileRepositoryResult {
  if (error.code === "42501") return { ok: false, kind: "denied" };
  if (error.code === "40001" ||
      (error.code === "22023" && error.message === "idempotency key reused with different input")) {
    return { ok: false, kind: "conflict" };
  }
  if (error.code === "22023" || error.code === "22008" || error.code === "23514") {
    const code = error.message && SAFE_INVALID_CODES.has(error.message)
      ? error.message
      : "BATCH_INVALID";
    return { ok: false, kind: "invalid", code };
  }
  if (error.code === "23505") {
    const code = error.message && SAFE_INVALID_CODES.has(error.message)
      ? error.message
      : "BATCH_INVALID";
    return { ok: false, kind: "invalid", code };
  }
  return { ok: false, kind: "unavailable" };
}

export function createFullProfileRepository(rpc?: Rpc) {
  let resolvedRpc = rpc;
  return {
    async createFullProfileBatch(input: ActorRef & {
      payload: FullProfilePayload;
      idempotency_key: string;
    }): Promise<FullProfileRepositoryResult> {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const rpcName = input.payload.contract_version === "worker-profile/1.1"
          ? "direct_entry_create_full_profile_batch_v2"
          : "direct_entry_create_full_profile_batch";
        const { data, error } = await resolvedRpc(rpcName, {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_contract_version: input.payload.contract_version,
          p_rows: input.payload.rows,
          p_idempotency_key: input.idempotency_key,
        });
        return error ? classify(error) : { ok: true, data };
      } catch {
        console.error("[direct-entry] full-profile batch RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
