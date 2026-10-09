/**
 * P3-W03-S02B-R3A - Pure route decision cho /direct-entry.
 *
 * Nhan du lieu DA RESOLVE (khong doc env/cookies/DB); output la discriminated union gioi han.
 * Khong nhan actor/capability/scope tu client; API/DB van la authority.
 */
import type { ActorResolution } from "./direct-entry-v2";
import type { NavCapabilityPredicate } from "../navigation/registry-capability.ts";
import {
  adminAreaNavPredicate,
  projectAdminNavPredicate,
  workerOperationsNavPredicate,
} from "../navigation/registry-capability.ts";

export type DirectEntryPageDecision =
  | "NOT_FOUND"
  | "REDIRECT_LOGIN"
  | "ACCOUNT_UNAVAILABLE"
  | "TEMPORARY_UNAVAILABLE"
  | "ACCESS_DENIED"
  | "ALLOW";

function decideCapabilityPageAccess(input: {
  actor: ActorResolution | null;
  allowed: NavCapabilityPredicate;
}): DirectEntryPageDecision {
  const actor = input.actor;
  if (!actor) return "TEMPORARY_UNAVAILABLE";
  if (!actor.ok) {
    if (actor.reason === "UNAUTHENTICATED") return "REDIRECT_LOGIN";
    if (actor.reason === "ACTOR_MAPPING_MISSING" || actor.reason === "ACTOR_DISABLED") {
      return "ACCOUNT_UNAVAILABLE";
    }
    return "TEMPORARY_UNAVAILABLE";
  }
  return input.allowed(actor.actor) ? "ALLOW" : "ACCESS_DENIED";
}

/** Server page gate for /admin; not coupled to the Direct Entry UI flag. */
export function decideAdminAreaAccess(input: {
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({
    actor: input.actor,
    allowed: adminAreaNavPredicate,
  });
}

/** Separate direct-URL gate for the implemented Personnel catalog page. */
export function decidePersonnelCatalogPageAccess(input: {
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideAdminAreaAccess(input);
}

const ENTRY_CAPABILITIES = ["entry_own", "entry_team", "entry_admin"] as const;

export function decideDirectEntryPageAccess(input: {
  uiEnabled: boolean;
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  if (!input.uiEnabled) return "NOT_FOUND";
  const actor = input.actor;
  if (!actor) return "TEMPORARY_UNAVAILABLE";
  if (!actor.ok) {
    if (actor.reason === "UNAUTHENTICATED") return "REDIRECT_LOGIN";
    if (actor.reason === "ACTOR_MAPPING_MISSING" || actor.reason === "ACTOR_DISABLED") {
      return "ACCOUNT_UNAVAILABLE";
    }
    return "TEMPORARY_UNAVAILABLE";
  }
  const hasEntryCapability = actor.actor.capabilities.some((capability) =>
    (ENTRY_CAPABILITIES as readonly string[]).includes(capability));
  return hasEntryCapability ? "ALLOW" : "ACCESS_DENIED";
}

/**
 * P2.5-W06A-R1: quyet dinh truy cap cho /direct-entry/projects.
 * Dung CHUNG predicate voi nav (projectAdminNavPredicate) — khong suy dien
 * quyen tu role/email/owner label. entry_own/entry_team KHONG duoc render
 * page roi moi cho API 403: phai ACCESS_DENIED ngay tu server decision.
 */
export function decideProjectOperationsPageAccess(input: {
  uiEnabled: boolean;
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  if (!input.uiEnabled) return "NOT_FOUND";
  const actor = input.actor;
  if (!actor) return "TEMPORARY_UNAVAILABLE";
  if (!actor.ok) {
    if (actor.reason === "UNAUTHENTICATED") return "REDIRECT_LOGIN";
    if (actor.reason === "ACTOR_MAPPING_MISSING" || actor.reason === "ACTOR_DISABLED") {
      return "ACCOUNT_UNAVAILABLE";
    }
    return "TEMPORARY_UNAVAILABLE";
  }
  return projectAdminNavPredicate(actor.actor) ? "ALLOW" : "ACCESS_DENIED";
}

/**
 * P2.5-W06-R1: quyet dinh truy cap cho /direct-entry/workers.
 * Dung CHUNG predicate voi nav (workerOperationsNavPredicate) — khong hai logic lech nhau.
 * Reviewer (change_review + all) duoc vao; reporting audience=all thieu capability bi tu choi.
 */
export function decideWorkerOperationsPageAccess(input: {
  uiEnabled: boolean;
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  if (!input.uiEnabled) return "NOT_FOUND";
  const actor = input.actor;
  if (!actor) return "TEMPORARY_UNAVAILABLE";
  if (!actor.ok) {
    if (actor.reason === "UNAUTHENTICATED") return "REDIRECT_LOGIN";
    if (actor.reason === "ACTOR_MAPPING_MISSING" || actor.reason === "ACTOR_DISABLED") {
      return "ACCOUNT_UNAVAILABLE";
    }
    return "TEMPORARY_UNAVAILABLE";
  }
  return workerOperationsNavPredicate(actor.actor) ? "ALLOW" : "ACCESS_DENIED";
}
