import "server-only";

/**
 * P1.5-W05-S02 — GET /api/ai/reports/capability
 *
 * - `ai_enabled`: AI_REPORTS_ENABLED=true?
 * - `config_ready`: có provider config active + verified (đọc projection, KHÔNG đọc envelope/secret)?
 * - `review`: phản ánh RPC review THỰC SỰ khả dụng — approve/reject chỉ true khi migration review
 *   đã được apply; RPC chưa tồn tại/lỗi ⇒ fail-closed approve=false, reject=false.
 */

import { isAiReportsEnabled } from "@/lib/ai/gateway/server/config.mjs";
import { jsonResponse } from "@/lib/ai/gateway/server/http.mjs";
import { createServerAiReviewService } from "@/lib/ai/gateway/server/review.mjs";
import { createSupabaseProviderConfigStore } from "@/lib/ai-config/server/store.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const aiEnabled = isAiReportsEnabled();

  let configReady = false;
  try {
    const store = createSupabaseProviderConfigStore();
    const active = await store.readActiveProjection();
    configReady = active.ok === true && active.config !== null && active.config !== undefined;
  } catch {
    configReady = false;
  }

  let review = { approve: false, reject: false, regenerate: true };
  try {
    review = await createServerAiReviewService().capability();
  } catch {
    review = { approve: false, reject: false, regenerate: true };
  }

  return jsonResponse({
    ok: true,
    ai_enabled: aiEnabled,
    config_ready: configReady,
    review: { approve: review.approve, reject: review.reject, regenerate: review.regenerate, reason: "review_rpc_ready" },
  });
}
