import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PASTE_BATCH_ENDPOINT,
  assignPasteEntryIds,
  beginPasteGroup,
  classifyPasteBatchResponse,
  emptyPasteBatchKeyState,
  pasteBatchErrorMessage,
  pasteBatchSignature,
  postPasteBatch,
  settlePasteGroup,
} from "./paste-batch-save.ts";

const SUBMISSION = "33333333-3333-4333-8333-333333333333";
const ENTRY = (n) => "c1000000-0000-4000-8000-0000000000" + String(n).padStart(2, "0");

function payloadRow(code, date = "2026-10-15") {
  return {
    project_id: "11111111-1111-4111-8111-111111111111",
    first_work_date: date,
    employee_code: code,
    worker: {
      display_name: "Nguyen Van A",
      date_of_birth: { state: "omitted" },
      national_id: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
    recruiter_id: "22222222-2222-4222-8222-222222222222",
    labor_type: "TEMPORARY",
  };
}

const THREE = [payloadRow("hrp-2026-000001"), payloadRow("hrp-2026-000002"),
  payloadRow("hrp-2026-000003")];

function recorded(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

function savedBody(ids) {
  return { ok: true, submission_id: SUBMISSION, submission_version: 7, entry_ids: ids,
    status: "DRAFT" };
}

test("mot nhom N dong di bang DUNG MOT POST, dung endpoint/header/body contract", async () => {
  const { calls, fetchImpl } = recorded(201, savedBody([ENTRY(1), ENTRY(2), ENTRY(3)]));
  const result = await postPasteBatch({ rows: THREE, idempotencyKey: "key-1", fetchImpl });
  assert.equal(calls.length, 1, "1 request cho 3 dong");
  assert.equal(calls[0].url, PASTE_BATCH_ENDPOINT);
  assert.equal(calls[0].url, "/api/direct-entry/batches");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.deepEqual(calls[0].init.headers, {
    "Content-Type": "application/json",
    "Idempotency-Key": "key-1",
  });
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body), ["rows"]);
  assert.equal(body.rows.length, 3);
  assert.deepEqual(body.rows, THREE);
  assert.deepEqual(Object.keys(body.rows[0]).sort(),
    ["employee_code", "first_work_date", "labor_type", "project_id", "recruiter_id", "worker"]);
  // Khong gui actor/auth subject/role/capability/scope/idempotency trong body.
  const serialized = JSON.stringify(body);
  for (const forbidden of ["actor", "auth_subject", "app_user_id", "role", "capability",
    "scope", "idempotency_key", "provider_type", "team_id", "storage_key", "checksum"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(result.kind, "saved");
  assert.deepEqual(result.entryIds, [ENTRY(1), ENTRY(2), ENTRY(3)]);
  assert.equal(result.submissionId, SUBMISSION);
  assert.equal(result.submissionVersion, 7);
});

test("entry_ids duoc map ve dong theo DUNG thu tu input", () => {
  const reversed = assignPasteEntryIds({
    kind: "saved", submissionId: SUBMISSION, submissionVersion: 7,
    entryIds: [ENTRY(3), ENTRY(2), ENTRY(1)],
  }, 3);
  assert.deepEqual(reversed.map((item) => item.index), [0, 1, 2]);
  assert.deepEqual(reversed.map((item) => item.entryId), [ENTRY(3), ENTRY(2), ENTRY(1)]);
  assert.ok(reversed.every((item) =>
    item.submissionId === SUBMISSION && item.submissionVersion === 7));
  assert.equal(assignPasteEntryIds({
    kind: "saved", submissionId: SUBMISSION, submissionVersion: 7, entryIds: [ENTRY(1)],
  }, 3), null, "so luong lech => null, khong tu doan");
});

test("retry dung lai idempotency key khi payload khong doi; doi du lieu thi key moi", () => {
  let counter = 0;
  const generate = () => "k" + (counter += 1);
  const first = beginPasteGroup({ keyState: emptyPasteBatchKeyState(), rows: THREE, generate });
  assert.equal(first.reused, false);
  const retry = beginPasteGroup({ keyState: first.keyState, rows: THREE, generate });
  assert.equal(retry.reused, true);
  assert.equal(retry.pending.key, first.pending.key);

  const edited = THREE.map((row, index) => index === 1
    ? { ...row, employee_code: "hrp-2026-000009" }
    : row);
  const afterEdit = beginPasteGroup({ keyState: first.keyState, rows: edited, generate });
  assert.equal(afterEdit.reused, false);
  assert.notEqual(afterEdit.pending.key, first.pending.key);
  assert.notEqual(pasteBatchSignature(edited), pasteBatchSignature(THREE));
});

test("409 khong tu retry va yeu cau reconcile; 5xx/2xx malformed giu key de thu lai", async () => {
  const conflict = classifyPasteBatchResponse(409, { ok: false, code: "IDEMPOTENCY_CONFLICT" }, 3);
  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");

  const server = classifyPasteBatchResponse(503, { ok: false, code: "BATCH_UNAVAILABLE" }, 3);
  assert.equal(server.kind, "retry");
  assert.equal(server.code, "BATCH_UNAVAILABLE");

  const malformed = classifyPasteBatchResponse(201, { ok: true, submission_id: SUBMISSION }, 3);
  assert.equal(malformed.kind, "retry");
  assert.equal(malformed.code, "PASTE_BATCH_RESPONSE_INVALID");

  const wrongCount = classifyPasteBatchResponse(201, savedBody([ENTRY(1)]), 3);
  assert.equal(wrongCount.kind, "retry");
  const badId = classifyPasteBatchResponse(201, savedBody([ENTRY(1), ENTRY(2), "not-a-uuid"]), 3);
  assert.equal(badId.kind, "retry");
  const duplicated = classifyPasteBatchResponse(201, savedBody([ENTRY(1), ENTRY(1), ENTRY(2)]), 3);
  assert.equal(duplicated.kind, "retry");

  const rejected = classifyPasteBatchResponse(400, { ok: false, code: "BATCH_INVALID" }, 3);
  assert.equal(rejected.kind, "rejected");
});

test("atomic: moi loi deu giu TOAN BO nhom o trang thai chua luu", () => {
  const group = beginPasteGroup({
    keyState: emptyPasteBatchKeyState(),
    rows: THREE,
    generate: () => "key-atomic",
  });
  const cases = [
    { result: { kind: "conflict", code: "IDEMPOTENCY_CONFLICT" }, reloadRequired: true, retryable: false, keepKey: false },
    { result: { kind: "retry", code: "PASTE_BATCH_UNAVAILABLE" }, reloadRequired: false, retryable: true, keepKey: true },
    { result: { kind: "rejected", code: "BATCH_INVALID" }, reloadRequired: false, retryable: false, keepKey: false },
  ];
  for (const item of cases) {
    const settled = settlePasteGroup({
      pending: group.pending,
      result: item.result,
      keyState: group.keyState,
    });
    assert.equal(settled.outcome.status, "unsaved", item.result.kind);
    assert.equal(settled.outcome.code, item.result.code);
    assert.equal(settled.outcome.reloadRequired, item.reloadRequired);
    assert.equal(settled.outcome.retryable, item.retryable);
    if (item.keepKey) {
      assert.deepEqual(settled.keyState, group.keyState, "5xx giu key");
    } else {
      assert.deepEqual(settled.keyState, emptyPasteBatchKeyState(), "key da dung xong");
    }
  }
});

test("thanh cong moi xoa key va mo nhom; khong optimistic-save truoc response", () => {
  const group = beginPasteGroup({
    keyState: emptyPasteBatchKeyState(), rows: THREE, generate: () => "key-ok",
  });
  const settled = settlePasteGroup({
    pending: group.pending,
    result: {
      kind: "saved", submissionId: SUBMISSION, submissionVersion: 4,
      entryIds: [ENTRY(1), ENTRY(2), ENTRY(3)],
    },
    keyState: group.keyState,
  });
  assert.equal(settled.outcome.status, "saved");
  assert.equal(settled.outcome.submissionVersion, 4);
  assert.deepEqual(settled.keyState, emptyPasteBatchKeyState());
});

test("network/loi size: giu key, khong gui request nao khi so dong ngoai 1..100", async () => {
  const { calls, fetchImpl } = recorded(201, savedBody([ENTRY(1)]));
  const thrown = await postPasteBatch({
    rows: THREE,
    idempotencyKey: "key-net",
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.equal(thrown.kind, "retry");
  assert.equal(thrown.code, "PASTE_BATCH_NETWORK");

  const none = await postPasteBatch({ rows: [], idempotencyKey: "key-empty", fetchImpl });
  assert.equal(none.kind, "rejected");
  assert.equal(none.code, "PASTE_BATCH_SIZE_INVALID");

  const tooMany = await postPasteBatch({
    rows: Array.from({ length: 101 }, () => payloadRow("hrp-2026-000001")),
    idempotencyKey: "key-many",
    fetchImpl,
  });
  assert.equal(tooMany.code, "PASTE_BATCH_SIZE_INVALID");
  assert.equal(calls.length, 0, "khong co request nao duoc gui");

  const blankKey = await postPasteBatch({ rows: THREE, idempotencyKey: "  ", fetchImpl });
  assert.equal(blankKey.code, "PASTE_BATCH_KEY_INVALID");
  assert.equal(calls.length, 0);
});

test("thong bao loi sanitized: khong lo ma noi bo tho hay du lieu may chu", () => {
  for (const code of ["PASTE_BATCH_NETWORK", "PASTE_BATCH_UNAVAILABLE",
    "PASTE_BATCH_RESPONSE_INVALID", "PASTE_BATCH_CONFLICT", "PASTE_BATCH_REJECTED",
    "PASTE_BATCH_SIZE_INVALID", "PASTE_BATCH_KEY_INVALID"]) {
    const message = pasteBatchErrorMessage(code);
    assert.equal(message.includes(code), false, code);
    assert.ok(message.length > 0);
  }
  assert.match(pasteBatchErrorMessage("PASTE_BATCH_UNKNOWN_XYZ"), /Không lưu được nhóm dòng/);
  const source = readFileSync(new URL("./paste-batch-save.ts", import.meta.url), "utf8");
  assert.equal(source.includes("localStorage"), false);
  assert.equal(source.includes("console."), false);
});
