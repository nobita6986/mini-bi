import assert from "node:assert/strict";
import test from "node:test";

import { createProjectTeamScopeRepository } from "./project-team-scope-repository.ts";

const ACTOR = { auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222" };
const TEAM = "66666666-6666-4666-8666-666666666666";
const MAPPING = "77777777-7777-4777-8777-777777777777";
const KEY = "55555555-5555-4555-8555-555555555555";

test("repository calls only mapping RPCs with session actor and server-owned pair versions", async () => {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push([name, args]);
    if (name === "direct_entry_list_project_team_scopes_admin") return { data: {
      authorization_date: "2026-10-15", include_history: false, page: 1, page_size: 25,
      total: 0, has_more: false, mappings: [],
    }, error: null };
    if (name === "direct_entry_grant_project_team_scopes_batch") return { data: {
      team_id: TEAM, effective_from: "2026-10-15",
      created: [{ mapping_id: MAPPING, project_id: "project-1", team_id: TEAM,
        valid_from: "2026-10-15", valid_to: null, version: 1, created: true }],
      skipped: [],
    }, error: null };
    return { data: { mapping_id: MAPPING, project_id: "project-1", team_id: TEAM,
      valid_to: "2026-10-15", version: 2, revoked: true }, error: null };
  };
  const repo = createProjectTeamScopeRepository(rpc);
  assert.equal((await repo.listScopes({ ...ACTOR, project_id: "project-1", team_id: null,
    search: "compal", include_history: true, page: 2, page_size: 50 })).ok, true);
  assert.equal((await repo.grantScope({ ...ACTOR, project_ids: ["project-1"], team_id: TEAM,
    reason: "grant", idempotency_key: KEY })).ok, true);
  assert.equal((await repo.revokeScope({ ...ACTOR, mapping_id: MAPPING,
    effective_to: null, reason: "revoke", idempotency_key: KEY })).ok, true);
  assert.deepEqual(calls.map(([name]) => name), [
    "direct_entry_list_project_team_scopes_admin",
    "direct_entry_grant_project_team_scopes_batch",
    "direct_entry_revoke_project_team_scope",
  ]);
  assert.deepEqual(calls[0][1], {
    p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id,
    p_project_id: "project-1", p_team_id: null, p_search: "compal",
    p_include_history: true, p_page: 2, p_page_size: 50,
  });
  assert.deepEqual(calls[1][1], {
    p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id,
    p_team_id: TEAM, p_project_ids: ["project-1"],
    p_reason: "grant", p_idempotency_key: KEY,
  });
  assert.deepEqual(calls[2][1], {
    p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id,
    p_mapping_id: MAPPING, p_effective_to: null, p_reason: "revoke",
    p_idempotency_key: KEY,
  });
});

test("repository fail-closes malformed envelopes, SQL authority/conflict, and thrown errors", async () => {
  const malformed = createProjectTeamScopeRepository(async () => ({ data: { ok: true }, error: null }));
  assert.deepEqual(await malformed.listScopes({ ...ACTOR, project_id: null, team_id: null,
    search: null, include_history: false, page: 1, page_size: 25 }), { ok: false, kind: "unavailable" });

  for (const [sqlstate, expected] of [["42501", "denied"], ["40001", "conflict"],
    ["P0002", "not-found"], ["22023", "invalid"], ["XX000", "unavailable"]]) {
    const repository = createProjectTeamScopeRepository(async () => ({ data: null,
      error: { code: sqlstate, message: "sensitive database detail" } }));
    const result = await repository.grantScope({ ...ACTOR, project_ids: ["project-1"], team_id: TEAM,
      reason: "r", idempotency_key: KEY });
    assert.deepEqual(result, { ok: false, kind: expected });
  }
  const thrown = createProjectTeamScopeRepository(async () => { throw new Error("secret"); });
  assert.deepEqual(await thrown.revokeScope({ ...ACTOR, mapping_id: MAPPING,
    effective_to: null, reason: "r", idempotency_key: KEY }),
  { ok: false, kind: "unavailable" });
});

test("repository rejects malformed batch projection instead of fabricating a result", async () => {
  const repository = createProjectTeamScopeRepository(async () => ({
    data: { team_id: TEAM, effective_from: "2026-10-15", created: [], skipped: [{
      project_id: "project-1", status: "ALREADY_EFFECTIVE", mapping_id: MAPPING, version: 1,
      recruiter_id: "must-not-project",
    }] },
    error: null,
  }));
  assert.deepEqual(await repository.grantScope({ ...ACTOR, team_id: TEAM,
    project_ids: ["project-1"], reason: "grant", idempotency_key: KEY }),
  { ok: false, kind: "unavailable" });
});
