/**
 * P3-W06A — Page boundary helper: resolve actor projection cho AppShell.
 *
 * - Tái sử dụng `getDirectEntryActor` từ src/lib/auth/direct-entry-session.ts
 *   (đã qua `resolveDirectEntrySession` + `resolveActor`).
 * - Chỉ lộ ra client các field cần cho nav: `app_user_id`, `capabilities`,
 *   `scopes` (kind only). KHÔNG lộ `auth_subject`, email, recruiter_suggestion
 *   hay bất kỳ PII nào khác.
 * - Nếu session resolve fail hoặc actor disabled → trả về `null`. AppShell
 *   sẽ chỉ render Dashboard (fail-closed cho Direct Entry).
 *
 * Hàm này chỉ được gọi từ Server Component (page/layout boundary).
 */

import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import type { NavActorProjection } from "@/lib/navigation/registry-capability";

export async function resolveNavActorForAppShell(): Promise<NavActorProjection | null> {
  const result = await getDirectEntryActor(createDirectEntryActorRepository());
  if (!result.actor.ok) return null;
  return {
    app_user_id: result.actor.actor.app_user_id,
    capabilities: result.actor.actor.capabilities,
    scopes: result.actor.actor.scopes.map((scope) => ({ kind: scope.kind })),
  };
}