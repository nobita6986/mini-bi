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

test("template is versioned, has 16 R3 data headers and contains no identifiers or sample PII", async () => {
  const bytes = await createWorkerProfileTemplate();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer);
  const sheet = workbook.getWorksheet("Direct Entry");
  assert.ok(sheet);
  assert.equal(workbook.getWorksheet("_meta").state, "veryHidden");
  assert.equal(workbook.getWorksheet("_meta").getCell("B1").value, "worker-profile-xlsx/1");
  const headers = sheet.getRow(1).values.slice(1);
  // P3-W07C-R3: 16 data header. Thứ tự production UI đồng bộ với grid:
  //   Dự án → HRP/Vendor → Người tuyển / Vendor → Loại hình LĐ
  //   → Ngày bắt đầu làm việc → Họ và tên → …
  // Cột `Nơi cấp` đã bỏ (server-authoritative migration #46 ghi "Bộ Công An").
  assert.equal(headers.length, 16);
  assert.equal(headers[0], "Dự án");
  assert.equal(headers[1], "HRP/Vendor");
  assert.equal(headers[2], "Người tuyển / Vendor");
  assert.equal(headers[3], "Loại hình LĐ");
  assert.equal(headers[4], "Ngày bắt đầu làm việc");
  assert.equal(headers[5], "Họ và tên");
  assert.equal(headers[6], "Giới tính");
  assert.equal(headers[7], "DOB");
  assert.equal(headers[8], "CMT/CCCD");
  assert.equal(headers[9], "Ngày cấp");
  assert.equal(headers.includes("Nơi cấp"), false, "Nơi cấp khong con trong template moi");
  assert.equal(headers[10], "Địa chỉ");
  assert.equal(headers[11], "Số điện thoại");
  assert.equal(headers[12], "STK");
  assert.equal(headers[13], "Tên ngân hàng");
  assert.equal(headers[14], "Tên chủ tài khoản");
  assert.equal(headers[15], "Ghi chú");
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
  // P3-W07C-R3: template mới 16 cột, thứ tự: Dự án → HRP/Vendor → Người tuyển
  // / Vendor → Loại hình LĐ → Ngày bắt đầu làm việc → Họ và tên → …
  // Server-authoritative migration #46 sẽ ghi "Bộ Công An" khi RPC create-batch
  // xử lý row này.
  sheet.getRow(2).values = [
    "Synthetic Project",   // Dự án
    "HRP",                 // HRP/Vendor
    "synthetic-recruiter-id", // Người tuyển / Vendor
    "Chính thức",          // Loại hình LĐ
    "2026-10-06",          // Ngày bắt đầu làm việc
    "Synthetic Worker",    // Họ và tên
    "Nam",                 // Giới tính
    "1995-04-03",          // DOB
    "012345678901",        // CMT/CCCD
    "2020-01-02",          // Ngày cấp
    "Synthetic Address",   // Địa chỉ
    "0912345678",          // Số điện thoại
    "000012345678",        // STK
    "Synthetic Bank",      // Tên ngân hàng
    "Synthetic Worker",    // Tên chủ tài khoản
    "Synthetic Note",      // Ghi chú
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

test("R3 template (16 headers, khong co Nơi cấp) round-trips through XLSX and paste parsers", async () => {
  // Template mới tải xuống (16 cột) KHÔNG có cột Nơi cấp. Người dùng
  // không thể gửi giá trị cho trường này qua Excel; server-authoritative
  // migration #46 sẽ ghi "Bộ Công An" cho mỗi entry mới.
  const template = await createWorkerProfileTemplate();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(template.buffer.slice(
    template.byteOffset,
    template.byteOffset + template.byteLength,
  ));
  const sheet = workbook.getWorksheet("Direct Entry");
  assert.ok(sheet);
  const headers = sheet.getRow(1).values.slice(1);
  assert.equal(headers.length, 16);
  // Thứ tự: Dự án → HRP/Vendor → Người tuyển / Vendor → Loại hình LĐ
  //   → Ngày bắt đầu làm việc → Họ và tên → Giới tính → …
  sheet.getRow(2).values = [
    "Synthetic Project",   // Dự án
    "HRP",                 // HRP/Vendor
    "synthetic-recruiter-id", // Người tuyển / Vendor
    "Thời vụ",             // Loại hình LĐ
    "2026-10-06",          // Ngày bắt đầu làm việc
    "Synthetic Worker",    // Họ và tên
    "Nữ",                  // Giới tính
    "", "", "", "", "", "", "", "", "",
  ];
  const filled = new Uint8Array(await workbook.xlsx.writeBuffer());
  const imported = await workerProfileXlsxToTsv(fakeFile("r3-template.xlsx", filled));
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

test("rejects legacy 17-column H05 template (con cot Nơi cấp) as XLSX_INVALID", async () => {
  // P3-W07C-R3: KHONG con tuong thich nguoc voi file Excel mau cu. File cu
  // (17 header, con cot `Nơi cấp`) phai tra XLSX_INVALID ro rang de nguoi
  // dung tai lai mau moi 16 header.
  const bytes = await workbookBytes((sheet) => {
    sheet.addRow([
      "Dự án", "Ngày bắt đầu làm việc", "Họ và tên", "Giới tính", "DOB", "CMT/CCCD",
      "Ngày cấp", "Nơi cấp", "Địa chỉ", "Số điện thoại", "HRP/Vendor",
      "Người tuyển / Vendor", "Loại hình LĐ", "STK", "Tên ngân hàng",
      "Tên chủ tài khoản", "Ghi chú",
    ]);
    sheet.addRow([
      "Synthetic Project", "2026-10-06", "Synthetic Worker", "Nữ", "", "", "", "Hà Nội", "",
      "", "HRP", "synthetic-recruiter-id", "Thời vụ", "", "", "", "",
    ]);
  });
  assert.deepEqual(
    await workerProfileXlsxToTsv(fakeFile("old-direct-entry-template.xlsx", bytes)),
    { ok: false, code: "XLSX_INVALID" },
    "legacy 17-header H05 template (con cot Nơi cấp) phai bi tu choi");
});

test("rejects legacy sheet them cot Mã NLĐ o dau", async () => {
  // P3-W07C-R3: KHONG con tuong thich nguoc; file cu them cot "Mã NLĐ"
  // o dau (H05 contract) cung phai tra XLSX_INVALID.
  const bytes = await workbookBytes((sheet) => {
    sheet.addRow(["Mã NLĐ", "Dự án", "Ngày bắt đầu làm việc", "Họ và tên",
      "Tên NV Tuyển dụng", "Loại hình LĐ", "STK"]);
    sheet.addRow(["", "Synthetic Project", "2025-03-04", "Synthetic Worker",
      "Synthetic Recruiter", "Thời vụ", "000012345678"]);
  });
  assert.deepEqual(
    await workerProfileXlsxToTsv(fakeFile("legacy-with-employee-code.xlsx", bytes)),
    { ok: false, code: "XLSX_INVALID" },
    "legacy sheet them cot Mã NLĐ o dau phai bi tu choi");
});

test("rejects formulas and numeric sensitive identifiers rather than silently losing zeros", async () => {
  // P3-W07C-R3: parser/importer yêu cầu header đúng 16 cột theo thứ tự
  // template mới. Test này dùng template mới để xác nhận formula / numeric
  // identifiers vẫn fail-closed với code `XLSX_CELL_UNSUPPORTED` chứ
  // không bị nuốt thành `XLSX_INVALID` (header mismatch).
  const template = await createWorkerProfileTemplate();
  const templateWorkbook = new ExcelJS.Workbook();
  await templateWorkbook.xlsx.load(template.buffer.slice(
    template.byteOffset,
    template.byteOffset + template.byteLength,
  ));
  const templateSheet = templateWorkbook.getWorksheet("Direct Entry");
  const headers = templateSheet.getRow(1).values.slice(1);

  const formulaWorkbook = new ExcelJS.Workbook();
  formulaWorkbook.addWorksheet("Direct Entry");
  const formulaSheet = formulaWorkbook.getWorksheet("Direct Entry");
  formulaSheet.addRow(headers);
  // Thứ tự: Dự án → HRP/Vendor → Người tuyển / Vendor → Loại hình LĐ
  //   → Ngày bắt đầu làm việc → Họ và tên → Giới tính → …
  // Cot dau tien (Dự án) chua formula de test fail-closed.
  formulaSheet.addRow([
    { formula: "1+1", result: 2 }, // Dự án (formula => XLSX_CELL_UNSUPPORTED)
    "HRP",                          // HRP/Vendor
    "synthetic-recruiter-id",       // Người tuyển / Vendor
    "Chính thức",                   // Loại hình LĐ
    "2025-03-04",                   // Ngày bắt đầu làm việc
    "Synthetic Worker",             // Họ và tên
    "Nam",                          // Giới tính
    "1995-04-03",                   // DOB
    "012345678901",                 // CMT/CCCD
    "2020-01-02",                   // Ngày cấp
    "Synthetic Address",            // Địa chỉ
    "0912345678",                   // Số điện thoại
    "000012345678",                 // STK
    "Synthetic Bank",               // Tên ngân hàng
    "Synthetic Worker",             // Tên chủ tài khoản
    "Synthetic Note",               // Ghi chú
  ]);
  const formulaBytes = new Uint8Array(await formulaWorkbook.xlsx.writeBuffer());
  assert.deepEqual(
    await workerProfileXlsxToTsv(fakeFile("formula.xlsx", formulaBytes)),
    { ok: false, code: "XLSX_CELL_UNSUPPORTED" },
  );

  const numericIdWorkbook = new ExcelJS.Workbook();
  numericIdWorkbook.addWorksheet("Direct Entry");
  const numericIdSheet = numericIdWorkbook.getWorksheet("Direct Entry");
  numericIdSheet.addRow(headers);
  // STK (text identifier) phai la so nguyen nhan dang numeric 123456
  // de test fail-closed.
  numericIdSheet.addRow([
    "Synthetic Project",            // Dự án
    "HRP",                          // HRP/Vendor
    "synthetic-recruiter-id",       // Người tuyển / Vendor
    "Chính thức",                   // Loại hình LĐ
    "2025-03-04",                   // Ngày bắt đầu làm việc
    "Synthetic Worker",             // Họ và tên
    "Nam",                          // Giới tính
    "1995-04-03",                   // DOB
    "012345678901",                 // CMT/CCCD
    "2020-01-02",                   // Ngày cấp
    "Synthetic Address",            // Địa chỉ
    "0912345678",                   // Số điện thoại
    123456,                         // STK (numeric => XLSX_CELL_UNSUPPORTED)
    "Synthetic Bank",               // Tên ngân hàng
    "Synthetic Worker",             // Tên chủ tài khoản
    "Synthetic Note",               // Ghi chú
  ]);
  const numericIdBytes = new Uint8Array(await numericIdWorkbook.xlsx.writeBuffer());
  assert.deepEqual(
    await workerProfileXlsxToTsv(fakeFile("numeric-id.xlsx", numericIdBytes)),
    { ok: false, code: "XLSX_CELL_UNSUPPORTED" },
  );
});
