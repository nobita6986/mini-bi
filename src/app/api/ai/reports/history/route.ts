import "server-only";

/**
 * P1.5-W05-S02 — GET /api/ai/reports/history — durable history (phân trang keyset, projection an toàn).
 * actor lấy từ pilot (server-derived), KHÔNG nhận actor authority từ client.
 */

import { isAiReportsEnabled, PILOT_ACTOR_REF } from "@/lib/ai/gateway/server/config.mjs";
import { errorResponse, jsonResponse } from "@/lib/ai/gateway/server/http.mjs";
import { createReviewService } from "@/lib/ai/gateway/server/review-wiring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_LIMIT = 50;

export async function GET(request: Request) {
  if (!isAiReportsEnabled()) return errorResponse("AI_DISABLED", "AI report generation đang tắt");

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const pageSizeRaw = url.searchParams.get("page_size");
  let pageSize = 20;
  if (pageSizeRaw !== null) {
    pageSize = Number.parseInt(pageSizeRaw, 10);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_LIMIT) {
      return errorResponse("AI_INPUT_INVALID", "page_size phải trong 1.." + PAGE_LIMIT);
    }
  }

  const service = createReviewService();
  const result = await service.history({ actor_ref: PILOT_ACTOR_REF, cursor, page_size: pageSize });
  if (!result.ok) return errorResponse(result.code, result.message);

  return jsonResponse({
    ok: true,
    items: result.items,
    next_cursor: result.next_cursor,
    has_more: result.has_more,
  });
}