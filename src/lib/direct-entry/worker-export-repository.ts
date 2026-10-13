/**
 * PRE-W2-P1 - Repository boundary cho xuat Excel full-PII.
 *
 * - Chi goi MOT RPC duoc grant: public.direct_entry_export_workers (#86).
 * - Khong doc table truc tiep (.from), khong goi direct_entry_read_projection (khong N+1).
 * - Actor lay tu server session mapping, khong bao gio tu client.
 * - Envelope duoc project chat; malformed/unknown => unavailable (khong bao gio success).
 * - service-role client chi duoc tao trong module server-only nay.
 */
import "server-only";

import { projectWorkerExportEnvelope } from "./worker-export-contract.ts";
import type { WorkerExportEnvelope, WorkerExportRequest } from "./worker-export-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export const WORKER_EXPORT_RPC_NAMES: readonly string[] = Object.freeze([
  "direct_entry_export_workers",
]);

export type WorkerExportOutcome =
  | { ok: true; envelope: WorkerExportEnvelope }
  | { ok: false; kind: "denied" | "invalid" | "unavailable" };

export type WorkerExportInput = ActorRef & WorkerExportRequest;

export type WorkerExportRepository = {
  exportWorkers(input: WorkerExportInput): Promise<WorkerExportOutcome>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

/**
 * SQLSTATE -> kind:
 *   42501 actor/scope/capability/row authority denied (fail-closed)
 *   22023 invalid filter / reason
 * Moi ma khac => unavailable (fail-closed, khong doan y nghia).
 */
export function classifyWorkerExportError(
  error: { code?: string; message?: string },
): "denied" | "invalid" | "unavailable" {
  if (error.code === "42501") return "denied";
  if (error.code === "22023") return "invalid";
  return "unavailable";
}

export function createWorkerExportRepository(rpc?: Rpc): WorkerExportRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async exportWorkers(input) {
      try {
        const { data, error } = await callRpc("direct_entry_export_workers", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_scope: input.scope,
          p_project_id: input.project_id,
          p_recruiter_id: input.recruiter_id,
          p_employment_status: input.employment_status,
          p_reason: input.reason,
        });
        if (error) return { ok: false, kind: classifyWorkerExportError(error) };
        const envelope = projectWorkerExportEnvelope(data);
        return envelope ? { ok: true, envelope } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] worker export RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
