import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  NORMAL_VENDOR_FINANCE_ENTRY_TYPES,
  OPENING_VENDOR_FINANCE_ENTRY_TYPES,
  PG_BIGINT_MAX,
  PG_BIGINT_MIN,
  VENDOR_FINANCE_CONTRACT_VERSION,
  VENDOR_FINANCE_DOCUMENT_KINDS,
  VENDOR_FINANCE_ENTRY_TYPES,
  VENDOR_FINANCE_EVIDENCE_MAX_BYTES,
  VENDOR_FINANCE_EVIDENCE_MIME_TYPES,
  VENDOR_FINANCE_EVIDENCE_TARGET_KINDS,
  VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
  VENDOR_FINANCE_MAX_OPENING_BATCH_ITEMS,
  VENDOR_FINANCE_MAX_REASON_LENGTH,
  VENDOR_FINANCE_MAX_SEARCH_LENGTH,
  checkForbiddenVendorFinanceClientFields,
  encodeVendorEntriesCursor,
  parseApplyOpeningBatchBody,
  parseCreateVendorReconciliationBody,
  parseFinalizeVendorFinanceEvidenceBody,
  parseListVendorFinanceEntriesQuery,
  parseListVendorFinanceVendorsQuery,
  parseListVendorReconciliationsQuery,
  parsePreviewOpeningBatchBody,
  parseRecordVendorFinanceEntryBody,
  parseReserveVendorFinanceEvidenceBody,
  parseReverseVendorFinanceEntryBody,
} from "./vendor-finance-contract.ts";
import {
  VFIN_UI_ACTIVE_FILTERS,
  VFIN_UI_BALANCE_FILTERS,
  VFIN_UI_CONTRACT_VERSION,
  VFIN_UI_DOCUMENT_KINDS,
  VFIN_UI_ENTRY_TYPES,
  VFIN_UI_EVIDENCE_MAX_BYTES,
  VFIN_UI_EVIDENCE_MIME_TYPES,
  VFIN_UI_EVIDENCE_TARGET_KINDS,
  VFIN_UI_INTERNAL_DISCLAIMER_VI,
  VFIN_UI_MAX_OPENING_BATCH_ITEMS,
  VFIN_UI_MAX_REASON_LENGTH,
  VFIN_UI_MAX_SEARCH_LENGTH,
  VFIN_UI_NORMAL_ENTRY_TYPES,
  VFIN_UI_OPENING_ENTRY_TYPES,
  VFIN_UI_PG_BIGINT_MAX,
  VFIN_UI_PG_BIGINT_MIN,
  buildCreateReconciliationRequest,
  buildDownloadEvidenceUrl,
  buildFinalizeEvidenceRequest,
  buildFinalizeEvidenceUrl,
  buildOpeningApplyRequest,
  buildOpeningApplyUrl,
  buildOpeningPreviewRequest,
  buildOpeningPreviewUrl,
  buildRecordEntryRequest,
  buildReserveEvidenceRequest,
  buildReserveEvidenceUrl,
  buildReverseEntryRequest,
  buildReverseEntryUrl,
  buildSingleEntryUrl,
  buildVendorDetailUrl,
  buildVendorEntriesUrl,
  buildVendorListUrl,
  buildVendorReconciliationsUrl,
  classifyVendorFinanceError,
  computeBrowserSha256Hex,
  computeReconciliationDifferencePreview,
  decideVendorFinancePageAccess,
  formatAbsoluteVndMinor,
  formatSignedVndDelta,
  formatVendorBalancePresentation,
  formatVietnamDateLabel,
  formatVndMinor,
  isCanonicalUiVendorId,
  normalizeNonNegativeVndInput,
  normalizePositiveVndInput,
  normalizeSignedVndInput,
  parseCreateReconciliationEnvelope,
  parseEvidenceDownloadEnvelope,
  parseEvidenceFinalizeEnvelope,
  parseEvidenceReserveEnvelope,
  parseOpeningApplyEnvelope,
  parseOpeningPreviewEnvelope,
  parseRecordEntryEnvelope,
  parseReverseEntryEnvelope,
  parseSingleEntryEnvelope,
  parseVendorDetailEnvelope,
  parseVendorEntriesPageEnvelope,
  parseVendorListEnvelope,
  parseVendorReconciliationsPageEnvelope,
  uploadEvidenceForCommittedTarget,
  validateEvidenceFilePreflight,
} from "./ui-model.ts";

const ENTRY_ID = "11111111-1111-4111-8111-111111111111";
const REVERSAL_ENTRY_ID = "22222222-2222-4222-8222-222222222222";
const RECONCILIATION_ID = "33333333-3333-4333-8333-333333333333";
const EVIDENCE_ID = "44444444-4444-4444-8444-444444444444";
const EVIDENCE_ID_2 = "55555555-5555-4555-8555-555555555555";
const BATCH_ID = "66666666-6666-4666-8666-666666666666";
const IDEMPOTENCY_KEY = "77777777-7777-4777-8777-777777777777";
const SAMPLE_SHA256 = "a".repeat(64);

function makeActor({
  capabilities = [],
  scopes = [{ kind: "all" }],
} = {}) {
  return {
    ok: true,
    actor: {
      auth_subject: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      app_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      display_name: "Người Dùng Kiểm Thử",
      capabilities,
      scopes,
    },
  };
}

function makeEvidenceSummary(overrides = {}) {
  return {
    evidence_id: EVIDENCE_ID,
    status: "READY",
    mime_type: "image/png",
    size_bytes: 2048,
    checksum_sha256: SAMPLE_SHA256,
    finalized_at: "2026-10-25T09:15:00.000Z",
    ...overrides,
  };
}

function makeEntryProjection(overrides = {}) {
  return {
    entry_id: ENTRY_ID,
    vendor_id: "VND-001",
    vendor_display_name_snapshot: "Công ty TNHH Cung Ứng Nhân Lực Sao Việt",
    vendor_active: true,
    vendor_sequence: 3,
    document_no: "VFIN-2026-000003",
    document_kind: "PAYMENT_VOUCHER",
    document_title_vi: "Phiếu ghi nhận thanh toán Vendor",
    entry_type: "PAYMENT_RECORDED",
    amount_minor: "5000000",
    balance_before_minor: "15000000",
    balance_delta_minor: "-5000000",
    balance_after_minor: "10000000",
    effective_date: "2026-10-25",
    reason: "Thanh toán đợt 1 theo bảng kê tháng 10/2026",
    opening_batch_id: null,
    reverses_entry_id: null,
    reverses_document_no: null,
    reversed_by_entry_id: null,
    reversed_by_document_no: null,
    can_reverse: true,
    can_attach_evidence: true,
    evidence: null,
    created_by_display_name: "Nguyễn Thị Kế Toán",
    created_at: "2026-10-25T09:00:00.000Z",
    internal_disclaimer: VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
    ...overrides,
  };
}

function makeReconciliationProjection(overrides = {}) {
  return {
    reconciliation_id: RECONCILIATION_ID,
    vendor_id: "VND-001",
    as_of_date: "2026-10-25",
    system_balance_minor: "10000000",
    confirmed_balance_minor: "10500000",
    difference_minor: "500000",
    ledger_sequence_at_reconciliation: 3,
    reason: "Đối chiếu biên bản cuối ngày với kế toán Vendor",
    can_attach_evidence: true,
    evidence: null,
    created_by_display_name: "Nguyễn Thị Kế Toán",
    created_at: "2026-10-25T10:00:00.000Z",
    ...overrides,
  };
}

function makeFakeImageFile({
  name = "bien-nhan.png",
  type = "image/png",
  bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]),
} = {}) {
  return {
    name,
    type,
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

test("browser-safe UI constants stay 100% synchronized with canonical backend contract", () => {
  assert.equal(VFIN_UI_CONTRACT_VERSION, VENDOR_FINANCE_CONTRACT_VERSION);
  assert.equal(VFIN_UI_INTERNAL_DISCLAIMER_VI, VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI);
  assert.equal(VFIN_UI_MAX_REASON_LENGTH, VENDOR_FINANCE_MAX_REASON_LENGTH);
  assert.equal(VFIN_UI_MAX_SEARCH_LENGTH, VENDOR_FINANCE_MAX_SEARCH_LENGTH);
  assert.equal(VFIN_UI_MAX_OPENING_BATCH_ITEMS, VENDOR_FINANCE_MAX_OPENING_BATCH_ITEMS);
  assert.equal(VFIN_UI_EVIDENCE_MAX_BYTES, VENDOR_FINANCE_EVIDENCE_MAX_BYTES);
  assert.equal(VFIN_UI_PG_BIGINT_MAX, PG_BIGINT_MAX);
  assert.equal(VFIN_UI_PG_BIGINT_MIN, PG_BIGINT_MIN);
  assert.deepEqual(VFIN_UI_ENTRY_TYPES, VENDOR_FINANCE_ENTRY_TYPES);
  assert.deepEqual(VFIN_UI_NORMAL_ENTRY_TYPES, NORMAL_VENDOR_FINANCE_ENTRY_TYPES);
  assert.deepEqual(VFIN_UI_OPENING_ENTRY_TYPES, OPENING_VENDOR_FINANCE_ENTRY_TYPES);
  assert.deepEqual(VFIN_UI_DOCUMENT_KINDS, VENDOR_FINANCE_DOCUMENT_KINDS);
  assert.deepEqual(VFIN_UI_EVIDENCE_MIME_TYPES, VENDOR_FINANCE_EVIDENCE_MIME_TYPES);
  assert.deepEqual(VFIN_UI_EVIDENCE_TARGET_KINDS, VENDOR_FINANCE_EVIDENCE_TARGET_KINDS);
  assert.deepEqual(VFIN_UI_ACTIVE_FILTERS, ["all", "active", "inactive"]);
  assert.deepEqual(VFIN_UI_BALANCE_FILTERS, [
    "all",
    "payable",
    "advance",
    "nonzero",
    "uninitialized",
  ]);
});

test("decideVendorFinancePageAccess enforces feature flag, authentication, view vs record authority, and fail-closed errors", () => {
  const fullAdmin = makeActor({
    capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    scopes: [{ kind: "all" }],
  });
  const entryAdminOnly = makeActor({
    capabilities: ["entry_admin"],
    scopes: [{ kind: "all" }],
  });
  const directRecorder = makeActor({
    capabilities: ["vendor_finance_record"],
    scopes: [{ kind: "all" }],
  });
  const bodViewer = makeActor({
    capabilities: ["vendor_finance_view"],
    scopes: [{ kind: "all" }],
  });
  const accountingMember = makeActor({ capabilities: [], scopes: [] });
  const catalogAdminOnly = makeActor({
    capabilities: ["catalog_master_manage"],
    scopes: [{ kind: "all" }],
  });
  const wrongScopeViewer = makeActor({
    capabilities: ["vendor_finance_view"],
    scopes: [{ kind: "team" }],
  });

  // Feature off -> NOT_FOUND
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "false",
      requiredMode: "view",
      actor: fullAdmin,
    }),
    "NOT_FOUND",
  );
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: undefined,
      requiredMode: "record",
      actor: fullAdmin,
    }),
    "NOT_FOUND",
  );

  // Unauthenticated / unmapped / disabled / resolver failure
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "view",
      actor: { ok: false, reason: "UNAUTHENTICATED" },
    }),
    "REDIRECT_LOGIN",
  );
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "view",
      actor: { ok: false, reason: "ACTOR_MAPPING_MISSING" },
    }),
    "ACCOUNT_UNAVAILABLE",
  );
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "view",
      actor: { ok: false, reason: "ACTOR_DISABLED" },
    }),
    "ACCOUNT_UNAVAILABLE",
  );
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "view",
      actor: null,
    }),
    "TEMPORARY_UNAVAILABLE",
  );

  // Full Admin & direct vendor_finance_record @ all -> ALLOW on both view and record
  for (const actor of [fullAdmin, directRecorder]) {
    assert.equal(
      decideVendorFinancePageAccess({ enabledFlag: "true", requiredMode: "view", actor }),
      "ALLOW",
    );
    assert.equal(
      decideVendorFinancePageAccess({ enabledFlag: "true", requiredMode: "record", actor }),
      "ALLOW",
    );
  }

  // Active Accounting Department member (resolved via server getActorAccess) -> ALLOW view & record
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "view",
      actor: accountingMember,
      serverAccess: { ok: true, can_view: true, can_record: true },
    }),
    "ALLOW",
  );
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "record",
      actor: accountingMember,
      serverAccess: { ok: true, can_view: true, can_record: true },
    }),
    "ALLOW",
  );

  // BoD / View-only (`vendor_finance_view @ all`) -> ALLOW on view, ACCESS_DENIED on record (/finance/opening-balance)
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "view",
      actor: bodViewer,
      serverAccess: { ok: true, can_view: true, can_record: false },
    }),
    "ALLOW",
  );
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "record",
      actor: bodViewer,
      serverAccess: { ok: true, can_view: true, can_record: false },
    }),
    "ACCESS_DENIED",
  );

  // Non-privileged roles (`entry_admin` alone, `catalog_master_manage`, non-all scopes) -> ACCESS_DENIED
  for (const actor of [entryAdminOnly, catalogAdminOnly, wrongScopeViewer, accountingMember]) {
    assert.equal(
      decideVendorFinancePageAccess({
        enabledFlag: "true",
        requiredMode: "view",
        actor,
        serverAccess: { ok: true, can_view: false, can_record: false },
      }),
      "ACCESS_DENIED",
    );
    assert.equal(
      decideVendorFinancePageAccess({
        enabledFlag: "true",
        requiredMode: "record",
        actor,
        serverAccess: { ok: false, code: "VENDOR_FINANCE_ACCESS_DENIED" },
      }),
      "ACCESS_DENIED",
    );
  }

  // Server access RPC transient error -> TEMPORARY_UNAVAILABLE (fail closed)
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "view",
      actor: accountingMember,
      serverAccess: { ok: false, code: "VENDOR_FINANCE_UNAVAILABLE" },
    }),
    "TEMPORARY_UNAVAILABLE",
  );
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "view",
      actor: accountingMember,
      serverAccess: { ok: false, code: "ACTOR_NOT_AVAILABLE" },
    }),
    "ACCOUNT_UNAVAILABLE",
  );
});

test("BigInt VND formatters and normalizers preserve exact digits beyond Number.MAX_SAFE_INTEGER and reject decimals", () => {
  // Exact 64-bit integer precision (> 2^53 - 1 where JS Number loses precision)
  assert.equal(formatVndMinor("9007199254740993"), "9.007.199.254.740.993 ₫");
  assert.equal(formatVndMinor("9223372036854775807"), "9.223.372.036.854.775.807 ₫");
  assert.equal(formatVndMinor("-9223372036854775808"), "-9.223.372.036.854.775.808 ₫");
  assert.equal(formatVndMinor("0"), "0 ₫");
  assert.equal(formatVndMinor("-250000"), "-250.000 ₫");
  assert.equal(formatVndMinor("100.5"), "—");
  assert.equal(formatVndMinor("-0"), "—");

  assert.equal(formatSignedVndDelta("1500000"), "+1.500.000 ₫");
  assert.equal(formatSignedVndDelta("-1500000"), "-1.500.000 ₫");
  assert.equal(formatSignedVndDelta("0"), "0 ₫");
  assert.equal(formatAbsoluteVndMinor("-9007199254740993"), "9.007.199.254.740.993 ₫");

  // Balance presentation states
  assert.deepEqual(
    formatVendorBalancePresentation({
      current_balance_minor: "0",
      balance_direction: "BALANCED",
      entry_count: 0,
      has_opening_entry: false,
    }),
    {
      amountText: "0 ₫",
      signedText: "0 ₫",
      statusLabel: "Chưa khởi tạo đầu kỳ",
      tone: "neutral",
    },
  );
  assert.equal(
    formatVendorBalancePresentation({
      current_balance_minor: "2500000",
      balance_direction: "PAYABLE",
      entry_count: 2,
      has_opening_entry: true,
    }).statusLabel,
    "Phải trả Vendor",
  );
  assert.equal(
    formatVendorBalancePresentation({
      current_balance_minor: "-1200000",
      balance_direction: "ADVANCE",
      entry_count: 1,
      has_opening_entry: true,
    }).amountText,
    "1.200.000 ₫",
  );

  // Input normalization: plain digits + consistent thousand grouping accepted; decimals/floats rejected
  assert.deepEqual(normalizePositiveVndInput(" 1.500.000 "), {
    ok: true,
    canonical: "1500000",
    value: 1500000n,
  });
  assert.deepEqual(normalizePositiveVndInput("9007199254740993"), {
    ok: true,
    canonical: "9007199254740993",
    value: 9007199254740993n,
  });
  for (const invalid of ["", "0", "-500", "+500", "100.5", "100,50", "1.500,000", "00100", "1e6"]) {
    const res = normalizePositiveVndInput(invalid);
    assert.equal(res.ok, false, `expected ${invalid} to be rejected`);
    assert.equal(res.code, "VENDOR_FINANCE_AMOUNT_INVALID");
  }
  assert.equal(normalizePositiveVndInput("9223372036854775808").code, "VENDOR_FINANCE_AMOUNT_OVERFLOW");

  // Non-negative input (opening balance): allows "0", rejects negative & decimals
  assert.deepEqual(normalizeNonNegativeVndInput("0"), {
    ok: true,
    canonical: "0",
    value: 0n,
  });
  assert.equal(normalizeNonNegativeVndInput("-1").ok, false);
  assert.equal(normalizeNonNegativeVndInput("12.34").ok, false);

  // Signed input (reconciliation): allows negative, zero, positive; rejects "-0" and decimals
  assert.deepEqual(normalizeSignedVndInput("-1.250.000"), {
    ok: true,
    canonical: "-1250000",
    value: -1250000n,
  });
  assert.deepEqual(normalizeSignedVndInput("-9223372036854775808"), {
    ok: true,
    canonical: "-9223372036854775808",
    value: -9223372036854775808n,
  });
  assert.equal(normalizeSignedVndInput("-0").ok, false);
  assert.equal(normalizeSignedVndInput("-9223372036854775809").code, "VENDOR_FINANCE_AMOUNT_OVERFLOW");

  // Reconciliation difference preview (`confirmed - system`) using BigInt
  assert.equal(
    computeReconciliationDifferencePreview("9007199254740991", "9007199254740995"),
    "4",
  );
  assert.equal(computeReconciliationDifferencePreview("10000000", "8500000"), "-1500000");
  // Overflow when confirmed - system exceeds int8 max
  assert.equal(
    computeReconciliationDifferencePreview("-9223372036854775808", "9223372036854775807"),
    null,
  );
  assert.equal(formatVietnamDateLabel("2026-10-25"), "25/10/2026");
});

test("URL and request builders round-trip cleanly through canonical VFIN-01 backend parsers with zero forbidden fields", () => {
  assert.equal(isCanonicalUiVendorId("__system_vendor__"), false);
  assert.equal(isCanonicalUiVendorId("VND-001"), true);

  // 1. Vendor list URL -> parseListVendorFinanceVendorsQuery
  const listUrl = buildVendorListUrl({
    search: "  Sao Việt  ",
    active: "active",
    balance_filter: "payable",
    page: 2,
    page_size: 25,
  });
  const parsedListQuery = parseListVendorFinanceVendorsQuery(
    new URL(`http://localhost${listUrl}`),
  );
  assert.deepEqual(parsedListQuery, {
    ok: true,
    value: {
      search: "Sao Việt",
      active: "active",
      balance_filter: "payable",
      page: 2,
      page_size: 25,
    },
  });

  // 2. Vendor entries URL (keyset cursor) -> parseListVendorFinanceEntriesQuery
  const cursor = encodeVendorEntriesCursor({ vendor_id: "VND-001", before_sequence: 10 });
  const entriesUrl = buildVendorEntriesUrl("VND-001", {
    cursor,
    entry_type: "PAYROLL_RECORDED",
    page_size: 25,
  });
  const parsedEntriesQuery = parseListVendorFinanceEntriesQuery(
    new URL(`http://localhost${entriesUrl}`),
    "VND-001",
  );
  assert.deepEqual(parsedEntriesQuery, {
    ok: true,
    value: {
      before_sequence: 10,
      entry_type: "PAYROLL_RECORDED",
      page_size: 25,
    },
  });

  // 3. Reconciliations URL -> parseListVendorReconciliationsQuery
  const recUrl = buildVendorReconciliationsUrl("VND-001", { page: 3, page_size: 15 });
  assert.deepEqual(parseListVendorReconciliationsQuery(new URL(`http://localhost${recUrl}`)), {
    ok: true,
    value: { page: 3, page_size: 15 },
  });

  assert.equal(buildVendorDetailUrl("VND-001"), "/api/vendor-finance/vendors/VND-001");
  assert.equal(buildSingleEntryUrl(ENTRY_ID), `/api/vendor-finance/entries/${ENTRY_ID}`);
  assert.equal(buildReverseEntryUrl(ENTRY_ID), `/api/vendor-finance/entries/${ENTRY_ID}/reverse`);
  assert.equal(buildOpeningPreviewUrl(), "/api/vendor-finance/opening-batches/preview");
  assert.equal(buildOpeningApplyUrl(), "/api/vendor-finance/opening-batches/apply");
  assert.equal(buildReserveEvidenceUrl(), "/api/vendor-finance/evidence/reserve");
  assert.equal(buildFinalizeEvidenceUrl(EVIDENCE_ID), `/api/vendor-finance/evidence/${EVIDENCE_ID}/finalize`);
  assert.equal(buildDownloadEvidenceUrl(EVIDENCE_ID), `/api/vendor-finance/evidence/${EVIDENCE_ID}/download`);

  // 4. Record entry request -> parseRecordVendorFinanceEntryBody (all 6 normal entry types)
  for (const type of VFIN_UI_NORMAL_ENTRY_TYPES) {
    const built = buildRecordEntryRequest({
      entry_type: type,
      amount_input: "12.500.000",
      effective_date: "2026-10-25",
      reason: "  Ghi nhận chứng từ kiểm thử  ",
      idempotency_key: IDEMPOTENCY_KEY.toUpperCase(),
      allowed_entry_types: VFIN_UI_NORMAL_ENTRY_TYPES,
    });
    assert.equal(built.ok, true);
    assert.deepEqual(checkForbiddenVendorFinanceClientFields(built.request.body), { ok: true });
    const serverParsed = parseRecordVendorFinanceEntryBody(
      built.request.body,
      built.request.headers["Idempotency-Key"],
    );
    assert.deepEqual(serverParsed, {
      ok: true,
      value: {
        entry_type: type,
        amount_minor: "12500000",
        effective_date: "2026-10-25",
        reason: "Ghi nhận chứng từ kiểm thử",
        idempotency_key: IDEMPOTENCY_KEY,
      },
    });
  }

  // Disallowed entry type for inactive vendor blocked before network call
  assert.equal(
    buildRecordEntryRequest({
      entry_type: "DEBT_RECORDED",
      amount_input: "1000000",
      effective_date: "2026-10-25",
      reason: "Không cho phép nợ mới trên vendor inactive",
      idempotency_key: IDEMPOTENCY_KEY,
      allowed_entry_types: ["PAYMENT_RECORDED", "ADJUSTMENT_DECREASE"],
    }).ok,
    false,
  );

  // 5. Reverse entry request -> parseReverseVendorFinanceEntryBody
  const reverseBuilt = buildReverseEntryRequest({
    effective_date: "",
    reason: "Nhập nhầm số tiền đợt 1",
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(reverseBuilt.ok, true);
  assert.deepEqual(
    parseReverseVendorFinanceEntryBody(
      reverseBuilt.request.body,
      reverseBuilt.request.headers["Idempotency-Key"],
    ),
    {
      ok: true,
      value: {
        effective_date: null,
        reason: "Nhập nhầm số tiền đợt 1",
        idempotency_key: IDEMPOTENCY_KEY,
      },
    },
  );

  // 6. Opening preview & apply requests -> parsePreviewOpeningBatchBody & parseApplyOpeningBatchBody
  const openingRows = [
    { vendor_id: "VND-001", entry_type: "OPENING_PAYABLE", amount_input: "25.000.000" },
    { vendor_id: "VND-002", entry_type: "OPENING_ADVANCE", amount_input: "0" },
    { vendor_id: "VND-003", entry_type: "OPENING_ADVANCE", amount_input: "4000000" },
  ];
  const previewBuilt = buildOpeningPreviewRequest({
    cutoff_date: "2026-10-01",
    rows: openingRows,
  });
  assert.equal(previewBuilt.ok, true);
  assert.equal(previewBuilt.non_zero_count, 2);
  assert.equal(previewBuilt.zero_count, 1);
  assert.equal(parsePreviewOpeningBatchBody(previewBuilt.request.body).ok, true);

  const applyBuilt = buildOpeningApplyRequest({
    cutoff_date: "2026-10-01",
    rows: openingRows,
    reason: "Chốt tồn đầu kỳ theo biên bản bàn giao",
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(applyBuilt.ok, true);
  assert.equal(
    parseApplyOpeningBatchBody(
      applyBuilt.request.body,
      applyBuilt.request.headers["Idempotency-Key"],
    ).ok,
    true,
  );

  // Opening validation: reject all-zero batch, duplicate vendor, __system_vendor__, > 200 items
  assert.equal(
    buildOpeningPreviewRequest({
      cutoff_date: "2026-10-01",
      rows: [{ vendor_id: "VND-001", entry_type: "OPENING_PAYABLE", amount_input: "0" }],
    }).ok,
    false,
  );
  const dupCheck = buildOpeningPreviewRequest({
    cutoff_date: "2026-10-01",
    rows: [
      { vendor_id: "VND-001", entry_type: "OPENING_PAYABLE", amount_input: "1000" },
      { vendor_id: "VND-001", entry_type: "OPENING_ADVANCE", amount_input: "2000" },
    ],
  });
  assert.equal(dupCheck.ok, false);
  assert.equal(dupCheck.invalid_vendor_id, "VND-001");
  assert.equal(
    buildOpeningPreviewRequest({
      cutoff_date: "2026-10-01",
      rows: [{ vendor_id: "__system_vendor__", entry_type: "OPENING_PAYABLE", amount_input: "1000" }],
    }).ok,
    false,
  );
  assert.equal(
    buildOpeningPreviewRequest({
      cutoff_date: "2026-10-01",
      rows: Array.from({ length: 201 }, (_, idx) => ({
        vendor_id: `VND-${idx + 1}`,
        entry_type: "OPENING_PAYABLE",
        amount_input: "1000",
      })),
    }).ok,
    false,
  );

  // 7. Create reconciliation request -> parseCreateVendorReconciliationBody
  const recBuilt = buildCreateReconciliationRequest({
    as_of_date: "2026-10-25",
    confirmed_balance_input: "-3.500.000",
    reason: "Vendor xác nhận đang giữ dư ứng 3.5tr",
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(recBuilt.ok, true);
  assert.deepEqual(
    parseCreateVendorReconciliationBody(
      recBuilt.request.body,
      recBuilt.request.headers["Idempotency-Key"],
    ),
    {
      ok: true,
      value: {
        as_of_date: "2026-10-25",
        confirmed_balance_minor: "-3500000",
        reason: "Vendor xác nhận đang giữ dư ứng 3.5tr",
        idempotency_key: IDEMPOTENCY_KEY,
      },
    },
  );

  // 8. Reserve & finalize evidence requests -> server parsers
  const reserveBuilt = buildReserveEvidenceRequest({
    target_kind: "ENTRY",
    target_id: ENTRY_ID,
    mime_type: "image/jpeg",
    size_bytes: 512000,
    checksum_sha256: SAMPLE_SHA256.toUpperCase(),
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(reserveBuilt.ok, true);
  assert.equal(
    parseReserveVendorFinanceEvidenceBody(
      reserveBuilt.request.body,
      reserveBuilt.request.headers["Idempotency-Key"],
    ).ok,
    true,
  );
  assert.deepEqual(parseFinalizeVendorFinanceEvidenceBody(buildFinalizeEvidenceRequest().body), {
    ok: true,
  });
});

test("HTTP response envelope parsers validate all 11 endpoint contracts and fail closed on tampered invariants or leaked fields", () => {
  const entry = makeEntryProjection({ evidence: makeEvidenceSummary() });
  const rec = makeReconciliationProjection({ evidence: makeEvidenceSummary() });

  // 1. Vendor list envelope
  const validList = {
    ok: true,
    data: {
      authorization_date: "2026-10-25",
      allowed_actions: { can_view: true, can_record: false },
      summary: {
        total_payable_minor: "10000000",
        total_advance_minor: "2000000",
        net_balance_minor: "8000000",
        vendors_with_payable_count: 1,
        vendors_with_advance_count: 1,
        vendors_with_nonzero_balance_count: 2,
        total_vendor_count: 3,
        uninitialized_vendor_count: 1,
      },
      filters: { search: null, active: "all", balance_filter: "all" },
      page: 1,
      page_size: 25,
      total: 1,
      has_more: false,
      vendors: [
        {
          vendor_id: "VND-001",
          display_name: "Sao Việt",
          active: true,
          current_balance_minor: "10000000",
          balance_direction: "PAYABLE",
          entry_count: 3,
          has_opening_entry: true,
          eligible_for_opening: false,
          last_effective_date: "2026-10-25",
          last_entry_at: "2026-10-25T09:00:00.000Z",
          last_reconciled_as_of_date: "2026-10-25",
        },
      ],
    },
  };
  assert.ok(parseVendorListEnvelope(validList));
  assert.equal(parseVendorListEnvelope({ ...validList, extra: 1 }), null);

  // 2. Vendor detail envelope
  const validDetail = {
    ok: true,
    data: {
      authorization_date: "2026-10-25",
      allowed_actions: {
        can_view: true,
        can_record: true,
        can_reconcile: true,
        allowed_entry_types: ["DEBT_RECORDED", "PAYMENT_RECORDED"],
      },
      vendor: {
        vendor_id: "VND-001",
        display_name: "Sao Việt",
        active: true,
        current_balance_minor: "10000000",
        balance_direction: "PAYABLE",
        latest_sequence: 3,
        entry_count: 3,
        has_opening_entry: true,
        eligible_for_opening: false,
        totals: {
          opening_payable_minor: "15000000",
          opening_advance_minor: "0",
          debt_recorded_minor: "0",
          payroll_recorded_minor: "0",
          payment_recorded_minor: "5000000",
          advance_recorded_minor: "0",
          adjustment_increase_minor: "0",
          adjustment_decrease_minor: "0",
          reversed_entry_count: 0,
        },
        latest_reconciliation: rec,
        recent_reconciliations: [rec],
      },
    },
  };
  assert.ok(parseVendorDetailEnvelope(validDetail));

  // 3. Entries page envelope + keyset cursor invariant
  const nextCursor = encodeVendorEntriesCursor({ vendor_id: "VND-001", before_sequence: 3 });
  assert.ok(
    parseVendorEntriesPageEnvelope({
      ok: true,
      data: {
        authorization_date: "2026-10-25",
        vendor_id: "VND-001",
        page_size: 25,
        has_more: true,
        next_cursor: nextCursor,
        entries: [entry],
      },
    }),
  );
  // Fail closed when has_more=true but next_cursor=null
  assert.equal(
    parseVendorEntriesPageEnvelope({
      ok: true,
      data: {
        authorization_date: "2026-10-25",
        vendor_id: "VND-001",
        page_size: 25,
        has_more: true,
        next_cursor: null,
        entries: [entry],
      },
    }),
    null,
  );

  // 4. Single entry, record entry, reverse entry envelopes
  assert.ok(
    parseSingleEntryEnvelope({
      ok: true,
      data: {
        authorization_date: "2026-10-25",
        allowed_actions: { can_view: true, can_record: false },
        entry,
      },
    }),
  );
  assert.ok(parseRecordEntryEnvelope({ ok: true, data: { entry, replayed: false } }));
  assert.ok(
    parseReverseEntryEnvelope({
      ok: true,
      data: {
        reversal_entry: makeEntryProjection({
          entry_id: REVERSAL_ENTRY_ID,
          vendor_sequence: 4,
          document_no: "VFIN-2026-000004",
          entry_type: "REVERSAL",
          balance_before_minor: "10000000",
          balance_delta_minor: "5000000",
          balance_after_minor: "15000000",
          reverses_entry_id: ENTRY_ID,
          reverses_document_no: "VFIN-2026-000003",
          can_reverse: false,
        }),
        reversed_entry: makeEntryProjection({
          reversed_by_entry_id: REVERSAL_ENTRY_ID,
          reversed_by_document_no: "VFIN-2026-000004",
          can_reverse: false,
        }),
        replayed: false,
      },
    }),
  );

  // Broken ledger invariant (`before + delta !== after`) or modified disclaimer or leaked `app_user_id` MUST fail closed
  assert.equal(
    parseRecordEntryEnvelope({
      ok: true,
      data: {
        entry: makeEntryProjection({ balance_after_minor: "9999999" }),
        replayed: false,
      },
    }),
    null,
  );
  assert.equal(
    parseRecordEntryEnvelope({
      ok: true,
      data: {
        entry: makeEntryProjection({ internal_disclaimer: "Đã thanh toán qua ngân hàng" }),
        replayed: false,
      },
    }),
    null,
  );
  assert.equal(
    parseRecordEntryEnvelope({
      ok: true,
      data: {
        entry: { ...entry, app_user_id: ENTRY_ID },
        replayed: false,
      },
    }),
    null,
  );

  // 5. Opening preview & apply envelopes
  assert.ok(
    parseOpeningPreviewEnvelope({
      ok: true,
      data: {
        authorization_date: "2026-10-25",
        cutoff_date: "2026-10-01",
        vendor_count: 1,
        skipped_zero_count: 1,
        total_payable_minor: "15000000",
        total_advance_minor: "0",
        net_balance_minor: "15000000",
        items: [
          {
            vendor_id: "VND-001",
            display_name: "Sao Việt",
            active: true,
            entry_type: "OPENING_PAYABLE",
            amount_minor: "15000000",
            balance_delta_minor: "15000000",
          },
        ],
      },
    }),
  );
  assert.ok(
    parseOpeningApplyEnvelope({
      ok: true,
      data: {
        batch: {
          batch_id: BATCH_ID,
          cutoff_date: "2026-10-01",
          vendor_count: 1,
          skipped_zero_count: 0,
          total_payable_minor: "15000000",
          total_advance_minor: "0",
          net_balance_minor: "15000000",
          reason: "Khởi tạo đầu kỳ",
          created_by_display_name: "Nguyễn Thị Kế Toán",
          created_at: "2026-10-25T08:00:00.000Z",
        },
        entries: [
          makeEntryProjection({
            document_kind: "OPENING_BALANCE_VOUCHER",
            entry_type: "OPENING_PAYABLE",
            amount_minor: "15000000",
            balance_before_minor: "0",
            balance_delta_minor: "15000000",
            balance_after_minor: "15000000",
            opening_batch_id: BATCH_ID,
          }),
        ],
        replayed: false,
      },
    }),
  );

  // 6. Reconciliations page & create envelopes + broken difference invariant check
  assert.ok(
    parseVendorReconciliationsPageEnvelope({
      ok: true,
      data: {
        authorization_date: "2026-10-25",
        vendor_id: "VND-001",
        page: 1,
        page_size: 15,
        total: 1,
        has_more: false,
        reconciliations: [rec],
      },
    }),
  );
  assert.ok(
    parseCreateReconciliationEnvelope({
      ok: true,
      data: { reconciliation: rec, replayed: false },
    }),
  );
  assert.equal(
    parseCreateReconciliationEnvelope({
      ok: true,
      data: {
        reconciliation: makeReconciliationProjection({ difference_minor: "999" }),
        replayed: false,
      },
    }),
    null,
  );

  // 7. Evidence reserve, finalize & download envelopes + HTTPS enforcement
  assert.ok(
    parseEvidenceReserveEnvelope({
      ok: true,
      data: {
        evidence_id: EVIDENCE_ID,
        target_kind: "ENTRY",
        target_id: ENTRY_ID,
        mime_type: "image/png",
        size_bytes: 2048,
        checksum_sha256: SAMPLE_SHA256,
        upload: {
          method: "PUT",
          url: "https://r2.example.cloudflarestorage.com/vfin-evidence/object-1?sig=abc",
          expires_at: "2026-10-25T09:20:00.000Z",
          headers: { "Content-Type": "image/png" },
        },
        replayed: false,
      },
    }),
  );
  // Plain http:// upload or download URL must fail closed
  assert.equal(
    parseEvidenceDownloadEnvelope({
      ok: true,
      data: {
        evidence_id: EVIDENCE_ID,
        target_kind: "ENTRY",
        target_id: ENTRY_ID,
        mime_type: "image/png",
        size_bytes: 2048,
        checksum_sha256: SAMPLE_SHA256,
        download: {
          url: "http://insecure.example.com/object-1",
          expires_at: "2026-10-25T09:20:00.000Z",
        },
      },
    }),
    null,
  );
  assert.ok(
    parseEvidenceFinalizeEnvelope({
      ok: true,
      data: {
        evidence: {
          ...makeEvidenceSummary(),
          target_kind: "ENTRY",
          target_id: ENTRY_ID,
        },
        replayed: false,
      },
    }),
  );
  assert.ok(
    parseEvidenceDownloadEnvelope({
      ok: true,
      data: {
        evidence_id: EVIDENCE_ID,
        target_kind: "ENTRY",
        target_id: ENTRY_ID,
        mime_type: "image/png",
        size_bytes: 2048,
        checksum_sha256: SAMPLE_SHA256,
        download: {
          url: "https://r2.example.cloudflarestorage.com/vfin-evidence/object-1?sig=read",
          expires_at: "2026-10-25T09:17:00.000Z",
        },
      },
    }),
  );
});

test("classifyVendorFinanceError maps error codes to sanitized Vietnamese guidance without leaking internal strings", () => {
  const batchConflict = classifyVendorFinanceError(
    {
      ok: false,
      code: "VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED",
      internal_sql_detail: "DETAIL: Key (vendor_id)=(VND-001) already exists",
    },
    409,
  );
  assert.equal(batchConflict.code, "VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED");
  assert.equal(batchConflict.isWholeBatchRollback, true);
  assert.equal(batchConflict.shouldRotateIdempotencyKey, true);
  assert.doesNotMatch(batchConflict.message, /Key \(vendor_id\)/);

  const storageTemp = classifyVendorFinanceError(
    { ok: false, code: "VENDOR_FINANCE_STORAGE_UNAVAILABLE" },
    503,
  );
  assert.equal(storageTemp.shouldRotateIdempotencyKey, false);
  assert.equal(storageTemp.isWholeBatchRollback, false);

  const recordDenied = classifyVendorFinanceError(
    { ok: false, code: "VENDOR_FINANCE_RECORD_DENIED" },
    403,
  );
  assert.equal(recordDenied.shouldRotateIdempotencyKey, false);
  assert.match(recordDenied.message, /chỉ có quyền xem/);
});

test("uploadEvidenceForCommittedTarget executes reserve -> PUT -> finalize and safely resumes PUT or finalize without ever calling money mutation endpoints", async () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb]);
  const expectedSha256 = createHash("sha256").update(pngBytes).digest("hex");
  const file = makeFakeImageFile({ bytes: pngBytes });

  assert.equal(
    await computeBrowserSha256Hex(await file.arrayBuffer()),
    expectedSha256,
  );
  assert.equal(
    validateEvidenceFilePreflight({ name: "doc.pdf", type: "application/pdf", size: 100 }).ok,
    false,
  );
  assert.equal(
    validateEvidenceFilePreflight({
      name: "huge.jpg",
      type: "image/jpeg",
      size: VFIN_UI_EVIDENCE_MAX_BYTES + 1,
    }).ok,
    false,
  );

  const nowFixed = Date.parse("2026-10-25T09:00:00.000Z");
  const futureExpiry = "2026-10-25T09:05:00.000Z";
  const presignedPutUrl = "https://r2.example.cloudflarestorage.com/vfin-evidence/put-1";
  const presignedPutUrl2 = "https://r2.example.cloudflarestorage.com/vfin-evidence/put-2";

  // Scenario A: PUT fails transiently -> returns resumeState (`put_completed: false`) -> retry skips reserve and runs PUT -> finalize
  const callsA = [];
  let putAttemptA = 0;
  const fakeFetchA = async (url, init = {}) => {
    callsA.push({ url: String(url), method: init.method ?? "GET" });
    if (url === "/api/vendor-finance/evidence/reserve") {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            evidence_id: EVIDENCE_ID,
            target_kind: "ENTRY",
            target_id: ENTRY_ID,
            mime_type: "image/png",
            size_bytes: pngBytes.byteLength,
            checksum_sha256: expectedSha256,
            upload: {
              method: "PUT",
              url: presignedPutUrl,
              expires_at: futureExpiry,
              headers: { "Content-Type": "image/png" },
            },
            replayed: false,
          },
        }),
        { status: 201 },
      );
    }
    if (url === presignedPutUrl) {
      putAttemptA += 1;
      if (putAttemptA === 1) {
        throw new TypeError("Failed to fetch");
      }
      return new Response(null, { status: 200 });
    }
    if (url === `/api/vendor-finance/evidence/${EVIDENCE_ID}/finalize`) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            evidence: {
              evidence_id: EVIDENCE_ID,
              target_kind: "ENTRY",
              target_id: ENTRY_ID,
              status: "READY",
              mime_type: "image/png",
              size_bytes: pngBytes.byteLength,
              checksum_sha256: expectedSha256,
              finalized_at: "2026-10-25T09:01:00.000Z",
            },
            replayed: false,
          },
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const firstAttempt = await uploadEvidenceForCommittedTarget({
    target_kind: "ENTRY",
    target_id: ENTRY_ID,
    file,
    fetchImpl: fakeFetchA,
    createIdempotencyKey: () => IDEMPOTENCY_KEY,
    nowMs: () => nowFixed,
  });
  assert.equal(firstAttempt.ok, false);
  assert.equal(firstAttempt.stage, "put");
  assert.ok(firstAttempt.resumeState);
  assert.equal(firstAttempt.resumeState.put_completed, false);

  const retryAttempt = await uploadEvidenceForCommittedTarget({
    target_kind: "ENTRY",
    target_id: ENTRY_ID,
    file,
    resumeState: firstAttempt.resumeState,
    fetchImpl: fakeFetchA,
    createIdempotencyKey: () => IDEMPOTENCY_KEY,
    nowMs: () => nowFixed,
  });
  assert.equal(retryAttempt.ok, true);
  assert.equal(retryAttempt.evidence.evidence_id, EVIDENCE_ID);
  assert.deepEqual(callsA, [
    { url: "/api/vendor-finance/evidence/reserve", method: "POST" },
    { url: presignedPutUrl, method: "PUT" },
    // Retry resumed directly at PUT -> finalize without re-calling reserve or /entries!
    { url: presignedPutUrl, method: "PUT" },
    { url: `/api/vendor-finance/evidence/${EVIDENCE_ID}/finalize`, method: "POST" },
  ]);

  // Scenario B: PUT succeeds, finalize fails transiently -> retry calls ONLY finalize;
  // then if reservation expired (409), runner falls back cleanly to fresh reserve -> PUT -> finalize!
  const callsB = [];
  let finalizeAttemptB = 0;
  const fakeFetchB = async (url, init = {}) => {
    callsB.push({ url: String(url), method: init.method ?? "GET" });
    if (url === "/api/vendor-finance/evidence/reserve") {
      const nextId = callsB.filter((c) => c.url.endsWith("/reserve")).length === 1
        ? EVIDENCE_ID
        : EVIDENCE_ID_2;
      const nextPut = nextId === EVIDENCE_ID ? presignedPutUrl : presignedPutUrl2;
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            evidence_id: nextId,
            target_kind: "RECONCILIATION",
            target_id: RECONCILIATION_ID,
            mime_type: "image/png",
            size_bytes: pngBytes.byteLength,
            checksum_sha256: expectedSha256,
            upload: {
              method: "PUT",
              url: nextPut,
              expires_at: futureExpiry,
              headers: { "Content-Type": "image/png" },
            },
            replayed: false,
          },
        }),
        { status: 201 },
      );
    }
    if (url === presignedPutUrl || url === presignedPutUrl2) {
      return new Response(null, { status: 200 });
    }
    if (url === `/api/vendor-finance/evidence/${EVIDENCE_ID}/finalize`) {
      finalizeAttemptB += 1;
      if (finalizeAttemptB === 1) {
        return new Response(
          JSON.stringify({ ok: false, code: "VENDOR_FINANCE_STORAGE_UNAVAILABLE" }),
          { status: 503 },
        );
      }
      return new Response(
        JSON.stringify({ ok: false, code: "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED" }),
        { status: 409 },
      );
    }
    if (url === `/api/vendor-finance/evidence/${EVIDENCE_ID_2}/finalize`) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            evidence: {
              evidence_id: EVIDENCE_ID_2,
              target_kind: "RECONCILIATION",
              target_id: RECONCILIATION_ID,
              status: "READY",
              mime_type: "image/png",
              size_bytes: pngBytes.byteLength,
              checksum_sha256: expectedSha256,
              finalized_at: "2026-10-25T09:02:00.000Z",
            },
            replayed: false,
          },
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const firstB = await uploadEvidenceForCommittedTarget({
    target_kind: "RECONCILIATION",
    target_id: RECONCILIATION_ID,
    file,
    fetchImpl: fakeFetchB,
    createIdempotencyKey: () => IDEMPOTENCY_KEY,
    nowMs: () => nowFixed,
  });
  assert.equal(firstB.ok, false);
  assert.equal(firstB.stage, "finalize");
  assert.ok(firstB.resumeState);
  assert.equal(firstB.resumeState.put_completed, true);

  // Retry when first reservation then reports EXPIRED -> falls back to fresh reserve -> PUT -> finalize on same RECONCILIATION_ID
  const secondB = await uploadEvidenceForCommittedTarget({
    target_kind: "RECONCILIATION",
    target_id: RECONCILIATION_ID,
    file,
    resumeState: firstB.resumeState,
    fetchImpl: fakeFetchB,
    createIdempotencyKey: () => IDEMPOTENCY_KEY,
    nowMs: () => nowFixed,
  });
  assert.equal(secondB.ok, true);
  assert.equal(secondB.evidence.evidence_id, EVIDENCE_ID_2);
  assert.deepEqual(callsB, [
    { url: "/api/vendor-finance/evidence/reserve", method: "POST" },
    { url: presignedPutUrl, method: "PUT" },
    { url: `/api/vendor-finance/evidence/${EVIDENCE_ID}/finalize`, method: "POST" },
    // Resumed directly at finalize (put_completed=true), got 409 EXPIRED, then cleanly reserved fresh slot:
    { url: `/api/vendor-finance/evidence/${EVIDENCE_ID}/finalize`, method: "POST" },
    { url: "/api/vendor-finance/evidence/reserve", method: "POST" },
    { url: presignedPutUrl2, method: "PUT" },
    { url: `/api/vendor-finance/evidence/${EVIDENCE_ID_2}/finalize`, method: "POST" },
  ]);

  // Confirm zero calls to any money entry or reconciliation creation route
  for (const call of [...callsA, ...callsB]) {
    assert.doesNotMatch(call.url, /\/vendors\/.*\/(entries|reconciliations)/);
  }
});
