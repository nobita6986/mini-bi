import assert from "node:assert/strict";
import test from "node:test";

import { EXCEL_PASTE_MAX_ROWS, parseExcelPaste } from "./excel-paste.ts";

function tsv(lines) { return lines.join("\n"); }

test("TSV nhieu dong, header, CRLF/LF, trailing blank, leading zero", () => {
  const text = [
    "Mã NLĐ\tNgày đầu tiên đi làm\tHọ tên\tDự án\tNgười tuyển\tLoại hình lao động",
    "000123\t2026-10-15\tNguyen Van A\tp-01\tr-01\tThời vụ",
    "000124\t15/10/2026\tNguyen Van B\tp-02\tr-02\tToàn thời gian",
    "",
  ].join("\r\n");
  const result = parseExcelPaste(text);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].employee_code, "000123");
  assert.equal(result.rows[0].first_work_date, "2026-10-15");
  assert.equal(result.rows[0].labor_type, "TEMPORARY");
  assert.equal(result.rows[1].first_work_date, "2026-10-15");
  assert.equal(result.rows[1].labor_type, "PERMANENT");
  assert.equal(result.rows[0].worker_display_name, "Nguyen Van A");
  assert.equal(result.rows[0].project, "p-01");
  assert.equal(result.rows[0].recruiter, "r-01");
});

test("sai cot (5/7), ngay loi, labor loi, duplicate, empty", () => {
  const bad = tsv([
    "000123\t2026-10-15\tA\tp\tr\tThời vụ",
    "000124\t31/02/2026\tB\tp\tr\tThời vụ",
    "000125\t2026-10-15\tC\tp\tr\tKhông rõ",
    "000126\t2026-10-15\tD\tp\tr",
    "000123\t2026-10-16\tE\tp\tr\tThời vụ",
    "000127\t2026-10-15\tF\tp\tr\tThời vụ\tTHUA",
  ]);
  const result = parseExcelPaste(bad);
  assert.equal(result.ok, false);
  const messages = result.errors.map((e) => e.message);
  assert.ok(messages.some((m) => m.includes("6 cột")));
  assert.ok(messages.some((m) => m.includes("ngày")));
  assert.ok(messages.some((m) => m.includes("Loại hình")));
  assert.ok(messages.some((m) => m.includes("trùng")));
});

test("empty paste va >100 rows", () => {
  assert.deepEqual(parseExcelPaste(""), { ok: false, errors: [{ line: 0, message: "Chưa có dòng dữ liệu nào để dán." }] });
  const many = [];
  for (let i = 0; i < EXCEL_PASTE_MAX_ROWS + 2; i += 1) {
    many.push("c" + String(i).padStart(3, "0") + "\t2026-10-15\tA\tp\tr\tThời vụ");
  }
  const result = parseExcelPaste(many.join("\n"));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes("tối đa 100")));
});

test("formula duoc giu nhu text, khong evaluate", () => {
  const result = parseExcelPaste("=SUM(A1:A3)\t2026-10-15\tA\tp\tr\tThời vụ");
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].employee_code, "=SUM(A1:A3)");
});
