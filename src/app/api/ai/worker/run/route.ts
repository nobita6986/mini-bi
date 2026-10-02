import "server-only";

/**
 * P1.5-W04 — POST /api/ai/worker/run: internal worker boundary (bounded).
 *
 * - Bảo vệ kép: pilot access gate (proxy) + token `AI_WORKER_TOKEN` (constant-time).
 * - DB queue là authority; route này chỉ chạy tối đa N job rồi trả kết quả tóm tắt.
 * - Chưa bật scheduler/live provider ở task này (W05/ops sẽ gọi).
 */

import { checkWorkerToken, isAiReportsEnabled } from "@/lib/ai/gateway/server/config.mjs";
import { errorResponse, jsonResponse, readJsonBody } from "@/lib/ai/gateway/server/http.mjs";
import { createServerAiReportGateway } from "@/lib/ai/gateway/server/service.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface WorkerResult {
  kind: string;
  job_id: string | null;
  status: string | null;
  error_code: string | null;
  revision_id: string | null;
  attempts: number | null;
}

export async function POST(request: Request) {
  if (!isAiReportsEnabled()) return errorResponse("AI_DISABLED", "AI report generation đang tắt");

  const tokenCheck = checkWorkerToken(request.headers.get("x-ai-worker-token"));
  if (!tokenCheck.ok) return errorResponse(tokenCheck.code, tokenCheck.message);

  const body = await readJsonBody(request);
  if (!body.ok) return errorResponse(body.code, body.message);

  const gateway = createServerAiReportGateway();
  if (!gateway.ok) return errorResponse(gateway.code, gateway.message);

  const result = await gateway.service.runWorker({
    worker_ref: "internal-worker",
    limit: body.value.limit,
  });
  if (!result.ok) return errorResponse(result.code, result.message);

  return jsonResponse({
    ok: true,
    processed: result.results.length,
    results: (result.results as WorkerResult[]).map((row) => ({
      kind: row.kind,
      job_id: row.job_id,
      status: row.status,
      error_code: row.error_code,
      revision_id: row.revision_id,
      attempts: row.attempts,
    })),
  });
}
