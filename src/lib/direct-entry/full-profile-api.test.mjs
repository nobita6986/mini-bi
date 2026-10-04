import assert from "node:assert/strict";
import test from "node:test";

import { postFullProfileBatch } from "./full-profile-api.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const row = {
  project_id: "project_synthetic_01",
  first_work_date: "2025-03-04",
  employee_code: "hrp-2025-000001",
  recruiter_id: "93000000-0000-4000-8000-000000000001",
  labor_type: "TEMPORARY",
  display_name: "Synthetic Worker",
  worker: { national_id: { state: "provided", value: "012345678901" } },
};
const payload = { contract_version: "worker-profile/1.0", rows: [row] };
const rpcResult = {
  submission_id: "a1000000-0000-4000-8000-000000000001",
  state: "DRAFT",
  version: 1,
  entry_ids: ["a2000000-0000-4000-8000-000000000001"],
  replayed: false,
};
const key = "b1000000-0000-4000-8000-000000000001";

function request(body = payload, headers = {}) {
  return new Request("https://example.test/api/direct-entry/batches/full-profile", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": key,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function deps(overrides = {}) {
  const calls = [];
  let sessionCalls = 0;
  return {
    calls,
    get sessionCalls() { return sessionCalls; },
    resolveSession: async () => {
      sessionCalls += 1;
      return { actor: { ok: true, actor }, response_headers: {} };
    },
    repository: {
      async createFullProfileBatch(input) {
        calls.push(input);
        return { ok: true, data: rpcResult };
      },
      ...overrides,
    },
  };
}

test("feature gate, same-origin, content type and idempotency validation precede auth", async () => {
  const dependencies = deps();
  assert.equal((await postFullProfileBatch(request(), undefined, dependencies)).status, 404);
  assert.equal((await postFullProfileBatch(request(payload, {
    origin: "https://attacker.test",
  }), "true", dependencies)).status, 403);
  assert.equal((await postFullProfileBatch(request(payload, {
    "content-type": "application/jsonp",
  }), "true", dependencies)).status, 400);
  assert.equal((await postFullProfileBatch(request(payload, {
    "idempotency-key": "not-a-uuid",
  }), "true", dependencies)).status, 400);
  assert.equal(dependencies.sessionCalls, 0);
  assert.equal(dependencies.calls.length, 0);
});

test("valid payload calls only the full-profile repository with trusted actor and safe response", async () => {
  const dependencies = deps();
  const response = await postFullProfileBatch(request(), "true", dependencies);
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.deepEqual(dependencies.calls[0], {
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    payload: {
      contract_version: "worker-profile/1.0",
      rows: [{
        project_id: row.project_id,
        first_work_date: row.first_work_date,
        employee_code: row.employee_code,
        recruiter_id: row.recruiter_id,
        labor_type: row.labor_type,
        display_name: row.display_name,
        worker_details: {
          gender: { state: "omitted" },
          date_of_birth: { state: "omitted" },
          national_id: { state: "provided", value: "012345678901" },
          national_id_issued_at: { state: "omitted" },
          national_id_issued_place: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "omitted" },
        },
        general_note: { state: "omitted" },
        payment: null,
        employment: null,
      }],
    },
    idempotency_key: key,
  });
  assert.deepEqual(body, {
    ok: true,
    submission_id: rpcResult.submission_id,
    state: "DRAFT",
    version: 1,
    entry_ids: rpcResult.entry_ids,
  });
  assert.equal(JSON.stringify(body).includes("012345678901"), false);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("idempotent replay is 200 and conflicts are 409", async () => {
  const replay = deps({
    async createFullProfileBatch() {
      return { ok: true, data: { ...rpcResult, replayed: true } };
    },
  });
  assert.equal((await postFullProfileBatch(request(), "true", replay)).status, 200);
  const conflict = deps({
    async createFullProfileBatch() { return { ok: false, kind: "conflict" }; },
  });
  assert.equal((await postFullProfileBatch(request(), "true", conflict)).status, 409);
});

test("body limit, row validation and database errors map to bounded statuses", async () => {
  const tooLarge = await postFullProfileBatch(
    request("x".repeat(4 * 1024 * 1024 + 1)),
    "true",
    deps(),
  );
  assert.equal(tooLarge.status, 413);
  const malformed = await postFullProfileBatch(request({
    ...payload,
    rows: [{ ...row, worker: { phone: { state: "omitted" }, team_id: "forbidden" } }],
  }), "true", deps());
  assert.equal(malformed.status, 400);
  const denied = deps({
    async createFullProfileBatch() { return { ok: false, kind: "denied" }; },
  });
  assert.equal((await postFullProfileBatch(request(), "true", denied)).status, 403);
  const invalid = deps({
    async createFullProfileBatch() {
      return { ok: false, kind: "invalid", code: "BANK_NOT_ACTIVE" };
    },
  });
  const response = await postFullProfileBatch(request(), "true", invalid);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, code: "BANK_NOT_ACTIVE" });
});

test("unauthenticated and malformed RPC responses fail closed", async () => {
  const unauthenticated = deps();
  unauthenticated.resolveSession = async () => ({
    actor: { ok: false, reason: "UNAUTHENTICATED" },
    response_headers: {},
  });
  assert.equal((await postFullProfileBatch(request(), "true", unauthenticated)).status, 401);
  const malformed = deps({
    async createFullProfileBatch() {
      return { ok: true, data: { ...rpcResult, national_id: "should not be returned" } };
    },
  });
  assert.equal((await postFullProfileBatch(request(), "true", malformed)).status, 500);
});
