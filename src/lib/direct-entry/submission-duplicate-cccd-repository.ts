/**
 * P3.1-HF-R1 - Repository boundary cho preflight canh bao CCCD trung.
 *
 * - Chi goi RPC public.direct_entry_submission_duplicate_cccd_preflight (read-only).
 * - auth_subject/app_user_id do server context truyen vao, khong bao gio lay tu client.
 * - Response duoc project chat; malformed/unknown response => unavailable (khong bao gio success).
 * - service-role client chi duoc tao trong module server-only nay.
 */
import "server-only";

import { projectDuplicateCccdPreflight } from "./submission-duplicate-cccd-contract.ts";
import type { DuplicateCccdPreflight } from "./submission-duplicate-cccd-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export type DuplicateCccdPreflightOutcome =
  | { ok: true; data: DuplicateCccdPreflight }
  | { ok: false; kind: "denied" | "not-found" | "invalid" | "unavailable" };

export type DuplicateCccdPreflightInput = ActorRef & { submission_id: string };

export type DuplicateCccdPreflightRepository = {
  preflight(input: DuplicateCccdPreflightInput): Promise<DuplicateCccdPreflightOutcome>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

/**
 * SQLSTATE -> kind. Chi nhan cac ma RPC thuc su dung:
 *   42501 actor/scope/submission scope denied
 *   P0002 submission not found
 *   22023 submission khong con la ban nhap
 * Moi ma khac => unavailable (fail-closed, khong doan y nghia).
 */
export function classifyDuplicateCccdPreflightError(
  error: { code?: string; message?: string },
): "denied" | "not-found" | "invalid" | "unavailable" {
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "22023") return "invalid";
  return "unavailable";
}

export function createDuplicateCccdPreflightRepository(
  rpc?: Rpc,
): DuplicateCccdPreflightRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async preflight(input) {
      try {
        const { data, error } = await callRpc(
          "direct_entry_submission_duplicate_cccd_preflight",
          {
            p_auth_subject: input.auth_subject,
            p_app_user_id: input.app_user_id,
            p_submission_id: input.submission_id,
          },
        );
        if (error) return { ok: false, kind: classifyDuplicateCccdPreflightError(error) };
        const projection = projectDuplicateCccdPreflight(data, {
          submission_id: input.submission_id,
        });
        return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] duplicate CCCD preflight RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
