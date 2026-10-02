import "server-only";

/**
 * P1.5-W05-S01-R1 — GET /api/ai/reports/[jobId]/analysis
 *
 * Tra TRANG THAI job + NOI DUNG draft revision (business-analysis/0.1 DA validate).
 * Hop dong response DONG NHAT: luon co attempts/max_attempts va revision la null hoac object
 * day du (khong co field analysis/lifecycle_status roi rac o top-level).
 * KHONG tra packet, payload provider, prompt noi bo, raw provider output hay PII.
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

  const base = {
    ok: true,
    job_id: status.job_id,
    status: status.status,
    error_code: status.error_code ?? null,
    attempts: Number.isInteger(status.attempts) ? status.attempts : 0,
    max_attempts: Number.isInteger(status.max_attempts) ? status.max_attempts : 0,
    review_capability: { approve: false, reject: false, regenerate: true, reason: "review_rpc_pending" },
  };

  if (!revision || !revision.analysis) {
    return jsonResponse({ ...base, revision: null });
  }

  return jsonResponse({
    ...base,
    revision: {
      revision_id: revision.revision_id,
      revision_number: revision.revision_number,
      lifecycle_status: revision.lifecycle_status,
      contract_version: revision.contract_version,
      created_at: revision.created_at,
      analysis: revision.analysis,
    },
  });
}