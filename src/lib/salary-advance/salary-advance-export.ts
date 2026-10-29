import type { SalaryAdvanceRequestSummary } from "./salary-advance-contract.ts";
import {
  formatDateTimeVi,
  getEvidenceReviewStateMeta,
  getPaymentMethodMeta,
  getRequestStateMeta,
  resolveSalaryAdvanceActorDisplayName,
} from "./salary-advance-ui-model.ts";

export const SALARY_ADVANCE_EXPORT_XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const SALARY_ADVANCE_EXPORT_COLUMNS = [
  { key: "stt", header: "STT", width: 8 },
  { key: "project_id", header: "Mã dự án", width: 16 },
  { key: "project_display_name", header: "Tên dự án", width: 26 },
  { key: "worker_employee_code", header: "Mã NV", width: 16 },
  { key: "worker_display_name", header: "Họ và tên NLĐ", width: 24 },
  { key: "requested_amount_vnd", header: "Số tiền đề nghị (VNĐ)", width: 20 },
  { key: "payment_method_label", header: "Phương thức nhận tiền", width: 20 },
  { key: "bank_institution_name", header: "Ngân hàng nhận", width: 22 },
  { key: "bank_account_number", header: "Số tài khoản nhận", width: 20 },
  { key: "bank_account_holder_name", header: "Chủ tài khoản nhận", width: 24 },
  { key: "request_state_label", header: "Trạng thái yêu cầu", width: 22 },
  {
    key: "evidence_review_state_label",
    header: "Trạng thái đối chiếu ảnh",
    width: 22,
  },
  { key: "initial_content", header: "Nội dung đề nghị", width: 34 },
  { key: "created_by_display_name", header: "Người tạo (QLDA)", width: 22 },
  { key: "created_at_formatted", header: "Thời điểm tạo", width: 20 },
  {
    key: "project_accountant_display_name",
    header: "Kế toán phụ trách",
    width: 22,
  },
  {
    key: "decided_by_display_name",
    header: "Người quyết định",
    width: 22,
  },
  { key: "decided_at_formatted", header: "Thời điểm quyết định", width: 20 },
  { key: "decision_note", header: "Ghi chú xử lý", width: 30 },
  {
    key: "reviewed_by_display_name",
    header: "Người đối chiếu ảnh",
    width: 22,
  },
  { key: "reviewed_at_formatted", header: "Thời điểm đối chiếu", width: 20 },
  { key: "review_note", header: "Ghi chú đối chiếu", width: 30 },
] as const;

export type SalaryAdvanceExportColumnKey =
  (typeof SALARY_ADVANCE_EXPORT_COLUMNS)[number]["key"];

export type SalaryAdvanceExportRow = Record<
  SalaryAdvanceExportColumnKey,
  string
>;

function safeCellString(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function projectSalaryAdvanceExportRow(
  item: SalaryAdvanceRequestSummary,
  index: number,
): SalaryAdvanceExportRow {
  const isBankTransfer = item.payment_method === "BANK_TRANSFER";
  const destination = isBankTransfer
    ? item.payment_destination_snapshot ?? null
    : null;
  const decisionNote =
    item.decision_note ??
    item.handled_externally_note ??
    item.withdrawn_note ??
    null;

  return {
    stt: String(index + 1),
    project_id: safeCellString(item.project_id),
    project_display_name: safeCellString(item.project_display_name),
    worker_employee_code: safeCellString(item.worker_employee_code),
    worker_display_name: safeCellString(item.worker_display_name),
    requested_amount_vnd: safeCellString(String(item.requested_amount_vnd ?? "")),
    payment_method_label: getPaymentMethodMeta(item.payment_method).label,
    bank_institution_name: safeCellString(destination?.institution_name),
    bank_account_number: safeCellString(destination?.account_number),
    bank_account_holder_name: safeCellString(destination?.account_holder_name),
    request_state_label: getRequestStateMeta(item.request_state).label,
    evidence_review_state_label: getEvidenceReviewStateMeta(
      item.evidence_review_state,
    ).label,
    initial_content: safeCellString(item.initial_content),
    created_by_display_name: resolveSalaryAdvanceActorDisplayName(
      item.created_by_display_name,
    ),
    created_at_formatted: item.created_at
      ? formatDateTimeVi(item.created_at)
      : "",
    project_accountant_display_name: item.current_project_accountant
      ? resolveSalaryAdvanceActorDisplayName(
          item.current_project_accountant.display_name,
        )
      : "",
    decided_by_display_name: item.decided_by_display_name
      ? resolveSalaryAdvanceActorDisplayName(item.decided_by_display_name)
      : "",
    decided_at_formatted: item.decided_at
      ? formatDateTimeVi(item.decided_at)
      : "",
    decision_note: safeCellString(decisionNote),
    reviewed_by_display_name: item.current_evidence?.reviewed_by_display_name
      ? resolveSalaryAdvanceActorDisplayName(
          item.current_evidence.reviewed_by_display_name,
        )
      : "",
    reviewed_at_formatted: item.current_evidence?.reviewed_at
      ? formatDateTimeVi(item.current_evidence.reviewed_at)
      : "",
    review_note: safeCellString(item.current_evidence?.review_note),
  };
}

export async function buildSalaryAdvanceExportXlsx(
  requests: readonly SalaryAdvanceRequestSummary[],
): Promise<Uint8Array> {
  const imported = await import("exceljs");
  const excel = imported.default;
  const workbook = new excel.Workbook();
  workbook.creator = "HR Partner BI";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Đối soát ứng lương");
  sheet.addRow(SALARY_ADVANCE_EXPORT_COLUMNS.map((col) => col.header));
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  for (let i = 0; i < SALARY_ADVANCE_EXPORT_COLUMNS.length; i += 1) {
    const colIndex = i + 1;
    sheet.getColumn(colIndex).width = SALARY_ADVANCE_EXPORT_COLUMNS[i].width;
    const headerCell = sheet.getRow(1).getCell(colIndex);
    headerCell.font = { bold: true };
    headerCell.numFmt = "@";
  }

  for (let rowIdx = 0; rowIdx < requests.length; rowIdx += 1) {
    const projected = projectSalaryAdvanceExportRow(requests[rowIdx], rowIdx);
    const addedRow = sheet.addRow(
      SALARY_ADVANCE_EXPORT_COLUMNS.map((col) => projected[col.key]),
    );
    for (let colIdx = 1; colIdx <= SALARY_ADVANCE_EXPORT_COLUMNS.length; colIdx += 1) {
      const cell = addedRow.getCell(colIdx);
      cell.value = String(
        projected[SALARY_ADVANCE_EXPORT_COLUMNS[colIdx - 1].key] ?? "",
      );
      cell.numFmt = "@";
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

export function buildSalaryAdvanceExportFilename(isoDate?: string): string {
  const datePart =
    typeof isoDate === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(isoDate)
      ? isoDate
      : new Date().toISOString().slice(0, 10);
  return `ung-luong-doi-soat-${datePart}.xlsx`;
}
