/**
 * P1.7-H07 - Regression cho 5 nhom fix:
 *   A. Session startup: bounded retry wrapper + su dung trong direct-entry/dashboard
 *   B. Project dropdown: mo truoc first_work_date, re-resolve khi nhap ngay
 *   C. Required validation: chi hien sau khi user bam "Lưu cac dong hop le"
 *   D. Cell editor contract: cellsTextEditor commit vao row.cells[column.key]
 *   E. Row selection: click/keyboard cap nhat selectedClientRowId; row highlight
 *
 * Tap trung vao (1) logic test cho source code (regex/source string checks)
 * va (2) cac test thuat cho helper. Day la regression test "structural",
 * giong H03/H05/H06: khong render React tree, ma kiem tra source pattern
 * de dam bao fix duoc giu qua cac refactor tiep theo.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const LIVE = join(ROOT, "src/components/direct-entry/direct-entry-live.tsx");
const GRID = join(ROOT, "src/components/direct-entry/direct-entry-spreadsheet-grid.tsx");
const DE_PAGE = join(ROOT, "src/app/direct-entry/page.tsx");
const DASH_PAGE = join(ROOT, "src/app/dashboard/page.tsx");

const live = readFileSync(LIVE, "utf8");
const grid = readFileSync(GRID, "utf8");
const dePage = readFileSync(DE_PAGE, "utf8");
const dashPage = readFileSync(DASH_PAGE, "utf8");

// --- A. Session startup bounded retry -----------------------------------

test("A1. /direct-entry va /dashboard su dung resolveSessionWithBoundedRetry (A.6: bounded retry)", () => {
  assert.match(dePage, /resolveSessionWithBoundedRetry/);
  assert.match(dePage, /getDirectEntryActor/);
  assert.match(dashPage, /resolveSessionWithBoundedRetry/);
  assert.match(dashPage, /getDirectEntryActor/);
});

test("A2. /direct-entry va /dashboard van catch throw va fallback null de khong crash SSR", () => {
  // P3-W06A R1: page goi `resolveActorForRequest().catch(() => null)` (Promise
  // chain) thay vi try/catch vi resolver wrap boi React cache va goi tu RSC.
  // Catch handler phai fallback `null` de khong crash SSR.
  assert.match(dePage, /resolveActorForRequest\(\)\.catch\(\(\) => null\)/);
  assert.match(dashPage, /resolveActorForRequest\(\)\.catch\(\(\) => null\)/);
});

test("A3. resolveSessionWithBoundedRetry retry toi da 2 lan va co delay bounded (khong polling vo han)", async () => {
  const mod = await import("../../lib/auth/direct-entry-session-retry.ts");
  let calls = 0;
  await assert.rejects(async () => {
    await mod.resolveSessionWithBoundedRetry(async () => {
      calls += 1;
      throw new Error("nope");
    });
  });
  assert.equal(calls, 2, "phai dung o 2 lan goi (1 lan dau + 1 retry)");
});

// --- B. Project dropdown before first_work_date ------------------------

test("B1. Desktop quick editor: project select khong disable khi firstWorkDate rong", () => {
  // P3-W07C-R6: selectedRowCatalog la catalog HIEN TAI, khong phu thuoc firstWorkDate.
  assert.match(live, /const selectedRowCatalog = selectedRow \? defaultCatalog : null;/);
  assert.equal(/catalogFor\(selectedRow\.firstWorkDate\)/.test(live), false,
    "Khong con dung catalogFor(selectedRow.firstWorkDate)");
  assert.equal(/selectedRow\.firstWorkDate === ""/.test(live), false,
    "Khong con nhanh theo ngay cua dong");
  assert.match(live, /selectedRowCatalog\?\.projects\.map/);
});

test("B2. Spreadsheet row: catalogOptions dung catalog hien tai, khong theo ngay", () => {
  // P3-W07C-R6: bo hoan toan nhanh fallback tam roi thay bang catalog theo ngay.
  assert.match(live, /catalogOptions: spreadsheetCatalogOptions\(fallbackCatalog \?\? undefined\)/);
  assert.match(live, /const fallbackCatalog = currentCatalog;/);
  assert.equal(/catalogs\[dateKey\]/.test(live), false, "khong con tra catalog theo ngay cua dong");
});

test("B3. SelectCellEditor project_id khong con hien thi 'Nhập ngày bắt đầu trước' khi date rong", () => {
  assert.equal(/Nhập ngày bắt đầu trước/.test(grid), false,
    "Khong con dong 'Nhập ngày bắt đầu trước' trong grid editor (B: dropdown mo truoc)");
  assert.match(grid, /<select aria-label="Dự án"/);
});

// --- C. Required validation only after save attempt --------------------

test("C1. stagedValidationForDisplay loc PASTE_VALUE_REQUIRED khi chua triggered", () => {
  assert.match(live, /stagedValidationForDisplay/);
  assert.match(live, /stagedValidationTriggered/);
  assert.match(live, /issue\.code !== "PASTE_VALUE_REQUIRED"/);
  assert.match(live, /setStagedValidationTriggered\(true\)/);
});

test("C2. Save button khong con disable theo canSave; user luon click duoc", () => {
  assert.match(live, /disabled=\{loadState !== "ready" \|\| stagedBusy\}/);
  // C.3: chi rieng disabled prop cua nut save, khong phai save logic ben trong
  // (save logic van dung canSave de quyet-mong-bao-loi-sau-khi-bam).
  assert.equal(/disabled=\{[^}]*stagedValidation\.canSave[^}]*\}/.test(live), false,
    "Khong con dieu kien stagedValidation.canSave trong disabled cua nut save (C.3: enable nut de kich hoat validation)");
});

test("C3. onStagedSave goi setStagedValidationTriggered(true) truoc khi validate", () => {
  assert.match(live, /setStagedValidationTriggered\(true\);\s*const preview = stagedValidation\.preview/);
});

test("C4. onQuickSaveRow goi setQuickValidationTriggeredFor(clientRowId) truoc khi validate", () => {
  assert.match(live, /setQuickValidationTriggeredFor\(clientRowId\);/);
  // Quick editor hien thi required errors cua row dang mo sau khi triggered.
  assert.match(live, /quickValidationTriggeredFor === target\.clientRowId/);
  assert.match(live, /quickErrorList/);
});

test("C5. setStagedValidationTriggered duoc reset sau khi save thanh cong", () => {
  assert.match(live, /setStagedModel\(createSpreadsheetRowModel\(\)\);\s*setStagedValidationTriggered\(false\)/);
});

test("C6. setQuickValidationTriggeredFor duoc reset sau khi quick save thanh cong", () => {
  assert.match(live, /setQuickEditClientRowId\(null\);\s*setQuickValidationTriggeredFor\(null\)/);
});

// --- D. Cell editor contract ---------------------------------------------

test("D1. cellsTextEditor doc/ghi row.cells[column.key] (khong phai row[column.key])", () => {
  assert.match(grid, /function cellsTextEditor/);
  assert.match(grid, /row\.cells\[column\.key\]/);
  // Mac dinh renderTextEditor doc row[column.key] => gia tri typed bien mat.
  // Fix dam bao editor commit vao staged model qua `cells[column.key]`.
  assert.match(grid, /onRowChange\(\{[\s\S]*cells:\s*\{\s*\.\.\.\s*row\.cells/);
});

test("D2. cellsTextEditor commit khi blur (onClose(true))", () => {
  assert.match(grid, /onBlur=\{\(\) => onClose\(true, false\)\}/);
});

test("D3. Column build cho data cells editable dung cellsTextEditor (khong phai renderTextEditor)", () => {
  // Phan renderEditCell cua data text cell phai tham chieu cellsTextEditor.
  assert.match(grid, /renderEditCell:\s*cellsTextEditor/);
  // Khong con import renderTextEditor (P1.7-H07 chuyen sang cellsTextEditor).
  assert.equal(/import\s*\{[^}]*renderTextEditor[^}]*\}\s*from\s*"react-data-grid"/.test(grid), false,
    "Khong con import renderTextEditor tu react-data-grid (D1: chuyen sang cellsTextEditor)");
});

test("D4. Date va Select cell editor van commit truc tiep (khong qua cellsTextEditor)", () => {
  // P3-W07C-R6: date editor dung DdmmDateInput (text DD/MM/YYYY) va commit qua onCommit.
  assert.match(grid, /DateCellEditor[\s\S]{0,400}<DdmmDateInput/);
  assert.match(grid, /onCommit=\{\(iso\) => props\.onRowChange\(/);
  // Select editor: providerType/value commit directly through the commit() helper.
  assert.match(grid, /const commit = \(nextValue: string\) => \{[\s\S]{0,120}props\.onRowChange\(/);
});

// --- E. Row selection ---------------------------------------------------

test("E1. onCellClick cap nhat selectedClientRowId tu clicked cell row (E.1)", () => {
  assert.match(grid, /const onCellClick = useCallback/);
  assert.match(grid, /onCellClick=\{onCellClick\}/);
  assert.match(grid, /onSelectedClientRowChange\(args\.row\.clientRowId\)/);
});

test("E2. onCellKeyDown cap nhat selectedClientRowId khi arrow/Tab/Enter (E.2)", () => {
  assert.match(grid, /ArrowUp.*ArrowDown.*ArrowLeft.*ArrowRight/);
  assert.match(grid, /navigationKeys\.has\(event\.key\)/);
  assert.match(grid, /onSelectedClientRowChange\(args\.row\.clientRowId\)/);
});

test("E3. DataGrid co rowClass de highlight row duoc chon (E.4)", () => {
  assert.match(grid, /rowClass=/);
  assert.match(grid, /row\.clientRowId === selectedClientRowId/);
});

test("E4. Contextual bar hien thi 'Đang chọn dòng STT {n}' thay vi ten nhan vien (E.5)", () => {
  assert.match(live, /Đang chọn dòng STT/);
  assert.equal(/Đang chọn:/.test(live), false,
    "Khong con text cu 'Đang chọn:' ma phai dung 'Đang chọn dòng STT' (E.5)");
});

test("E5. Staged row action bar nut Xóa dòng goi onStagedDelete voi clientRowId (E.6)", () => {
  // Existing H06 test da assert nut Xoa chi thao tac tren staged row.
  // H07: dam bao action Xoa van ton tai va nhan dung clientRowId.
  assert.match(live, /Xóa dòng/);
  assert.match(live, /onStagedDelete\(selected\.clientRowId\)/);
  assert.match(live, /onStagedDelete\(target\.clientRowId\)/);
});

test("E6. Persisted row action nut 'Hồ sơ NLĐ' mo dialog voi entry_id tu row (E.7)", () => {
  assert.match(live, /Hồ sơ NLĐ/);
  assert.match(live, /setDocumentsRowId\(persisted\.rowId\)/);
});
