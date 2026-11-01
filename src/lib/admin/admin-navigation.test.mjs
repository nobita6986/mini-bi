import assert from "node:assert/strict";
import test from "node:test";

import {
  adminAreaNavPredicate,
  adminSecurityNavPredicate,
  catalogOperatorNavPredicate,
  decideNavEntryVisibility,
} from "../navigation/registry-capability.ts";
import { CURRENT_NAV_ENTRIES, findEntryByPath } from "../navigation/registry.ts";
import {
  ADMIN_SECTIONS,
  isAdminSectionActive,
  visibleAdminSections,
} from "./admin-navigation.ts";

const fullAdmin = {
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
  scopes: [{ kind: "all" }],
};
const accountingCatalog = {
  capabilities: ["catalog_master_manage"],
  scopes: [{ kind: "all" }],
};

test("Admin authority predicate: Full Admin and Accounting catalog operator allow", () => {
  assert.equal(adminSecurityNavPredicate(fullAdmin), true);
  assert.equal(catalogOperatorNavPredicate(accountingCatalog), true);
  assert.equal(adminAreaNavPredicate(fullAdmin), true);
  assert.equal(adminAreaNavPredicate(accountingCatalog), true);
});

test("Admin authority predicate fails closed without effective all or canonical capability", () => {
  assert.equal(adminAreaNavPredicate({ capabilities: ["catalog_master_manage"], scopes: [{ kind: "team" }] }), false);
  assert.equal(adminAreaNavPredicate({ capabilities: ["entry_admin"], scopes: [{ kind: "all" }] }), false);
  assert.equal(adminAreaNavPredicate({ capabilities: ["team_manager_assign"], scopes: [{ kind: "all" }] }), false);
  assert.equal(adminAreaNavPredicate({ capabilities: [], scopes: [{ kind: "all" }] }), false);
});

test("one top-level /admin entry is independently authorized and is not a Direct Entry route", () => {
  const entries = CURRENT_NAV_ENTRIES.filter((entry) => entry.path === "/admin");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "admin");
  assert.equal(entries[0].capability, "admin_area");
  assert.equal(decideNavEntryVisibility({
    capabilityKey: entries[0].capability,
    actor: accountingCatalog,
    viewport: "desktop",
    entryVisibleInViewport: true,
  }), true);
  assert.equal(decideNavEntryVisibility({
    capabilityKey: entries[0].capability,
    actor: null,
    viewport: "desktop",
    entryVisibleInViewport: true,
  }), false);
});

test("Admin internal navigation exposes mapping, departments, and worker edit history only to authorized Admin actors", () => {
  assert.deepEqual(ADMIN_SECTIONS.map(({ id, href }) => ({ id, href })), [
    { id: "personnel", href: "/admin/catalog/personnel" },
    { id: "teams", href: "/admin/catalog/teams" },
    { id: "labor-types", href: "/admin/catalog/labor-types" },
    { id: "project-team-scopes", href: "/admin/catalog/project-team-scopes" },
    { id: "vendors", href: "/admin/catalog/vendors" },
    { id: "departments", href: "/admin/departments" },
    { id: "accounts", href: "/admin/access/accounts" },
    { id: "attendance", href: "/admin/attendance" },
    { id: "worker-edit-history", href: "/admin/worker-edit-history" },
  ]);
  assert.deepEqual(ADMIN_SECTIONS.map(({ id, label }) => ({ id, label })), [
    { id: "personnel", label: "Nhân sự" },
    { id: "teams", label: "Nhóm" },
    { id: "labor-types", label: "Loại hình lao động" },
    { id: "project-team-scopes", label: "Mapping Dự án ↔ Nhóm" },
    { id: "vendors", label: "Vendor (NCC)" },
    { id: "departments", label: "Phòng ban" },
    { id: "accounts", label: "Tài khoản truy cập" },
    { id: "attendance", label: "Báo cáo chấm công" },
    { id: "worker-edit-history", label: "Lịch sử chỉnh sửa NLĐ" },
  ]);
  const serializableSections = ADMIN_SECTIONS.map(({ id, label, href }) => ({ id, label, href }));
  const catalogOnly = serializableSections.filter(({ id }) => !["departments", "accounts", "project-team-scopes", "attendance", "worker-edit-history"].includes(id));
  const attendanceOnly = serializableSections.filter(({ id }) => id === "attendance");
  const fullAdminWithoutHistory = serializableSections.filter(({ id }) => id !== "worker-edit-history");
  const allowlistedAdmin = {
    capabilities: [...fullAdmin.capabilities, "worker_edit_history_view"],
    scopes: [{ kind: "all" }],
  };
  // Accounting (catalog operator) sees catalog sections, never departments, accounts, project mappings, attendance, or worker edit history.
  assert.deepEqual(visibleAdminSections(accountingCatalog), catalogOnly);
  // Canonical BoD (entry_privileged_edit @ all or report_analytics_view + report_view @ all) sees only Attendance Report.
  assert.deepEqual(visibleAdminSections({ capabilities: ["entry_privileged_edit"], scopes: [{ kind: "all" }] }), attendanceOnly);
  assert.deepEqual(visibleAdminSections({ capabilities: ["report_analytics_view", "report_view"], scopes: [{ kind: "all" }] }), attendanceOnly);
  // Aggregate-only or submission-only report viewers do not receive Attendance Report access.
  assert.deepEqual(visibleAdminSections({ capabilities: ["report_analytics_view"], scopes: [{ kind: "all" }] }), []);
  assert.deepEqual(visibleAdminSections({ capabilities: ["report_view"], scopes: [{ kind: "all" }] }), []);
  // Canonical Full Admin without worker_edit_history_view sees every section except worker-edit-history; allowlisted Admin sees all.
  assert.deepEqual(visibleAdminSections(fullAdmin), fullAdminWithoutHistory);
  assert.deepEqual(visibleAdminSections(allowlistedAdmin), serializableSections);
  assert.equal(visibleAdminSections(allowlistedAdmin).some((section) => Object.values(section).some((value) => typeof value === "function")), false);
  // Project Admin (entry_admin@all without the triple) and unresolved actors see nothing.
  assert.deepEqual(visibleAdminSections({ capabilities: ["entry_admin"], scopes: [{ kind: "all" }] }), []);
  assert.deepEqual(visibleAdminSections(null), []);
});

test("catalog and access paths highlight exactly one internal tab", () => {
  for (const [pathname, activeId] of [
    ["/admin/catalog/personnel", "personnel"],
    ["/admin/catalog/personnel/record", "personnel"],
    ["/admin/catalog/teams", "teams"],
    ["/admin/catalog/teams/record", "teams"],
    ["/admin/catalog/vendors", "vendors"],
    ["/admin/catalog/vendors/record", "vendors"],
    ["/admin/catalog/labor-types", "labor-types"],
    ["/admin/catalog/labor-types/record", "labor-types"],
    ["/admin/departments", "departments"],
    ["/admin/departments/40000000-0000-4000-8000-000000000003", "departments"],
    ["/admin/access/accounts", "accounts"],
    ["/admin/access/accounts/record", "accounts"],
    ["/admin/catalog/project-team-scopes", "project-team-scopes"],
  ]) {
    assert.deepEqual(
      ADMIN_SECTIONS.filter((section) => isAdminSectionActive(pathname, section.href)).map(({ id }) => id),
      [activeId],
      pathname,
    );
  }
});

test("top-level Admin remains the active registry entry across catalog and access routes", () => {
  assert.equal(findEntryByPath("/admin/catalog/personnel")?.id, "admin");
  assert.equal(findEntryByPath("/admin/catalog/teams")?.id, "admin");
  assert.equal(findEntryByPath("/admin/catalog/teams/nested")?.id, "admin");
  assert.equal(findEntryByPath("/admin/catalog/vendors")?.id, "admin");
  assert.equal(findEntryByPath("/admin/catalog/labor-types")?.id, "admin");
  assert.equal(findEntryByPath("/admin/departments")?.id, "admin");
  assert.equal(findEntryByPath("/admin/departments/40000000-0000-4000-8000-000000000003")?.id, "admin");
  assert.equal(findEntryByPath("/admin/access/accounts")?.id, "admin");
  assert.equal(findEntryByPath("/admin/catalog/project-team-scopes")?.id, "admin");
});
