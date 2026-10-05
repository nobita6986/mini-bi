import assert from "node:assert/strict";
import test from "node:test";

import {
  DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS,
  DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS,
  DIRECT_ENTRY_GENDER_OPTIONS,
  DIRECT_ENTRY_GRID_COLUMNS,
  directEntryGridColumn,
  directEntryGridColumnIndex,
  recruitersForProvider,
} from "./direct-entry-grid-columns.ts";
import { workerProfileField } from "./worker-profile-import-contract.ts";

/**
 * P1.7-H05: mot so truong duoc override label tren UI grid nhung van giu contract
 * source of truth. Test registry phai nhan cac override nay de tap trung vao
 * `contractField` (dung cho projection/validation).
 */
const H05_LABEL_OVERRIDES = Object.freeze({
  address: "Địa chỉ",
  phone: "Số điện thoại",
  provider_hint: "HRP/Vendor",
  recruiter_id: "Người tuyển / Vendor",
});

const EXPECTED_KEYS = [
  "row_index", "project_id", "first_work_date", "employee_code", "display_name", "gender",
  "date_of_birth", "age_years", "national_id", "national_id_issued_at",
  "national_id_issued_place", "address", "phone", "provider_hint", "provider_type", "recruiter_id", "team_hint",
  "labor_type", "initial_status", "leave_date", "leave_reason_text", "general_note",
  "account_number", "bank_name", "account_holder_name", "cccd_documents", "save_status",
  "row_actions",
];

test("registry khoa dung thu tu vat ly cua P1.7", () => {
  assert.equal(DIRECT_ENTRY_GRID_COLUMNS.length, 28);
  assert.deepEqual(DIRECT_ENTRY_GRID_COLUMNS.map((column) => column.key), EXPECTED_KEYS);
  assert.equal(new Set(EXPECTED_KEYS).size, EXPECTED_KEYS.length);
  assert.equal(directEntryGridColumnIndex("project_id"), 1);
  assert.equal(directEntryGridColumnIndex("row_actions"), 27);
  assert.equal(directEntryGridColumnIndex("unknown"), -1);
});

test("registry tai su dung worker-profile spec thay vi nhan ban contract", () => {
  for (const column of DIRECT_ENTRY_GRID_COLUMNS.filter((item) => item.contractField !== null)) {
    const contractField = workerProfileField(column.key);
    assert.ok(contractField, column.key);
    assert.equal(column.contractField, contractField, column.key);
    // P1.7-H05: mot so cot duoc override label UI; contract van giu canonicalHeader.
    const override = H05_LABEL_OVERRIDES[column.key];
    if (override) {
      assert.equal(column.label, override, column.key);
    } else if (column.key !== "provider_hint" && column.key !== "recruiter_id") {
      assert.equal(column.label, contractField.canonicalHeader, column.key);
    }
    assert.equal(column.required, contractField.requirement === "required", column.key);
  }
  for (const key of ["cccd_documents", "save_status", "row_actions"]) {
    assert.equal(directEntryGridColumn(key)?.contractField, null, key);
  }
  assert.equal(directEntryGridColumn("provider_hint")?.label, "HRP/Vendor");
  assert.equal(directEntryGridColumn("recruiter_id")?.label, "Người tuyển / Vendor");
});

test("default visible data columns are the 18 H05 columns and exclude action rail", () => {
  assert.deepEqual(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS, [
    "row_index", "project_id", "first_work_date", "display_name", "gender",
    "date_of_birth", "national_id", "national_id_issued_at", "national_id_issued_place",
    "address", "phone", "provider_type", "recruiter_id", "labor_type",
    "account_number", "bank_name", "account_holder_name", "general_note",
  ]);
  assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.length, 18);
  // Ma NLĐ khong xuat hien tren grid va khong cho nhap o day; server tu sinh.
  assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.includes("employee_code"), false);
  // Tuoi, trang thai lam viec, ngay nghi, ghi chu nghi khong xuat hien tren grid.
  for (const key of ["age_years", "initial_status", "leave_date", "leave_reason_text",
    "team_hint", "provider_hint"]) {
    assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.includes(key), false, key);
  }
  // Hồ sơ CCCD dat NGOAI grid (action rail).
  assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.includes("cccd_documents"), false);
  assert.deepEqual(DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS, ["save_status", "row_actions"]);
  assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.some((key) =>
    DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS.includes(key)), false);
  for (const key of ["date_of_birth", "address", "phone", "account_number",
    "bank_name", "account_holder_name", "general_note"]) {
    assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.includes(key), true, key);
  }
  assert.deepEqual(DIRECT_ENTRY_GENDER_OPTIONS, ["Nam", "Nữ"]);
  assert.equal(DIRECT_ENTRY_GENDER_OPTIONS.includes(""), false,
    "khong co option trong cho gioi tinh");
});

test("recruiter options are empty without provider and filter by the selected provider", () => {
  const recruiters = [
    { id: "hrp-1", label: "HRP Recruiter", provider_type: "hrp" },
    { id: "vendor-1", label: "Vendor Recruiter", provider_type: "vendor" },
  ];
  assert.deepEqual(recruitersForProvider(recruiters, ""), []);
  assert.deepEqual(recruitersForProvider(recruiters, "hrp"), [recruiters[0]]);
  assert.deepEqual(recruitersForProvider(recruiters, "vendor"), [recruiters[1]]);
});

test("write, validation-only va ignore co boundary fail-closed", () => {
  for (const key of ["project_id", "display_name", "account_number", "bank_name"]) {
    const column = directEntryGridColumn(key);
    assert.equal(column?.pasteMode, "write", key);
    assert.equal(column?.editable, true, key);
  }
  for (const key of ["row_index", "employee_code", "age_years", "provider_hint", "team_hint"]) {
    const column = directEntryGridColumn(key);
    assert.equal(column?.pasteMode, "validate-only", key);
    assert.equal(column?.editable, false, key);
  }
  assert.equal(directEntryGridColumn("provider_type")?.pasteMode, "ignore");
  assert.equal(directEntryGridColumn("provider_type")?.editable, true);
  for (const key of ["cccd_documents", "save_status", "row_actions"]) {
    const column = directEntryGridColumn(key);
    assert.equal(column?.pasteMode, "ignore", key);
    assert.equal(column?.editable, false, key);
  }
});

test("registry va moi column deu immutable", () => {
  assert.equal(Object.isFrozen(DIRECT_ENTRY_GRID_COLUMNS), true);
  assert.equal(DIRECT_ENTRY_GRID_COLUMNS.every((column) => Object.isFrozen(column)), true);
});
