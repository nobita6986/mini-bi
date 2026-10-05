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

test("header has five approved actions and no legacy paste or technical label", () => {
  const headerStart = live.indexOf("<header className={styles.header}>");
  const headerEnd = live.indexOf("</header>", headerStart);
  const header = live.slice(headerStart, headerEnd);
  assert.ok(headerStart > 0 && headerEnd > headerStart);
  // P1.7-H05: them nut "Thêm nhanh NLĐ" rieng voi "Thêm dòng" => tong cong 5.
  assert.equal((header.match(/<button\b/g) ?? []).length, 5);
  for (const action of [
    "Tải file Excel mẫu",
    "Nhập file Excel",
    "Thêm dòng",
    "Thêm nhanh NLĐ",
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

test("only the approved 18 data columns render; action rail is outside that set", () => {
  assert.deepEqual(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS, [
    "row_index", "project_id", "first_work_date", "display_name", "gender",
    "date_of_birth", "national_id", "national_id_issued_at", "national_id_issued_place",
    "address", "phone", "provider_type", "recruiter_id", "labor_type",
    "account_number", "bank_name", "account_holder_name", "general_note",
  ]);
  assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.length, 18);
  // R1: DataGrid chi nhan 18 default columns. ACTION_RAIL chi con la tap
  // metadata ngoai DataGrid (cho action rail ben ngoai).
  assert.deepEqual(DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS, ["save_status", "row_actions"]);
  assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.some((key) =>
    DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS.includes(key)), false);
  assert.match(grid, /DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS/);
  assert.doesNotMatch(grid, /return DIRECT_ENTRY_GRID_COLUMNS\.map\(build\)/);
  assert.deepEqual(DIRECT_ENTRY_GENDER_OPTIONS, ["Nam", "Nữ"]);
  assert.match(grid, /columnKey === "gender"\) return DIRECT_ENTRY_GENDER_OPTIONS/);
  assert.doesNotMatch(grid, /STATUS_OPTIONS/);
  // CCCD column key da duoc loai khoi action rail va khong con xuat hien trong grid.
  assert.equal(grid.includes('key: "cccd_documents"'), false,
    "cccd_documents khong con la cot trong grid");
});

test("provider filtering, recruiter reset, and CCCD/action rail outside grid are wired", () => {
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
  // P1.7-H05: recruiter field bi disable khi provider_type chua duoc chon.
  assert.match(grid, /disabled=\{props\.row\.providerType === ""\}/);
  assert.match(grid, /value=\{option\.id\}/);
  // P1.7-H05: employee_code khong hien thi tren grid (server tu sinh theo migration #39).
  assert.equal(grid.includes('employee_code'), false,
    "employee_code khong con xuat hien tren grid");
  assert.equal(grid.includes("Tự sinh khi lưu"), false,
    "employee_code placeholder khong con tren grid");
});

test("action rail dat NGOAI grid va chi gom CCCD button (persisted) hoac × (staged)", () => {
  // P1.7-H05-R1: action rail chuyen hoan toan ra ngoai DataGrid. Grid chi nhan
  // 18 cot default; khong con cot 'save_status', 'row_actions' hay cccd_documents.
  // Khong con cot frozen hay callback onManageDocuments trong grid.
  assert.equal(grid.includes("frozen"), false,
    "khong con cot frozen trong grid H05");
  assert.equal(grid.includes("Quản lý CCCD"), false,
    "Quan ly CCCD phai dat ngoai grid");
  assert.equal(grid.includes("Lưu dòng trước"), false);
  assert.equal(/onManageDocuments=\{[^}]*\(clientRowId\)/.test(live), false,
    "onManageDocuments da chuyen khoi grid sang rail ngoai");
  assert.equal(grid.includes("aria-label=\"Xóa dòng\""), false,
    "nut × cua staged row da chuyen ra ngoai DataGrid");
  // Live side: rail ben ngoai grid su dung setCccdRowId va aria-label tha ngu canh.
  assert.match(live, /setCccdRowId\(persistedRow\.rowId\)/);
  assert.match(live, /disabled=\{!row\.canManageCccd\}/);
  assert.match(live, /\{row\.canManageCccd \? "Hồ sơ" : "Tải hồ sơ"\}/);
  assert.match(live, /aria-label=\{row\.canManageCccd \? `Hồ sơ \$\{row\.employeeCode\}` : "Tải hồ sơ"\}/);
  assert.match(live, /data-testid=\{`row-delete-\$\{row\.clientRowId\}`\}/);
  assert.doesNotMatch(grid, /Nhân bản|Làm trống/);
  assert.match(live, /persisted: row\.entryId !== null/);
  assert.match(live, /onDeleteRow=\{onStagedDelete\}/);
});
