import assert from "node:assert/strict";
import test from "node:test";

import {
  DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS,
  DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS,
  DIRECT_ENTRY_GRID_COLUMNS,
  directEntryGridColumn,
  directEntryGridColumnIndex,
  recruitersForProvider,
} from "./direct-entry-grid-columns.ts";
import { workerProfileField } from "./worker-profile-import-contract.ts";

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
    if (column.key !== "provider_hint" && column.key !== "recruiter_id") {
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

test("default visible data columns are the approved 12 and exclude action rail", () => {
  assert.deepEqual(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS, [
    "row_index", "project_id", "first_work_date", "employee_code", "display_name", "gender",
    "national_id", "national_id_issued_at", "national_id_issued_place", "provider_type",
    "recruiter_id", "labor_type",
  ]);
  assert.deepEqual(DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS,
    ["cccd_documents", "save_status", "row_actions"]);
  assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.some((key) =>
    DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS.includes(key)), false);
  for (const key of ["date_of_birth", "age_years", "address", "phone", "team_hint",
    "initial_status", "leave_date", "leave_reason_text", "general_note", "account_number",
    "bank_name", "account_holder_name"]) {
    assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.includes(key), false, key);
  }
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
