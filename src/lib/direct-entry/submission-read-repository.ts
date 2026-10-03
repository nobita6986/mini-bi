/**
 * P1.6-W04-S04C-S02C - Repository boundary cho doc/list own submission.
 *
 * - Chi goi hai RPC doc duoc grant: direct_entry_list_own_submissions, direct_entry_read_own_submission.
 * - Khong doc table truc tiep (.from), khong goi transition/change-request/helper RPC.
 * - Actor lay tu server session mapping, khong bao gio tu client.
 * - Malformed/unknown response => unavailable (khong bao gio success).
 */
import "server-only";

import {
  projectSubmissionDetail,
  projectSubmissionListPage,
} from "./submission-read-contract.ts";
import type {
  SubmissionReadDetail,
  SubmissionReadListPage,
  SubmissionReadQuery,
} from "./submission-read-contract.ts";
import { classifySubmissionTransitionError } from "./submission-transition-repository.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export type SubmissionReadOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "denied" | "invalid" | "not-found" | "unavailable" };

/** Cung bang phan loai SQLSTATE voi S01A/S02A/S02B de khong lech nhau. */
export const classifySubmissionReadError = classifySubmissionTransitionError;

export const SUBMISSION_READ_RPC_NAMES: readonly string[] = Object.freeze([
  "direct_entry_list_own_submissions",
  "direct_entry_read_own_submission",
]);

export type SubmissionReadRepository = {
  listOwnSubmissions(input: ActorRef & SubmissionReadQuery):
    Promise<SubmissionReadOutcome<SubmissionReadListPage>>;
  readOwnSubmission(input: ActorRef & { submission_id: string }):
    Promise<SubmissionReadOutcome<SubmissionReadDetail>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

function normalizeKind(kind: "conflict" | "denied" | "invalid" | "not-found" | "unavailable") {
  return kind === "conflict" ? "unavailable" as const : kind;
}

export function createSubmissionReadRepository(rpc?: Rpc): SubmissionReadRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async listOwnSubmissions(input) {
      try {
        const { data, error } = await callRpc("direct_entry_list_own_submissions", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_page_size: input.page_size,
          p_cursor: input.cursor,
          p_state: input.state,
        });
        if (error) return { ok: false, kind: normalizeKind(classifySubmissionReadError(error)) };
        const projection = projectSubmissionListPage(data, { page_size: input.page_size });
        return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] own submission list RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async readOwnSubmission(input) {
      try {
        const { data, error } = await callRpc("direct_entry_read_own_submission", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_submission_id: input.submission_id,
        });
        if (error) return { ok: false, kind: normalizeKind(classifySubmissionReadError(error)) };
        const projection = projectSubmissionDetail(data, { submission_id: input.submission_id });
        return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] own submission read RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
