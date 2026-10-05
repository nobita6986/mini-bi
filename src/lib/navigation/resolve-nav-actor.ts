/**
 * P3-W06A R1 — Request-scoped actor resolution cho page + layout.
 *
 * Muc tieu:
 * - Moi request chi thuc hien mot chuoi Supabase getUser + actor repository
 *   resolution, duoc chia se giua layout (AppShell) va page (route access).
 * - React `cache()` (RSC) dam bao request-scoped: moi render pass goi
 *   resolver 1 lan, nhung request tiep theo van resolve lai (khong leak
 *   actor qua user).
 * - Tuyet doi KHONG dung `unstable_cache` (cross-request) cho actor — do
 *   la PII + role decision, phai theo user hien tai.
 *
 * Refs:
 * - node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md
 *   (React cache: request-scoped memoization).
 * - src/lib/auth/direct-entry-session.ts (Supabase client + resolveActor).
 * - src/lib/auth/direct-entry-session-retry.ts (bounded retry H07).
 *
 * Layout goi `resolveNavActorForAppShell()` de lay `NavActorProjection`;
 * page goi `resolveActorForRequest()` de lay `ActorResolution` day du cho
 * route access decision. Ca hai cung share cache key (request-scoped).
 *
 * `resolveNavActorForAppShell` nhan them flag `directEntryEnabled` de
 * tranh query actor khi UI flag off (Direct Entry layout khong can actor
 * cho nav: `filterEntriesForActor` da filter Direct Entry ra, Dashboard
 * capability "any" luon hien).
 */

import "server-only";

import { cache } from "react";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { resolveSessionWithBoundedRetry } from "@/lib/auth/direct-entry-session-retry";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import type { ActorResolution } from "@/lib/auth/direct-entry-v2";
import type { NavActorProjection } from "@/lib/navigation/registry-capability";

/**
 * Request-scoped resolver: tra ve `ActorResolution` day du (goc tu
 * `resolveDirectEntrySession`).
 *
 * - Request dau tien trong mot render pass goi getDirectEntryActor +
 *   resolveActor + (H07) bounded retry.
 * - Lan goi tiep theo trong cung render pass (layout + page) tra ve
 *   cung ket qua (React cache).
 * - Request moi bat dau render pass moi → resolver chay lai, khong
 *   share actor giua user (React cache khong persist qua request).
 */
export const resolveActorForRequest = cache(
  async (): Promise<ActorResolution> => {
    const result = await resolveSessionWithBoundedRetry(() =>
      getDirectEntryActor(createDirectEntryActorRepository()));
    return result.actor;
  },
);

/**
 * Request-scoped nav projection (chỉ capabilities + scopes.kind).
 *
 * Predicate trong `registry-capability.ts` chi dung `capabilities` + `scopes.kind`
 * (xem `decideNavEntryVisibility`, `directEntryNavPredicate`,
 *  `adminAuthorityNavPredicate`). `app_user_id` khong can cho nav; loai bo
 * khoi projection de giam PII surface (P3-C01 R2 chu truong).
 *
 * - Tra ve `null` neu actor resolution fail (UNAUTHENTICATED, ...) hoac
 *   `directEntryEnabled === false` (tranh query thua khi UI flag off).
 * - Tra ve projection neu actor OK.
 * - Cung dung React cache nhu `resolveActorForRequest` de tranh duplicate
 *   getUser + repository resolution.
 */
export const resolveNavActorForAppShell = cache(
  async (input: { directEntryEnabled: boolean }): Promise<NavActorProjection | null> => {
    if (!input.directEntryEnabled) {
      // P3-W06A R1 yeu cau 9: tranh actor query thua khi UI flag off.
      // Direct Entry nav entry da bi filter boi flag; Dashboard luon hien.
      return null;
    }
    const actor = await resolveActorForRequest();
    if (!actor.ok) return null;
    return {
      capabilities: actor.actor.capabilities,
      scopes: actor.actor.scopes.map((scope) => ({ kind: scope.kind })),
    };
  },
);
