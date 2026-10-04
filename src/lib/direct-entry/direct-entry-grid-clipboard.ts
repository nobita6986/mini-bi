import { PASTE_MAX_ROWS } from "./paste-primitives.ts";
import {
  DIRECT_ENTRY_GRID_COLUMNS,
  type DirectEntryGridColumn,
  type DirectEntryGridPasteMode,
} from "./direct-entry-grid-columns.ts";

export const DIRECT_ENTRY_GRID_MAX_ROWS = PASTE_MAX_ROWS;

export type ClipboardMatrix = readonly (readonly string[])[];

export type ClipboardParseResult =
  | { ok: true; matrix: ClipboardMatrix; rowCount: number; columnCount: number }
  | { ok: false; code: "CLIPBOARD_ROW_OVERFLOW"; rowCount: number; maxRows: number };

export type ClipboardAnchor = { rowIndex: number; columnIndex: number };

export type ClipboardMappedCell = {
  sourceRowIndex: number;
  sourceColumnIndex: number;
  rowIndex: number;
  columnIndex: number;
  columnKey: string;
  pasteMode: DirectEntryGridPasteMode;
  value: string;
};

export type ClipboardMapResult =
  | {
    ok: true;
    rowCount: number;
    columnCount: number;
    cells: readonly ClipboardMappedCell[];
    writeCells: readonly ClipboardMappedCell[];
    validationCells: readonly ClipboardMappedCell[];
    ignoredCells: readonly ClipboardMappedCell[];
  }
  | {
    ok: false;
    code: "CLIPBOARD_ANCHOR_INVALID" | "CLIPBOARD_ROW_OVERFLOW" | "CLIPBOARD_COLUMN_OVERFLOW";
  };

/** Parse Excel text/plain TSV without trimming cell values or collapsing empty cells. */
export function parseClipboardTsv(
  text: string,
  maxRows = DIRECT_ENTRY_GRID_MAX_ROWS,
): ClipboardParseResult {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  // Excel commonly appends exactly one record terminator. It is not a second blank data row.
  if (normalized.endsWith("\n") && lines.at(-1) === "") lines.pop();
  if (lines.length === 0) lines.push("");
  if (lines.length > maxRows) {
    return { ok: false, code: "CLIPBOARD_ROW_OVERFLOW", rowCount: lines.length, maxRows };
  }
  const matrix = lines.map((line) => Object.freeze(line.split("\t")));
  const columnCount = matrix.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  return {
    ok: true,
    matrix: Object.freeze(matrix),
    rowCount: matrix.length,
    columnCount,
  };
}

/** Serialize a possibly ragged selection as a rectangular TSV matrix. */
export function serializeClipboardTsv(matrix: ClipboardMatrix): string {
  if (matrix.length === 0) return "";
  const columnCount = matrix.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  return matrix.map((row) => {
    const cells = Array.from({ length: columnCount }, (_, index) => row[index] ?? "");
    return cells.join("\t");
  }).join("\n");
}

/**
 * Map a clipboard matrix to physical grid coordinates. Bounds are checked before any cell is
 * returned, so callers cannot accidentally apply a partial overflow.
 */
export function mapClipboardFromAnchor(input: {
  matrix: ClipboardMatrix;
  anchor: ClipboardAnchor;
  columns?: readonly DirectEntryGridColumn[];
  maxRows?: number;
}): ClipboardMapResult {
  const columns = input.columns ?? DIRECT_ENTRY_GRID_COLUMNS;
  const maxRows = input.maxRows ?? DIRECT_ENTRY_GRID_MAX_ROWS;
  const { rowIndex, columnIndex } = input.anchor;
  if (!Number.isInteger(rowIndex) || !Number.isInteger(columnIndex) ||
      rowIndex < 0 || columnIndex < 0 || columnIndex >= columns.length) {
    return { ok: false, code: "CLIPBOARD_ANCHOR_INVALID" };
  }
  if (rowIndex + input.matrix.length > maxRows) {
    return { ok: false, code: "CLIPBOARD_ROW_OVERFLOW" };
  }
  const matrixWidth = input.matrix.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  if (columnIndex + matrixWidth > columns.length) {
    return { ok: false, code: "CLIPBOARD_COLUMN_OVERFLOW" };
  }

  const cells: ClipboardMappedCell[] = [];
  input.matrix.forEach((row, sourceRowIndex) => {
    row.forEach((value, sourceColumnIndex) => {
      const targetColumnIndex = columnIndex + sourceColumnIndex;
      const column = columns[targetColumnIndex];
      cells.push(Object.freeze({
        sourceRowIndex,
        sourceColumnIndex,
        rowIndex: rowIndex + sourceRowIndex,
        columnIndex: targetColumnIndex,
        columnKey: column.key,
        pasteMode: column.pasteMode,
        value,
      }));
    });
  });
  const frozenCells = Object.freeze(cells);
  return {
    ok: true,
    rowCount: input.matrix.length,
    columnCount: matrixWidth,
    cells: frozenCells,
    writeCells: Object.freeze(cells.filter((cell) => cell.pasteMode === "write")),
    validationCells: Object.freeze(cells.filter((cell) => cell.pasteMode === "validate-only")),
    ignoredCells: Object.freeze(cells.filter((cell) => cell.pasteMode === "ignore")),
  };
}

export type ClipboardUndoCell = {
  rowIndex: number;
  columnKey: string;
  previousValue: string | undefined;
};

export type ClipboardUndoSnapshot = {
  /** Rows beyond this count were placeholders added by the paste and must be removed on undo. */
  previousRowCount: number;
  cells: readonly ClipboardUndoCell[];
};

/** Capture only write cells. A new paste replaces this one snapshot; no undo stack is created. */
export function captureClipboardUndoSnapshot(input: {
  mapping: Extract<ClipboardMapResult, { ok: true }>;
  currentRowCount: number;
  readCell: (rowIndex: number, columnKey: string) => string | undefined;
}): ClipboardUndoSnapshot {
  return Object.freeze({
    previousRowCount: input.currentRowCount,
    cells: Object.freeze(input.mapping.writeCells.map((cell) => Object.freeze({
      rowIndex: cell.rowIndex,
      columnKey: cell.columnKey,
      previousValue: cell.rowIndex < input.currentRowCount
        ? input.readCell(cell.rowIndex, cell.columnKey)
        : undefined,
    }))),
  });
}

/**
 * Restore one snapshot through a pure row writer supplied by the W01B row model. Newly appended
 * rows are truncated before overwritten cells are restored.
 */
export function restoreClipboardUndoSnapshot<Row>(input: {
  rows: readonly Row[];
  snapshot: ClipboardUndoSnapshot;
  writeCell: (
    rows: readonly Row[],
    rowIndex: number,
    columnKey: string,
    value: string | undefined,
  ) => readonly Row[];
}): readonly Row[] {
  let restored: readonly Row[] = input.rows.slice(0, input.snapshot.previousRowCount);
  for (const cell of input.snapshot.cells) {
    if (cell.rowIndex >= input.snapshot.previousRowCount) continue;
    restored = input.writeCell(restored, cell.rowIndex, cell.columnKey, cell.previousValue);
  }
  return restored;
}
