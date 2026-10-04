import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DIRECT_ENTRY_GRID_COLUMNS,
  directEntryGridColumnIndex,
} from "./direct-entry-grid-columns.ts";

const source = readFileSync(
  new URL("../../components/direct-entry/direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");

test("registry co dung 27 cot va thu tu vat ly on dinh", () => {
  assert.equal(DIRECT_ENTRY_GRID_COLUMNS.length, 27);
  assert.equal(directEntryGridColumnIndex("project_id"), 1);
  assert.equal(directEntryGridColumnIndex("employee_code"), 3);
  assert.equal(directEntryGridColumnIndex("row_actions"), 26);
  assert.equal(directEntryGridColumnIndex("khong_ton_tai"), -1);
  // Moi cot deu co khoa duy nhat.
  assert.equal(new Set(DIRECT_ENTRY_GRID_COLUMNS.map((column) => column.key)).size, 27);
});

test("grid render cot tu registry, khong hard-code danh sach cot", () => {
  assert.match(source, /DIRECT_ENTRY_GRID_COLUMNS\.map\(build\)/);
  assert.equal(source.includes('name: "Mã NLĐ"'), false, "khong duoc hard-code ten cot");
});

test("paste dung pure parser/mapper cua W01, khong tu tach TSV trong component", () => {
  assert.match(source, /parseClipboardTsv\(/);
  assert.match(source, /mapClipboardFromAnchor\(/);
  assert.match(source, /serializeClipboardTsv\(/);
  assert.equal(/\.split\("\\t"\)/.test(source), false, "khong tu split tab");
  assert.equal(/\.split\(\/\\r\?\\n\//.test(source), false, "khong tu split dong");
});

test("paste chi doi React state: khong fetch, khong localStorage, khong Clipboard permission API", () => {
  assert.equal(/\bfetch\s*\(/.test(source), false, "khong goi mang");
  assert.equal(/\blocalStorage\s*[.[]/.test(source), false, "khong dung localStorage");
  assert.equal(/\bsessionStorage\s*[.[]/.test(source), false, "khong dung sessionStorage");
  assert.equal(/\bnavigator\s*\.\s*clipboard/.test(source), false, "khong dung Clipboard API");
  assert.equal(/\breadText\s*\(/.test(source), false, "khong doc clipboard nen");
  // Chi doc clipboard tu su kien do nguoi dung tao.
  assert.match(source, /event\.clipboardData\.getData\("text\/plain"\)/);
});

test("paste overflow bi tu choi toan bo truoc khi ap dung", () => {
  assert.match(source, /if \(!parsed\.ok\) \{ onPasteRejected\("CLIPBOARD_ROW_OVERFLOW"\); return args\.row; \}/);
  assert.match(source, /if \(!mapping\.ok\) \{ onPasteRejected\(mapping\.code\); return args\.row; \}/);
  // onPasteApplied chi duoc goi sau khi mapping thanh cong.
  const appliedIndex = source.indexOf("onPasteApplied({ mapping");
  const mappingGuard = source.indexOf("if (!mapping.ok)");
  assert.ok(mappingGuard > 0 && appliedIndex > mappingGuard, "chi apply sau khi qua guard");
});

test("banner paste co so hang x cot va nut Hoan tac", () => {
  assert.match(source, /data-testid="spreadsheet-paste-notice"/);
  assert.match(source, /data-testid="spreadsheet-undo"/);
  assert.match(source, /Hoàn tác/);
  assert.match(source, /canUndo/);
});

test("nut luu co busy/disabled va khong tu bao da luu", () => {
  assert.match(source, /data-testid="spreadsheet-save"/);
  assert.match(source, /disabled=\{saveDisabled \|\| saveBusy === true\}/);
  assert.match(source, /aria-busy=\{saveBusy === true\}/);
  assert.equal(source.includes("Đã lưu"), false, "khong optimistic da luu trong component");
});

test("dong bi khoa khong editable va derived/action khong editable", () => {
  assert.match(source, /!row\.locked && row\.editableFields\.includes\(columnKey\)/);
  assert.match(source, /column\.editor !== "readonly" && column\.editor !== "action"/);
  assert.match(source, /column\.pasteMode === "write"/);
});

test("loi duoc danh dau tren dung o va co tong ket dong loi", () => {
  assert.match(source, /data-cell-state=\{issue \? issue\.severity : "ok"\}/);
  assert.match(source, /data-testid="spreadsheet-error-summary"/);
  assert.match(source, /title=\{issue \? issue\.message : undefined\}/);
});

test("editor select/catalog lay option tu vocabulary hien huu, khong dinh nghia nghiep vu moi", () => {
  assert.match(source, /const GENDER_OPTIONS = \["", "Nam", "Nữ", "Khác"\];/);
  assert.match(source, /const LABOR_TYPE_OPTIONS = \["", "Thời vụ", "Toàn thời gian"\];/);
  assert.match(source, /const STATUS_OPTIONS = \["", "Chưa xác nhận", "Đang làm", "Đã nghỉ"\];/);
  // Option project/recruiter den tu catalog truyen vao, khong hard-code ID.
  assert.match(source, /catalogs\?\.projects \?\? \[\]\)\.map\(\(option\) => option\.label\)/);
  assert.match(source, /catalogs\?\.recruiters \?\? \[\]\)\.map\(\(option\) => option\.label\)/);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(source), false,
    "khong hard-code UUID catalog");
});

test("thao tac dong la client-only, khong co API xoa", () => {
  assert.match(source, /onClearRow\(row\.clientRowId\)/);
  assert.match(source, /onDeleteRow\(row\.clientRowId\)/);
  assert.match(source, /onDuplicateRow\(row\.clientRowId\)/);
  assert.equal(/method:\s*"DELETE"/.test(source), false);
});
