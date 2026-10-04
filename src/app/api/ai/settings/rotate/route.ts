import "server-only";

/**
 * P1.5-W04A — POST /api/ai/settings/rotate — xoay API key (version mới, nonce mới, AAD mới).
 * KHÔNG giải mã key cũ; version mới bắt đầu ở trạng thái draft (chưa active tới khi test + activate).
 */

import { PILOT_ACTOR_REF } from "@/lib/ai-config/settings-flag.ts";
import { guardSettingsRequest, settingsError, settingsJson } from "@/lib/ai-config/server/route-helpers.mjs";
import { readSettingsJsonBody } from "@/lib/ai-config/server/route-body";
import { createSettingsWiring } from "@/lib/ai-config/server/settings-wiring";
import { guardApiSession } from "@/lib/auth/api-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const guard = guardSettingsRequest(request, { mutation: true, actor_ref: PILOT_ACTOR_REF });
  if (!guard.ok) return guard.response;

  // P1.7-H04: route nay tung chi duoc bao ve boi Pilot Basic Auth. Sau khi bo Basic Auth,
  // bat buoc xac thuc Supabase session/actor truoc khi cham bat ky du lieu nao.
  const session = await guardApiSession();
  if (!session.ok) return session.response;

  const wired = createSettingsWiring();
  if (!wired.ok) return settingsError(wired.code, wired.message);

  const body = await readSettingsJsonBody(request);
  if (!body.ok) return settingsError(body.code, body.message);

  const result = await wired.service.rotate(body.value);
  if (!result.ok) return settingsError(result.code, result.message);
  return settingsJson({ ok: true, config: result.config });
}
