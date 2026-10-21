import assert from "node:assert/strict";
import test from "node:test";
import { createAssignmentRepository } from "./assignment-repository.ts";

const actor = { auth_subject: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", app_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const team = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const template = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const version = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

test("assignment options call the scoped service RPC with the trusted actor and project its result", async () => {
  let called;
  const data = {
    templates: [{ template_id: template, template_code: "DAILY", display_name: "Báo cáo ngày",
      default_frequency: "DAILY", current_published_version_id: version }],
    teams: [{ team_id: team, code: "TEAM_A", display_name: "Team A" }],
    users: [],
  };
  const repository = createAssignmentRepository(async (name, args) => {
    called = { name, args };
    return { data, error: null };
  });
  const result = await repository.listOptions({ ...actor, team_id: team });
  assert.deepEqual(called, { name: "work_report_list_assignment_options", args: {
    p_auth_subject: actor.auth_subject, p_app_user_id: actor.app_user_id, p_team_id: team,
  } });
  assert.deepEqual(result, { ok: true, data });
});

test("assignment options reject malformed RPC data and preserve access denials", async () => {
  const malformed = createAssignmentRepository(async () => ({ data: { users: [] }, error: null }));
  assert.deepEqual(await malformed.listOptions({ ...actor, team_id: null }), { ok: false, kind: "unavailable" });
  const denied = createAssignmentRepository(async () => ({ data: null, error: { code: "42501" } }));
  assert.deepEqual(await denied.listOptions({ ...actor, team_id: team }), { ok: false, kind: "denied" });
});
