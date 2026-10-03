import assert from "node:assert/strict";
import test from "node:test";

import {
  allowedWorkStatusTargets,
  buildChangeRequestItem,
  buildPaymentProposal,
  buildWorkerDetailsProposal,
  buildWorkStatusProposal,
  hcmTodayDate,
  proposalErrorMessage,
  workerDetailsFromForm,
  workerFormFromDetails,
} from "./change-request-proposal-builders.ts";

const OPTIONAL = { state: "unknown" };
const TODAY = "2026-10-20";

function worker(overrides = {}) {
  return {
    display_name: "Nguyen Van Synthetic",
    date_of_birth: { state: "provided", value: "1990-01-02" },
    national_id: OPTIONAL,
    address: OPTIONAL,
    phone: OPTIONAL,
    ...overrides,
  };
}

test("worker_details proposal: du 5 field, chi khi co thay doi, optional-state dung nghia", () => {
  const baseline = worker();
  const unchanged = buildWorkerDetailsProposal(baseline, workerFormFromDetails(baseline));
  assert.deepEqual(unchanged, { ok: false, code: "WORKER_UNCHANGED" });

  const form = workerFormFromDetails(baseline);
  form.phone = { state: "provided", text: "0900000000" };
  const built = buildWorkerDetailsProposal(baseline, form);
  assert.equal(built.ok, true);
  const proposal = built.proposal.worker_details;
  assert.deepEqual(Object.keys(proposal).sort(),
    ["address", "date_of_birth", "display_name", "national_id", "phone"]);
  assert.deepEqual(proposal.phone, { state: "provided", value: "0900000000" });
  assert.deepEqual(proposal.national_id, { state: "unknown" });

  const blankProvided = workerFormFromDetails(baseline);
  blankProvided.national_id = { state: "provided", text: "" };
  assert.equal(workerDetailsFromForm(blankProvided), null);
  assert.deepEqual(buildWorkerDetailsProposal(baseline, blankProvided),
    { ok: false, code: "WORKER_INVALID" });

  const badName = workerFormFromDetails(baseline);
  badName.display_name = "   ";
  assert.deepEqual(buildWorkerDetailsProposal(baseline, badName),
    { ok: false, code: "WORKER_INVALID" });

  const badDate = workerFormFromDetails(baseline);
  badDate.date_of_birth = { state: "provided", text: "31/02/1990" };
  assert.deepEqual(buildWorkerDetailsProposal(baseline, badDate),
    { ok: false, code: "WORKER_INVALID" });
  assert.match(proposalErrorMessage("WORKER_UNAVAILABLE"), /quyền xem thông tin cá nhân/);
});

test("PAYMENT proposal: dung 4 field, bank phai active, giu so 0 dau", () => {
  const activeBankIds = new Set(["bank_a"]);
  const baseline = { state: "omitted", account_number: null, bank_id: null,
    account_holder_name: null };
  const provided = { state: "provided", account_number: "000123", bank_id: "bank_a",
    account_holder_name: "NGUYEN VAN SYNTHETIC" };
  const built = buildPaymentProposal({ baseline, draft: provided, activeBankIds });
  assert.deepEqual(built.proposal, provided);
  assert.deepEqual(Object.keys(built.proposal).sort(),
    ["account_holder_name", "account_number", "bank_id", "state"]);

  assert.deepEqual(buildPaymentProposal({ baseline: provided, draft: provided, activeBankIds }),
    { ok: false, code: "PAYMENT_UNCHANGED" });
  assert.deepEqual(buildPaymentProposal({
    baseline, draft: { ...provided, bank_id: "bank_inactive" }, activeBankIds,
  }), { ok: false, code: "PAYMENT_INVALID" });
  assert.deepEqual(buildPaymentProposal({
    baseline, draft: { ...provided, account_number: "000-123" }, activeBankIds,
  }), { ok: false, code: "PAYMENT_INVALID" });
  assert.deepEqual(buildPaymentProposal({
    baseline, draft: { state: "unknown", account_number: "1", bank_id: "bank_a",
      account_holder_name: "x" }, activeBankIds,
  }), { ok: false, code: "PAYMENT_INVALID" });
  const notProvided = buildPaymentProposal({
    baseline, draft: { state: "intentionally_blank", account_number: null, bank_id: null,
      account_holder_name: null }, activeBankIds,
  });
  assert.deepEqual(notProvided.proposal, { state: "intentionally_blank", account_number: null,
    bank_id: null, account_holder_name: null });
});

test("WORK_STATUS proposal: transition + date bounds + ly do bat buoc khi OFF", () => {
  assert.deepEqual(allowedWorkStatusTargets("UNCONFIRMED"), ["ON", "OFF"]);
  assert.deepEqual(allowedWorkStatusTargets("ON"), ["OFF"]);
  assert.deepEqual(allowedWorkStatusTargets("OFF"), ["ON"]);
  assert.deepEqual(allowedWorkStatusTargets(null), []);

  const baseline = { status: "UNCONFIRMED", effective_date: "2026-10-01" };
  const on = buildWorkStatusProposal({ baseline, status: "ON", effectiveDate: "2026-10-05",
    leaveReason: "", today: TODAY });
  assert.deepEqual(on.proposal, { status: "ON", effective_date: "2026-10-05" });
  assert.equal("leave_reason" in on.proposal, false);

  const off = buildWorkStatusProposal({ baseline, status: "OFF", effectiveDate: "2026-10-05",
    leaveReason: "  Nghi viec rieng  ", today: TODAY });
  assert.deepEqual(off.proposal, { status: "OFF", effective_date: "2026-10-05",
    leave_reason: "Nghi viec rieng" });

  assert.deepEqual(buildWorkStatusProposal({ baseline, status: "OFF", effectiveDate: "2026-10-05",
    leaveReason: "   ", today: TODAY }), { ok: false, code: "STATUS_REASON_REQUIRED" });
  assert.deepEqual(buildWorkStatusProposal({ baseline, status: "UNCONFIRMED",
    effectiveDate: "2026-10-05", leaveReason: "", today: TODAY }),
  { ok: false, code: "STATUS_TRANSITION_INVALID" });
  assert.deepEqual(buildWorkStatusProposal({ baseline, status: "ON", effectiveDate: "2026-09-30",
    leaveReason: "", today: TODAY }), { ok: false, code: "STATUS_DATE_INVALID" });
  assert.deepEqual(buildWorkStatusProposal({ baseline, status: "ON", effectiveDate: "2026-10-21",
    leaveReason: "", today: TODAY }), { ok: false, code: "STATUS_DATE_INVALID" });
  assert.deepEqual(buildWorkStatusProposal({ baseline, status: "ON", effectiveDate: "31/10/2026",
    leaveReason: "", today: TODAY }), { ok: false, code: "STATUS_DATE_INVALID" });
  assert.deepEqual(buildWorkStatusProposal({ baseline: null, status: "ON",
    effectiveDate: "2026-10-05", leaveReason: "", today: TODAY }),
  { ok: false, code: "STATUS_INVALID" });

  const offBaseline = { status: "OFF", effective_date: "2026-10-05" };
  assert.deepEqual(buildWorkStatusProposal({ baseline: offBaseline, status: "OFF",
    effectiveDate: "2026-10-05", leaveReason: "x", today: TODAY }),
  { ok: false, code: "STATUS_UNCHANGED" });
});

test("item di qua validator cua create contract, khong tu viet lai", () => {
  const item = buildChangeRequestItem({
    entryId: "c1000000-0000-4000-8000-00000000000a",
    expectedVersion: 3,
    targetKind: "PAYMENT",
    proposal: { state: "provided", account_number: "000123", bank_id: "bank_a",
      account_holder_name: "NGUYEN VAN SYNTHETIC" },
  });
  assert.equal(item.target_kind, "PAYMENT");
  assert.equal(item.expected_version, 3);
  assert.equal(buildChangeRequestItem({
    entryId: "c1000000-0000-4000-8000-00000000000a",
    expectedVersion: 3,
    targetKind: "PAYMENT",
    proposal: { state: "omitted", account_number: null, bank_id: null,
      account_holder_name: null, extra: 1 },
  }), null);
  assert.equal(buildChangeRequestItem({
    entryId: "not-a-uuid", expectedVersion: 3, targetKind: "ENTRY_FIELD",
    proposal: { labor_type: "PERMANENT" },
  }), null);
  assert.match(hcmTodayDate(), /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
});
