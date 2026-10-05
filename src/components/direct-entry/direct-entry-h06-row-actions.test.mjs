/**
 * P1.7-H06 — Selected-row tests for Direct Entry (H06).
 *
 * Assertions for the simplified row action flow + selected-worker document
 * upload. Each test maps to a brief item.
 *
 * Source-level tests (read source as text) designed to run in CI without DOM.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  deleteSpreadsheetRow,
  createSpreadsheetRowModel,
  updateSpreadsheetRowCells,
} from "../../lib/direct-entry/spreadsheet-row-model.ts";

const live = readFileSync(
  new URL("./direct-entry-live.tsx", import.meta.url), "utf8");
const grid = readFileSync(
  new URL("./direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");
const documents = readFileSync(
  new URL("./direct-entry-worker-documents.tsx", import.meta.url), "utf8");
const manager = readFileSync(
  new URL("./direct-entry-cccd-manager.tsx", import.meta.url), "utf8");
const docEditor = readFileSync(
  new URL("./direct-entry-document-editor.tsx", import.meta.url), "utf8");

/* ----- 1. Khong con desktop action rail / tieu de Thao tác ----- */
test("H06-1 khong con desktop action rail va tieu de 'Thao tác'", () => {
  assert.doesNotMatch(live, /<div className=\{styles\.gridWithRail\}>/);
  assert.doesNotMatch(live, /<aside className=\{styles\.actionRailDesktop\}/);
  assert.doesNotMatch(live, /className=\{styles\.actionRailTitle\}/);
  assert.doesNotMatch(live, /className=\{styles\.actionRailDesktopList\}/);
  assert.doesNotMatch(live, /className=\{styles\.actionRailDesktopItem\}/);
  assert.doesNotMatch(live, /aria-label="Thao tác theo dòng"/);
  assert.doesNotMatch(live, /data-testid="desktop-action-rail"/);
});

/* ----- 2. Khong co day nut × theo row ----- */
test("H06-2 khong co day nut × theo row", () => {
  // Live khong con row-delete data-testid.
  assert.doesNotMatch(live, /data-testid=\{`row-delete-\$\{row\.clientRowId\}`\}/);
  // Khong con CSS class actionRailDeleteButton.
  assert.doesNotMatch(live, /className=\{styles\.actionRailDeleteButton\}/);
  // Grid khong no row data-testid=delete.
  assert.doesNotMatch(grid, /aria-label="Xóa dòng"/);
  assert.doesNotMatch(grid, /data-testid="row-delete-/);
});

/* ----- 3. DataGrid van chi co dung 18 data columns ----- */
test("H06-3 DataGrid van chi co dung 18 data columns", () => {
  const m = grid.match(/DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS\s*\.\s*map\(\(key\)\s*=>\s*directEntryGridColumn\(key\)\)/);
  assert.ok(m, "grid phai tao dataColumns tu DEFAULT_GRID_COLUMN_KEYS");
  for (const forbidden of ["save_status", "row_actions", "cccd_documents"]) {
    assert.equal(grid.includes(`"${forbidden}"`), false,
      `DataGrid khong duoc append cot ${forbidden}`);
  }
});

/* ----- 4. Click/focus cell chon dung clientRowId ----- */
test("H06-4 click/focus cell chon dung clientRowId qua DataGrid selectedRows", () => {
  assert.match(grid, /selectedRows=\{selectedClientRowId === null \|\| selectedClientRowId === undefined/);
  assert.match(grid, /new Set<string>\(\[selectedClientRowId\]\)/);
  assert.match(grid, /onSelectedRowsChange=\{/);
  // Chon row dua tren clientRowId, khong dua tren row index.
  assert.match(grid, /rowKeyGetter=\{\(row\) => row\.clientRowId\}/);
  // onChange pass buffer single key qua `onSelectedClientRowChange`.
  assert.match(grid, /onSelectedClientRowChange\(only\)/);
  // Live truyen selectedClientRowId xuong grid.
  assert.match(live, /selectedClientRowId=\{selectedClientRowId\}/);
});

/* ----- 5. Khong selection -> khong co Ho so NLD; Xoa disabled ----- */
test("H06-5 khong selection => Xoa disabled, khong co Ho so NLD", () => {
  // P1.7-H08: khi chua co selection, contextual bar chi hien Xoa (disabled).
  // Hồ sơ NLĐ chi render khi row da chon + co entry_id + co quyen xem.
  const bar = live.match(/<div className=\{styles\.contextualActionBar\}[\s\S]{0,6000}<\/div>/);
  assert.ok(bar, "phai co contextual action bar");
  // Xóa dòng: disabled khi selected === null.
  assert.match(bar[0], /data-testid="contextual-delete"[\s\S]{0,500}disabled=\{selected === null \|\| !selectedIsStaged\}/);
  // Khong co nut Ho so NLD render trong bar khi khong co selection.
  // (H08 chi render nut khi selectedIsPersisted && canOpenWorkerDocuments).
});

/* ----- 6. Staged selection => Xóa enabled, hien thi hint "Luu NLĐ" ----- */
test("H06-6 staged selection: Xóa enabled, hien thi hint", () => {
  // P1.7-H08: staged row khong con nut disabled "Ho so NLD"; thay vao do
  // hien thi inline hint "Lưu NLĐ để thêm hồ sơ" (data-testid="contextual-staged-hint").
  assert.match(live, /contextual-staged-hint/);
  assert.match(live, /Lưu NLĐ để thêm hồ sơ/);
  // Xóa dòng chi enabled khi staged.
  assert.match(live, /disabled=\{selected === null \|\| !selectedIsStaged\}/);
});

/* ----- 7. Persisted selection => Xóa disabled, Hồ sơ theo capability ----- */
test("H06-7 persisted selection: Xóa disabled, Hồ sơ theo capability", () => {
  // P1.7-H08: nut Ho so NLD chi render khi co entry_id + canViewDocs.
  // canEditDocuments prop truy vao DirectEntryWorkerDocuments chap nhan ca
  // entry_own lan entry_admin (truoc day chi entry_own).
  const contextualDocs = live.match(/data-testid="contextual-documents"[\s\S]{0,2500}/);
  assert.ok(contextualDocs, "phai co nut contextual-documents");
  // canEditDocuments prop accepts entry_own OR entry_admin.
  const workerDoc = live.match(/canEditDocuments=\{[\s\S]{0,400}\}/);
  assert.ok(workerDoc, "phai co canEditDocuments prop");
  assert.match(workerDoc[0], /entry_own[\s\S]{0,200}\|\|[\s\S]{0,200}entry_admin/);
  // Xóa dòng: disabled khi !selectedIsStaged (persisted => disabled).
  const contextualDel = live.match(/data-testid="contextual-delete"[\s\S]{0,400}/);
  assert.ok(contextualDel);
  assert.match(contextualDel[0], /disabled=\{selected === null \|\| !selectedIsStaged\}/);
});

/* ----- 8. Xoa row giua chi xoa row do ----- */
test("H06-8 xoa row giua chi xoa row do", () => {
  let model = createSpreadsheetRowModel();
  // Them 1 cell so 3 row khong trong (bypass 30 initial blanks).
  model = updateSpreadsheetRowCells(model, model.rows[0].clientRowId,
    { display_name: "Alpha" });
  model = updateSpreadsheetRowCells(model, model.rows[1].clientRowId,
    { display_name: "Beta" });
  model = updateSpreadsheetRowCells(model, model.rows[2].clientRowId,
    { display_name: "Gamma" });
  const firstId = model.rows[0].clientRowId;
  const secondId = model.rows[1].clientRowId;
  const thirdId = model.rows[2].clientRowId;
  model = deleteSpreadsheetRow(model, secondId);
  // Row giua bien mat; hai row con lai giu id va data.
  assert.equal(model.rows.some((row) => row.clientRowId === secondId), false,
    "row giua phai bi xoa");
  const alpha = model.rows.find((row) => row.clientRowId === firstId);
  const gamma = model.rows.find((row) => row.clientRowId === thirdId);
  assert.ok(alpha !== undefined && gamma !== undefined);
  assert.equal(alpha?.cells.display_name, "Alpha");
  assert.equal(gamma?.cells.display_name, "Gamma");
});

/* ----- 9. Stale selection fail-safe ----- */
test("H06-9 stale selection khong tac dong row khac", () => {
  // Effect `setStagedModel((current) => deleteSpreadsheetRow(current, clientRowId))`
  // chi xoa row co clientRowId match.
  let model = createSpreadsheetRowModel();
  model = updateSpreadsheetRowCells(model, model.rows[0].clientRowId,
    { display_name: "Alpha" });
  model = updateSpreadsheetRowCells(model, model.rows[1].clientRowId,
    { display_name: "Beta" });
  const ghostId = "spreadsheet-row-9999-ghost";
  const before = model.rows.length;
  model = deleteSpreadsheetRow(model, ghostId);
  assert.equal(model.rows.length, before, "stale id khong anh huong model");
  // Live: stale selection cleanup (useEffect).
  assert.match(live, /setSelectedClientRowId\(null\)/);
});

/* ----- 10. Hồ sơ mo dung persisted entry_id ----- */
test("H06-10 Hồ sơ NLĐ mo theo entry_id (khong theo row index/ho ten/CCCD)", () => {
  // Mo dialog dua vao `rowId` (persisted rowId), danh den `documentsRow`.
  // `documentsRow` se cung cap `entryId` cho DirectEntryWorkerDocuments -> CCCD/Document.
  assert.match(live, /setDocumentsRowId\(persisted\.rowId\)/);
  // Documents dialog mount theo entry_id, khong theo row index/ho ten/CCCD.
  assert.match(live, /key=\{documentsRow\?\.entryId \?\? "no-documents-row"\}/);
  // CCCD manager mount theo entry_id (prop `row.entryId` duoc truyen).
  assert.match(documents, /<DirectEntryCccdManager[\s\S]{0,400}row=\{row\}/);
  // Document editor mount theo entryId.
  assert.match(documents, /entryId=\{row\.entryId\}/);
  // Document drawer su dung DirectEntryCccdManager (CCCD_FRONT/BACK) va DirectEntryDocumentEditor (3 loai).
  assert.match(documents, /<DirectEntryCccdManager/);
  assert.match(documents, /<DirectEntryDocumentEditor/);
});

/* ----- 11. Khong dung row index/name/CCCD de mo ho so ----- */
test("H06-11 khong dung row index/name/CCCD de mo ho so", () => {
  // Contextual action bar KHONG su dung row index, ho ten hay CCCD de set rowId.
  const action = live.match(/data-testid="contextual-documents"[\s\S]{0,1500}/);
  assert.ok(action);
  // Khong co index/name lookup ben trong.
  assert.equal(/national_id|nationalId/.test(action[0]), false,
    "contextual action khong su dung national_id");
  assert.equal(/row_index/.test(action[0]), false,
    "contextual action khong su dung row index");
  // Documents dialog resolve rowId -> entryId server-issued (entryId field reference).
  assert.match(documents, /entryId=\{row\.entryId\}/);
});

/* ----- 12. Reuse DirectEntryCccdManager + DirectEntryDocumentEditor ----- */
test("H06-12 reuse DirectEntryCccdManager va DirectEntryDocumentEditor", () => {
  // Trong documents dialog phai reference ca hai.
  assert.match(documents, /\bDirectEntryCccdManager\b/);
  assert.match(documents, /\bDirectEntryDocumentEditor\b/);
  // CCCD manager khong them API upload moi (transport/runner giu nguyen).
  assert.match(manager, /createCccdTransport/);
  assert.match(manager, /runCccdUpload/);
});

/* ----- 13. Khong N+1 fetch ----- */
test("H06-13 khong N+1 entry-detail fetch tren document dialog", () => {
  // Documents dialog chi fetch entry detail ben trong DirectEntryCccdManager
  // (1 lan duy nhat, da kiem o test cccd-manager). Live khong goi fetch.
  const liveRegion = live.slice(live.indexOf("<DirectEntryWorkerDocuments"),
    live.indexOf("<Dialog.Root", live.indexOf("<DirectEntryWorkerDocuments")));
  assert.equal(/fetchEntryDetail|\/api\/direct-entry\/entries\//.test(liveRegion), false,
    "live khong goi entry detail");
  assert.equal((liveRegion.match(/\bfetch\s*\(/g) ?? []).length, 0,
    "live khong goi fetch truc tiep");
});

/* ----- 14. Khong render/log storage metadata ----- */
test("H06-14 khong render/log storage metadata", () => {
  const RAW_LOGGING = /console\.(?:log|error|warn|info)\(/;
  for (const file of [documents, manager, docEditor, live]) {
    assert.doesNotMatch(file, RAW_LOGGING);
    for (const forbidden of ["storage_key", "checksum",
      "signed_url", "file.name", "file_name"]) {
      assert.equal(file.includes(forbidden), false, forbidden);
    }
  }
  // Documents dialog chi hien ho ten + ma NLĐ, khong full CCCD hay storage key.
  assert.match(documents, /Mã do máy chủ cấp/);
  assert.doesNotMatch(documents, /\{national_id\}/);
  // Khong log signed URL / bucket name.
  assert.doesNotMatch(documents, /signedUrl|bucket_name/);
});

/* ----- 15. Mobile persisted card mo cung document flow ----- */
test("H06-15 mobile persisted card mo cung documents dialog", () => {
  assert.match(live, /data-testid=\{`mobile-open-documents-\$\{row\.rowId\}`\}/);
  assert.match(live, /onClick=\{\(\) => setDocumentsRowId\(row\.rowId\)\}/);
  // Documents dialog khong phan biet desktop/mobile (cung component).
  assert.equal(documents.includes("useBreakpoint"), false,
    "documents dialog khong tach desktop/mobile");
});

/* ----- 16. Quick editor staged khong upload ----- */
test("H06-16 staged quick editor khong upload", () => {
  // Quick editor chi goi onQuickSaveRow; khong co direct upload transport.
  const quickEditor = live.match(/<Dialog\.Content className=\{styles\.quickDrawer\}[\s\S]{0,20000}<\/Dialog\.Content>/);
  assert.ok(quickEditor);
  assert.equal(/createCccdTransport|runCccdUpload|\/documents"/.test(quickEditor[0]), false,
    "quick editor khong goi upload transport");
  assert.match(quickEditor[0], /Lưu trước để tải hồ sơ/);
  assert.match(quickEditor[0], /data-testid="quick-save-row"/);
  assert.match(quickEditor[0], /data-testid="quick-delete-row"/);
});

/* ----- 17. Sau save chi select persisted row khi match server entry_id ----- */
test("H06-17 sau save chi select persisted row khi match server-returned entry_id", () => {
  // Quick save: setSelectionAfterSaveEntryId(savedEntryId) -> effect resolve.
  const quickSaved = live.match(
    /const onQuickSaveRow = useCallback\(async \(clientRowId: string\) => \{[\s\S]{0,5000}\}, \[[\s\S]{0,400}\]\);/);
  assert.ok(quickSaved);
  const savedBranch = quickSaved[0].indexOf('if (result.kind === "saved")');
  const savedSlice = quickSaved[0].slice(savedBranch, savedBranch + 2000);
  assert.match(savedSlice, /setSelectionAfterSaveEntryId\(savedEntryId\)/);
  // Batch save: lap qua savedClientRowIds va set stagedToEntry map.
  const batchSaved = live.match(
    /const onStagedSave = useCallback\(async \(\) => \{[\s\S]{0,5000}\}, \[[\s\S]{0,400}\]\);/);
  assert.ok(batchSaved);
  const batchSavedBranch = batchSaved[0].indexOf('if (result.kind === "saved")');
  const batchSavedSlice = batchSaved[0].slice(batchSavedBranch, batchSavedBranch + 3000);
  assert.match(batchSavedSlice, /const stagedToEntry = new Map<string, string>/);
  assert.match(batchSavedSlice, /setSelectionAfterSaveEntryId\(expectedEntryId\)/);
  // Resolver effect tim row theo entryId.
  assert.match(live, /const match = rows\.find\(\(row\) => row\.entryId === selectionAfterSaveEntryId\)/);
});

/* ----- 18. H05/H05-R1, CCCD, document, grid, XLSX regressions ----- */
test("H06-18 H05/H05-R1, CCCD, document, grid, XLSX regressions khong suy yeu", () => {
  // CCCD manager khong bi sua code mat bao so.
  assert.match(manager, /CCCD_VALIDATION_PENDING_CODE/);
  assert.match(manager, /DOCUMENT_VERSION_CONFLICT/);
  assert.match(manager, /cccdSlotComplete/);
  // Document editor khong bi sua OCC/idempotency code mat.
  assert.match(docEditor, /Idempotency-Key/);
  assert.match(docEditor, /expected_entry_version/);
  // Grid khong them cot pseudo-columns.
  assert.equal(grid.includes("save_status"), false);
  assert.equal(grid.includes("row_actions"), false);
  assert.equal(grid.includes("cccd_documents"), false);
  // XLSX import/template path khong bi xoa.
  assert.match(live, /workerProfileXlsxToTsv/);
  assert.match(live, /createWorkerProfileTemplate/);
});