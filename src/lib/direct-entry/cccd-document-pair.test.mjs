import assert from "node:assert/strict";
import test from "node:test";

import {
  CCCD_MAX_BYTES,
  CCCD_STATUS_UNKNOWN_LABEL,
  buildCccdUploadPlan,
  cccdIntentFingerprint,
  cccdProgressFromFlags,
  cccdProgressLabel,
  cccdSlotComplete,
  isCccdSha256,
} from "./cccd-document-pair.ts";

const ENTRY = "c1000000-0000-4000-8000-00000000000a";
const SHA = "a".repeat(64);

function doc(type, upload, validation, scan) {
  return { document_type: type, upload_status: upload, validation_status: validation, scan_status: scan };
}

function file(type, overrides = {}) {
  return { documentType: type, sizeBytes: 2048, mimeType: "image/jpeg", sha256: SHA, ...overrides };
}

test("tien do 0/2..2/2: scan_status bat buoc va chi CLEAN/NOT_REQUIRED la complete", () => {
  assert.equal(cccdProgressLabel([]), "0/2");
  assert.equal(cccdProgressLabel([doc("CCCD_FRONT", "READY", "VALIDATED", "CLEAN")]), "1/2");
  assert.equal(cccdProgressLabel([doc("CCCD_FRONT", "READY", "VALIDATED", "NOT_REQUIRED")]), "1/2");
  for (const scan of ["PENDING", "REJECTED"]) {
    assert.equal(cccdProgressLabel([doc("CCCD_FRONT", "READY", "VALIDATED", scan)]), "0/2", scan);
  }
  assert.equal(cccdProgressLabel([doc("CCCD_FRONT", "READY", "VALIDATED", undefined)]), "0/2");
  assert.equal(cccdProgressLabel([doc("CCCD_FRONT", "QUEUED", "VALIDATED", "CLEAN")]), "0/2");
  assert.equal(cccdProgressLabel([
    doc("CCCD_FRONT", "READY", "VALIDATED", "CLEAN"),
    doc("CCCD_BACK", "READY", "VALIDATED", "NOT_REQUIRED"),
  ]), "2/2");
  assert.equal(cccdProgressFromFlags({ cccd_front_ready: true, cccd_back_ready: false }), "1/2");
  assert.equal(cccdProgressFromFlags({ cccd_front_ready: false, cccd_back_ready: false }), "0/2");
  assert.equal(CCCD_STATUS_UNKNOWN_LABEL, "Chưa tải trạng thái");
});

test("plan: mot hoac hai mat, thu tu FRONT->BACK, partial retry hop le", () => {
  const both = buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 3,
    files: [file("CCCD_BACK"), file("CCCD_FRONT")] });
  assert.equal(both.ok, true);
  assert.deepEqual(both.order, ["CCCD_FRONT", "CCCD_BACK"]);
  assert.equal(both.fingerprints.CCCD_FRONT,
    "cccd:" + ENTRY + ":3:CCCD_FRONT:" + SHA);
  const frontOnly = buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 3, files: [file("CCCD_FRONT")] });
  assert.equal(frontOnly.ok, true);
  assert.deepEqual(frontOnly.order, ["CCCD_FRONT"]);
  const backOnly = buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 3, files: [file("CCCD_BACK")] });
  assert.equal(backOnly.ok, true);
  assert.deepEqual(backOnly.order, ["CCCD_BACK"]);
  assert.equal(buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 3, files: [] }).ok, false);
  assert.equal(buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 3,
    files: [file("CCCD_FRONT"), file("CCCD_FRONT")] }).ok, false);
});

test("validate: UUID, sha256 lowercase 64 hex, size, mime, version", () => {
  assert.equal(isCccdSha256(SHA), true);
  assert.equal(isCccdSha256("A".repeat(64)), false);
  assert.equal(isCccdSha256("a".repeat(63)), false);
  assert.equal(buildCccdUploadPlan({ entryId: "not-a-uuid", entryVersion: 1,
    files: [file("CCCD_FRONT")] }).ok, false);
  assert.equal(buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 0,
    files: [file("CCCD_FRONT")] }).ok, false);
  assert.equal(buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 1,
    files: [file("CCCD_FRONT", { sha256: "A".repeat(64) })] }).ok, false);
  assert.equal(buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 1,
    files: [file("CCCD_FRONT", { sizeBytes: 0 })] }).ok, false);
  assert.equal(buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 1,
    files: [file("CCCD_FRONT", { sizeBytes: CCCD_MAX_BYTES + 1 })] }).ok, false);
  assert.equal(buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 1,
    files: [file("CCCD_FRONT", { mimeType: "text/plain" })] }).ok, false);
});

test("fingerprint: cung noi dung + version dung lai, doi version/file/mat thi doi", () => {
  const base = cccdIntentFingerprint({ entryId: ENTRY, entryVersion: 1,
    documentType: "CCCD_FRONT", sha256: SHA });
  assert.equal(cccdIntentFingerprint({ entryId: ENTRY, entryVersion: 1,
    documentType: "CCCD_FRONT", sha256: SHA }), base);
  assert.notEqual(cccdIntentFingerprint({ entryId: ENTRY, entryVersion: 2,
    documentType: "CCCD_FRONT", sha256: SHA }), base);
  assert.notEqual(cccdIntentFingerprint({ entryId: ENTRY, entryVersion: 1,
    documentType: "CCCD_BACK", sha256: SHA }), base);
  assert.notEqual(cccdIntentFingerprint({ entryId: ENTRY, entryVersion: 1,
    documentType: "CCCD_FRONT", sha256: "b".repeat(64) }), base);
  assert.equal(/[^\u0000-\u007f]/.test(base), false, "fingerprint chi ASCII, khong PII");
});
