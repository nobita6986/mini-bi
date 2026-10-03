/**
 * P1.6-W04-S04C-S01A - Repository boundary cho transition submission.
 *
 * - Chi goi RPC public.direct_entry_transition_submission (khong doc/ghi table truc tiep).
 * - auth_subject/app_user_id do server context truyen vao, khong bao gio lay tu client.
 * - Response duoc project chat; malformed/unknown response => unavailable (khong bao gio success).
 * - service-role client chi duoc tao trong module server-only nay.
 */
import "server-only";

import { projectSubmissionTransitionResult } from "./submission-transition-contract.ts";
import type {
  SubmissionState,
  SubmissionTransitionResult,
} from "./submission-transition-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export type SubmissionTransitionOutcome<T = SubmissionTransitionResult> =
  | { ok: true; data: T }
  | { ok: false; kind: "conflict" | "denied" | "invalid" | "not-found" | "unavailable" };

export type SubmissionTransitionInput = ActorRef & {
  submission_id: string;
  expected_version: number;
  target_state: SubmissionState;
  idempotency_key: string;
};

export type SubmissionTransitionRepository = {
  transitionSubmission(
    input: SubmissionTransitionInput,
  ): Promise<SubmissionTransitionOutcome<SubmissionTransitionResult>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

/**
 * SQLSTATE -> kind. Chi nhan cac ma RPC thuc su dung:
 *   40001 stale OCC, mutation khong hop le hoac SUBMITTED terminal
 *   23505 idempotency unique
 *   42501 capability/scope/submission scope denied
 *   P0002 submission not found
 *   23514 submission rong (khong con entry nao)
 *   22023 idempotency key sai hoac no-op transition; rieng message reuse-khac-payload la conflict
 * Moi ma khac => unavailable (fail-closed, khong doan y nghia).
 */
export function classifySubmissionTransitionError(
  error: { code?: string; message?: string },
): "conflict" | "denied" | "invalid" | "not-found" | "unavailable" {
  if (error.code === "40001") return "conflict";
  if (error.code === "23505") return "conflict";
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "23514") return "invalid";
  if (error.code === "22023") {
    return error.message === "idempotency key reused with different input" ? "conflict" : "invalid";
  }
  return "unavailable";
}

export function createSubmissionTransitionRepository(
  rpc?: Rpc,
): SubmissionTransitionRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async transitionSubmission(input) {
      try {
        const { data, error } = await callRpc("direct_entry_transition_submission", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_submission_id: input.submission_id,
          p_expected_version: input.expected_version,
          p_target_state: input.target_state,
          p_idempotency_key: input.idempotency_key,
        });
        if (error) return { ok: false, kind: classifySubmissionTransitionError(error) };
        const projection = projectSubmissionTransitionResult(data, {
          submission_id: input.submission_id,
          expected_version: input.expected_version,
        });
        return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] submission transition RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
