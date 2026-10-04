import "server-only";

/**
 * P1.5-W04 — GET /api/ai/reports/[jobId]: trạng thái job + draft revision (nếu có).
 * Không trả packet, không trả payload provider, không trả raw provider output.
 */

import { isAiReportsEnabled } from "@/lib/ai/gateway/server/config.mjs";
import { errorResponse, jsonResponse } from "@/lib/ai/gateway/server/http.mjs";
import { createServerAiReportGateway } from "@/lib/ai/gateway/server/service.mjs";
import { guardApiSession } from "@/lib/auth/api-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!isAiReportsEnabled()) return errorResponse("AI_DISABLED", "AI report generation đang tắt");

  // P1.7-H04: route nay tung chi duoc bao ve boi Pilot Basic Auth. Sau khi bo Basic Auth,
  // bat buoc xac thuc Supabase session/actor truoc khi cham bat ky du lieu nao.
  const session = await guardApiSession();
  if (!session.ok) return session.response;

  const params = await context.params;
  const jobId = typeof params?.jobId === "string" ? params.jobId : "";
  const gateway = createServerAiReportGateway();
  if (!gateway.ok) return errorResponse(gateway.code, gateway.message);

  const result = await gateway.service.getStatus({ job_id: jobId });
  if (!result.ok) return errorResponse(result.code, result.message);

  const status = result.status ?? {};
  return jsonResponse({
    ok: true,
    job_id: status.job_id,
    status: status.status,
    attempts: status.attempts,
    max_attempts: status.max_attempts,
    error_code: status.error_code ?? null,
    revision_id: status.revision_id ?? null,
    revision: status.revision
      ? {
          revision_id: status.revision.revision_id,
          revision_number: status.revision.revision_number,
          lifecycle_status: status.revision.lifecycle_status,
          contract_version: status.revision.contract_version,
          created_at: status.revision.created_at,
        }
      : null,
  });
}
