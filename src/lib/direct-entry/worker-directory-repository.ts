/**
 * P2.5-W03 - Repository boundary cho worker directory.
 *
 * - Chi goi MOT RPC doc duoc grant: direct_entry_list_workers (#52).
 * - Khong doc table truc tiep (.from), khong goi helper/audience/assignment RPC.
 * - Actor lay tu server session mapping, khong bao gio tu client.
 * - Audience/filter/paging do RPC quyet dinh; projection o day chi xac nhan shape.
 * - Malformed/unknown response => unavailable (khong bao gio success).
 */
import "server-only";

import { projectWorkerDirectoryPage } from "./worker-directory-contract.ts";
import type { WorkerDirectoryPage, WorkerDirectoryQuery } from "./worker-directory-contract.ts";
import { classifySubmissionTransitionError } from "./submission-transition-repository.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export type WorkerDirectoryOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "denied" | "invalid" | "not-found" | "unavailable" };

/** Cung bang phan loai SQLSTATE voi cac read/mutation boundary khac. */
export const classifyWorkerDirectoryError = classifySubmissionTransitionError;

export const WORKER_DIRECTORY_RPC_NAMES: readonly string[] = Object.freeze([
  "direct_entry_list_workers",
]);

export type WorkerDirectoryRepository = {
  listWorkers(input: ActorRef & WorkerDirectoryQuery): Promise<WorkerDirectoryOutcome<WorkerDirectoryPage>>;
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

export function createWorkerDirectoryRepository(rpc?: Rpc): WorkerDirectoryRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async listWorkers(input) {
      try {
        const { data, error } = await callRpc("direct_entry_list_workers", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_scope: input.scope,
          p_project_id: input.project_id,
          p_recruiter_id: input.recruiter_id,
          p_employment_status: input.employment_status,
          p_cursor: input.cursor,
          p_page_size: input.page_size,
        });
        if (error) return { ok: false, kind: normalizeKind(classifyWorkerDirectoryError(error)) };
        const page = projectWorkerDirectoryPage(data, {
          scope: input.scope,
          page_size: input.page_size,
        });
        return page ? { ok: true, data: page } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] worker directory RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
