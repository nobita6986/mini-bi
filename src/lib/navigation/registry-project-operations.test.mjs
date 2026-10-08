/**
 * P2.5-W06A - Dang ky nav entry cho Project Operations + gate flag theo route.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_NAV_ENTRIES,
  entriesForViewport,
  filterEntriesForActor,
  findEntryByPath,
  isDirectEntryRoute,
} from "./registry.ts";

test("entry 'project-operations' duoc dang ky trong cung registry", () => {
  const entry = CURRENT_NAV_ENTRIES.find((item) => item.id === "project-operations");
  assert.ok(entry, "thieu entry project-operations");
  assert.equal(entry.path, "/direct-entry/projects");
  assert.equal(entry.capability, "project_admin",
    "dung projectAdminNavPredicate (entry_admin + all scope, dung DB W02)");
  assert.deepEqual(entry.visibility, { desktop: true, mobile: true });
  assert.equal(findEntryByPath("/direct-entry/projects"), entry);
});

test("moi route /direct-entry* deu bi gate boi cung flag", () => {
  for (const path of ["/direct-entry", "/direct-entry/projects", "/direct-entry/x/y"]) {
    assert.equal(isDirectEntryRoute({ path }), true, path);
  }
  assert.equal(isDirectEntryRoute({ path: "/dashboard" }), false);

  const off = entriesForViewport("desktop", false).map((entry) => entry.id);
  assert.equal(off.includes("project-operations"), false, "flag off => khong hien");
  assert.equal(off.includes("dashboard"), true);

  const on = entriesForViewport("desktop", true).map((entry) => entry.id);
  assert.equal(on.includes("project-operations"), true);
});

test("F6: findEntryByPath dung longest-prefix de highlight dung muc", () => {
  assert.equal(findEntryByPath("/direct-entry/projects")?.id, "project-operations");
  assert.equal(findEntryByPath("/direct-entry")?.id, "direct-entry");
  assert.equal(findEntryByPath("/direct-entry/projects/anything")?.id, "project-operations");
  assert.equal(findEntryByPath("/dashboard")?.id, "dashboard");
  assert.equal(findEntryByPath("/dashboard/account/password")?.id, "dashboard");
  assert.equal(findEntryByPath("/login"), undefined);
});

test("flag off an ca entry qua filterEntriesForActor (AppShell)", () => {
  const actor = {
    capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    scopes: [{ kind: "all" }],
  };
  const visible = filterEntriesForActor({
    viewport: "desktop", directEntryEnabled: false, actor, decide: () => true,
  }).map((entry) => entry.id);
  assert.equal(visible.includes("project-operations"), false);
  assert.equal(visible.includes("direct-entry"), false);
  assert.equal(visible.includes("dashboard"), true);
});
