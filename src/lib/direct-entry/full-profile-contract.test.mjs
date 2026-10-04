import assert from "node:assert/strict";
import test from "node:test";

import {
  FULL_PROFILE_MAX_ROWS,
  WORKER_PROFILE_CONTRACT_VERSION,
  parseFullProfilePayload,
} from "./full-profile-contract.ts";

const baseRow = {
  project_id: "project_synthetic_01",
  first_work_date: "2025-03-04",
  employee_code: "hrp-2025-000001",
  recruiter_id: "93000000-0000-4000-8000-000000000001",
  labor_type: "TEMPORARY",
  display_name: "Synthetic Worker",
};

function payload(rows = [baseRow]) {
  return { contract_version: WORKER_PROFILE_CONTRACT_VERSION, rows };
}

test("worker-profile/1.0 projects a minimal header-import row to the server DTO", () => {
  const parsed = parseFullProfilePayload(payload());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.payload.contract_version, "worker-profile/1.0");
  assert.equal(parsed.payload.rows[0].display_name, "Synthetic Worker");
  assert.deepEqual(parsed.payload.rows[0].worker_details, {
    gender: { state: "omitted" },
    date_of_birth: { state: "omitted" },
    national_id: { state: "omitted" },
    national_id_issued_at: { state: "omitted" },
    national_id_issued_place: { state: "omitted" },
    address: { state: "omitted" },
    phone: { state: "omitted" },
  });
  assert.deepEqual(parsed.payload.rows[0].general_note, { state: "omitted" });
  assert.equal("age_years" in parsed.payload.rows[0], false);
  assert.equal("candidate_code" in parsed.payload.rows[0], false);
});

test("preserves leading-zero identifier strings and accepts D11/D15 vocabulary", () => {
  const parsed = parseFullProfilePayload(payload([{
    ...baseRow,
    worker: {
      gender: { state: "provided", value: " female " },
      national_id: { state: "provided", value: "012345678901" },
      national_id_issued_at: { state: "provided", value: "2020-01-02" },
      national_id_issued_place: { state: "provided", value: "Synthetic place" },
    },
  }]));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.payload.rows[0].worker_details.gender, {
    state: "provided",
    value: "FEMALE",
  });
  assert.deepEqual(parsed.payload.rows[0].worker_details.national_id, {
    state: "provided",
    value: "012345678901",
  });
});

test("rejects recursive unknown/authority fields without projecting them", () => {
  for (const bad of [
    { ...baseRow, team_id: "94000000-0000-4000-8000-000000000001" },
    { ...baseRow, worker: { phone: { state: "omitted" }, audit: true } },
    { ...baseRow, payment: { state: "provided", bank_label: "Synthetic bank" } },
    { ...baseRow, "Mã số ứng viên": "candidate-alias-must-not-enter-server-contract" },
    { ...baseRow, sourceRow: 1 },
  ]) {
    const parsed = parseFullProfilePayload(payload([bad]));
    assert.equal(parsed.ok, false);
  }
});

test("rejects invalid calendar dates, gender, national ID, and employee-code year", () => {
  const cases = [
    { ...baseRow, first_work_date: "2025-02-30" },
    { ...baseRow, employee_code: "hrp-2024-000001" },
    { ...baseRow, worker: { gender: { state: "provided", value: "UNKNOWN" } } },
    { ...baseRow, worker: { national_id: { state: "provided", value: "12345678" } } },
    { ...baseRow, worker: { date_of_birth: { state: "provided", value: "03/04/2000" } } },
  ];
  for (const row of cases) assert.equal(parseFullProfilePayload(payload([row])).ok, false);
});

test("rejects duplicate codes and enforces the 100-row contract bound", () => {
  assert.equal(parseFullProfilePayload(payload([baseRow, baseRow])).ok, false);
  assert.equal(parseFullProfilePayload(payload(Array.from(
    { length: FULL_PROFILE_MAX_ROWS },
    (_, index) => ({ ...baseRow, employee_code: `hrp-2025-${String(index).padStart(6, "0")}` }),
  ))).ok, true);
  assert.equal(parseFullProfilePayload(payload(Array.from(
    { length: FULL_PROFILE_MAX_ROWS + 1 },
    (_, index) => ({ ...baseRow, employee_code: `hrp-2025-${String(index).padStart(6, "0")}` }),
  ))).ok, false);
});

test("payment requires an explicit state, all three values, and a catalog bank ID", () => {
  const valid = parseFullProfilePayload(payload([{
    ...baseRow,
    payment: {
      state: "provided",
      account_number: "00001234",
      bank_id: "synthetic-bank-01",
      account_holder_name: "Synthetic Holder",
    },
  }]));
  assert.equal(valid.ok, true);
  assert.equal(parseFullProfilePayload(payload([{
    ...baseRow,
    payment: { account_number: "00001234", bank_id: "synthetic-bank-01" },
  }])).ok, false);
  assert.equal(parseFullProfilePayload(payload([{
    ...baseRow,
    payment: {
      state: "provided",
      account_number: "00001234",
      bank_label: "Synthetic Bank",
      account_holder_name: "Synthetic Holder",
    },
  }])).ok, false);
});

test("historical OFF requires a valid leave date and reason", () => {
  const valid = parseFullProfilePayload(payload([{
    ...baseRow,
    employment: {
      initial_status: "OFF",
      leave_date: "2025-03-04",
      leave_reason_text: "Synthetic historical record",
    },
  }]));
  assert.equal(valid.ok, true);
  assert.equal(parseFullProfilePayload(payload([{
    ...baseRow,
    employment: { initial_status: "OFF", leave_date: "2025-03-04", leave_reason_text: "" },
  }])).ok, false);
});

test("general note remains omitted unless explicitly provided and bounded", () => {
  const omitted = parseFullProfilePayload(payload());
  assert.equal(omitted.ok, true);
  if (omitted.ok) {
    assert.deepEqual(omitted.payload.rows[0].general_note, { state: "omitted" });
  }
  assert.equal(parseFullProfilePayload(payload([{
    ...baseRow,
    general_note: { state: "provided", value: "x".repeat(4001) },
  }])).ok, false);
  assert.equal(parseFullProfilePayload(payload([{
    ...baseRow,
    general_note: { state: "unknown" },
  }])).ok, false);
});
