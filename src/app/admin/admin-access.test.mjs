import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decideAdminAreaAccess,
  decidePersonnelCatalogPageAccess,
} from "../../lib/auth/direct-entry-page-access.ts";

function actor(capabilities, scopes = [{ kind: "all", reference: "all" }]) {
  return {
    ok: true,
    actor: {
      auth_subject: "subject-fixture",
      app_user_id: "user-fixture",
      display_name: "Fixture",
      enabled: true,
      capabilities,
      scopes,
      self_recruiter_suggestion: null,
      session: { provider: "supabase", verification: "getUser", authenticated_at: null },
    },
  };
}

test("Admin and Personnel direct-page decisions allow Full Admin and catalog operator", () => {
  const full = actor(["entry_admin", "recruiter_master_manage", "team_master_manage"]);
  const accounting = actor(["catalog_master_manage"]);
  for (const pageDecision of [decideAdminAreaAccess, decidePersonnelCatalogPageAccess]) {
    assert.equal(pageDecision({ actor: full }), "ALLOW");
    assert.equal(pageDecision({ actor: accounting }), "ALLOW");
    assert.equal(pageDecision({ actor: actor(["catalog_master_manage"], [{ kind: "team", reference: "t" }]) }), "ACCESS_DENIED");
    assert.equal(pageDecision({ actor: actor(["entry_admin"]) }), "ACCESS_DENIED");
    assert.equal(pageDecision({ actor: actor(["team_manager_assign"]) }), "ACCESS_DENIED");
  }
});

test("disabled, unmapped, ambiguous and missing actor resolutions fail closed", () => {
  for (const reason of ["ACTOR_DISABLED", "ACTOR_MAPPING_MISSING"]) {
    assert.equal(decideAdminAreaAccess({ actor: { ok: false, reason } }), "ACCOUNT_UNAVAILABLE");
  }
  for (const reason of ["AMBIGUOUS_RECRUITER_LINK", "AMBIGUOUS_TEAM_MEMBERSHIP"]) {
    assert.equal(decidePersonnelCatalogPageAccess({ actor: { ok: false, reason } }), "TEMPORARY_UNAVAILABLE");
  }
  assert.equal(decideAdminAreaAccess({ actor: null }), "TEMPORARY_UNAVAILABLE");
  assert.equal(decideAdminAreaAccess({ actor: { ok: false, reason: "UNAUTHENTICATED" } }), "REDIRECT_LOGIN");
});

test("both Admin URL surfaces resolve actor server-side and use explicit access decisions", () => {
  const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
  const adminPage = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  const personnelPage = readFileSync(new URL("./catalog/personnel/page.tsx", import.meta.url), "utf8");
  assert.match(layout, /resolveActorForRequest\(\)/);
  assert.match(layout, /decideAdminAreaAccess/);
  assert.match(adminPage, /resolveActorForRequest\(\)/);
  assert.match(adminPage, /decideAdminAreaAccess/);
  assert.match(personnelPage, /resolveActorForRequest\(\)/);
  assert.match(personnelPage, /decidePersonnelCatalogPageAccess/);
  assert.doesNotMatch(layout + adminPage + personnelPage, /DIRECT_ENTRY_UI_ENABLED/);
});
