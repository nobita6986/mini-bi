import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANGE_REQUEST_RPC_NAMES,
  classifyChangeRequestError,
  createChangeRequestRepository,
} from "./change-request-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const entryA = "c1000000-0000-4000-8000-000000000001",
  entryB = "c1000000-0000-4000-8000-000000000002";
const requestId = "d1000000-0000-4000-8000-000000000001";
const proposal = { labor_type: "PERMANENT" };

test("repository exposes only the four granted change request RPCs", () => {
  assert.deepEqual([...CHANGE_REQUEST_RPC_NAMES], [
    "direct_entry_create_change_request",
    "direct_entry_withdraw_change_request",
    "direct_entry_approve_change_request",
    "direct_entry_reject_change_request",
  ]);
  assert.equal(CHANGE_REQUEST_RPC_NAMES.includes("direct_entry_decide_change_request"), false);
});

test("create calls the create RPC with server actor and exact items", async () => {
  const calls = [];
  const repository = createChangeRequestRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: { request_id: requestId, state: "PENDING", items: 2 }, error: null };
  });
  const items = [
    { entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1, proposal },
    { entry_id: entryB, target_kind: "ENTRY_FIELD", expected_version: 1, proposal },
  ];
  const result = await repository.createChangeRequest({
    ...actor, items, reason: "Synthetic reason", idempotency_key: "create-synthetic-key",
  });
  assert.deepEqual(result, {
    ok: true,
    data: { request_id: requestId, state: "PENDING", items: 2 },
  });
  assert.deepEqual(calls, [{
    name: "direct_entry_create_change_request",
    args: {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_items: items,
      p_reason: "Synthetic reason",
      p_idempotency_key: "create-synthetic-key",
    },
  }]);
});

test("withdraw, approve and reject call their own wrapper RPC and never the helper", async () => {
  const calls = [];
  const repository = createChangeRequestRepository(async (name, args) => {
    calls.push({ name, args });
    const state = name === "direct_entry_withdraw_change_request"
      ? "WITHDRAWN"
      : name === "direct_entry_approve_change_request" ? "APPROVED" : "REJECTED";
    return { data: { request_id: requestId, state, version: 3 }, error: null };
  });
  assert.deepEqual(await repository.withdrawChangeRequest({
    ...actor, request_id: requestId, expected_version: 2, idempotency_key: "withdraw-key",
  }), { ok: true, data: { request_id: requestId, state: "WITHDRAWN", version: 3 } });
  assert.deepEqual(await repository.approveChangeRequest({
    ...actor, request_id: requestId, expected_version: 2, reason: "duyet", idempotency_key: "approve-key",
  }), { ok: true, data: { request_id: requestId, state: "APPROVED", version: 3 } });
  assert.deepEqual(await repository.rejectChangeRequest({
    ...actor, request_id: requestId, expected_version: 2, reason: "tu choi", idempotency_key: "reject-key",
  }), { ok: true, data: { request_id: requestId, state: "REJECTED", version: 3 } });
  assert.deepEqual(calls.map(({ name }) => name), [
    "direct_entry_withdraw_change_request",
    "direct_entry_approve_change_request",
    "direct_entry_reject_change_request",
  ]);
  assert.deepEqual(calls[1].args, {
    p_auth_subject: actor.auth_subject,
    p_app_user_id: actor.app_user_id,
    p_request_id: requestId,
    p_expected_version: 2,
    p_reason: "duyet",
    p_idempotency_key: "approve-key",
  });
  for (const call of calls) {
    assert.equal(call.name === "direct_entry_decide_change_request", false);
  }
});

test("database denial codes are classified consistently with the S01A boundary", async () => {
  assert.equal(classifyChangeRequestError({ code: "40001" }), "conflict");
  assert.equal(classifyChangeRequestError({ code: "23505" }), "conflict");
  assert.equal(classifyChangeRequestError({ code: "42501" }), "denied");
  assert.equal(classifyChangeRequestError({ code: "P0002" }), "not-found");
  assert.equal(classifyChangeRequestError({ code: "23514" }), "invalid");
  assert.equal(classifyChangeRequestError({ code: "22023", message: "invalid change request item" }), "invalid");
  assert.equal(classifyChangeRequestError({
    code: "22023", message: "idempotency key reused with different input",
  }), "conflict");
  assert.equal(classifyChangeRequestError({ code: "XX000" }), "unavailable");

  for (const [error, kind] of [
    [{ code: "42501" }, "denied"],
    [{ code: "40001" }, "conflict"],
    [{ code: "P0002" }, "not-found"],
  ]) {
    const repository = createChangeRequestRepository(async () => ({ data: null, error }));
    assert.deepEqual(await repository.withdrawChangeRequest({
      ...actor, request_id: requestId, expected_version: 2, idempotency_key: "k",
    }), { ok: false, kind });
  }
});

test("malformed or mismatched RPC payloads fail closed", async () => {
  const createPayloads = [
    null,
    [],
    { request_id: requestId, state: "PENDING" },
    { request_id: requestId, state: "PENDING", items: 3 },
    { request_id: requestId, state: "APPROVED", items: 2 },
    { request_id: requestId, state: "PENDING", items: 2, reused: true },
    { request_id: "not-a-uuid", state: "PENDING", items: 2 },
  ];
  for (const payload of createPayloads) {
    const repository = createChangeRequestRepository(async () => ({ data: payload, error: null }));
    const result = await repository.createChangeRequest({
      ...actor,
      items: [
        { entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1, proposal },
        { entry_id: entryB, target_kind: "ENTRY_FIELD", expected_version: 1, proposal },
      ],
      reason: "Synthetic reason",
      idempotency_key: "create-synthetic-key",
    });
    assert.deepEqual(result, { ok: false, kind: "unavailable" }, JSON.stringify(payload));
  }

  const decisionPayloads = [
    { request_id: requestId, state: "REJECTED", version: 3 },
    { request_id: requestId, state: "APPROVED", version: 4 },
    { request_id: requestId, state: "APPROVED", version: 3, revision_id: requestId },
    { request_id: requestId, state: "APPROVED", version: 3, decided_at: "2026-10-03T00:00:00Z" },
  ];
  for (const payload of decisionPayloads) {
    const repository = createChangeRequestRepository(async () => ({ data: payload, error: null }));
    assert.deepEqual(await repository.approveChangeRequest({
      ...actor, request_id: requestId, expected_version: 2, reason: "duyet", idempotency_key: "k",
    }), { ok: false, kind: "unavailable" }, JSON.stringify(payload));
  }
});

test("transport failures are sanitized and never leak raw detail", async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const repository = createChangeRequestRepository(async () => {
      throw new Error("private d1000000 request detail");
    });
    const result = await repository.rejectChangeRequest({
      ...actor, request_id: requestId, expected_version: 2, reason: "private reason",
      idempotency_key: "k",
    });
    assert.deepEqual(result, { ok: false, kind: "unavailable" });
    assert.doesNotMatch(JSON.stringify(result), /d1000000|private/);
    assert.doesNotMatch(logged.join(" "), /d1000000|private/);
  } finally {
    console.error = originalError;
  }
});
