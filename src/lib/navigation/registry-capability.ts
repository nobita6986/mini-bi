/**
 * P3-W06A — Capability projection cho navigation.
 *
 * Nguyên tắc (P2-P3 R00 §Reuse matrix + P3-C01 §2.1/§2.1a):
 * - Tái sử dụng `CAPABILITIES` từ src/lib/auth/direct-entry-v2.ts (21 token).
 * - Tái sử dụng `DirectEntryActor` shape từ cùng module (đã được `actorProjection`
 *   trong auth-session-core.ts sanitize trước khi lộ ra client).
 * - Không tạo role engine mới: mỗi entry khai báo `capability` metadata
 *   (đã có sẵn trong registry), nav chỉ hỏi "actor có ít nhất một token trong
 *   entry's predicate không?".
 * - Direct Entry nav entry có `capability: "entry_admin"` đại diện cho
 *   "một trong entry_own | entry_team | entry_admin" (registry.ts giải thích).
 *   T1A biến metadata tĩnh đó thành pure predicate resolve từ session thật.
 * - Admin authority rule (P3-C01 §2.1a) là AND của `entry_admin` ∧
 *   `recruiter_master_manage` ∧ `team_master_manage`. Hiện P3 chỉ cần
 *   Direct Entry nav visibility — admin nav entry chưa được đăng ký; nếu
 *   sau này thêm, predicate tương ứng sẽ là adminAuthorityPredicate() ở đây.
 *
 * Tách thành file riêng để:
 * - test thuần với `node:test` (registry.ts chỉ phụ thuộc React, file này thuần).
 * - page boundary (server component) import thẳng — không phải build module mới.
 */

import type { Capability } from "@/lib/auth/direct-entry-v2";

/** Subset các field mà nav cần từ actor projection. */
export type NavActorProjection = {
  capabilities: readonly Capability[];
  scopes: readonly { kind: "own" | "team" | "all" }[];
};

/** Predicate phụ thuộc entry — registry.ts có metadata `capability`. */
export type NavCapabilityPredicate = (actor: NavActorProjection) => boolean;

/** Bộ token "một trong" mà registry metadata `entry_admin` đại diện. */
const DIRECT_ENTRY_ENTRY_CAPABILITIES: readonly Capability[] = [
  "entry_own",
  "entry_team",
  "entry_admin",
];

/** Direct Entry: actor phải có ít nhất một trong entry_own | entry_team | entry_admin. */
export const directEntryNavPredicate: NavCapabilityPredicate = (actor) =>
  actor.capabilities.some((capability) =>
    DIRECT_ENTRY_ENTRY_CAPABILITIES.includes(capability)
  );

/** Admin authority rule (P3-C01 §2.1a): AND của 3 token ở scope `all`. */
export const ADMIN_AUTHORITY_CAPABILITIES: readonly Capability[] = [
  "entry_admin",
  "recruiter_master_manage",
  "team_master_manage",
];

export const adminAuthorityNavPredicate: NavCapabilityPredicate = (actor) => {
  const allScopeGranted = actor.scopes.some((scope) => scope.kind === "all");
  if (!allScopeGranted) return false;
  return ADMIN_AUTHORITY_CAPABILITIES.every((required) =>
    actor.capabilities.includes(required)
  );
};

/**
 * P2.5-W06A-R1: Project Operations authority chinh xac theo DB W02
 * (direct_entry_assert_project_admin) = entry_admin + effective all scope.
 * KHONG yeu cau recruiter_master_manage/team_master_manage (RPC W02 khong yeu cau).
 * Dung CHUNG cho nav visibility va page decision.
 */
export const projectAdminNavPredicate: NavCapabilityPredicate = (actor) =>
  actor.capabilities.includes("entry_admin") &&
  actor.scopes.some((scope) => scope.kind === "all");

/** Bảng ánh xạ `entry.capability` metadata → predicate tương ứng. */
export const NAV_CAPABILITY_PREDICATES: Readonly<Record<string, NavCapabilityPredicate>> = {
  any: () => true,
  owner: adminAuthorityNavPredicate,
  finance: () => false, // P3 chưa có entry finance; fail-closed.
  hrp: directEntryNavPredicate,
  entry_own: directEntryNavPredicate,
  entry_team: directEntryNavPredicate,
  entry_admin: directEntryNavPredicate,
  project_admin: projectAdminNavPredicate,
};

/** Resolver trung tâm — đảm bảo mỗi entry luôn có predicate. */
export function resolveNavCapabilityPredicate(
  capabilityKey: string,
): NavCapabilityPredicate {
  const predicate = NAV_CAPABILITY_PREDICATES[capabilityKey];
  if (predicate) return predicate;
  // Token không xác định → fail-closed: ẩn entry thay vì render với quyền ngầm định.
  return () => false;
}

/**
 * Quyết định một nav entry có được render cho actor này không.
 * Thuần, không phụ thuộc React, không đọc env.
 */
export function decideNavEntryVisibility(input: {
  capabilityKey: string;
  actor: NavActorProjection | null;
  viewport: "desktop" | "mobile";
  entryVisibleInViewport: boolean;
}): boolean {
  if (!input.entryVisibleInViewport) return false;
  // Actor chưa resolve (page chưa có session) hoặc resolve fail:
  // - `any` vẫn hiện (Dashboard).
  // - capability khác: ẩn cho tới khi actor OK.
  if (input.actor === null) {
    return input.capabilityKey === "any";
  }
  return resolveNavCapabilityPredicate(input.capabilityKey)(input.actor);
}