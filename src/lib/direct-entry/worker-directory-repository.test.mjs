import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKER_DIRECTORY_RPC_NAMES,
  classifyWorkerDirectoryError,
  createWorkerDirectoryRepository,
} from "./worker-directory-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const entryId = "c1000000-0000-4000-8000-000000000001";
const recruiterId = "d1000000-0000-4000-8000-000000000001";

const row = {
  entry_id: entryId,
  entry_version: 1,
  submission_state: "SUBMITTED",
  employee_code: "hrp-2026-300001",
  display_name: "Worker One",
  project_id: "proj_a",
  project_display: "Project A",
  first_work_date: "2026-10-01",
  labor_type: "TEMPORARY",
  employment_status: null,
  recruiter_id: recruiterId,
  recruiter_display: "Recruiter A",
  payment: null,
  pending_request: null,
  last_decision: null,
  is_project_manager: false,
  allowed_actions: {
    view: true, view_pii: false, view_payment: false,
    propose_change: false, propose_change_code: "PROPOSE_PENDING_W04_POLICY",
  },
};
const payload = {
  items: [row], scope: "managed", page_size: 25, has_more: false, next_cursor: null,
  authorization_date: "2026-10-08",
};
const query = {
  scope: "managed", project_id: null, recruiter_id: null,
  employment_status: null, cursor: null, page_size: 25,
};

test("the worker directory repository exposes exactly one read RPC", () => {
  assert.deepEqual([...WORKER_DIRECTORY_RPC_NAMES], ["direct_entry_list_workers"]);
  for (const forbidden of [
    "direct_entry_assign_project_manager",
    "direct_entry_actor_can_access_project",
    "direct_entry_read_projection",
    "direct_entry_list_own_submissions",
    "direct_entry_create_project",
  ]) {
    assert.equal(WORKER_DIRECTORY_RPC_NAMES.includes(forbidden), false, forbidden);
  }
});

test("listWorkers calls only its RPC with the server actor and exact query", async () => {
  const calls = [];
  let data = payload;
  const repository = createWorkerDirectoryRepository(async (name, args) => {
    calls.push({ name, args });
    return { data, error: null };
  });
  // The RPC echoes the requested scope; the projector refuses a mismatch.
  data = { ...payload, scope: "recruited" };
  const requested = {
    ...actor, ...query, scope: "recruited", project_id: "proj_a",
    recruiter_id: recruiterId, employment_status: "ON", cursor: "20261008:" + entryId,
  };
  const result = await repository.listWorkers(requested);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { ...payload, scope: "recruited" });
  assert.deepEqual(calls, [{
    name: "direct_entry_list_workers",
    args: {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_scope: "recruited",
      p_project_id: "proj_a",
      p_recruiter_id: recruiterId,
      p_employment_status: "ON",
      p_cursor: "20261008:" + entryId,
      p_page_size: 25,
    },
  }]);
});

test("SQLSTATE classification reuses the shared read/mutation table", () => {
  assert.equal(classifyWorkerDirectoryError({ code: "42501" }), "denied");
  assert.equal(classifyWorkerDirectoryError({ code: "22023" }), "invalid");
  assert.equal(classifyWorkerDirectoryError({ code: "P0002" }), "not-found");
  assert.equal(classifyWorkerDirectoryError({ code: "40001" }), "conflict");
  assert.equal(classifyWorkerDirectoryError({ code: "XX000" }), "unavailable");
  assert.equal(classifyWorkerDirectoryError({}), "unavailable");
});

test("errors and malformed payloads never produce a success", async () => {
  for (const [error, kind] of [
    [{ code: "42501" }, "denied"],
    [{ code: "22023" }, "invalid"],
    [{ code: "P0002" }, "not-found"],
    [{ code: "40001" }, "unavailable"],
    [{ code: "XX000" }, "unavailable"],
  ]) {
    const repository = createWorkerDirectoryRepository(async () => ({ data: null, error }));
    const result = await repository.listWorkers({ ...actor, ...query });
    assert.deepEqual(result, { ok: false, kind }, JSON.stringify(error));
  }

  for (const data of [
    null,
    {},
    { ...payload, scope: "recruited" },
    { ...payload, page_size: 50 },
    { ...payload, items: [{ ...row, national_id: "012345678901" }] },
    { ...payload, next_cursor: "nope", has_more: true },
  ]) {
    const repository = createWorkerDirectoryRepository(async () => ({ data, error: null }));
    const result = await repository.listWorkers({ ...actor, ...query });
    assert.deepEqual(result, { ok: false, kind: "unavailable" });
  }

  const throwing = createWorkerDirectoryRepository(async () => {
    throw new Error("boom");
  });
  assert.deepEqual(await throwing.listWorkers({ ...actor, ...query }),
    { ok: false, kind: "unavailable" });
});
