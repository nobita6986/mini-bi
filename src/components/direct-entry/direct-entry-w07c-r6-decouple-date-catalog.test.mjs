import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decideDdmmCommit,
  formatDateToDDMM,
  parseDDMMToIso,
} from "../../lib/direct-entry/direct-entry-date-format.ts";
import { buildSpreadsheetValidation } from "../../lib/direct-entry/direct-entry-grid-validation.ts";
import {
  createSpreadsheetRowModel,
  updateSpreadsheetRowCells,
  updateSpreadsheetRowProviderType,
} from "../../lib/direct-entry/spreadsheet-row-model.ts";
import { recruitersForProvider } from "../../lib/direct-entry/direct-entry-grid-columns.ts";

function read(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const live = read("./direct-entry-live.tsx");
const grid = read("./direct-entry-spreadsheet-grid.tsx");
const shell = read("./direct-entry-shell.tsx");
const ddmm = read("./direct-entry-ddmm-date-input.tsx");

const PROJECT = { id: "11111111-1111-4111-8111-111111111111", label: "Dự án Giả Bắc" };
const RECRUITER = {
  id: "22222222-2222-4222-8222-222222222222", label: "Tuyển Dụng Giả 1",
  provider_type: "hrp", personnel_code: "vinht.td", vendor_id: null,
};
const CURRENT_CATALOG = { projects: [PROJECT], recruiters: [RECRUITER] };

test("R6-A1: khong con input type=date cho first_work_date tren moi be mat", () => {
  for (const [name, source] of [["live", live], ["grid", grid], ["shell", shell]]) {
    assert.equal(/type="date"/.test(stripComments(source)), false, name + " con type=date");
  }
  // Editor dung chung: text + inputMode numeric + placeholder DD/MM/YYYY.
  assert.match(ddmm, /type="text"/);
  assert.match(ddmm, /inputMode="numeric"/);
  assert.match(ddmm, /DDMM_DATE_PLACEHOLDER/);
  assert.equal(ddmm.includes('placeholder="DD/MM/YYYY"') || ddmm.includes("placeholder={DDMM_DATE_PLACEHOLDER}"), true);
  // Moi be mat first_work_date dung editor dung chung nay.
  assert.equal((live.match(/<DdmmDateInput/g) ?? []).length, 3, "mobile card + quick editor + drawer");
  assert.equal((shell.match(/<DdmmDateInput/g) ?? []).length, 2, "legacy shell editor + inline row");
  assert.match(grid, /<DdmmDateInput/);
});

test("R6-A2/A3: ISO mo ra DD/MM/YYYY va nhap DD/MM/YYYY commit ve ISO", () => {
  assert.equal(formatDateToDDMM("2026-10-02"), "02/10/2026");
  assert.equal(decideDdmmCommit("02/10/2026", "").iso, "2026-10-02");
  assert.equal(decideDdmmCommit("02/10/2026", "2026-01-01").iso, "2026-10-02");
});

test("R6-A4: chap nhan D/M/YYYY va dau '-'", () => {
  assert.equal(decideDdmmCommit("2-10-2026", "").iso, "2026-10-02");
  assert.equal(decideDdmmCommit("2/10/2026", "").iso, "2026-10-02");
  assert.equal(parseDDMMToIso("02-10-2026"), "2026-10-02");
});

test("R6-A5: ngay sai KHONG xoa va KHONG ghi de gia tri cu", () => {
  const previous = "2026-10-02";
  for (const bad of ["", "   ", "31/02/2026", "abc", "2026-10-02", "1/13/2026"]) {
    const decision = decideDdmmCommit(bad, previous);
    assert.equal(decision.ok, false, bad + " phai bi tu choi");
  }
  // O trong khi chua tung co ngay thi commit rong la vo hai.
  assert.deepEqual(decideDdmmCommit("", ""), { ok: true, iso: "" });
  // Editor tra hien thi ve gia tri dang luu khi commit that bai.
  assert.match(ddmm, /setDraft\(formatDateToDDMM\(value\)\)/);
  assert.match(ddmm, /onClose\?\.\(false\)/);
  assert.match(ddmm, /event\.key === "Escape"/);
});

test("R6-B6: doi ngay giu nguyen project/recruiter/providerType", () => {
  let model = createSpreadsheetRowModel();
  const rowId = model.rows[0].clientRowId;
  model = updateSpreadsheetRowProviderType(model, rowId, "hrp");
  model = updateSpreadsheetRowCells(model, rowId, {
    project_id: PROJECT.id, recruiter_id: RECRUITER.id, first_work_date: "2026-10-02",
  });
  model = updateSpreadsheetRowCells(model, rowId, { first_work_date: "2026-11-15" });
  const row = model.rows[0];
  assert.equal(row.cells.first_work_date, "2026-11-15");
  assert.equal(row.cells.project_id, PROJECT.id, "project duoc giu");
  assert.equal(row.cells.recruiter_id, RECRUITER.id, "recruiter duoc giu");
  assert.equal(row.providerType, "hrp", "providerType duoc giu");
});

test("R6-B7: doi ngay khong phat request catalog theo ngay moi", () => {
  // Chi con MOT lan goi ensureCatalog duy nhat: ngay HCM cua trang luc mount.
  const calls = [...stripComments(live).matchAll(/ensureCatalog\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(calls, ["today"], "khong con ensureCatalog theo first_work_date");
  // Khong con effect load catalog theo catalogDates cua tung dong.
  assert.equal(/stagedValidation\.catalogDates/.test(live), false);
  // Khong con lookup catalog theo key la ngay cua dong.
  assert.equal(/catalogs\[/.test(stripComments(live)), true, "chi con currentCatalog/defaultCatalog");
  assert.equal(/catalogs\[row\.firstWorkDate\]|catalogs\[cells\.first_work_date|catalogs\[dateKey\]|catalogs\[target\.cells/.test(live), false,
    "khong con tra catalog theo ngay cua dong");
  // Va khong con xoa recruiter khi doi ngay o bat ky be mat nao.
  assert.equal(/firstWorkDate, recruiterId: ""/.test(live), false);
});

test("R6-B8/B9: catalog hien tai resolve UUID recruiter thanh label, khong bao thieu danh muc cho ngay lich su", () => {
  let model = createSpreadsheetRowModel();
  const rowId = model.rows[0].clientRowId;
  model = updateSpreadsheetRowCells(model, rowId, {
    project_id: PROJECT.label,
    first_work_date: "2026-10-02",
    display_name: "Nguyễn Văn Giả A",
    recruiter_id: RECRUITER.label,
    labor_type: "Thời vụ",
  });
  // catalogFor bo qua tham so ngay: catalog hien tai luon duoc dung.
  const validation = buildSpreadsheetValidation({
    rows: model.rows,
    referenceDate: "2026-10-20",
    catalogFor: () => CURRENT_CATALOG,
  });
  assert.equal(validation.cellIssues.some((issue) => issue.code === "PASTE_CATALOG_MISSING"), false,
    "ngay lich su khong duoc sinh PASTE_CATALOG_MISSING khi muc co trong catalog hien tai");
  assert.equal(validation.canSave, true);
  assert.equal(validation.rows[0].recruiterLabel, RECRUITER.label);
  assert.equal(validation.rows[0].projectLabel, PROJECT.label);
});

test("R6-B: provider scoping va stored catalog IDs duoc giu nguyen", () => {
  assert.deepEqual(recruitersForProvider([RECRUITER], "hrp").map((o) => o.id), [RECRUITER.id]);
  assert.deepEqual(recruitersForProvider([RECRUITER], "vendor").map((o) => o.id), []);
  assert.deepEqual(recruitersForProvider([RECRUITER], "").map((o) => o.id), []);
  // Both catalog fields use stable IDs; shortened names remain display-only.
  assert.match(grid, /\[props\.columnKey\]: option\.id/);
});

test("R6-C: search popup R4-R2 van dung portal ra document.body", () => {
  assert.match(grid, /createPortal\([\s\S]{0,1600}document\.body\s*,?\s*\)/);
  assert.match(grid, /position: "fixed"/);
  assert.match(grid, /computeSearchPopupPosition/);
});
