/**
 * PRE-W2-P1 - worker export contract (pure validator/projection).
 *
 * Khoa: body allowlist (unknown/type/enum/filter), strict row + envelope shape, khong fallback.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  projectWorkerExportEnvelope,
  projectWorkerExportRequest,
  projectWorkerExportRow,
  WORKER_EXPORT_COLUMNS,
  WORKER_EXPORT_ROW_KEYS,
  WORKER_EXPORT_ROW_LIMIT,
} from "./worker-export-contract.ts";

function validRow(overrides = {}) {
  return {
    employee_code: "hrp-2026-300001",
    display_name: "Nguyen Van A",
    date_of_birth: "1990-01-01",
    national_id: "012345678901",
    phone: "0900000001",
    address: "1 Street",
    project_display: "Project A",
    first_work_date: "2026-10-01",
    labor_type_display: "Thời vụ",
    recruiter_display: "Recruiter A",
    provider_type: "HRP",
    employment_status: "ON",
    leave_date: null,
    leave_reason: null,
    account_number: "012345678901",
    bank_name: "Bank",
    account_holder_name: "Holder",
    payment_note: null,
    general_note: "Synthetic note",
    ...overrides,
  };
}

test("the request accepts the exact allowlist and optional/null filters", () => {
  assert.deepEqual(projectWorkerExportRequest({ scope: "recruited", reason: "  ly do  " }), {
    scope: "recruited", project_id: null, recruiter_id: null, employment_status: null,
    reason: "ly do",
  });
  assert.deepEqual(projectWorkerExportRequest({
    scope: "managed", project_id: "proj_a", recruiter_id: null, employment_status: "OFF",
    reason: "x",
  }), {
    scope: "managed", project_id: "proj_a", recruiter_id: null, employment_status: "OFF", reason: "x",
  });
  assert.deepEqual(projectWorkerExportRequest({ scope: "all", reason: "audit all" }), {
    scope: "all", project_id: null, recruiter_id: null, employment_status: null, reason: "audit all",
  });
});

test("the request rejects unknown keys, wrong types, invalid enums and filters", () => {
  for (const body of [
    null,
    [],
    { scope: "recruited" },
    { scope: "recruited", reason: "" },
    { scope: "recruited", reason: "x".repeat(4001) },
    { scope: "everything", reason: "x" },
    { scope: "recruited", reason: "x", idempotency_key: "abc" },
    { scope: "recruited", reason: "x", auth_subject: "s" },
    { scope: "recruited", reason: "x", project_id: "bad project" },
    { scope: "recruited", reason: "x", recruiter_id: "not-a-uuid" },
    { scope: "recruited", reason: "x", employment_status: "MAYBE" },
    { scope: "recruited", reason: "x", scope_extra: 1 },
  ]) {
    assert.equal(projectWorkerExportRequest(body), null, JSON.stringify(body));
  }
});

test("the row projection keeps the 19 fields and fails closed on malformed rows", () => {
  assert.deepEqual(Object.keys(projectWorkerExportRow(validRow())).sort(),
    [...WORKER_EXPORT_ROW_KEYS].sort());
  for (const bad of [
    null,
    validRow({ extra: 1 }),
    (() => { const r = validRow(); delete r.national_id; return r; })(),
    (() => { const r = validRow(); delete r.general_note; return r; })(),
    validRow({ first_work_date: "2026/10/01" }),
    validRow({ date_of_birth: "nope" }),
    validRow({ leave_date: "2026-99-99" }),
    validRow({ provider_type: "Other" }),
    validRow({ employment_status: "MAYBE" }),
    validRow({ payment_note: "fabricated" }),
    validRow({ general_note: "x".repeat(4001) }),
    validRow({ project_display: "" }),
    validRow({ recruiter_display: "" }),
  ]) {
    assert.equal(projectWorkerExportRow(bad), null, JSON.stringify(bad));
  }
  assert.equal("payment_note" in projectWorkerExportRow(validRow({ payment_note: "" })), true);
  assert.equal("general_note" in projectWorkerExportRow(validRow({ general_note: null })), true);
});

test("the envelope accepts exactly ok/rows or too_many_rows/limit", () => {
  const ok = projectWorkerExportEnvelope({ status: "ok", rows: [validRow()] });
  assert.equal(ok.status, "ok");
  assert.equal(ok.rows.length, 1);
  assert.deepEqual(projectWorkerExportEnvelope({ status: "ok", rows: [] }),
    { status: "ok", rows: [] });

  assert.deepEqual(projectWorkerExportEnvelope({ status: "too_many_rows", limit: 10000 }), {
    status: "too_many_rows", limit: WORKER_EXPORT_ROW_LIMIT,
  });
  for (const bad of [
    null,
    { status: "ok" },
    { status: "ok", rows: [validRow({ extra: 1 })] },
    { status: "too_many_rows" },
    { status: "too_many_rows", limit: 9999 },
    { status: "too_many_rows", limit: 10000, rows: [] },
    { status: "done", rows: [] },
  ]) {
    assert.equal(projectWorkerExportEnvelope(bad), null, JSON.stringify(bad));
  }
});

test("the XLSX column contract is exactly 19 ordered columns with the four text ids", () => {
  assert.equal(WORKER_EXPORT_COLUMNS.length, 19);
  assert.deepEqual(WORKER_EXPORT_COLUMNS.map((c) => c.header), [
    "Mã NLĐ", "Họ và tên", "Ngày sinh", "CCCD", "Số điện thoại", "Địa chỉ", "Dự án",
    "Ngày bắt đầu", "Loại hình lao động", "Người tuyển", "Nhà cung cấp",
    "Trạng thái làm việc", "Ngày nghỉ", "Lý do nghỉ", "Số tài khoản", "Ngân hàng",
    "Chủ tài khoản", "Ghi chú thanh toán", "Ghi chú",
  ]);
  assert.deepEqual(
    WORKER_EXPORT_COLUMNS.filter((c) => c.text).map((c) => c.key),
    ["employee_code", "national_id", "phone", "account_number"]);
});
