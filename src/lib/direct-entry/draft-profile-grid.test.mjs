import assert from "node:assert/strict";
import test from "node:test";

import { projectDraftProfileGridCells } from "./draft-profile-grid.ts";

const field = (state) => state === "provided"
  ? { state, value: "Synthetic value" }
  : state === "redacted"
    ? { state, present: true }
    : { state };

function profile(overrides = {}) {
  return {
    contract_version: "worker-profile/1.0",
    worker_details: {
      display_name: field("provided"),
      gender: field("omitted"),
      date_of_birth: field("unknown"),
      national_id: field("intentionally_blank"),
      national_id_issued_at: field("redacted"),
      national_id_issued_place: field("omitted"),
      address: field("provided"),
      phone: field("provided"),
    },
    general_note: field("provided"),
    employment: {
      status: "ON",
      effective_date: "2026-10-01",
      version: 3,
      leave_date: field("omitted"),
      leave_reason_text: field("unknown"),
    },
    payment: {
      state: "provided",
      account_number: { state: "masked", value: "•••• 0042" },
      bank_name: field("provided"),
      account_holder_name: field("redacted"),
      version: 2,
    },
    ...overrides,
  };
}

test("provided fields hydrate as cell values while every non-raw state stays display-only", () => {
  const result = projectDraftProfileGridCells(profile());

  assert.equal(result.cells.display_name, "Synthetic value");
  assert.equal(result.cells.address, "Synthetic value");
  assert.equal(result.cells.general_note, "Synthetic value");
  assert.equal(result.cells.bank_name, "Synthetic value");
  assert.equal(result.cells.account_number, undefined);
  assert.equal(result.displayValues.account_number, "•••• 0042");
  assert.equal(result.displayValues.national_id_issued_at, "Có dữ liệu · đã ẩn theo quyền");
  assert.equal(result.displayValues.gender, "Không được cung cấp");
  assert.equal(result.displayValues.date_of_birth, "Chưa xác định");
  assert.equal(result.displayValues.national_id, "Cố ý để trống");
  assert.equal(result.displayValues.account_holder_name, "Có dữ liệu · đã ẩn theo quyền");
});

test("empty payment and employment projections remain distinct from omitted or blank fields", () => {
  const result = projectDraftProfileGridCells(profile({ payment: null, employment: null }));

  assert.equal(result.displayValues.account_number, "Chưa có hồ sơ thanh toán");
  assert.equal(result.displayValues.bank_name, "Chưa có hồ sơ thanh toán");
  assert.equal(result.displayValues.leave_date, "Chưa có dữ liệu việc làm");
  assert.equal(result.displayValues.leave_reason_text, "Chưa có dữ liệu việc làm");
});

test("bank name is projected as text without catalog lookup or mapping", () => {
  const result = projectDraftProfileGridCells(profile({
    payment: {
      state: "provided",
      account_number: field("omitted"),
      bank_name: { state: "provided", value: "Synthetic Bank Text" },
      account_holder_name: field("intentionally_blank"),
      version: 1,
    },
  }));

  assert.equal(result.cells.bank_name, "Synthetic Bank Text");
  assert.equal(result.displayValues.bank_name, undefined);
});
