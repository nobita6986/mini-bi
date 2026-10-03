import assert from "node:assert/strict";
import test from "node:test";

import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import { checkDocumentFile, DOCUMENT_MAX_BYTES } from "./document-upload-contract.ts";

test("document MIME, size and magic-byte checks use the W01 allowlist and ceiling", () => {
  assert.equal(DOCUMENT_MAX_BYTES, 10 * 1024 * 1024);
  const cases = [
    ["image/jpeg", Uint8Array.of(0xff, 0xd8, 0xff, 0x00), true],
    ["image/png", Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), true],
    ["application/pdf", new TextEncoder().encode("%PDF-1.7"), true],
    ["image/png", new TextEncoder().encode("%PDF-1.7"), false],
    ["text/plain", new TextEncoder().encode("synthetic"), false],
  ];
  for (const [mime_type, bytes, expected] of cases) {
    const result = checkDocumentFile({
      document_type: "CCCD_FRONT",
      mime_type,
      size_bytes: bytes.length,
      bytes,
    });
    assert.equal(result.ok, expected, mime_type);
  }
  assert.equal(checkDocumentFile({
    document_type: "CCCD_BACK",
    mime_type: "image/png",
    size_bytes: DOCUMENT_MAX_BYTES + 1,
    bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  }).ok, false);
  assert.equal(checkDocumentFile({
    document_type: "NATIONAL_ID",
    mime_type: "image/png",
    size_bytes: 8,
    bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  }).ok, false);
});

test("client authority rejection detects nested objects and arrays", () => {
  assert.deepEqual(validateClientBusinessPayload({
    metadata: [{ candidate: { actor: { app_user_id: "synthetic" } } }],
  }), {
    ok: false,
    field: "metadata[0].candidate.actor",
    code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  });
});
