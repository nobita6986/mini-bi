import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { filterCatalogSearchOptions } from "../../lib/direct-entry/catalog-search.ts";
import { moveTypeaheadIndex } from "../../lib/direct-entry/typeahead.ts";
import {
  createSpreadsheetRowModel,
  updateSpreadsheetRowCells,
} from "../../lib/direct-entry/spreadsheet-row-model.ts";
import { recruitersForProvider } from "../../lib/direct-entry/direct-entry-grid-columns.ts";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}
const live = source("./direct-entry-live.tsx");
const grid = source("./direct-entry-spreadsheet-grid.tsx");

const PROJECTS = [{ id: "p1", label: "Compal" }, { id: "p2", label: "CDL" }, { id: "p3", label: "Khác" }];
const RECRUITERS = [
  { id: "r1", label: "Nguyễn Văn A", provider_type: "hrp", personnel_code: "vinht.td", vendor_id: null },
  { id: "r2", label: "Trần Thị B", provider_type: "vendor", personnel_code: null, vendor_id: "VND-77" },
];
const CATALOGS = { projects: PROJECTS, recruiters: RECRUITERS };

test("W07C-R4: doi ngay bat dau lam viec KHONG xoa recruiter da chon", () => {
  const model = createSpreadsheetRowModel();
  const rowId = model.rows[0].clientRowId;
  let next = updateSpreadsheetRowCells(model, rowId, {
    recruiter_id: "r1", first_work_date: "2026-10-01",
  });
  next = updateSpreadsheetRowCells(next, rowId, { first_work_date: "2026-11-15" });
  assert.equal(next.rows[0].cells.first_work_date, "2026-11-15");
  assert.equal(next.rows[0].cells.recruiter_id, "r1", "gia tri recruiter phai duoc giu");
});

test("W07C-R4: live khong con xoa recruiter_id khi first_work_date thay doi", () => {
  assert.equal(/first_work_date[^\n]*recruiter_id: ""/.test(live), false);
  assert.equal(/field === "first_work_date" \? \{ recruiter_id: "" \}/.test(live), false);
  assert.equal(live.includes('recruiter_id: ""'), false, "khong con patch xoa recruiter");
});

test("W07C-R4: danh muc cua ngay moi chua tai xong thi dung fallback, khong tra null", () => {
  assert.match(live, /catalogs\[dateKey\] \?\? fallbackCatalog/);
  assert.equal(/catalogs\[dateKey\] \?\? null/.test(live), false);
});

test("W07C-R4: tim kiem khong phan biet hoa/thuong theo nhan hien thi", () => {
  // Vi du cua Owner: go "C" tim duoc Compal va CDL (khop theo noi dung, khong phan
  // biet hoa/thuong). "Khác" cung chua "c" nen xuat hien — dung voi loc substring.
  assert.deepEqual(filterCatalogSearchOptions(PROJECTS, "C").map((o) => o.label),
    ["Compal", "CDL", "Khác"]);
  assert.deepEqual(filterCatalogSearchOptions(PROJECTS, "com").map((o) => o.label), ["Compal"]);
  assert.deepEqual(filterCatalogSearchOptions(PROJECTS, "COMPAL").map((o) => o.label),
    ["Compal"]);
  assert.deepEqual(filterCatalogSearchOptions(PROJECTS, "cdl").map((o) => o.label), ["CDL"]);
});

test("W07C-R4: tim kiem theo ma/dinh danh va tu khoa bo sung", () => {
  assert.deepEqual(
    filterCatalogSearchOptions([{ id: "p1", label: "Compal", keywords: "CP-01" }], "cp-01")
      .map((o) => o.id), ["p1"]);
  assert.deepEqual(
    filterCatalogSearchOptions([{ id: "vinht.td", label: "Nguyễn Văn A" }], "vinht").map((o) => o.id),
    ["vinht.td"]);
});

test("W07C-R4: query rong tra ve toan bo option, khong tu loc bot", () => {
  assert.equal(filterCatalogSearchOptions(PROJECTS, "").length, 3);
  assert.equal(filterCatalogSearchOptions(PROJECTS, "   ").length, 3);
});

test("W07C-R4: ban phim — mui ten di chuyen tren danh sach DA LOC", () => {
  // "l" khop dung hai du an: Compal va CDL.
  const visible = filterCatalogSearchOptions(PROJECTS, "l");
  assert.deepEqual(visible.map((o) => o.label), ["Compal", "CDL"]);
  assert.equal(moveTypeaheadIndex(-1, visible.length, "down"), 0, "mui ten xuong chon muc dau");
  assert.equal(moveTypeaheadIndex(0, visible.length, "down"), 1);
  assert.equal(moveTypeaheadIndex(1, visible.length, "down"), 0, "quay vong");
  assert.equal(moveTypeaheadIndex(0, visible.length, "up"), 1);
});

test("W07C-R4: editor commit contract duoc giu nguyen", () => {
  // Khong bao gio tu dong commit option dau tien: chi auto khi dung MOT ket qua.
  assert.match(grid, /visible\.length === 1 \? visible\[0\] : undefined/);
  // Blur/Tab giu nguyen gia tri da luu.
  assert.match(grid, /onBlur=\{\(\) => props\.onClose\(true, false\)\}/);
  // Escape dong ma khong doi gia tri.
  assert.match(grid, /props\.onClose\(false, false\)/);
  // Commit chi xay ra khi nguoi dung chon.
  assert.match(grid, /onClick=\{\(\) => commit\(option\)\}/);
});

test("W07C-R4: hai cot Dự án / Người tuyển dung editor co tim kiem", () => {
  assert.match(grid, /column\.key === "project_id" \|\| column\.key === "recruiter_id"/);
  assert.match(grid, /<SearchableCatalogCellEditor/);
  assert.match(grid, /filterCatalogSearchOptions\(options, query\)/);
});

test("W07C-R4: provider scoping cua Nguoi tuyen khong bi noi long", () => {
  assert.deepEqual(recruitersForProvider(RECRUITERS, "hrp").map((o) => o.id), ["r1"]);
  assert.deepEqual(recruitersForProvider(RECRUITERS, "vendor").map((o) => o.id), ["r2"]);
  // Chua chon HRP/Vendor thi khong co option nao => dropdown khong mo danh sach sai.
  assert.deepEqual(recruitersForProvider(RECRUITERS, "").map((o) => o.id), []);
  // CATALOGS van duoc dung trong test tim kiem phia tren.
  assert.equal(CATALOGS.recruiters.length, 2);
});
