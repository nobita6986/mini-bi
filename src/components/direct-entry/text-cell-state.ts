/**
 * P3-W06A R1 — Pure state-transition helpers cho Direct Entry text cell editor.
 *
 * Muc tieu:
 * - Tach phan "nhan keystroke + composition end + sinh next row/patch" ra khoi
 *   React render, de:
 *     (a) production component (CellsTextEditorComponent) goi cung helper
 *         (khong con duplicate inline logic);
 *     (b) tests co the goi cung helper de xac minh contract production
 *         di theo (khong con tinh trang helper mo phong bi tach roi).
 * - Ham thuan, deterministic, khong phu thuoc React, ref, focus hay DOM.
 *
 * Production bug (P1.7-RESIDUAL-TEXT-CELL_SINGLE_CHARACTER_INPUT):
 * - Editor truoc su dung `ref={(node) => { if (node) { node.focus(); node.select(); } }}`
 *   voi arrow function inline. Moi React re-render (do `onChange` → `onRowChange`)
 *   se unmount + remount ref callback → goi lai `node.select()` → highlight toan
 *   bo text → keystroke tiep theo thay the toan bo, chi thay 1 ky tu.
 * - Fix o `cellsTextEditor` (cellsTextEditor.tsx) dung `useRef` + `useEffect` de
 *   focus + select CHI 1 LAN khi mount; subsequent re-render giu nguyen DOM
 *   node + focus/selection.
 *
 * `commitTextCellValue` va `commitTextCellCompositionEnd` la contract thuc su
 * ma `CellsTextEditorComponent` goi (khong con helper mo phong tach roi).
 */

export type SpreadsheetRowLike = {
  cells: Readonly<Record<string, string>>;
};

export type TextCellCommit = {
  /** Gia tri moi se dat vao `row.cells[columnKey]` (de UI cap nhat local state). */
  value: string;
  /** Row moi voi `cells[columnKey]` da duoc merge full value. */
  nextRow: SpreadsheetRowLike;
  /** Patch chi chua `columnKey` (de parent dua len orchestrator). */
  patch: Readonly<Record<string, string>>;
};

/**
 * Merge mot full value vao `row.cells[columnKey]`, giu nguyen cac field khac.
 *
 * Day la buoc chuyen tiep chuan ma CellsTextEditorComponent goi khi user
 * nhap mot keystroke (ASCII) don le hoac khi editor commit gia tri cuoi
 * cung (blur/Enter/Tab) ma khong qua IME composition.
 *
 * Contract:
 * - `nextRow.cells[columnKey] === value` (full value, khong phai delta).
 * - `patch` chi chua `columnKey` (parent co the dua len orchestrator
 *   de merge vao row model goc ma khong mat thong tin field khac).
 * - Ham thuan: cung input luon cho cung output.
 */
export function commitTextCellValue(input: {
  row: SpreadsheetRowLike;
  value: string;
  columnKey: string;
}): TextCellCommit {
  const { row, value, columnKey } = input;
  const nextRow: SpreadsheetRowLike = {
    ...row,
    cells: { ...row.cells, [columnKey]: value },
  };
  return {
    value,
    nextRow,
    patch: { [columnKey]: value },
  };
}

/**
 * Composition end (IME) transition: thay the toan bo current value bang
 * committed value cuoi cung.
 *
 * Day la buoc chuyen tiep ma CellsTextEditorComponent goi khi `onCompositionEnd`
 * xay ra. Composition semantics: cac composing char trung gian (pre-edit) duoc
 * browser hien thi trong input, nhung gia tri committed cuoi cung moi la
 * quyet dinh text cuoi cung. Editor KHONG commit pre-edit vao row de tranh
 * ghi de lan nhau.
 *
 * Contract:
 * - Neu `committedValue` rong (user cancel composition, e.g. Esc), giu nguyen
 *   `row.cells[columnKey]`.
 * - Neu khong rong, replace full value va commit vao `row.cells[columnKey]`.
 */
export function commitTextCellCompositionEnd(input: {
  row: SpreadsheetRowLike;
  committedValue: string;
  columnKey: string;
}): TextCellCommit {
  const { row, committedValue, columnKey } = input;
  if (committedValue === "") {
    return {
      value: row.cells[columnKey] ?? "",
      nextRow: row,
      patch: { [columnKey]: row.cells[columnKey] ?? "" },
    };
  }
  return commitTextCellValue({ row, value: committedValue, columnKey });
}
