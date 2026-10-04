/**
 * P1.7-W02 - Adapter validation cho spreadsheet grid.
 *
 * Module nay KHONG tu viet lai bat ky rule nghiep vu nao. No chi:
 *   1. serialize cac dong staged thanh TSV theo header canonical cua registry;
 *   2. goi lai dung pipeline preview full-profile cua P1.6;
 *   3. anh xa issue ve dung clientRowId + column key cua grid.
 *
 * Nho vay moi parser/validator/catalog resolver/issue message van la mot nguon su that duy nhat.
 */
import {
  DIRECT_ENTRY_GRID_COLUMNS,
  directEntryGridColumn,
} from "./direct-entry-grid-columns.ts";
import {
  spreadsheetRowIsBlank,
  type SpreadsheetStagedRow,
} from "./spreadsheet-row-model.ts";
import {
  buildWorkerProfilePreview,
  createPasteCatalogResolver,
  type ExistingProfileIdentity,
  type PasteCatalogSource,
  type WorkerProfilePreview,
} from "./worker-profile-preview.ts";
import { workerProfileIssueMessage } from "./worker-profile-import-contract.ts";

/** Cac cot vat ly duoc ghi vao payload, theo dung thu tu vat ly cua registry. */
export const SPREADSHEET_WRITE_COLUMNS = Object.freeze(
  DIRECT_ENTRY_GRID_COLUMNS.filter((column) => column.pasteMode === "write"),
);
const SPREADSHEET_VALIDATION_COLUMNS = Object.freeze(
  DIRECT_ENTRY_GRID_COLUMNS.filter((column) =>
    column.pasteMode === "write" || column.key === "employee_code"),
);

function canonicalHeaderFor(columnKey: string): string | null {
  const column = directEntryGridColumn(columnKey);
  return column?.contractField?.canonicalHeader ?? null;
}

/**
 * Serialize mot tap dong staged thanh TSV full-profile.
 * Chi gom cac cot pasteMode = "write"; cot derived/ignore khong bao gio vao payload.
 */
export function serializeSpreadsheetRows(
  rows: readonly SpreadsheetStagedRow[],
): string {
  const headers = SPREADSHEET_VALIDATION_COLUMNS
    .map((column) => canonicalHeaderFor(column.key))
    .filter((header): header is string => header !== null);
  const lines = rows.map((row) =>
    SPREADSHEET_VALIDATION_COLUMNS
      .map((column) => row.cells[column.key] ?? "")
      .join("\t"));
  return [headers.join("\t"), ...lines].join("\n");
}

export type SpreadsheetCellIssue = {
  /** Dong client chua loi. Voi issue muc bang thi la null. */
  clientRowId: string | null;
  /** Cot grid chua loi; null khi loi o muc bang/header. */
  columnKey: string | null;
  code: string;
  severity: "error" | "warning";
  /** Message da duoc contract dich san; khong chua gia tri nguoi dung. */
  message: string;
};

export type SpreadsheetValidationRow = {
  clientRowId: string;
  canProceed: boolean;
  errorCount: number;
  warningCount: number;
  employeeCode: string;
  displayName: string;
  projectLabel: string;
  recruiterLabel: string;
  firstWorkDate: string;
};

export type SpreadsheetValidation = {
  /** Preview goc cua P1.6, dung lai cho save boundary. */
  preview: WorkerProfilePreview | null;
  /** clientRowId cua cac dong KHONG trong, theo dung thu tu hien thi. */
  rowOrder: readonly string[];
  rows: readonly SpreadsheetValidationRow[];
  /** Issue theo tung o, chi danh cho cac dong co du lieu. */
  cellIssues: readonly SpreadsheetCellIssue[];
  /** Issue muc bang/header (khong gan voi mot dong cu the). */
  headerIssues: readonly SpreadsheetCellIssue[];
  validRowCount: number;
  errorCount: number;
  warningCount: number;
  canSave: boolean;
  catalogDates: readonly string[];
  firstError: { clientRowId: string; columnKey: string } | null;
};

const EMPTY_VALIDATION: SpreadsheetValidation = Object.freeze({
  preview: null,
  rowOrder: Object.freeze([]),
  rows: Object.freeze([]),
  cellIssues: Object.freeze([]),
  headerIssues: Object.freeze([]),
  validRowCount: 0,
  errorCount: 0,
  warningCount: 0,
  canSave: false,
  catalogDates: Object.freeze([]),
  firstError: null,
});

export function spreadsheetCellIssuesFor(
  validation: SpreadsheetValidation,
  clientRowId: string | null,
  columnKey: string,
): readonly SpreadsheetCellIssue[] {
  if (clientRowId === null) return [];
  return validation.cellIssues.filter((issue) =>
    issue.clientRowId === clientRowId && issue.columnKey === columnKey);
}

export function spreadsheetRowHasError(
  validation: SpreadsheetValidation,
  clientRowId: string,
): boolean {
  return validation.cellIssues.some((issue) =>
    issue.clientRowId === clientRowId && issue.severity === "error");
}

/**
 * Chay validation tren cac dong staged KHONG trong.
 * Dong trong hoan toan khong duoc validate va khong bao gio tao issue.
 */
export function buildSpreadsheetValidation(input: {
  rows: readonly SpreadsheetStagedRow[];
  referenceDate: string;
  catalogFor: (effectiveDate: string) => PasteCatalogSource | null;
  existing?: readonly ExistingProfileIdentity[];
  capabilities?: readonly string[];
}): SpreadsheetValidation {
  const dataRows = input.rows.filter((row) => !spreadsheetRowIsBlank(row));
  if (dataRows.length === 0) return EMPTY_VALIDATION;

  const resolver = createPasteCatalogResolver(input.catalogFor);
  const preview = buildWorkerProfilePreview({
    text: serializeSpreadsheetRows(dataRows),
    referenceDate: input.referenceDate,
    resolver,
    existing: input.existing,
    employeeCodeMode: "server-generated",
  });

  const clientRowIdForSourceRow = (sourceRow: number): string | null => {
    const index = sourceRow - 2;
    return dataRows[index]?.clientRowId ?? null;
  };

  const cellIssues: SpreadsheetCellIssue[] = [];
  const headerIssues: SpreadsheetCellIssue[] = [];
  for (const issue of preview.issues) {
    const mapped: SpreadsheetCellIssue = Object.freeze({
      clientRowId: issue.row >= 2 ? clientRowIdForSourceRow(issue.row) : null,
      columnKey: issue.field === null ? null : issue.field,
      code: issue.code,
      severity: issue.severity,
      message: workerProfileIssueMessage(issue.code),
    });
    if (issue.row >= 2 && mapped.clientRowId !== null) cellIssues.push(mapped);
    else headerIssues.push(mapped);
  }

  const rows: SpreadsheetValidationRow[] = preview.rows.map((row) => ({
    clientRowId: clientRowIdForSourceRow(row.sourceRow) ?? "",
    canProceed: row.canProceed,
    errorCount: row.issues.length,
    warningCount: row.warnings.length,
    employeeCode: row.row.employee_code,
    displayName: row.row.display_name,
    projectLabel: row.labels.project,
    recruiterLabel: row.labels.recruiter,
    firstWorkDate: row.row.first_work_date,
  }));

  const firstError = cellIssues.find((issue) =>
    issue.severity === "error" && issue.clientRowId !== null && issue.columnKey !== null);

  return {
    preview,
    rowOrder: Object.freeze(dataRows.map((row) => row.clientRowId)),
    rows: Object.freeze(rows),
    cellIssues: Object.freeze(cellIssues),
    headerIssues: Object.freeze(headerIssues),
    validRowCount: preview.validRows,
    errorCount: preview.errorCount,
    warningCount: preview.warningCount,
    canSave: preview.canProceed && preview.validRows > 0,
    catalogDates: preview.catalogDates,
    firstError: firstError && firstError.clientRowId !== null && firstError.columnKey !== null
      ? { clientRowId: firstError.clientRowId, columnKey: firstError.columnKey }
      : null,
  };
}
