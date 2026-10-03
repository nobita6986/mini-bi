import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createDirectEntryWriteRepository } from "./write-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const entryId = "a2000000-0000-4000-8000-000000000001";
const documentId = "b2000000-0000-4000-8000-000000000001";
const storageKey = `p1.6/c2000000-0000-4000-8000-000000000001/CCCD_FRONT/1/${documentId}`;
const reserveInput = {
  ...actor,
  entry_id: entryId,
  expected_entry_version: 1,
  document_type: "CCCD_FRONT",
  idempotency_key: "synthetic-document-key",
  size_bytes: 512,
  mime_type: "image/png",
  reason: null,
};
const lifecycle = { upload_status: "QUEUED", scan_status: "PENDING", validation_status: "PENDING" };

test("repository reserves through the direct-upload RPC with no checksum or key from the client", async () => {
  const calls = [];
  const repository = createDirectEntryWriteRepository(async (name, args) => {
    calls.push({ name, args });
    return {
      data: { document_id: documentId, version: 1, entry_version: 2, reused: false, storage_key: storageKey, ...lifecycle },
      error: null,
    };
  });
  const result = await repository.reserveDocumentUpload(reserveInput);
  assert.equal(result.ok, true);
  assert.equal(result.data.storage_key, storageKey);
  assert.equal(calls[0].name, "direct_entry_reserve_document_direct_upload");
  assert.deepEqual(Object.keys(calls[0].args).sort(), [
    "p_app_user_id", "p_auth_subject", "p_document_type", "p_entry_id", "p_expected_entry_version",
    "p_idempotency_key", "p_mime_type", "p_reason", "p_size_bytes",
  ]);
});

test("malformed projections and raw RPC errors fail closed without leaking", async () => {
  const malformed = createDirectEntryWriteRepository(async () => ({
    data: { document_id: "not-an-id", storage_key: "unsafe-key" }, error: null,
  }));
  assert.deepEqual(await malformed.reserveDocumentUpload(reserveInput), { ok: false, kind: "unavailable" });

  const extra = createDirectEntryWriteRepository(async () => ({
    data: { document_id: documentId, version: 1, entry_version: 2, reused: false, storage_key: storageKey, bucket: "x", ...lifecycle },
    error: null,
  }));
  assert.deepEqual(await extra.reserveDocumentUpload(reserveInput), { ok: false, kind: "unavailable" });

  const errorText = "secret raw database error";
  const failing = createDirectEntryWriteRepository(async () => ({ data: null, error: { code: "XX000", message: errorText } }));
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    assert.deepEqual(await failing.reserveDocumentUpload(reserveInput), { ok: false, kind: "unavailable" });
    assert.equal(logged.join(" ").includes(errorText), false);
  } finally {
    console.error = originalError;
  }
});

test("context and finalize bind to the RPCs and project NOT_REQUIRED without CLEAN claims", async () => {
  const calls = [];
  const repository = createDirectEntryWriteRepository(async (name, args) => {
    calls.push({ name, args });
    if (name === "direct_entry_document_direct_context") {
      return {
        data: {
          document_id: documentId, document_type: "CCCD_FRONT", version: 1, storage_key: storageKey,
          size_bytes: 512, mime_type: "image/png", entry_version: 2, ...lifecycle,
        },
        error: null,
      };
    }
    return {
      data: {
        document_id: documentId, version: 1, entry_version: 3, reused: false,
        upload_status: "READY", scan_status: "NOT_REQUIRED", validation_status: "VALIDATED",
      },
      error: null,
    };
  });
  const context = await repository.getDocumentContext({ ...actor, entry_id: entryId, document_id: documentId, purpose: "finalize" });
  assert.equal(context.ok, true);
  const finalized = await repository.finalizeDocument({
    ...actor, entry_id: entryId, document_id: documentId, expected_entry_version: 2,
    idempotency_key: "k", outcome: "validated", checksum_sha256: "a".repeat(64), size_bytes: 512, mime_type: "image/png",
  });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.data.scan_status, "NOT_REQUIRED");
  assert.deepEqual(Object.keys(finalized.data).sort(), [
    "document_id", "entry_version", "reused", "scan_status", "upload_status", "validation_status", "version",
  ]);
  assert.deepEqual(calls.map((call) => call.name), [
    "direct_entry_document_direct_context", "direct_entry_finalize_document_direct_upload",
  ]);
});

test("repository source only uses RPCs and no legacy worker callback", () => {
  const source = readFileSync(new URL("./write-repository.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.from\(["']direct_entry_(?:document|entries)/);
  assert.doesNotMatch(source, /apply_document_worker_callback|direct_entry_reserve_document_upload"/);
});