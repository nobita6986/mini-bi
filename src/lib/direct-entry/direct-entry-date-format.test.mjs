import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  formatDateToDDMM,
  formatFreeDateText,
  parseDDMMToIso,
  parseIsoDate,
  todayInHoChiMinhAsDDMM,
} from "./direct-entry-date-format.ts";

test("parseIsoDate: chap nhan YYYY-MM-DD hop le", () => {
  assert.deepEqual(parseIsoDate("2026-10-06"), { year: 2026, month: 10, day: 6 });
  assert.deepEqual(parseIsoDate("2000-02-29"), { year: 2000, month: 2, day: 29 });
  assert.deepEqual(parseIsoDate("1999-12-31"), { year: 1999, month: 12, day: 31 });
});

test("parseIsoDate: tu choi ngay khong hop le (fail closed, khong tu sua)", () => {
  // Sai format
  assert.equal(parseIsoDate(""), null);
  assert.equal(parseIsoDate("2026-10"), null);
  assert.equal(parseIsoDate("2026/10/06"), null);
  assert.equal(parseIsoDate("2026-10-06T00:00"), null);
  assert.equal(parseIsoDate("06-10-2026"), null);
  // Ngay khong ton tai theo lich
  assert.equal(parseIsoDate("2026-02-30"), null);
  assert.equal(parseIsoDate("2026-04-31"), null);
  assert.equal(parseIsoDate("2026-13-01"), null);
  assert.equal(parseIsoDate("2026-00-10"), null);
  // Nam nhuan (2000 la nhuan, 1900 KHONG nhuan)
  assert.equal(parseIsoDate("1900-02-29"), null);
  assert.equal(parseIsoDate("2026-02-29"), null, "2026 khong nhuan");
  // Khong phai string
  // @ts-expect-error: testing runtime guard
  assert.equal(parseIsoDate(null), null);
  // @ts-expect-error: testing runtime guard
  assert.equal(parseIsoDate(undefined), null);
});

test("formatDateToDDMM: chuyen YYYY-MM-DD thanh DD/MM/YYYY", () => {
  assert.equal(formatDateToDDMM("2026-10-06"), "06/10/2026");
  assert.equal(formatDateToDDMM("2000-02-29"), "29/02/2000");
  assert.equal(formatDateToDDMM("1999-01-01"), "01/01/1999");
  // Padding day/month 1 ky tu
  assert.equal(formatDateToDDMM("2026-01-09"), "09/01/2026");
});

test("formatDateToDDMM: fail closed khi input khong hop le (khong tu sua sai)", () => {
  assert.equal(formatDateToDDMM(""), "");
  assert.equal(formatDateToDDMM("not-a-date"), "");
  assert.equal(formatDateToDDMM("2026-02-30"), "");
  assert.equal(formatDateToDDMM("2026-13-01"), "");
  // KHONG tu dich sang ngay khac neu format sai (vi du "2026-1-1" phai fail
  // thay vi "01/01/2026").
  assert.equal(formatDateToDDMM("2026-1-1"), "");
});

test("formatFreeDateText: DOB/CCCD issue date echo dung nguyen text, khong chuan hoa", () => {
  for (const value of [
    "07/10/1990",
    "07-10-1990",
    "7/10/1990",
    "1990-10-07",
    "31/02/2030",
    "not-a-date",
    "  07/10/1990  ",
  ]) {
    assert.equal(formatFreeDateText(value), value);
  }
  assert.equal(formatFreeDateText(""), "");
});

test("formatDateToDDMM khong dung Date constructor (tranh UTC leak)", () => {
  // Input "2026-10-06" phai ra "06/10/2026" tren moi timezone.
  // Truoc day code dung `new Date("2026-10-06")` co the tra "05/10/2026"
  // tren America/Los_Angeles vi constructor phan tich ISO nhu UTC.
  // Pure string helpers duoi day phai KHONG goi `new Date("YYYY-MM-DD")`
  // hay `new Date(<value>)` cho format/parse output. UTC probe trong
  // parseIsoDate (validate lich theo nam nhuan) va default `now = new Date()`
  // trong helper cho phep.
  const source = readFileSync(new URL("./direct-entry-date-format.ts", import.meta.url), "utf8");
  // Loai bo cac khoi comment /** ... */ va // lines truoc khi scan.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  // `new Date(...)` voi tham so ISO date string hoac input tu nguoi dung
  // khong duoc phep xuat hien trong runtime code. UTC probe (Date.UTC)
  // va default `now = new Date()` (khong tham so) duoc phep.
  assert.equal(/new Date\(\s*["']\d{4}-/.test(stripped), false,
    "khong duoc parse chuoi ISO bang `new Date(...)` (gay UTC leak)");
  assert.equal(/new Date\(\s*Date\.UTC/.test(stripped), true,
    "parseIsoDate phai dung `new Date(Date.UTC(...))` de validate lich (UTC, khong phu thuoc local time)");
  // Loai tru 2 dong probe hop le truoc khi check khong con `new Date(...)`
  // voi tham so user nào.
  const strippedNoProbe = stripped
    .replace(/const probe = new Date\(Date\.UTC\([^)]+\)\);?/g, "")
    .replace(/= new Date\(\)/g, "");
  assert.equal(/new Date\(\s*[a-zA-Z_"]/.test(strippedNoProbe), false,
    "khong duoc parse bien string user/ISO bang `new Date(...)` (sau khi loai tru UTC probe)");
});

test("todayInHoChiMinhAsDDMM: tra DD/MM/YYYY theo Asia/Ho_Chi_Minh (khong lech UTC)", () => {
  // 2026-01-01T17:30:00Z => 2026-01-02 00:30 GMT+7
  assert.equal(todayInHoChiMinhAsDDMM(new Date("2026-01-01T17:30:00.000Z")), "02/01/2026");
  // 2026-07-31T16:59:59Z => 2026-07-31 23:59:59 GMT+7
  assert.equal(todayInHoChiMinhAsDDMM(new Date("2026-07-31T16:59:59.000Z")), "31/07/2026");
  // 2026-07-31T17:00:00Z => 2026-08-01 00:00 GMT+7
  assert.equal(todayInHoChiMinhAsDDMM(new Date("2026-07-31T17:00:00.000Z")), "01/08/2026");
  // Format check.
  assert.match(todayInHoChiMinhAsDDMM(new Date("2026-04-15T08:00:00.000Z")), /^\d{2}\/\d{2}\/\d{4}$/);
});

test("parseDDMMToIso: chuyen DD/MM/YYYY thanh YYYY-MM-DD", () => {
  assert.equal(parseDDMMToIso("06/10/2026"), "2026-10-06");
  assert.equal(parseDDMMToIso("29/02/2000"), "2000-02-29");
  assert.equal(parseDDMMToIso("01/01/1999"), "1999-01-01");
  // Padding day/month single-digit.
  assert.equal(parseDDMMToIso("9/1/2026"), "2026-01-09");
  // Separator "-" cung duoc chap nhan.
  assert.equal(parseDDMMToIso("06-10-2026"), "2026-10-06");
});

test("parseDDMMToIso: fail closed khi input khong hop le", () => {
  assert.equal(parseDDMMToIso(""), "");
  // Trim truoc khi parse.
  assert.equal(parseDDMMToIso("  "), "");
  // Sai format
  assert.equal(parseDDMMToIso("2026-10-06"), "");
  assert.equal(parseDDMMToIso("06/10"), "");
  assert.equal(parseDDMMToIso("06/10/2026abc"), "");
  assert.equal(parseDDMMToIso("not-a-date"), "");
  // Ngay khong ton tai theo lich.
  assert.equal(parseDDMMToIso("30/02/2026"), "");
  assert.equal(parseDDMMToIso("31/04/2026"), "");
  // Thang 00 (MM=00) khong hop le (thang 1..12).
  assert.equal(parseDDMMToIso("15/00/2026"), "");
  // Ngay 00 (DD=00) khong hop le (ngay 1..31).
  assert.equal(parseDDMMToIso("00/10/2026"), "");
  // 1900 KHONG phai nam nhuan (gregorian rule).
  assert.equal(parseDDMMToIso("29/02/1900"), "");
  // 2026 khong nhuan.
  assert.equal(parseDDMMToIso("29/02/2026"), "");
  // Khong phai string.
  // @ts-expect-error: testing runtime guard
  assert.equal(parseDDMMToIso(null), "");
  // @ts-expect-error: testing runtime guard
  assert.equal(parseDDMMToIso(undefined), "");
});
