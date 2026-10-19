import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteDraftRow,
  draftRowDeleteErrorMessage,
} from "./draft-row-delete-client.ts";
import {
  EMPTY_INTENT_KEY,
  resolveIntentKey,
} from "./submission-lifecycle.ts";

const entryId = "11111111-1111-4111-8111-111111111111";
const key = "22222222-2222-4222-8222-222222222222";

test("delete gửi đúng method/header/body OCC và chỉ nhận projection 200 strict", async () => {
  const calls = [];
  const result = await deleteDraftRow({
    entryId,
    expectedVersion: 7,
    idempotencyKey: key,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        ok: true,
        entry_id: entryId,
        deleted: true,
        entry_version: 8,
      });
    },
  });
  assert.deepEqual(result, { kind: "deleted", entryId, entryVersion: 8 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/direct-entry/entries/${entryId}`);
  assert.equal(calls[0].init.method, "DELETE");
  assert.deepEqual(calls[0].init.headers, {
    "Content-Type": "application/json",
    "Idempotency-Key": key,
  });
  assert.equal(calls[0].init.body, '{"expected_version":7}');
});

test("conflict và final-row là lỗi terminal rõ ràng", async () => {
  for (const code of ["DRAFT_CONFLICT", "DRAFT_FINAL_ROW"]) {
    const result = await deleteDraftRow({
      entryId,
      expectedVersion: 7,
      idempotencyKey: key,
      fetchImpl: async () => Response.json({ ok: false, code }, { status: 409 }),
    });
    assert.deepEqual(result, { kind: "conflict", code });
  }
  assert.equal(draftRowDeleteErrorMessage({ kind: "conflict", code: "DRAFT_FINAL_ROW" }),
    "Không thể xóa hàng cuối của bản nháp.");
});

test("network/5xx/malformed hoặc non-200 2xx là retry, không giả thành công", async () => {
  const network = await deleteDraftRow({
    entryId, expectedVersion: 7, idempotencyKey: key,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(network, { kind: "retry", code: "DRAFT_DELETE_NETWORK" });
  const unavailable = await deleteDraftRow({
    entryId, expectedVersion: 7, idempotencyKey: key,
    fetchImpl: async () => Response.json({ ok: false, code: "DRAFT_DELETE_UNAVAILABLE" },
      { status: 500 }),
  });
  assert.deepEqual(unavailable, { kind: "retry", code: "DRAFT_DELETE_UNAVAILABLE" });
  const malformed = await deleteDraftRow({
    entryId, expectedVersion: 7, idempotencyKey: key,
    fetchImpl: async () => Response.json({ ok: true, entry_id: entryId, deleted: true,
      entry_version: 8, extra: true }),
  });
  assert.deepEqual(malformed, { kind: "retry", code: "DRAFT_DELETE_RESPONSE_INVALID" });
  const noContent = await deleteDraftRow({
    entryId, expectedVersion: 7, idempotencyKey: key,
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  assert.deepEqual(noContent, { kind: "retry", code: "DRAFT_DELETE_RESPONSE_INVALID" });
});

test("retry cùng intent giữ nguyên Idempotency-Key", async () => {
  let generated = 0;
  const first = resolveIntentKey(EMPTY_INTENT_KEY, `delete:${entryId}:7`, () => {
    generated += 1;
    return key;
  });
  const retry = await deleteDraftRow({
    entryId, expectedVersion: 7, idempotencyKey: first.key,
    fetchImpl: async () => { throw new Error("lost response"); },
  });
  assert.equal(retry.kind, "retry");
  const second = resolveIntentKey(first.state, `delete:${entryId}:7`, () => {
    generated += 1;
    return "33333333-3333-4333-8333-333333333333";
  });
  assert.equal(second.key, key);
  assert.equal(second.reused, true);
  assert.equal(generated, 1);
});

test("403/404 giữ phân loại rejected để UI giữ row", async () => {
  for (const [status, code] of [[403, "ACTOR_DENIED"], [404, "ENTRY_NOT_FOUND"]]) {
    const result = await deleteDraftRow({
      entryId, expectedVersion: 7, idempotencyKey: key,
      fetchImpl: async () => Response.json({ ok: false, code }, { status }),
    });
    assert.deepEqual(result, { kind: "rejected", code });
  }
});

test("retry phân biệt lỗi mạng, server và phản hồi để người dùng biết bước tiếp", () => {
  assert.match(draftRowDeleteErrorMessage({ kind: "retry", code: "DRAFT_DELETE_NETWORK" }),
    /Mất kết nối/);
  assert.match(draftRowDeleteErrorMessage({ kind: "retry", code: "DRAFT_DELETE_UNAVAILABLE" }),
    /Máy chủ chưa xác nhận/);
  assert.match(draftRowDeleteErrorMessage({ kind: "retry", code: "DRAFT_DELETE_RESPONSE_INVALID" }),
    /Phản hồi máy chủ/);
});
