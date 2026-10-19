import "server-only";

import {
  projectSubmissionDeleteResult,
  type SubmissionDeleteResult,
} from "./submission-delete-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export type SubmissionDeleteOutcome<T = SubmissionDeleteResult> =
  | { ok: true; data: T }
  | { ok: false; kind: "conflict" | "denied" | "invalid" | "not-found" | "processing" | "unavailable" };

export type SubmissionDeleteRepository = {
  deleteDraftSubmission(input: ActorRef & {
    submission_id: string;
    expected_version: number;
    idempotency_key: string;
  }): Promise<SubmissionDeleteOutcome>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

export function classifySubmissionDeleteError(
  error: { code?: string; message?: string },
): Exclude<SubmissionDeleteOutcome, { ok: true }>["kind"] {
  if (error.code === "40001" || error.code === "23505" || error.code === "55000") {
    return "conflict";
  }
  if (error.code === "55P03") return "processing";
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "23514" || error.code === "22023") {
    return error.code === "22023" &&
      error.message === "idempotency key reused with different input"
      ? "conflict"
      : "invalid";
  }
  return "unavailable";
}

export function createSubmissionDeleteRepository(rpc?: Rpc): SubmissionDeleteRepository {
  let resolvedRpc = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async deleteDraftSubmission(input) {
      try {
        const { data, error } = await callRpc("direct_entry_delete_draft_submission", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_submission_id: input.submission_id,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
        });
        if (error) return { ok: false, kind: classifySubmissionDeleteError(error) };
        const projection = projectSubmissionDeleteResult(data, {
          submission_id: input.submission_id,
          expected_version: input.expected_version,
        });
        return projection
          ? { ok: true, data: projection }
          : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] submission deletion RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
