import assert from "node:assert/strict";
import test from "node:test";

import { createCccdTransport } from "./cccd-transport.ts";
import { postFullProfileBatch } from "./full-profile-batch.ts";
import { postPasteBatch } from "./paste-batch-save.ts";

/**
 * P1.6-I04C3-I06-R1 - Regression test receiver-sensitive dung CHUNG cho ca ba write transport.
 *
 * Trong browser that, fetch la mot ham cua Window. Khi transport goi
 * input.fetchImpl(url, init) thi "this" la object input (khong phai Window) va
 * Chrome nem TypeError "Illegal invocation" TRUOC khi request duoc gui di.
 * Cac unit test cu inject mot ham async thuong, ma mot ham nhu vay khong quan tam
 * "this", nen loi nay khong bao gio lo ra.
 *
 * Helper duoi day tai tao dung rang buoc do: no CHI hoat dong khi duoc goi nhu mot
 * ham tu do (bare call / bound call). Neu bi goi theo dang obj.fetchImpl(...),
 * "this" la object thuong va no nem dung loi cua browser.
 */
function rawBrowserLikeFetch(handler) {
  const calls = [];
  function rawFetch(url, init) {
    if (this !== undefined && this !== null) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }
  return { rawFetch, calls };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const SUBMISSION = "44444444-4444-4444-8444-444444444444";
const ENTRY = "a1000000-0000-4000-8000-000000000001";
const DOC = "d1000000-0000-4000-8000-0000000000f1";
const KEY = "55555555-5555-4555-8555-555555555555";
const omitted = () => ({ state: "omitted" });

function fullProfileRow() {
  return {
    project_id: "11111111-1111-4111-8111-111111111111",
    first_work_date: "2026-10-15",
    employee_code: "hrp-2026-000001",
    recruiter_id: "22222222-2222-4222-8222-222222222222",
    labor_type: "TEMPORARY",
    display_name: "Nguyen Van Gia A",
    worker: {
      gender: omitted(),
      date_of_birth: omitted(),
      national_id: omitted(),
      national_id_issued_at: omitted(),
      national_id_issued_place: omitted(),
      address: omitted(),
      phone: omitted(),
    },
    general_note: omitted(),
    payment: null,
    employment: null,
  };
}

function pasteRow() {
  return {
    project_id: "11111111-1111-4111-8111-111111111111",
    first_work_date: "2026-10-15",
    employee_code: "hrp-2026-000002",
    worker: {
      display_name: "Nguyen Van Gia B",
      date_of_birth: omitted(),
      national_id: omitted(),
      address: omitted(),
      phone: omitted(),
    },
    recruiter_id: "22222222-2222-4222-8222-222222222222",
    labor_type: "TEMPORARY",
  };
}

// Control: chung minh probe nay THAT SU receiver-sensitive. Neu khong co test nay,
// ba test duoi co the xanh gia neu helper bi vo hieu hoa.
test("control: raw browser-like fetch nem Illegal invocation khi bi goi nhu object method", () => {
  const { rawFetch } = rawBrowserLikeFetch(() => jsonResponse(200, {}));
  const holder = { fetchImpl: rawFetch };
  assert.throws(() => holder.fetchImpl("/batches", { method: "POST" }), /Illegal invocation/);
});

test("full-profile batch save: raw browser-like fetch khong bi goi nhu object method", async () => {
  const { rawFetch, calls } = rawBrowserLikeFetch(() => jsonResponse(201, {
    ok: true, submission_id: SUBMISSION, state: "DRAFT", version: 1, entry_ids: [ENTRY],
  }));
  const result = await postFullProfileBatch({
    rows: [fullProfileRow()], idempotencyKey: KEY, fetchImpl: rawFetch,
  });
  assert.equal(calls.length, 1, "dung mot request");
  assert.equal(result.kind, "saved");
  assert.deepEqual(result.entryIds, [ENTRY]);
});

test("legacy paste batch save: raw browser-like fetch khong bi goi nhu object method", async () => {
  const { rawFetch, calls } = rawBrowserLikeFetch(() => jsonResponse(201, {
    ok: true, submission_id: SUBMISSION, submission_version: 7, entry_ids: [ENTRY],
    status: "DRAFT",
  }));
  const result = await postPasteBatch({
    rows: [pasteRow()], idempotencyKey: "key-1", fetchImpl: rawFetch,
  });
  assert.equal(calls.length, 1, "dung mot request");
  assert.equal(result.kind, "saved");
});

test("CCCD transport reserve/put/finalize: raw browser-like fetch khong bi goi nhu object method", async () => {
  const { rawFetch, calls } = rawBrowserLikeFetch((url, init) => {
    if (init?.method === "PUT") return jsonResponse(200, {});
    if (String(url).endsWith("/finalize")) {
      return jsonResponse(200, {
        ok: true, document_id: DOC, version: 1, entry_version: 6,
        upload_status: "READY", scan_status: "CLEAN", validation_status: "VALIDATED",
      });
    }
    return jsonResponse(201, {
      ok: true, document_id: DOC, entry_version: 5,
      upload: { method: "PUT", url: "https://signed.invalid/put", headers: { "x-amz-acl": "private" } },
    });
  });
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
  const transport = createCccdTransport({
    entryId: ENTRY,
    reason: null,
    blobs: { CCCD_FRONT: blob },
    fetchImpl: rawFetch,
    reloadDetail: async () => null,
  });

  const reserved = await transport.reserve({
    documentType: "CCCD_FRONT", entryVersion: 4, sizeBytes: 3, mimeType: "image/jpeg",
    idempotencyKey: "opaque-key-1",
  });
  assert.equal(reserved.kind, "reserved");

  const put = await transport.put({
    documentType: "CCCD_FRONT", url: "https://signed.invalid/put", headers: { "x-amz-acl": "private" },
  });
  assert.equal(put.ok, true);

  const finalized = await transport.finalize({
    documentType: "CCCD_FRONT", documentId: DOC, entryVersion: 5,
    idempotencyKey: "opaque-key-1:finalize",
  });
  assert.equal(finalized.kind, "finalized");
  assert.equal(calls.length, 3, "reserve + put + finalize");
});
