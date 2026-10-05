import { WORKER_PROFILE_FIELDS } from "./worker-profile-import-contract.ts";

export const SPREADSHEET_INITIAL_ROW_COUNT = 30;
export const SPREADSHEET_SPARE_ROW_COUNT = 10;
export const SPREADSHEET_MAX_DATA_ROWS = 100;

const CLIENT_ROW_ID_PREFIX = "spreadsheet-row";

/**
 * P1.7-H08-R1: default issue place cho moi staged row moi. Nguoi dung duoc
 * sua/xoa; day chi la gia tri khoi tao (server/imported value khong bi ghi de).
 */
export const DEFAULT_NATIONAL_ID_ISSUED_PLACE = "Bộ Công An";

/** First-work-date default la ngay hien tai theo Asia/Ho_Chi_Minh (GMT+7). */
export const SPREADSHEET_DEFAULT_DATE_FIELD_KEY = "first_work_date";
export const SPREADSHEET_DEFAULT_PLACE_FIELD_KEY = "national_id_issued_place";

/**
 * Tra ve ngay hien tai (YYYY-MM-DD) theo timezone Asia/Ho_Chi_Minh. Tranh
 * dung `toISOString()` vi mac dinh la UTC, gay lech ngay khi may o GMT-/+ khac.
 */
export function spreadsheetDefaultFirstWorkDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * The persisted worker-profile fields are the only user-entered values owned by
 * this model. Derived, status, document and action columns remain outside it.
 */
export const SPREADSHEET_WRITABLE_FIELD_KEYS: readonly string[] = Object.freeze(
  WORKER_PROFILE_FIELDS.filter((field) => field.persisted && field.key !== "employee_code")
    .map((field) => field.key),
);

const WRITABLE_FIELD_KEYS = new Set(SPREADSHEET_WRITABLE_FIELD_KEYS);

export type SpreadsheetStagedRow = {
  /** Client-only stable identity. It is never a server entry identifier. */
  clientRowId: string;
  /** Raw cell text as entered or pasted. Validation happens in a separate adapter. */
  cells: Readonly<Record<string, string>>;
  /** Client-only recruiter filter/assertion; never serialized as a worker-profile field. */
  providerType: "hrp" | "vendor" | "";
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

/**
 * P1.7-H08-R1: cel mac dinh cho staged row moi.
 * - `first_work_date` = ngay hien tai theo GMT+7 (tranh lech ngay do UTC).
 * - `national_id_issued_place` = "Bộ Công An".
 * User co the sua/xoa; import/imported values tu pipeline khong bi ghi de.
 */
export function defaultCells(now: Date = new Date()): Record<string, string> {
  const cells = Object.fromEntries(SPREADSHEET_WRITABLE_FIELD_KEYS.map((key) => [key, ""]));
  cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY] = spreadsheetDefaultFirstWorkDate(now);
  cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY] = DEFAULT_NATIONAL_ID_ISSUED_PLACE;
  return cells;
}

/**
 * Returns true neu row chi chua default values (khong co business input nao).
 * Duoc dung de:
 *  - loc row khoi validation save/filter.
 *  - khong dem row vao batch request.
 *  - khong trigger required validation.
 * Khi user nhap business field (display_name, project_id, recruiter_id, ...)
 * hoac thay doi default value (vd xoa "Bộ Công An" de go "Khác"), row se
 * tu dong duoc tinh la khong trong.
 */
export function spreadsheetRowIsBlank(row: SpreadsheetStagedRow): boolean {
  return SPREADSHEET_WRITABLE_FIELD_KEYS.every((key) => {
    const value = (row.cells[key] ?? "").trim();
    if (value.length === 0) return true;
    if (key === SPREADSHEET_DEFAULT_DATE_FIELD_KEY) {
      return value === spreadsheetDefaultFirstWorkDate();
    }
    if (key === SPREADSHEET_DEFAULT_PLACE_FIELD_KEY) {
      return value === DEFAULT_NATIONAL_ID_ISSUED_PLACE;
    }
    return false;
  });
}

function nextBlankRow(sequence: number): SpreadsheetStagedRow {
  return {
    clientRowId: `${CLIENT_ROW_ID_PREFIX}-${sequence}`,
    cells: defaultCells(),
    providerType: "",
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

export function updateSpreadsheetRowProviderType(
  model: SpreadsheetRowModel,
  clientRowId: string,
  providerType: SpreadsheetStagedRow["providerType"],
): SpreadsheetRowModel {
  const rows = model.rows.map((row) => {
    if (row.clientRowId !== clientRowId || row.providerType === providerType) return row;
    return {
      ...row,
      providerType,
      cells: { ...row.cells, recruiter_id: "" },
    };
  });
  return rows.every((row, index) => row === model.rows[index])
    ? model
    : { ...model, rows };
}

export function clearSpreadsheetRow(
  model: SpreadsheetRowModel,
  clientRowId: string,
): SpreadsheetRowModel {
  let found = false;
  const rows = model.rows.map((row) => {
    if (row.clientRowId !== clientRowId) return row;
    found = true;
    return { ...row, cells: defaultCells() };
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
    providerType: source.providerType,
  };
  const rows = [...model.rows];
  rows.splice(sourceIndex + 1, 0, duplicate);

  return ensureSpreadsheetSpareRows({
    rows,
    nextClientRowSequence: model.nextClientRowSequence + 1,
  });
}
