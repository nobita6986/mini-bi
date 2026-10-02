import "server-only";

/**
 * P1.5-W05-S01 — GET /api/ai/reports/[jobId]/analysis
 *
 * Trả TRẠNG THÁI job + NỘI DUNG draft revision (business-analysis/0.1 ĐÃ validate).
 * KHÔNG trả packet, payload provider, prompt nội bộ, raw provider output hay PII.
 * `review_capability`: approve/reject CHƯA khả dụng (blocker W05 — chưa có RPC duyệt revision).
 */

import { isAiReportsEnabled } from "@/lib/ai/gateway/server/config.mjs";
import { errorResponse, jsonResponse } from "@/lib/ai/gateway/server/http.mjs";
import { createServerAiReportGateway } from "@/lib/ai/gateway/server/service.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!isAiReportsEnabled()) return errorResponse("AI_DISABLED", "AI report generation đang tắt");

  const params = await context.params;
  const jobId = typeof params?.jobId === "string" ? params.jobId : "";
  const gateway = createServerAiReportGateway();
  if (!gateway.ok) return errorResponse(gateway.code, gateway.message);

  const result = await gateway.service.getStatus({ job_id: jobId });
  if (!result.ok) return errorResponse(result.code, result.message);

  const status = result.status ?? {};
  const revision = status.revision ?? null;

  if (!revision || !revision.analysis) {
    // Chưa hoàn tất hoặc không có draft: chỉ trả trạng thái job (để client poll).
    return jsonResponse({
      ok: true,
      job_id: status.job_id,
      status: status.status,
      error_code: status.error_code ?? null,
      attempts: status.attempts,
      max_attempts: status.max_attempts,
      revision_id: status.revision_id ?? null,
      revision: null,
      review_capability: { approve: false, reject: false, regenerate: true, reason: "review_rpc_pending" },
    });
  }

  return jsonResponse({
    ok: true,
    job_id: status.job_id,
    status: status.status,
    error_code: status.error_code ?? null,
    revision_id: revision.revision_id,
    revision_number: revision.revision_number,
    lifecycle_status: revision.lifecycle_status,
    contract_version: revision.contract_version,
    created_at: revision.created_at,
    analysis: revision.analysis,
    review_capability: { approve: false, reject: false, regenerate: true, reason: "review_rpc_pending" },
  });
}
