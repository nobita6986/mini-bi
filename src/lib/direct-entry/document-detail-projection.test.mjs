import assert from "node:assert/strict";
import test from "node:test";

import { fetchEntryDetail, projectEntryDetail } from "./document-detail-projection.ts";

const ENTRY = "c1000000-0000-4000-8000-00000000000a";
const DOC = "d1000000-0000-4000-8000-0000000000f1";

function document(overrides = {}) {
  return {
    document_id: DOC,
    document_type: "CCCD_FRONT",
    version: 1,
    size_bytes: 2048,
    mime_type: "image/jpeg",
    upload_status: "READY",
    scan_status: "CLEAN",
    validation_status: "VALIDATED",
    ...overrides,
  };
}

function body(overrides = {}) {
  return { ok: true, entry: { entry_id: ENTRY, version: 4, documents: [document()], ...overrides } };
}

test("projection hop le: chi giu cac truong trong allow-list", () => {
  const result = projectEntryDetail(body(), ENTRY);
  assert.equal(result.entryVersion, 4);
  assert.deepEqual(result.documents, [document()]);
  assert.deepEqual(Object.keys(result.documents[0]).sort(),
    ["document_id", "document_type", "mime_type", "scan_status", "size_bytes", "upload_status",
      "validation_status", "version"]);
});

test("fail-closed: entry_id lech, version sai, documents sai kieu", () => {
  assert.equal(projectEntryDetail(body(), "d1000000-0000-4000-8000-00000000000b"), null);
  assert.equal(projectEntryDetail({ ok: false, entry: {} }, ENTRY), null);
  assert.equal(projectEntryDetail({ ok: true }, ENTRY), null);
  assert.equal(projectEntryDetail(body({ version: 0 }), ENTRY), null);
  assert.equal(projectEntryDetail(body({ version: 1.5 }), ENTRY), null);
  assert.equal(projectEntryDetail(body({ documents: "x" }), ENTRY), null);
  assert.equal(projectEntryDetail(body({ documents: [document({ document_type: "PASSPORT" })] }),
    ENTRY), null);
  assert.equal(projectEntryDetail(body({ documents: [document({ size_bytes: "2048" })] }), ENTRY), null);
  assert.equal(projectEntryDetail(body({ documents: [document({ scan_status: undefined })] }),
    ENTRY), null);
});

test("fail-closed: field la (checksum/storage_key/bucket/signed URL) lam hong ca response", () => {
  for (const extra of [{ checksum_sha256: "a".repeat(64) }, { storage_key: "staging/x.jpg" },
    { bucket: "direct-entry" }, { signed_url: "https://signed.invalid/x" },
    { filename: "cccd.jpg" }, { created_by_user_id: ENTRY }]) {
    assert.equal(projectEntryDetail(body({ documents: [document(extra)] }), ENTRY), null,
      JSON.stringify(extra));
  }
});

test("fetchEntryDetail: dung MOT GET, khong cache, same-origin; moi loi => null", async () => {
  const calls = [];
  const okFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => body() };
  };
  const projection = await fetchEntryDetail(ENTRY, okFetch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/direct-entry/entries/" + ENTRY);
  assert.deepEqual(calls[0].init, { cache: "no-store", credentials: "same-origin" });
  assert.equal(projection.documents.length, 1);

  assert.equal(await fetchEntryDetail(ENTRY, async () => ({ ok: false, status: 404,
    json: async () => ({ ok: false }) })), null);
  assert.equal(await fetchEntryDetail(ENTRY, async () => ({ ok: true, status: 200,
    json: async () => { throw new Error("bad json"); } })), null);
  assert.equal(await fetchEntryDetail(ENTRY, async () => { throw new Error("offline"); }), null);
  assert.equal(await fetchEntryDetail(ENTRY, async () => ({ ok: true, status: 200,
    json: async () => ({ ok: true, entry: { entry_id: ENTRY, version: 1,
      documents: [document({ checksum_sha256: "x" })] } }) })), null);
});
