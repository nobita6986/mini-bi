/**
 * P1.7-H04 - Quyet dinh truy cap page cho cac route tung nam sau Pilot Basic Auth.
 *
 * Ham thuan: nhan ActorResolution DA RESOLVE (khong doc env/cookie/DB) va tra ve mot
 * quyet dinh gioi han. Khong nhan actor/capability tu client.
 *
 * Khac voi direct-entry-page-access: /dashboard la dashboard BI chung, nen chi can
 * session + actor mapping hop le, KHONG doi hoi capability Direct Entry.
 */
import type { ActorResolution } from "./direct-entry-v2";

export type SessionPageDecision =
  | "REDIRECT_LOGIN"
  | "ACCOUNT_UNAVAILABLE"
  | "TEMPORARY_UNAVAILABLE"
  | "ALLOW";

export function decideSessionPageAccess(actor: ActorResolution | null): SessionPageDecision {
  if (!actor) return "TEMPORARY_UNAVAILABLE";
  if (actor.ok) return "ALLOW";
  if (actor.reason === "UNAUTHENTICATED") return "REDIRECT_LOGIN";
  if (actor.reason === "ACTOR_MAPPING_MISSING" || actor.reason === "ACTOR_DISABLED") {
    return "ACCOUNT_UNAVAILABLE";
  }
  return "TEMPORARY_UNAVAILABLE";
}
