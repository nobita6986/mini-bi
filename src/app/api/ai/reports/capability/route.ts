import "server-only";

/**
 * P1.5-W05-S01 — GET /api/ai/reports/capability
 *
 * Cho client biết AI report có khả dụng không TRƯỚC khi mở form (fail-closed, không chạm provider):
 * - `ai_enabled`: AI_REPORTS_ENABLED=true?
 * - `config_ready`: có provider config active + verified (đọc projection, KHÔNG đọc envelope/secret)?
 * - `review`: khả năng duyệt/từ chối/regenerate. approve/reject CHƯA khả dụng vì chưa có RPC duyệt
 *   revision (blocker W05 — báo T0); regenerate đã có sẵn.
 */

import { isAiReportsEnabled } from "@/lib/ai/gateway/server/config.mjs";
import { jsonResponse } from "@/lib/ai/gateway/server/http.mjs";
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

  return jsonResponse({
    ok: true,
    ai_enabled: aiEnabled,
    config_ready: configReady,
    review: {
      approve: false,
      reject: false,
      regenerate: true,
      reason: "review_rpc_pending",
    },
  });
}
