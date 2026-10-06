/**
 * P3-W06A Scope C + R1 — Behavioral regression tests cho Direct Entry text cell.
 *
 * Acceptance (P3-W06A §Scope C):
 *  1. Continuous ASCII typing phai accumulate, ky tu cu khong bi mat.
 *  2. Vietnamese IME composition phai giu committed value cuoi cung.
 *  3. Gia tri ton tai sau re-render / blur / Enter / Tab.
 *  4. Editor KHONG remount/reselect o moi keystroke.
 *  5. Khong regress Excel paste, dropdown, date, row selection, delete row,
 *     staged/persisted rows.
 *
 * P3-W06A R1 (Gap 3):
 *  - Helpers `commitTextCellValue` / `commitTextCellCompositionEnd` duoc
 *    CellsTextEditorComponent that su goi (khong con helper mo phong tach
 *    roi). Test suite nay goi CUNG helper do de xac minh production di
 *    theo cung contract. Test chuoi "" → "N" → "Ng" → "Ngu" → "Nguyễn"
 *    thong qua cac lan goi helper lien tiep, moi lan `row` input la row
 *    accumulated tu lan goi truoc (giong production: onRowChange nhan row
 *    moi lam input cho lan keystroke tiep theo).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  commitTextCellValue,
  commitTextCellCompositionEnd,
} from "./text-cell-state.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRID = join(HERE, "direct-entry-spreadsheet-grid.tsx");
const LIVE = join(HERE, "direct-entry-live.tsx");
const COLUMNS = join(HERE, "..", "..", "lib", "direct-entry", "direct-entry-grid-columns.ts");

/** @type {{ cells: Readonly<Record<string, string>> }} */
const EMPTY_ROW = { cells: {} };

// ===== Group 1: pure state-transition contract (CUNG helper production) ===

test("R1-S1 commitTextCellValue: chen ky tu vao o trong row trong (append)", () => {
  const transition = commitTextCellValue({
    row: EMPTY_ROW,
    value: "A",
    columnKey: "display_name",
  });
  assert.equal(transition.value, "A");
  assert.equal(transition.nextRow.cells.display_name, "A");
  assert.deepEqual(transition.patch, { display_name: "A" });
});

test("R1-S2 chuoi lien tiep '' -> 'N' -> 'Ng' -> 'Ngu' -> 'Nguyễn' giu full value", () => {
  // Production: moi keystroke goi commitTextCellValue(row_accumulated, value)
  // voi row_accumulated tu lan onRowChange truoc. Test mo phong cung flow.
  // Moi "value" la full value cua cell sau khi go (giong input HTML chinh
  // xac, do browser dang controlled <input value={accumulatedValue}>).
  /** @type {{ cells: Readonly<Record<string, string>> }} */
  let row = EMPTY_ROW;
  const sequence = ["", "N", "Ng", "Ngu", "Nguy", "Nguyễn"];
  const fullValues = ["N", "Ng", "Ngu", "Nguy", "Nguyễn"];
  const accumulated = [""];
  for (const value of fullValues) {
    const transition = commitTextCellValue({ row, value, columnKey: "display_name" });
    row = transition.nextRow;
    accumulated.push(transition.value);
  }
  // Tung intermediate value phai giu full ky tu truoc (accumulate, khong re-select lam mat).
  assert.deepEqual(accumulated, sequence);
  // Row.cells phai chua full value cuoi cung.
  assert.equal(row.cells.display_name, "Nguyễn");
});

test("R1-S3 cac patch trong chuoi lien tiep KHONG rong (ky tu cu khong bi mat)", () => {
  // Production: moi keystroke goi commitTextCellValue(row_accumulated, value)
  // voi value = full value cua input. Row.cells phai accumulate, khong bao gio
  // reset.
  /** @type {{ cells: Readonly<Record<string, string>> }} */
  let row = EMPTY_ROW;
  const fullValues = ["A", "AB", "ABC", "ABCD", "ABCDE"];
  for (const value of fullValues) {
    const transition = commitTextCellValue({ row, value, columnKey: "x" });
    row = transition.nextRow;
  }
  // Row.cells phai chua full "ABCDE".
  assert.equal(row.cells.x, "ABCDE");
});

test("R1-S4 commitTextCellCompositionEnd: full committed 'tiếng' ghi vao row, khong ghi de boi pre-edit", () => {
  // Production: compositionend goi commitTextCellCompositionEnd voi full
  // committed value. Pre-edit chi hien thi qua local UI state, KHONG commit
  // vao row (CellsTextEditorComponent da check isComposingRef).
  // Test verify: commit composition "tiếng" → row.cells.display_name === "tiếng".
  /** @type {{ cells: Readonly<Record<string, string>> }} */
  let row = EMPTY_ROW;
  const transition = commitTextCellCompositionEnd({
    row,
    committedValue: "tiếng",
    columnKey: "display_name",
  });
  row = transition.nextRow;
  assert.equal(row.cells.display_name, "tiếng");
  assert.ok(row.cells.display_name.includes("ế"), "Vietnamese committed value phai giu ky tu co dau");
});

test("R1-S5 commitTextCellCompositionEnd: empty committed → giu nguyen current value (cancel)", () => {
  // User nhan ESC de cancel composition → committedValue rong → editor giu current.
  const row = { cells: { x: "partial" } };
  const transition = commitTextCellCompositionEnd({
    row,
    committedValue: "",
    columnKey: "x",
  });
  assert.equal(transition.value, "partial");
  assert.equal(transition.nextRow.cells.x, "partial");
  assert.deepEqual(transition.patch, { x: "partial" });
});

test("R1-S6 commitTextCellValue: ghi de full value, khong ghi de field khac", () => {
  const row = { cells: { display_name: "old", cccd: "079123456789" } };
  const transition = commitTextCellValue({
    row,
    value: "new name",
    columnKey: "display_name",
  });
  // CCCD field phai con nguyen, chi display_name thay doi.
  assert.equal(transition.nextRow.cells.display_name, "new name");
  assert.equal(transition.nextRow.cells.cccd, "079123456789");
  assert.deepEqual(transition.patch, { display_name: "new name" });
});

// ===== Group 2: structural invariants (anti-regression) ===================

test("R2-S1 grid KHONG con su dung callback ref inline de focus/select (P3-W06A Scope C fix)", () => {
  // Bug goc: `ref={(node) => { if (node) { node.focus(); node.select(); } }}`
  // voi arrow function inline. Moi re-render se re-mount ref → re-select.
  // Sau fix: dung useRef + useEffect (empty deps).
  const source = readFileSync(GRID, "utf8");
  // Chan ref callback inline co focus/select ben trong (tru trong comment).
  const codeLines = source.split("\n").filter((line) => !/^\s*(\*|\/\/)/.test(line));
  const codeOnly = codeLines.join("\n");
  // Phat hien pattern ref={...} ma body chua focus+select.
  const refCallbackWithSelect = /ref=\{[\s\S]{0,200}node\.select\(\)[\s\S]{0,40}\}/.test(codeOnly);
  assert.equal(refCallbackWithSelect, false,
    "grid khong duoc co callback ref inline goi node.select() (se remount moi render)");
});

test("R2-S2 grid dung useRef + useEffect (empty deps) cho focus/select 1 lan", () => {
  const source = readFileSync(GRID, "utf8");
  // Phai co useRef va useEffect, va useEffect phai co empty deps array.
  assert.match(source, /useRef<HTMLInputElement>/);
  // useEffect voi empty deps de focus/select 1 lan.
  const focusEffect = source.match(/useEffect\(\(\) => \{[\s\S]{0,200}node\.focus\(\)[\s\S]{0,200}\},\s*\[\]\)/);
  assert.ok(focusEffect, "phai co useEffect voi empty deps de focus+select 1 lan");
});

test("R2-S3 grid co onCompositionStart/End de xu ly Vietnamese IME", () => {
  const source = readFileSync(GRID, "utf8");
  assert.match(source, /onCompositionStart=/);
  assert.match(source, /onCompositionEnd=/);
  // Editor co isComposingRef de tranh commit giua composition.
  assert.match(source, /isComposingRef/);
});

test("R2-S4 grid memo hoa CellsTextEditor de tranh remount khi row tham chieu thay doi", () => {
  const source = readFileSync(GRID, "utf8");
  assert.match(source, /import\s*\{[^}]*\bmemo\b[^}]*\}\s*from\s*["']react["']/);
  assert.match(source, /memo\(CellsTextEditorComponent\)/);
  // cellsTextEditor (wrapper) van duoc dung lam renderEditCell de tranh pha contract.
  assert.match(source, /renderEditCell:\s*cellsTextEditor/);
});

test("R2-S5 Excel paste/dropdown/date editor khong bi anh huong (P1.7-H07 contract giu nguyen)", () => {
  const source = readFileSync(GRID, "utf8");
  // Dropdown van di qua SelectCellEditor (khong phai CellsTextEditor).
  assert.match(source, /function SelectCellEditor/);
  assert.match(source, /<select aria-label="Dự án"/);
  // Date van di qua DateCellEditor.
  assert.match(source, /function DateCellEditor/);
  assert.match(source, /type="date"/);
  // Excel paste van con onCellPaste.
  assert.match(source, /const onCellPaste/);
  assert.match(source, /onPasteApplied\(/);
});

test("R2-S6 onBlur van commit (onClose(true, false)) - khong mat value khi blur/Enter/Tab", () => {
  const source = readFileSync(GRID, "utf8");
  assert.match(source, /onBlur=\{\(\) => onClose\(true, false\)\}/);
});

test("R2-S7 production component thuc su goi helper (khong con logic inline)", () => {
  // Dam bao CellsTextEditorComponent import va goi commitTextCellValue /
  // commitTextCellCompositionEnd tu text-cell-state.ts (khong con duplicate).
  const source = readFileSync(GRID, "utf8");
  assert.match(source, /from\s+["']@\/components\/direct-entry\/text-cell-state["']/);
  assert.match(source, /commitTextCellValue\(/);
  assert.match(source, /commitTextCellCompositionEnd\(/);
});

// ===== P3-W07C-R1: editor dateText (DD/MM/YYYY text input) =================

test("R2-T1 grid registry co editor type 'dateText' cho date_of_birth va national_id_issued_at", () => {
  // P3-W07C-R1: doi tu native date picker sang text input DD/MM/YYYY.
  // 2 cot nay dung `editor: "dateText"` thay cho `editor: "date"`.
  // first_work_date van giu `editor: "date"` (native picker).
  const columns = readFileSync(COLUMNS, "utf8");
  assert.match(columns, /fieldColumn\("date_of_birth"[\s\S]{0,400}editor:\s*"dateText"/);
  assert.match(columns, /fieldColumn\("national_id_issued_at"[\s\S]{0,400}editor:\s*"dateText"/);
  // first_work_date khong doi (van `editor: "date"`).
  const firstWorkDate = columns.match(/fieldColumn\("first_work_date"[\s\S]{0,300}\}\)/);
  assert.ok(firstWorkDate);
  assert.match(firstWorkDate[0], /editor:\s*"date"/);
});

test("R2-T2 grid dang ky CellsDateTextEditor va renderEditCell dat vao dateText column", () => {
  const source = readFileSync(GRID, "utf8");
  // Component helper + memo wrapper.
  assert.match(source, /function CellsDateTextEditorComponent/);
  assert.match(source, /const CellsDateTextEditor = memo\(CellsDateTextEditorComponent\)/);
  assert.match(source, /function cellsDateTextEditor/);
  // Editor: text input voi placeholder DD/MM/YYYY.
  const component = source.match(/function CellsDateTextEditorComponent[\s\S]{0,3500}\n\}/);
  assert.ok(component, "phai co CellsDateTextEditorComponent body");
  assert.match(component[0], /type="text"/);
  assert.match(component[0], /placeholder="DD\/MM\/YYYY"/);
  assert.match(component[0], /inputMode="numeric"/);
  // Commit: parse DD/MM/YYYY -> ISO va goi onRowChange.
  assert.match(component[0], /parseDDMMToIso\(nextValue\)/);
  // Column routing: `editor: "dateText"` di qua cellsDateTextEditor.
  assert.match(source, /column\.editor === "dateText"[\s\S]{0,500}renderEditCell: cellsDateTextEditor/);
  // Closed-cell display: cung DD/MM/YYYY format nhu `date`.
  assert.match(source, /column\.editor === "date" \|\| column\.editor === "dateText"/);
});

test("R2-T3 mobile staged card: Ngày sinh va Ngày cấp la text input DD/MM/YYYY", () => {
  // P3-W07C-R1: chuyen type=date sang type=text voi placeholder DD/MM/YYYY.
  // Source khoa cung hien thi (formatDateToDDMM) va parser (parseDDMMToIso)
  // trong onMobileStagedChange.
  const live = readFileSync(LIVE, "utf8");
  // Khong con type="date" cho date_of_birth hay national_id_issued_at.
  assert.doesNotMatch(live,
    /type="date"[\s\S]{0,200}value=\{cells\.date_of_birth\??\s*\?\?\s*""/);
  assert.doesNotMatch(live,
    /type="date"[\s\S]{0,200}value=\{cells\.national_id_issued_at\??\s*\?\?\s*""/);
  assert.doesNotMatch(live,
    /type="date"[\s\S]{0,200}value=\{target\.cells\.date_of_birth\??\s*\?\?\s*""/);
  assert.doesNotMatch(live,
    /type="date"[\s\S]{0,200}value=\{target\.cells\.national_id_issued_at\??\s*\?\?\s*""/);
  // text input voi placeholder DD/MM/YYYY va hien thi formatDateToDDMM.
  assert.match(live,
    /type="text"[\s\S]{0,200}placeholder="DD\/MM\/YYYY"[\s\S]{0,200}value=\{formatDateToDDMM\(cells\.date_of_birth/);
  assert.match(live,
    /type="text"[\s\S]{0,200}placeholder="DD\/MM\/YYYY"[\s\S]{0,200}value=\{formatDateToDDMM\(cells\.national_id_issued_at/);
  // onMobileStagedChange parse DD/MM/YYYY -> ISO truoc khi luu.
  assert.match(live,
    /onMobileStagedChange = useCallback\(\([\s\S]{0,800}parseDDMMToIso\(value\)[\s\S]{0,800}updateSpreadsheetRowCells\(/);
});