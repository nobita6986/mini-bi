import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deleteDraftSubmission,
  draftSubmissionDeleteErrorMessage,
  isDraftSubmissionDeleteKey,
} from "./draft-submission-delete-client.ts";

const SUBMISSION_ID = "00000000-0000-4000-8000-000000000001";
const KEY = "b1000000-0000-4000-8000-000000000001";

function successBody(overrides = {}) {
  return {
    ok: true,
    submission_id: SUBMISSION_ID,
    deleted: true,
    version: 4,
    entries_deleted: 2,
    cleanup_objects_queued: 3,
    ...overrides,
  };
}

async function call(init = {}) {
  const calls = [];
  const result = await deleteDraftSubmission({
    submissionId: SUBMISSION_ID,
    expectedVersion: 3,
    idempotencyKey: KEY,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json(successBody(), { status: 200 });
    },
    ...init,
  });
  return { result, calls };
}

test("request: DELETE đúng route, body chỉ có expected_version, có Idempotency-Key", async () => {
  const { result, calls } = await call();
  assert.deepEqual(result, {
    kind: "deleted",
    submissionId: SUBMISSION_ID,
    version: 4,
    entriesDeleted: 2,
    cleanupObjectsQueued: 3,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/direct-entry/submissions/${SUBMISSION_ID}`);
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[0].options.cache, "no-store");
  assert.deepEqual(calls[0].options.headers, {
    "Content-Type": "application/json",
    "Idempotency-Key": KEY,
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), { expected_version: 3 });
  // Khong gui authority/actor/scope.
  const raw = calls[0].options.body;
  for (const forbidden of ["actor", "capability", "scope", "app_user_id", "auth_subject"]) {
    assert.equal(raw.includes(forbidden), false);
  }
});

test("projection 200: strict, thiếu/thừa trường hoặc sai shape => retry (không báo đã xóa)", async () => {
  for (const body of [
    successBody({ ok: false }),
    successBody({ deleted: false }),
    successBody({ submission_id: "00000000-0000-4000-8000-000000000002" }),
    successBody({ version: 0 }),
    successBody({ entries_deleted: -1 }),
    successBody({ cleanup_objects_queued: -1 }),
    { ...successBody(), extra: true },
    { ok: true, deleted: true },
  ]) {
    const result = await deleteDraftSubmission({
      submissionId: SUBMISSION_ID,
      expectedVersion: 3,
      idempotencyKey: KEY,
      fetchImpl: async () => Response.json(body, { status: 200 }),
    });
    assert.deepEqual(result, { kind: "retry", code: "SUBMISSION_DELETE_RESPONSE_INVALID" });
  }
});

test("lỗi 409: SUBMISSION_CONFLICT/SUBMISSION_PROCESSING là conflict; 2xx lạ là retry", async () => {
  for (const code of ["SUBMISSION_CONFLICT", "SUBMISSION_PROCESSING"]) {
    const result = await deleteDraftSubmission({
      submissionId: SUBMISSION_ID,
      expectedVersion: 3,
      idempotencyKey: KEY,
      fetchImpl: async () => Response.json({ ok: false, code }, { status: 409 }),
    });
    assert.deepEqual(result, { kind: "conflict", code });
  }
  const other = await deleteDraftSubmission({
    submissionId: SUBMISSION_ID,
    expectedVersion: 3,
    idempotencyKey: KEY,
    fetchImpl: async () => Response.json({ ok: false, code: "SOMETHING" }, { status: 409 }),
  });
  assert.deepEqual(other, { kind: "rejected", code: "SOMETHING" });
  const twoHundred = await deleteDraftSubmission({
    submissionId: SUBMISSION_ID,
    expectedVersion: 3,
    idempotencyKey: KEY,
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  assert.deepEqual(twoHundred, { kind: "retry", code: "SUBMISSION_DELETE_RESPONSE_INVALID" });
});

test("lỗi quyền/không tìm thấy/phiên hết hạn là rejected (giữ bản nháp)", async () => {
  const cases = [
    [403, "SUBMISSION_DELETE_DENIED"],
    [404, "SUBMISSION_NOT_FOUND"],
    [401, "UNAUTHENTICATED"],
    [400, "SUBMISSION_DELETE_INVALID"],
  ];
  for (const [status, code] of cases) {
    const result = await deleteDraftSubmission({
      submissionId: SUBMISSION_ID,
      expectedVersion: 3,
      idempotencyKey: KEY,
      fetchImpl: async () => Response.json({ ok: false, code }, { status }),
    });
    assert.deepEqual(result, { kind: "rejected", code });
  }
});

test("5xx và lỗi mạng là retry (giữ nguyên để thử lại cùng key)", async () => {
  const server = await deleteDraftSubmission({
    submissionId: SUBMISSION_ID,
    expectedVersion: 3,
    idempotencyKey: KEY,
    fetchImpl: async () => Response.json({ ok: false, code: "SUBMISSION_DELETE_UNAVAILABLE" }, { status: 500 }),
  });
  assert.deepEqual(server, { kind: "retry", code: "SUBMISSION_DELETE_UNAVAILABLE" });
  const network = await deleteDraftSubmission({
    submissionId: SUBMISSION_ID,
    expectedVersion: 3,
    idempotencyKey: KEY,
    fetchImpl: async () => { throw new Error("down"); },
  });
  assert.deepEqual(network, { kind: "retry", code: "SUBMISSION_DELETE_NETWORK" });
});

test("input không hợp lệ bị chặn trước khi gọi mạng", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return Response.json(successBody(), { status: 200 }); };
  for (const input of [
    { submissionId: "not-a-uuid", expectedVersion: 3, idempotencyKey: KEY },
    { submissionId: SUBMISSION_ID, expectedVersion: 0, idempotencyKey: KEY },
    { submissionId: SUBMISSION_ID, expectedVersion: 3, idempotencyKey: "" },
    { submissionId: SUBMISSION_ID, expectedVersion: 3, idempotencyKey: "a".repeat(129) },
    { submissionId: SUBMISSION_ID, expectedVersion: 3, idempotencyKey: "co\u0000ntrol" },
  ]) {
    const result = await deleteDraftSubmission({ ...input, fetchImpl });
    assert.deepEqual(result, { kind: "rejected", code: "SUBMISSION_DELETE_INVALID" });
  }
  assert.equal(calls, 0);
  assert.equal(isDraftSubmissionDeleteKey(KEY), true);
  assert.equal(isDraftSubmissionDeleteKey(""), false);
});

test("thông báo lỗi nêu rõ bản nháp vẫn được giữ và không tuyên bố đã xóa storage", () => {
  const messages = [
    draftSubmissionDeleteErrorMessage({ kind: "retry", code: "SUBMISSION_DELETE_NETWORK" }),
    draftSubmissionDeleteErrorMessage({ kind: "retry", code: "SUBMISSION_DELETE_RESPONSE_INVALID" }),
    draftSubmissionDeleteErrorMessage({ kind: "retry", code: "SUBMISSION_DELETE_UNAVAILABLE" }),
    draftSubmissionDeleteErrorMessage({ kind: "conflict", code: "SUBMISSION_CONFLICT" }),
    draftSubmissionDeleteErrorMessage({ kind: "conflict", code: "SUBMISSION_PROCESSING" }),
    draftSubmissionDeleteErrorMessage({ kind: "rejected", code: "SUBMISSION_DELETE_DENIED" }),
    draftSubmissionDeleteErrorMessage({ kind: "rejected", code: "SUBMISSION_NOT_FOUND" }),
    draftSubmissionDeleteErrorMessage({ kind: "rejected", code: "UNAUTHENTICATED" }),
    draftSubmissionDeleteErrorMessage({ kind: "rejected", code: "XYZ" }),
  ];
  for (const message of messages) {
    assert.match(message, /giữ/);
    assert.equal(/đã xóa khỏi (kho|storage|bucket)/i.test(message), false);
  }
  assert.match(messages[0], /Mất kết nối/);
  assert.match(messages[3], /thay đổi ở nơi khác/);
  assert.match(messages[4], /đang được xử lý/);
  assert.match(messages[5], /không có quyền/);
});
