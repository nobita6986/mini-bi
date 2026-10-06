/**
 * P1.7-H08-R1 — Entry defaults + text input regression.
 *
 * Group 1: default Ngày bắt đầu làm việc (GMT+7) + Nơi cấp (`Bộ Công An`).
 *   - Source chỉ define defaults 1 chỗ (spreadsheet-row-model.ts).
 *   - Live component dùng `createSpreadsheetRowModel()` (đã gồm defaults)
 *   - P3-W07C: defaultCells EMPTY (lazy). Activation chen defaults khi user
 *     tuong tac lan dau voi row (select, open quick editor, mobile details
 *     onToggle, edit cell, chon HRP/Vendor, paste/import).
 *   - Live component dung `createSpreadsheetRowModel()` (30 initial rows
 *     EMPTY, 10 added batch rows EMPTY, paste-pad) + activation contracts
 *     chen defaults khi can.
 *   - Quick editor + mobile staged card render `target.cells.first_work_date`
 *     va `target.cells.national_id_issued_place` (duoc activation khi mo).
 *   - User co the sua/xoa defaults; rerender KHONG ghi de lai (idempotent).
 *   - Khong dung `toISOString()` trong runtime (tranh lech UTC).
 *
 * Group 2: default-only row van la blank.
 *   - `spreadsheetRowIsBlank` da duoc nang cap de coi row chi chua 2 default
 *     la blank → khong tinh vao save batch, khong validate, khong gui server.
 *   - `selectNonEmptySpreadsheetRows` da dung predicate nay.
 *   - `buildSpreadsheetValidation` filter qua cung predicate.
 *   - P3-W07C-R1: activation chen defaults vao cell EMPTY; user/paste patch
 *     van thang (khong bi default overwrite).
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
  // P3-W07C: defaultCells() tra ve EMPTY (lazy); activation qua
  // activateSpreadsheetRowLazyDefaults se chen default khi row duoc kich hoat.
  assert.match(rowModel, /export function defaultCells\(\)/);
  assert.match(rowModel, /export function activateSpreadsheetRowLazyDefaults\(/);
});

test("R1-2 defaultCells tra ve EMPTY (lazy); activate chen default theo Asia/Ho_Chi_Minh", () => {
  // P3-W07C: defaultCells() tra ve EMPTY. Lazy activation chen default
  // (date theo Asia/Ho_Chi_Minh + place "Bộ Công An") qua
  // activateSpreadsheetRowLazyDefaults.
  assert.match(rowModel, /defaultCells[\s\S]{0,400}SPREADSHEET_WRITABLE_FIELD_KEYS\.map\(\(key\) => \[key, ""\]\)/);
  assert.match(rowModel, /activateSpreadsheetRowLazyDefaults[\s\S]{0,800}spreadsheetDefaultFirstWorkDate\(now\)/);
  assert.match(rowModel, /activateSpreadsheetRowLazyDefaults[\s\S]{0,800}DEFAULT_NATIONAL_ID_ISSUED_PLACE/);
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
  // Initial 30 rows: useState khoi tao qua factory (defaultCells EMPTY; lazy).
  assert.match(live, /useState<SpreadsheetRowModel>\(\(\) => createSpreadsheetRowModel\(\)\)/);
  // Sau khi save thanh cong, clear staged qua cung factory (batch moi EMPTY, lazy activate khi user tuong tac).
  assert.match(live, /setStagedModel\(createSpreadsheetRowModel\(\)\)/);
  // addStagedRows them 10 rows moi qua ensureSpreadsheetRowCount (appendBlankRows => defaultCells EMPTY).
  assert.match(live, /ensureSpreadsheetRowCount\(current, current\.rows\.length \+ ADD_STAGED_ROW_BATCH\)/);
  // addQuickStagedRow cung dung ensureSpreadsheetRowCount (cho append path) + activation truoc khi mo drawer.
  assert.match(live, /addQuickStagedRow[\s\S]{0,1500}ensureSpreadsheetRowCount/);
});

test("R1-5 quick editor (desktop drawer) render values tu target.cells (lazy defaults khi activated)", () => {
  // Quick editor desktop doc truc tiep target.cells.first_work_date
  // va target.cells.national_id_issued_place. Sau P3-W07C defaultCells EMPTY;
  // openQuickEditor activate row nen cells co defaults ngay khi mo drawer.
  // Dat ten nho de biet: `quickDrawer`.
  const quickStart = live.indexOf("Dialog.Content className={styles.quickDrawer}");
  assert.ok(quickStart > 0, "phai co Dialog.Content cho quick editor drawer");
  const quickEnd = live.indexOf("</Dialog.Content>", quickStart);
  assert.ok(quickEnd > quickStart);
  const quickEditor = live.slice(quickStart, quickEnd);
  assert.match(quickEditor, /target\.cells\.first_work_date \?\? ""/);
  assert.match(quickEditor, /target\.cells\.national_id_issued_place \?\? ""/);
});

test("R1-6 mobile staged card render values tu cells (lazy activation qua onToggle)", () => {
  // Mobile staged card cung render cells.first_work_date va cells.national_id_issued_place.
  // P3-W07C-R1: details.onToggle activate lazy defaults khi user mo card.
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
  // P3-W07C-R1: updateSpreadsheetRowCells activation truoc (chen defaults vao
  // cell EMPTY) roi apply patch (user/paste luon thang). Merge patch shape
  // van giu nguyen.
  assert.match(rowModel, /updateSpreadsheetRowCells[\s\S]{0,800}cells:\s*\{\s*\.\.\.\s*row\.cells,\s*\.\.\.\s*patch\s*\}/);
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
  assert.match(predicate[0], /spreadsheetDefaultFirstWorkDate\(now\)/);
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
  // P3-W06A Scope C: cellsTextEditor la wrapper; CellsTextEditorComponent moi
  // la noi doc/ghi. Test van pass neu wrapper uy quyen qua <CellsTextEditor>.
  // P3-W06A R1: wrapper cung forward rowIdx de trinh bien dich.
  const wrapper = grid.match(/function cellsTextEditor[\s\S]{0,600}\}/);
  assert.ok(wrapper, "phai co cellsTextEditor wrapper");
  assert.match(wrapper[0], /<CellsTextEditor\s+row=\{row\}[\s\S]{0,300}\/>/);
  // CellsTextEditorComponent chua contract doc/ghi row.cells.
  const component = grid.match(/function CellsTextEditorComponent[\s\S]{0,3500}\n\}/);
  assert.ok(component, "phai co CellsTextEditorComponent");
  // Doc cells.
  assert.match(component[0], /const \[value, setValue\] = useState\(\(\) => row\.cells\[column\.key\] \?\? ""\)/);
  // Ghi cells qua onRowChange (production can transition helper `commitTextCellValue`).
  assert.match(component[0], /onRowChange\([\s\S]{0,200}cells:\s*\{\s*\.\.\.\s*row\.cells/);
});

test("R1-14 cellsTextEditor KHONG commit/close sau moi onChange keystroke", () => {
  // P3-W06A: cellsTextEditor la wrapper; CellsTextEditorComponent commit logic.
  // Wrapper chi uy quyen (khong commit truc tiep).
  const wrapper = grid.match(/function cellsTextEditor[\s\S]{0,600}\}/);
  assert.ok(wrapper);
  // Wrapper chi render <CellsTextEditor/>, khong goi onRowChange truc tiep.
  assert.doesNotMatch(wrapper[0], /onRowChange\(/,
    "wrapper cellsTextEditor KHONG goi onRowChange truc tiep (de tranh double commit)");
  // CellsTextEditorComponent: commit() goi onRowChange voi commitChanges=false (mac dinh).
  const component = grid.match(/function CellsTextEditorComponent[\s\S]{0,3500}\n\}/);
  assert.ok(component);
  // P3-W06A R1: commit() goi commitTextCellValue(...) va truyen value vao cells.
  assert.match(component[0], /function commit\(nextValue: string\)/);
  assert.match(component[0], /commitComposition\(finalValue\)/);
  // Commit chi xay ra tren onBlur (onClose(true)).
  assert.match(component[0], /onBlur=\{\(\) => onClose\(true, false\)\}/);
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
  assert.match(selectEditor[0], /const commit = \(nextValue: string\) => \{[\s\S]{0,200}props\.onRowChange\([\s\S]{0,200},\s*true/);
});

test("R1-17 simulated multi-character Vietnamese input: cellsTextEditor contract persists string", () => {
  // Gia lap behavior cua editor: typing tung keystroke phai accumulate.
  // Day la structural test (khong render React): verify contract qua source.
  // P3-W06A: cellsTextEditor la wrapper; contract trong CellsTextEditorComponent.
  // P3-W06A R1: contract can them vi CellsTextEditorComponent dai hon (commit/composition).
  const component = grid.match(/function CellsTextEditorComponent[\s\S]{0,3500}\n\}/);
  assert.ok(component);
  // value doc tu row.cells => moi keystroke tiep theo doc duoc gia tri cu.
  assert.match(component[0], /value=\{value\}/);
  // commit() cap nhat cells va goi onRowChange (commitChanges=false).
  assert.match(component[0], /function commit\(nextValue: string\)/);
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
  // P3-W06A: cellsTextEditor la wrapper uy quyen; className "rdg-text-editor"
  // nam trong CellsTextEditorComponent. Test wrapper co khop <CellsTextEditor/>.
  const cellsEditor = grid.match(/function cellsTextEditor[\s\S]{0,600}\}/);
  assert.ok(cellsEditor);
  // P3-W06A R1: cellsTextEditor wrapper forward rowIdx de typecheck (RowIdx la
  // bat buoc cua CellsTextEditor memo). Pattern nay match ca rowIdx=4.
  assert.match(cellsEditor[0], /<CellsTextEditor\s+row=\{row\}[\s\S]{0,300}\/>/);
  // CellsTextEditorComponent van nhan className="rdg-text-editor".
  const component = grid.match(/function CellsTextEditorComponent[\s\S]{0,3500}\n\}/);
  assert.ok(component);
  assert.match(component[0], /className="rdg-text-editor"/);
  // Quick editor dropdown: project select co aria-label "Dự án".
  assert.match(live, /<select aria-label="Dự án"/);
  // HRP/Vendor: provider dropdown trong SelectCellEditor co aria-label rieng.
  assert.match(selectEditor[0], /<select aria-label="HRP\/Vendor"/);
});

test("R1-23 blank spare rows van duoc maintain qua ensureSpreadsheetSpareRows (10 trailing)", () => {
  // P3-W07C-R1: ensureSpreadsheetSpareRows goi appendBlankRows (them row
  // EMPTY, lazy). Spare rows luon EMPTY truoc khi user tuong tac.
  assert.match(rowModel, /SPREADSHEET_SPARE_ROW_COUNT = 10/);
  assert.match(rowModel, /ensureSpreadsheetSpareRows[\s\S]{0,600}appendBlankRows/);
  // (Verified in spreadsheet-row-model.test.mjs R1-3 + replenish test.)
});

test("R1-24 quick editor field order giu nguyen (place luon render, defaults activation)", () => {
  // Quick editor phai render field national_id_issued_place (de user co the sua default).
  const quickStart = live.indexOf("Dialog.Content className={styles.quickDrawer}");
  assert.ok(quickStart > 0);
  const quickEnd = live.indexOf("</Dialog.Content>", quickStart);
  assert.ok(quickEnd > quickStart);
  const quickEditor = live.slice(quickStart, quickEnd);
  assert.match(quickEditor, /Nơi cấp/);
  // P3-W07C: cells.national_id_issued_place hien thi (duoc activation khi
  // openQuickEditor; neu chua activation thi EMPTY + placeholder).
  assert.match(quickEditor, /target\.cells\.national_id_issued_place \?\? ""/);
  // Field first_work_date cung render.
  assert.match(quickEditor, /Ngày bắt đầu làm việc/);
  assert.match(quickEditor, /target\.cells\.first_work_date \?\? ""/);
});

test("R1-25 mobile staged card field order giu nguyen (place luon render, activation onToggle)", () => {
  const mobileStaged = live.match(/styles\.mobileStagedCard[\s\S]{0,8000}<\/details>/);
  assert.ok(mobileStaged);
  assert.match(mobileStaged[0], /Nơi cấp/);
  // P3-W07C-R1: cells.national_id_issued_place hien thi (activation qua
  // onToggle khi user mo details).
  assert.match(mobileStaged[0], /cells\.national_id_issued_place \?\? ""/);
  assert.match(mobileStaged[0], /Ngày bắt đầu làm việc/);
  assert.match(mobileStaged[0], /cells\.first_work_date \?\? ""/);
});
