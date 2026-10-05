/**
 * P1.7-H05-R1 — Targeted source-level tests for the UI gap fixes.
 *
 * Each assertion here corresponds to a specific gap from the brief:
 *   - DataGrid nhan dung 18 cot, khong render save_status / row_actions /
 *     cccd_documents nhu cot pseudo-column.
 *   - Khong con nut × ben trong DataGrid (chi o rail ngoai).
 *   - Desktop action rail (gridWithRail) nam canh grid va map tung clientRowId.
 *   - "Lưu NLĐ" trong quick editor chi validate va gui DUY NHAT row dang mo.
 *   - Quick save thanh cong chi remove staged row vua luu (con lai giu nguyen).
 *   - Quick save loi/retry/OCC giu nguyen staged rows.
 *   - "Thêm dòng" them dung 10 staged rows, disabled khi khong du cho 10 row.
 *   - Mã NLĐ do server cap; khong co input/edit tren UI (grid/quick/drawer).
 *   - 4 optional field (STK/Bank/AccountHolder/Note) editable o staged,
 *     persisted projection khong phat sinh mutation gia.
 *
 * Tests thuoc source-level (read source as text) va duoc thiet ke de khong
 * phu thuoc vao DOM/runtime de co the chay trong CI environment.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SPREADSHEET_INITIAL_ROW_COUNT,
  SPREADSHEET_MAX_DATA_ROWS,
  SPREADSHEET_WRITABLE_FIELD_KEYS,
} from "../../lib/direct-entry/spreadsheet-row-model.ts";

import {
  DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS,
  DIRECT_ENTRY_GRID_COLUMNS,
} from "../../lib/direct-entry/direct-entry-grid-columns.ts";

const live = readFileSync(
  new URL("./direct-entry-live.tsx", import.meta.url), "utf8");
const grid = readFileSync(
  new URL("./direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");

const FOUR_OPTIONAL_FIELDS = ["account_number", "bank_name", "account_holder_name", "general_note"];
const EXPECTED_18_COLUMNS = Object.freeze([
  "row_index", "project_id", "first_work_date", "display_name", "gender",
  "date_of_birth", "national_id", "national_id_issued_at", "national_id_issued_place",
  "address", "phone", "provider_type", "recruiter_id", "labor_type",
  "account_number", "bank_name", "account_holder_name", "general_note",
]);

test("DataGrid nhan dung 18 cot default, khong save_status/row_actions/cccd_documents", () => {
  assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.length, 18);
  assert.deepEqual([...DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS], [...EXPECTED_18_COLUMNS]);
  for (const forbidden of ["save_status", "row_actions", "cccd_documents"]) {
    assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.includes(forbidden), false,
      `cot ${forbidden} khong duoc co trong DataGrid default`);
  }
  // Grid source: cot chi den tu DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.
  assert.match(grid, /DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS/);
  const dataColumnsBlock = grid.match(/const dataColumns[\s\S]{0,400}/);
  assert.ok(dataColumnsBlock, "phai co block tao dataColumns tu DEFAULT_GRID_COLUMN_KEYS");
  assert.match(dataColumnsBlock[0], /\.map\(\(key\) => directEntryGridColumn\(key\)\)/);
  // Khong append save_status/row_actions/cccd_documents.
  const blocked = ["save_status", "row_actions", "cccd_documents"];
  for (const key of blocked) {
    assert.equal(grid.includes(`"${key}"`), false,
      `DataGrid khong duoc append cot/pseudo ${key}`);
  }
  // 4 optional field van nam trong 18 cot (account_number/bank_name/
  // account_holder_name/general_note).
  for (const key of FOUR_OPTIONAL_FIELDS) {
    assert.ok(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.includes(key),
      `optional field ${key} phai co trong grid 18 cot`);
  }
});

test("DataGrid khong render nut × trong bang", () => {
  // P1.7-H06: nut × da duoc loai bo khoi DataGrid; chi con trong contextual
  // action bar (live) qua nut text "Xóa dòng".
  assert.equal(/aria-label="Xóa dòng"/.test(grid), false,
    "nut Xóa dòng staged row khong con trong DataGrid");
  assert.equal(grid.includes("data-testid=\"row-delete-"), false,
    "row-delete-<clientRowId> chi render trong live, khong phai DataGrid");
  assert.equal(grid.includes("onDeleteRow(row.clientRowId)"), false,
    "DataGrid khong con goi onDeleteRow truc tiep");
  // P1.7-H06: live co nut "Xóa dòng" trong contextual action bar, khong con
  // row-delete-* data-testid (the da bi loai theo task §3).
  assert.doesNotMatch(live, /data-testid=\{`row-delete-\$\{row\.clientRowId\}`\}/);
  assert.match(live, /data-testid="contextual-delete"/);
});

test("Contextual action bar (H06) thay the action rail; hai nut Hồ sơ NLĐ + Xóa dòng", () => {
  // P1.7-H06: layout gridWithRail + actionRailDesktop da bi loai bo; chi con
  // grid section full-width + contextual action bar nam phia tren.
  assert.equal(live.indexOf('<div className={styles.gridWithRail}>'), -1,
    "khong con layout gridWithRail");
  assert.equal(live.indexOf('<aside className={styles.actionRailDesktop}'), -1,
    "khong con action rail desktop");
  assert.equal(live.indexOf('data-testid="desktop-action-rail"'), -1,
    "khong con desktop-action-rail data-testid");
  // Contextual action bar phai co hai nut.
  const barIdx = live.indexOf('data-testid="contextual-action-bar"');
  assert.ok(barIdx > 0, "phai co contextual action bar");
  const docsBtn = live.match(/data-testid="contextual-documents"[\s\S]{0,400}Hồ sơ NLĐ/);
  assert.ok(docsBtn, "nut Hồ sơ NLĐ phai nam trong contextual action bar");
  const deleteBtn = live.match(/data-testid="contextual-delete"[\s\S]{0,400}Xóa dòng/);
  assert.ok(deleteBtn, "nut Xóa dòng phai nam trong contextual action bar");
  // Khong lap lai rail/list/table thu hai.
  assert.equal(/<ul[\s\S]{0,200}actionRail/.test(live), false,
    "khong con danh sach rail ngoai grid");
  assert.equal(/<table\b[\s\S]{0,200}actionRail/.test(live), false,
    "rail khong duoc la mot bang thu hai");
});

test("Quick save (Lưu NLĐ) chi gui row duy nhat, khong gui batch toan bo", () => {
  // onQuickSaveRow phai validate va build body chi voi matchingPreview,
  // khong lay toan bo stagedModel.rows.
  const quickSaveBlock = live.match(
    /const onQuickSaveRow = useCallback\(async \(clientRowId: string\) => \{[\s\S]{0,3500}\}, \[[\s\S]{0,200}\]\);/);
  assert.ok(quickSaveBlock, "phai co onQuickSaveRow useCallback");
  assert.match(quickSaveBlock[0], /buildServerGeneratedFullProfileRequestBody\(\[\s*matchingPreview\s*\]\)/);
  assert.match(quickSaveBlock[0], /stagedValidation\.rows\.findIndex\(\(row\) =>\s*row\.clientRowId === clientRowId\)/);
  assert.match(quickSaveBlock[0], /fullProfileIntentDigest\(body\.rows\)/);
  // Intent key chi dua tren clientRowId dang mo, khong them prefix khac.
  assert.match(quickSaveBlock[0], /"quick_full_profile_row:" \+ clientRowId \+ ":" \+ digest/);
  // Loai bo toan bo staged row khac: chi deleteSpreadsheetRow voi id vua luu.
  assert.match(quickSaveBlock[0], /deleteSpreadsheetRow\(current, clientRowId\)/);
  assert.equal(/selectNonEmptySpreadsheetRows\(/.test(quickSaveBlock[0]), false,
    "quick save KHONG duoc dung selectNonEmptyStagedRows (se gui tat ca)");
  // Nut quick-save-row phai goi onQuickSaveRow voi target.clientRowId.
  assert.match(live, /data-testid="quick-save-row"[\s\S]{0,200}onQuickSaveRow\(target\.clientRowId\)/);
});

test("Quick save thanh cong: chi xoa staged row vua luu, giu nguyen row khac; H06 giu selection", () => {
  const quickSaveBlock = live.match(
    /const onQuickSaveRow = useCallback\(async \(clientRowId: string\) => \{[\s\S]{0,5000}\}, \[[\s\S]{0,400}\]\);/);
  assert.ok(quickSaveBlock, "phai co onQuickSaveRow useCallback");
  const savedBranch = quickSaveBlock[0].indexOf('if (result.kind === "saved")');
  assert.ok(savedBranch > 0, "quick save phai co saved branch");
  const savedSlice = quickSaveBlock[0].slice(savedBranch, savedBranch + 2000);
  // deleteSpreadsheetRow trong nhanh saved chi nhan clientRowId duy nhat.
  assert.match(savedSlice, /deleteSpreadsheetRow\(current, clientRowId\)/);
  assert.match(savedSlice, /setQuickEditClientRowId\(null\)/);
  assert.match(savedSlice, /await reloadDrafts\(\)/);
  // Phai KHONG dung createSpreadsheetRowModel (se xoa toan bo staged rows).
  assert.equal(quickSaveBlock[0].includes("createSpreadsheetRowModel()"), false,
    "quick save KHONG duoc recreate toan bo staged model");
  // P1.7-H06: phai giu selection bang server-returned entry_id; khong doan
  // theo row index/ho ten/CCCD.
  assert.match(savedSlice, /setSelectionAfterSaveEntryId\(savedEntryId\)/);
  assert.match(savedSlice, /typeof savedEntryId === "string"/);
});

test("Quick save loi/retry/OCC: giu nguyen toan bo staged rows, khong dong editor", () => {
  const quickSaveBlock = live.match(
    /const onQuickSaveRow = useCallback\(async \(clientRowId: string\) => \{[\s\S]{0,3500}\}, \[[\s\S]{0,200}\]\);/);
  const savedBranch = quickSaveBlock[0].indexOf('if (result.kind === "saved")');
  const afterSaved = quickSaveBlock[0].slice(savedBranch);
  // Nhanh retry/conflict (khong phai saved): KHONG xoa row, KHONG dong drawer.
  // setStagedMessage chi, khong deleteSpreadsheetRow / setQuickEditClientRowId(null).
  const retryBranch = quickSaveBlock[0].indexOf('if (result.kind === "retry")');
  assert.ok(retryBranch > 0, "phai co retry branch");
  const retrySlice = quickSaveBlock[0].slice(retryBranch, retryBranch + 400);
  assert.equal(/deleteSpreadsheetRow/.test(retrySlice), false,
    "retry/conflict khong duoc xoa staged row");
  assert.equal(/setQuickEditClientRowId\(null\)/.test(retrySlice), false,
    "retry/conflict khong duoc dong quick editor");
  // Confirm: khong co setStagedModel(createSpreadsheetRowModel()) trong khoi nhanh error.
  const afterSavedSlice = quickSaveBlock[0].slice(afterSaved.indexOf('if (result.kind === "saved")'));
  assert.equal(afterSavedSlice.includes("createSpreadsheetRowModel()"), false,
    "khong recreate toan bo model trong quick save");
});

test("Thêm dòng: them dung 10 rows va check tren tong staged rows hien co", () => {
  const addBlock = live.match(/const addStagedRows = useCallback\(\(\) => \{[\s\S]{0,500}\}, \[[\s\S]{0,200}\]\);/);
  assert.ok(addBlock, "phai co addStagedRows useCallback");
  assert.match(addBlock[0], /current\.rows\.length \+ ADD_STAGED_ROW_BATCH > SPREADSHEET_MAX_DATA_ROWS/);
  assert.match(addBlock[0], /ensureSpreadsheetRowCount\(current, current\.rows\.length \+ ADD_STAGED_ROW_BATCH\)/);
  // ADD_STAGED_ROW_BATCH = 10 duoc khai bao truoc addStagedRows.
  assert.match(live, /const ADD_STAGED_ROW_BATCH = 10;/);
  // canAddStagedRows phai dung cung cong thuc.
  assert.match(live, /model\.rows\.length \+ ADD_STAGED_ROW_BATCH <= SPREADSHEET_MAX_DATA_ROWS/);
  // Nut Thêm dòng phai disabled khi !canAddStagedRows.
  assert.match(live, /data-testid="add-rows-batch"[\s\S]{0,200}disabled=\{loadState !== "ready" \|\| !canAddStagedRows\(stagedModel\)\}/);
});

test("Thêm dòng: 30->40, 90->100, 91->100 khong them partial, limit notice", () => {
  // 30 rows: 30+10 = 40 OK.
  // 90 rows: 90+10 = 100 OK.
  // 91-100 rows: 91+10 = 101 > 100, khong duoc them (disabled).
  // Gia tri 100: 100+10 = 110 > 100, khong duoc them.
  assert.equal(SPREADSHEET_MAX_DATA_ROWS, 100);
  assert.equal(SPREADSHEET_INITIAL_ROW_COUNT, 30);
  // 30+10 <= 100 OK.
  assert.equal(30 + 10 <= SPREADSHEET_MAX_DATA_ROWS, true);
  // 90+10 == 100 OK.
  assert.equal(90 + 10 <= SPREADSHEET_MAX_DATA_ROWS, true);
  // 91+10 > 100 khong OK.
  assert.equal(91 + 10 <= SPREADSHEET_MAX_DATA_ROWS, false);
  // 1000+10 > 100 khong OK.
  assert.equal(100 + 10 <= SPREADSHEET_MAX_DATA_ROWS, false);
  // Limit notice xuat hien trong addStagedRows.
  assert.match(live, /Đã đạt giới hạn 100 dòng dữ liệu; không thêm được 10 dòng mới\./);
});

test("Mã NLĐ (employee_code) khong co input/edit path tren UI", () => {
  // Grid: khong render cot employee_code.
  assert.equal(grid.includes("employee_code"), false,
    "employee_code khong con xuat hien trong DataGrid");
  // Persisted drawer: chi render <output>, khong phai <input>.
  // Scan all Field blocks for the one with persisted-employee-code.
  let foundOutput = false;
  // Scan all Field blocks for the one with persisted-employee-code.
  for (const m of live.matchAll(/<Field[^>]*>[\s\S]{0,500}?<\/Field>/g)) {
    if (m[0].includes("persisted-employee-code")) {
      foundOutput = m[0].includes("<output");
      assert.equal(m[0].includes("<input"), false,
        "persisted Mã NLĐ khong duoc la <input>");
      break;
    }
  }
  assert.ok(foundOutput, "persisted Mã NLĐ phai render bang <output>");
  // Quick editor khong co input cho Mã NLĐ.
  const quickFields = live.match(
    /<Dialog\.Content className=\{styles\.quickDrawer\}[\s\S]{0,10000}<\/Dialog\.Content>/);
  assert.ok(quickFields, "phai co quick editor dialog");
  // Khong cho sua Mã NLĐ: assert khong co handleMobileStagedFieldChange voi employee_code.
  assert.equal(/handleMobileStagedFieldChange\([^,]+,\s*"employee_code"\)/.test(quickFields[0]), false,
    "quick editor khong duoc sua employee_code");
  // editableFields cua persisted row khong bao gom employee_code.
  const persistedEditableFieldMatch = live.match(
    /editableFields: editable[\s\S]{0,500}\?\s*\[[^\]]+\]\s*:\s*\[\]/);
  assert.ok(persistedEditableFieldMatch, "persisted row phai co editableFields list");
  assert.equal(/employee_code/.test(persistedEditableFieldMatch[0]), false,
    "persisted editableFields khong duoc co employee_code");
  // onSpreadsheetCellsChange phai bo qua patch.employee_code.
  assert.match(live, /patch\.employee_code !== undefined[\s\S]{0,200}\.filter\(\(\[key\]\) => key !== "employee_code"\)/);
});

test("4 optional field (STK/Bank/AccountHolder/Note) editable o staged, XLSX import, va quick form", () => {
  // SPREADSHEET_WRITABLE_FIELD_KEYS phai bao gom 4 optional field.
  for (const key of FOUR_OPTIONAL_FIELDS) {
    assert.ok(SPREADSHEET_WRITABLE_FIELD_KEYS.includes(key),
      `${key} phai nam trong writable field keys`);
  }
  // Quick editor co input cho 4 optional field.
  const quickFields = live.match(
    /<Dialog\.Content className=\{styles\.quickDrawer\}[\s\S]{0,10000}<\/Dialog\.Content>/);
  assert.ok(quickFields, "phai co quick editor");
  for (const key of FOUR_OPTIONAL_FIELDS) {
    assert.match(quickFields[0],
      new RegExp(`handleMobileStagedFieldChange\\(target\\.clientRowId, "${key}"\\)`),
      `quick editor phai co field ${key}`);
  }
  // XLSX import: kiem tra cac optional field nam trong workbook contract/header.
  // Chung ta kiem tra qua viec tim worker profile contract co key nay.
  const contract = readFileSync(
    new URL("../../lib/direct-entry/worker-profile-import-contract.ts", import.meta.url),
    "utf8");
  for (const key of FOUR_OPTIONAL_FIELDS) {
    assert.match(contract, new RegExp(`\\b${key}\\b`),
      `worker-profile contract phai co ${key}`);
  }
});

test("Persisted row: 4 optional field chi render projection, khong phat sinh mutation", () => {
  // Persisted editableFields KHONG bao gom 4 optional field (chi 5 field goc).
  const persistedEditableFieldMatch = live.match(
    /editableFields: editable[\s\S]{0,500}\?\s*\[[^\]]+\]\s*:\s*\[\]/);
  assert.ok(persistedEditableFieldMatch, "persisted row phai co editableFields");
  for (const key of FOUR_OPTIONAL_FIELDS) {
    assert.equal(persistedEditableFieldMatch[0].includes(`"${key}"`), false,
      `persisted editableFields KHONG duoc bao gom ${key}`);
  }
  // Projection cell mapping cho 4 optional field (profileCells.cells).
  assert.match(live, /profileCells\.cells/);
  assert.match(live, /projectDraftProfileGridCells\(row\.profile\)/);
  // Display-only flag: 4 optional field nam trong editableFields chi khi staged.
  // Kiem tra SPREADSHEET_WRITABLE_FIELD_KEYS (staged) bao gom nhung persisted khong.
  const stagedHas = FOUR_OPTIONAL_FIELDS.every((key) =>
    SPREADSHEET_WRITABLE_FIELD_KEYS.includes(key));
  assert.ok(stagedHas, "staged row phai cho phep sua 4 optional field");
  // onSpreadsheetCellsChange: chi xoa employee_code khoi patch, giu nguyen 4 optional field.
  const onSpreadsheetCellsChange = live.match(
    /const onSpreadsheetCellsChange = useCallback\(\([\s\S]{0,2000}\}, \[[\s\S]{0,200}\]\);/);
  assert.ok(onSpreadsheetCellsChange, "phai co onSpreadsheetCellsChange useCallback");
  assert.match(onSpreadsheetCellsChange[0], /safePatch/);
  assert.match(onSpreadsheetCellsChange[0], /key !== "employee_code"/);
  // Dam bao 4 optional field khong bi loai bo trong safePatch.
  assert.equal(/key === "account_number"|key === "bank_name"|key === "account_holder_name"|key === "general_note"/.test(onSpreadsheetCellsChange[0]), false,
    "onSpreadsheetCellsChange KHONG duoc loai bo 4 optional field khoi patch");
});

test("Registry tong van giu day du cac field (bao gom save_status/row_actions/cccd_documents) cho drawer/projection", () => {
  // Dam bao registry 28 cot van day du; chi DataGrid khong su dung cac field
  // do. Muc dich nay de drawer/projection/validation khong bi anh huong.
  assert.equal(DIRECT_ENTRY_GRID_COLUMNS.length, 28);
  const keys = new Set(DIRECT_ENTRY_GRID_COLUMNS.map((column) => column.key));
  for (const key of ["save_status", "row_actions", "cccd_documents"]) {
    assert.ok(keys.has(key),
      `registry phai van giu ${key} (chi DataGrid default khong dung)`);
  }
});