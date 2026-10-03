import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANGE_REQUEST_READ_RPC_NAMES,
  classifyChangeRequestReadError,
  createChangeRequestReadRepository,
} from "./change-request-read-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const entryA = "c1000000-0000-4000-8000-000000000001";
const requestId = "d1000000-0000-4000-8000-000000000001";
const createdAt = "2026-10-03T10:00:00.000000Z";
const cursor = "20261003100400000000:" + requestId;

const listItem = {
  request_id: requestId,
  state: "PENDING",
  version: 1,
  created_at: createdAt,
  item_count: 1,
  entry_ids: [entryA],
  can_withdraw: false,
  can_decide: true,
};
const listPayload = { requests: [listItem], page_size: 20, has_more: false, next_cursor: null };
const detailPayload = {
  request_id: requestId,
  state: "PENDING",
  version: 1,
  created_at: createdAt,
  items: [{ entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1,
    proposal: { labor_type: "PERMANENT" } }],
  can_withdraw: false,
  can_decide: true,
};

test("read repository exposes only the two read RPCs", () => {
  assert.deepEqual([...CHANGE_REQUEST_READ_RPC_NAMES], [
    "direct_entry_list_change_requests",
    "direct_entry_read_change_request",
  ]);
  for (const forbidden of [
    "direct_entry_create_change_request",
    "direct_entry_withdraw_change_request",
    "direct_entry_approve_change_request",
    "direct_entry_reject_change_request",
    "direct_entry_decide_change_request",
  ]) {
    assert.equal(CHANGE_REQUEST_READ_RPC_NAMES.includes(forbidden), false, forbidden);
  }
});

test("list calls only the list RPC with server actor and exact query", async () => {
  const calls = [];
  const repository = createChangeRequestReadRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: listPayload, error: null };
  });
  const result = await repository.listChangeRequests({
    ...actor, page_size: 20, cursor, state: "PENDING",
  });
  assert.deepEqual(result, { ok: true, data: listPayload });
  assert.deepEqual(calls, [{
    name: "direct_entry_list_change_requests",
    args: {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_page_size: 20,
      p_cursor: cursor,
      p_state: "PENDING",
    },
  }]);
});

test("detail calls only the read RPC and projects strictly", async () => {
  const calls = [];
  const repository = createChangeRequestReadRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: detailPayload, error: null };
  });
  assert.deepEqual(await repository.readChangeRequest({ ...actor, request_id: requestId }), {
    ok: true, data: detailPayload,
  });
  assert.deepEqual(calls, [{
    name: "direct_entry_read_change_request",
    args: {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_request_id: requestId,
    },
  }]);
});

test("SQLSTATE classification stays fail-closed for reads", async () => {
  assert.equal(classifyChangeRequestReadError({ code: "P0002" }), "not-found");
  assert.equal(classifyChangeRequestReadError({ code: "42501" }), "denied");
  assert.equal(classifyChangeRequestReadError({ code: "22023" }), "invalid");
  for (const [error, kind] of [
    [{ code: "P0002" }, "not-found"],
    [{ code: "42501" }, "denied"],
    [{ code: "22023" }, "invalid"],
    [{ code: "40001" }, "unavailable"],
    [{ code: "23505" }, "unavailable"],
    [{ code: "XX000", message: "boom" }, "unavailable"],
  ]) {
    const repository = createChangeRequestReadRepository(async () => ({ data: null, error }));
    assert.deepEqual(await repository.listChangeRequests({
      ...actor, page_size: 20, cursor: null, state: null,
    }), { ok: false, kind }, JSON.stringify(error));
  }
});

test("malformed or unknown RPC payloads fail closed without partial data", async () => {
  const listPayloads = [
    null,
    [],
    "[]",
    { requests: [], page_size: 20, has_more: false },
    { requests: [], page_size: 20, has_more: false, next_cursor: null, extra: 1 },
    { requests: [{ ...listItem, can_decide: 1 }], page_size: 20, has_more: false, next_cursor: null },
    { requests: [{ ...listItem, created_by_user_id: entryA }], page_size: 20, has_more: false, next_cursor: null },
  ];
  for (const payload of listPayloads) {
    const repository = createChangeRequestReadRepository(async () => ({ data: payload, error: null }));
    assert.deepEqual(
      await repository.listChangeRequests({ ...actor, page_size: 20, cursor: null, state: null }),
      { ok: false, kind: "unavailable" },
      JSON.stringify(payload),
    );
  }

  const detailPayloads = [
    null,
    { ...detailPayload, request_id: "d1000000-0000-4000-8000-000000000002" },
    { ...detailPayload, items: [] },
    { ...detailPayload, reason: "S02B reason" },
    { ...detailPayload, items: [{ entry_id: entryA, target_kind: "ENTRY_FIELD",
      expected_version: 1, proposal: { unknown_field: 1 } }] },
  ];
  for (const payload of detailPayloads) {
    const repository = createChangeRequestReadRepository(async () => ({ data: payload, error: null }));
    assert.deepEqual(
      await repository.readChangeRequest({ ...actor, request_id: requestId }),
      { ok: false, kind: "unavailable" },
      JSON.stringify(payload),
    );
  }
});

test("transport failures are sanitized and never leak raw detail", async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const repository = createChangeRequestReadRepository(async () => {
      throw new Error("private d1000000 request detail");
    });
    const result = await repository.readChangeRequest({ ...actor, request_id: requestId });
    assert.deepEqual(result, { ok: false, kind: "unavailable" });
    assert.doesNotMatch(JSON.stringify(result), /d1000000|private/);
    assert.doesNotMatch(logged.join(" "), /d1000000|private/);
  } finally {
    console.error = originalError;
  }
});
