import assert from "node:assert/strict";
import test from "node:test";

import {
  cccdIntentKey,
  cccdProgressLabel,
  cccdSlotComplete,
  buildCccdUploadPlan,
} from "./cccd-document-pair.ts";

const ENTRY = "c1000000-0000-4000-8000-00000000000a";

function doc(type, upload, validation, scan) {
  return { document_type: type, upload_status: upload, validation_status: validation, scan_status: scan };
}

function file(type, overrides = {}) {
  return { documentType: type, sizeBytes: 2048, mimeType: "image/jpeg",
    contentSignature: "sig-" + type, ...overrides };
}

test("tien do ho so CCCD: 0/2, 1/2, 2/2", () => {
  assert.equal(cccdProgressLabel([]), "0/2");
  assert.equal(cccdProgressLabel([doc("CCCD_FRONT", "QUEUED", "PENDING")]), "0/2");
  assert.equal(cccdProgressLabel([doc("CCCD_FRONT", "READY", "VALIDATED", "CLEAN")]), "1/2");
  assert.equal(cccdProgressLabel([
    doc("CCCD_FRONT", "READY", "VALIDATED", "CLEAN"),
    doc("CCCD_BACK", "READY", "VALIDATED", "NOT_REQUIRED"),
  ]), "2/2");
  assert.equal(cccdProgressLabel([
    doc("CCCD_FRONT", "READY", "VALIDATED", "REJECTED"),
    doc("CCCD_BACK", "FAILED", "PENDING"),
  ]), "0/2");
  assert.deepEqual(cccdSlotComplete([]), { CCCD_FRONT: false, CCCD_BACK: false });
});

test("ke hoach hai mat: du file, thu tu tuan tu, key khong PII", () => {
  const plan = buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 3,
    files: [file("CCCD_BACK"), file("CCCD_FRONT")] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.order, ["CCCD_FRONT", "CCCD_BACK"]);
  assert.equal(plan.intentKeys.CCCD_FRONT, "cccd:" + ENTRY + ":CCCD_FRONT:sig-CCCD_FRONT");
  assert.match(plan.intentKeys.CCCD_BACK, /^cccd:c1000000-0000-4000-8000-00000000000a:CCCD_BACK:sig-CCCD_BACK$/);
  const serialized = JSON.stringify(plan);
  assert.equal(/[àáâãèéêìíòóôõùúýăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(serialized), false);
});

test("thieu mat, trung mat, sai kich thuoc/mime/signature deu fail-closed", () => {
  const missing = buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 1, files: [file("CCCD_FRONT")] });
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].documentType, "CCCD_BACK");
  assert.equal(buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 1,
    files: [file("CCCD_FRONT"), file("CCCD_FRONT"), file("CCCD_BACK")] }).ok, false);
  assert.equal(buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 1,
    files: [file("CCCD_FRONT", { sizeBytes: 0 }), file("CCCD_BACK")] }).ok, false);
  assert.equal(buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 1,
    files: [file("CCCD_FRONT", { sizeBytes: 10 * 1024 * 1024 + 1 }), file("CCCD_BACK")] }).ok, false);
  assert.equal(buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 1,
    files: [file("CCCD_FRONT", { mimeType: "text/plain" }), file("CCCD_BACK")] }).ok, false);
  assert.equal(buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 1,
    files: [file("CCCD_FRONT", { contentSignature: "  " }), file("CCCD_BACK")] }).ok, false);
  assert.equal(buildCccdUploadPlan({ entryId: "", entryVersion: 1, files: [] }).ok, false);
  assert.equal(buildCccdUploadPlan({ entryId: ENTRY, entryVersion: 0, files: [] }).ok, false);
});

test("retry cung noi dung dung lai key, doi noi dung thi key moi", () => {
  const first = cccdIntentKey({ entryId: ENTRY, documentType: "CCCD_FRONT", contentSignature: "a" });
  const retry = cccdIntentKey({ entryId: ENTRY, documentType: "CCCD_FRONT", contentSignature: "a" });
  const changed = cccdIntentKey({ entryId: ENTRY, documentType: "CCCD_FRONT", contentSignature: "b" });
  assert.equal(first, retry);
  assert.notEqual(first, changed);
  assert.notEqual(first, cccdIntentKey({ entryId: ENTRY, documentType: "CCCD_BACK", contentSignature: "a" }));
});
