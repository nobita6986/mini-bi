import "server-only";

import type { VendorFinanceExportVendorItem } from "./vendor-finance-contract.ts";

export const VENDOR_FINANCE_EXPORT_XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const VENDOR_FINANCE_EXPORT_WORKSHEET_NAME = "Danh sách Vendor";

export const VENDOR_FINANCE_EXPORT_COLUMNS = [
  { key: "stt", header: "STT", width: 8 },
  { key: "vendor_id", header: "Mã Vendor", width: 20 },
  { key: "display_name", header: "Tên Vendor", width: 34 },
  { key: "status_label", header: "Trạng thái", width: 18 },
  { key: "sub_ledger_count", header: "Số sổ dự án", width: 14 },
  { key: "payable_total_minor", header: "Công nợ phải trả (VND)", width: 24 },
  { key: "shared_advance_balance_minor", header: "Số dư ứng dùng chung (VND)", width: 26 },
  { key: "last_effective_date", header: "Ngày giao dịch gần nhất", width: 22 },
] as const;

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const FORMULA_TRIGGER_RE = /^[\s]*[=+\-@]/;

function sanitizeExportText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const cleaned = value.replace(CONTROL_CHARS_RE, "");
  return FORMULA_TRIGGER_RE.test(cleaned) ? `'${cleaned}` : cleaned;
}

function sanitizeCanonicalMinorString(value: string): string {
  const cleaned = sanitizeExportText(value).trim();
  if (!/^(?:0|-?[1-9][0-9]{0,18})$/.test(cleaned)) {
    return "0";
  }
  return BigInt(cleaned).toString();
}

export async function buildVendorFinanceExportXlsx(
  vendors: readonly VendorFinanceExportVendorItem[],
): Promise<Uint8Array> {
  const imported = await import("exceljs");
  const excel = imported.default;
  const workbook = new excel.Workbook();
  workbook.creator = "Vendor Finance";
  const sheet = workbook.addWorksheet(VENDOR_FINANCE_EXPORT_WORKSHEET_NAME);

  sheet.addRow(VENDOR_FINANCE_EXPORT_COLUMNS.map((col) => col.header));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (let index = 1; index <= VENDOR_FINANCE_EXPORT_COLUMNS.length; index += 1) {
    sheet.getColumn(index).width = VENDOR_FINANCE_EXPORT_COLUMNS[index - 1].width;
    sheet.getRow(1).getCell(index).font = { bold: true };
  }

  vendors.forEach((vendor, rowIndex) => {
    const rowValues: string[] = [
      String(rowIndex + 1),
      sanitizeExportText(vendor.vendor_id),
      sanitizeExportText(vendor.display_name),
      vendor.active ? "Đang hoạt động" : "Ngừng hoạt động",
      String(vendor.sub_ledger_count),
      sanitizeCanonicalMinorString(vendor.payable_total_minor),
      sanitizeCanonicalMinorString(vendor.shared_advance_balance_minor),
      sanitizeExportText(vendor.last_effective_date),
    ];
    const added = sheet.addRow(rowValues);
    for (let colIdx = 1; colIdx <= VENDOR_FINANCE_EXPORT_COLUMNS.length; colIdx += 1) {
      const cell = added.getCell(colIdx);
      cell.value = rowValues[colIdx - 1];
      cell.numFmt = "@";
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

/** Safe filename without PII or vendor names. */
export function vendorFinanceExportFilename(authorizationDate?: string | null): string {
  const safe =
    typeof authorizationDate === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(authorizationDate)
      ? authorizationDate
      : new Date().toISOString().slice(0, 10);
  return `danh-sach-vendor-cong-no-${safe}.xlsx`;
}
