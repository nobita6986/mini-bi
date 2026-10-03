import assert from "node:assert/strict";
import test from "node:test";

import { reserveDirectEntryDocument } from "./document-api.ts";
import { downloadDirectEntryDocument, finalizeDirectEntryDocument } from "./document-finalize-api.ts";

const entryId = "a2000000-0000-4000-8000-000000000001";
const documentId = "b2000000-0000-4000-8000-000000000001";
const storageKey = `p1.6/c2000000-0000-4000-8000-000000000001/CCCD_FRONT/1/${documentId}`;
const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82);
const fakePng = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
const queued = { upload_status: "QUEUED", scan_status: "PENDING", validation_status: "PENDING" };
const ready = { upload_status: "READY", scan_status: "NOT_REQUIRED", validation_status: "VALIDATED" };

function makeRequest(body, { method = "POST", headers = {}, idem = true } = {}) {
  return new Request(`https://example.test/api/direct-entry/entries/${entryId}/documents`, {
    method,
    headers: {
      origin: "https://example.test", host: "example.test", "content-type": "application/json",
      ...(idem ? { "idempotency-key": "synthetic-key" } : {}), ...headers,
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

function deps({ capabilities = ["document_upload", "document_view"], available = true, bytes = png, head, repo = {} } = {}) {
  const log = { storage: [], db: [], sessions: 0 };
  const storage = {
    available: () => available,
    async createUploadUrl(input) { log.storage.push(["createUploadUrl", input]); return { url: "https://signed.example.test/put", expires_at: "2026-10-01T00:05:00.000Z", headers: { "Content-Type": input.mime_type } }; },
    async headStaged() { log.storage.push(["head"]); return head ?? { kind: "found", size_bytes: bytes.length, content_type: "image/png" }; },
    async readStaged() { log.storage.push(["read"]); return bytes; },
    async promote() { log.storage.push(["promote"]); },
    async deleteStaged() { log.storage.push(["delete"]); },
    async createDownloadUrl(input) { log.storage.push(["download", input]); return { url: "https://signed.example.test/get", expires_at: "x", headers: {} }; },
  };
  const repository = {
    async reserveDocumentUpload(input) { log.db.push(["reserve", input]); return { ok: true, data: { document_id: documentId, version: 1, entry_version: 2, reused: false, storage_key: storageKey, ...queued } }; },
    async getDocumentContext(input) { log.db.push(["context", input]); return { ok: true, data: { document_id: documentId, document_type: "CCCD_FRONT", version: 1, entry_version: 2, size_bytes: bytes.length, mime_type: "image/png", storage_key: storageKey, ...queued } }; },
    async finalizeDocument(input) { log.db.push(["finalize", input]); return { ok: true, data: { document_id: documentId, version: 1, entry_version: 3, reused: false, ...(input.outcome === "validated" ? ready : { upload_status: "FAILED", scan_status: "NOT_REQUIRED", validation_status: "REJECTED" }) } }; },
    ...repo,
  };
  return {
    log,
    resolveSession: async () => { log.sessions += 1; return { actor: { ok: true, actor: { auth_subject: "91000000-0000-4000-8000-000000000001", app_user_id: "92000000-0000-4000-8000-000000000001", capabilities } }, response_headers: {} }; },
    repository,
    storage,
  };
}

const reserveBody = { document_type: "CCCD_FRONT", expected_entry_version: 1, size_bytes: png.length, mime_type: "image/png" };

test("reservation signs a PUT only after the DB reservation and returns no bucket or key", async () => {
  const d = deps();
  const res = await reserveDirectEntryDocument(makeRequest(reserveBody), entryId, "true", d);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(d.log.db.map((c) => c[0]), ["reserve"]);
  assert.equal(d.log.storage[0][0], "createUploadUrl");
  assert.equal(body.upload.method, "PUT");
  assert.equal(body.validation_status, "PENDING");
  assert.doesNotMatch(JSON.stringify(body), /p1\.6\/|hrp-bi|checksum|bucket|storage_key/);
  assert.equal(d.log.db[0][1].size_bytes, png.length);
  assert.equal("checksum_sha256" in d.log.db[0][1], false);
});

test("missing storage config fails closed before any DB or storage call", async () => {
  const d = deps({ available: false });
  const res = await reserveDirectEntryDocument(makeRequest(reserveBody), entryId, "true", d);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "DOCUMENT_STORAGE_UNAVAILABLE");
  assert.deepEqual(d.log.db, []);
  assert.deepEqual(d.log.storage, []);
});

test("client cannot choose bucket, key, status or storage profile", async () => {
  for (const extra of [{ bucket: "x" }, { storage_key: "k" }, { object_key: "k" }, { scan_status: "CLEAN" }, { upload_status: "READY" }, { status: "READY" }, { storage_profile: "p" }, { url: "u" }]) {
    const d = deps();
    const res = await reserveDirectEntryDocument(makeRequest({ ...reserveBody, ...extra }), entryId, "true", d);
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.deepEqual(d.log.db, []);
    assert.equal(d.log.sessions, 0);
  }
});

test("claimed MIME, size, type, idempotency and capability are checked before mutation", async () => {
  const cases = [
    [{ ...reserveBody, mime_type: "image/svg+xml" }, 400],
    [{ ...reserveBody, size_bytes: 10 * 1024 * 1024 + 1 }, 400],
    [{ ...reserveBody, document_type: "NOPE" }, 400],
  ];
  for (const [body, status] of cases) {
    const d = deps();
    assert.equal((await reserveDirectEntryDocument(makeRequest(body), entryId, "true", d)).status, status);
    assert.deepEqual(d.log.db, []);
  }
  const noKey = deps();
  assert.equal((await reserveDirectEntryDocument(makeRequest(reserveBody, { idem: false }), entryId, "true", noKey)).status, 400);
  const noCap = deps({ capabilities: ["document_view"] });
  assert.equal((await reserveDirectEntryDocument(makeRequest(reserveBody), entryId, "true", noCap)).status, 403);
  assert.deepEqual(noCap.log.db, []);
  const off = deps();
  assert.equal((await reserveDirectEntryDocument(makeRequest(reserveBody), entryId, "false", off)).status, 404);
});

test("reservation replay and conflicts map without leaking and do not re-sign finished uploads", async () => {
  const conflict = deps({ repo: { async reserveDocumentUpload() { return { ok: false, kind: "conflict" }; } } });
  assert.equal((await reserveDirectEntryDocument(makeRequest(reserveBody), entryId, "true", conflict)).status, 409);
  const done = deps({ repo: { async reserveDocumentUpload() { return { ok: true, data: { document_id: documentId, version: 1, entry_version: 3, reused: true, storage_key: storageKey, ...ready } }; } } });
  const res = await reserveDirectEntryDocument(makeRequest(reserveBody), entryId, "true", done);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).upload, null);
  assert.deepEqual(done.log.storage, []);
});

const finalizeReq = (body = { expected_entry_version: 2 }, opts) => makeRequest(body, opts);

test("valid finalize promotes, finalizes in DB with server SHA-256, then deletes staging", async () => {
  const d = deps();
  const res = await finalizeDirectEntryDocument(finalizeReq(), entryId, documentId, "true", d);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.scan_status, "NOT_REQUIRED");
  assert.equal(body.validation_status, "VALIDATED");
  assert.deepEqual(d.log.storage.map((s) => s[0]), ["head", "read", "promote", "delete"]);
  const fin = d.log.db.find((c) => c[0] === "finalize")[1];
  assert.match(fin.checksum_sha256, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(body), /p1\.6\/|checksum|hrp-bi/);
});

test("finalize rejects missing, oversized and MIME-mismatched objects", async () => {
  const missing = deps({ head: { kind: "missing" } });
  assert.equal((await finalizeDirectEntryDocument(finalizeReq(), entryId, documentId, "true", missing)).status, 409);
  assert.equal(missing.log.db.some((c) => c[0] === "finalize"), false);
  const big = deps({ head: { kind: "found", size_bytes: 10 * 1024 * 1024 + 1, content_type: "image/png" } });
  assert.equal((await finalizeDirectEntryDocument(finalizeReq(), entryId, documentId, "true", big)).status, 422);
  assert.deepEqual(big.log.storage.map((s) => s[0]), ["head", "delete"]);
  const mime = deps({ head: { kind: "found", size_bytes: png.length, content_type: "image/jpeg" } });
  const res = await finalizeDirectEntryDocument(finalizeReq(), entryId, documentId, "true", mime);
  assert.equal(res.status, 422);
  assert.equal(mime.log.db.find((c) => c[0] === "finalize")[1].outcome, "rejected");
  assert.equal(mime.log.storage.some((s) => s[0] === "promote"), false);
});

test("fake content is deleted, recorded as rejected and never becomes READY", async () => {
  const d = deps({ bytes: fakePng });
  const res = await finalizeDirectEntryDocument(finalizeReq(), entryId, documentId, "true", d);
  assert.equal(res.status, 422);
  assert.equal(d.log.storage.some((s) => s[0] === "promote"), false);
  assert.equal(d.log.storage.some((s) => s[0] === "delete"), true);
  assert.equal(d.log.db.find((c) => c[0] === "finalize")[1].outcome, "rejected");
});

test("DB failure after copy does not report success and keeps objects for reconciliation", async () => {
  const d = deps({ repo: { async finalizeDocument() { return { ok: false, kind: "unavailable" }; } } });
  const res = await finalizeDirectEntryDocument(finalizeReq(), entryId, documentId, "true", d);
  assert.equal(res.status, 503);
  const body = JSON.stringify(await res.json());
  assert.doesNotMatch(body, /p1\.6\/|final|ok":true/);
  assert.deepEqual(d.log.storage.map((s) => s[0]), ["head", "read", "promote"]);
});

test("finalize replay on READY document is idempotent with no storage or DB mutation", async () => {
  const d = deps({ repo: { async getDocumentContext() { return { ok: true, data: { document_id: documentId, document_type: "CCCD_FRONT", version: 1, entry_version: 3, size_bytes: png.length, mime_type: "image/png", storage_key: storageKey, ...ready } }; } } });
  const res = await finalizeDirectEntryDocument(finalizeReq(), entryId, documentId, "true", d);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).reused, true);
  assert.deepEqual(d.log.storage, []);
  assert.equal(d.log.db.some((c) => c[0] === "finalize"), false);
});

test("finalize stale OCC conflicts and rejects authority fields and missing capability", async () => {
  const stale = deps({ repo: { async finalizeDocument() { return { ok: false, kind: "conflict" }; } } });
  assert.equal((await finalizeDirectEntryDocument(finalizeReq(), entryId, documentId, "true", stale)).status, 409);
  const extra = deps();
  assert.equal((await finalizeDirectEntryDocument(finalizeReq({ expected_entry_version: 2, storage_key: "k" }), entryId, documentId, "true", extra)).status, 400);
  assert.equal(extra.log.sessions, 0);
  const noCap = deps({ capabilities: ["document_view"] });
  assert.equal((await finalizeDirectEntryDocument(finalizeReq(), entryId, documentId, "true", noCap)).status, 403);
  const off = deps({ available: false });
  assert.equal((await finalizeDirectEntryDocument(finalizeReq(), entryId, documentId, "true", off)).status, 503);
  assert.deepEqual(off.log.db, []);
});

const downloadReq = () => new Request(`https://example.test/x`, { method: "GET" });
const readyContext = { async getDocumentContext() { return { ok: true, data: { document_id: documentId, document_type: "CCCD_FRONT", version: 1, entry_version: 3, size_bytes: 20, mime_type: "image/png", storage_key: storageKey, ...ready } }; } };

test("download requires document_view and an eligible document, then redirects to a short signed GET", async () => {
  const denied = deps({ capabilities: ["document_upload"], repo: readyContext });
  assert.equal((await downloadDirectEntryDocument(downloadReq(), entryId, documentId, "true", denied)).status, 403);
  assert.deepEqual(denied.log.storage, []);
  const scope = deps({ repo: { async getDocumentContext() { return { ok: false, kind: "denied" }; } } });
  assert.equal((await downloadDirectEntryDocument(downloadReq(), entryId, documentId, "true", scope)).status, 404);
  const pending = deps();
  assert.equal((await downloadDirectEntryDocument(downloadReq(), entryId, documentId, "true", pending)).status, 404);
  assert.equal(pending.log.storage.some((s) => s[0] === "download"), false);
  const ok = deps({ repo: readyContext });
  const res = await downloadDirectEntryDocument(downloadReq(), entryId, documentId, "true", ok);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://signed.example.test/get");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(ok.log.storage[0][1].version, 1);
});