import assert from "node:assert/strict";
import test from "node:test";

import {
  createChangeRequest,
  decideChangeRequest,
  withdrawChangeRequest,
} from "./change-request-api.ts";
import {
  buildEntryFieldProposal,
  workerEntryFormFromBaseline,
} from "./change-request-proposal-builders.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
  capabilities: ["change_request_create", "change_review"],
  ok: true,
};
const entryA = "c1000000-0000-4000-8000-000000000001";
const entryB = "c1000000-0000-4000-8000-000000000002";
const requestId = "d1000000-0000-4000-8000-000000000001";
const idempotencyKey = "change-request-synthetic-key";

function createBody(overrides = {}) {
  return {
    items: [{ entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1, proposal: { labor_type: "PERMANENT" } }],
    reason: "Synthetic change reason",
    idempotency_key: idempotencyKey,
    ...overrides,
  };
}

function request(body, headers = {}, path = "/api/direct-entry/change-requests") {
  return new Request("https://example.test" + path, {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function dependencies(overrides = {}) {
  const calls = [];
  let sessions = 0;
  return {
    calls,
    sessionCount: () => sessions,
    resolveSession: async () => {
      sessions += 1;
      return { actor: { ok: true, actor }, response_headers: {} };
    },
    repository: {
      async createChangeRequest(input) {
        calls.push({ name: "create", input });
        return { ok: true, data: { request_id: requestId, state: "PENDING", items: input.items.length } };
      },
      async withdrawChangeRequest(input) {
        calls.push({ name: "withdraw", input });
        return { ok: true, data: { request_id: requestId, state: "WITHDRAWN", version: input.expected_version + 1 } };
      },
      async approveChangeRequest(input) {
        calls.push({ name: "approve", input });
        return { ok: true, data: { request_id: requestId, state: "APPROVED", version: input.expected_version + 1 } };
      },
      async rejectChangeRequest(input) {
        calls.push({ name: "reject", input });
        return { ok: true, data: { request_id: requestId, state: "REJECTED", version: input.expected_version + 1 } };
      },
      ...overrides,
    },
  };
}

test("gate, CSRF, requestId, content-type and authority injection fail before session", async () => {
  const deps = dependencies();
  assert.equal((await createChangeRequest(request(createBody()), undefined, deps)).status, 404);
  assert.equal((await withdrawChangeRequest(
    request({ expected_version: 1, idempotency_key: "k" }), requestId, undefined, deps)).status, 404);
  assert.equal((await decideChangeRequest(
    request({ decision: "approve", expected_version: 1, reason: "x", idempotency_key: "k" }),
    requestId, undefined, deps)).status, 404);

  assert.equal((await createChangeRequest(
    request(createBody(), { origin: "https://attacker.test" }), "true", deps)).status, 403);
  assert.equal((await withdrawChangeRequest(
    request({ expected_version: 1, idempotency_key: "k" }), "not-a-uuid", "true", deps)).status, 400);
  assert.equal((await decideChangeRequest(
    request({ decision: "approve", expected_version: 1, reason: "x", idempotency_key: "k" }),
    "not-a-uuid", "true", deps)).status, 400);
  assert.equal((await createChangeRequest(
    request(createBody(), { "content-type": "text/plain" }), "true", deps)).status, 400);
  assert.equal((await createChangeRequest(request("not json"), "true", deps)).status, 400);

  const authority = await createChangeRequest(request(createBody({
    items: [{
      entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1,
      proposal: { labor_type: "PERMANENT", capability: "change_review" },
    }],
  })), "true", deps);
  assert.equal(authority.status, 400);
  assert.equal((await authority.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");

  const mismatch = await createChangeRequest(
    request(createBody(), { "idempotency-key": "different-key" }), "true", deps);
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).code, "IDEMPOTENCY_KEY_MISMATCH");

  const matched = await createChangeRequest(
    request(createBody(), { "idempotency-key": idempotencyKey }), "true", deps);
  assert.equal(matched.status, 200);
  assert.equal(deps.sessionCount(), 1);
  assert.equal(deps.calls.length, 1);
});

test("session and actor mapping fail closed before the repository", async () => {
  for (const [session, status, code] of [
    [{ actor: { ok: false, reason: "UNAUTHENTICATED" } }, 401, "UNAUTHENTICATED"],
    [{ actor: { ok: false, reason: "ACTOR_DISABLED" } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: false, reason: "ACTOR_MAPPING_MISSING" } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: { auth_subject: actor.auth_subject } } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: null } }, 403, "ACTOR_NOT_AVAILABLE"],
  ]) {
    const deps = dependencies();
    deps.resolveSession = async () => ({ ...session, response_headers: {} });
    const response = await createChangeRequest(request(createBody()), "true", deps);
    assert.equal(response.status, status, code);
    assert.equal((await response.json()).code, code);
    assert.equal(deps.calls.length, 0);
  }
  const throwing = dependencies();
  throwing.resolveSession = async () => { throw new Error("private session detail"); };
  const failed = await createChangeRequest(request(createBody()), "true", throwing);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { ok: false, code: "CHANGE_REQUEST_UNAVAILABLE" });
  assert.equal(throwing.calls.length, 0);
});

test("valid create uses only the server actor and returns the exact projection", async () => {
  const deps = dependencies();
  const response = await createChangeRequest(request(createBody({
    items: [
      { entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1, proposal: { labor_type: "PERMANENT" } },
      { entry_id: entryB, target_kind: "WORK_STATUS", expected_version: 1,
        proposal: { status: "OFF", effective_date: "2026-10-15", leave_reason: "Nghi viec" } },
    ],
  })), "true", deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, request_id: requestId, state: "PENDING", items: 2,
  });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(deps.calls[0].input, {
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    items: [
      { entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1, proposal: { labor_type: "PERMANENT" } },
      { entry_id: entryB, target_kind: "WORK_STATUS", expected_version: 1,
        proposal: { status: "OFF", effective_date: "2026-10-15", leave_reason: "Nghi viec" } },
    ],
    reason: "Synthetic change reason",
    idempotency_key: idempotencyKey,
  });
});

test("full-field ENTRY_FIELD builder output reaches create API with reason, OCC and idempotency", async () => {
  const baseline = {
    project_id: "project-old",
    first_work_date: "2026-10-01",
    employee_code: "hrp-2026-000001",
    recruiter_id: "22222222-2222-4222-8222-222222222222",
    labor_type: "PERMANENT",
    worker_details: {
      display_name: "Nguyen Van Synthetic",
      gender: { state: "provided", value: "MALE" },
      date_of_birth: { state: "provided", value: "1990-01-02" },
      national_id: { state: "unknown" },
      national_id_issued_at: { state: "omitted" },
      national_id_issued_place: { state: "provided", value: "Ha Noi" },
      address: { state: "unknown" },
      phone: { state: "unknown" },
    },
  };
  const form = workerEntryFormFromBaseline(baseline);
  form.project_id = "project-new";
  form.first_work_date = "2026-10-02";
  form.employee_code = "hrp-2026-000002";
  form.recruiter_id = "33333333-3333-4333-8333-333333333333";
  form.labor_type = "TEMPORARY";
  form.workerDetails.display_name = "Nguyen Van Corrected";
  form.workerDetails.phone = { state: "provided", text: "0900000000" };
  const built = buildEntryFieldProposal({ entryId: entryA, expectedVersion: 7, baseline, form });
  assert.equal(built.ok, true);
  const item = {
    entry_id: entryA,
    target_kind: "ENTRY_FIELD",
    expected_version: 7,
    proposal: built.proposal,
  };
  const reason = "Điều chỉnh theo hồ sơ đã xác minh";
  const key = "full-field-proposal-idempotency";
  const deps = dependencies();
  const response = await createChangeRequest(request(createBody({
    items: [item], reason, idempotency_key: key,
  })), "true", deps);
  assert.equal(response.status, 200);
  assert.deepEqual(deps.calls[0].input, {
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    items: [item],
    reason,
    idempotency_key: key,
  });
});

test("DOCUMENT and mixed DOCUMENT create return sanitized 400 before session/repository", async () => {
  const documentItem = {
    entry_id: entryB,
    target_kind: "DOCUMENT",
    expected_version: 1,
    proposal: {
      document_type: "EMPLOYMENT_CONTRACT",
      idempotency_key: "document-synthetic-key",
      checksum_sha256: "a".repeat(64),
      size_bytes: 2048,
      mime_type: "application/pdf",
    },
  };
  for (const items of [[documentItem], [
    { entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1, proposal: { labor_type: "PERMANENT" } },
    documentItem,
  ]]) {
    const deps = dependencies();
    const response = await createChangeRequest(request(createBody({ items })), "true", deps);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      code: "DOCUMENT_CHANGE_REQUEST_UNSUPPORTED",
    });
    assert.equal(deps.sessionCount(), 0);
    assert.equal(deps.calls.length, 0);
  }
});

test("withdraw and decision dispatch to the matching repository method only", async () => {
  const withdrawDeps = dependencies();
  const withdrawn = await withdrawChangeRequest(
    request({ expected_version: 2, idempotency_key: "withdraw-key" }, {}, "/api/direct-entry/change-requests/x/withdraw"),
    requestId, "true", withdrawDeps);
  assert.equal(withdrawn.status, 200);
  assert.deepEqual(await withdrawn.json(), {
    ok: true, request_id: requestId, state: "WITHDRAWN", version: 3,
  });
  assert.deepEqual(withdrawDeps.calls.map(({ name }) => name), ["withdraw"]);

  for (const decision of ["approve", "reject"]) {
    const deps = dependencies();
    const response = await decideChangeRequest(
      request({ decision, expected_version: 2, reason: "Synthetic decision", idempotency_key: "decision-key" }),
      requestId, "true", deps);
    assert.equal(response.status, 200, decision);
    assert.deepEqual(await response.json(), {
      ok: true,
      request_id: requestId,
      state: decision === "approve" ? "APPROVED" : "REJECTED",
      version: 3,
    });
    assert.deepEqual(deps.calls.map(({ name }) => name), [
      decision === "approve" ? "approve" : "reject",
    ]);
    assert.deepEqual(deps.calls[0].input, {
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      request_id: requestId,
      expected_version: 2,
      reason: "Synthetic decision",
      idempotency_key: "decision-key",
    });
  }

  for (const decision of ["APPROVE", "delete", "", 7, null]) {
    const response = await decideChangeRequest(
      request({ decision, expected_version: 2, reason: "x", idempotency_key: "k" }),
      requestId, "true", dependencies());
    assert.equal(response.status, 400, String(decision));
  }
});

test("repository kinds map to a consistent sanitized HTTP vocabulary", async () => {
  const cases = [
    { handler: "withdraw", kinds: { denied: [403, "CHANGE_REQUEST_DENIED"], conflict: [409, "CHANGE_REQUEST_CONFLICT"],
      invalid: [400, "CHANGE_REQUEST_INVALID"], "not-found": [404, "CHANGE_REQUEST_NOT_FOUND"],
      unavailable: [500, "CHANGE_REQUEST_UNAVAILABLE"] } },
    { handler: "decision", kinds: { denied: [403, "CHANGE_REQUEST_DENIED"], conflict: [409, "CHANGE_REQUEST_CONFLICT"],
      invalid: [400, "CHANGE_REQUEST_INVALID"], "not-found": [404, "CHANGE_REQUEST_NOT_FOUND"],
      unavailable: [500, "CHANGE_REQUEST_UNAVAILABLE"] } },
    { handler: "create", kinds: { denied: [403, "CHANGE_REQUEST_DENIED"], conflict: [409, "CHANGE_REQUEST_CONFLICT"],
      invalid: [400, "CHANGE_REQUEST_INVALID"], "not-found": [404, "ENTRY_NOT_FOUND"],
      unavailable: [500, "CHANGE_REQUEST_UNAVAILABLE"] } },
  ];
  for (const { handler, kinds } of cases) {
    for (const [kind, [status, code]] of Object.entries(kinds)) {
      const deps = dependencies({
        async createChangeRequest() { return { ok: false, kind }; },
        async withdrawChangeRequest() { return { ok: false, kind }; },
        async approveChangeRequest() { return { ok: false, kind }; },
        async rejectChangeRequest() { return { ok: false, kind }; },
      });
      const response = handler === "create"
        ? await createChangeRequest(request(createBody()), "true", deps)
        : handler === "withdraw"
          ? await withdrawChangeRequest(
            request({ expected_version: 1, idempotency_key: "k" }), requestId, "true", deps)
          : await decideChangeRequest(
            request({ decision: "reject", expected_version: 1, reason: "x", idempotency_key: "k" }),
            requestId, "true", deps);
      assert.equal(response.status, status, handler + "/" + kind);
      assert.deepEqual(await response.json(), { ok: false, code }, handler + "/" + kind);
    }
  }
});

test("raw database errors, reasons and PII never reach the response or the log", async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const deps = dependencies({
      async createChangeRequest() {
        throw new Error("private 000012340056 account detail reason=duyet-noi-bo");
      },
    });
    const response = await createChangeRequest(request(createBody()), "true", deps);
    assert.equal(response.status, 500);
    const body = JSON.stringify(await response.json());
    assert.doesNotMatch(body, /000012340056|private|duyet-noi-bo/);
    assert.doesNotMatch(logged.join(" "), /000012340056|private|duyet-noi-bo/);
  } finally {
    console.error = originalError;
  }
});
