/**
 * P1.6-W04-S04C-S02A - Repository boundary cho change request.
 *
 * - Chi goi bon RPC duoc grant: direct_entry_create_change_request,
 *   direct_entry_withdraw_change_request, direct_entry_approve_change_request,
 *   direct_entry_reject_change_request.
 * - KHONG goi helper direct_entry_decide_change_request (da bi revoke EXECUTE voi service-role);
 *   approve/reject la hai RPC wrapper mong cua helper do.
 * - Khong table DML, khong doc truoc DB de tu danh gia quyen/trang thai.
 * - Malformed/unknown response => unavailable (khong bao gio success).
 */
import "server-only";

import {
  projectChangeRequestCreated,
  projectChangeRequestStateResult,
} from "./change-request-contract.ts";
import type {
  ChangeRequestCreateResult,
  ChangeRequestDecisionInput,
  ChangeRequestState,
  ChangeRequestStateResult,
  ChangeRequestWithdrawInput,
} from "./change-request-contract.ts";
import { classifySubmissionTransitionError } from "./submission-transition-repository.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export type ChangeRequestOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "conflict" | "denied" | "invalid" | "not-found" | "unavailable" };

/**
 * Cung mot bang phan loai SQLSTATE voi S01A (40001/23505 conflict, 42501 denied, P0002 not-found,
 * 23514/22023 invalid tru khi message la idempotency reuse-khac-payload). Tai su dung thay vi
 * viet bang thu hai de hai boundary khong the lech nhau.
 */
export const classifyChangeRequestError = classifySubmissionTransitionError;

export type ChangeRequestRepository = {
  createChangeRequest(input: ActorRef & {
    items: readonly Record<string, unknown>[];
    reason: string;
    idempotency_key: string;
  }): Promise<ChangeRequestOutcome<ChangeRequestCreateResult>>;
  withdrawChangeRequest(input: ActorRef & { request_id: string } & ChangeRequestWithdrawInput):
    Promise<ChangeRequestOutcome<ChangeRequestStateResult>>;
  approveChangeRequest(input: ActorRef & { request_id: string; expected_version: number;
    reason: string; idempotency_key: string }): Promise<ChangeRequestOutcome<ChangeRequestStateResult>>;
  rejectChangeRequest(input: ActorRef & { request_id: string; expected_version: number;
    reason: string; idempotency_key: string }): Promise<ChangeRequestOutcome<ChangeRequestStateResult>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

const RPC_NAMES = [
  "direct_entry_create_change_request",
  "direct_entry_withdraw_change_request",
  "direct_entry_approve_change_request",
  "direct_entry_reject_change_request",
] as const;

export const CHANGE_REQUEST_RPC_NAMES: readonly string[] = Object.freeze([...RPC_NAMES]);

export function createChangeRequestRepository(rpc?: Rpc): ChangeRequestRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async createChangeRequest(input) {
      try {
        const { data, error } = await callRpc("direct_entry_create_change_request", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_items: input.items,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        });
        if (error) return { ok: false, kind: classifyChangeRequestError(error) };
        const projection = projectChangeRequestCreated(data, input.items.length);
        return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] change request create RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async withdrawChangeRequest(input) {
      try {
        const { data, error } = await callRpc("direct_entry_withdraw_change_request", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_request_id: input.request_id,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
        });
        if (error) return { ok: false, kind: classifyChangeRequestError(error) };
        const projection = projectChangeRequestStateResult(data, {
          request_id: input.request_id,
          expected_version: input.expected_version,
          state: "WITHDRAWN",
        });
        return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] change request withdraw RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async approveChangeRequest(input) {
      return decide(callRpc, "direct_entry_approve_change_request", "APPROVED", input);
    },
    async rejectChangeRequest(input) {
      return decide(callRpc, "direct_entry_reject_change_request", "REJECTED", input);
    },
  };
}

async function decide(
  callRpc: Rpc,
  rpcName: string,
  expectedState: ChangeRequestState,
  input: ActorRef & { request_id: string; expected_version: number; reason: string; idempotency_key: string },
): Promise<ChangeRequestOutcome<ChangeRequestStateResult>> {
  try {
    const { data, error } = await callRpc(rpcName, {
      p_auth_subject: input.auth_subject,
      p_app_user_id: input.app_user_id,
      p_request_id: input.request_id,
      p_expected_version: input.expected_version,
      p_reason: input.reason,
      p_idempotency_key: input.idempotency_key,
    });
    if (error) return { ok: false, kind: classifyChangeRequestError(error) };
    const projection = projectChangeRequestStateResult(data, {
      request_id: input.request_id,
      expected_version: input.expected_version,
      state: expectedState,
    });
    return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
  } catch {
    console.error("[direct-entry] change request decision RPC failed");
    return { ok: false, kind: "unavailable" };
  }
}

export type ChangeRequestDecisionRepositoryInput = ActorRef & ChangeRequestDecisionInput & {
  request_id: string;
};
