/**
 * P3-W06A Scope C — Behavioral regression tests cho Direct Entry text cell.
 *
 * Acceptance (P3-W06A §Scope C):
 *  1. Continuous ASCII typing phai accumulate, ky tu cu khong bi mat.
 *  2. Vietnamese IME composition phai giu committed value cuoi cung.
 *  3. Gia tri ton tai sau re-render / blur / Enter / Tab.
 *  4. Editor KHONG remount/reselect o moi keystroke.
 *  5. Khong regress Excel paste, dropdown, date, row selection, delete row,
 *     staged/persisted rows.
 *
 * Test strategy:
 *  - Phan state transition (`applyTextCellKeystroke`, `applyTextCellCompositionEnd`,
 *    `simulateAsciiKeystrokes`, `simulateVietnameseIme`) test thuan o day.
 *  - Phan DOM/React effect (focus/select 1 lan) test qua source-string + contract
 *    trong `direct-entry-h08-r1-defaults-text-regression.test.mjs` da co.
 *    Bo sung them cac invariant ve useRef + useEffect (empty deps) va
 *    onCompositionStart/End, MEMO de tranh remount.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  applyTextCellKeystroke,
  applyTextCellCompositionEnd,
  simulateAsciiKeystrokes,
  simulateVietnameseIme,
} from "./text-cell-state.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRID = join(HERE, "direct-entry-spreadsheet-grid.tsx");

// ===== Group 1: pure state-transition contract ===========================

test("R1-S1 applyTextCellKeystroke chen ky tu vao cuoi (append)", () => {
  const result = applyTextCellKeystroke({
    currentValue: "",
    selectionStart: 0,
    selectionEnd: 0,
    key: "A",
    columnKey: "display_name",
  });
  assert.equal(result.value, "A");
  assert.deepEqual(result.patch, { display_name: "A" });
});

test("R1-S2 simulateAsciiKeystrokes 'Nguyen' accumulate dung tu dau den cuoi", () => {
  const result = simulateAsciiKeystrokes({
    initialValue: "",
    keys: ["N", "g", "u", "y", "e", "n"],
    columnKey: "display_name",
  });
  assert.equal(result.finalValue, "Nguyen");
  // Tung keystroke phai sinh intermediate value dung (khong re-select lam mat).
  assert.deepEqual(result.intermediateValues, [
    "",
    "N",
    "Ng",
    "Ngu",
    "Nguy",
    "Nguye",
    "Nguyen",
  ]);
  // Patch cuoi cung phai la gia tri accumulated.
  assert.equal(result.patches[5]?.display_name, "Nguyen");
});

test("R1-S3 simulateAsciiKeystrokes ky tu lien tiep khong bi thay the boi ky tu truoc", () => {
  // Day la behavior bug truoc day: keystroke thu 2 se replace keystroke thu 1
  // do select-all sau re-render. Sau fix, tung keystroke chi append.
  const result = simulateAsciiKeystrokes({
    initialValue: "",
    keys: ["A", "B", "C", "D", "E"],
    columnKey: "x",
  });
  assert.equal(result.finalValue, "ABCDE");
  // 4 patch dau KHONG duoc bang "" (ky tu cu bi xoa).
  for (let index = 1; index < 5; index += 1) {
    assert.notEqual(result.patches[index]?.x, "",
      `keystroke ${index} khong duoc rong gia tri (ky tu cu khong bi mat)`);
  }
});

test("R1-S4 simulateVietnameseIme committed value 'tiếng' giu nguyen, khong bi ghi de boi pre-edit", () => {
  // Composition: user go "tie" → trinh duyet hien thi "t", "ti", "tie" qua cac
  // compositionupdate → compositionend voi "tiếng" (co dau).
  // Editor phai:
  //   - Hien thi pre-edit qua local state (cho user thay ro feedback).
  //   - Commit "tiếng" vao row.cells[column.key] MOT LAN o compositionend.
  //   - KHONG commit "t", "ti", "tie" vao row (se bi patch qua nhau).
  const result = simulateVietnameseIme({
    initialValue: "",
    preEditFragments: ["t", "ti", "tie"],
    finalCommitted: "tiếng",
    columnKey: "display_name",
  });
  assert.equal(result.finalValue, "tiếng");
  // Gia tri committed phai chua cac ky tu co dau (đặc biệt "ế").
  assert.ok(result.finalValue.includes("ế"), "Vietnamese committed value phai giu ky tu co dau");
});

test("R1-S5 applyTextCellCompositionEnd: empty committed → giu nguyen current value (cancel)", () => {
  // User nhan ESC de cancel composition → committedValue rong → editor giu current.
  const result = applyTextCellCompositionEnd({
    currentValue: "partial",
    committedValue: "",
    columnKey: "x",
  });
  assert.equal(result.value, "partial");
  assert.deepEqual(result.patch, { x: "partial" });
});

test("R1-S6 applyTextCellKeystroke thay the selection range", () => {
  // User select "abc" roi go "X" → "X" thay the "abc".
  const result = applyTextCellKeystroke({
    currentValue: "abcdef",
    selectionStart: 0,
    selectionEnd: 3,
    key: "X",
    columnKey: "x",
  });
  assert.equal(result.value, "Xdef");
});

test("R1-S7 applyTextCellKeystroke clamp selection ngoai pham vi", () => {
  // Phong trường hop DOM tra ve selectionStart/End > length (race condition khi
  // gia tri ngan di sau keystroke truoc). Editor phai khong crash.
  const result = applyTextCellKeystroke({
    currentValue: "abc",
    selectionStart: 10,
    selectionEnd: 20,
    key: "Z",
    columnKey: "x",
  });
  assert.equal(result.value, "abcZ");
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
