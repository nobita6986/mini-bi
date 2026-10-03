/**
 * P1.6-W04-S04C-S02B - Repository boundary cho doc/list change request.
 *
 * - Chi goi hai RPC doc duoc grant: direct_entry_list_change_requests, direct_entry_read_change_request.
 * - Khong doc table truc tiep (.from), khong goi mutation/helper RPC, khong doc truoc DB.
 * - Actor lay tu server session mapping, khong bao gio tu client.
 * - Malformed/unknown response => unavailable (khong bao gio success).
 */
import "server-only";

import {
  projectChangeRequestDetail,
  projectChangeRequestListPage,
} from "./change-request-read-contract.ts";
import type {
  ChangeRequestDetail,
  ChangeRequestListPage,
  ChangeRequestListQuery,
} from "./change-request-read-contract.ts";
import { classifySubmissionTransitionError } from "./submission-transition-repository.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export type ChangeRequestReadOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "denied" | "invalid" | "not-found" | "unavailable" };

/** Cung bang phan loai SQLSTATE voi S01A/S02A de khong lech nhau. */
export const classifyChangeRequestReadError = classifySubmissionTransitionError;

export const CHANGE_REQUEST_READ_RPC_NAMES: readonly string[] = Object.freeze([
  "direct_entry_list_change_requests",
  "direct_entry_read_change_request",
]);

export type ChangeRequestReadRepository = {
  listChangeRequests(input: ActorRef & ChangeRequestListQuery):
    Promise<ChangeRequestReadOutcome<ChangeRequestListPage>>;
  readChangeRequest(input: ActorRef & { request_id: string }):
    Promise<ChangeRequestReadOutcome<ChangeRequestDetail>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

export function createChangeRequestReadRepository(rpc?: Rpc): ChangeRequestReadRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async listChangeRequests(input) {
      try {
        const { data, error } = await callRpc("direct_entry_list_change_requests", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_page_size: input.page_size,
          p_cursor: input.cursor,
          p_state: input.state,
        });
        if (error) {
          const kind = classifyChangeRequestReadError(error);
          return { ok: false, kind: kind === "conflict" ? "unavailable" : kind };
        }
        const projection = projectChangeRequestListPage(data, { page_size: input.page_size });
        return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] change request list RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async readChangeRequest(input) {
      try {
        const { data, error } = await callRpc("direct_entry_read_change_request", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_request_id: input.request_id,
        });
        if (error) {
          const kind = classifyChangeRequestReadError(error);
          return { ok: false, kind: kind === "conflict" ? "unavailable" : kind };
        }
        const projection = projectChangeRequestDetail(data, { request_id: input.request_id });
        return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] change request read RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
