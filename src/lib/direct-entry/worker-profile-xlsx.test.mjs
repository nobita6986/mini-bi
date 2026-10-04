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

test("template is versioned and contains no identifiers or sample PII", async () => {
  const bytes = await createWorkerProfileTemplate();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer);
  const sheet = workbook.getWorksheet("Direct Entry");
  assert.ok(sheet);
  assert.equal(workbook.getWorksheet("_meta").state, "veryHidden");
  assert.equal(workbook.getWorksheet("_meta").getCell("B1").value, "worker-profile-xlsx/1");
  const headers = sheet.getRow(1).values.slice(1);
  assert.ok(headers.includes("Mã NLĐ"));
  assert.ok(headers.includes("STK"));
  assert.equal(sheet.rowCount, 1);
});

test("imports strict scalar cells while injecting server-generated employee-code column", async () => {
  const bytes = await workbookBytes((sheet) => {
    sheet.addRow(["Dự án", "Ngày bắt đầu làm việc", "Họ và tên", "Tên NV Tuyển dụng",
      "Loại hình LĐ", "STK"]);
    sheet.addRow(["Synthetic Project", "2025-03-04", "Synthetic Worker",
      "Synthetic Recruiter", "Thời vụ", "000012345678"]);
  });
  const result = await workerProfileXlsxToTsv(fakeFile("synthetic.xlsx", bytes));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.rowCount, 1);
    assert.match(result.text, /^Mã NLĐ\tDự án/);
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
