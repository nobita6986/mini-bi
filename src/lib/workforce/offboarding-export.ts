import ExcelJS from "exceljs";
import type { OffboardingReportExport } from "./offboarding-report-contract.ts";

const CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function offboardingExportFilename(authorizationDate: string): string {
  return `bao-cao-nld-nghi-viec-${authorizationDate}.xlsx`;
}

/**
 * Excel export for the offboarding report. May include the full phone number for the
 * authorized all-scope audience, but NEVER includes the CCCD (the RPC does not return it).
 */
export async function buildOffboardingExcel(data: OffboardingReportExport): Promise<Response> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Báo cáo NLĐ nghỉ việc", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "Họ tên", key: "display_name", width: 28 },
    { header: "Mã NLĐ", key: "employee_code", width: 20 },
    { header: "Dự án / công việc cuối", key: "project_display", width: 32 },
    { header: "Người tuyển cuối", key: "recruiter_display", width: 28 },
    { header: "Ngày nghỉ việc", key: "off_effective_date", width: 16 },
    { header: "Số ngày đã nghỉ", key: "days_since_off", width: 14 },
    { header: "Số điện thoại", key: "phone", width: 16 },
  ];

  for (const item of data.items) {
    sheet.addRow({
      display_name: item.display_name,
      employee_code: item.employee_code,
      project_display: item.project_display,
      recruiter_display: item.recruiter_display,
      off_effective_date: item.off_effective_date,
      days_since_off: item.days_since_off,
      phone: item.phone ?? "",
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const body = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer as ArrayBuffer);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${offboardingExportFilename(data.authorization_date)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
