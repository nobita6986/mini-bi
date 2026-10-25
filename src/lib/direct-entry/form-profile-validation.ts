/**
 * PRE-WAVE-2: Adapter validation cho chế độ Biểu mẫu (Form mode - worker-profile/1.2).
 *
 * Tuyệt đối không sửa đổi validation của chế độ Lưới (Grid mode - worker-profile/1.1).
 * Module này tái sử dụng toàn bộ pipeline `buildSpreadsheetValidation`, và chỉ điều chỉnh
 * quy tắc bắt buộc cá nhân cho Biểu mẫu:
 *   1. `national_id` (Số CCCD 12 chữ số hợp lệ) là BẮT BUỘC (`PASTE_VALUE_REQUIRED` nếu để trống).
 *   2. `display_name` (Họ và tên) là KHÔNG BẮT BUỘC (loại bỏ `PASTE_VALUE_REQUIRED` trên `display_name`,
 *      nhưng vẫn giữ nguyên các lỗi định dạng như `PASTE_FORMULA_CELL` hoặc `PASTE_TEXT_TOO_LONG`).
 */
import {
  buildSpreadsheetValidation,
  type SpreadsheetCellIssue,
  type SpreadsheetValidation,
  type SpreadsheetValidationRow,
} from "./direct-entry-grid-validation.ts";
import { CCCD_REQUIRED_FULL_PROFILE_CONTRACT_VERSION } from "./full-profile-contract.ts";
import type { SpreadsheetStagedRow } from "./spreadsheet-row-model.ts";
import {
  issue,
  workerProfileIssueMessage,
  type WorkerProfileIssue,
} from "./worker-profile-import-contract.ts";
import type {
  ExistingProfileIdentity,
  PasteCatalogSource,
  WorkerProfilePreview,
  WorkerProfilePreviewRow,
} from "./worker-profile-preview.ts";

export function buildFormProfileValidation(input: {
  rows: readonly SpreadsheetStagedRow[];
  referenceDate: string;
  catalogFor: (effectiveDate: string) => PasteCatalogSource | null;
  existing?: readonly ExistingProfileIdentity[];
  capabilities?: readonly string[];
}): SpreadsheetValidation {
  const base = buildSpreadsheetValidation(input);
  if (base.preview === null) return base;

  const clientRowIdForSourceRow = (sourceRow: number): string | null => {
    const index = sourceRow - 2;
    return base.rowOrder[index] ?? null;
  };

  const previewRows: WorkerProfilePreviewRow[] = base.preview.rows.map((previewRow) => {
    const filteredIssues = previewRow.issues.filter(
      (item) => !(item.field === "display_name" && item.code === "PASTE_VALUE_REQUIRED"),
    );
    const hasNationalIdError = filteredIssues.some((item) => item.field === "national_id");
    const nextIssues: WorkerProfileIssue[] = [...filteredIssues];
    if (previewRow.row.worker.national_id.state !== "provided" && !hasNationalIdError) {
      nextIssues.push(issue("PASTE_VALUE_REQUIRED", "error", previewRow.sourceRow, "national_id"));
    }
    return {
      ...previewRow,
      issues: nextIssues,
      canProceed: nextIssues.length === 0,
    };
  });

  const allIssues: WorkerProfileIssue[] = [
    ...base.preview.headerIssues,
    ...previewRows.flatMap((row) => [...row.issues, ...row.warnings]),
  ];
  const errorCount = allIssues.filter((item) => item.severity === "error").length;
  const warningCount = allIssues.filter((item) => item.severity === "warning").length;
  const validRows = previewRows.filter((row) => row.canProceed).length;

  const preview: WorkerProfilePreview = {
    ...base.preview,
    contractVersion: CCCD_REQUIRED_FULL_PROFILE_CONTRACT_VERSION,
    rows: previewRows,
    issues: allIssues,
    validRows,
    errorCount,
    warningCount,
    canProceed: errorCount === 0 && previewRows.length > 0,
  };

  const cellIssues: SpreadsheetCellIssue[] = [];
  const headerIssues: SpreadsheetCellIssue[] = [];
  for (const item of preview.issues) {
    const mapped: SpreadsheetCellIssue = Object.freeze({
      clientRowId: item.row >= 2 ? clientRowIdForSourceRow(item.row) : null,
      columnKey: item.field === null ? null : item.field,
      code: item.code,
      severity: item.severity,
      message: workerProfileIssueMessage(item.code),
    });
    if (item.row >= 2 && mapped.clientRowId !== null) cellIssues.push(mapped);
    else headerIssues.push(mapped);
  }

  const rows: SpreadsheetValidationRow[] = previewRows.map((row) => ({
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

  const firstError = cellIssues.find(
    (item) => item.severity === "error" && item.clientRowId !== null && item.columnKey !== null,
  );

  return {
    preview,
    rowOrder: base.rowOrder,
    rows: Object.freeze(rows),
    cellIssues: Object.freeze(cellIssues),
    headerIssues: Object.freeze(headerIssues),
    validRowCount: validRows,
    errorCount,
    warningCount,
    canSave: validRows > 0,
    catalogDates: base.catalogDates,
    firstError:
      firstError && firstError.clientRowId !== null && firstError.columnKey !== null
        ? { clientRowId: firstError.clientRowId, columnKey: firstError.columnKey }
        : null,
  };
}
