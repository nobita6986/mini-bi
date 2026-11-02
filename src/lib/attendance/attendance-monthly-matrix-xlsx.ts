import {
  DEFAULT_ATTENDANCE_SLOT_POLICY,
  type AttendanceMonthlyMatrixCalendarDayProjection,
  type AttendanceMonthlyMatrixDayCellProjection,
  type AttendanceMonthlyMatrixEmployeeRowProjection,
  type AttendanceMonthlyMatrixReportProjection,
  type AttendanceMonthlyMatrixSlotPolicySummaryProjection,
} from "./attendance-monthly-matrix-contract.ts";
import {
  describeMatrixDayCell,
  MATRIX_DAY_STATUS_LABELS,
  MATRIX_LEAVE_SESSION_LABELS,
  MATRIX_LEAVE_TYPE_LABELS,
  MATRIX_LEGEND_ITEMS,
  MATRIX_WEEKDAY_LABELS,
} from "./attendance-monthly-matrix-ui-model.ts";

function sanitizeSpreadsheetText(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (/^[=+\-@\t\r]/.test(trimmed)) {
    return `'${trimmed}`;
  }
  return trimmed;
}

export function formatMatrixLeaveSummary(
  cell: Pick<AttendanceMonthlyMatrixDayCellProjection, "approved_leaves">,
): string {
  if (cell.approved_leaves.length === 0) return "";
  return cell.approved_leaves
    .map((item) => {
      const typeLabel = MATRIX_LEAVE_TYPE_LABELS[item.leave_type] ?? item.leave_type;
      const sessionLabel = MATRIX_LEAVE_SESSION_LABELS[item.session_code] ?? item.session_code;
      return `${typeLabel} (${sessionLabel})`;
    })
    .join("; ");
}

export function formatMatrixDayCellText(cell: AttendanceMonthlyMatrixDayCellProjection): string {
  const presentation = describeMatrixDayCell(cell);
  const slotParts = presentation.slots.map(
    (slot) => `${slot.slotTitle}: ${slot.summaryText}`,
  );
  const parts: string[] = [slotParts.join("\n")];

  if (cell.has_checkin) {
    const targetPrefix =
      cell.distance_target_kind === "BRANCH"
        ? cell.branch_code_used
          ? `CN:${cell.branch_code_used}`
          : "CN"
        : "HQ";

    if (cell.distance_status === "COMPUTED" && cell.distance_meters !== null) {
      parts.push(`[${targetPrefix} ${Math.round(cell.distance_meters)}m]`);
    } else if (cell.distance_status === "BRANCH_NOT_CONFIGURED") {
      parts.push(`[${targetPrefix} chưa có tọa độ]`);
    } else if (cell.distance_status === "HQ_NOT_CONFIGURED") {
      parts.push("[HQ chưa có tọa độ]");
    } else if (cell.distance_status === "INVALID_GPS") {
      parts.push("[GPS không hợp lệ]");
    }
  }

  if (cell.has_approved_leave) {
    const leaveText = formatMatrixLeaveSummary(cell);
    parts.push(leaveText ? `Nghỉ: ${leaveText}` : `Nghỉ (${cell.approved_leave_units} ngày)`);
  }

  return parts.join("\n");
}

export function attendanceMonthlyMatrixExportFilename(yearMonth: string): string {
  const safeMonth = /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(yearMonth) ? yearMonth : "report";
  return `attendance-monthly-matrix-${safeMonth}.xlsx`;
}

export async function buildAttendanceMonthlyMatrixXlsx(input: {
  year_month: string;
  from_date: string;
  to_date: string;
  calendar_days: AttendanceMonthlyMatrixCalendarDayProjection[];
  items: AttendanceMonthlyMatrixEmployeeRowProjection[];
  slot_policy?: AttendanceMonthlyMatrixSlotPolicySummaryProjection;
}): Promise<Uint8Array> {
  const imported = await import("exceljs");
  const excel = imported.default ?? imported;
  const workbook = new excel.Workbook();
  workbook.creator = "Mini BI Attendance";

  const matrixSheet = workbook.addWorksheet("Ma trận chấm công");
  const baseHeaders = [
    "STT",
    "Họ và tên",
    "Mã nhân sự",
    "Chi nhánh",
    "Mã chi nhánh",
    "Số ngày có check-in",
    "Tổng lượt check-in",
    "Số ngày có phép duyệt",
    "Tổng ngày phép duyệt",
    "Số ngày chưa check-in (ngoài ngày phép)",
  ];

  const dayHeaders = input.calendar_days.map((day) => {
    const dd = String(day.day_of_month).padStart(2, "0");
    const dow = MATRIX_WEEKDAY_LABELS[day.day_of_week] ?? "";
    return `${dd} (${dow})`;
  });

  const allMatrixHeaders = [...baseHeaders, ...dayHeaders];
  matrixSheet.addRow(allMatrixHeaders);
  matrixSheet.views = [{ state: "frozen", xSplit: 5, ySplit: 1 }];

  const headerRow = matrixSheet.getRow(1);
  headerRow.font = { bold: true };
  for (let col = 1; col <= allMatrixHeaders.length; col += 1) {
    matrixSheet.getColumn(col).width = col <= 5 ? 20 : col <= 10 ? 18 : 28;
    if (col >= 2 && col <= 5) {
      matrixSheet.getColumn(col).numFmt = "@";
    }
  }

  input.items.forEach((emp, index) => {
    const dayByDate = new Map<string, AttendanceMonthlyMatrixDayCellProjection>();
    for (const d of emp.days) {
      dayByDate.set(d.business_date, d);
    }

    const rowValues: Array<string | number> = [
      index + 1,
      sanitizeSpreadsheetText(emp.employee_display_name),
      sanitizeSpreadsheetText(emp.personnel_code ?? ""),
      sanitizeSpreadsheetText(emp.branch?.display_name ?? "Mặc định (HQ)"),
      sanitizeSpreadsheetText(emp.branch?.branch_code ?? "HQ"),
      emp.summary.checkin_day_count,
      emp.summary.total_checkins,
      emp.summary.approved_leave_day_count,
      emp.summary.approved_leave_units,
      emp.summary.no_checkin_without_leave_day_count,
    ];

    for (const calDay of input.calendar_days) {
      const cell = dayByDate.get(calDay.business_date);
      rowValues.push(cell ? sanitizeSpreadsheetText(formatMatrixDayCellText(cell)) : "");
    }

    const addedRow = matrixSheet.addRow(rowValues);
    addedRow.alignment = { vertical: "top", wrapText: true };

    input.calendar_days.forEach((calDay, dayIdx) => {
      const cellData = dayByDate.get(calDay.business_date);
      if (!cellData) return;
      const presentation = describeMatrixDayCell(cellData);
      const excelCell = addedRow.getCell(baseHeaders.length + dayIdx + 1);
      if (presentation.tone === "emerald") {
        excelCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFECFDF5" },
        };
      } else if (presentation.tone === "amber") {
        excelCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFFBEB" },
        };
      } else if (presentation.tone === "sky") {
        excelCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF0F9FF" },
        };
      } else {
        excelCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFEF2F2" },
        };
      }
    });
  });

  const detailSheet = workbook.addWorksheet("Chi tiết theo ngày");
  const detailHeaders = [
    "Ngày",
    "Họ và tên",
    "Mã nhân sự",
    "Chi nhánh hiện tại",
    "Trạng thái ngày",
    "Phiên bản khung giờ",
    "Mốc 1 (Sáng)",
    "Mốc 2 (Trưa)",
    "Mốc 3 (Đầu chiều)",
    "Mốc 4 (Cuối chiều)",
    "Số mốc chưa có lượt chấm",
    "Số lượt lệch khung giờ",
    "Giờ check-in đầu",
    "Giờ check-in cuối",
    "Số lượt check-in",
    "Mốc tính khoảng cách",
    "Trạng thái khoảng cách",
    "Khoảng cách (m)",
    "Nghỉ phép đã duyệt",
    "Số công phép",
  ];
  detailSheet.addRow(detailHeaders);
  detailSheet.views = [{ state: "frozen", ySplit: 1 }];
  detailSheet.getRow(1).font = { bold: true };
  for (let col = 1; col <= detailHeaders.length; col += 1) {
    detailSheet.getColumn(col).width = col >= 7 && col <= 10 ? 26 : 20;
  }
  detailSheet.getColumn(2).numFmt = "@";
  detailSheet.getColumn(3).numFmt = "@";
  detailSheet.getColumn(4).numFmt = "@";

  for (const emp of input.items) {
    for (const day of emp.days) {
      const presentation = describeMatrixDayCell(day);
      const targetLabel =
        day.distance_target_kind === "BRANCH"
          ? day.branch_code_used
            ? `Chi nhánh (${day.branch_code_used})`
            : "Chi nhánh"
          : day.distance_target_kind === "HQ"
            ? "HQ"
            : "";

      detailSheet.addRow([
        day.business_date,
        sanitizeSpreadsheetText(emp.employee_display_name),
        sanitizeSpreadsheetText(emp.personnel_code ?? ""),
        sanitizeSpreadsheetText(emp.branch?.display_name ?? "Mặc định (HQ)"),
        MATRIX_DAY_STATUS_LABELS[day.day_status],
        `v${presentation.policyVersionUsed}`,
        sanitizeSpreadsheetText(
          `${presentation.slots[0]?.targetTime ?? "08:00"}: ${presentation.slots[0]?.summaryText ?? ""}`,
        ),
        sanitizeSpreadsheetText(
          `${presentation.slots[1]?.targetTime ?? "11:00"}: ${presentation.slots[1]?.summaryText ?? ""}`,
        ),
        sanitizeSpreadsheetText(
          `${presentation.slots[2]?.targetTime ?? "13:00"}: ${presentation.slots[2]?.summaryText ?? ""}`,
        ),
        sanitizeSpreadsheetText(
          `${presentation.slots[3]?.targetTime ?? "17:00"}: ${presentation.slots[3]?.summaryText ?? ""}`,
        ),
        presentation.missingSlotCount,
        presentation.lateOrEarlyCheckinCount,
        day.first_time_local ?? "",
        day.last_time_local ?? "",
        day.checkin_count,
        sanitizeSpreadsheetText(targetLabel),
        day.distance_status ?? "",
        day.distance_meters !== null ? day.distance_meters : "",
        sanitizeSpreadsheetText(formatMatrixLeaveSummary(day)),
        day.approved_leave_units > 0 ? day.approved_leave_units : "",
      ]);
    }
  }

  const legendSheet = workbook.addWorksheet("Chú giải & Khung giờ");
  legendSheet.addRow(["CHÚ GIẢI MÀU SẮC, TRẠNG THÁI & QUY TẮC KHUNG GIỜ CHẤM CÔNG"]);
  legendSheet.getRow(1).font = { bold: true, size: 12 };
  legendSheet.addRow([]);
  legendSheet.addRow(["Nhãn trạng thái", "Ý nghĩa hiển thị", "Quy tắc rà soát cho HR HRP"]);
  legendSheet.getRow(3).font = { bold: true };
  for (const item of MATRIX_LEGEND_ITEMS) {
    legendSheet.addRow([item.badgeText, item.title, item.description]);
  }
  legendSheet.addRow([
    "Quy tắc gán mốc & tie-break",
    "Gán mọi lượt chấm về mốc gần nhất theo khoảng cách phút",
    "Không bỏ lượt chấm dư: nhiều lượt cùng gần 1 mốc sẽ hiển thị đầy đủ theo thứ tự tăng dần. Khi khoảng cách phút bằng nhau giữa 2 mốc liền kề (ví dụ 09:30 giữa 08:00 và 11:00, hoặc 12:00 giữa 11:00 và 13:00), hệ thống cố định gán về mốc sớm hơn (Mốc 1 -> Mốc 4).",
  ]);

  legendSheet.addRow([]);
  legendSheet.addRow(["CẤU HÌNH KHUNG GIỜ ÁP DỤNG TRONG THÁNG BÁO CÁO"]);
  const policyHeaderRowIdx = legendSheet.rowCount;
  legendSheet.getRow(policyHeaderRowIdx).font = { bold: true };
  legendSheet.addRow([
    "Phiên bản",
    "Hiệu lực từ ngày",
    "Hiệu lực đến ngày",
    "Mốc 1 (Sáng)",
    "Mốc 2 (Trưa)",
    "Mốc 3 (Đầu chiều)",
    "Mốc 4 (Cuối chiều)",
    "Người cấu hình",
  ]);
  legendSheet.getRow(legendSheet.rowCount).font = { bold: true };

  const monthPolicies =
    input.slot_policy?.month_policies && input.slot_policy.month_policies.length > 0
      ? input.slot_policy.month_policies
      : [DEFAULT_ATTENDANCE_SLOT_POLICY];

  for (const pol of monthPolicies) {
    const formatSlotConfig = (idx: 0 | 1 | 2 | 3) => {
      const s = pol.slots[idx]!;
      return `${s.target_time} (-${s.grace_before_minutes}p / +${s.grace_after_minutes}p)`;
    };
    legendSheet.addRow([
      `v${pol.version}`,
      pol.effective_from_date,
      pol.effective_to_date ?? "Đang mở",
      formatSlotConfig(0),
      formatSlotConfig(1),
      formatSlotConfig(2),
      formatSlotConfig(3),
      sanitizeSpreadsheetText(pol.configured_by_display_name),
    ]);
  }

  for (let col = 1; col <= 8; col += 1) {
    legendSheet.getColumn(col).width = col === 3 ? 65 : 26;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

export type AttendanceMonthlyMatrixExportSummary = Pick<
  AttendanceMonthlyMatrixReportProjection,
  "filters" | "calendar_days" | "items"
>;
