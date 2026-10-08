import assert from "node:assert/strict";
import test from "node:test";

import { createFullProfileRepository } from "./full-profile-repository.ts";

const payload = {
  contract_version: "worker-profile/1.0",
  rows: [],
};

test("repository invokes only the versioned full-profile RPC with trusted inputs", async () => {
  const calls = [];
  const repository = createFullProfileRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: { submission_id: "synthetic" }, error: null };
  });
  const result = await repository.createFullProfileBatch({
    auth_subject: "91000000-0000-4000-8000-000000000001",
    app_user_id: "92000000-0000-4000-8000-000000000001",
    payload,
    idempotency_key: "b1000000-0000-4000-8000-000000000001",
  });
  assert.deepEqual(calls, [{
    name: "direct_entry_create_full_profile_batch",
    args: {
      p_auth_subject: "91000000-0000-4000-8000-000000000001",
      p_app_user_id: "92000000-0000-4000-8000-000000000001",
      p_contract_version: "worker-profile/1.0",
      p_rows: [],
      p_idempotency_key: "b1000000-0000-4000-8000-000000000001",
    },
  }]);
  assert.deepEqual(result, { ok: true, data: { submission_id: "synthetic" } });
});

test("repository routes worker-profile/1.1 only to its versioned server-code RPC", async () => {
  const calls = [];
  const repository = createFullProfileRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: { ok: true }, error: null };
  });
  const payloadV2 = {
    contract_version: "worker-profile/1.1",
    rows: [{
      project_id: "project_synthetic",
      first_work_date: "2025-03-04",
      recruiter_id: "93000000-0000-4000-8000-000000000001",
      provider_type: "hrp",
      labor_type: "TEMPORARY",
      display_name: "Synthetic Worker",
    }],
  };
  await repository.createFullProfileBatch({
    auth_subject: "91000000-0000-4000-8000-000000000001",
    app_user_id: "92000000-0000-4000-8000-000000000001",
    payload: payloadV2,
    idempotency_key: "b1000000-0000-4000-8000-000000000002",
  });
  assert.equal(calls[0].name, "direct_entry_create_full_profile_batch_v2");
  assert.deepEqual(calls[0].args.p_rows, payloadV2.rows);
});

test("repository sanitizes conflict, authorization, validation, and infrastructure errors", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    for (const [error, expected] of [
      [{ code: "22023", message: "idempotency key reused with different input" }, { ok: false, kind: "conflict" }],
      [{ code: "42501", message: "permission denied with sensitive details" }, { ok: false, kind: "denied" }],
      [{ code: "22023", message: "BANK_NOT_ACTIVE" }, { ok: false, kind: "invalid", code: "BANK_NOT_ACTIVE" }],
      [{ code: "23505", message: "national-id value leaked" }, {
        ok: false, kind: "invalid", code: "BATCH_INVALID",
      }],
    ]) {
      const repository = createFullProfileRepository(async () => ({
        data: null,
        error,
      }));
      const result = await repository.createFullProfileBatch({
        auth_subject: "91000000-0000-4000-8000-000000000001",
        app_user_id: "92000000-0000-4000-8000-000000000001",
        payload,
        idempotency_key: "b1000000-0000-4000-8000-000000000001",
      });
      assert.deepEqual(result, expected);
    }
  } finally {
    console.warn = originalWarn;
  }
});

test("repository logs only sanitized denial diagnostics", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const payloadV2 = {
      contract_version: "worker-profile/1.1",
      rows: [{ project_id: "project-a", payment: null, employment: null },
        { project_id: "project-b", payment: { state: "provided" },
          employment: { initial_status: "OFF" } }],
    };
    const repository = createFullProfileRepository(async () => ({
      data: null,
      error: { code: "42501", message: "worker create authority denied" },
    }));
    await repository.createFullProfileBatch({
      auth_subject: "91000000-0000-4000-8000-000000000001",
      app_user_id: "92000000-0000-4000-8000-000000000001",
      payload: payloadV2,
      idempotency_key: "b1000000-0000-4000-8000-000000000003",
    });
    assert.deepEqual(warnings, [["[direct-entry] full-profile denied", {
      category: "CREATE_AUTHORITY",
      contract_version: "worker-profile/1.1",
      row_count: 2,
      distinct_project_count: 2,
      payment_row_count: 1,
      employment_row_count: 1,
    }]]);
    assert.equal(JSON.stringify(warnings).includes("worker create authority denied"), false);
  } finally {
    console.warn = originalWarn;
  }
});

test("repository source has no direct table access or secondary RPC", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./full-profile-repository.ts", import.meta.url), "utf8");
  assert.match(source, /direct_entry_create_full_profile_batch/);
  assert.doesNotMatch(source, /\.from\s*\(/);
  assert.doesNotMatch(source, /select\s+.+from|insert\s+into|update\s+\w+|delete\s+from/i);
});
