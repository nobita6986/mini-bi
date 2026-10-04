import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  WORKER_PROFILE_CONTRACT_VERSION,
  WORKER_PROFILE_DERIVED_KEYS,
  WORKER_PROFILE_FIELDS,
  WORKER_PROFILE_REQUIRED_HEADERS,
  WORKER_PROFILE_TEMPLATE_HEADERS,
  isKnownWorkerProfileHeader,
  resolveWorkerProfileHeader,
  workerProfileField,
  workerProfileIssueMessage,
} from "./worker-profile-import-contract.ts";

// Du lieu trong file nay la GIA hoan toan (synthetic), khong phai du lieu that cua Owner.

/** Bo comment truoc khi quet tu khoa bi cam (comment khong phai code). */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("contract version rieng, khong dung lai direct-entry/1.1", () => {
  assert.equal(WORKER_PROFILE_CONTRACT_VERSION, "worker-profile/1.0");
  assert.notEqual(WORKER_PROFILE_CONTRACT_VERSION, "direct-entry/1.1");
  const source = codeOnly(
    readFileSync(new URL("./worker-profile-import-contract.ts", import.meta.url), "utf8"));
  assert.equal(source.includes("DIRECT_ENTRY_CONTRACT_VERSION"), false);
  assert.equal(source.includes("contracts/direct-entry-v1"), false);
});

test("header canonical cua template dung danh sach T0-locked, khong co alias import", () => {
  const required = ["Mã NLĐ", "Dự án", "Ngày bắt đầu làm việc", "Họ và tên",
    "Tên NV Tuyển dụng", "Loại hình LĐ"];
  assert.deepEqual([...WORKER_PROFILE_REQUIRED_HEADERS], required);
  for (const header of required) {
    assert.equal(WORKER_PROFILE_TEMPLATE_HEADERS.includes(header), true, header);
  }
  for (const header of ["Giới tính", "DOB", "CMT/CCCD", "Ngày cấp", "Nơi cấp",
    "Địa chỉ hiện tại", "Số điện thoại", "Ghi chú", "Tình trạng làm việc hiện tại",
    "Ngày nghỉ thực tế", "Ghi chú về nghỉ việc", "STK", "Tên ngân hàng", "Tên chủ tài khoản",
    "STT", "Tháng", "Tuổi", "Chi nhánh/Team", "Người tuyển dụng (HRP/Vendor)"]) {
    assert.equal(WORKER_PROFILE_TEMPLATE_HEADERS.includes(header), true, header);
  }
  // A3 / D1: alias import khong duoc xuat hien tren template/UI moi.
  assert.equal(WORKER_PROFILE_TEMPLATE_HEADERS.includes("Mã số ứng viên"), false);
  assert.equal(WORKER_PROFILE_TEMPLATE_HEADERS.includes("Người tuyển"), false);
  assert.equal(WORKER_PROFILE_TEMPLATE_HEADERS.includes("Ngày vào"), false);
  assert.equal(WORKER_PROFILE_TEMPLATE_HEADERS.includes("CCCD"), false);
});

test("alias import van duoc nhan, ke ca 'Ma so ung vien' -> employee_code", () => {
  assert.equal(isKnownWorkerProfileHeader("Mã số ứng viên"), true);
  assert.equal(isKnownWorkerProfileHeader("  mã   SỐ   ứng   viên  "), true);
  assert.equal(isKnownWorkerProfileHeader("Ngày vào"), true);
  assert.equal(isKnownWorkerProfileHeader("Tên Công ty/Dự án làm việc"), true);
  assert.equal(isKnownWorkerProfileHeader("Họ tên NLĐ"), true);
  assert.equal(isKnownWorkerProfileHeader("Người tuyển dụng"), true);
  assert.equal(isKnownWorkerProfileHeader("Loại hình lao động"), true);
  assert.equal(isKnownWorkerProfileHeader("SĐT"), true);
  assert.equal(isKnownWorkerProfileHeader("Ngày sinh"), true);

  const resolved = resolveWorkerProfileHeader([
    "Mã số ứng viên", "Dự án", "Ngày vào", "Họ tên NLĐ", "Người tuyển dụng", "Loại hình LĐ",
  ]);
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.columns.map((column) => column.key),
    ["employee_code", "project_id", "first_work_date", "display_name", "recruiter_id", "labor_type"]);
});

test("header: NFC + gop khoang trang + ha case; khong fuzzy", () => {
  const decomposed = "Ma\u0303\u0301 NLĐ"; // NFD-ish input, NFC se gop lai
  const resolved = resolveWorkerProfileHeader([
    "  MÃ   NLĐ  ", "dự án", "NGÀY BẮT ĐẦU LÀM VIỆC", "họ và tên", "tên nv tuyển dụng",
    "loại hình lđ",
  ]);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.columns[0].key, "employee_code");
  assert.equal(resolved.columns[2].key, "first_work_date");
  void decomposed;

  // Khong fuzzy: thieu tu / viet tat / sai chinh ta deu la unknown.
  for (const bad of ["Mã", "Mã NV", "Dự án làm", "Ngày bắt đầu", "Họ tênn", "Tên tuyển"]) {
    const result = resolveWorkerProfileHeader([bad]);
    assert.equal(result.ok, false, bad);
    assert.equal(result.issues.some((item) => item.code === "PASTE_HEADER_UNKNOWN"), true, bad);
  }
});

test("header: thu tu tuy y, so cot khong co dinh, cot tuy chon co the vang mat", () => {
  const shuffled = resolveWorkerProfileHeader([
    "Loại hình LĐ", "Họ và tên", "Tên NV Tuyển dụng", "Mã NLĐ", "Dự án",
    "Ngày bắt đầu làm việc",
  ]);
  assert.equal(shuffled.ok, true);
  assert.deepEqual(shuffled.columns.map((column) => column.index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(shuffled.columns.map((column) => column.key),
    ["labor_type", "display_name", "recruiter_id", "employee_code", "project_id",
      "first_work_date"]);

  const withOptional = resolveWorkerProfileHeader([
    "Mã NLĐ", "Dự án", "Ngày bắt đầu làm việc", "Họ và tên", "Tên NV Tuyển dụng", "Loại hình LĐ",
    "CMT/CCCD",
  ]);
  assert.equal(withOptional.ok, true);
  assert.equal(withOptional.columns.length, 7);
});

test("header: unknown, duplicate (alias + canonical), thieu cot bat buoc, o header trong", () => {
  const unknown = resolveWorkerProfileHeader(["Mã NLĐ", "Cột lạ"]);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.issues.some((item) => item.code === "PASTE_HEADER_UNKNOWN"), true);
  assert.equal(unknown.issues.filter((item) => item.code === "PASTE_HEADER_REQUIRED").length, 5);

  const duplicate = resolveWorkerProfileHeader([
    "Mã NLĐ", "Mã số ứng viên", "Dự án", "Ngày bắt đầu làm việc", "Họ và tên",
    "Tên NV Tuyển dụng", "Loại hình LĐ",
  ]);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.issues.some((item) =>
    item.code === "PASTE_HEADER_DUPLICATE" && item.field === "employee_code"), true);
  assert.equal(duplicate.columns.filter((column) => column.key === "employee_code").length, 1);

  const duplicateAlias = resolveWorkerProfileHeader([
    "Họ và tên", "Họ tên NLĐ", "Mã NLĐ", "Dự án", "Ngày bắt đầu làm việc",
    "Tên NV Tuyển dụng", "Loại hình LĐ",
  ]);
  assert.equal(duplicateAlias.issues.some((item) =>
    item.code === "PASTE_HEADER_DUPLICATE" && item.field === "display_name"), true);

  const empty = resolveWorkerProfileHeader(["Mã NLĐ", "", "Dự án"]);
  assert.equal(empty.issues.some((item) => item.code === "PASTE_HEADER_EMPTY"), true);
});

test("derived fields khong bao gio persisted va khong nam trong danh sach bat buoc", () => {
  assert.deepEqual([...WORKER_PROFILE_DERIVED_KEYS].sort(),
    ["age_years", "effective_month", "provider_hint", "row_index", "team_hint"]);
  for (const key of WORKER_PROFILE_DERIVED_KEYS) {
    assert.equal(workerProfileField(key).persisted, false, key);
    assert.equal(WORKER_PROFILE_REQUIRED_HEADERS.includes(workerProfileField(key).canonicalHeader),
      false, key);
  }
  // Team va HRP/Vendor khong phai client authority (D6).
  assert.equal(workerProfileField("team_hint").persisted, false);
  assert.equal(workerProfileField("provider_hint").persisted, false);
});

test("moi field co sensitivity marker va tham chieu validator; khong co DTO/authority", () => {
  for (const field of WORKER_PROFILE_FIELDS) {
    assert.ok(["none", "direct_pii", "financial", "sensitive_free_text", "derived"]
      .includes(field.sensitivity), field.key);
    assert.equal(typeof field.validator, "string", field.key);
    assert.ok(field.validator.length > 0, field.key);
  }
  const pii = WORKER_PROFILE_FIELDS.filter((field) => field.sensitivity === "direct_pii")
    .map((field) => field.key);
  for (const key of ["employee_code", "display_name", "date_of_birth", "national_id",
    "national_id_issued_at", "national_id_issued_place", "address", "phone",
    "account_holder_name", "leave_date"]) {
    assert.equal(pii.includes(key), true, key);
  }
  assert.equal(workerProfileField("account_number").sensitivity, "financial");
  assert.equal(workerProfileField("general_note").sensitivity, "sensitive_free_text");

  const source = codeOnly(
    readFileSync(new URL("./worker-profile-import-contract.ts", import.meta.url), "utf8"));
  for (const forbidden of ["fetch(", "localStorage", "sessionStorage", "capability", "scope",
    "actor_id", "storage_key", "checksum", "bucket", "signed"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("issue code co message tinh, khong chua gia tri nguoi dung", () => {
  for (const field of WORKER_PROFILE_FIELDS) {
    assert.equal(typeof field.key, "string");
  }
  for (const code of ["PASTE_HEADER_UNKNOWN", "PASTE_HEADER_DUPLICATE", "PASTE_HEADER_REQUIRED",
    "PASTE_HEADER_EMPTY", "PASTE_FORMULA_CELL", "PASTE_NATIONAL_ID_INVALID",
    "PASTE_DUPLICATE_NATIONAL_ID", "PASTE_BANK_CATALOG_EMPTY", "PASTE_CATALOG_MISSING",
    "PASTE_CATALOG_AMBIGUOUS", "PASTE_ROW_LIMIT", "PASTE_MONTH_MISMATCH", "PASTE_AGE_MISMATCH"]) {
    const message = workerProfileIssueMessage(code);
    assert.equal(message.includes(code), false, code);
    assert.ok(message.length > 0, code);
  }
  assert.match(workerProfileIssueMessage("PASTE_UNKNOWN_CODE_XYZ"), /không hợp lệ/);
});
