import assert from "node:assert/strict";
import test from "node:test";

import {
  PG_BIGINT_MAX,
  PG_BIGINT_MIN,
  VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
  checkForbiddenVendorFinanceClientFields,
  computeApplyOpeningBatchFingerprint,
  computeRecordEntryFingerprint,
  decodeVendorEntriesCursor,
  encodeVendorEntriesCursor,
  parseApplyOpeningBatchBody,
  parseCreateVendorReconciliationBody,
  parseFinalizeVendorFinanceEvidenceBody,
  parseListVendorFinanceEntriesQuery,
  parseListVendorFinanceVendorsQuery,
  parseNonNegativeMinorAmount,
  parsePositiveMinorAmount,
  parsePreviewOpeningBatchBody,
  parseRecordVendorFinanceEntryBody,
  parseReserveVendorFinanceEvidenceBody,
  parseReverseVendorFinanceEntryBody,
  parseSignedMinorAmount,
  projectOpeningApplyMutation,
  projectVendorFinanceEntry,
  projectVendorFinanceVendorDetail,
  projectVendorReconciliation,
} from "./vendor-finance-contract.ts";

const IDEM_1 = "11111111-1111-4111-8111-111111111111";
const ENTRY_ID = "22222222-2222-4222-8222-222222222222";
const BATCH_ID = "33333333-3333-4333-8333-333333333333";
const REC_ID = "44444444-4444-4444-8444-444444444444";
const SHA_OK = "a".repeat(64);

function makeCanonicalEntry(overrides = {}) {
  return {
    entry_id: ENTRY_ID,
    vendor_id: "VND_ALPHA",
    vendor_display_name_snapshot: "Công ty TNHH Alpha",
    vendor_active: true,
    vendor_sequence: 1,
    document_no: "VFIN-2026-000001",
    document_kind: "PAYROLL_VOUCHER",
    document_title_vi: "Phiếu ghi nhận lương nhà cung cấp",
    entry_type: "PAYROLL_RECORDED",
    amount_minor: "9007199254740993",
    balance_before_minor: "0",
    balance_delta_minor: "9007199254740993",
    balance_after_minor: "9007199254740993",
    effective_date: "2026-10-24",
    reason: "Chốt bảng lương kỳ 10/2026",
    opening_batch_id: null,
    reverses_entry_id: null,
    reverses_document_no: null,
    reversed_by_entry_id: null,
    reversed_by_document_no: null,
    can_reverse: true,
    can_attach_evidence: true,
    evidence: null,
    created_by_display_name: "Trần Thị Kế Toán",
    created_at: "2026-10-24T02:00:00.000Z",
    internal_disclaimer: VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
    ...overrides,
  };
}

test("money parsers accept lossless decimal strings above MAX_SAFE_INTEGER and up to int8 bounds", () => {
  const aboveSafe = parsePositiveMinorAmount("9007199254740993");
  assert.equal(aboveSafe.ok, true);
  assert.equal(aboveSafe.canonical, "9007199254740993");
  assert.equal(aboveSafe.value, BigInt("9007199254740993"));

  const maxPos = parsePositiveMinorAmount(PG_BIGINT_MAX.toString());
  assert.equal(maxPos.ok, true);
  assert.equal(maxPos.value, PG_BIGINT_MAX);

  const zeroNonNeg = parseNonNegativeMinorAmount("0");
  assert.equal(zeroNonNeg.ok, true);
  assert.equal(zeroNonNeg.canonical, "0");

  const minSigned = parseSignedMinorAmount(PG_BIGINT_MIN.toString());
  assert.equal(minSigned.ok, true);
  assert.equal(minSigned.value, PG_BIGINT_MIN);
});

test("money parsers reject floats, numbers, zero/negatives, leading zeros, scientific notation, and int8 overflow", () => {
  for (const bad of [0, 100, 12.5, "0", "-1", "-0", "+100", "0100", "100.5", "1e6", " 100 ", ""]) {
    const res = parsePositiveMinorAmount(bad);
    assert.equal(res.ok, false, `expected rejection for ${String(bad)}`);
    assert.equal(res.code, "VENDOR_FINANCE_AMOUNT_INVALID");
  }

  const posOverflow = parsePositiveMinorAmount("9223372036854775808");
  assert.deepEqual(posOverflow, { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" });

  const hugeOverflow = parsePositiveMinorAmount("100000000000000000000");
  assert.deepEqual(hugeOverflow, { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" });

  const negSignedZero = parseSignedMinorAmount("-0");
  assert.deepEqual(negSignedZero, { ok: false, code: "VENDOR_FINANCE_AMOUNT_INVALID" });

  const negOverflow = parseSignedMinorAmount("-9223372036854775809");
  assert.deepEqual(negOverflow, { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" });
});

test("checkForbiddenVendorFinanceClientFields rejects client authority & server-computed ledger fields at any depth", () => {
  const forbiddenPayloads = [
    { app_user_id: IDEM_1 },
    { auth_subject: IDEM_1 },
    { capabilities: ["vendor_finance_record"] },
    { scopes: [{ kind: "all" }] },
    { balance_delta_minor: "-500000" },
    { balance_before_minor: "0" },
    { balance_after_minor: "500000" },
    { document_no: "VFIN-2026-999999" },
    { vendor_sequence: 9 },
    { vendor_display_name_snapshot: "Spoofed Name" },
    { system_balance_minor: "0" },
    { difference_minor: "0" },
    { authority_source: "full_admin" },
    { storage_key: "vfin-01/entry/a/b" },
    { items: [{ vendor_id: "VND_1", entry_type: "OPENING_PAYABLE", amount_minor: "100", balanceAfterMinor: "100" }] },
  ];

  for (const payload of forbiddenPayloads) {
    assert.deepEqual(checkForbiddenVendorFinanceClientFields(payload), {
      ok: false,
      code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
    });
  }
});

test("parseRecordVendorFinanceEntryBody enforces normal entry enum, positive integer strings, real date, reason & idempotency match", () => {
  const ok = parseRecordVendorFinanceEntryBody(
    {
      entry_type: "PAYMENT_RECORDED",
      amount_minor: "25000000",
      effective_date: "2026-10-24",
      reason: "  Thanh toán đợt 1  ",
      idempotency_key: IDEM_1.toUpperCase(),
    },
    IDEM_1,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.value.reason, "Thanh toán đợt 1");
  assert.equal(ok.value.idempotency_key, IDEM_1);

  // OPENING_* and REVERSAL cannot be submitted to normal record endpoint
  for (const forbiddenType of ["OPENING_PAYABLE", "OPENING_ADVANCE", "REVERSAL"]) {
    const res = parseRecordVendorFinanceEntryBody(
      {
        entry_type: forbiddenType,
        amount_minor: "1000",
        effective_date: "2026-10-24",
        reason: "test",
        idempotency_key: IDEM_1,
      },
      null,
    );
    assert.deepEqual(res, { ok: false, code: "VENDOR_FINANCE_ENTRY_TYPE_INVALID" });
  }

  // Impossible calendar date
  const badDate = parseRecordVendorFinanceEntryBody(
    {
      entry_type: "DEBT_RECORDED",
      amount_minor: "1000",
      effective_date: "2026-02-30",
      reason: "test",
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.deepEqual(badDate, { ok: false, code: "VENDOR_FINANCE_DATE_INVALID" });

  // Mismatched Idempotency-Key header vs body
  const mismatch = parseRecordVendorFinanceEntryBody(
    {
      entry_type: "DEBT_RECORDED",
      amount_minor: "1000",
      effective_date: "2026-10-24",
      reason: "test",
      idempotency_key: IDEM_1,
    },
    ENTRY_ID,
  );
  assert.deepEqual(mismatch, { ok: false, code: "IDEMPOTENCY_KEY_MISMATCH" });
});

test("opening batch parsers skip zero-amount rows in fingerprint, reject duplicate vendors, negative amounts, __system_vendor__, and all-zero batches", () => {
  const previewOk = parsePreviewOpeningBatchBody({
    cutoff_date: "2026-10-01",
    items: [
      { vendor_id: "VND_1", entry_type: "OPENING_PAYABLE", amount_minor: "1500000" },
      { vendor_id: "VND_2", entry_type: "OPENING_ADVANCE", amount_minor: "0" },
    ],
  });
  assert.equal(previewOk.ok, true);

  // Duplicate vendor_id
  const dup = parsePreviewOpeningBatchBody({
    cutoff_date: "2026-10-01",
    items: [
      { vendor_id: "VND_1", entry_type: "OPENING_PAYABLE", amount_minor: "100" },
      { vendor_id: "VND_1", entry_type: "OPENING_ADVANCE", amount_minor: "200" },
    ],
  });
  assert.deepEqual(dup, { ok: false, code: "VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR" });

  // Reserved __system_vendor__
  const sysVendor = parsePreviewOpeningBatchBody({
    cutoff_date: "2026-10-01",
    items: [{ vendor_id: "__system_vendor__", entry_type: "OPENING_PAYABLE", amount_minor: "100" }],
  });
  assert.deepEqual(sysVendor, { ok: false, code: "VENDOR_FINANCE_VENDOR_INVALID" });

  // All zero rows -> VENDOR_FINANCE_OPENING_BATCH_EMPTY
  const allZero = parseApplyOpeningBatchBody(
    {
      cutoff_date: "2026-10-01",
      items: [{ vendor_id: "VND_1", entry_type: "OPENING_PAYABLE", amount_minor: "0" }],
      reason: "Khởi tạo",
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.deepEqual(allZero, { ok: false, code: "VENDOR_FINANCE_OPENING_BATCH_EMPTY" });

  // Deterministic fingerprint invariant to item order and zero-amount rows
  const fpA = computeApplyOpeningBatchFingerprint({
    cutoff_date: "2026-10-01",
    items: [
      { vendor_id: "VND_B", entry_type: "OPENING_ADVANCE", amount_minor: "500" },
      { vendor_id: "VND_Z", entry_type: "OPENING_PAYABLE", amount_minor: "0" },
      { vendor_id: "VND_A", entry_type: "OPENING_PAYABLE", amount_minor: "1000" },
    ],
    reason: "Cutover",
  });
  const fpB = computeApplyOpeningBatchFingerprint({
    cutoff_date: "2026-10-01",
    items: [
      { vendor_id: "VND_A", entry_type: "OPENING_PAYABLE", amount_minor: "1000" },
      { vendor_id: "VND_B", entry_type: "OPENING_ADVANCE", amount_minor: "500" },
    ],
    reason: "Cutover",
  });
  assert.equal(fpA, fpB);

  const recFpA = computeRecordEntryFingerprint({
    vendor_id: "VND_A",
    entry_type: "DEBT_RECORDED",
    amount_minor: "1000",
    effective_date: "2026-10-24",
    reason: "Test",
  });
  const recFpB = computeRecordEntryFingerprint({
    vendor_id: "VND_A",
    entry_type: "PAYMENT_RECORDED",
    amount_minor: "1000",
    effective_date: "2026-10-24",
    reason: "Test",
  });
  assert.notEqual(recFpA, recFpB);
});

test("reconciliation, reverse, and evidence parsers validate signed amounts, exact keys, and MIME/size/hash bounds", () => {
  const recNeg = parseCreateVendorReconciliationBody(
    {
      as_of_date: "2026-10-24",
      confirmed_balance_minor: "-3500000",
      reason: "NCC xác nhận còn dư ứng 3.5M",
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.equal(recNeg.ok, true);
  assert.equal(recNeg.value.confirmed_balance_minor, "-3500000");

  const revDefaultDate = parseReverseVendorFinanceEntryBody(
    {
      reason: "Nhập nhầm NCC",
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.equal(revDefaultDate.ok, true);
  assert.equal(revDefaultDate.value.effective_date, null);

  const evOk = parseReserveVendorFinanceEvidenceBody(
    {
      target_kind: "ENTRY",
      target_id: ENTRY_ID,
      mime_type: "image/png",
      size_bytes: 1024,
      checksum_sha256: SHA_OK.toUpperCase(),
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.equal(evOk.ok, true);
  assert.equal(evOk.value.checksum_sha256, SHA_OK);

  const evPdfRejected = parseReserveVendorFinanceEvidenceBody(
    {
      target_kind: "ENTRY",
      target_id: ENTRY_ID,
      mime_type: "application/pdf",
      size_bytes: 1024,
      checksum_sha256: SHA_OK,
      idempotency_key: IDEM_1,
    },
    null,
  );
  assert.deepEqual(evPdfRejected, { ok: false, code: "VENDOR_FINANCE_EVIDENCE_MIME_INVALID" });

  assert.deepEqual(parseFinalizeVendorFinanceEvidenceBody({}), { ok: true });
  assert.deepEqual(parseFinalizeVendorFinanceEvidenceBody({ extra: 1 }), {
    ok: false,
    code: "VENDOR_FINANCE_PAYLOAD_INVALID",
  });
});

test("keyset cursor & query parsers bind cursor to vendor_id and reject tampering or duplicate params", () => {
  const cursor = encodeVendorEntriesCursor({ vendor_id: "VND_ALPHA", before_sequence: 42 });
  assert.deepEqual(decodeVendorEntriesCursor(cursor, "VND_ALPHA"), {
    ok: true,
    before_sequence: 42,
  });
  assert.deepEqual(decodeVendorEntriesCursor(cursor, "VND_OTHER"), {
    ok: false,
    code: "VENDOR_FINANCE_CURSOR_INVALID",
  });

  const entriesUrl = new URL(
    `https://bi.local/api/vendor-finance/vendors/VND_ALPHA/entries?cursor=${cursor}&entry_type=PAYROLL_RECORDED&page_size=20`,
  );
  const parsedEntries = parseListVendorFinanceEntriesQuery(entriesUrl, "VND_ALPHA");
  assert.equal(parsedEntries.ok, true);
  assert.equal(parsedEntries.value.before_sequence, 42);
  assert.equal(parsedEntries.value.entry_type, "PAYROLL_RECORDED");

  const dupParamUrl = new URL("https://bi.local/api/vendor-finance/vendors?page=1&page=2");
  assert.deepEqual(parseListVendorFinanceVendorsQuery(dupParamUrl), {
    ok: false,
    code: "VENDOR_FINANCE_QUERY_INVALID",
  });
});

test("response projectors are strictly fail-closed on arithmetic mismatch, extra PII/storage_key fields, or tampered disclaimer", () => {
  const validEntry = makeCanonicalEntry();
  assert.ok(projectVendorFinanceEntry(validEntry));

  // Arithmetic chain tamper: before + delta !== after -> fail closed (null)
  assert.equal(
    projectVendorFinanceEntry(makeCanonicalEntry({ balance_after_minor: "999" })),
    null,
  );

  // Leaked PII or storage_key -> fail closed (null)
  assert.equal(
    projectVendorFinanceEntry({ ...validEntry, app_user_id: IDEM_1 }),
    null,
  );

  // Tampered internal disclaimer -> fail closed (null)
  assert.equal(
    projectVendorFinanceEntry(makeCanonicalEntry({ internal_disclaimer: "Fake bank receipt" })),
    null,
  );

  // Reconciliation difference arithmetic check: confirmed - system === difference
  const validRec = {
    reconciliation_id: REC_ID,
    vendor_id: "VND_ALPHA",
    as_of_date: "2026-10-24",
    system_balance_minor: "1000000",
    confirmed_balance_minor: "850000",
    difference_minor: "-150000",
    ledger_sequence_at_reconciliation: 4,
    reason: "Đối soát tháng 10",
    can_attach_evidence: true,
    evidence: null,
    created_by_display_name: "Trần Thị Kế Toán",
    created_at: "2026-10-24T02:00:00.000Z",
  };
  assert.ok(projectVendorReconciliation(validRec));
  assert.equal(
    projectVendorReconciliation({ ...validRec, difference_minor: "150000" }),
    null,
  );

  // Vendor detail projection preserves allowed_entry_types
  const detail = projectVendorFinanceVendorDetail({
    authorization_date: "2026-10-24",
    allowed_actions: {
      can_view: true,
      can_record: true,
      can_reconcile: true,
      allowed_entry_types: ["PAYMENT_RECORDED", "ADJUSTMENT_INCREASE", "ADJUSTMENT_DECREASE"],
    },
    vendor: {
      vendor_id: "VND_ALPHA",
      display_name: "Công ty TNHH Alpha",
      active: false,
      current_balance_minor: "1000000",
      balance_direction: "PAYABLE",
      latest_sequence: 1,
      entry_count: 1,
      has_opening_entry: false,
      eligible_for_opening: false,
      totals: {
        opening_payable_minor: "0",
        opening_advance_minor: "0",
        debt_recorded_minor: "1000000",
        payroll_recorded_minor: "0",
        payment_recorded_minor: "0",
        advance_recorded_minor: "0",
        adjustment_increase_minor: "0",
        adjustment_decrease_minor: "0",
        reversed_entry_count: 0,
      },
      latest_reconciliation: validRec,
      recent_reconciliations: [validRec],
    },
  });
  assert.ok(detail);
  assert.deepEqual(detail.allowed_actions.allowed_entry_types, [
    "PAYMENT_RECORDED",
    "ADJUSTMENT_INCREASE",
    "ADJUSTMENT_DECREASE",
  ]);

  // Opening batch apply requires entries.length === batch.vendor_count
  assert.ok(
    projectOpeningApplyMutation({
      batch: {
        batch_id: BATCH_ID,
        cutoff_date: "2026-10-01",
        vendor_count: 1,
        skipped_zero_count: 2,
        total_payable_minor: "9007199254740993",
        total_advance_minor: "0",
        net_balance_minor: "9007199254740993",
        reason: "Chốt số dư đầu kỳ",
        created_by_display_name: "Trần Thị Kế Toán",
        created_at: "2026-10-24T02:00:00.000Z",
      },
      entries: [makeCanonicalEntry({ entry_type: "OPENING_PAYABLE", opening_batch_id: BATCH_ID })],
      replayed: false,
    }),
  );
});
