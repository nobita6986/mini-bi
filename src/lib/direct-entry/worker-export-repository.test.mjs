import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyWorkerExportError,
  createWorkerExportRepository,
  WORKER_EXPORT_RPC_NAMES,
} from "./worker-export-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const request = {
  scope: "recruited", project_id: null, recruiter_id: null, employment_status: null,
  search: null, first_work_date_from: null, first_work_date_to: null, provider_type: null,
  reason: "export test",
};
const row = {
  employee_code: "hrp-2026-300001",
  display_name: "Worker One",
  date_of_birth: "1990-01-01",
  national_id: "012345678901",
  national_id_issued_at: "2020-01-01",
  phone: "0900000001",
  address: "1 Street",
  project_display: "Project A",
  first_work_date: "2026-10-01",
  labor_type_display: "Thời vụ",
  recruiter_display: "Recruiter A",
  provider_type: "HRP",
  employment_status: "ON",
  leave_date: null,
  leave_reason: null,
  account_number: "012345678901",
  bank_name: null,
  account_holder_name: null,
  payment_note: null,
  general_note: null,
};

test("the worker export repository exposes exactly one RPC", () => {
  assert.deepEqual([...WORKER_EXPORT_RPC_NAMES], ["direct_entry_export_workers"]);
  for (const forbidden of [
    "direct_entry_list_workers",
    "direct_entry_read_projection",
    "direct_entry_worker_directory_audience",
  ]) {
    assert.equal(WORKER_EXPORT_RPC_NAMES.includes(forbidden), false, forbidden);
  }
});

test("exportWorkers calls only its RPC with the server actor and exact request", async () => {
  const calls = [];
  const repository = createWorkerExportRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: { status: "ok", rows: [row] }, error: null };
  });
  const result = await repository.exportWorkers({ ...actor, ...request, scope: "managed",
    project_id: "proj_a", recruiter_id: null, employment_status: "OFF",
    search: "000021", first_work_date_from: "2026-10-01", first_work_date_to: "2026-10-31",
    provider_type: "hrp", reason: "ly do" });
  assert.equal(result.ok, true);
  assert.equal(result.envelope.status, "ok");
  assert.equal(result.envelope.rows[0].national_id, "012345678901");
  assert.deepEqual(calls, [{
    name: "direct_entry_export_workers",
    args: {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_scope: "managed",
      p_project_id: "proj_a",
      p_recruiter_id: null,
      p_employment_status: "OFF",
      p_reason: "ly do",
      p_search: "000021",
      p_first_work_date_from: "2026-10-01",
      p_first_work_date_to: "2026-10-31",
      p_provider_type: "hrp",
    },
  }]);
});

test("SQLSTATE classification is fail-closed", () => {
  assert.equal(classifyWorkerExportError({ code: "42501" }), "denied");
  assert.equal(classifyWorkerExportError({ code: "22023" }), "invalid");
  assert.equal(classifyWorkerExportError({ code: "XX000" }), "unavailable");
  assert.equal(classifyWorkerExportError({}), "unavailable");
});

test("errors and malformed envelopes never produce a success", async () => {
  for (const [error, kind] of [
    [{ code: "42501" }, "denied"],
    [{ code: "22023" }, "invalid"],
    [{ code: "XX000" }, "unavailable"],
  ]) {
    const repository = createWorkerExportRepository(async () => ({ data: null, error }));
    assert.deepEqual(await repository.exportWorkers({ ...actor, ...request }),
      { ok: false, kind }, JSON.stringify(error));
  }

  for (const data of [
    null,
    {},
    { status: "ok" },
    { status: "ok", rows: [{ ...row, extra: 1 }] },
    { status: "too_many_rows", limit: 9999 },
    { status: "unknown", rows: [] },
  ]) {
    const repository = createWorkerExportRepository(async () => ({ data, error: null }));
    assert.deepEqual(await repository.exportWorkers({ ...actor, ...request }),
      { ok: false, kind: "unavailable" }, JSON.stringify(data));
  }

  const throwing = createWorkerExportRepository(async () => { throw new Error("boom"); });
  assert.deepEqual(await throwing.exportWorkers({ ...actor, ...request }),
    { ok: false, kind: "unavailable" });
});

test("RPC diagnostics log only a safe error code and never the database message", async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const repository = createWorkerExportRepository(async () => ({
      data: null,
      error: { code: "PGRST202", message: "PII and secret must stay out of logs" },
    }));
    assert.deepEqual(await repository.exportWorkers({ ...actor, ...request }),
      { ok: false, kind: "unavailable" });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(logged, [[
    "[direct-entry] worker export RPC returned error",
    { code: "PGRST202", kind: "unavailable" },
  ]]);
  assert.equal(JSON.stringify(logged).includes("PII and secret"), false);
});

test("the too_many_rows envelope is carried through, never turned into a file", async () => {
  const repository = createWorkerExportRepository(async () => ({
    data: { status: "too_many_rows", limit: 10000 }, error: null,
  }));
  const result = await repository.exportWorkers({ ...actor, ...request });
  assert.equal(result.ok, true);
  assert.deepEqual(result.envelope, { status: "too_many_rows", limit: 10000 });
  assert.equal("rows" in result.envelope, false);
});
