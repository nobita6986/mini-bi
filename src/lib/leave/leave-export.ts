export const LEAVE_EXPORT_XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const LEAVE_EXPORT_COLUMNS = [
  { key: "personnel_code", header: "Mã nhân sự", width: 16 },
  { key: "display_name", header: "Họ và tên", width: 26 },
  { key: "login_id", header: "Tài khoản", width: 18 },
  { key: "unit_kind", header: "Khối / Bộ phận", width: 18 },
  { key: "team_name", header: "Nhóm (Team)", width: 22 },
  { key: "employment_status", header: "Trạng thái nhân sự", width: 20 },
  { key: "work_start_date", header: "Ngày vào làm", width: 16 },
  { key: "official_effective_date", header: "Ngày lên chính thức", width: 18 },
  { key: "month_paid_days", header: "Nghỉ có phép trong tháng (ngày)", width: 26 },
  { key: "month_unpaid_probation_days", header: "Nghỉ thử việc không lương (ngày)", width: 28 },
  { key: "month_unpaid_other_days", header: "Nghỉ chưa cấu hình/không lương (ngày)", width: 32 },
  { key: "month_pending_days", header: "Đang chờ duyệt trong tháng (ngày)", width: 28 },
  { key: "carry_over_granted_days", header: "Phép năm trước chuyển sang (ngày)", width: 28 },
  { key: "monthly_accrued_days", header: "Phép tích lũy trong năm (ngày)", width: 26 },
  { key: "seniority_granted_days", header: "Phép thâm niên (ngày)", width: 22 },
  { key: "consumed_days", header: "Đã dùng trong năm (ngày)", width: 24 },
  { key: "reserved_days", header: "Giữ chỗ đơn đã duyệt (ngày)", width: 26 },
  { key: "expired_days", header: "Phép chuyển năm hết hạn (ngày)", width: 28 },
  { key: "available_days", header: "Số dư phép khả dụng (ngày)", width: 26 },
] as const;

function formatHalfDayUnitsAsDays(units: unknown): string {
  const n = Number(units ?? 0);
  if (!Number.isFinite(n)) return "0";
  const days = n / 2;
  return Number.isInteger(days) ? String(days) : days.toFixed(1);
}

function safeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function leaveMonthlyReportFilename(yearMonth: string): string {
  const safe = /^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)
    ? yearMonth
    : new Date().toISOString().slice(0, 7);
  return `bao-cao-nghi-phep-thang-${safe}.xlsx`;
}

export async function buildLeaveMonthlyReportXlsx(
  reportPayload: Record<string, unknown>,
): Promise<Uint8Array> {
  const imported = await import("exceljs");
  const excel = imported.default;
  const workbook = new excel.Workbook();
  workbook.creator = "Mini BI - Leave Management";

  const yearMonth = safeText(reportPayload.year_month || "");
  const sheet = workbook.addWorksheet(`Nghỉ phép ${yearMonth || "Tháng"}`);
  sheet.addRow(LEAVE_EXPORT_COLUMNS.map((c) => c.header));
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  for (let i = 1; i <= LEAVE_EXPORT_COLUMNS.length; i += 1) {
    sheet.getColumn(i).width = LEAVE_EXPORT_COLUMNS[i - 1].width;
    sheet.getRow(1).getCell(i).font = { bold: true };
  }

  const rawRows = Array.isArray(reportPayload.rows) ? reportPayload.rows : [];
  for (const rawRow of rawRows) {
    if (!rawRow || typeof rawRow !== "object") continue;
    const row = rawRow as Record<string, unknown>;
    const account =
      row.account && typeof row.account === "object"
        ? (row.account as Record<string, unknown>)
        : {};
    const routing =
      row.routing && typeof row.routing === "object"
        ? (row.routing as Record<string, unknown>)
        : {};
    const balance =
      row.balance && typeof row.balance === "object"
        ? (row.balance as Record<string, unknown>)
        : {};

    const values = [
      safeText(account.personnel_code),
      safeText(account.display_name),
      safeText(account.login_id),
      safeText(row.unit_kind),
      safeText(routing.team_name ?? routing.team_code),
      safeText(row.employment_status),
      safeText(row.work_start_date),
      safeText(row.official_effective_date),
      formatHalfDayUnitsAsDays(row.month_paid_leave_units),
      formatHalfDayUnitsAsDays(row.month_unpaid_probation_units),
      formatHalfDayUnitsAsDays(row.month_unpaid_other_units),
      formatHalfDayUnitsAsDays(row.month_pending_units),
      formatHalfDayUnitsAsDays(balance.carry_over_granted_units),
      formatHalfDayUnitsAsDays(balance.monthly_accrued_units),
      formatHalfDayUnitsAsDays(balance.seniority_granted_units),
      formatHalfDayUnitsAsDays(balance.consumed_units),
      formatHalfDayUnitsAsDays(balance.reserved_units),
      formatHalfDayUnitsAsDays(balance.expired_units),
      formatHalfDayUnitsAsDays(balance.available_units),
    ];

    const added = sheet.addRow(values);
    for (let i = 1; i <= values.length; i += 1) {
      added.getCell(i).numFmt = "@";
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}
