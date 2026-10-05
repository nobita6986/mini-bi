import assert from "node:assert/strict";
import test from "node:test";

import ExcelJS from "exceljs";
import {
  createWorkerProfileTemplate,
  workerProfileXlsxToTsv,
} from "./worker-profile-xlsx.ts";

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
  // P1.7-H05: Loai hinh LĐ hien thi label "Chính thức" tren XLSX template (UI H05).
  assert.equal(headers[12], "Chính thức");
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
  const laborColumn = headers.indexOf("Chính thức") + 1;
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
