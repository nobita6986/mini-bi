import "server-only";

/**
 * P1.5-W04 — POST /api/ai/reports: enqueue-or-reuse một generation job.
 *
 * Thứ tự bắt buộc (fail closed):
 *   1. feature flag (production thiếu AI_REPORTS_ENABLED=true ⇒ AI_DISABLED trước DB/config)
 *   2. CSRF/origin guard cho mutation từ browser
 *   3. config provider/policy
 *   4. enqueue (policy → packet → DB) và trả request_id NGAY; KHÔNG chờ provider.
 *
 * Route nằm sau pilot access gate (proxy matcher) và không trả packet/analysis.
 */

import { after } from "next/server";

import {
  PILOT_ACTOR_REF,
  checkSameOriginRequest,
  isAiReportsEnabled,
} from "@/lib/ai/gateway/server/config.mjs";
import { errorResponse, jsonResponse, readJsonBody } from "@/lib/ai/gateway/server/http.mjs";
import { createServerAiReportGateway } from "@/lib/ai/gateway/server/service.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  if (!isAiReportsEnabled()) {
    return errorResponse("AI_DISABLED", "AI report generation đang tắt");
  }

  const originCheck = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!originCheck.ok) return errorResponse(originCheck.code, originCheck.message);

  const body = await readJsonBody(request);
  if (!body.ok) return errorResponse(body.code, body.message);

  const gateway = createServerAiReportGateway();
  if (!gateway.ok) return errorResponse(gateway.code, gateway.message);

  const result = await gateway.service.enqueueReport({
    input: body.value,
    actor_ref: gateway.actor_ref ?? PILOT_ACTOR_REF,
    access_scope_hash: gateway.access_scope_hash,
    provider_key: gateway.provider_key,
    model_key: gateway.model_key,
    adapter_version: gateway.adapter_version,
  });
  if (!result.ok) return errorResponse(result.code, result.message);

  /**
   * Fast-path tuỳ chọn: xử lý tuần tự tối đa hai job sau khi response xong.
   * Giới hạn nhỏ này cho phép queue tự dọn một job cũ bị lỗi cấu hình trước job vừa tạo,
   * trong khi provider concurrency vẫn do DB/policy giữ ở mức một.
   * `after()` KHÔNG phải durability guarantee — job vẫn nằm trong DB queue và scheduler/ops
   * gọi /api/ai/worker/run để xử lý tiếp. Mặc định TẮT.
   */
  if (process.env.AI_INLINE_WORKER_ENABLED === "true" && !result.cache_hit && result.revision_id === null) {
    after(async () => {
      const inline = createServerAiReportGateway();
      if (!inline.ok) return;
      await inline.service.runWorker({ worker_ref: "inline-after", limit: 2 });
    });
  }

  return jsonResponse(
    {
      ok: true,
      request_id: result.job_id,
      job_id: result.job_id,
      status: result.status,
      reused: result.reused === true,
      cache_hit: result.cache_hit === true,
      revision_id: result.revision_id ?? null,
    },
    202
  );
}
