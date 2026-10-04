import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createCccdTransport,
  projectFinalizeResponse,
  projectReserveResponse,
} from "./cccd-transport.ts";

const ENTRY = "c1000000-0000-4000-8000-00000000000a";
const DOC = "d1000000-0000-4000-8000-0000000000f1";

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("reserve response: 2xx hop le, 409 conflict, 5xx retryable, 2xx malformed fail-closed", () => {
  const reserved = projectReserveResponse(201, {
    ok: true, document_id: DOC, entry_version: 5,
    upload: { method: "PUT", url: "https://signed.invalid/x", headers: { "content-type": "image/jpeg" } },
  });
  assert.equal(reserved.kind, "reserved");
  assert.equal(reserved.documentId, DOC);
  assert.equal(reserved.entryVersion, 5);
  assert.deepEqual(Object.keys(reserved.upload).sort(), ["headers", "url"]);

  assert.equal(projectReserveResponse(201, {
    ok: true, document_id: DOC, entry_version: 5 }).upload, null);
  assert.equal(projectReserveResponse(409, { ok: false, code: "DOCUMENT_VERSION_CONFLICT" }).kind,
    "conflict");
  assert.equal(projectReserveResponse(503, { ok: false, code: "DOCUMENT_STORAGE_UNAVAILABLE" }).kind,
    "retryable");
  assert.equal(projectReserveResponse(400, { ok: false, code: "DOCUMENT_SIZE_INVALID" }).kind,
    "rejected");
  for (const body of [null, {}, { ok: true }, { ok: true, document_id: DOC },
    { ok: true, document_id: DOC, entry_version: 5,
      upload: { method: "POST", url: "x", headers: {} } }]) {
    const outcome = projectReserveResponse(200, body);
    assert.equal(outcome.kind, "retryable", JSON.stringify(body));
    assert.equal(outcome.code, "DOCUMENT_RESPONSE_INVALID");
  }
});

test("finalize response: chi doc trang thai do may chu tra ve, khong tu suy dien", () => {
  const finalized = projectFinalizeResponse(200, {
    ok: true, document_id: DOC, version: 1, entry_version: 6, upload_status: "READY",
    scan_status: "NOT_REQUIRED", validation_status: "VALIDATED", reused: false,
  }, "CCCD_FRONT");
  assert.equal(finalized.kind, "finalized");
  assert.equal(finalized.entryVersion, 6);
  assert.deepEqual(finalized.document,
    { document_type: "CCCD_FRONT", upload_status: "READY", validation_status: "VALIDATED",
      scan_status: "NOT_REQUIRED" });

  assert.equal(projectFinalizeResponse(409, { ok: false, code: "DOCUMENT_VERSION_CONFLICT" },
    "CCCD_BACK").kind, "conflict");
  assert.equal(projectFinalizeResponse(503, { ok: false }, "CCCD_BACK").kind, "retryable");
  assert.equal(projectFinalizeResponse(422, { ok: false, code: "DOCUMENT_SIZE_INVALID" },
    "CCCD_BACK").kind, "rejected");
  assert.equal(projectFinalizeResponse(200, { ok: true, entry_version: 6 }, "CCCD_BACK").kind,
    "retryable");
});

test("request body/header dung contract va khong chua PII hay metadata luu tru", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init?.method === "PUT") return jsonResponse(200, {});
    if (url.endsWith("/finalize")) {
      return jsonResponse(200, { ok: true, document_id: DOC, version: 1, entry_version: 6,
        upload_status: "READY", scan_status: "CLEAN", validation_status: "VALIDATED" });
    }
    return jsonResponse(201, { ok: true, document_id: DOC, entry_version: 5,
      upload: { method: "PUT", url: "https://signed.invalid/put", headers: { "x-amz-acl": "private" } } });
  };
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
  const transport = createCccdTransport({
    entryId: ENTRY,
    reason: null,
    blobs: { CCCD_FRONT: blob },
    fetchImpl,
    reloadDetail: async () => null,
  });

  const reserved = await transport.reserve({ documentType: "CCCD_FRONT", entryVersion: 4,
    sizeBytes: 3, mimeType: "image/jpeg", idempotencyKey: "opaque-key-1" });
  assert.equal(reserved.kind, "reserved");
  const reserveCall = calls[0];
  assert.equal(reserveCall.url, "/api/direct-entry/entries/" + ENTRY + "/documents");
  assert.equal(reserveCall.init.method, "POST");
  assert.deepEqual(reserveCall.init.headers,
    { "Idempotency-Key": "opaque-key-1", "Content-Type": "application/json" });
  const reserveBody = JSON.parse(reserveCall.init.body);
  assert.deepEqual(Object.keys(reserveBody).sort(),
    ["document_type", "expected_entry_version", "mime_type", "size_bytes"]);
  assert.equal(reserveBody.expected_entry_version, 4);

  await transport.put({ documentType: "CCCD_FRONT", url: "https://signed.invalid/put",
    headers: { "x-amz-acl": "private" } });
  assert.equal(calls[1].url, "https://signed.invalid/put");
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(calls[1].init.body, blob, "PUT body la bytes, khong phai metadata");

  await transport.finalize({ documentType: "CCCD_FRONT", documentId: DOC, entryVersion: 5,
    idempotencyKey: "opaque-key-1:finalize" });
  const finalizeCall = calls[2];
  assert.equal(finalizeCall.url, "/api/direct-entry/entries/" + ENTRY + "/documents/" + DOC + "/finalize");
  assert.deepEqual(Object.keys(JSON.parse(finalizeCall.init.body)), ["expected_entry_version"]);

  // Khong request nao chua filename/ho ten/ma NLĐ/so CCCD/checksum/storage key/bucket.
  const serialized = JSON.stringify(calls.map((call) => ({ url: call.url, body: call.init.body })));
  for (const forbidden of ["cccd.jpg", "Nguyen", "hrp-2026", "checksum", "storage_key", "bucket",
    "fileName", "file_name", "national_id"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("reason boundary: chi gui khi duoc yeu cau, khong tu them truong authority", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return jsonResponse(201, { ok: true, document_id: DOC, entry_version: 2, upload: null });
  };
  await createCccdTransport({ entryId: ENTRY, reason: null, blobs: {}, fetchImpl,
    reloadDetail: async () => null })
    .reserve({ documentType: "CCCD_FRONT", entryVersion: 1, sizeBytes: 1,
      mimeType: "image/png", idempotencyKey: "k1" });
  await createCccdTransport({ entryId: ENTRY, reason: "Thay ảnh bị mờ", blobs: {}, fetchImpl,
    reloadDetail: async () => null })
    .reserve({ documentType: "CCCD_FRONT", entryVersion: 1, sizeBytes: 1,
      mimeType: "image/png", idempotencyKey: "k2" });
  assert.equal("reason" in bodies[0], false);
  assert.equal(bodies[1].reason, "Thay ảnh bị mờ");
  for (const body of bodies) {
    for (const forbidden of ["actor", "auth_subject", "app_user_id", "capability", "scope_kind",
      "provider_type", "team_id"]) {
      assert.equal(JSON.stringify(body).includes(forbidden), false, forbidden);
    }
  }
});

test("transport khong render hay log: khong console, khong localStorage, signed URL chi trong memory", () => {
  const source = readFileSync(new URL("./cccd-transport.ts", import.meta.url), "utf8");
  assert.equal(source.includes("console."), false);
  assert.equal(source.includes("localStorage"), false);
  assert.equal(source.includes("sessionStorage"), false);
  assert.equal(source.includes("dangerouslySetInnerHTML"), false);
  assert.doesNotMatch(source, /document\.write|innerHTML\s*=/);
});
