/**
 * P1.7-H08-R1 — Entry defaults + text input regression.
 *
 * Group 1: default Ngày bắt đầu làm việc (GMT+7) + Nơi cấp (`Bộ Công An`).
 *   - Source chỉ define defaults 1 chỗ (spreadsheet-row-model.ts).
 *   - Live component dùng `createSpreadsheetRowModel()` (đã gồm defaults)
 *     cho cả 30 initial rows, 10 added batch rows và quick editor drawer.
 *   - Quick editor + mobile staged card render `target.cells.first_work_date`
 *     và `target.cells.national_id_issued_place` (kế thừa từ staged row factory).
 *   - User có thể sửa/xóa defaults; rerender KHÔNG ghi đè lại.
 *   - Không dùng `toISOString()` trong runtime (tránh lệch UTC).
 *   - Spreadsheet row factory `appendBlankRows` gắn defaults cho mọi row
 *     mới (initial 30, batch 10, paste-pad).
 *
 * Group 2: default-only row vẫn là blank.
 *   - `spreadsheetRowIsBlank` đã được nâng cấp để coi row chỉ chứa 2 default
 *     là blank → không tính vào save batch, không validate, không gửi server.
 *   - `selectNonEmptySpreadsheetRows` đã dùng predicate này.
 *   - `buildSpreadsheetValidation` filter qua cùng predicate.
 *   - Khi user sửa default hoặc nhập business field, row tự active.
 *
 * Group 3: text editor nhiều ký tự (H07 cellsTextEditor regression).
 *   - Editor đọc/ghi `row.cells[column.key]`.
 *   - Mỗi keystroke: `onRowChange(next, false)` (commitChanges=false).
 *   - Blur/Enter/Tab: `onClose(true, ...)` commit.
 *   - Không commit/close sau mỗi `onChange`.
 *   - Không dùng `renderTextEditor` mặc định của react-data-grid.
 *
 * Group 4: H07 + H08 invariants.
 *   - H07: lazy validation, project fallback, row selection, cellsTextEditor.
 *   - H08: Hồ sơ NLĐ capability/view/upload, staged hint, no-permission hint.
 *   - Excel paste/import không bị ảnh hưởng.
 *   - Dropdown/date editors dùng commit riêng (không qua cellsTextEditor).
 *   - Blank spare rows vẫn được maintain bởi `ensureSpreadsheetSpareRows`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const ROW_MODEL = join(ROOT, "src/lib/direct-entry/spreadsheet-row-model.ts");
const LIVE = join(ROOT, "src/components/direct-entry/direct-entry-live.tsx");
const GRID = join(ROOT, "src/components/direct-entry/direct-entry-spreadsheet-grid.tsx");
const VALIDATION = join(ROOT, "src/lib/direct-entry/direct-entry-grid-validation.ts");

const rowModel = readFileSync(ROW_MODEL, "utf8");
const live = readFileSync(LIVE, "utf8");
const grid = readFileSync(GRID, "utf8");
const validation = readFileSync(VALIDATION, "utf8");

// ===== Group 1: defaults for date + place ================================

test("R1-1 spreadsheet-row-model export constants cho defaults va field keys", () => {
  assert.match(rowModel, /export const DEFAULT_NATIONAL_ID_ISSUED_PLACE = "Bộ Công An"/);
  assert.match(rowModel, /export const SPREADSHEET_DEFAULT_DATE_FIELD_KEY = "first_work_date"/);
  assert.match(rowModel, /export const SPREADSHEET_DEFAULT_PLACE_FIELD_KEY = "national_id_issued_place"/);
  // Co helper cho phep test inject `now` deterministic.
  assert.match(rowModel, /export function spreadsheetDefaultFirstWorkDate\(now: Date = new Date\(\)\)/);
  // Co helper defaultCells() de share logic giua row factory va blank clear.
  assert.match(rowModel, /export function defaultCells\(now: Date = new Date\(\)\)/);
});

test("R1-2 defaultCells set first_work_date theo Asia/Ho_Chi_Minh va place = Bộ Công An", () => {
  assert.match(rowModel, /defaultCells[\s\S]{0,400}spreadsheetDefaultFirstWorkDate\(now\)/);
  assert.match(rowModel, /defaultCells[\s\S]{0,400}DEFAULT_NATIONAL_ID_ISSUED_PLACE/);
  // Runtime khong hard-code ngay default va khong dung toISOString().
  const withoutComments = rowModel
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");
  assert.equal(/"\d{4}-\d{2}-\d{2}"/.test(withoutComments), false,
    "khong hard-code ngay default; phai tinh tu Asia/Ho_Chi_Minh");
  assert.equal(/toISOString/.test(withoutComments), false,
    "runtime khong dung toISOString de tinh ngay (tranh lech UTC)");
});

test("R1-3 createSpreadsheetRowModel / appendBlankRows / nextBlankRow dung defaultCells", () => {
  // createSpreadsheetRowModel goi appendBlankRows (30 lan).
  assert.match(rowModel, /export function createSpreadsheetRowModel\(\)[\s\S]{0,200}appendBlankRows/);
  // appendBlankRows goi nextBlankRow, nextBlankRow goi defaultCells.
  assert.match(rowModel, /function appendBlankRows[\s\S]{0,300}nextBlankRow\(/);
  assert.match(rowModel, /function nextBlankRow[\s\S]{0,200}defaultCells\(\)/);
  // clearSpreadsheetRow cung reset ve defaultCells (consistent UX).
  assert.match(rowModel, /clearSpreadsheetRow[\s\S]{0,300}defaultCells\(\)/);
});

test("R1-4 live su dung createSpreadsheetRowModel cho 30 initial + clear sau save", () => {
  // Initial 30 rows: useState khoi tao qua factory.
  assert.match(live, /useState<SpreadsheetRowModel>\(\(\) => createSpreadsheetRowModel\(\)\)/);
  // Sau khi save thanh cong, clear staged qua cung factory (defaults se apply cho batch moi).
  assert.match(live, /setStagedModel\(createSpreadsheetRowModel\(\)\)/);
  // addStagedRows them 10 rows moi qua ensureSpreadsheetRowCount (appendBlankRows => defaultCells).
  assert.match(live, /ensureSpreadsheetRowCount\(current, current\.rows\.length \+ ADD_STAGED_ROW_BATCH\)/);
  // addQuickStagedRow cung dung ensureSpreadsheetRowCount (quick editor se thua huong defaults).
  assert.match(live, /addQuickStagedRow[\s\S]{0,500}ensureSpreadsheetRowCount/);
});

test("R1-5 quick editor (desktop drawer) render defaults tu target.cells (ke thua tu row factory)", () => {
  // Quick editor desktop doc truc tiep target.cells.first_work_date
  // va target.cells.national_id_issued_place, vi vay defaults tu row factory
  // se hien thi ngay khi user mo drawer.
  // Dat ten nho de biet: `quickDrawer`.
  const quickStart = live.indexOf("Dialog.Content className={styles.quickDrawer}");
  assert.ok(quickStart > 0, "phai co Dialog.Content cho quick editor drawer");
  const quickEnd = live.indexOf("</Dialog.Content>", quickStart);
  assert.ok(quickEnd > quickStart);
  const quickEditor = live.slice(quickStart, quickEnd);
  assert.match(quickEditor, /target\.cells\.first_work_date \?\? ""/);
  assert.match(quickEditor, /target\.cells\.national_id_issued_place \?\? ""/);
});

test("R1-6 mobile staged card render defaults tu cells (ke thua tu row factory)", () => {
  // Mobile staged card cung render cells.first_work_date va cells.national_id_issued_place.
  const mobileStaged = live.match(/styles\.mobileStagedCard[\s\S]{0,8000}<\/details>/);
  assert.ok(mobileStaged, "phai co mobileStagedCard section");
  assert.match(mobileStaged[0], /cells\.first_work_date \?\? ""/);
  assert.match(mobileStaged[0], /cells\.national_id_issued_place \?\? ""/);
});

test("R1-7 user edit defaults qua handleMobileStagedFieldChange khong bi factory overwrite", () => {
  // handleMobileStagedFieldChange goi onMobileStagedChange (Update cells).
  assert.match(live, /const handleMobileStagedFieldChange = useCallback/);
  // updateRow phai goi updateSpreadsheetRowCells (merge patch, khong reset cells).
  assert.match(live, /updateSpreadsheetRowCells\(/);
  // onCellsChange trong grid cung chi goi onCellsChange (delta), khong full replace.
  assert.match(grid, /onRowsChange[\s\S]{0,500}onCellsChange\(row\.clientRowId, patch\)/);
});

test("R1-8 updateSpreadsheetRowCells MERGE patch (khong full replace cells)", () => {
  // Dam bao updateSpreadsheetRowCells chi ghi de cac key trong patch,
  // giu nguyen gia tri default (date/place) neu user khong sua.
  assert.match(rowModel, /updateSpreadsheetRowCells[\s\S]{0,400}cells:\s*\{\s*\.\.\.\s*row\.cells,\s*\.\.\.\s*patch\s*\}/);
});

// ===== Group 2: default-only row vẫn là blank =============================

test("R1-9 spreadsheetRowIsBlank da nang cap de bo qua default-only rows", () => {
  // Truoc H08-R1: every writable field empty => blank.
  // Sau H08-R1: every writable field empty HOAC default => blank.
  const predicate = rowModel.match(/export function spreadsheetRowIsBlank[\s\S]{0,800}\}/);
  assert.ok(predicate, "phai co spreadsheetRowIsBlank");
  // Phai co 2 nhanh default (date + place).
  assert.match(predicate[0], /SPREADSHEET_DEFAULT_DATE_FIELD_KEY/);
  assert.match(predicate[0], /SPREADSHEET_DEFAULT_PLACE_FIELD_KEY/);
  assert.match(predicate[0], /spreadsheetDefaultFirstWorkDate\(\)/);
  assert.match(predicate[0], /DEFAULT_NATIONAL_ID_ISSUED_PLACE/);
});

test("R1-10 selectNonEmptySpreadsheetRows su dung cung predicate (khong duplicate logic)", () => {
  // selectNonEmptySpreadsheetRows chi filter qua spreadsheetRowIsBlank.
  assert.match(rowModel, /selectNonEmptySpreadsheetRows[\s\S]{0,200}spreadsheetRowIsBlank/);
  // buildSpreadsheetValidation cung dung cung predicate.
  assert.match(validation, /input\.rows\.filter\(\(row\) => !spreadsheetRowIsBlank\(row\)\)/);
});

test("R1-11 ensureSpreadsheetSpareRows va ensureSpreadsheetRowCount chia se default factory", () => {
  // Ca hai deu goi appendBlankRows, appendBlankRows goi nextBlankRow, nextBlankRow goi defaultCells.
  // Dam bao khong co override rieng (logic duy nhat).
  assert.match(rowModel, /function appendBlankRows[\s\S]{0,300}nextBlankRow\(/);
  // ensureSpreadsheetRowCount chi goi appendBlankRows (khong co override cells).
  const ensure = rowModel.match(/export function ensureSpreadsheetRowCount[\s\S]{0,400}\}/);
  assert.ok(ensure, "phai co ensureSpreadsheetRowCount");
  assert.equal(/blankCells\(/.test(ensure[0]), false,
    "ensureSpreadsheetRowCount KHONG su dung blankCells (logic cu); chi dung defaultCells qua appendBlankRows");
});

test("R1-12 Excel paste khong override default (paste patch merge vao row.cells)", () => {
  // onStagedPaste goi updateSpreadsheetRowCells (merge), khong full replace.
  // Dam bao 2 default khong bi mat khi paste mot cell khac.
  assert.match(live, /onStagedPaste[\s\S]{0,2000}updateSpreadsheetRowCells\(/);
});

test("R1-21 Excel paste/import khong bi anh huong boi default place", () => {
  // Import path: parseWorkerProfilePaste => set cac field (gom national_id_issued_place neu user paste).
  // Dam bao import path khong bi factory overwrite.
  assert.match(live, /parseWorkerProfilePaste\(\{/);
  // onStagedPaste merge vao stagedModel (updateSpreadsheetRowCells MERGE).
  assert.match(live, /onStagedPaste[\s\S]{0,2000}updateSpreadsheetRowCells\(/);
  // XLSX import cung su dung parseWorkerProfilePaste path.
  assert.match(live, /workerProfileXlsxToTsv\(file\)/);
  assert.match(live, /parseWorkerProfilePaste\(/);
});

// ===== Group 3: cellsTextEditor multi-character regression =================

test("R1-13 cellsTextEditor doc/ghi row.cells[column.key] (H07 contract)", () => {
  // Mac dinh renderTextEditor cua react-data-grid doc row[column.key] (sai cho row model nay).
  // cellsTextEditor phai doc/ghi row.cells[column.key].
  const editor = grid.match(/function cellsTextEditor[\s\S]{0,800}\}/);
  assert.ok(editor, "phai co cellsTextEditor");
  // Doc cells.
  assert.match(editor[0], /const value = row\.cells\[column\.key\] \?\? ""/);
  // Ghi cells qua onRowChange.
  assert.match(editor[0], /onRowChange\(\{[\s\S]{0,200}cells:\s*\{\s*\.\.\.\s*row\.cells/);
});

test("R1-14 cellsTextEditor KHONG commit/close sau moi onChange keystroke", () => {
  const editor = grid.match(/function cellsTextEditor[\s\S]{0,800}\}/);
  assert.ok(editor);
  // onRowChange KHONG truyen commitChanges=true (mac dinh false) trong onChange handler.
  // Lay trong doan tu `onChange={` den `>}` dong (ket thuc JSX self-closing input).
  const onChange = editor[0].match(/onChange=\{[\s\S]{0,500}?\}\s*\/>/);
  assert.ok(onChange, "phai co onChange handler (JSX self-closing)");
  assert.equal(/onRowChange\([^)]*,\s*true\s*\)/.test(onChange[0]), false,
    "onChange KHONG goi onRowChange voi commitChanges=true (se close editor)");
  // Commit chi xay ra tren onBlur (onClose(true)).
  assert.match(editor[0], /onBlur=\{\(\) => onClose\(true, false\)\}/);
});

test("R1-15 Column build cho data cells editable dung cellsTextEditor (khong dung renderTextEditor)", () => {
  // Phai gan renderEditCell = cellsTextEditor.
  assert.match(grid, /renderEditCell:\s*cellsTextEditor/);
  // Khong import renderTextEditor tu react-data-grid.
  assert.equal(/import\s*\{[^}]*renderTextEditor[^}]*\}\s*from\s*"react-data-grid"/.test(grid), false,
    "khong con import renderTextEditor tu react-data-grid (H07 chuyen sang cellsTextEditor)");
  // Mac dinh text editor cua react-data-grid sai row model: KHONG con su dung.
  assert.doesNotMatch(grid, /<DataGrid[\s\S]{0,3000}renderTextEditor/);
});

test("R1-16 Date va Select cell editor van commit truc tiep (khong qua cellsTextEditor)", () => {
  // DateCellEditor: commit onRowChange voi commitChanges=true.
  const dateEditor = grid.match(/function DateCellEditor[\s\S]{0,400}\}/);
  assert.ok(dateEditor, "phai co DateCellEditor");
  assert.match(dateEditor[0], /onRowChange\([\s\S]{0,200},\s*true\)/);
  // SelectCellEditor: cung commit truc tiep.
  const selectEditor = grid.match(/function SelectCellEditor[\s\S]{0,1500}\}/);
  assert.ok(selectEditor, "phai co SelectCellEditor");
  assert.match(selectEditor[0], /const change = \(nextValue: string\) => props\.onRowChange\([\s\S]{0,200},\s*true\)/);
});

test("R1-17 simulated multi-character Vietnamese input: cellsTextEditor contract persists string", () => {
  // Gia lap behavior cua editor: typing tung keystroke phai accumulate.
  // Day la structural test (khong render React): verify contract qua source.
  const editor = grid.match(/function cellsTextEditor[\s\S]{0,800}\}/);
  assert.ok(editor);
  // value doc tu row.cells => moi keystroke tiep theo doc duoc gia tri cu.
  assert.match(editor[0], /value=\{value\}/);
  // onChange cap nhat cells => onRowChange se goi onRowsChange o parent.
  // Parent onRowsChange trong grid chi goi onCellsChange(clientRowId, patch) neu co diff.
  assert.match(grid, /onRowsChange[\s\S]{0,500}onCellsChange\(row\.clientRowId, patch\)/);
  // Dam bao onCellsChange chi merge patch (khong full replace row).
  assert.match(live, /setStagedModel\(\(current\) => updateSpreadsheetRowCells\(current, clientRowId, \{[\s\S]{0,400}\}\)\)/);
});

test("R1-18 paste cellsTextEditor (paste nhieu ky tu) khong bi mat do cellsTextEditor contract", () => {
  // Paste thong qua onCellPaste + onPasteApplied; onPasteApplied prop wired
  // toi onStagedPaste (cap nhat nhieu rows qua updateSpreadsheetRowCells).
  // Text editor onChange path rieng nhung cung ghi vao row.cells[column.key]
  // qua onRowChange.
  assert.match(grid, /const onCellPaste[\s\S]{0,4000}onPasteApplied\(/);
  // onStagedPaste merge vao row.cells (khong full replace).
  assert.match(live, /onStagedPaste[\s\S]{0,2000}updateSpreadsheetRowCells\(/);
  // Prop onPasteApplied duoc bind vao onStagedPaste.
  assert.match(live, /onPasteApplied=\{onStagedPaste\}/);
});

// ===== Group 4: H07 + H08 invariants (anti-regression) ====================

test("R1-19 H07 invariants: lazy validation, project fallback, row selection", () => {
  // Lazy validation (chi hien PASTE_VALUE_REQUIRED sau khi bam Save).
  assert.match(live, /stagedValidationForDisplay/);
  assert.match(live, /stagedValidationTriggered/);
  // Project fallback khi first_work_date rong.
  assert.match(live, /row\.firstWorkDate === ""\s*\?\s*fallbackCatalog/);
  // Row selection: rowClass highlight + click/keyboard cap nhat selected.
  assert.match(grid, /rowClass=\{\(row\) => row\.clientRowId === selectedClientRowId/);
  assert.match(grid, /onSelectedClientRowChange/);
  assert.match(grid, /onSelectedRowsChange=\{/);
  // cellsTextEditor van la editor.
  assert.match(grid, /renderEditCell:\s*cellsTextEditor/);
});

test("R1-20 H08 invariants: Hồ sơ NLĐ capability/view/upload, staged hint, no-permission hint", () => {
  // H08: canOpenWorkerDocuments = canViewDocs && selectedHasEntryId.
  assert.match(live, /const canOpenWorkerDocuments = canViewDocs && selectedHasEntryId/);
  // H08: entry_own HOAC entry_admin cho edit path.
  assert.match(live, /entry_own[\s\S]{0,200}\|\|[\s\S]{0,200}entry_admin/);
  // H08: staged hint "Lưu NLĐ để thêm hồ sơ".
  assert.match(live, /data-testid="contextual-staged-hint"/);
  assert.match(live, /Lưu NLĐ để thêm hồ sơ\./);
  // H08: no-permission hint khi thieu document_view.
  assert.match(live, /data-testid="contextual-no-permission-hint"/);
  assert.match(live, /Bạn không có quyền xem hồ sơ\./);
});

test("R1-21 Excel paste/import khong bi anh huong boi default place", () => {
  // Import path: parseWorkerProfilePaste => set cac field (gom national_id_issued_place neu user paste).
  // Dam bao import path khong bi factory overwrite.
  assert.match(live, /parseWorkerProfilePaste\(\{/);
  // onStagedPaste merge vao stagedModel (updateSpreadsheetRowCells MERGE).
  assert.match(live, /onStagedPaste[\s\S]{0,2000}updateSpreadsheetRowCells\(/);
  // XLSX import cung su dung parseWorkerProfilePaste path.
  assert.match(live, /workerProfileXlsxToTsv\(file\)/);
  assert.match(live, /parseWorkerProfilePaste\(/);
});

test("R1-22 dropdown/date editors khong dung cellsTextEditor (tai su dung commit truc tiep)", () => {
  // Dropdown (project/recruiter/labor_type/gender) render qua SelectCellEditor.
  const selectEditor = grid.match(/function SelectCellEditor[\s\S]{0,3500}\}/);
  assert.ok(selectEditor);
  // KHONG phai la cellsTextEditor; cellsTextEditor la input, SelectCellEditor la <select>.
  assert.match(selectEditor[0], /<select /);
  // SelectCellEditor co aria-label "Dự án" cho project dropdown.
  assert.match(selectEditor[0], /<select aria-label="Dự án"/);
  // Date editor render qua DateCellEditor (type="date").
  const dateEditor = grid.match(/function DateCellEditor[\s\S]{0,400}\}/);
  assert.ok(dateEditor);
  assert.match(dateEditor[0], /type="date"/);
  // cellsTextEditor la input rdg-text-editor (rieng biet).
  const cellsEditor = grid.match(/function cellsTextEditor[\s\S]{0,800}\}/);
  assert.ok(cellsEditor);
  assert.match(cellsEditor[0], /className="rdg-text-editor"/);
  // Quick editor dropdown: project select co aria-label "Dự án".
  assert.match(live, /<select aria-label="Dự án"/);
  // HRP/Vendor: provider dropdown trong SelectCellEditor co aria-label rieng.
  assert.match(selectEditor[0], /<select aria-label="HRP\/Vendor"/);
});

test("R1-23 blank spare rows van duoc maintain qua ensureSpreadsheetSpareRows (10 trailing)", () => {
  // ensureSpreadsheetSpareRows goi appendBlankRows (them default cells).
  // Dam bao so spare rows khong doi sau H08-R1.
  assert.match(rowModel, /SPREADSHEET_SPARE_ROW_COUNT = 10/);
  assert.match(rowModel, /ensureSpreadsheetSpareRows[\s\S]{0,600}appendBlankRows/);
  // Test: cap nhat 100 row full data, spare rows van co default + blank.
  // (Verified in spreadsheet-row-model.test.mjs R1-3 + replenish test.)
});

test("R1-24 quick editor field order giu nguyen (place luon render, defaults co san)", () => {
  // Quick editor phai render field national_id_issued_place (de user co the sua default).
  const quickStart = live.indexOf("Dialog.Content className={styles.quickDrawer}");
  assert.ok(quickStart > 0);
  const quickEnd = live.indexOf("</Dialog.Content>", quickStart);
  assert.ok(quickEnd > quickStart);
  const quickEditor = live.slice(quickStart, quickEnd);
  assert.match(quickEditor, /Nơi cấp/);
  // Mac dinh hien thi qua cells.national_id_issued_place (da co default tu row factory).
  assert.match(quickEditor, /target\.cells\.national_id_issued_place \?\? ""/);
  // Field first_work_date cung render.
  assert.match(quickEditor, /Ngày bắt đầu làm việc/);
  assert.match(quickEditor, /target\.cells\.first_work_date \?\? ""/);
});

test("R1-25 mobile staged card field order giu nguyen (place luon render, defaults co san)", () => {
  const mobileStaged = live.match(/styles\.mobileStagedCard[\s\S]{0,8000}<\/details>/);
  assert.ok(mobileStaged);
  assert.match(mobileStaged[0], /Nơi cấp/);
  assert.match(mobileStaged[0], /cells\.national_id_issued_place \?\? ""/);
  assert.match(mobileStaged[0], /Ngày bắt đầu làm việc/);
  assert.match(mobileStaged[0], /cells\.first_work_date \?\? ""/);
});
