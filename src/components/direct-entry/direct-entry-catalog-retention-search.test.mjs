import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SEARCH_POPUP_MAX_HEIGHT,
  computeSearchPopupPosition,
  filterCatalogSearchOptions,
} from "../../lib/direct-entry/catalog-search.ts";
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

test("W07C-R4-R1: mo o da co gia tri roi go ngay thi loc dung, khong noi vao nhan cu", () => {
  // Neu query bi NOI vao nhan cu: "Compal" + "C" = "CompalC" => khong khop gi.
  assert.equal(filterCatalogSearchOptions(PROJECTS, "CompalC").length, 0);
  // Sau khi chon het text khi focus, ky tu dau tien THAY THE nhan cu.
  assert.deepEqual(filterCatalogSearchOptions(PROJECTS, "C").map((o) => o.label),
    ["Compal", "CDL", "Khác"]);
  assert.match(grid, /onFocus=\{selectAll\}/);
  assert.match(grid, /ref=\{queryInput\}/);
  assert.match(grid, /const browsing = query === pristineQuery;/);
  assert.match(grid, /browsing \? \[\.\.\.options\] : filterCatalogSearchOptions/);
});

test("W07C-R4-R1: dong ma chua chon thi gia tri cu khong doi, khong auto-commit", () => {
  // Escape dong ma khong doi gia tri.
  assert.match(grid, /props\.onClose\(false, false\)/);
  // Blur/Tab giu nguyen row da luu.
  assert.match(grid, /onBlur=\{\(\) => props\.onClose\(true, false\)\}/);
  // KHONG con auto-commit chi vi ket qua loc con mot muc.
  assert.equal(/visible\.length === 1 \? visible\[0\]/.test(grid), false);
  assert.match(grid, /const target = activeIndex >= 0 \? visible\[activeIndex\] : undefined;/);
  // Commit chi xay ra khi nguoi dung chon bang click.
  assert.match(grid, /onClick=\{\(\) => commit\(option\)\}/);
});

test("W07C-R4-R2: danh sach goi y KHONG con nam trong cell (thoat overflow: clip)", () => {
  // Nguyen nhan: o cua react-data-grid co overflow: clip nen danh sach render
  // ben trong cell bi cat khoi o. Kiem tra chinh xac luat CSS do van ton tai,
  // de test nay that su gan voi loi clipping chu khong chi la khop chuoi.
  const rdgCss = readFileSync(
    new URL("../../../node_modules/react-data-grid/lib/styles.css", import.meta.url), "utf8");
  // Selector cua cell bi hash nen khop theo layer + thuoc tinh, khong theo ten class.
  assert.match(rdgCss, /@layer rdg\.Cell\s*\{[\s\S]{0,900}overflow:\s*clip/,
    "o grid van clip noi dung");

  // Danh sach phai duoc render qua portal ra document.body => khong con la con cua
  // cell, nen khong the bi clip. Day la dieu kien ma code cu (ul nam trong cell) vi pham.
  const portalAt = grid.indexOf("createPortal(");
  const listAt = grid.indexOf('<ul');
  assert.ok(portalAt > 0, "phai dung createPortal");
  assert.ok(listAt > portalAt, "ul phai nam TRONG loi goi createPortal");
  assert.match(grid, /createPortal\([\s\S]{0,1600}document\.body\s*,?\s*\)/,
    "portal target la document.body");
  assert.equal((grid.match(/<ul/g) ?? []).length, 1, "chi co mot danh sach goi y");
  // Popup dat bang position: fixed voi toa do tinh tu anchor.
  assert.match(grid, /position: "fixed"/);
  assert.match(grid, /top: popup\.top/);
  assert.match(grid, /left: popup\.left/);
});

test("W07C-R4-R2: toa do popup luon nam trong viewport", () => {
  const viewport = { width: 1000, height: 800 };
  const anchor = { top: 300, bottom: 330, left: 200, width: 220 };

  // Du cho phia duoi => dat duoi o.
  const below = computeSearchPopupPosition({ anchor, listHeight: 200, viewport });
  assert.equal(below.placement, "below");
  assert.equal(below.top, 330);
  assert.ok(below.top + below.maxHeight <= viewport.height);

  // Sat day viewport => lat len tren, khong tran ra ngoai.
  const flipped = computeSearchPopupPosition({
    anchor: { top: 760, bottom: 790, left: 200, width: 220 }, listHeight: 200, viewport,
  });
  assert.equal(flipped.placement, "above");
  assert.ok(flipped.top >= 0, "khong bi day len tren viewport");
  assert.ok(flipped.top + flipped.maxHeight <= 760, "nam gon phia tren o");

  // Keo sat mep phai => kep lai trong le margin.
  const right = computeSearchPopupPosition({
    anchor: { top: 100, bottom: 130, left: 960, width: 220 }, listHeight: 120, viewport,
  });
  assert.ok(right.left + right.width <= viewport.width, "khong tran ngang");
  assert.ok(right.left >= 0);

  // Danh sach dai bi cat theo tran chieu cao.
  const capped = computeSearchPopupPosition({ anchor, listHeight: 5000, viewport });
  assert.ok(capped.maxHeight <= SEARCH_POPUP_MAX_HEIGHT);

  // Viewport rat thap van tra ve vi tri hop le (khong am, khong tran).
  const tiny = computeSearchPopupPosition({
    anchor, listHeight: 200, viewport: { width: 320, height: 200 },
  });
  assert.ok(tiny.top >= 0);
  assert.ok(tiny.top + tiny.maxHeight <= 200);
});

test("W07C-R4-R2: popup tinh lai vi tri khi grid cuon hoac viewport doi kich thuoc", () => {
  assert.match(grid, /window\.addEventListener\("scroll", onViewportChange, true\)/,
    "bat scroll theo capture de thay ca scroll cua grid");
  assert.match(grid, /window\.addEventListener\("resize", onViewportChange\)/);
  assert.match(grid, /window\.removeEventListener\("scroll", onViewportChange, true\)/);
  assert.match(grid, /window\.removeEventListener\("resize", onViewportChange\)/);
  assert.match(grid, /getBoundingClientRect\(\)/, "neo theo input dang sua");
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
