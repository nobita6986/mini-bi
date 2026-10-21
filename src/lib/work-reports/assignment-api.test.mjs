import assert from "node:assert/strict";
import test from "node:test";
import { createWorkReportAssignment, listWorkReportAssignmentOptions, setWorkReportAssignmentState, changeWorkReportObligation } from "./assignment-api.ts";

const actor = { auth_subject: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", app_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const template = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const user = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
function request(path, body) {
  return new Request(`https://bi.test${path}`, { method: "POST", headers: { host: "bi.test", origin: "https://bi.test",
    "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) });
}
function getRequest(path) { return new Request(`https://bi.test${path}`); }
function deps(repository = {}) { return { resolveSession: async () => ({ actor: { ok: true, actor } }), repository }; }
function assignment() { return { template_id: template, target_kind: "USER", target_user_id: user, target_team_id: null,
  target_user_ids: [], frequency: "DAILY", is_mandatory: true, due_day_offset: 0, due_time_local: "23:59:59",
  exclude_sundays: false, effective_from: "2026-10-21", effective_to: null, idempotency_key: "request-1" }; }

test("assignment options use the session actor and accept only an optional team filter", async () => {
  let input;
  const data = { templates: [], teams: [], users: [] };
  const response = await listWorkReportAssignmentOptions(
    getRequest(`/api/work-reports/assignments?team_id=${user}`), "true", deps({
      listOptions: async (value) => { input = value; return { ok: true, data }; },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(input, { ...actor, team_id: user });
  assert.deepEqual(await response.json(), { ok: true, ...data });
  assert.equal((await listWorkReportAssignmentOptions(
    getRequest(`/api/work-reports/assignments?app_user_id=${user}`), "true", deps(),
  )).status, 400);
});

test("assignment creation resolves actor from session and validates scope through repository result", async () => {
  let input;
  const response = await createWorkReportAssignment(request("/api/work-reports/assignments", assignment()), "true", deps({
    create: async (value) => { input = value; return { ok: true, data: { assignment_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", version: 1 } }; },
  }));
  assert.equal(response.status, 200);
  assert.equal(input.app_user_id, actor.app_user_id);
  assert.equal(input.target_user_id, user);
});

test("assignment rejects client authority and mismatched target shape", async () => {
  const forged = { ...assignment(), app_user_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
  assert.equal((await createWorkReportAssignment(request("/api/work-reports/assignments", forged), "true", deps())).status, 400);
  const mismatch = { ...assignment(), target_team_id: user };
  assert.equal((await createWorkReportAssignment(request("/api/work-reports/assignments", mismatch), "true", deps())).status, 400);
});

test("database denies an out-of-scope assignment without returning success", async () => {
  const response = await createWorkReportAssignment(request("/api/work-reports/assignments", assignment()), "true", deps({
    create: async () => ({ ok: false, kind: "denied" }),
  }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "WORK_REPORT_ACCESS_DENIED");
});

test("pause/revoke and exempt/reopen routes pass only the server session actor", async () => {
  let stateInput;
  const patch = request("/api/work-reports/assignments/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", {
    expected_version: 1, state: "REVOKED", idempotency_key: "state-1",
  });
  const patched = await setWorkReportAssignmentState(patch, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "true", deps({
    setState: async (input) => { stateInput = input; return { ok: true, data: { version: 2 } }; },
  }));
  assert.equal(patched.status, 200);
  assert.equal(stateInput.app_user_id, actor.app_user_id);
  let actionInput;
  const changed = await changeWorkReportObligation(request("/api/work-reports/obligations/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/status", {
    expected_version: 1, action: "EXEMPT", reason: "Đã miễn", reopened_until: null, idempotency_key: "status-1",
  }), "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "true", deps({
    changeObligation: async (input) => { actionInput = input; return { ok: true, data: { version: 2 } }; },
  }));
  assert.equal(changed.status, 200);
  assert.equal(actionInput.reason, "Đã miễn");
});
