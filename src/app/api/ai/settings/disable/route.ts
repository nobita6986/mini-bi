import "server-only";

/**
 * P1.5-W04A — POST /api/ai/settings/disable — tắt một version (giữ nguyên bản ghi để audit).
 * Job đã đóng băng version này sẽ fail-closed ở worker (không âm thầm đổi model/key).
 */

import { PILOT_ACTOR_REF } from "@/lib/ai-config/settings-flag.ts";
import { guardSettingsRequest, readSettingsBody, settingsError, settingsJson } from "@/lib/ai-config/server/route-helpers.mjs";
import { createSettingsWiring } from "@/lib/ai-config/server/settings-wiring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const guard = guardSettingsRequest(request, { mutation: true, actor_ref: PILOT_ACTOR_REF });
  if (!guard.ok) return guard.response;

  const wired = createSettingsWiring();
  if (!wired.ok) return settingsError(wired.code, wired.message);

  const body = await readSettingsBody(request);
  if (!body.ok) return settingsError(body.code, body.message);

  const result = await wired.service.disable(body.value);
  if (!result.ok) return settingsError(result.code, result.message);
  return settingsJson({ ok: true, config: result.config });
}
