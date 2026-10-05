import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS,
  DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS,
  DIRECT_ENTRY_GENDER_OPTIONS,
  recruitersForProvider,
} from "../../lib/direct-entry/direct-entry-grid-columns.ts";
import {
  createSpreadsheetRowModel,
  updateSpreadsheetRowCells,
  updateSpreadsheetRowProviderType,
} from "../../lib/direct-entry/spreadsheet-row-model.ts";

const live = readFileSync(new URL("./direct-entry-live.tsx", import.meta.url), "utf8");
const grid = readFileSync(new URL("./direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");

test("header has four approved actions and no legacy paste or technical label", () => {
  const headerStart = live.indexOf("<header className={styles.header}>");
  const headerEnd = live.indexOf("</header>", headerStart);
  const header = live.slice(headerStart, headerEnd);
  assert.ok(headerStart > 0 && headerEnd > headerStart);
  assert.equal((header.match(/<button\b/g) ?? []).length, 4);
  for (const action of [
    "Tải file Excel mẫu",
    "Nhập file Excel",
    "Thêm dòng",
    "Lưu các dòng hợp lệ",
  ]) assert.ok(header.includes(action), action);
  for (const hidden of [
    "P1.6 · Direct Entry · S03CD",
    "Dán từ Excel",
    "Dán hồ sơ từ Excel",
    "Ctrl+V",
    "dán một vùng từ Excel",
  ]) assert.equal(live.includes(hidden), false, hidden);
  assert.equal(live.includes("DirectEntryExcelPasteDialog"), false);
  assert.equal(live.includes("DirectEntryWorkerProfilePasteDialog"), false);
});

test("grid renders immediately before collapsed submission and change-request panels", () => {
  const gridSection = live.indexOf("<section className={styles.gridSection}");
  const gridComponent = live.indexOf("<DirectEntrySpreadsheetGrid", gridSection);
  const submissionPanel = live.indexOf("<details className={styles.secondaryPanel}", gridComponent);
  const submissionList = live.indexOf("<DirectEntrySubmissionList", submissionPanel);
  const changePanel = live.indexOf("<details className={styles.secondaryPanel}", submissionPanel + 1);
  assert.ok(gridSection > 0 && gridComponent > gridSection);
  assert.ok(submissionPanel > gridComponent && submissionList > submissionPanel);
  assert.ok(changePanel > submissionList);
  assert.match(live, /<summary>Đợt nhập liệu \(\{submissions\.length\}\)<\/summary>/);
  assert.match(live, /<summary>Yêu cầu thay đổi \(\{changeRequests\.length\}\)<\/summary>/);
  assert.doesNotMatch(live, /<details className=\{styles\.secondaryPanel\}[^>]*\bopen\b/);
});

test("only the approved 12 data columns render; action rail is outside that set", () => {
  assert.deepEqual(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS, [
    "row_index", "project_id", "first_work_date", "employee_code", "display_name", "gender",
    "national_id", "national_id_issued_at", "national_id_issued_place", "provider_type",
    "recruiter_id", "labor_type",
  ]);
  assert.deepEqual(DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS,
    ["cccd_documents", "save_status", "row_actions"]);
  assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.some((key) =>
    DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS.includes(key)), false);
  assert.match(grid, /DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS[\s\S]*DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS/);
  assert.doesNotMatch(grid, /return DIRECT_ENTRY_GRID_COLUMNS\.map\(build\)/);
  assert.deepEqual(DIRECT_ENTRY_GENDER_OPTIONS, ["", "Nam", "Nữ"]);
  assert.match(grid, /columnKey === "gender"\) return DIRECT_ENTRY_GENDER_OPTIONS/);
  assert.doesNotMatch(grid, /STATUS_OPTIONS/);
});

test("provider filtering, recruiter reset, and employee-code read-only display are wired", () => {
  const recruiters = [
    { id: "hrp-id", label: "HRP person", provider_type: "hrp" },
    { id: "vendor-id", label: "Vendor person", provider_type: "vendor" },
  ];
  assert.deepEqual(recruitersForProvider(recruiters, ""), []);
  assert.deepEqual(recruitersForProvider(recruiters, "hrp"), [recruiters[0]]);
  assert.deepEqual(recruitersForProvider(recruiters, "vendor"), [recruiters[1]]);

  let model = createSpreadsheetRowModel();
  const rowId = model.rows[0].clientRowId;
  model = updateSpreadsheetRowProviderType(model, rowId, "hrp");
  model = updateSpreadsheetRowCells(model, rowId, { recruiter_id: "hrp-id" });
  model = updateSpreadsheetRowProviderType(model, rowId, "vendor");
  assert.equal(model.rows[0].providerType, "vendor");
  assert.equal(model.rows[0].cells.recruiter_id, "");
  assert.equal(Object.hasOwn(model.rows[0].cells, "provider_type"), false);
  assert.match(grid, /disabled=\{props\.row\.providerType === ""\}/);
  assert.match(grid, /value=\{option\.id\}/);
  assert.match(grid, /row\.clientStaged \? "Tự sinh khi lưu" : row\.employeeCode/);
  assert.match(grid, /editable: \(row: SpreadsheetGridRow\) => column\.key === "provider_type"\s*\n\s*\? row\.clientStaged/);
});

test("action rail has only staged Remove, frozen controls, and guarded CCCD manager", () => {
  assert.match(grid, /key: column\.key, name: column\.label, width: column\.width, resizable: true, frozen/);
  assert.match(grid, /!row\.clientStaged/);
  assert.match(grid, /: <button type="button" aria-label=\{`Remove/);
  assert.match(grid, /disabled=\{!row\.persisted \|\| !row\.canManageCccd \|\| !onManageDocuments\}/);
  assert.match(grid, /row\.persisted \? "Quản lý CCCD" : "Lưu dòng trước"/);
  assert.doesNotMatch(grid, /Nhân bản|Làm trống/);
  assert.match(live, /persisted: row\.entryId !== null/);
  assert.match(live, /onDeleteRow=\{onStagedDelete\}/);
  assert.match(live, /onManageDocuments=\{\(clientRowId\)/);
});
