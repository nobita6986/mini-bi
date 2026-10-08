/**
 * P2.5-HF-R1 - repository boundary cho tra cuu episode.
 *
 * - Chi goi MOT RPC doc duoc grant: direct_entry_lookup_worker_episodes (#59).
 * - Khong doc table truc tiep (.from), khong goi helper/assignment/ACL RPC.
 * - Actor lay tu server session mapping, khong bao gio tu client.
 * - Malformed/unknown response => unavailable (khong bao gio success).
 * - Khong log identity, CCCD hay raw error message.
 */
import "server-only";

import { projectWorkerEpisodeLookupPage } from "./worker-episode-lookup-contract.ts";
import type { WorkerEpisodeLookupPage, WorkerEpisodeLookupQuery } from "./worker-episode-lookup-contract.ts";
import { classifySubmissionTransitionError } from "./submission-transition-repository.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export type WorkerEpisodeLookupOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "denied" | "invalid" | "not-found" | "unavailable" };

/** Cung bang phan loai SQLSTATE voi cac read/mutation boundary khac. */
export const classifyWorkerEpisodeLookupError = classifySubmissionTransitionError;

export const WORKER_EPISODE_LOOKUP_RPC_NAMES: readonly string[] = Object.freeze([
  "direct_entry_lookup_worker_episodes",
]);

export type WorkerEpisodeLookupRepository = {
  lookup(input: ActorRef & WorkerEpisodeLookupQuery): Promise<WorkerEpisodeLookupOutcome<WorkerEpisodeLookupPage>>;
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

export function createWorkerEpisodeLookupRepository(rpc?: Rpc): WorkerEpisodeLookupRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async lookup(input) {
      try {
        const { data, error } = await callRpc("direct_entry_lookup_worker_episodes", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_project_id: input.project_id,
          p_display_name: input.display_name,
          p_national_id: input.national_id,
          p_page_size: input.page_size,
          p_offset: input.offset,
        });
        if (error) return { ok: false, kind: normalizeKind(classifyWorkerEpisodeLookupError(error)) };
        const page = projectWorkerEpisodeLookupPage(data, {
          page_size: input.page_size,
          offset: input.offset,
        });
        return page ? { ok: true, data: page } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] worker episode lookup RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
