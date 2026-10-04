import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CCCD_STATUS_UNKNOWN_LABEL,
  CCCD_UNSAVED_LABEL,
  EMPTY_CCCD_STATUS_CACHE,
  dropCccdStatus,
  readCccdStatus,
  writeCccdStatus,
} from "./cccd-status.ts";

const ENTRY = "c1000000-0000-4000-8000-00000000000a";

function doc(type, upload, validation, scan) {
  return { document_type: type, upload_status: upload, validation_status: validation,
    scan_status: scan };
}

test("dong chua luu hien 'Chưa lưu' va nut quan ly bi khoa", () => {
  const view = readCccdStatus(EMPTY_CCCD_STATUS_CACHE, null, null);
  assert.equal(view.kind, "UNSAVED");
  assert.equal(view.label, "Chưa lưu");
  assert.equal(CCCD_UNSAVED_LABEL, "Chưa lưu");
  assert.equal(view.canManage, false);
  assert.equal(readCccdStatus(EMPTY_CCCD_STATUS_CACHE, "", null).canManage, false);
});

test("dong da luu nhung chua mo ho so hien 'Chưa tải trạng thái' (khong gia 0/2)", () => {
  const view = readCccdStatus(EMPTY_CCCD_STATUS_CACHE, ENTRY, 1);
  assert.equal(view.kind, "UNKNOWN");
  assert.equal(view.label, CCCD_STATUS_UNKNOWN_LABEL);
  assert.equal(view.label, "Chưa tải trạng thái");
  assert.notEqual(view.label, "0/2");
  assert.equal(view.canManage, true);
});

test("0/2, 1/2, 2/2 chi sau khi da doc detail dung entry/version", () => {
  const zero = writeCccdStatus(EMPTY_CCCD_STATUS_CACHE, ENTRY, 3, []);
  assert.equal(readCccdStatus(zero, ENTRY, 3).label, "0/2");
  assert.equal(readCccdStatus(zero, ENTRY, 3).kind, "LOADED");

  const one = writeCccdStatus(zero, ENTRY, 3, [doc("CCCD_FRONT", "READY", "VALIDATED", "CLEAN")]);
  assert.equal(readCccdStatus(one, ENTRY, 3).label, "1/2");

  const two = writeCccdStatus(one, ENTRY, 4, [
    doc("CCCD_FRONT", "READY", "VALIDATED", "CLEAN"),
    doc("CCCD_BACK", "READY", "VALIDATED", "NOT_REQUIRED"),
  ]);
  assert.equal(readCccdStatus(two, ENTRY, 4).label, "2/2");

  // scan_status thieu/PENDING/REJECTED khong duoc tinh hoan tat.
  const pending = writeCccdStatus(EMPTY_CCCD_STATUS_CACHE, ENTRY, 1,
    [doc("CCCD_FRONT", "READY", "VALIDATED", "PENDING")]);
  assert.equal(readCccdStatus(pending, ENTRY, 1).label, "0/2");
});

test("version lech => quay ve 'Chưa tải trạng thái', khong dung du lieu cu", () => {
  const cache = writeCccdStatus(EMPTY_CCCD_STATUS_CACHE, ENTRY, 3, []);
  assert.equal(readCccdStatus(cache, ENTRY, 4).kind, "UNKNOWN");
  assert.equal(readCccdStatus(cache, ENTRY, 4).label, CCCD_STATUS_UNKNOWN_LABEL);
  assert.equal(readCccdStatus(dropCccdStatus(cache, ENTRY), ENTRY, 3).kind, "UNKNOWN");
  assert.equal(readCccdStatus(cache, "d1000000-0000-4000-8000-00000000000b", 3).kind, "UNKNOWN");
});

test("cache la bat bien, chi trong memory, khong luu storage", () => {
  const first = writeCccdStatus(EMPTY_CCCD_STATUS_CACHE, ENTRY, 1, []);
  const second = writeCccdStatus(first, ENTRY, 2, []);
  assert.equal(first.size, 1);
  assert.equal(second.size, 1);
  assert.notEqual(first, second);
  const source = readFileSync(new URL("./cccd-status.ts", import.meta.url), "utf8");
  for (const forbidden of ["localStorage.", "sessionStorage.", "document.cookie", "indexedDB.",
    "storage_key", "checksum", "signed", "bucket"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  // Khong co API luu tru nao khac ngoai Map trong memory.
  assert.doesNotMatch(source, /\bwindow\.localStorage|\bglobalThis\.localStorage/);
});
