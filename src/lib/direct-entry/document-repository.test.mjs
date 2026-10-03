import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createDirectEntryWriteRepository } from "./write-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const entryId = "a2000000-0000-4000-8000-000000000001";
const storageKey = "p1.6/c2000000-0000-4000-8000-000000000001/CCCD_FRONT/1/b2000000-0000-4000-8000-000000000001";
const input = {
  ...actor,
  entry_id: entryId,
  expected_entry_version: 1,
  document_type: "CCCD_FRONT",
  idempotency_key: "synthetic-document-key",
  checksum_sha256: "a".repeat(64),
  size_bytes: 512,
  mime_type: "image/png",
  reason: null,
};

test("repository reserves documents through the trusted RPC and projects storage key privately", async () => {
  const calls = [];
  const repository = createDirectEntryWriteRepository(async (name, args) => {
    calls.push({ name, args });
    return {
      data: {
        document_id: "b2000000-0000-4000-8000-000000000001",
        version: 1,
        entry_version: 2,
        upload_status: "QUEUED",
        scan_status: "PENDING",
        reused: false,
        storage_key: storageKey,
      },
      error: null,
    };
  });
  assert.deepEqual(await repository.reserveDocumentUpload(input), {
    ok: true,
    data: {
      document_id: "b2000000-0000-4000-8000-000000000001",
      version: 1,
      entry_version: 2,
      upload_status: "QUEUED",
      scan_status: "PENDING",
      reused: false,
      storage_key: storageKey,
    },
  });
  assert.deepEqual(calls, [{
    name: "direct_entry_reserve_document_upload",
    args: {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_entry_id: entryId,
      p_expected_entry_version: 1,
      p_document_type: "CCCD_FRONT",
      p_idempotency_key: "synthetic-document-key",
      p_checksum_sha256: "a".repeat(64),
      p_size_bytes: 512,
      p_mime_type: "image/png",
      p_reason: null,
    },
  }]);
});

test("malformed reservation projection and raw RPC errors fail closed", async () => {
  const malformed = createDirectEntryWriteRepository(async () => ({
    data: { document_id: "not-an-id", storage_key: "unsafe-key" },
    error: null,
  }));
  assert.deepEqual(await malformed.reserveDocumentUpload(input), {
    ok: false,
    kind: "unavailable",
  });

  const errorText = "secret raw database error";
  const failing = createDirectEntryWriteRepository(async () => ({
    data: null,
    error: { code: "XX000", message: errorText },
  }));
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    assert.deepEqual(await failing.reserveDocumentUpload(input), {
      ok: false,
      kind: "unavailable",
    });
    assert.equal(logged.join(" ").includes(errorText), false);
  } finally {
    console.error = originalError;
  }

  const source = readFileSync(new URL("./write-repository.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.from\(["']direct_entry_(?:document|entries)/);
  assert.match(source, /callRpc\("direct_entry_reserve_document_upload"/);
});
