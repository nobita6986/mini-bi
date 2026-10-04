import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  deriveAgeYears,
  parseWorkerProfilePaste,
  toWorkerProfileWriteModel,
} from "./worker-profile-paste.ts";

// Toan bo gia tri trong file nay la GIA (synthetic); khong dung du lieu that cua Owner.
const REFERENCE_DATE = "2026-10-16";
const NAME = "Nguyễn Văn Giả A";
const PROJECT = "Dự án Giả Bắc";
const RECRUITER = "Tuyển Dụng Giả 1";
const NID = "012345678901";
const PHONE = "0900000001";
const ACCOUNT = "000123456789";
const HOLDER = "NGUYEN VAN GIA A";
const ADDRESS = "Số 1 Đường Giả, Phường Test";
const PLACE = "Cục Cảnh sát Giả";

function parse(text, referenceDate = REFERENCE_DATE) {
  return parseWorkerProfilePaste({ text, referenceDate });
}

function requiredPairs(code = "hrp-2026-000123", date = "2026-10-15") {
  return [
    ["Mã NLĐ", code],
    ["Dự án", PROJECT],
    ["Ngày bắt đầu làm việc", date],
    ["Họ và tên", NAME],
    ["Tên NV Tuyển dụng", RECRUITER],
    ["Loại hình LĐ", "Thời vụ"],
  ];
}

function fullPairs(code = "hrp-2026-000123") {
  return [...requiredPairs(code), ["Giới tính", "Nam"], ["DOB", "1990-05-20"],
    ["CMT/CCCD", NID], ["Ngày cấp", "2020-06-01"], ["Nơi cấp", PLACE],
    ["Địa chỉ hiện tại", ADDRESS], ["Số điện thoại", PHONE], ["Ghi chú", "Ghi chú giả"],
    ["Tình trạng làm việc hiện tại", "Đang làm"], ["STK", ACCOUNT],
    ["Tên ngân hàng", "Ngân hàng Giả"], ["Tên chủ tài khoản", HOLDER]];
}

function toTsv(rows) {
  const header = rows[0].map((pair) => pair[0]).join("\t");
  const body = rows.map((row) => row.map((pair) => pair[1]).join("\t")).join("\n");
  return header + "\n" + body;
}

function codesFor(count) {
  return Array.from({ length: count }, (item, index) =>
    "hrp-2026-" + String(index + 1).padStart(6, "0"));
}

test("ho so toi thieu: chi 6 cot bat buoc, 1 dong, header bat buoc", () => {
  const result = parse(toTsv([requiredPairs()]));
  assert.equal(result.contractVersion, "worker-profile/1.0");
  assert.equal(result.rows.length, 1);
  assert.equal(result.errorCount, 0);
  assert.equal(result.canProceed, true);
  const row = result.rows[0];
  assert.equal(row.sourceRow, 2);
  assert.equal(row.employee_code, "hrp-2026-000123");
  assert.equal(row.project_label, PROJECT);
  assert.equal(row.first_work_date, "2026-10-15");
  assert.equal(row.display_name, NAME);
  assert.equal(row.recruiter_label, RECRUITER);
  assert.equal(row.labor_type, "TEMPORARY");
  // Truong tuy chon vang mat => omitted, KHONG phai chuoi rong.
  assert.deepEqual(row.worker.national_id, { state: "omitted" });
  assert.deepEqual(row.worker.phone, { state: "omitted" });
  assert.deepEqual(row.general_note, { state: "omitted" });
  assert.deepEqual(row.payment.account_number, { state: "omitted" });
  assert.deepEqual(row.employment.initial_status, { state: "omitted" });
  assert.equal(row.derived.effective_month, "2026-10");
  assert.equal(row.derived.age_years, null);
});

test("ho so day du: moi cot tuy chon duoc map dung", () => {
  const result = parse(toTsv([fullPairs()]));
  assert.equal(result.errorCount, 0);
  const row = result.rows[0];
  assert.deepEqual(row.worker.gender, { state: "provided", value: "MALE" });
  assert.deepEqual(row.worker.date_of_birth, { state: "provided", value: "1990-05-20" });
  assert.deepEqual(row.worker.national_id, { state: "provided", value: NID });
  assert.deepEqual(row.worker.national_id_issued_at, { state: "provided", value: "2020-06-01" });
  assert.deepEqual(row.worker.national_id_issued_place, { state: "provided", value: PLACE });
  assert.deepEqual(row.worker.address, { state: "provided", value: ADDRESS });
  assert.deepEqual(row.worker.phone, { state: "provided", value: PHONE });
  assert.deepEqual(row.general_note, { state: "provided", value: "Ghi chú giả" });
  assert.deepEqual(row.payment.account_number, { state: "provided", value: ACCOUNT });
  assert.deepEqual(row.payment.bank_label, { state: "provided", value: "Ngân hàng Giả" });
  assert.deepEqual(row.payment.account_holder_name, { state: "provided", value: HOLDER });
  assert.equal(row.derived.age_years, 36);
  assert.equal(deriveAgeYears("1990-05-20", REFERENCE_DATE), 36);
  assert.equal(deriveAgeYears("1990-11-20", REFERENCE_DATE), 35);
});

test("thu tu cot tuy y; cot tuy chon co the vang mat; khong co dinh so cot", () => {
  const shuffled = [["Loại hình LĐ", "Toàn thời gian"], ["Họ và tên", NAME],
    ["CMT/CCCD", NID], ["Tên NV Tuyển dụng", RECRUITER], ["Mã NLĐ", "hrp-2026-000123"],
    ["Dự án", PROJECT], ["Ngày bắt đầu làm việc", "2026-10-15"]];
  const result = parse(toTsv([shuffled]));
  assert.equal(result.errorCount, 0);
  assert.equal(result.rows[0].labor_type, "PERMANENT");
  assert.deepEqual(result.rows[0].worker.national_id, { state: "provided", value: NID });
});

test("CRLF/LF, dong trong cuoi, 1 dong va 100 dong; 101 dong bi tu choi", () => {
  const single = toTsv([requiredPairs()]).replace(/\n/g, "\r\n") + "\r\n\r\n";
  assert.equal(parse(single).rows.length, 1);

  const hundred = codesFor(100).map((code) => requiredPairs(code));
  const ok = parse(toTsv(hundred));
  assert.equal(ok.rows.length, 100);
  assert.equal(ok.errorCount, 0);

  const hundredOne = codesFor(101).map((code) => requiredPairs(code));
  const over = parse(toTsv(hundredOne));
  assert.equal(over.rows.length, 100);
  assert.equal(over.issues.some((item) => item.code === "PASTE_ROW_LIMIT"), true);
  assert.equal(over.canProceed, false);

  assert.equal(parse("").issues[0].code, "PASTE_EMPTY");
  assert.equal(parse("Mã NLĐ\tDự án").issues.some((item) =>
    item.code === "PASTE_HEADER_REQUIRED"), true);
  const headerOnly = parse(["Mã NLĐ", "Dự án", "Ngày bắt đầu làm việc", "Họ và tên",
    "Tên NV Tuyển dụng", "Loại hình LĐ"].join("\t"));
  assert.equal(headerOnly.issues.some((item) => item.code === "PASTE_NO_DATA_ROWS"), true);
});

test("cong thuc Excel khong bao gio duoc evaluate", () => {
  // Cot bi rang buoc: bi tu choi, nhung van giu nguyen van ban (khong tinh toan).
  const formulaCode = parse(toTsv([[["Mã NLĐ", "=SUM(A1:A3)"], ["Dự án", PROJECT],
    ["Ngày bắt đầu làm việc", "2026-10-15"], ["Họ và tên", NAME],
    ["Tên NV Tuyển dụng", RECRUITER], ["Loại hình LĐ", "Thời vụ"]]]));
  assert.equal(formulaCode.issues.some((item) => item.code === "PASTE_FORMULA_CELL"), true);
  assert.equal(formulaCode.rows[0].employee_code, "=SUM(A1:A3)");
  assert.equal(formulaCode.canProceed, false);

  // Cot text tu do: giu nguyen van ban, khong sinh so.
  const freeText = parse(toTsv([[...requiredPairs(), ["Ghi chú", "=1+1"]]]));
  assert.deepEqual(freeText.rows[0].general_note, { state: "provided", value: "=1+1" });
  assert.equal(freeText.errorCount, 0);

  for (const marker of ["=A1", "+A1", "-A1", "@A1"]) {
    const result = parse(toTsv([[["Mã NLĐ", marker], ["Dự án", PROJECT],
      ["Ngày bắt đầu làm việc", "2026-10-15"], ["Họ và tên", NAME],
      ["Tên NV Tuyển dụng", RECRUITER], ["Loại hình LĐ", "Thời vụ"]]]));
    assert.equal(result.issues.some((item) => item.code === "PASTE_FORMULA_CELL"), true, marker);
  }

  const source = readFileSync(new URL("./worker-profile-paste.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /eval\(|new Function\(/);
});

test("giu nguyen so 0 dau cho CCCD, so dien thoai, STK; khong dung Number()", () => {
  const result = parse(toTsv([fullPairs()]));
  assert.equal(result.rows[0].worker.national_id.value, "012345678901");
  assert.equal(result.rows[0].worker.phone.value, "0900000001");
  assert.equal(result.rows[0].payment.account_number.value, "000123456789");
  assert.equal(typeof result.rows[0].worker.national_id.value, "string");

  const shorter = parse(toTsv([[...requiredPairs(), ["CMT/CCCD", "012345678"]]]));
  assert.equal(shorter.rows[0].worker.national_id.value, "012345678");

  const source = readFileSync(new URL("./worker-profile-paste.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function buildRow"));
  for (const field of ["national_id", "phone", "account_number"]) {
    assert.equal(body.includes("Number(" + field), false, field);
  }
  assert.doesNotMatch(body, /Number\(nationalIdRaw\)|Number\(accountNumberRaw\)|Number\(phone/);
});

test("ma NLĐ: regex canonical va nam phai khop ngay bat dau", () => {
  for (const bad of ["hrp-26-000123", "hrp-2026-12345", "HRP-2026-000123", "000123",
    "hrp-2026-0001234"]) {
    const result = parse(toTsv([[["Mã NLĐ", bad], ["Dự án", PROJECT],
      ["Ngày bắt đầu làm việc", "2026-10-15"], ["Họ và tên", NAME],
      ["Tên NV Tuyển dụng", RECRUITER], ["Loại hình LĐ", "Thời vụ"]]]));
    assert.equal(result.issues.some((item) => item.code === "PASTE_EMPLOYEE_CODE_FORMAT"),
      true, bad);
  }
  const wrongYear = parse(toTsv([requiredPairs("hrp-2025-000123")]));
  assert.equal(wrongYear.issues.some((item) => item.code === "PASTE_EMPLOYEE_CODE_YEAR"), true);
});

test("ngay: YYYY-MM-DD va DD/MM/YYYY, ngay lich that, khong tuong lai", () => {
  const slash = parse(toTsv([[["Mã NLĐ", "hrp-2026-000123"], ["Dự án", PROJECT],
    ["Ngày bắt đầu làm việc", "15/10/2026"], ["Họ và tên", NAME],
    ["Tên NV Tuyển dụng", RECRUITER], ["Loại hình LĐ", "Thời vụ"],
    ["DOB", "20/5/1990"]]]));
  assert.equal(slash.errorCount, 0);
  assert.equal(slash.rows[0].first_work_date, "2026-10-15");
  assert.deepEqual(slash.rows[0].worker.date_of_birth, { state: "provided", value: "1990-05-20" });

  for (const bad of ["2026-02-31", "31/02/2026", "2026-13-01", "khong-phai-ngay", "2026/10/15"]) {
    const result = parse(toTsv([[["Mã NLĐ", "hrp-2026-000123"], ["Dự án", PROJECT],
      ["Ngày bắt đầu làm việc", bad], ["Họ và tên", NAME],
      ["Tên NV Tuyển dụng", RECRUITER], ["Loại hình LĐ", "Thời vụ"]]]));
    assert.equal(result.issues.some((item) => item.code === "PASTE_DATE_INVALID"), true, bad);
  }

  const futureDob = parse(toTsv([[...requiredPairs(), ["DOB", "2027-01-01"]]]));
  assert.equal(futureDob.issues.some((item) => item.code === "PASTE_DOB_FUTURE"), true);
});

test("ngay cap: khong tuong lai, khong truoc ngay sinh", () => {
  const future = parse(toTsv([[...requiredPairs(), ["DOB", "1990-05-20"],
    ["Ngày cấp", "2027-01-01"]]]));
  assert.equal(future.issues.some((item) => item.code === "PASTE_ISSUED_FUTURE"), true);

  const beforeDob = parse(toTsv([[...requiredPairs(), ["DOB", "1990-05-20"],
    ["Ngày cấp", "1989-01-01"]]]));
  assert.equal(beforeDob.issues.some((item) => item.code === "PASTE_ISSUED_BEFORE_DOB"), true);

  const sameDay = parse(toTsv([[...requiredPairs(), ["DOB", "1990-05-20"],
    ["Ngày cấp", "1990-05-20"]]]));
  assert.equal(sameDay.issues.some((item) => item.code === "PASTE_ISSUED_BEFORE_DOB"), false);
});

test("gioi tinh: alias Nam/Nu/Khac + gia tri la", () => {
  const cases = [["Nam", "MALE"], ["M", "MALE"], ["male", "MALE"], ["Nữ", "FEMALE"],
    ["F", "FEMALE"], ["Female", "FEMALE"], ["Khác", "OTHER"], ["Other", "OTHER"],
    ["  nữ  ", "FEMALE"]];
  for (const [input, expected] of cases) {
    const result = parse(toTsv([[...requiredPairs(), ["Giới tính", input]]]));
    assert.deepEqual(result.rows[0].worker.gender, { state: "provided", value: expected }, input);
  }
  const invalid = parse(toTsv([[...requiredPairs(), ["Giới tính", "Không rõ"]]]));
  assert.equal(invalid.issues.some((item) => item.code === "PASTE_GENDER_INVALID"), true);
  assert.deepEqual(invalid.rows[0].worker.gender, { state: "omitted" });
});

test("CCCD: dung 9 hoac 12 chu so, khong checksum", () => {
  for (const good of ["012345678", "012345678901", "123456789012"]) {
    const result = parse(toTsv([[...requiredPairs(), ["CMT/CCCD", good]]]));
    assert.deepEqual(result.rows[0].worker.national_id, { state: "provided", value: good }, good);
  }
  for (const bad of ["01234567", "0123456789", "0123456789012", "01234567890a",
    "0012-3456", "01234567890"]) {
    const result = parse(toTsv([[...requiredPairs(), ["CMT/CCCD", bad]]]));
    assert.equal(result.issues.some((item) => item.code === "PASTE_NATIONAL_ID_INVALID"),
      true, bad);
  }
});

test("tinh trang lam viec: vocabulary hien huu, ngay nghi va ly do", () => {
  const off = parse(toTsv([[...requiredPairs(),
    ["Tình trạng làm việc hiện tại", "Đã nghỉ"], ["Ngày nghỉ thực tế", "2026-10-20"],
    ["Ghi chú về nghỉ việc", "Hết hạn hợp đồng giả"]]]));
  assert.equal(off.errorCount, 0);
  assert.deepEqual(off.rows[0].employment.initial_status, { state: "provided", value: "OFF" });

  const offMissing = parse(toTsv([[...requiredPairs(),
    ["Tình trạng làm việc hiện tại", "OFF"]]]));
  assert.equal(offMissing.issues.some((item) => item.code === "PASTE_LEAVE_MISSING"), true);
  assert.equal(offMissing.issues.some((item) =>
    item.code === "PASTE_LEAVE_REASON_MISSING"), true);

  const leaveBeforeStart = parse(toTsv([[...requiredPairs(),
    ["Tình trạng làm việc hiện tại", "Đã nghỉ"], ["Ngày nghỉ thực tế", "2026-10-01"],
    ["Ghi chú về nghỉ việc", "Lý do giả"]]]));
  assert.equal(leaveBeforeStart.issues.some((item) =>
    item.code === "PASTE_LEAVE_BEFORE_START"), true);

  const leaveWithoutOff = parse(toTsv([[...requiredPairs(),
    ["Tình trạng làm việc hiện tại", "Đang làm"], ["Ngày nghỉ thực tế", "2026-11-01"]]]));
  assert.equal(leaveWithoutOff.issues.some((item) =>
    item.code === "PASTE_LEAVE_REQUIRES_OFF"), true);

  const unknown = parse(toTsv([[...requiredPairs(),
    ["Tình trạng làm việc hiện tại", "Nghỉ thai sản"]]]));
  assert.equal(unknown.issues.some((item) => item.code === "PASTE_STATUS_INVALID"), true);
});

test("do dai: ghi chu 4000 ok, 4001 loi; dia chi 1024 ok, 1025 loi", () => {
  const noteOk = parse(toTsv([[...requiredPairs(), ["Ghi chú", "x".repeat(4000)]]]));
  assert.equal(noteOk.errorCount, 0);
  const noteTooLong = parse(toTsv([[...requiredPairs(), ["Ghi chú", "x".repeat(4001)]]]));
  assert.equal(noteTooLong.issues.some((item) =>
    item.code === "PASTE_TEXT_TOO_LONG" && item.field === "general_note"), true);

  const addressOk = parse(toTsv([[...requiredPairs(), ["Địa chỉ hiện tại", "x".repeat(1024)]]]));
  assert.equal(addressOk.errorCount, 0);
  const addressTooLong = parse(toTsv([[...requiredPairs(),
    ["Địa chỉ hiện tại", "x".repeat(1025)]]]));
  assert.equal(addressTooLong.issues.some((item) =>
    item.code === "PASTE_TEXT_TOO_LONG" && item.field === "address"), true);
});

test("thanh toan: du 3 truong hoac khong co truong nao; khong tu suy ra state", () => {
  const partial = parse(toTsv([[...requiredPairs(), ["STK", ACCOUNT]]]));
  assert.equal(partial.issues.some((item) => item.code === "PASTE_PAYMENT_INCOMPLETE"), true);

  const full = parse(toTsv([[...requiredPairs(), ["STK", ACCOUNT],
    ["Tên ngân hàng", "Ngân hàng Giả"], ["Tên chủ tài khoản", HOLDER]]]));
  assert.equal(full.errorCount, 0);
  assert.equal("payment_state" in full.rows[0].payment, false);

  const badAccount = parse(toTsv([[...requiredPairs(), ["STK", "a".repeat(65)],
    ["Tên ngân hàng", "Ngân hàng Giả"], ["Tên chủ tài khoản", HOLDER]]]));
  assert.equal(badAccount.issues.some((item) =>
    item.code === "PASTE_ACCOUNT_NUMBER_INVALID"), true);
});

test("cot dan xuat: validation-only, khong vao write model", () => {
  const result = parse(toTsv([[...requiredPairs(), ["DOB", "1990-05-20"], ["STT", "7"],
    ["Tháng", "10/2026"], ["Tuổi", "36"], ["Chi nhánh/Team", "Team Giả"],
    ["Người tuyển dụng (HRP/Vendor)", "HRP"]]]));
  const row = result.rows[0];
  assert.equal(row.derived.row_index, 7);
  assert.equal(row.derived.effective_month, "2026-10");
  assert.equal(row.derived.age_years, 36);
  assert.equal(row.derived.team_hint, "Team Giả");
  assert.equal(row.derived.provider_hint, "HRP");
  // Chi la canh bao (khong luu), khong chan dong.
  assert.equal(result.errorCount, 0);

  const model = toWorkerProfileWriteModel(row);
  const serialized = JSON.stringify(model);
  for (const derived of ["STT", "Tháng", "Tuổi", "Team Giả", "HRP", "row_index",
    "effective_month", "age_years", "team_hint", "provider_hint", "derived", "sourceRow"]) {
    assert.equal(serialized.includes(derived), false, derived);
  }
  assert.deepEqual(Object.keys(model).sort(), ["display_name", "employee_code", "employment",
    "first_work_date", "general_note", "labor_type", "payment", "project_label",
    "recruiter_label", "worker"]);
});

test("cot dan xuat: mismatch thang la loi; format khong doc duoc chi la canh bao", () => {
  const mismatch = parse(toTsv([[...requiredPairs(), ["Tháng", "11/2026"]]]));
  assert.equal(mismatch.issues.some((item) =>
    item.code === "PASTE_MONTH_MISMATCH" && item.severity === "error"), true);

  const badMonth = parse(toTsv([[...requiredPairs(), ["Tháng", "Q4-2026"]]]));
  assert.equal(badMonth.issues.some((item) =>
    item.code === "PASTE_DERIVED_INVALID" && item.severity === "warning"), true);
  assert.equal(badMonth.errorCount, 0);

  const badAge = parse(toTsv([[...requiredPairs(), ["DOB", "1990-05-20"], ["Tuổi", "99"]]]));
  assert.equal(badAge.issues.some((item) =>
    item.code === "PASTE_AGE_MISMATCH" && item.severity === "warning"), true);

  const badIndex = parse(toTsv([[...requiredPairs(), ["STT", "-1"]]]));
  assert.equal(badIndex.issues.some((item) => item.code === "PASTE_DERIVED_INVALID"), true);
});

test("loi khong chua PII: chi co code/severity/row/field", () => {
  const result = parse(toTsv([[...requiredPairs(), ["CMT/CCCD", "12345"], ["Số điện thoại", PHONE],
    ["Địa chỉ hiện tại", ADDRESS], ["Ghi chú", "Ghi chú giả"]]]));
  assert.ok(result.issues.length > 0);
  const serialized = JSON.stringify(result.issues);
  for (const pii of [NAME, NID, PHONE, ACCOUNT, HOLDER, ADDRESS, PLACE, "Nguyễn Văn Giả",
    "hrp-2026-000123", "12345"]) {
    assert.equal(serialized.includes(pii), false, pii);
  }
  for (const entry of result.issues) {
    assert.deepEqual(Object.keys(entry).sort(), ["code", "field", "row", "severity"]);
    assert.match(entry.code, /^PASTE_[A-Z_]+$/);
    assert.ok(["error", "warning"].includes(entry.severity));
    assert.equal(Number.isSafeInteger(entry.row), true);
  }
});

test("module thuan: khong network, khong mutation, khong authority, khong storage", () => {
  const source = readFileSync(new URL("./worker-profile-paste.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["fetch(", "XMLHttpRequest", "localStorage.", "sessionStorage.",
    "indexedDB.", "document.cookie", "console.", "capability", "scope", "actor_id",
    "storage_key", "checksum", "bucket", "signed"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  // Khong dinh nghia server DTO/response.
  assert.doesNotMatch(source, /submission_id|entry_ids|expected_version|idempotency_key/);
  assert.doesNotMatch(source, /"unknown"|intentionally_blank/);
});
