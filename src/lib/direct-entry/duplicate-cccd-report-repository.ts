/**
 * P3.1-HF-R3 - Repository boundary cho bao cao CCCD trung.
 *
 * - Chi goi MOT RPC doc duoc grant: public.direct_entry_duplicate_cccd_report (#74).
 * - Khong doc table truc tiep (.from), khong goi helper/audience RPC.
 * - auth_subject/app_user_id do server session mapping truyen vao, khong bao gio tu client.
 * - Payload duoc project chat (xac nhan key RPC, bo authority/project_id); malformed/unknown
 *   response => unavailable (khong bao gio success).
 * - service-role client chi duoc tao trong module server-only nay.
 */
import "server-only";

import { projectDuplicateCccdReportRpcPage } from "./duplicate-cccd-report-contract.ts";
import type {
  DuplicateCccdReportPage,
  DuplicateCccdReportQuery,
} from "./duplicate-cccd-report-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export const DUPLICATE_CCCD_REPORT_RPC_NAMES: readonly string[] = Object.freeze([
  "direct_entry_duplicate_cccd_report",
]);

export type DuplicateCccdReportOutcome =
  | { ok: true; data: DuplicateCccdReportPage }
  | { ok: false; kind: "denied" | "invalid" | "unavailable" };

export type DuplicateCccdReportInput = ActorRef & DuplicateCccdReportQuery;

export type DuplicateCccdReportRepository = {
  report(input: DuplicateCccdReportInput): Promise<DuplicateCccdReportOutcome>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

/**
 * SQLSTATE -> kind. Chi nhan cac ma RPC thuc su dung:
 *   42501 actor/scope/authority denied (mapping, khong duoc phep, thieu all scope)
 *   22023 page/page_size ngoai bien (route da chan truoc; giu de fail-closed)
 * Moi ma khac => unavailable (fail-closed, khong doan y nghia).
 */
export function classifyDuplicateCccdReportError(
  error: { code?: string; message?: string },
): "denied" | "invalid" | "unavailable" {
  if (error.code === "42501") return "denied";
  if (error.code === "22023") return "invalid";
  return "unavailable";
}

export function createDuplicateCccdReportRepository(rpc?: Rpc): DuplicateCccdReportRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async report(input) {
      try {
        const { data, error } = await callRpc("direct_entry_duplicate_cccd_report", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_page: input.page,
          p_page_size: input.page_size,
        });
        if (error) return { ok: false, kind: classifyDuplicateCccdReportError(error) };
        const page = projectDuplicateCccdReportRpcPage(data, {
          page: input.page,
          page_size: input.page_size,
        });
        return page ? { ok: true, data: page } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] duplicate CCCD report RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
