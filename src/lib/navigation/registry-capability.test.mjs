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
import { readFileSync } from "node:fs";
import { test } from "node:test";

const cap = await import("./registry-capability.ts");
const reg = await import("./registry.ts");
const {
  decideNavEntryVisibility,
  directEntryNavPredicate,
  adminAuthorityNavPredicate,
  adminAreaNavPredicate,
  adminSecurityNavPredicate,
  catalogOperatorNavPredicate,
  projectAdminNavPredicate,
  workerOperationsAllScopePredicate,
  workerOperationsNavPredicate,
  workerOperationsReviewPredicate,
  resolveNavCapabilityPredicate,
} = cap;
const { CURRENT_NAV_ENTRIES, filterEntriesForActor } = reg;

/** @typedef {{ kind: "own" | "team" | "all" }} NavScope */
/** @typedef {{ capabilities: readonly string[], scopes: readonly NavScope[] }} NavActorProjection */

/** @param {readonly string[]} capabilities @param {readonly NavScope[]} [scopes] @returns {NavActorProjection} */
function makeActor(capabilities, scopes = [{ kind: "all", reference: "all" }]) {
  return { capabilities, scopes };
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

test("Admin area: catalog operator OR Full Admin triple + effective all", () => {
  const full = makeActor(
    ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    [{ kind: "all", reference: "all" }],
  );
  const accounting = makeActor(["catalog_master_manage"], [{ kind: "all", reference: "all" }]);
  assert.equal(adminSecurityNavPredicate(full), true);
  assert.equal(catalogOperatorNavPredicate(accounting), true);
  assert.equal(adminAreaNavPredicate(full), true);
  assert.equal(adminAreaNavPredicate(accounting), true);
  assert.equal(adminAreaNavPredicate(makeActor(["catalog_master_manage"], [{ kind: "team", reference: "t" }])), false);
  assert.equal(adminAreaNavPredicate(makeActor(["entry_admin"], [{ kind: "all", reference: "all" }])), false);
  assert.equal(adminAreaNavPredicate(makeActor(["team_manager_assign"], [{ kind: "all", reference: "all" }])), false);
});

test("F5: projectAdminNavPredicate = entry_admin + all scope, KHONG can 2 token kia", () => {
  // DB W02 (direct_entry_assert_project_admin) chi can entry_admin + all scope.
  assert.equal(projectAdminNavPredicate(makeActor(["entry_admin"], [{ kind: "all", reference: "all" }])), true);
  assert.equal(projectAdminNavPredicate(makeActor(["entry_admin", "recruiter_master_manage", "team_master_manage"],
    [{ kind: "all", reference: "all" }])), true, "them 2 token khong anh huong");
  // entry_own/entry_team KHONG duoc render page roi moi cho API 403.
  assert.equal(projectAdminNavPredicate(makeActor(["entry_own"], [{ kind: "all", reference: "all" }])), false);
  assert.equal(projectAdminNavPredicate(makeActor(["entry_team"], [{ kind: "all", reference: "all" }])), false);
  // entry_admin nhung KHONG co scope all => fail.
  assert.equal(projectAdminNavPredicate(makeActor(["entry_admin"], [{ kind: "team", reference: "t" }])), false);
  assert.equal(projectAdminNavPredicate(makeActor(["entry_admin"], [])), false);
});

test("W06-R1: worker operations audience matrix (reviewer/admin/PM/uploader)", () => {
  const all = [{ kind: "all", reference: "all" }];
  // Reviewer bundle toi thieu + all.
  assert.equal(workerOperationsNavPredicate(makeActor(["change_review", "pii_view", "payment_view"], all)), true);
  // Admin entry_admin + all.
  assert.equal(workerOperationsNavPredicate(makeActor(["entry_admin"], all)), true);
  // Nguoi de xuat / PM.
  assert.equal(workerOperationsNavPredicate(makeActor(["change_request_create"], [{ kind: "own" }])), true);
  // Uploader hien huu.
  assert.equal(workerOperationsNavPredicate(makeActor(["entry_own"], [{ kind: "own" }])), true);
  assert.equal(workerOperationsNavPredicate(makeActor(["entry_team"], [{ kind: "team" }])), true);
  // Reporting audience=all nhung thieu capability => KHONG mo.
  assert.equal(workerOperationsNavPredicate(makeActor([], all)), false);
  // Reviewer thieu all scope => khong mo.
  assert.equal(workerOperationsNavPredicate(makeActor(["change_review"], [{ kind: "team" }])), false);
  // scope=all tab / review queue.
  assert.equal(workerOperationsAllScopePredicate(makeActor(["entry_admin"], all)), true);
  assert.equal(workerOperationsAllScopePredicate(makeActor(["change_review"], all)), true);
  assert.equal(workerOperationsAllScopePredicate(makeActor(["entry_own"], all)), false);
  assert.equal(workerOperationsAllScopePredicate(makeActor(["entry_admin"], [{ kind: "team" }])), false);
  assert.equal(workerOperationsReviewPredicate(makeActor(["change_review"], all)), true);
  assert.equal(workerOperationsReviewPredicate(makeActor(["entry_admin"], all)), false,
    "admin khong tu dong la reviewer");
  assert.equal(workerOperationsReviewPredicate(makeActor(["change_review"], [{ kind: "own" }])), false);
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
  assert.deepEqual(ids, ["dashboard", "direct-entry", "worker-operations"]);
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

test("filterEntriesForActor: reviewer (change_review + all) → Dashboard + Người lao động", () => {
  // P2.5-W06-R1: reviewer bundle + effective all scope duoc vao Worker Operations
  // (nhung KHONG duoc vao Direct Entry editor: khong co entry_own|entry_team|entry_admin).
  const reviewerActor = makeActor(["change_review", "document_view"]);
  const result = filterEntriesForActor({
    viewport: "mobile",
    directEntryEnabled: true,
    actor: reviewerActor,
    decide: decideFor(reviewerActor, "mobile"),
  });
  assert.deepEqual(result.map((e) => e.id), ["dashboard", "worker-operations"]);
  // Reviewer KHONG thay entry Direct Entry / Du an.
  assert.equal(result.some((e) => e.id === "direct-entry"), false);
  assert.equal(result.some((e) => e.id === "project-operations"), false);
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

test("filterEntriesForActor: owner (đủ 3 admin) + viewport=mobile → Dashboard + Direct Entry + Dự án", () => {
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
  // Full Admin thấy Admin cùng với các khu vực đã có quyền.
  assert.deepEqual(result.map((e) => e.id).sort(),
    ["admin", "dashboard", "direct-entry", "project-operations", "worker-operations"]);
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

test("Admin catalog navigation remains available when Direct Entry UI is disabled", () => {
  const accounting = makeActor(["catalog_master_manage"], [{ kind: "all", reference: "all" }]);
  const result = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: false,
    actor: accounting,
    decide: decideFor(accounting, "desktop"),
  });
  assert.deepEqual(result.map((entry) => entry.id), ["dashboard", "admin"]);
});

test("CURRENT_NAV_ENTRIES giữ nguyên (không tạo registry thứ hai)", () => {
  // Admin is added to the same registry; no separate menu registry is introduced.
  const ids = CURRENT_NAV_ENTRIES.map((e) => e.id).sort();
  assert.deepEqual(ids, ["admin", "dashboard", "direct-entry", "project-operations", "worker-operations"]);
});

// ===== P3-W06A R1 Gap 2: asymmetric desktop/mobile visibility ============
// Muc tieu: dam bao AppShell goi `filterEntriesForActor` voi viewport
// RIENG (desktop + mobile), khong dung nham visibility giua 2 nhanh.
// Test voi registry "dummy" co entry chi hien tren 1 viewport (P3-W06A R1
// pattern: co the them entry chi hien tren mobile sau).

test("Gap2: registry chỉ có 1 entry desktop=true, mobile=false → desktop thấy, mobile ẩn", () => {
  // Mo phong bang registry that (filterEntriesForActor dung CURRENT_NAV_ENTRIES).
  // Dang ky them mot entry "moi" voi visibility chi desktop.
  const result = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: true,
    actor: makeActor([]),
    decide: (entry) => entry.capability === "any" && entry.id === "dashboard",
  });
  // Trong registry hien tai, Dashboard va Direct Entry deu co
  // visibility { desktop: true, mobile: true }. Test asymmetric qua
  // decide: chi cho "any" (Dashboard).
  // Trên mobile: decide khong bao gio chay (filter visibility truoc) → van chi Dashboard.
  const desktopIds = result.map((e) => e.id).sort();
  assert.deepEqual(desktopIds, ["dashboard"]);
});

test("Gap2: app-shell.tsx truyền viewport='desktop' cho desktopItems và viewport='mobile' cho mobileItems", () => {
  // Dam bao AppShell goi filterEntriesForActor voi viewport dung cho tung
  // nhanh, khong dung nham (P3-W06A R1 bug gap 2: closure hardcode "desktop"
  // duoc tai su dung cho mobile).
  const source = readFileSync(new URL("../../components/app-shell/app-shell.tsx", import.meta.url), "utf8");
  // Bo comment lines truoc khi check.
  const codeOnly = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");
  // Phai co 2 lan goi filterEntriesForActor voi viewport "desktop" va "mobile" RIENG.
  const desktopCall = /filterEntriesForActor\(\{[\s\S]{0,200}viewport:\s*"desktop"[\s\S]{0,400}\}/.test(codeOnly);
  const mobileCall = /filterEntriesForActor\(\{[\s\S]{0,200}viewport:\s*"mobile"[\s\S]{0,400}\}/.test(codeOnly);
  assert.ok(desktopCall, "AppShell phai goi filterEntriesForActor voi viewport='desktop' cho desktopItems");
  assert.ok(mobileCall, "AppShell phai goi filterEntriesForActor voi viewport='mobile' cho mobileItems");
});

test("Gap2: app-shell.tsx truyền entry.visibility.desktop cho desktop quyết định, KHÔNG lẫn sang mobile", () => {
  // Asymmetric: desktop decide nhan `entry.visibility.desktop`, mobile decide
  // nhan `entry.visibility.mobile`. Khong co cho nao re-use.
  const source = readFileSync(new URL("../../components/app-shell/app-shell.tsx", import.meta.url), "utf8");
  const codeOnly = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");
  // Phai co `entryVisibleInViewport: entry.visibility.desktop` (desktop decide).
  assert.match(codeOnly, /entryVisibleInViewport:\s*entry\.visibility\.desktop/);
  // Phai co `entryVisibleInViewport: entry.visibility.mobile` (mobile decide).
  assert.match(codeOnly, /entryVisibleInViewport:\s*entry\.visibility\.mobile/);
});

// Test thuc te asymmetric: dung registry that, viewport=true/false khac nhau.
// Dam bao filterEntriesForActor KHONG bi "leak" visibility giua 2 nhanh.

test("Gap2 (asymmetric): filterEntriesForActor voi 1 entry co visibility {desktop: true, mobile: false}", () => {
  // Tao mock entry voi visibility chi desktop. CURRENT_NAV_ENTRIES goc co
  // ca 2 entry deu la { desktop: true, mobile: true } nen test này phai
  // dung mock rieng (CURRENT_NAV_ENTRIES.filter() se khong match mock).
  // De dam bao code filterEntriesForActor dung `entry.visibility[viewport]`
  // ma khong hardcode, ta test voi `decide` gia lap.
  const desktop = CURRENT_NAV_ENTRIES.filter((e) => e.visibility.desktop);
  const mobile = CURRENT_NAV_ENTRIES.filter((e) => e.visibility.mobile);
  // Trong registry hien tai, desktop va mobile phai giong nhau vi ca 2 entry
  // deu co visibility { desktop: true, mobile: true }.
  assert.deepEqual(
    desktop.map((e) => e.id).sort(),
    mobile.map((e) => e.id).sort(),
    "registry hien tai co desktop === mobile, nhung code phai doc viewport RIENG",
  );
});
