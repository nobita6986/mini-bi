import assert from "node:assert/strict";
import test from "node:test";

import {
  SUBMISSION_READ_RPC_NAMES,
  classifySubmissionReadError,
  createSubmissionReadRepository,
} from "./submission-read-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const submissionId = "b1000000-0000-4000-8000-000000000001",
  entryA = "c1000000-0000-4000-8000-000000000001";
const createdAt = "2026-10-04T09:00:00.000000Z";
const cursor = "20261004090100000000:" + submissionId;

const listItem = {
  submission_id: submissionId,
  state: "DRAFT",
  version: 1,
  entry_count: 1,
  created_at: createdAt,
  updated_at: createdAt,
  submitted_at: null,
  allowed_transitions: ["REVIEW"],
};
const listPayload = { items: [listItem], page_size: 20, has_more: false, next_cursor: null };
const detailPayload = { ...listItem, entry_ids: [entryA] };

test("submission read repository exposes only the two read RPCs", () => {
  assert.deepEqual([...SUBMISSION_READ_RPC_NAMES], [
    "direct_entry_list_own_submissions",
    "direct_entry_read_own_submission",
  ]);
  for (const forbidden of [
    "direct_entry_transition_submission",
    "direct_entry_create_change_request",
    "direct_entry_list_change_requests",
    "direct_entry_read_change_request",
    "direct_entry_assert_actor",
  ]) {
    assert.equal(SUBMISSION_READ_RPC_NAMES.includes(forbidden), false, forbidden);
  }
});

test("list and detail call only their own RPC with server actor and exact query", async () => {
  const calls = [];
  const repository = createSubmissionReadRepository(async (name, args) => {
    calls.push({ name, args });
    return name === "direct_entry_list_own_submissions"
      ? { data: listPayload, error: null }
      : { data: detailPayload, error: null };
  });
  assert.deepEqual(await repository.listOwnSubmissions({
    ...actor, page_size: 20, cursor, state: "REVIEW",
  }), { ok: true, data: listPayload });
  assert.deepEqual(await repository.readOwnSubmission({ ...actor, submission_id: submissionId }), {
    ok: true, data: detailPayload,
  });
  assert.deepEqual(calls, [
    {
      name: "direct_entry_list_own_submissions",
      args: {
        p_auth_subject: actor.auth_subject,
        p_app_user_id: actor.app_user_id,
        p_page_size: 20,
        p_cursor: cursor,
        p_state: "REVIEW",
      },
    },
    {
      name: "direct_entry_read_own_submission",
      args: {
        p_auth_subject: actor.auth_subject,
        p_app_user_id: actor.app_user_id,
        p_submission_id: submissionId,
      },
    },
  ]);
});

test("SQLSTATE classification stays fail-closed for reads", async () => {
  assert.equal(classifySubmissionReadError({ code: "42501" }), "denied");
  assert.equal(classifySubmissionReadError({ code: "P0002" }), "not-found");
  assert.equal(classifySubmissionReadError({ code: "22023" }), "invalid");
  for (const [error, kind] of [
    [{ code: "42501" }, "denied"],
    [{ code: "P0002" }, "not-found"],
    [{ code: "22023" }, "invalid"],
    [{ code: "40001" }, "unavailable"],
    [{ code: "23505" }, "unavailable"],
    [{ code: "XX000", message: "boom" }, "unavailable"],
  ]) {
    const repository = createSubmissionReadRepository(async () => ({ data: null, error }));
    assert.deepEqual(await repository.listOwnSubmissions({
      ...actor, page_size: 20, cursor: null, state: null,
    }), { ok: false, kind }, JSON.stringify(error));
  }
});

test("malformed RPC payloads fail closed without partial data", async () => {
  const listPayloads = [
    null,
    [],
    "{}",
    { items: [], page_size: 20, has_more: false },
    { items: [], page_size: 20, has_more: false, next_cursor: null, extra: 1 },
    { items: [{ ...listItem, state: "SUBMITTED" }], page_size: 20, has_more: false, next_cursor: null },
    { items: [{ ...listItem, created_by_user_id: entryA }], page_size: 20, has_more: false, next_cursor: null },
  ];
  for (const payload of listPayloads) {
    const repository = createSubmissionReadRepository(async () => ({ data: payload, error: null }));
    assert.deepEqual(
      await repository.listOwnSubmissions({ ...actor, page_size: 20, cursor: null, state: null }),
      { ok: false, kind: "unavailable" },
      JSON.stringify(payload),
    );
  }
  const detailPayloads = [
    null,
    { ...detailPayload, submission_id: "b1000000-0000-4000-8000-000000000002" },
    { ...detailPayload, entry_ids: [] },
    { ...detailPayload, entry_ids: [entryA, entryA], entry_count: 2 },
    { ...detailPayload, worker_details: { display_name: "x" } },
    { ...detailPayload, payment: { state: "unknown" } },
  ];
  for (const payload of detailPayloads) {
    const repository = createSubmissionReadRepository(async () => ({ data: payload, error: null }));
    assert.deepEqual(
      await repository.readOwnSubmission({ ...actor, submission_id: submissionId }),
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
    const repository = createSubmissionReadRepository(async () => {
      throw new Error("private b1000000 submission detail");
    });
    const result = await repository.readOwnSubmission({ ...actor, submission_id: submissionId });
    assert.deepEqual(result, { ok: false, kind: "unavailable" });
    assert.doesNotMatch(JSON.stringify(result), /b1000000|private/);
    assert.doesNotMatch(logged.join(" "), /b1000000|private/);
  } finally {
    console.error = originalError;
  }
});
