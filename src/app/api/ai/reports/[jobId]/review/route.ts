import "server-only";

/**
 * P1.5-W05-S02 — POST /api/ai/reports/[jobId]/review — approve/reject draft revision.
 * Sau pilot gate; CSRF/origin cho mutation; body projection nghiêm ngặt; decision chỉ approve|reject.
 */

import { isAiReportsEnabled, PILOT_ACTOR_REF } from "@/lib/ai/gateway/server/config.mjs";
import { checkSameOriginRequest } from "@/lib/ai/gateway/http-guards.mjs";
import { errorResponse, jsonResponse } from "@/lib/ai/gateway/server/http.mjs";
import { createReviewService } from "@/lib/ai/gateway/server/review-wiring";
import { projectReviewRequest } from "@/lib/ai-report/review-projection";
import { guardApiSession } from "@/lib/auth/api-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!isAiReportsEnabled()) return errorResponse("AI_DISABLED", "AI report generation đang tắt");

  // P1.7-H04: route nay tung chi duoc bao ve boi Pilot Basic Auth. Sau khi bo Basic Auth,
  // bat buoc xac thuc Supabase session/actor truoc khi cham bat ky du lieu nao.
  const session = await guardApiSession();
  if (!session.ok) return session.response;

  const originCheck = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!originCheck.ok) return errorResponse(originCheck.code, originCheck.message);

  const params = await context.params;
  const jobId = typeof params?.jobId === "string" ? params.jobId : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
    return errorResponse("AI_INPUT_INVALID", "job_id không hợp lệ");
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return errorResponse("AI_INPUT_INVALID", "body không phải JSON hợp lệ");
  }
  const parsed = projectReviewRequest(body);
  if (!parsed.ok) return errorResponse(parsed.code, parsed.message);

  const service = createReviewService();
  const result = parsed.decision === "approve"
    ? await service.approve({ job_id: jobId, expected_revision_number: parsed.expected_revision_number, actor_ref: PILOT_ACTOR_REF })
    : await service.reject({ job_id: jobId, expected_revision_number: parsed.expected_revision_number, actor_ref: PILOT_ACTOR_REF, reason: parsed.reason ?? "" });

  if (!result.ok) return errorResponse(result.code, result.message);
  return jsonResponse({
    ok: true,
    revision_id: result.revision_id,
    lifecycle_status: result.lifecycle_status,
    idempotent: result.idempotent,
  });
}