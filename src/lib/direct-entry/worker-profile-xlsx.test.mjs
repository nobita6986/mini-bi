import assert from "node:assert/strict";
import test from "node:test";

import ExcelJS from "exceljs";
import {
  createWorkerProfileTemplate,
  workerProfileXlsxToTsv,
} from "./worker-profile-xlsx.ts";
import { parseWorkerProfilePaste } from "./worker-profile-paste.ts";

function fakeFile(name, bytes) {
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ),
  };
}

async function workbookBytes(configure) {
  const workbook = new ExcelJS.Workbook();
  configure(workbook.addWorksheet("Direct Entry"));
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

test("template is versioned, has 17 H05 data headers and contains no identifiers or sample PII", async () => {
  const bytes = await createWorkerProfileTemplate();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer);
  const sheet = workbook.getWorksheet("Direct Entry");
  assert.ok(sheet);
  assert.equal(workbook.getWorksheet("_meta").state, "veryHidden");
  assert.equal(workbook.getWorksheet("_meta").getCell("B1").value, "worker-profile-xlsx/1");
  const headers = sheet.getRow(1).values.slice(1);
  // P1.7-H05: 17 data header theo dung thu tu production UI; khong co STT, Mã NLĐ, Tuổi.
  assert.equal(headers.length, 17);
  assert.equal(headers[0], "Dự án");
  assert.equal(headers[1], "Ngày bắt đầu làm việc");
  assert.equal(headers[2], "Họ và tên");
  assert.equal(headers[3], "Giới tính");
  assert.equal(headers[4], "DOB");
  assert.equal(headers[5], "CMT/CCCD");
  assert.equal(headers[6], "Ngày cấp");
  assert.equal(headers[7], "Nơi cấp");
  assert.equal(headers[8], "Địa chỉ");
  assert.equal(headers[9], "Số điện thoại");
  // P1.7-H05: HRP/Vendor va Nguoi tuyen / Vendor la 2 cot lien tiep trong XLSX
  // (de nguoi dung khai provider truoc, recruiter sau).
  assert.equal(headers[10], "HRP/Vendor");
  assert.equal(headers[11], "Người tuyển / Vendor");
  // Header phai la ten cot canonical; "Chính thức" la gia tri dropdown.
  assert.equal(headers[12], "Loại hình LĐ");
  assert.equal(headers[13], "STK");
  assert.equal(headers[14], "Tên ngân hàng");
  assert.equal(headers[15], "Tên chủ tài khoản");
  assert.equal(headers[16], "Ghi chú");
  // P1.7-H05: KHONG co STT/Mã NLĐ/Tuổi/status/action tren XLSX template.
  for (const banned of ["STT", "Mã NLĐ", "Tuổi", "Trạng thái", "Hồ sơ CCCD",
    "Thao tác", "Tình trạng làm việc hiện tại"]) {
    assert.equal(headers.includes(banned), false, banned);
  }
  // STK phai co text format de giu so 0 dau.
  const stkColumn = headers.indexOf("STK") + 1;
  assert.equal(sheet.getColumn(stkColumn).numFmt, "@");
  // CMT/CCCD cung phai text format de giu so 0 dau neu Excel doc nhan dang so.
  const cccdColumn = headers.indexOf("CMT/CCCD") + 1;
  assert.equal(sheet.getColumn(cccdColumn).numFmt, "@");
  // Data validation cho Gioi tinh va Loai hinh LĐ.
  const genderColumn = headers.indexOf("Giới tính") + 1;
  assert.deepEqual(
    sheet.getCell(2, genderColumn).dataValidation,
    { type: "list", allowBlank: true, formulae: ['"Nam,Nữ"'] },
  );
  const laborColumn = headers.indexOf("Loại hình LĐ") + 1;
  assert.deepEqual(
    sheet.getCell(2, laborColumn).dataValidation,
    { type: "list", allowBlank: true, formulae: ['"Thời vụ,Chính thức"'] },
  );
  // Data validation cells nam tren row 2 nen rowCount = 2 (header row + validation
  // template row); khong co sample data that.
  assert.equal(sheet.rowCount, 2);
  // Row 2 chi co data validation, khong co gia tri mau.
  for (let column = 1; column <= headers.length; column += 1) {
    const cell = sheet.getRow(2).getCell(column);
    assert.equal(cell.value, null, `row 2 column ${column} khong co gia tri mau`);
  }
});

test("generated template round-trips through the production XLSX and paste parsers", async () => {
  const template = await createWorkerProfileTemplate();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(template.buffer.slice(
    template.byteOffset,
    template.byteOffset + template.byteLength,
  ));
  const sheet = workbook.getWorksheet("Direct Entry");
  assert.ok(sheet);
  sheet.getRow(2).values = [
    "Synthetic Project",
    "2026-10-06",
    "Synthetic Worker",
    "Nam",
    "1995-04-03",
    "012345678901",
    "2020-01-02",
    "Bộ Công An",
    "Synthetic Address",
    "0912345678",
    "HRP",
    "synthetic-recruiter-id",
    "Chính thức",
    "000012345678",
    "Synthetic Bank",
    "Synthetic Worker",
    "Synthetic Note",
  ];
  const filled = new Uint8Array(await workbook.xlsx.writeBuffer());

  const imported = await workerProfileXlsxToTsv(fakeFile("direct-entry-template.xlsx", filled));
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  assert.equal(imported.rowCount, 1);

  const parsed = parseWorkerProfilePaste({
    text: imported.text,
    referenceDate: "2026-10-06",
    employeeCodeMode: "server-generated",
  });
  assert.equal(parsed.errorCount, 0, JSON.stringify(parsed.issues));
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.canProceed, true);
  assert.equal(parsed.rows[0].employee_code, "");
  assert.equal(parsed.rows[0].project_label, "Synthetic Project");
  assert.equal(parsed.rows[0].recruiter_label, "synthetic-recruiter-id");
  assert.equal(parsed.rows[0].labor_type, "PERMANENT");
  assert.equal(parsed.rows[0].derived.provider_hint, "HRP");
  assert.deepEqual(parsed.rows[0].worker.gender, { state: "provided", value: "MALE" });
  assert.deepEqual(parsed.rows[0].payment.account_number,
    { state: "provided", value: "000012345678" });
});

test("previously downloaded H05 template also imports without requiring a re-download", async () => {
  const bytes = await workbookBytes((sheet) => {
    sheet.addRow([
      "Dự án", "Ngày bắt đầu làm việc", "Họ và tên", "Giới tính", "DOB", "CMT/CCCD",
      "Ngày cấp", "Nơi cấp", "Địa chỉ", "Số điện thoại", "HRP/Vendor",
      "Người tuyển / Vendor", "Chính thức", "STK", "Tên ngân hàng",
      "Tên chủ tài khoản", "Ghi chú",
    ]);
    sheet.addRow([
      "Synthetic Project", "2026-10-06", "Synthetic Worker", "Nữ", "", "", "", "", "",
      "", "HRP", "synthetic-recruiter-id", "Thời vụ", "", "", "", "",
    ]);
  });
  const imported = await workerProfileXlsxToTsv(fakeFile("old-direct-entry-template.xlsx", bytes));
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const parsed = parseWorkerProfilePaste({
    text: imported.text,
    referenceDate: "2026-10-06",
    employeeCodeMode: "server-generated",
  });
  assert.equal(parsed.errorCount, 0, JSON.stringify(parsed.issues));
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].labor_type, "TEMPORARY");
  assert.deepEqual(parsed.rows[0].worker.gender, { state: "provided", value: "FEMALE" });
});

test("imports 17-field H05 sheet and drops legacy Mã NLĐ column when present", async () => {
  const bytes = await workbookBytes((sheet) => {
    // Legacy XLSX them cot "Mã NLĐ" o dau de test import KHONG prepend cot
    // do vao output va giu dung vi tri data.
    sheet.addRow(["Mã NLĐ", "Dự án", "Ngày bắt đầu làm việc", "Họ và tên",
      "Tên NV Tuyển dụng", "Loại hình LĐ", "STK"]);
    sheet.addRow(["", "Synthetic Project", "2025-03-04", "Synthetic Worker",
      "Synthetic Recruiter", "Thời vụ", "000012345678"]);
  });
  const result = await workerProfileXlsxToTsv(fakeFile("synthetic.xlsx", bytes));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.rowCount, 1);
    // Output KHONG prepend "Mã NLĐ" - H05 contract.
    assert.equal(result.text.startsWith("Mã NLĐ\t"), false);
    assert.match(result.text, /^Dự án\tNgày bắt đầu làm việc\t/);
    // STK la text nen giu so 0 dau.
    assert.match(result.text, /\t000012345678$/);
  }
});

test("rejects formulas and numeric sensitive identifiers rather than silently losing zeros", async () => {
  const formulaBytes = await workbookBytes((sheet) => {
    sheet.addRow(["Dự án", "Ngày bắt đầu làm việc", "Họ và tên", "Tên NV Tuyển dụng",
      "Loại hình LĐ"]);
    sheet.addRow([{ formula: "1+1", result: 2 }, "2025-03-04", "Synthetic Worker",
      "Synthetic Recruiter", "Thời vụ"]);
  });
  assert.deepEqual(
    await workerProfileXlsxToTsv(fakeFile("formula.xlsx", formulaBytes)),
    { ok: false, code: "XLSX_CELL_UNSUPPORTED" },
  );

  const numericIdBytes = await workbookBytes((sheet) => {
    sheet.addRow(["Dự án", "Ngày bắt đầu làm việc", "Họ và tên", "Tên NV Tuyển dụng",
      "Loại hình LĐ", "STK"]);
    sheet.addRow(["Synthetic Project", "2025-03-04", "Synthetic Worker",
      "Synthetic Recruiter", "Thời vụ", 123456]);
  });
  assert.deepEqual(
    await workerProfileXlsxToTsv(fakeFile("numeric-id.xlsx", numericIdBytes)),
    { ok: false, code: "XLSX_CELL_UNSUPPORTED" },
  );
});
