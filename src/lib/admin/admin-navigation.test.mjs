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

test("Admin internal navigation exposes Personnel and Teams exactly once", () => {
  assert.deepEqual(ADMIN_SECTIONS.map(({ id, href }) => ({ id, href })), [
    { id: "personnel", href: "/admin/catalog/personnel" },
    { id: "teams", href: "/admin/catalog/teams" },
  ]);
  assert.deepEqual(visibleAdminSections(accountingCatalog), ADMIN_SECTIONS);
  assert.deepEqual(visibleAdminSections({ capabilities: ["entry_admin"], scopes: [{ kind: "all" }] }), []);
});

test("catalog paths and nested paths highlight exactly one internal tab", () => {
  for (const [pathname, activeId] of [
    ["/admin/catalog/personnel", "personnel"],
    ["/admin/catalog/personnel/record", "personnel"],
    ["/admin/catalog/teams", "teams"],
    ["/admin/catalog/teams/record", "teams"],
  ]) {
    assert.deepEqual(
      ADMIN_SECTIONS.filter((section) => isAdminSectionActive(pathname, section.href)).map(({ id }) => id),
      [activeId],
      pathname,
    );
  }
});

test("top-level Admin remains the active registry entry across catalog routes", () => {
  assert.equal(findEntryByPath("/admin/catalog/personnel")?.id, "admin");
  assert.equal(findEntryByPath("/admin/catalog/teams")?.id, "admin");
  assert.equal(findEntryByPath("/admin/catalog/teams/nested")?.id, "admin");
});
