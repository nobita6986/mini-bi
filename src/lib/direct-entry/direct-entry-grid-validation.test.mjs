import assert from "node:assert/strict";
import test from "node:test";

import {
  SPREADSHEET_WRITE_COLUMNS,
  buildSpreadsheetValidation,
  serializeSpreadsheetRows,
  spreadsheetCellIssuesFor,
} from "./direct-entry-grid-validation.ts";
import {
  createSpreadsheetRowModel,
  updateSpreadsheetRowCells,
} from "./spreadsheet-row-model.ts";

const REFERENCE_DATE = "2026-10-16";
const PROJECT = { id: "11111111-1111-4111-8111-111111111111", label: "Dự án Giả Bắc" };
const RECRUITER = { id: "22222222-2222-4222-8222-222222222222", label: "Tuyển Dụng Giả 1" };

const catalogFor = () => ({ projects: [PROJECT], recruiters: [RECRUITER] });

function withRow(model, index, patch) {
  const row = model.rows[index];
  assert.ok(row);
  return updateSpreadsheetRowCells(model, row.clientRowId, patch);
}
function rowIdAt(model, index) {
  const row = model.rows[index];
  assert.ok(row);
  return row.clientRowId;
}

test("dong trong khong duoc validate va khong tao issue nao", () => {
  const model = createSpreadsheetRowModel();
  const validation = buildSpreadsheetValidation({
    rows: model.rows, referenceDate: REFERENCE_DATE, catalogFor,
  });
  assert.equal(validation.rows.length, 0);
  assert.equal(validation.cellIssues.length, 0);
  assert.equal(validation.errorCount, 0);
  assert.equal(validation.canSave, false);
  assert.equal(validation.firstError, null);
});

test("regression: chi cot pasteMode write moi vao payload, dung thu tu vat ly", () => {
  const headers = SPREADSHEET_WRITE_COLUMNS.map((column) => column.contractField?.canonicalHeader);
  assert.equal(SPREADSHEET_WRITE_COLUMNS.length, 20, "20 truong persisted");
  assert.equal(headers.includes(undefined), false);
  assert.equal(SPREADSHEET_WRITE_COLUMNS.some((column) => column.pasteMode !== "write"), false);
  // Thu tu vat ly phai khop registry (STT dung truoc Dự án, va STT khong phai cot write).
  assert.equal(SPREADSHEET_WRITE_COLUMNS[0]?.key, "project_id");
  assert.equal(SPREADSHEET_WRITE_COLUMNS[1]?.key, "first_work_date");
});

test("serialize giu nguyen so 0 dau, Unicode va o trong noi bo", () => {
  let model = createSpreadsheetRowModel();
  model = withRow(model, 4, {
    project_id: PROJECT.label,
    first_work_date: REFERENCE_DATE,
    employee_code: "hrp-2026-000101",
    display_name: "Nguyễn Văn Giả A",
    recruiter_id: RECRUITER.label,
    labor_type: "Thời vụ",
    national_id: "099006000001",
    phone: "",
    account_number: "0001234567890",
  });
  const row = model.rows[4];
  assert.ok(row);
  const tsv = serializeSpreadsheetRows([row]);
  const dataLine = tsv.split("\n")[1] ?? "";
  const cells = dataLine.split("\t");
  assert.equal(cells[0], PROJECT.label);
  assert.equal(cells[1], REFERENCE_DATE);
  assert.equal(cells[2], "hrp-2026-000101");
  assert.equal(cells[3], "Nguyễn Văn Giả A");
  assert.ok(cells.includes("099006000001"), "CCCD giu so 0 dau");
  assert.ok(cells.includes("0001234567890"), "STK giu so 0 dau");
  assert.ok(cells.includes(""), "o trong noi bo van duoc giu");
});

test("dong hop le duoc resolve catalog va khong co issue", () => {
  let model = createSpreadsheetRowModel();
  model = withRow(model, 0, {
    project_id: PROJECT.label,
    first_work_date: REFERENCE_DATE,
    employee_code: "hrp-2026-000101",
    display_name: "Nguyễn Văn Giả A",
    recruiter_id: RECRUITER.label,
    labor_type: "Thời vụ",
  });
  const validation = buildSpreadsheetValidation({
    rows: model.rows, referenceDate: REFERENCE_DATE, catalogFor,
  });
  assert.equal(validation.rowOrder.length, 1);
  assert.equal(validation.rowOrder[0], rowIdAt(model, 0));
  assert.equal(validation.validRowCount, 1);
  assert.equal(validation.canSave, true);
  assert.equal(validation.rows[0]?.projectLabel, PROJECT.label);
  assert.equal(validation.rows[0]?.recruiterLabel, RECRUITER.label);
});

test("issue duoc gan dung clientRowId va column key, khong lo gia tri PII", () => {
  let model = createSpreadsheetRowModel();
  model = withRow(model, 0, {
    project_id: PROJECT.label,
    first_work_date: REFERENCE_DATE,
    employee_code: "hrp-2026-000101",
    display_name: "Nguyễn Văn Giả A",
    recruiter_id: RECRUITER.label,
    labor_type: "Thời vụ",
  });
  model = withRow(model, 3, {
    project_id: PROJECT.label,
    first_work_date: REFERENCE_DATE,
    employee_code: "hrp-2026-000104",
    display_name: "Nguyễn Văn Giả D",
    recruiter_id: RECRUITER.label,
    labor_type: "Thời vụ",
    national_id: "12345",
  });
  const validation = buildSpreadsheetValidation({
    rows: model.rows, referenceDate: REFERENCE_DATE, catalogFor,
  });
  const targetId = rowIdAt(model, 3);
  const issues = spreadsheetCellIssuesFor(validation, targetId, "national_id");
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, "error");
  assert.equal(issues[0]?.message.includes("12345"), false, "message khong echo gia tri");
  assert.equal(validation.firstError?.clientRowId, targetId);
  assert.equal(validation.firstError?.columnKey, "national_id");
  assert.equal(validation.canSave, false);
  // Dong hop le khong bi gan loi.
  assert.equal(spreadsheetCellIssuesFor(validation, rowIdAt(model, 0), "national_id").length, 0);
});

test("duplicate employee_code trong cung mot lan nhap bi phat hien", () => {
  let model = createSpreadsheetRowModel();
  for (const index of [0, 1]) {
    model = withRow(model, index, {
      project_id: PROJECT.label,
      first_work_date: REFERENCE_DATE,
      employee_code: "hrp-2026-000101",
      display_name: "Nguyễn Văn Giả " + index,
      recruiter_id: RECRUITER.label,
      labor_type: "Thời vụ",
    });
  }
  const validation = buildSpreadsheetValidation({
    rows: model.rows, referenceDate: REFERENCE_DATE, catalogFor,
  });
  assert.ok(validation.errorCount >= 1);
  assert.equal(validation.canSave, false);
});

test("catalog missing duoc bao tai dung cot va chan save", () => {
  let model = createSpreadsheetRowModel();
  model = withRow(model, 0, {
    project_id: "Dự án Không Tồn Tại",
    first_work_date: REFERENCE_DATE,
    employee_code: "hrp-2026-000101",
    display_name: "Nguyễn Văn Giả A",
    recruiter_id: RECRUITER.label,
    labor_type: "Thời vụ",
  });
  const validation = buildSpreadsheetValidation({
    rows: model.rows, referenceDate: REFERENCE_DATE, catalogFor,
  });
  assert.equal(validation.canSave, false);
  assert.ok(validation.cellIssues.some((issue) => issue.columnKey === "project_id"));
});
