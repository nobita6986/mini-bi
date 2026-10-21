import assert from "node:assert/strict";
import test from "node:test";
import { listMyWorkReportObligations, getWorkReportSubmission, writeWorkReportSubmission } from "./submission-api.ts";

const actor = { auth_subject: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", app_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
function deps(repository = {}) { return { resolveSession: async () => ({ actor: { ok: true, actor } }), repository }; }
function post(body) { return new Request(`https://bi.test/api/work-reports/submissions/${id}/submit`, { method: "POST",
  headers: { host: "bi.test", origin: "https://bi.test", "sec-fetch-site": "same-origin", "content-type": "application/json" },
  body: JSON.stringify(body) }); }

test("obligations inbox is session scoped and maps RPC failure to explicit error", async () => {
  let input;
  const response = await listMyWorkReportObligations(new Request("https://bi.test/api/work-reports/obligations?status=ACTIVE"), "true", deps({
    listMine: async (value) => { input = value; return { ok: true, data: [] }; },
  }));
  assert.equal(response.status, 200);
  assert.equal(input.app_user_id, actor.app_user_id);
  assert.equal(input.status, "ACTIVE");
  assert.equal((await listMyWorkReportObligations(new Request("https://bi.test/api/work-reports/obligations?team_id=x"), "true", deps())).status, 400);
});

test("submission mutation rejects client-supplied actor and mismatched idempotency header", async () => {
  const forged = await writeWorkReportSubmission(post({ payload_json: { calls_made: 1, app_user_id: actor.app_user_id },
    expected_version: null, idempotency_key: "submit-1" }), id, "submit", "true", deps());
  assert.equal(forged.status, 400);
  const mismatch = post({ payload_json: { calls_made: 1 }, expected_version: null, idempotency_key: "submit-1" });
  mismatch.headers.set("idempotency-key", "submit-2");
  assert.equal((await writeWorkReportSubmission(mismatch, id, "submit", "true", deps())).status, 400);
});

test("draft, submit, and resubmit use the current server actor and OCC version", async () => {
  const calls = [];
  const repository = {
    saveDraft: async (input) => { calls.push(["draft", input]); return { ok: true, data: { version: 1 } }; },
    submit: async (input) => { calls.push(["submit", input]); return { ok: true, data: { version: input.expected_version + 1 } }; },
  };
  for (const [action, expectedVersion] of [["draft", null], ["submit", 1], ["submit", 2]]) {
    const response = await writeWorkReportSubmission(post({ payload_json: { calls_made: 3 }, expected_version: expectedVersion,
      idempotency_key: `${action}-${expectedVersion}` }), id, action, "true", deps(repository));
    assert.equal(response.status, 200);
  }
  assert.deepEqual(calls.map(([name]) => name), ["draft", "submit", "submit"]);
  assert.equal(calls[2][1].expected_version, 2);
  assert.equal(calls[1][1].app_user_id, actor.app_user_id);
});

test("cross-user read denial is returned as 403, never as a successful empty record", async () => {
  const response = await getWorkReportSubmission(new Request(`https://bi.test/api/work-reports/obligations/${id}`), id, "true", deps({
    get: async () => ({ ok: false, kind: "denied" }),
  }));
  assert.equal(response.status, 403);
});
