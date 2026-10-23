/**
 * HF Duplicate CCCD Self-Service Actions - Repository boundary cho tu rut trung ho so.
 *
 * - Chi goi MOT RPC duoc grant: public.direct_entry_self_withdraw_duplicate_cccd.
 * - Khong doc/ghi table truc tiep (.from), khong tu suy quyen tren application.
 * - auth_subject/app_user_id do server session mapping truyen vao, khong bao gio tu client.
 * - Ket qua duoc project chat (`{ entry_id, version }`); raw DB message khong bao gio ro ri.
 */
import "server-only";

import {
  projectDuplicateCccdSelfWithdrawRpcResult,
  type DuplicateCccdSelfWithdrawResult,
} from "./duplicate-cccd-report-contract.ts";
import { isUuid } from "../http/direct-entry-api-guard.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export const DUPLICATE_CCCD_SELF_WITHDRAW_RPC_NAMES: readonly string[] = Object.freeze([
  "direct_entry_self_withdraw_duplicate_cccd",
]);

export type DuplicateCccdSelfWithdrawOutcome =
  | { ok: true; data: DuplicateCccdSelfWithdrawResult }
  | {
      ok: false;
      kind: "conflict" | "denied" | "invalid" | "not-found" | "unavailable";
      code: string;
    };

export type DuplicateCccdSelfWithdrawInput = ActorRef & {
  entry_id: string;
  expected_version: number;
  reason: string | null;
  idempotency_key: string;
};

export type DuplicateCccdSelfWithdrawRepository = {
  selfWithdraw(input: DuplicateCccdSelfWithdrawInput): Promise<DuplicateCccdSelfWithdrawOutcome>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await client).rpc(name, args);
}

export function classifyDuplicateCccdSelfWithdrawError(
  error: { code?: string; message?: string },
): Exclude<DuplicateCccdSelfWithdrawOutcome, { ok: true }> {
  if (error.code === "42501") {
    return { ok: false, kind: "denied", code: "SELF_WITHDRAW_DENIED" };
  }
  if (error.code === "P0002") {
    return { ok: false, kind: "not-found", code: "ENTRY_NOT_FOUND" };
  }
  if (error.code === "40001") {
    const msg = typeof error.message === "string" ? error.message.toLowerCase() : "";
    if (msg.includes("already voided")) {
      return { ok: false, kind: "conflict", code: "ENTRY_ALREADY_VOIDED" };
    }
    if (msg.includes("not an active duplicate")) {
      return { ok: false, kind: "conflict", code: "DUPLICATE_NO_LONGER_ACTIVE" };
    }
    if (msg.includes("idempotency")) {
      return { ok: false, kind: "conflict", code: "IDEMPOTENCY_CONFLICT" };
    }
    return { ok: false, kind: "conflict", code: "VERSION_CONFLICT" };
  }
  if (error.code === "22023" || error.code === "23514") {
    return { ok: false, kind: "invalid", code: "SELF_WITHDRAW_INVALID" };
  }
  return { ok: false, kind: "unavailable", code: "SELF_WITHDRAW_UNAVAILABLE" };
}

export function createDuplicateCccdSelfWithdrawRepository(
  rpc?: Rpc,
): DuplicateCccdSelfWithdrawRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async selfWithdraw(input) {
      if (!isUuid(input.entry_id) || !isUuid(input.auth_subject) || !isUuid(input.app_user_id)) {
        return { ok: false, kind: "invalid", code: "SELF_WITHDRAW_INVALID" };
      }
      try {
        const { data, error } = await callRpc("direct_entry_self_withdraw_duplicate_cccd", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
          p_expected_version: input.expected_version,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        });
        if (error) return classifyDuplicateCccdSelfWithdrawError(error);
        const result = projectDuplicateCccdSelfWithdrawRpcResult(data, input.entry_id);
        return result
          ? { ok: true, data: result }
          : { ok: false, kind: "unavailable", code: "SELF_WITHDRAW_UNAVAILABLE" };
      } catch {
        console.error("[direct-entry] duplicate CCCD self-withdraw RPC failed");
        return { ok: false, kind: "unavailable", code: "SELF_WITHDRAW_UNAVAILABLE" };
      }
    },
  };
}
