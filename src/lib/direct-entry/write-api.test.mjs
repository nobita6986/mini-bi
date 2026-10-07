import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { postDirectEntryBatch, getDirectEntryEntry } from "./write-api.ts";
import { createDirectEntryWriteRepository } from "./write-repository.ts";

const repositorySource = readFileSync(new URL("./write-repository.ts", import.meta.url), "utf8");
const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
  ok: true,
};
const session = async () => ({
  actor: { ok: true, actor },
  response_headers: {},
});
const validWorker = {
  display_name: "Synthetic Worker",
  date_of_birth: { state: "omitted" },
  national_id: { state: "omitted" },
  address: { state: "omitted" },
  phone: { state: "omitted" },
};
const validRow = {
  project_id: "project_synthetic_01",
  first_work_date: "2026-10-15",
  employee_code: "hrp-2026-000001",
  worker: validWorker,
  recruiter_id: "93000000-0000-4000-8000-000000000001",
  labor_type: "TEMPORARY",
};
const batchResult = {
  submission_id: "a1000000-0000-4000-8000-000000000001",
  state: "DRAFT",
  version: 1,
  entry_ids: ["a2000000-0000-4000-8000-000000000001"],
};

function request(body, headers = {}) {
  return new Request("https://example.test/api/direct-entry/batches", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": "synthetic-idem-01",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function dependencies(overrides = {}) {
  const calls = [];
  const catalogCalls = [];
  return {
    calls,
    catalogCalls,
    resolveSession: session,
    repository: {
      async loadInputCatalog(input) {
        catalogCalls.push(input);
        return {
          ok: true,
          data: {
            effective_date: validRow.first_work_date,
            projects: [{ project_id: validRow.project_id, display_name: "Synthetic project" }],
            recruiters: [{
              recruiter_id: validRow.recruiter_id,
              display_name: "Synthetic recruiter",
              personnel_code: "synthetic.td",
              provider_type: "hrp",
              vendor_id: null,
              team_id: "94000000-0000-4000-8000-000000000001",
              team_display_name: "Synthetic team",
              label: "Synthetic recruiter · synthetic.td · Synthetic team",
            }],
            banks: [],
          },
        };
      },
      async createBatch(input) {
        calls.push(input);
        return { ok: true, data: batchResult };
      },
      async readEntry(input) {
        calls.push(input);
        return { ok: true, data: input.projection };
      },
      ...overrides,
    },
  };
}

test("disabled gate and same-origin rejection happen before session or RPC", async () => {
  let sessions = 0;
  const deps = dependencies({
    async createBatch() { throw new Error("must not reach repository"); },
  });
  deps.resolveSession = async () => { sessions += 1; return session(); };
  const disabled = await postDirectEntryBatch(request({ rows: [validRow] }), undefined, deps);
  assert.equal(disabled.status, 404);
  const csrf = await postDirectEntryBatch(request({ rows: [validRow] }, {
    origin: "https://attacker.test",
  }), "true", deps);
  assert.equal(csrf.status, 403);
  assert.equal(sessions, 0);
});

test("valid batch uses trusted actor IDs and returns only the write projection", async () => {
  const deps = dependencies();
  const response = await postDirectEntryBatch(request({ rows: [validRow] }), "true", deps);
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.deepEqual(deps.calls, [{
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    rows: [{
      project_id: validRow.project_id,
      first_work_date: validRow.first_work_date,
      employee_code: validRow.employee_code,
      worker_details: validWorker,
      recruiter_id: validRow.recruiter_id,
      labor_type: validRow.labor_type,
    }],
    idempotency_key: "synthetic-idem-01",
  }]);
  assert.deepEqual(deps.catalogCalls, [{
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    effective_date: validRow.first_work_date,
  }]);
  assert.deepEqual(body, {
    ok: true,
    submission_id: batchResult.submission_id,
    submission_version: 1,
    entry_ids: batchResult.entry_ids,
    status: "DRAFT",
  });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("batch creation requires active project and recruiter from the trusted effective-date catalog", async () => {
  const invalid = dependencies({
    async loadInputCatalog() {
      return {
        ok: true,
        data: { effective_date: validRow.first_work_date, projects: [], recruiters: [], banks: [] },
      };
    },
  });
  const invalidResponse = await postDirectEntryBatch(
    request({ rows: [validRow] }), "true", invalid,
  );
  assert.equal(invalidResponse.status, 400);
  assert.equal(invalid.calls.length, 0);

  const unavailable = dependencies({
    async loadInputCatalog() { return { ok: false, kind: "unavailable" }; },
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await postDirectEntryBatch(request({ rows: [validRow] }), "true", unavailable);
    assert.equal(response.status, 500);
    assert.equal(JSON.stringify(await response.json()).includes("database"), false);
    assert.equal(unavailable.calls.length, 0);
  } finally {
    console.error = originalError;
  }
});

test("rejects CSRF, malformed JSON type, invalid idempotency key and oversized body", async () => {
  const deps = dependencies();
  for (const [input, expected] of [
    [request({ rows: [validRow] }, { "content-type": "application/jsonp" }), 400],
    [request({ rows: [validRow] }, { "idempotency-key": " " }), 400],
    [request({ rows: [validRow] }, { "idempotency-key": "x".repeat(129) }), 400],
  ]) {
    assert.equal((await postDirectEntryBatch(input, "true", deps)).status, expected);
  }
  const oversized = new Request("https://example.test/api/direct-entry/batches", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": "oversized",
    },
    body: `"${"x".repeat(65_536)}"`,
  });
  assert.equal((await postDirectEntryBatch(oversized, "true", deps)).status, 400);
  assert.equal(deps.calls.length, 0);
});

test("nested client authority fields are rejected before authentication or RPC", async () => {
  for (const payload of [
    { rows: [validRow], auth_subject: actor.auth_subject },
    { rows: [validRow], app_user_id: actor.app_user_id },
    { rows: [validRow], capability: "entry_admin" },
    { rows: [validRow], scope: { kind: "all" } },
    { rows: [validRow], created_by_user_id: actor.app_user_id },
    { rows: [{ ...validRow, worker: { ...validWorker, actor: "spoof" } }] },
    { rows: [{ ...validRow, nested: [{ created_by_user_id: actor.app_user_id }] }] },
    { rows: [{ ...validRow, team_id: "94000000-0000-4000-8000-000000000001" }] },
    { rows: [{ ...validRow, provider_type: "vendor" }] },
  ]) {
    let sessions = 0;
    const deps = dependencies();
    deps.resolveSession = async () => { sessions += 1; return session(); };
    const response = await postDirectEntryBatch(request(payload), "true", deps);
    assert.equal(response.status, 400);
    assert.equal(sessions, 0);
    assert.equal(deps.calls.length, 0);
  }
});

test("unauthenticated and invalid rows fail closed", async () => {
  const unauthenticated = dependencies();
  unauthenticated.resolveSession = async () => ({
    actor: { ok: false, reason: "UNAUTHENTICATED" },
    response_headers: {},
  });
  assert.equal((await postDirectEntryBatch(request({ rows: [validRow] }), "true", unauthenticated)).status, 401);
  assert.equal((await postDirectEntryBatch(request({ rows: [{ ...validRow, employee_code: "bad" }] }), "true", dependencies())).status, 400);
});

test("read validates UUID before session and keeps the restricted projection", async () => {
  const deps = dependencies();
  const invalid = await getDirectEntryEntry("not-a-uuid", "true", deps);
  assert.equal(invalid.status, 400);
  assert.equal(deps.calls.length, 0);

  const entryId = "a2000000-0000-4000-8000-000000000001";
  const projection = {
    entry_id: entryId,
    submission_id: batchResult.submission_id,
    project_id: "project_synthetic_01",
    first_work_date: "2026-10-15",
    employee_code: "hrp-2026-000001",
    worker_details: {},
    recruiter_id: validRow.recruiter_id,
    team_id: "94000000-0000-4000-8000-000000000001",
    provider_type: "hrp",
    labor_type: "TEMPORARY",
    version: 1,
    scope_kind: "own",
    payment: null,
    employment_status: { status: "UNCONFIRMED", effective_date: "2026-10-15", version: 1 },
    documents: [],
  };
  deps.repository.readEntry = async (input) => {
    deps.calls.push(input);
    return { ok: true, data: projection };
  };
  const response = await getDirectEntryEntry(entryId, "true", deps);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).entry, projection);
  assert.equal(deps.calls[0].auth_subject, actor.auth_subject);
  assert.equal(deps.calls[0].app_user_id, actor.app_user_id);

  deps.repository.readEntry = async () => ({
    ok: true,
    data: { ...projection, scope_kind: "project" },
  });
  const projectManagerResponse = await getDirectEntryEntry(entryId, "true", deps);
  assert.equal(projectManagerResponse.status, 200,
    "a project-manager-scoped draft projection is a valid server response");

  deps.repository.readEntry = async () => ({ ok: false, kind: "denied" });
  const denied = await getDirectEntryEntry(entryId, "true", deps);
  assert.equal(denied.status, 404);
  assert.equal((await denied.json()).code, "ENTRY_NOT_FOUND");

  deps.repository.readEntry = async () => ({
    ok: true,
    data: { ...projection, worker_details: { national_id: { state: "provided", value: 123 } } },
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const malformed = await getDirectEntryEntry(entryId, "true", deps);
    assert.equal(malformed.status, 500);
    assert.equal(JSON.stringify(await malformed.json()).includes("123"), false);
  } finally {
    console.error = originalError;
  }
});

test("repository calls create/read RPCs and sanitizes errors", async () => {
  const rpcCalls = [];
  const repository = createDirectEntryWriteRepository(async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === "direct_entry_create_batch") {
      return { data: null, error: { code: "22023", message: "idempotency key reused with different input" } };
    }
    return { data: null, error: { code: "42501", message: "raw private database detail" } };
  });
  const input = {
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
  };
  assert.deepEqual(await repository.createBatch({
    ...input, rows: [], idempotency_key: "idem",
  }), { ok: false, kind: "conflict" });
  assert.deepEqual(await repository.readEntry({
    ...input, entry_id: "a2000000-0000-4000-8000-000000000001",
  }), { ok: false, kind: "denied" });
  assert.deepEqual(rpcCalls.map(({ name }) => name), [
    "direct_entry_create_batch",
    "direct_entry_read_projection",
  ]);
  assert.doesNotMatch(repositorySource, /\.from\s*\(/);
  assert.doesNotMatch(repositorySource, /\.(?:select|insert|update|delete)\s*\(/);
  assert.deepEqual(rpcCalls[0].args, {
    p_auth_subject: actor.auth_subject,
    p_app_user_id: actor.app_user_id,
    p_rows: [],
    p_idempotency_key: "idem",
  });

  const originalError = console.error;
  const logged = [];
  console.error = (message) => logged.push(String(message));
  try {
    const throwing = createDirectEntryWriteRepository(async () => {
      throw new Error("raw database message and worker data");
    });
    assert.deepEqual(await throwing.createBatch({
      ...input, rows: [], idempotency_key: "throwing",
    }), { ok: false, kind: "unavailable" });
    assert.equal(logged.join(" ").includes("raw database message"), false);
    assert.equal(logged.join(" ").includes("worker data"), false);
  } finally {
    console.error = originalError;
  }
});

test("malformed RPC results and private database errors are not returned", async () => {
  const deps = dependencies({
    async createBatch() {
      return { ok: false, kind: "unavailable", message: "private database error" };
    },
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await postDirectEntryBatch(request({ rows: [validRow] }), "true", deps);
    assert.equal(response.status, 500);
    assert.equal(JSON.stringify(await response.json()).includes("private database error"), false);
    const malformed = dependencies({
      async createBatch() { return { ok: true, data: { private: "unexpected" } }; },
    });
    const malformedResponse = await postDirectEntryBatch(
      request({ rows: [validRow] }), "true", malformed,
    );
    assert.equal(malformedResponse.status, 500);
    assert.equal(JSON.stringify(await malformedResponse.json()).includes("unexpected"), false);
  } finally {
    console.error = originalError;
  }
});
