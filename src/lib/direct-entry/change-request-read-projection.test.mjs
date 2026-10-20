import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCUMENT_STAGING_MESSAGE,
  LEAVE_REASON_HIDDEN_MESSAGE,
  documentReadRows,
  optionalValueText,
  paymentReadRows,
  projectDocumentReadProposal,
  projectEntrySensitiveContext,
  projectPaymentReadProposal,
  projectWorkStatusReadProposal,
  projectWorkerDetails,
  workStatusReadRows,
  workerDetailsRows,
} from "./change-request-read-projection.ts";

const OPTIONAL = { state: "unknown" };

function worker(overrides = {}) {
  return {
    display_name: "Nguyen Van Synthetic",
    date_of_birth: { state: "provided", value: "1990-01-02" },
    national_id: { state: "intentionally_blank" },
    address: OPTIONAL,
    phone: OPTIONAL,
    ...overrides,
  };
}

test("worker_details must use the canonical full projection", () => {
  assert.deepEqual(projectWorkerDetails(worker()), worker());
  const complete = worker({
    gender: { state: "provided", value: "FEMALE" },
    national_id_issued_at: { state: "provided", value: "15/01/2020" },
    national_id_issued_place: { state: "provided", value: "Bộ Công An" },
  });
  assert.deepEqual(projectWorkerDetails(complete), complete,
    "review projection must retain every editable canonical profile field");
  assert.equal(projectWorkerDetails({ present: true }), null);
  assert.equal(projectWorkerDetails(worker({ extra: 1 })), null);
  assert.equal(projectWorkerDetails(worker({ phone: { state: "provided" } })), null);
  assert.equal(projectWorkerDetails(worker({ phone: { state: "provided", value: "" } })), null);
  assert.deepEqual(
    projectWorkerDetails(worker({ date_of_birth: { state: "provided", value: "31/02/1990" } })),
    worker({ date_of_birth: { state: "provided", value: "31/02/1990" } }),
    "DOB remains bounded source text under the current canonical contract",
  );
  assert.equal(projectWorkerDetails(worker({ date_of_birth: { state: "provided", value: "1990-01-02", x: 1 } })),
    null);
  assert.equal(projectWorkerDetails(worker({ display_name: "   " })), null);
  assert.equal(projectWorkerDetails({}), null);
  assert.equal(optionalValueText({ state: "intentionally_blank" }), "Chủ động để trống");
});

test("workerDetailsRows chi hien field thuc su thay doi", () => {
  const rows = workerDetailsRows(worker(), worker({ display_name: "Tran Thi Synthetic",
    phone: { state: "provided", value: "0900000000" } }));
  assert.deepEqual(rows.map((row) => row.field), ["display_name", "phone"]);
  assert.deepEqual(rows[0], { field: "display_name", label: "Họ tên",
    before: "Nguyen Van Synthetic", after: "Tran Thi Synthetic" });
  assert.deepEqual(workerDetailsRows(worker(), worker()), []);

  const extendedBefore = worker({ gender: { state: "provided", value: "MALE" },
    national_id_issued_at: { state: "omitted" },
    national_id_issued_place: { state: "provided", value: "Hà Nội" } });
  const extendedAfter = worker({ gender: { state: "provided", value: "FEMALE" },
    national_id_issued_at: { state: "provided", value: "01/02/2020" },
    national_id_issued_place: { state: "provided", value: "Bộ Công An" } });
  assert.deepEqual(workerDetailsRows(extendedBefore, extendedAfter).map((row) => row.label),
    ["Giới tính", "Ngày cấp", "Nơi cấp"]);
});

test("PAYMENT read projection requires full values, preserves leading zeroes", () => {
  const full = projectPaymentReadProposal({
    state: "provided", account_number: "000123", bank_id: "bank_a",
    account_holder_name: "NGUYEN VAN SYNTHETIC",
  });
  assert.equal(full.complete, true);
  assert.deepEqual(full.account, { mode: "FULL", value: "000123" });

  const masked = projectPaymentReadProposal({
    state: "provided", account_number: "••••6789",
  });
  assert.equal(masked, null, "legacy masked response fails closed");

  const omitted = projectPaymentReadProposal({ state: "unknown", account_number: null });
  assert.equal(omitted.complete, false);
  assert.deepEqual(omitted.account, { mode: "ABSENT" });

  for (const invalid of [
    { state: "provided", account_number: "000123", bank_id: "b", account_holder_name: "x", extra: 1 },
    { state: "provided", account_number: "••••0123", bank_id: "b", account_holder_name: "x" },
    { state: "provided", account_number: "000123", bank_id: null, account_holder_name: "x" },
    { state: "pending", account_number: null },
    { state: "provided", account_number: 123 },
    { state: "provided", account_number: "000123", bank_id: "", account_holder_name: "x" },
    { state: "provided", account_number: "000123", bank_id: "b", account_holder_name: "  " },
    null,
  ]) {
    assert.equal(projectPaymentReadProposal(invalid), null, JSON.stringify(invalid));
  }
});

test("paymentReadRows dung nhan catalog va fail-closed khi khong giai duoc bank", () => {
  const after = projectPaymentReadProposal({
    state: "provided", account_number: "00005678", bank_id: "bank_a",
    account_holder_name: "Synthetic Account Holder",
  });
  assert.ok(after);
  const before = {
    state: "provided", account_number: "00001234", bank_id: "bank_a",
    account_holder_name: "Synthetic Account Holder",
  };
  const rows = paymentReadRows({
    before,
    after,
    bankLabel: (bankId) => (bankId === "bank_a" ? "Ngân hàng Synthetic" : null),
  });
  assert.deepEqual(rows.map((row) => row.field), ["account_number"]);
  assert.equal(rows[0].before, "00001234");
  assert.equal(rows[0].after, "00005678");
  assert.equal(JSON.stringify(rows).includes("bank_a"), false);
  assert.equal(paymentReadRows({
    before: null, after, bankLabel: () => null,
  }), null);

  const context = projectEntrySensitiveContext({
    entry_id: "c1000000-0000-4000-8000-000000000001",
    worker_details: worker(),
    payment: {
      state: "provided", account_number: "00001234", bank_id: null,
      bank_name: "Ngân hàng Synthetic", account_holder_name: "Synthetic Account Holder", version: 2,
    },
  });
  assert.equal(context?.payment?.bank_name, "Ngân hàng Synthetic",
    "review context preserves the existing full R4 bank-name projection");
  assert.deepEqual(paymentReadRows({
    before: context.payment,
    after,
    bankLabel: (bankId) => (bankId === "bank_a" ? "Ngân hàng Synthetic" : null),
  })?.map((row) => row.field), ["account_number"]);
});

test("WORK_STATUS read projection omits reason for proposers and accepts it for reviewers", () => {
  assert.deepEqual(projectWorkStatusReadProposal({
    status: "ON", effective_date: "2026-10-01", leave_reason: null,
  }), { status: "ON", effectiveDate: "2026-10-01", leaveReason: null });
  assert.equal(projectWorkStatusReadProposal({
    status: "OFF", effective_date: "2026-10-01", leave_reason: null,
  }), null);
  const view = projectWorkStatusReadProposal({ status: "OFF", effective_date: "2026-10-01" });
  assert.deepEqual(view, { status: "OFF", effectiveDate: "2026-10-01", leaveReason: null });
  const reviewerView = projectWorkStatusReadProposal({
    status: "OFF", effective_date: "2026-10-01", leave_reason: "Nghỉ theo đề nghị của NLĐ",
  });
  assert.deepEqual(reviewerView, { status: "OFF", effectiveDate: "2026-10-01",
    leaveReason: "Nghỉ theo đề nghị của NLĐ" });
  assert.equal(projectWorkStatusReadProposal({ status: "MAYBE", effective_date: "2026-10-01" }), null);
  assert.equal(projectWorkStatusReadProposal({ status: "ON", effective_date: "31/10/2026" }), null);
  const rows = workStatusReadRows({
    before: { status: "UNCONFIRMED", effective_date: "2026-09-01" }, after: view,
  });
  assert.deepEqual(rows.map((row) => row.field), ["status", "effective_date", "leave_reason"]);
  assert.equal(rows[2].label, "Lý do nghỉ việc");
  assert.equal(rows[2].after, LEAVE_REASON_HIDDEN_MESSAGE);
  const reviewerRows = workStatusReadRows({
    before: { status: "ON", effective_date: "2026-09-01" }, after: reviewerView,
  });
  assert.equal(reviewerRows[2].after, "Nghỉ theo đề nghị của NLĐ");

  const onView = projectWorkStatusReadProposal({ status: "ON", effective_date: "2026-10-01" });
  assert.ok(onView);
  assert.deepEqual(workStatusReadRows({
    before: { status: "UNCONFIRMED", effective_date: "2026-09-01" }, after: onView,
  }).map((row) => row.field), ["status", "effective_date"]);
});

test("DOCUMENT read projection chi tra metadata an toan", () => {
  const minimal = projectDocumentReadProposal({ document_type: "EMPLOYMENT_CONTRACT" });
  assert.deepEqual(minimal, { documentType: "EMPLOYMENT_CONTRACT", sizeBytes: null, mimeType: null });
  const full = projectDocumentReadProposal({
    document_type: "CCCD_FRONT", size_bytes: 2048, mime_type: "image/png",
  });
  assert.deepEqual(full, { documentType: "CCCD_FRONT", sizeBytes: 2048, mimeType: "image/png" });
  for (const invalid of [
    { document_type: "EMPLOYMENT_CONTRACT", idempotency_key: "k" },
    { document_type: "EMPLOYMENT_CONTRACT", checksum_sha256: "a".repeat(64) },
    { document_type: "EMPLOYMENT_CONTRACT", storage_key: "p1.6/x" },
    { document_type: "UNKNOWN" },
    { document_type: "EMPLOYMENT_CONTRACT", size_bytes: 0 },
    { document_type: "EMPLOYMENT_CONTRACT", mime_type: "text/plain" },
    null,
  ]) {
    assert.equal(projectDocumentReadProposal(invalid), null, JSON.stringify(invalid));
  }
  const rows = documentReadRows(full);
  const text = JSON.stringify(rows);
  assert.equal(text.includes("checksum"), false);
  assert.equal(text.includes("idempotency"), false);
  assert.equal(text.includes("storage"), false);
  assert.equal(rows[0].after, "CCCD mặt trước");
  assert.match(DOCUMENT_STAGING_MESSAGE, /chưa sẵn sàng/);
});
