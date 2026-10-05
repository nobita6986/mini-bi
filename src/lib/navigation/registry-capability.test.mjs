/**
 * P3-W06A — Capability projection + filter tests.
 * Style: node:test + pure assertions.
 *
 * Bao phủ:
 * - directEntryNavPredicate: actor có entry_own/entry_team/entry_admin thì true.
 * - adminAuthorityNavPredicate: yêu cầu đủ 3 capability + scope 'all'.
 * - decideNavEntryVisibility: viewport + actor + capability key.
 * - filterEntriesForActor + AppShell use case: dashboard luôn hiện với
 *   valid actor, Direct Entry ẩn với reader/reviewer, hiện với hrp/owner.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const cap = await import("./registry-capability.ts");
const reg = await import("./registry.ts");
const {
  decideNavEntryVisibility,
  directEntryNavPredicate,
  adminAuthorityNavPredicate,
  resolveNavCapabilityPredicate,
} = cap;
const { CURRENT_NAV_ENTRIES, filterEntriesForActor } = reg;

/** @typedef {{ kind: "own" | "team" | "all" }} NavScope */
/** @typedef {{ app_user_id: string, capabilities: readonly string[], scopes: readonly NavScope[] }} NavActorProjection */

/** @param {readonly string[]} capabilities @param {readonly NavScope[]} [scopes] @returns {NavActorProjection} */
function makeActor(capabilities, scopes = [{ kind: "all", reference: "all" }]) {
  return { app_user_id: "app-user-test", capabilities, scopes };
}

test("directEntryNavPredicate: entry_own / entry_team / entry_admin đều đủ điều kiện", () => {
  assert.equal(directEntryNavPredicate(makeActor(["entry_own"])), true);
  assert.equal(directEntryNavPredicate(makeActor(["entry_team"])), true);
  assert.equal(directEntryNavPredicate(makeActor(["entry_admin"])), true);
  assert.equal(directEntryNavPredicate(makeActor(["document_view"])), false);
  assert.equal(directEntryNavPredicate(makeActor([])), false);
});

test("adminAuthorityNavPredicate: phải có đủ 3 capability + scope 'all'", () => {
  const allCaps = ["entry_admin", "recruiter_master_manage", "team_master_manage"];
  assert.equal(adminAuthorityNavPredicate(makeActor(allCaps, [{ kind: "all", reference: "all" }])), true);
  // Thiếu 1 capability → fail.
  assert.equal(
    adminAuthorityNavPredicate(makeActor(["entry_admin", "recruiter_master_manage"], [{ kind: "all", reference: "all" }])),
    false,
  );
  // Thiếu scope 'all' → fail (kể cả đủ capability).
  assert.equal(
    adminAuthorityNavPredicate(makeActor(allCaps, [{ kind: "team", reference: "t" }])),
    false,
  );
});

test("resolveNavCapabilityPredicate: token không xác định fail-closed", () => {
  assert.equal(resolveNavCapabilityPredicate("entry_own")(makeActor(["entry_own"])), true);
  assert.equal(resolveNavCapabilityPredicate("bogus_token")(makeActor(["entry_admin"])), false);
});

test("decideNavEntryVisibility: viewport false thì luôn ẩn", () => {
  assert.equal(
    decideNavEntryVisibility({
      capabilityKey: "any",
      actor: makeActor([]),
      viewport: "desktop",
      entryVisibleInViewport: false,
    }),
    false,
  );
});

test("decideNavEntryVisibility: actor null + capability=any vẫn hiện (Dashboard cho guest)", () => {
  assert.equal(
    decideNavEntryVisibility({
      capabilityKey: "any",
      actor: null,
      viewport: "desktop",
      entryVisibleInViewport: true,
    }),
    true,
  );
});

test("decideNavEntryVisibility: actor null + capability khác 'any' phải ẩn (fail-closed)", () => {
  assert.equal(
    decideNavEntryVisibility({
      capabilityKey: "entry_admin",
      actor: null,
      viewport: "desktop",
      entryVisibleInViewport: true,
    }),
    false,
  );
});

test("decideNavEntryVisibility: actor OK + capability=entry_admin thì entry_own đủ điều kiện", () => {
  assert.equal(
    decideNavEntryVisibility({
      capabilityKey: "entry_admin",
      actor: makeActor(["entry_own"]),
      viewport: "mobile",
      entryVisibleInViewport: true,
    }),
    true,
  );
});

/** @param {NavActorProjection} actor @param {"desktop" | "mobile"} viewport */
function decideFor(actor, viewport) {
  return (/** @type {{ capability: string, visibility: { desktop: boolean, mobile: boolean } }} */ entry) =>
    decideNavEntryVisibility({
      capabilityKey: entry.capability,
      actor,
      viewport,
      entryVisibleInViewport: viewport === "desktop" ? entry.visibility.desktop : entry.visibility.mobile,
    });
}

test("filterEntriesForActor: valid actor + hrp role → Dashboard + Direct Entry", () => {
  const hrpActor = makeActor(["entry_own"]);
  const result = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: true,
    actor: hrpActor,
    decide: decideFor(hrpActor, "desktop"),
  });
  const ids = result.map((e) => e.id);
  assert.deepEqual(ids, ["dashboard", "direct-entry"]);
});

test("filterEntriesForActor: reader (no capability) → chỉ Dashboard", () => {
  const readerActor = makeActor([]);
  const result = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: true,
    actor: readerActor,
    decide: decideFor(readerActor, "desktop"),
  });
  assert.deepEqual(result.map((e) => e.id), ["dashboard"]);
});

test("filterEntriesForActor: reviewer (no entry_*) → chỉ Dashboard", () => {
  // Theo matrix P3-C01 §2.2: reviewer có change_review + document_view nhưng
  // KHÔNG có entry_own | entry_team | entry_admin.
  const reviewerActor = makeActor(["change_review", "document_view"]);
  const result = filterEntriesForActor({
    viewport: "mobile",
    directEntryEnabled: true,
    actor: reviewerActor,
    decide: decideFor(reviewerActor, "mobile"),
  });
  assert.deepEqual(result.map((e) => e.id), ["dashboard"]);
});

test("filterEntriesForActor: actor null → chỉ Dashboard (fail-closed cho Direct Entry)", () => {
  const result = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: true,
    actor: null,
    decide: decideFor(null, "desktop"),
  });
  assert.deepEqual(result.map((e) => e.id), ["dashboard"]);
});

test("filterEntriesForActor: owner (đủ 3 admin) + viewport=mobile → Dashboard + Direct Entry", () => {
  const ownerActor = makeActor(
    ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    [{ kind: "all", reference: "all" }],
  );
  const result = filterEntriesForActor({
    viewport: "mobile",
    directEntryEnabled: true,
    actor: ownerActor,
    decide: decideFor(ownerActor, "mobile"),
  });
  assert.deepEqual(result.map((e) => e.id).sort(), ["dashboard", "direct-entry"]);
});

test("filterEntriesForActor: Direct Entry off bởi env → chỉ Dashboard dù actor có quyền", () => {
  const hrpActor = makeActor(["entry_own"]);
  const result = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: false,
    actor: hrpActor,
    decide: decideFor(hrpActor, "desktop"),
  });
  assert.deepEqual(result.map((e) => e.id), ["dashboard"]);
});

test("CURRENT_NAV_ENTRIES giữ nguyên (không tạo registry thứ hai)", () => {
  const ids = CURRENT_NAV_ENTRIES.map((e) => e.id).sort();
  assert.deepEqual(ids, ["dashboard", "direct-entry"]);
});
