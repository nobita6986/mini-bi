import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SPREADSHEET_INITIAL_ROW_COUNT,
  SPREADSHEET_MAX_DATA_ROWS,
  SPREADSHEET_SPARE_ROW_COUNT,
  createSpreadsheetRowModel,
  ensureSpreadsheetRowCount,
  spreadsheetRowIsBlank,
} from "../../lib/direct-entry/spreadsheet-row-model.ts";

const live = readFileSync(new URL("./direct-entry-live.tsx", import.meta.url), "utf8");

function slice(startMarker, endMarker) {
  const start = live.indexOf(startMarker);
  assert.ok(start > 0, "missing marker: " + startMarker);
  const end = live.indexOf(endMarker, start);
  assert.ok(end > start, "missing end marker for: " + startMarker);
  return live.slice(start, end);
}

const pasteHandler = slice("const onStagedPaste = useCallback", "const onStagedUndo = useCallback");
const saveHandler = slice("const onStagedSave = useCallback", "const updateDate = useCallback");
const reloadDraftHandler = slice("const reloadDrafts = useCallback", "const runTransition = useCallback");

test("live render spreadsheet grid va khoi tao 30 staged rows client-only", () => {
  assert.match(live, /<DirectEntrySpreadsheetGrid/);
  assert.match(live, /useState<SpreadsheetRowModel>\(\(\) => createSpreadsheetRowModel\(\)\)/);
  assert.equal(SPREADSHEET_INITIAL_ROW_COUNT, 30);
  assert.equal(SPREADSHEET_SPARE_ROW_COUNT, 10);
  assert.equal(SPREADSHEET_MAX_DATA_ROWS, 100);
  // clientRowId khong bao gio duoc ghep voi entry_id.
  assert.equal(/clientRowId:\s*[a-zA-Z]*[Ee]ntryId/.test(live), false);
});

test("zero drafts van co 30 dong trong, va paste gan cuoi bang tu noi rong", () => {
  const model = createSpreadsheetRowModel();
  assert.equal(model.rows.length, 30);
  assert.equal(model.rows.every((row) => spreadsheetRowIsBlank(row)), true);
  const grown = ensureSpreadsheetRowCount(model, 32);
  assert.equal(grown.rows.length, 32);
  assert.equal(grown.nextClientRowSequence, 33);
  // Khong thu nho va khong doi id da cap.
  assert.equal(ensureSpreadsheetRowCount(grown, 10).rows.length, 32);
  assert.deepEqual(ensureSpreadsheetRowCount(model, 5).rows.map((r) => r.clientRowId),
    model.rows.map((r) => r.clientRowId));
});

test("paste cap nhat staged rows va khong goi mang", () => {
  assert.match(pasteHandler, /updateSpreadsheetRowCells\(/);
  assert.match(pasteHandler, /ensureSpreadsheetRowCount\(/);
  assert.match(pasteHandler, /request\.mapping\.cells\.some\(\(cell\) => cell\.rowIndex < liveDraftRowCount\)/);
  assert.match(pasteHandler, /cell\.rowIndex - liveDraftRowCount/);
  assert.equal(/\bfetch\s*\(/.test(pasteHandler), false, "paste khong fetch");
  assert.equal(/localStorage|sessionStorage|navigator\.clipboard/.test(pasteHandler), false);
  assert.match(pasteHandler, /setStagedNotice\(/);
  assert.match(pasteHandler, /Đã dán /);
});

test("undo dung snapshot W01 va khoi phuc dung truoc paste", () => {
  assert.match(live, /captureClipboardUndoSnapshot\(/);
  assert.match(live, /restoreClipboardUndoSnapshot\(/);
  assert.match(live, /const onStagedUndo = useCallback/);
  assert.match(live, /stagedUndo\.current = null;/);
  assert.match(live, /canUndo=\{stagedCanUndo\}/);
});

test("validation chay tren staged rows va map issue ve dung o", () => {
  assert.match(live, /buildSpreadsheetValidation\(\{/);
  assert.match(live, /rows: stagedModel\.rows,/);
  assert.match(live, /validation=\{stagedValidation\}/);
  // Blank rows khong vao save: chi rowOrder (non-empty) duoc dem.
  assert.match(live, /Lưu các dòng hợp lệ/);
  assert.match(live, /disabled=\{loadState !== "ready" \|\| !stagedValidation\.canSave \|\| stagedBusy\}/);
});

test("save dung full-profile batch, mot request, co chan double submit", () => {
  assert.match(saveHandler, /buildServerGeneratedFullProfileRequestBody\(/);
  assert.match(saveHandler, /postFullProfileBatch\(\{/);
  assert.equal(/\/api\/direct-entry/.test(saveHandler), false, "khong tu goi URL moi");
  assert.match(saveHandler, /if \(stagedInFlight\.current\) return;/);
  assert.match(saveHandler, /resolveIntentKey\(/);
  assert.match(saveHandler, /clearIntentKey\(/);
});

test("409 khong auto-retry, network/5xx giu intent key", () => {
  // retry: giu nguyen key va khong clear intent.
  assert.match(saveHandler, /if \(result\.kind === "retry"\) \{\s*\n\s*setStagedMessage\(fullProfileErrorMessage\(result\.code\)\);\s*\n\s*return;/);
  assert.equal(/setTimeout/.test(saveHandler), false, "khong auto-retry");
  const retryBranch = saveHandler.indexOf('if (result.kind === "retry")');
  const clearAfterRetry = saveHandler.indexOf('stagedIntent.current = clearIntentKey', retryBranch);
  assert.ok(retryBranch > 0 && clearAfterRetry > retryBranch,
    "sau nhanh retry moi clear key cho conflict/rejected");
});

test("success reload tu server va chi clear staged sau khi server xac nhan", () => {
  assert.match(saveHandler, /if \(result\.kind === "saved"\)/);
  assert.match(saveHandler, /await reloadDrafts\(\);/);
  const savedBranch = saveHandler.indexOf('if (result.kind === "saved")');
  const clearStaged = saveHandler.indexOf("setStagedModel(createSpreadsheetRowModel())");
  assert.ok(clearStaged > savedBranch, "clear staged chi trong nhanh saved");
});

test("persisted rows read-only theo submission lock, khong mo field ngoai safe mutation", () => {
  assert.match(live, /const editable = row\.state !== "saving" && row\.state !== "conflict" &&/);
  assert.match(live, /isRowEditable\(row, submissions\)/);
  assert.match(live, /editableFields: editable\s*\n\s*\? \["employee_code", "first_work_date", "display_name", "project_id", "recruiter_id", "labor_type"\]\s*\n\s*: \[\],/);
  // Field full-profile khac khong duoc them vao persisted editableFields.
  assert.equal(/editableFields: editable[\s\S]{0,400}account_number/.test(live), false);
});

test("draft reload requires exact versioned projection and makes one batch call without detail N+1", () => {
  assert.match(live, /value\.projection_version !== DRAFT_LIST_PROJECTION_VERSION/);
  assert.match(live, /return projectOwnDrafts\(\{/);
  assert.equal((reloadDraftHandler.match(/\/api\/direct-entry\/drafts/g) ?? []).length, 1);
  assert.equal(/\/api\/direct-entry\/entries\//.test(reloadDraftHandler), false);
});

test("masked display values are excluded from spreadsheet copy and write sources", () => {
  const grid = readFileSync(new URL("./direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");
  assert.match(grid, /const value = args\.row\.cells\[args\.column\.key\] \?\? ""/);
  assert.equal(/const value = args\.row\.displayValues/.test(grid), false);
  assert.match(live, /editableFields: editable\s*\n\s*\? \["employee_code", "first_work_date", "display_name", "project_id", "recruiter_id", "labor_type"\]/);
  assert.match(live, /CLIPBOARD_PERSISTED_ROW/);
});

test("spreadsheet is the only live desktop grid and profile hydration is passed to it", () => {
  assert.equal(/<DataGrid(?:<|\s)/.test(live), false);
  assert.equal((live.match(/<DirectEntrySpreadsheetGrid\b/g) ?? []).length, 1);
  assert.equal(live.includes('aria-label="Bảng bản nháp Direct Entry"'), false);
  assert.match(live, /projectDraftProfileGridCells\(row\.profile\)/);
  assert.match(live, /providerType: row\.providerType \?\? ""/);
  assert.match(live, /team_hint: row\.teamDisplayName/);
  assert.match(live, /onOpenDraft=\{\(rowId\) => setSelectedRowId\(rowId\)\}/);
  assert.ok(live.indexOf("<DirectEntrySpreadsheetGrid") < live.indexOf("<details className={styles.secondaryPanel}"));
  assert.ok(live.indexOf("<DirectEntrySpreadsheetGrid") < live.indexOf("<DirectEntrySubmissionList"));
  const grid = readFileSync(new URL("./direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");
  assert.match(grid, /maxRows: liveDraftRows \+ 100/);
  assert.match(grid, /DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS[\s\S]*DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS/);
});

test("persisted actions reopen the existing drawer; mobile, CCCD, payment and document paths remain", () => {
  const grid = readFileSync(new URL("./direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");
  // P1.7-H05: action rail ben trong grid chi co row_actions voi Xoa cho
  // staged row va save_status; CCCD/employee_code da chuyen ra ngoai grid.
  assert.match(grid, /!row\.clientStaged/);
  assert.match(grid, /onDeleteRow\(row\.clientRowId\)/);
  assert.match(grid, /Xóa dòng<\/button>|aria-label="Xóa dòng"/);
  // P1.7-H05: KHONG con CCCD/employee_code trong grid data columns.
  assert.equal(grid.includes("Quản lý CCCD"), false,
    "Quan ly CCCD phai dat ngoai grid");
  assert.equal(grid.includes("Tự sinh khi lưu"), false,
    "employee_code placeholder da chuyen ra ngoai grid");
  assert.equal(grid.includes("Nhân bản"), false);
  assert.equal(grid.includes("Làm trống"), false);
  assert.match(live, /selectedRowLocked = selectedRow !== null && !isRowEditable\(selectedRow, submissions\)/);
  assert.match(live, /styles\.mobileSection/);
  assert.match(live, /<Dialog\.Root open=\{selectedRow !== null\}/);
  for (const marker of ["DirectEntryCccdManager", "DirectEntryPaymentEditor",
    "DirectEntryDocumentEditor", "onManageDocuments=", "onEntryVersionChange="]) {
    assert.ok(live.includes(marker), "missing " + marker);
  }
});

test("XLSX import/template and mobile staged editor stay on the spreadsheet workflow", () => {
  assert.match(live, /workerProfileXlsxToTsv\(file\)/);
  assert.match(live, /createWorkerProfileTemplate\(\)/);
  assert.match(live, /Nhập file Excel/);
  assert.match(live, /Tải file Excel mẫu/);
  // P1.7-H05: employeeCode do server tu sinh (migration #39), UI chi hien thi
  // khi row da persisted.
  assert.match(live, /employeeCodeMode: "server-generated"|Máy chủ sẽ cấp mã khi lưu/);
  assert.match(live, /className=\{styles\.mobileStagedList\}/);
  assert.match(live, /Máy chủ sẽ cấp mã khi lưu/);
  // P1.7-H05: HRP/Vendor dropdown chi co 2 option don gian (HRP, Vendor) theo
  // yeu cau production UI; khong dung optgroup nhom.
  assert.match(live, /<option value="hrp">HRP<\/option>/);
  assert.match(live, /<option value="vendor">Vendor<\/option>/);
  assert.equal(live.includes('<optgroup label="HRP">'), false,
    "khong dung optgroup; HRP/Vendor chi co 2 option don gian");
});

test("khong thao cac duong CCCD/payment/submission/change-request/mobile", () => {
  for (const marker of ["DirectEntryCccdManager", "DirectEntryPaymentEditor",
    "DirectEntryDocumentEditor", "DirectEntrySubmissionList",
    "DirectEntryChangeRequestList", "DirectEntryChangeRequestProposer",
    "DirectEntryChangeRequestReviewer", "DirectEntrySubmittedDocumentManager",
    "styles.mobileSection"]) {
    assert.ok(live.includes(marker), "missing " + marker);
  }
  assert.equal(live.includes("DirectEntryWorkerProfilePasteDialog"), false);
  assert.equal(live.includes("DirectEntryExcelPasteDialog"), false);
});

test("khong co N+1 entry-detail fetch trong duong staged", () => {
  const stagedRegion = live.slice(live.indexOf("P1.7-W02 spreadsheet"), live.indexOf("const columns = useMemo"));
  assert.equal(/fetchEntryDetail|\/entries\/\${?[a-zA-Z]*\}?\/documents/.test(stagedRegion), false);
  assert.equal((stagedRegion.match(/\bfetch\s*\(/g) ?? []).length, 0,
    "duong staged khong tu goi fetch");
});
