import assert from "node:assert/strict";
import test from "node:test";

import {
  allowedWorkStatusTargets,
  buildChangeRequestItem,
  buildEntryFieldProposal,
  buildPaymentProposal,
  buildWorkerDetailsProposal,
  buildWorkStatusProposal,
  hcmTodayDate,
  projectWorkerDetailsForProposal,
  proposalErrorMessage,
  workerDetailsFromForm,
  workerEntryFormFromBaseline,
  workerFormFromDetails,
} from "./change-request-proposal-builders.ts";

const OPTIONAL = { state: "unknown" };
const TODAY = "2026-10-20";

function worker(overrides = {}) {
  return {
    display_name: "Nguyen Van Synthetic",
    gender: { state: "provided", value: "MALE" },
    date_of_birth: { state: "provided", value: "1990-01-02" },
    national_id: OPTIONAL,
    national_id_issued_at: { state: "omitted" },
    national_id_issued_place: { state: "provided", value: "Ha Noi" },
    address: OPTIONAL,
    phone: OPTIONAL,
    ...overrides,
  };
}

test("worker_details proposal: preloads and edits the complete canonical worker profile", () => {
  const baseline = worker();
  const unchanged = buildWorkerDetailsProposal(baseline, workerFormFromDetails(baseline));
  assert.deepEqual(unchanged, { ok: false, code: "WORKER_UNCHANGED" });

  const form = workerFormFromDetails(baseline);
  form.gender = { state: "provided", text: "FEMALE" };
  form.national_id_issued_at = { state: "provided", text: "15/01/2020" };
  form.national_id_issued_place = { state: "provided", text: "Bộ Công An" };
  form.phone = { state: "provided", text: "0900000000" };
  const built = buildWorkerDetailsProposal(baseline, form);
  assert.equal(built.ok, true);
  const proposal = built.proposal.worker_details;
  assert.deepEqual(Object.keys(proposal).sort(),
    ["address", "date_of_birth", "display_name", "gender", "national_id",
      "national_id_issued_at", "national_id_issued_place", "phone"]);
  assert.deepEqual(proposal.phone, { state: "provided", value: "0900000000" });
  assert.deepEqual(proposal.national_id, { state: "unknown" });
  assert.deepEqual(proposal.gender, { state: "provided", value: "FEMALE" });
  assert.deepEqual(proposal.national_id_issued_at,
    { state: "provided", value: "15/01/2020" });
  assert.deepEqual(proposal.national_id_issued_place,
    { state: "provided", value: "Bộ Công An" });

  assert.deepEqual(projectWorkerDetailsForProposal(baseline), baseline);
  assert.equal(projectWorkerDetailsForProposal({
    display_name: { present: true },
    date_of_birth: { state: "provided" },
    national_id: { state: "provided" },
    address: { state: "provided" },
    phone: { state: "provided" },
  }), null, "redacted presence/state data must never become a mutable worker proposal");
  assert.equal(projectWorkerDetailsForProposal({ ...baseline, private_extra: "forbidden" }), null);

  const blankProvided = workerFormFromDetails(baseline);
  blankProvided.national_id = { state: "provided", text: "" };
  assert.equal(workerDetailsFromForm(blankProvided), null);
  assert.deepEqual(buildWorkerDetailsProposal(baseline, blankProvided),
    { ok: false, code: "WORKER_INVALID" });

  const badName = workerFormFromDetails(baseline);
  badName.display_name = "   ";
  assert.deepEqual(buildWorkerDetailsProposal(baseline, badName),
    { ok: false, code: "WORKER_INVALID" });

  const badGender = workerFormFromDetails(baseline);
  badGender.gender = { state: "intentionally_blank", text: "" };
  assert.deepEqual(buildWorkerDetailsProposal(baseline, badGender),
    { ok: false, code: "WORKER_INVALID" });

  const badDate = workerFormFromDetails(baseline);
  badDate.date_of_birth = { state: "provided", text: "31/02/1990" };
  const freeDate = buildWorkerDetailsProposal(baseline, badDate);
  assert.equal(freeDate.ok, true,
    "DOB remains ordinary source text under the current worker-details contract");
  assert.equal(freeDate.proposal.worker_details.date_of_birth.value, "31/02/1990");
  assert.match(proposalErrorMessage("WORKER_UNAVAILABLE"), /quyền xem thông tin cá nhân/);

  const legacyBaseline = worker({ gender: undefined, national_id_issued_at: undefined,
    national_id_issued_place: undefined });
  const legacyForm = workerFormFromDetails(legacyBaseline);
  legacyForm.phone = { state: "provided", text: "0911111111" };
  const legacyProposal = buildWorkerDetailsProposal(legacyBaseline, legacyForm);
  assert.equal(legacyProposal.ok, true);
  assert.equal("gender" in legacyProposal.proposal.worker_details, false);
  assert.equal("national_id_issued_at" in legacyProposal.proposal.worker_details, false);
  assert.equal("national_id_issued_place" in legacyProposal.proposal.worker_details, false);
});

test("ENTRY_FIELD proposal preloads every #61 field and emits only changed keys", () => {
  const baseline = {
    project_id: "project-old",
    first_work_date: "2026-10-01",
    employee_code: "hrp-2026-000001",
    recruiter_id: "22222222-2222-4222-8222-222222222222",
    labor_type: "PERMANENT",
    worker_details: worker(),
  };
  const form = workerEntryFormFromBaseline(baseline);
  assert.equal(form.project_id, baseline.project_id);
  assert.equal(form.first_work_date, baseline.first_work_date);
  assert.equal(form.employee_code, baseline.employee_code);
  assert.equal(form.recruiter_id, baseline.recruiter_id);
  assert.equal(form.labor_type, baseline.labor_type);
  assert.deepEqual(form.workerDetails, workerFormFromDetails(baseline.worker_details));
  assert.deepEqual(buildEntryFieldProposal({ entryId: "c1000000-0000-4000-8000-00000000000a",
    expectedVersion: 8, baseline, form }), { ok: false, code: "WORKER_UNCHANGED" });

  form.project_id = "project-new";
  form.first_work_date = "2026-10-02";
  form.employee_code = "hrp-2026-000002";
  form.recruiter_id = "33333333-3333-4333-8333-333333333333";
  form.labor_type = "TEMPORARY";
  form.workerDetails.display_name = "Nguyen Van Updated";
  form.workerDetails.phone = { state: "provided", text: "0900000000" };
  const built = buildEntryFieldProposal({
    entryId: "c1000000-0000-4000-8000-00000000000a", expectedVersion: 8, baseline, form,
  });
  assert.equal(built.ok, true);
  assert.deepEqual(Object.keys(built.proposal).sort(), [
    "employee_code", "first_work_date", "labor_type", "project_id", "recruiter_id",
    "worker_details",
  ]);
  assert.equal(built.proposal.worker_details.display_name, "Nguyen Van Updated");
  assert.deepEqual(built.proposal.worker_details.phone, { state: "provided", value: "0900000000" });

  const item = buildChangeRequestItem({ entryId: "c1000000-0000-4000-8000-00000000000a",
    expectedVersion: 8, targetKind: "ENTRY_FIELD", proposal: built.proposal });
  assert.equal(item.entry_id, "c1000000-0000-4000-8000-00000000000a");
  assert.equal(item.expected_version, 8);
  assert.equal(item.target_kind, "ENTRY_FIELD");
  assert.deepEqual(buildEntryFieldProposal({
    entryId: item.entry_id,
    expectedVersion: 8,
    baseline,
    form: { ...workerEntryFormFromBaseline(baseline), labor_type: "TEMPORARY" },
  }), { ok: true, proposal: { labor_type: "TEMPORARY" } });
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
