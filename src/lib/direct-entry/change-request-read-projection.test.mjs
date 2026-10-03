import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCUMENT_STAGING_MESSAGE,
  LEAVE_REASON_HIDDEN_MESSAGE,
  PRESENCE_ONLY_MESSAGE,
  documentReadRows,
  isPresenceOnlyWorkerDetails,
  optionalValueText,
  paymentReadRows,
  projectDocumentReadProposal,
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

test("worker_details FULL duoc strict-project, presence-only khong bi coi la full", () => {
  assert.deepEqual(projectWorkerDetails(worker()), worker());
  assert.equal(isPresenceOnlyWorkerDetails({ present: true }), true);
  assert.equal(isPresenceOnlyWorkerDetails({ present: false }), false);
  assert.equal(projectWorkerDetails({ present: true }), null);
  assert.equal(projectWorkerDetails(worker({ extra: 1 })), null);
  assert.equal(projectWorkerDetails(worker({ phone: { state: "provided" } })), null);
  assert.equal(projectWorkerDetails(worker({ phone: { state: "provided", value: "" } })), null);
  assert.equal(projectWorkerDetails(worker({ date_of_birth: { state: "provided", value: "31/02/1990" } })),
    null);
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
});

test("PAYMENT read projection: FULL khac MASKED, giu so 0 dau, khong reconstruct", () => {
  const full = projectPaymentReadProposal({
    state: "provided", account_number: "000123", bank_id: "bank_a",
    account_holder_name: "NGUYEN VAN SYNTHETIC",
  });
  assert.equal(full.complete, true);
  assert.deepEqual(full.account, { mode: "FULL", value: "000123" });

  const masked = projectPaymentReadProposal({
    state: "provided", account_number: "••••6789",
  });
  assert.equal(masked.complete, false);
  assert.deepEqual(masked.account, { mode: "MASKED", value: "••••6789" });
  assert.equal(masked.bankId, null);
  assert.equal(masked.holderName, null);

  const omitted = projectPaymentReadProposal({ state: "unknown", account_number: null });
  assert.equal(omitted.complete, false);
  assert.deepEqual(omitted.account, { mode: "ABSENT" });

  for (const invalid of [
    { state: "provided", account_number: "000123", bank_id: "b", account_holder_name: "x", extra: 1 },
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
    state: "provided", account_number: "••••6789", bank_id: "bank_a",
    account_holder_name: null,
  });
  const rows = paymentReadRows({
    before: { state: "provided", account_number: "••••1234", bank_id: "bank_a",
      account_holder_name: null, masked: true },
    after,
    bankLabel: (bankId) => (bankId === "bank_a" ? "Ngân hàng Synthetic" : null),
  });
  assert.deepEqual(rows.map((row) => row.field), ["account_number"]);
  assert.equal(rows[0].before, "••••1234");
  assert.equal(JSON.stringify(rows).includes("bank_a"), false);
  assert.equal(paymentReadRows({
    before: null, after, bankLabel: () => null,
  }), null);
});

test("WORK_STATUS read projection chi co status + effective_date, ly do luon duoc ghi ro la an", () => {
  const view = projectWorkStatusReadProposal({ status: "OFF", effective_date: "2026-10-01" });
  assert.deepEqual(view, { status: "OFF", effectiveDate: "2026-10-01", reasonOmitted: true });
  assert.equal(projectWorkStatusReadProposal({
    status: "OFF", effective_date: "2026-10-01", leave_reason: "raw reason",
  }), null);
  assert.equal(projectWorkStatusReadProposal({ status: "MAYBE", effective_date: "2026-10-01" }), null);
  assert.equal(projectWorkStatusReadProposal({ status: "ON", effective_date: "31/10/2026" }), null);
  const rows = workStatusReadRows({
    before: { status: "UNCONFIRMED", effective_date: "2026-09-01" }, after: view,
  });
  assert.deepEqual(rows.map((row) => row.field), ["status", "effective_date", "leave_reason"]);
  assert.equal(rows[2].after, LEAVE_REASON_HIDDEN_MESSAGE);
  assert.equal(JSON.stringify(rows).includes("raw reason"), false);
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
  assert.match(PRESENCE_ONLY_MESSAGE, /thông tin cá nhân/);
});
