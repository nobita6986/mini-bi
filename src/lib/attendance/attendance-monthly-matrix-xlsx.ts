import type {
  AttendanceMatrixLeaveSessionCode,
  AttendanceMatrixLeaveType,
  AttendanceMonthlyMatrixCalendarDayProjection,
  AttendanceMonthlyMatrixDayCellProjection,
  AttendanceMonthlyMatrixEmployeeRowProjection,
  AttendanceMonthlyMatrixReportProjection,
} from "./attendance-monthly-matrix-contract.ts";

const DAY_OF_WEEK_LABELS: Readonly<Record<number, string>> = {
  1: "T2",
  2: "T3",
  3: "T4",
  4: "T5",
  5: "T6",
  6: "T7",
  7: "CN",
};

const LEAVE_TYPE_LABELS: Readonly<Record<AttendanceMatrixLeaveType, string>> = {
  ANNUAL: "Phép năm",
  MATERNITY: "Thai sản",
  UNPAID: "Không lương",
};

const SESSION_LABELS: Readonly<Record<AttendanceMatrixLeaveSessionCode, string>> = {
  FULL: "Cả ngày",
  AM: "Sáng",
  PM: "Chiều",
};

const DAY_STATUS_LABELS: Readonly<Record<AttendanceMonthlyMatrixDayCellProjection["day_status"], string>> =
  {
    CHECKED_IN: "Có check-in",
    APPROVED_LEAVE: "Nghỉ phép đã duyệt",
    CHECKED_IN_AND_LEAVE: "Có check-in + Nghỉ phép",
    NO_CHECKIN: "Chưa check-in",
  };

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
      const typeLabel = LEAVE_TYPE_LABELS[item.leave_type] ?? item.leave_type;
      const sessionLabel = SESSION_LABELS[item.session_code] ?? item.session_code;
      return `${typeLabel} (${sessionLabel})`;
    })
    .join("; ");
}

export function formatMatrixDayCellText(cell: AttendanceMonthlyMatrixDayCellProjection): string {
  const parts: string[] = [];

  if (cell.has_checkin) {
    const firstTime = cell.first_time_local ?? "--:--";
    const lastTime = cell.last_time_local ?? firstTime;
    const timePart =
      cell.checkin_count > 1 && lastTime !== firstTime
        ? `${firstTime}-${lastTime} (${cell.checkin_count})`
        : cell.checkin_count > 1
          ? `${firstTime} (${cell.checkin_count})`
          : firstTime;

    let distancePart = "";
    const targetPrefix =
      cell.distance_target_kind === "BRANCH"
        ? cell.branch_code_used
          ? `CN:${cell.branch_code_used}`
          : "CN"
        : "HQ";

    if (cell.distance_status === "COMPUTED" && cell.distance_meters !== null) {
      distancePart = ` [${targetPrefix} ${Math.round(cell.distance_meters)}m]`;
    } else if (cell.distance_status === "BRANCH_NOT_CONFIGURED") {
      distancePart = ` [${targetPrefix} chưa có tọa độ]`;
    } else if (cell.distance_status === "HQ_NOT_CONFIGURED") {
      distancePart = " [HQ chưa có tọa độ]";
    } else if (cell.distance_status === "INVALID_GPS") {
      distancePart = " [GPS không hợp lệ]";
    }

    parts.push(`${timePart}${distancePart}`);
  }

  if (cell.has_approved_leave) {
    const leaveText = formatMatrixLeaveSummary(cell);
    parts.push(leaveText ? `Nghỉ: ${leaveText}` : `Nghỉ (${cell.approved_leave_units} ngày)`);
  }

  return parts.join(" | ");
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
    const dow = DAY_OF_WEEK_LABELS[day.day_of_week] ?? "";
    return `${dd} (${dow})`;
  });

  const allMatrixHeaders = [...baseHeaders, ...dayHeaders];
  matrixSheet.addRow(allMatrixHeaders);
  matrixSheet.views = [{ state: "frozen", xSplit: 5, ySplit: 1 }];

  const headerRow = matrixSheet.getRow(1);
  headerRow.font = { bold: true };
  for (let col = 1; col <= allMatrixHeaders.length; col += 1) {
    matrixSheet.getColumn(col).width = col <= 5 ? 20 : col <= 10 ? 18 : 22;
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

    matrixSheet.addRow(rowValues);
  });

  const detailSheet = workbook.addWorksheet("Chi tiết theo ngày");
  const detailHeaders = [
    "Ngày",
    "Họ và tên",
    "Mã nhân sự",
    "Chi nhánh hiện tại",
    "Trạng thái ngày",
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
    detailSheet.getColumn(col).width = 20;
  }
  detailSheet.getColumn(2).numFmt = "@";
  detailSheet.getColumn(3).numFmt = "@";
  detailSheet.getColumn(4).numFmt = "@";

  for (const emp of input.items) {
    for (const day of emp.days) {
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
        DAY_STATUS_LABELS[day.day_status],
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

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

export type AttendanceMonthlyMatrixExportSummary = Pick<
  AttendanceMonthlyMatrixReportProjection,
  "filters" | "calendar_days" | "items"
>;
