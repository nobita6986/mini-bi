import { WORKER_PROFILE_FIELDS } from "./worker-profile-import-contract.ts";

export const SPREADSHEET_INITIAL_ROW_COUNT = 30;
export const SPREADSHEET_SPARE_ROW_COUNT = 10;
export const SPREADSHEET_MAX_DATA_ROWS = 100;

const CLIENT_ROW_ID_PREFIX = "spreadsheet-row";

/**
 * The persisted worker-profile fields are the only user-entered values owned by
 * this model. Derived, status, document and action columns remain outside it.
 */
export const SPREADSHEET_WRITABLE_FIELD_KEYS: readonly string[] = Object.freeze(
  WORKER_PROFILE_FIELDS.filter((field) => field.persisted).map((field) => field.key),
);

const WRITABLE_FIELD_KEYS = new Set(SPREADSHEET_WRITABLE_FIELD_KEYS);

export type SpreadsheetStagedRow = {
  /** Client-only stable identity. It is never a server entry identifier. */
  clientRowId: string;
  /** Raw cell text as entered or pasted. Validation happens in a separate adapter. */
  cells: Readonly<Record<string, string>>;
};

export type SpreadsheetRowModel = {
  rows: readonly SpreadsheetStagedRow[];
  /** Monotonic client-only sequence used to avoid recycling IDs after deletion. */
  nextClientRowSequence: number;
};

export class SpreadsheetDataRowLimitError extends RangeError {
  constructor() {
    super(`A spreadsheet batch accepts at most ${SPREADSHEET_MAX_DATA_ROWS} data rows.`);
    this.name = "SpreadsheetDataRowLimitError";
  }
}

function blankCells(): Record<string, string> {
  return Object.fromEntries(SPREADSHEET_WRITABLE_FIELD_KEYS.map((key) => [key, ""]));
}

function nextBlankRow(sequence: number): SpreadsheetStagedRow {
  return {
    clientRowId: `${CLIENT_ROW_ID_PREFIX}-${sequence}`,
    cells: blankCells(),
  };
}

function appendBlankRows(model: SpreadsheetRowModel, count: number): SpreadsheetRowModel {
  if (count <= 0) return model;

  const added = Array.from({ length: count }, (_, index) =>
    nextBlankRow(model.nextClientRowSequence + index));

  return {
    rows: [...model.rows, ...added],
    nextClientRowSequence: model.nextClientRowSequence + count,
  };
}

function assertWritablePatch(patch: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!WRITABLE_FIELD_KEYS.has(key)) {
      throw new TypeError(`Unknown spreadsheet writable field: ${key}`);
    }
    if (typeof value !== "string") {
      throw new TypeError(`Spreadsheet cell ${key} must be a string.`);
    }
  }
}

export function spreadsheetRowIsBlank(row: SpreadsheetStagedRow): boolean {
  return SPREADSHEET_WRITABLE_FIELD_KEYS.every((key) =>
    (row.cells[key] ?? "").trim().length === 0);
}

export function selectNonEmptySpreadsheetRows(
  model: SpreadsheetRowModel,
): SpreadsheetStagedRow[] {
  return model.rows.filter((row) => !spreadsheetRowIsBlank(row));
}

/**
 * Keeps at least ten empty placeholders after the last row containing user data.
 * One hundred is the data-row limit; trailing placeholders are not batch data.
 */
export function ensureSpreadsheetSpareRows(model: SpreadsheetRowModel): SpreadsheetRowModel {
  const dataRows = selectNonEmptySpreadsheetRows(model);
  if (dataRows.length > SPREADSHEET_MAX_DATA_ROWS) throw new SpreadsheetDataRowLimitError();

  let lastDataIndex = -1;
  for (let index = model.rows.length - 1; index >= 0; index -= 1) {
    const row = model.rows[index];
    if (row && !spreadsheetRowIsBlank(row)) {
      lastDataIndex = index;
      break;
    }
  }

  const requiredLength = Math.max(
    SPREADSHEET_INITIAL_ROW_COUNT,
    lastDataIndex + 1 + SPREADSHEET_SPARE_ROW_COUNT,
  );

  return appendBlankRows(model, requiredLength - model.rows.length);
}

/**
 * Bao dam model co it nhat `minimumRowCount` dong hien thi.
 * Can cho paste bat dau gan cuoi bang: phai co dong trong de ghi truoc khi ap ma tran.
 * Day chi la placeholder client-side, khong tinh vao gioi han 100 dong du lieu.
 */
export function ensureSpreadsheetRowCount(
  model: SpreadsheetRowModel,
  minimumRowCount: number,
): SpreadsheetRowModel {
  if (!Number.isFinite(minimumRowCount) || minimumRowCount <= model.rows.length) return model;
  return appendBlankRows(model, Math.ceil(minimumRowCount) - model.rows.length);
}

export function createSpreadsheetRowModel(): SpreadsheetRowModel {
  return appendBlankRows({ rows: [], nextClientRowSequence: 1 }, SPREADSHEET_INITIAL_ROW_COUNT);
}

export function updateSpreadsheetRowCells(
  model: SpreadsheetRowModel,
  clientRowId: string,
  patch: Readonly<Record<string, string>>,
): SpreadsheetRowModel {
  assertWritablePatch(patch);

  let found = false;
  const rows = model.rows.map((row) => {
    if (row.clientRowId !== clientRowId) return row;
    found = true;
    return { ...row, cells: { ...row.cells, ...patch } };
  });
  if (!found) return model;

  return ensureSpreadsheetSpareRows({ ...model, rows });
}

export function clearSpreadsheetRow(
  model: SpreadsheetRowModel,
  clientRowId: string,
): SpreadsheetRowModel {
  let found = false;
  const rows = model.rows.map((row) => {
    if (row.clientRowId !== clientRowId) return row;
    found = true;
    return { ...row, cells: blankCells() };
  });
  if (!found) return model;

  return ensureSpreadsheetSpareRows({ ...model, rows });
}

export function deleteSpreadsheetRow(
  model: SpreadsheetRowModel,
  clientRowId: string,
): SpreadsheetRowModel {
  const rows = model.rows.filter((row) => row.clientRowId !== clientRowId);
  if (rows.length === model.rows.length) return model;
  return ensureSpreadsheetSpareRows({ ...model, rows });
}

export function duplicateSpreadsheetRow(
  model: SpreadsheetRowModel,
  clientRowId: string,
): SpreadsheetRowModel {
  const sourceIndex = model.rows.findIndex((row) => row.clientRowId === clientRowId);
  if (sourceIndex < 0) return model;

  const source = model.rows[sourceIndex];
  if (!source) return model;
  if (!spreadsheetRowIsBlank(source)
    && selectNonEmptySpreadsheetRows(model).length >= SPREADSHEET_MAX_DATA_ROWS) {
    throw new SpreadsheetDataRowLimitError();
  }

  const duplicate = {
    clientRowId: `${CLIENT_ROW_ID_PREFIX}-${model.nextClientRowSequence}`,
    cells: { ...source.cells },
  };
  const rows = [...model.rows];
  rows.splice(sourceIndex + 1, 0, duplicate);

  return ensureSpreadsheetSpareRows({
    rows,
    nextClientRowSequence: model.nextClientRowSequence + 1,
  });
}
