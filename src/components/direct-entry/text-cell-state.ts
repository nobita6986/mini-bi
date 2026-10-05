/**
 * P3-W06A — Pure state-transition cho Direct Entry text cell editor.
 *
 * Mục đích:
 * - Tách phần "nhận keystroke + sinh patch" ra khỏi React render để có thể
 *   test hành vi bằng `node:test` (không cần jsdom/happy-dom).
 * - Hàm thuần, deterministic, không phụ thuộc React, ref, focus hay DOM.
 *
 * Production bug (P1.7-RESIDUAL-TEXT-CELL_SINGLE_CHARACTER_INPUT):
 * - Editor trước đây dùng `ref={(node) => { if (node) { node.focus(); node.select(); } }}`
 *   với arrow function inline. Mỗi lần React re-render (do `onChange` → `onRowChange`),
 *   React unmount + remount ref callback → gọi lại `node.select()` → highlight toàn bộ
 *   text → keystroke tiếp theo thay thế toàn bộ, chỉ thấy 1 ký tự.
 * - Fix ở `cellsTextEditor` (cellsTextEditor.tsx) dùng `useRef` + `useEffect` để
 *   focus + select CHỈ MỘT LẦN khi mount; subsequent re-render giữ nguyên DOM
 *   node + focus/selection.
 *
 * Hàm `applyTextCellKeystroke` ở đây chỉ là phép biến đổi text thuần
 * (input current + key event → next text + patch delta). Nó ĐẶC TẢ contract
 * mà editor phải tuân theo; còn DOM/IME/focus là việc của component.
 */

export type TextCellNextState = {
  /** Gia tri moi se dat vao `row.cells[column.key]`. */
  value: string;
  /** Patch delta de merge vao row.cells (giong nhu cach onCellsChange dang lam). */
  patch: Readonly<Record<string, string>>;
};

/**
 * Ap dung mot keystroke ASCII don le (khong qua IME composition).
 *
 * - Thay the 1 ky tu tai `selectionStart` (hoac append neu khong co selection).
 * - Khong commit/close.
 */
export function applyTextCellKeystroke(input: {
  currentValue: string;
  selectionStart: number;
  selectionEnd: number;
  key: string;
  columnKey: string;
}): TextCellNextState {
  const { currentValue, selectionStart, selectionEnd, key, columnKey } = input;
  const start = clampIndex(selectionStart, currentValue.length);
  const end = clampIndex(selectionEnd, currentValue.length);
  const before = currentValue.slice(0, start);
  const after = currentValue.slice(end);
  const next = before + key + after;
  return {
    value: next,
    patch: { [columnKey]: next },
  };
}

/**
 * Ap dung composition (IME): input hien tai (co the chua cac composing char
 * dang duoc the hien tam thoi) + composition data cua trinh duyet → text da
 * committed. Editor se goi ham nay khi `compositionend` xay ra.
 *
 * - Neu `committedValue` rong (user cancel composition), giu nguyen currentValue.
 * - Neu khong rong, replace toan bo current value bang committed value (day la
 *   semantic cua composition: composition cuoi cung quyet dinh text cuoi cung,
 *   khong phai cac composing char trung gian).
 */
export function applyTextCellCompositionEnd(input: {
  currentValue: string;
  committedValue: string;
  columnKey: string;
}): TextCellNextState {
  const { currentValue, committedValue, columnKey } = input;
  if (committedValue === "") {
    return { value: currentValue, patch: { [columnKey]: currentValue } };
  }
  return {
    value: committedValue,
    patch: { [columnKey]: committedValue },
  };
}

/**
 * Mo phong chuoi keystroke lien tiep (ASCII) de test regression: tung keystroke
 * phai accumulate, ky tu cu khong bi mat.
 */
export function simulateAsciiKeystrokes(input: {
  initialValue: string;
  keys: readonly string[];
  columnKey: string;
}): {
  finalValue: string;
  intermediateValues: readonly string[];
  patches: readonly Readonly<Record<string, string>>[];
} {
  let value = input.initialValue;
  const intermediateValues: string[] = [value];
  const patches: Readonly<Record<string, string>>[] = [];
  for (const key of input.keys) {
    const next = applyTextCellKeystroke({
      currentValue: value,
      selectionStart: value.length,
      selectionEnd: value.length,
      key,
      columnKey: input.columnKey,
    });
    value = next.value;
    patches.push(next.patch);
    intermediateValues.push(value);
  }
  return { finalValue: value, intermediateValues, patches };
}

/**
 * Mo phong Vietnamese IME composition: go "tie" (khong dau) → trinh duyet
 * compositionstart → cap nhat compositiondata tung pre-edit char → compositionend
 * voi "tiếng" (co dau). Editor phai giu gia tri committed cuoi cung.
 */
export function simulateVietnameseIme(input: {
  initialValue: string;
  preEditFragments: readonly string[]; // cac gia tri pre-edit qua cac compositionupdate
  finalCommitted: string; // "tiếng" - chuoi cuoi cung sau khi commit
  columnKey: string;
}): {
  finalValue: string;
  intermediateValues: readonly string[];
} {
  let value = input.initialValue;
  const intermediate: string[] = [value];
  for (const fragment of input.preEditFragments) {
    // Composition data la text trung gian (co the co dau, co the khong).
    // Editor nen hien thi fragment qua value nhung KHONG commit vao row
    // cho den khi compositionend (chung ta mo phong day du bang cach
    // truyen gia tri committed cuoi cung qua applyTextCellCompositionEnd).
    // Trong mo phong thuan, ta gia su gia tri hien thi = fragment.
    value = fragment;
    intermediate.push(value);
  }
  const committed = applyTextCellCompositionEnd({
    currentValue: value,
    committedValue: input.finalCommitted,
    columnKey: input.columnKey,
  });
  return { finalValue: committed.value, intermediateValues: intermediate };
}

function clampIndex(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > max) return max;
  return Math.floor(value);
}