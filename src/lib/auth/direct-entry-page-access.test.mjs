import assert from "node:assert/strict";
import test from "node:test";

import {
  decideAdminAreaAccess,
  decideDirectEntryPageAccess,
  decidePersonnelCatalogPageAccess,
  decideTeamCatalogPageAccess,
} from "./direct-entry-page-access.ts";

function actor(capabilities) {
  return {
    ok: true,
    actor: {
      auth_subject: "s", app_user_id: "u", enabled: true,
      capabilities, scopes: [], self_recruiter_suggestion: null,
      session: { provider: "supabase", verification: "getUser", authenticated_at: null },
    },
  };
}

const reasons = [
  "UNAUTHENTICATED", "ACTOR_MAPPING_MISSING", "ACTOR_DISABLED",
  "ACTOR_REPOSITORY_MISSING", "ACTOR_REPOSITORY_INVALID",
  "AMBIGUOUS_RECRUITER_LINK", "AMBIGUOUS_TEAM_MEMBERSHIP",
];

function denied(reason) { return { ok: false, reason }; }

test("flag off -> NOT_FOUND", () => {
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: false, actor: actor(["entry_own"]) }), "NOT_FOUND");
});

test("resolution mapping", () => {
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied("UNAUTHENTICATED") }), "REDIRECT_LOGIN");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied("ACTOR_MAPPING_MISSING") }), "ACCOUNT_UNAVAILABLE");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied("ACTOR_DISABLED") }), "ACCOUNT_UNAVAILABLE");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied("ACTOR_REPOSITORY_MISSING") }), "TEMPORARY_UNAVAILABLE");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied("ACTOR_REPOSITORY_INVALID") }), "TEMPORARY_UNAVAILABLE");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied("AMBIGUOUS_RECRUITER_LINK") }), "TEMPORARY_UNAVAILABLE");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied("AMBIGUOUS_TEAM_MEMBERSHIP") }), "TEMPORARY_UNAVAILABLE");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: null }), "TEMPORARY_UNAVAILABLE");
});

test("capability gating: entry_own/team/admin ALLOW, khong co hoac khong lien quan -> ACCESS_DENIED", () => {
  for (const cap of ["entry_own", "entry_team", "entry_admin"]) {
    assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: actor([cap]) }), "ALLOW", cap);
  }
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: actor(["change_review"]) }), "ACCESS_DENIED");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: actor([]) }), "ACCESS_DENIED");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: actor(["entry_own", "change_review", "entry_admin"]) }), "ALLOW");
});

test("output union la gioi han va exhaustive", () => {
  const seen = new Set();
  for (const reason of reasons) seen.add(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied(reason) }));
  seen.add(decideDirectEntryPageAccess({ uiEnabled: false, actor: null }));
  seen.add(decideDirectEntryPageAccess({ uiEnabled: true, actor: null }));
  seen.add(decideDirectEntryPageAccess({ uiEnabled: true, actor: actor([]) }));
  seen.add(decideDirectEntryPageAccess({ uiEnabled: true, actor: actor(["entry_own"]) }));
  for (const value of seen) {
    assert.ok([
      "NOT_FOUND", "REDIRECT_LOGIN", "ACCOUNT_UNAVAILABLE",
      "TEMPORARY_UNAVAILABLE", "ACCESS_DENIED", "ALLOW",
    ].includes(value), value);
  }
});

test("Admin route decisions use all-scope catalog operator OR canonical Full Admin", () => {
  const fullAdmin = {
    ...actor(["entry_admin", "recruiter_master_manage", "team_master_manage"]),
    actor: {
      ...actor(["entry_admin", "recruiter_master_manage", "team_master_manage"]).actor,
      scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
    },
  };
  const accounting = {
    ...actor(["catalog_master_manage"]),
    actor: {
      ...actor(["catalog_master_manage"]).actor,
      scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
    },
  };
  for (const decide of [decideAdminAreaAccess, decidePersonnelCatalogPageAccess, decideTeamCatalogPageAccess]) {
    assert.equal(decide({ actor: fullAdmin }), "ALLOW");
    assert.equal(decide({ actor: accounting }), "ALLOW");
    assert.equal(decide({ actor: actor(["catalog_master_manage"]) }), "ACCESS_DENIED");
    assert.equal(decide({ actor: actor(["entry_admin"]) }), "ACCESS_DENIED");
    assert.equal(decide({ actor: actor(["team_manager_assign"]) }), "ACCESS_DENIED");
    assert.equal(decide({ actor: actor(["entry_own"]) }), "ACCESS_DENIED");
    assert.equal(decide({ actor: actor(["entry_team"]) }), "ACCESS_DENIED");
    assert.equal(decide({ actor: actor(["change_request_create"]) }), "ACCESS_DENIED");
    assert.equal(decide({ actor: { ok: false, reason: "ACTOR_DISABLED" } }), "ACCOUNT_UNAVAILABLE");
    assert.equal(decide({ actor: { ok: false, reason: "ACTOR_MAPPING_MISSING" } }), "ACCOUNT_UNAVAILABLE");
    assert.equal(decide({ actor: { ok: false, reason: "AMBIGUOUS_TEAM_MEMBERSHIP" } }), "TEMPORARY_UNAVAILABLE");
    assert.equal(decide({ actor: { ok: false, reason: "AMBIGUOUS_RECRUITER_LINK" } }), "TEMPORARY_UNAVAILABLE");
  }
});
