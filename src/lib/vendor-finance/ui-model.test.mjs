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
  VENDOR_FINANCE_GLOBAL_ROLE_CODES,
  VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
  VENDOR_FINANCE_LEDGER_SCOPES,
  VENDOR_FINANCE_MAX_OPENING_BATCH_ITEMS,
  VENDOR_FINANCE_MAX_REASON_LENGTH,
  VENDOR_FINANCE_MAX_SEARCH_LENGTH,
  checkForbiddenVendorFinanceClientFields,
  encodeVendorEntriesCursor,
  parseApplyOpeningBatchBody,
  parseAssignGlobalRoleBody,
  parseAssignProjectAccountantBody,
  parseCreateVendorReconciliationBody,
  parseEndGlobalRoleBody,
  parseEndProjectAccountantBody,
  parseFinalizeVendorFinanceEvidenceBody,
  parseGetVendorFinanceVendorDetailQuery,
  parseListVendorFinanceEntriesQuery,
  parseListVendorFinanceVendorsQuery,
  parseListVendorReconciliationsQuery,
  parseMonthlyReportQuery,
  parsePreviewOpeningBatchBody,
  parseRecordVendorFinanceEntryBody,
  parseReserveVendorFinanceEvidenceBody,
  parseReverseVendorFinanceEntryBody,
  parseSetProjectVendorLinkBody,
} from "./vendor-finance-contract.ts";
import {
  PROJECT_REVENUE_MISSING_SOURCE_LABEL_VI,
  VFIN_UI_ACTIVE_FILTERS,
  VFIN_UI_BALANCE_FILTERS,
  VFIN_UI_CONTRACT_VERSION,
  VFIN_UI_DOCUMENT_KINDS,
  VFIN_UI_ENTRY_TYPES,
  VFIN_UI_EVIDENCE_MAX_BYTES,
  VFIN_UI_EVIDENCE_MIME_TYPES,
  VFIN_UI_EVIDENCE_TARGET_KINDS,
  VFIN_UI_GLOBAL_ROLE_CODES,
  VFIN_UI_INTERNAL_DISCLAIMER_VI,
  VFIN_UI_LEDGER_SCOPE_FILTERS,
  VFIN_UI_MAX_OPENING_BATCH_ITEMS,
  VFIN_UI_MAX_REASON_LENGTH,
  VFIN_UI_MAX_SEARCH_LENGTH,
  VFIN_UI_NORMAL_ENTRY_TYPES,
  VFIN_UI_OPENING_ENTRY_TYPES,
  VFIN_UI_PG_BIGINT_MAX,
  VFIN_UI_PG_BIGINT_MIN,
  buildAdminEndGlobalRoleUrl,
  buildAdminEndProjectAccountantUrl,
  buildAdminGlobalRolesUrl,
  buildAdminProjectAccountantsUrl,
  buildAdminProjectVendorsUrl,
  buildAssignGlobalRoleRequest,
  buildAssignProjectAccountantRequest,
  buildCreateReconciliationRequest,
  buildDownloadEvidenceUrl,
  buildEndGlobalRoleRequest,
  buildEndProjectAccountantRequest,
  buildFinalizeEvidenceRequest,
  buildFinalizeEvidenceUrl,
  buildMonthlyReportUrl,
  buildOpeningApplyRequest,
  buildOpeningApplyUrl,
  buildOpeningPreviewRequest,
  buildOpeningPreviewUrl,
  buildRecordEntryRequest,
  buildReserveEvidenceRequest,
  buildReserveEvidenceUrl,
  buildReverseEntryRequest,
  buildReverseEntryUrl,
  buildSetProjectVendorLinkRequest,
  buildSingleEntryUrl,
  buildVendorDetailUrl,
  buildVendorEntriesUrl,
  buildVendorFinanceContextUrl,
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
  isCanonicalUiProjectId,
  isCanonicalUiVendorId,
  normalizeNonNegativeVndInput,
  normalizePositiveVndInput,
  normalizeSignedVndInput,
  parseAdminGlobalRolesEnvelope,
  parseAdminProjectAccountantsEnvelope,
  parseAdminProjectVendorsEnvelope,
  parseAssignGlobalRoleEnvelope,
  parseAssignProjectAccountantEnvelope,
  parseCreateReconciliationEnvelope,
  parseEndGlobalRoleEnvelope,
  parseEndProjectAccountantEnvelope,
  parseEvidenceDownloadEnvelope,
  parseEvidenceFinalizeEnvelope,
  parseEvidenceReserveEnvelope,
  parseMonthlyReportEnvelope,
  parseOpeningApplyEnvelope,
  parseOpeningPreviewEnvelope,
  parseRecordEntryEnvelope,
  parseReverseEntryEnvelope,
  parseSetProjectVendorLinkEnvelope,
  parseSingleEntryEnvelope,
  parseVendorDetailEnvelope,
  parseVendorEntriesPageEnvelope,
  parseVendorFinanceContextEnvelope,
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
const ACCOUNTANT_A_REF = "88888888-8888-4888-8888-888888888888";
const ASSIGNMENT_ID = "99999999-9999-4999-8999-999999999999";
const LINK_ID = "abababab-abab-4bab-8bab-abababababab";
const ROLE_GRANT_ID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const PROJECT_ID = "PRJ-NORTH-01";
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
    ledger_scope: "PROJECT_ACCOUNTANT",
    project_id: PROJECT_ID,
    project_display_name_snapshot: "Dự án Tuyển dụng Miền Bắc",
    accountant_ref: ACCOUNTANT_A_REF,
    responsible_accountant_display_name: "Nguyễn Thị Kế Toán A",
    vendor_sequence: 3,
    cursor_sequence: 3,
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
    created_by_display_name: "Nguyễn Thị Kế Toán A",
    created_at: "2026-10-25T09:00:00.000Z",
    internal_disclaimer: VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
    ...overrides,
  };
}

function makeReconciliationProjection(overrides = {}) {
  return {
    reconciliation_id: RECONCILIATION_ID,
    vendor_id: "VND-001",
    ledger_scope: "PROJECT_ACCOUNTANT",
    project_id: PROJECT_ID,
    project_display_name_snapshot: "Dự án Tuyển dụng Miền Bắc",
    accountant_ref: ACCOUNTANT_A_REF,
    responsible_accountant_display_name: "Nguyễn Thị Kế Toán A",
    as_of_date: "2026-10-25",
    system_balance_minor: "10000000",
    confirmed_balance_minor: "10500000",
    difference_minor: "500000",
    ledger_sequence_at_reconciliation: 3,
    reason: "Đối chiếu biên bản cuối ngày với kế toán Vendor",
    can_attach_evidence: true,
    evidence: null,
    created_by_display_name: "Nguyễn Thị Kế Toán A",
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
  assert.deepEqual(VFIN_UI_LEDGER_SCOPE_FILTERS, ["all", ...VENDOR_FINANCE_LEDGER_SCOPES]);
  assert.deepEqual([...VFIN_UI_GLOBAL_ROLE_CODES].sort(), [...VENDOR_FINANCE_GLOBAL_ROLE_CODES].sort());
  assert.deepEqual(VFIN_UI_ACTIVE_FILTERS, ["all", "active", "inactive"]);
  assert.deepEqual(VFIN_UI_BALANCE_FILTERS, [
    "all",
    "payable",
    "advance",
    "nonzero",
    "uninitialized",
  ]);
  assert.equal(PROJECT_REVENUE_MISSING_SOURCE_LABEL_VI, "Chưa có nguồn chuẩn");
});

test("decideVendorFinancePageAccess enforces feature flag, authentication, view vs record vs admin authority, narrow reconciler, and fail-closed errors", () => {
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
      requiredMode: "admin",
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

  // Full Admin -> ALLOW on view, record, and admin
  assert.equal(
    decideVendorFinancePageAccess({ enabledFlag: "true", requiredMode: "view", actor: fullAdmin }),
    "ALLOW",
  );
  assert.equal(
    decideVendorFinancePageAccess({ enabledFlag: "true", requiredMode: "record", actor: fullAdmin }),
    "ALLOW",
  );
  assert.equal(
    decideVendorFinancePageAccess({ enabledFlag: "true", requiredMode: "admin", actor: fullAdmin }),
    "ALLOW",
  );

  // Direct vendor_finance_record @ all -> ALLOW view & record, ACCESS_DENIED on admin
  assert.equal(
    decideVendorFinancePageAccess({ enabledFlag: "true", requiredMode: "view", actor: directRecorder }),
    "ALLOW",
  );
  assert.equal(
    decideVendorFinancePageAccess({ enabledFlag: "true", requiredMode: "record", actor: directRecorder }),
    "ALLOW",
  );
  assert.equal(
    decideVendorFinancePageAccess({ enabledFlag: "true", requiredMode: "admin", actor: directRecorder }),
    "ACCESS_DENIED",
  );

  // Active Accounting Department member (Project Accountant) -> ALLOW view & record, ACCESS_DENIED admin
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "view",
      actor: accountingMember,
      serverAccess: { ok: true, can_view: true, can_record: true, can_reconcile: true },
    }),
    "ALLOW",
  );
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "record",
      actor: accountingMember,
      serverAccess: { ok: true, can_view: true, can_record: true, can_reconcile: true },
    }),
    "ALLOW",
  );
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "admin",
      actor: accountingMember,
      serverAccess: {
        ok: true,
        can_view: true,
        can_record: true,
        can_reconcile: true,
        can_manage_project_assignments: false,
      },
    }),
    "ACCESS_DENIED",
  );

  // BoD narrow reconciler (`GLOBAL_RECONCILER`: can_view=true, can_reconcile=true, can_record=false) -> ALLOW view, ACCESS_DENIED record & admin
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "view",
      actor: accountingMember,
      serverAccess: { ok: true, can_view: true, can_record: false, can_reconcile: true },
    }),
    "ALLOW",
  );
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "record",
      actor: accountingMember,
      serverAccess: { ok: true, can_view: true, can_record: false, can_reconcile: true },
    }),
    "ACCESS_DENIED",
  );

  // BoD / View-only (`vendor_finance_view @ all`) -> ALLOW on view, ACCESS_DENIED on record & admin
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
  assert.equal(
    decideVendorFinancePageAccess({
      enabledFlag: "true",
      requiredMode: "admin",
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

test("BigInt VND formatters, MULTI_LEDGER non-netting presentation, and normalizers preserve exact digits beyond Number.MAX_SAFE_INTEGER and reject decimals", () => {
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

  // MULTI_LEDGER balance presentation never nets/offsets across project books!
  assert.deepEqual(
    formatVendorBalancePresentation({
      current_balance_minor: "0",
      balance_direction: "MULTI_LEDGER",
      entry_count: 4,
      has_opening_entry: true,
      sub_ledger_count: 2,
    }),
    {
      amountText: "2 sổ dự án riêng",
      signedText: "2 sổ dự án riêng",
      statusLabel: "Nhiều sổ dự án (không bù trừ)",
      tone: "primary",
    },
  );

  // Standard single-subledger balance presentation states
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

  // Input normalization
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

  assert.deepEqual(normalizeNonNegativeVndInput("0"), {
    ok: true,
    canonical: "0",
    value: 0n,
  });
  assert.equal(normalizeNonNegativeVndInput("-1").ok, false);
  assert.equal(normalizeNonNegativeVndInput("12.34").ok, false);

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

  assert.equal(
    computeReconciliationDifferencePreview("9007199254740991", "9007199254740995"),
    "4",
  );
  assert.equal(computeReconciliationDifferencePreview("10000000", "8500000"), "-1500000");
  assert.equal(
    computeReconciliationDifferencePreview("-9223372036854775808", "9223372036854775807"),
    null,
  );
  assert.equal(formatVietnamDateLabel("2026-10-25"), "25/10/2026");
});

test("URL and request builders round-trip cleanly through canonical VFIN-02 backend parsers with zero forbidden fields", () => {
  assert.equal(isCanonicalUiVendorId("__system_vendor__"), false);
  assert.equal(isCanonicalUiVendorId("VND-001"), true);
  assert.equal(isCanonicalUiProjectId(PROJECT_ID), true);
  assert.equal(isCanonicalUiProjectId(" bad id "), false);

  // 1. Vendor list URL -> parseListVendorFinanceVendorsQuery
  const listUrl = buildVendorListUrl({
    search: "  Sao Việt  ",
    active: "active",
    balance_filter: "payable",
    project_id: PROJECT_ID,
    accountant_ref: ACCOUNTANT_A_REF.toUpperCase(),
    ledger_scope: "PROJECT_ACCOUNTANT",
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
      project_id: PROJECT_ID,
      accountant_ref: ACCOUNTANT_A_REF,
      ledger_scope: "PROJECT_ACCOUNTANT",
      page: 2,
      page_size: 25,
    },
  });

  // 2. Vendor detail URL -> parseGetVendorFinanceVendorDetailQuery
  const detailUrl = buildVendorDetailUrl("VND-001", {
    project_id: PROJECT_ID,
    accountant_ref: ACCOUNTANT_A_REF,
    ledger_scope: "PROJECT_ACCOUNTANT",
  });
  assert.deepEqual(parseGetVendorFinanceVendorDetailQuery(new URL(`http://localhost${detailUrl}`)), {
    ok: true,
    value: {
      project_id: PROJECT_ID,
      accountant_ref: ACCOUNTANT_A_REF,
      ledger_scope: "PROJECT_ACCOUNTANT",
    },
  });

  // 3. Vendor entries URL (v2 scope-bound keyset cursor + month drill-down) -> parseListVendorFinanceEntriesQuery
  const cursor = encodeVendorEntriesCursor({
    vendor_id: "VND-001",
    before_sequence: 10,
    project_id: PROJECT_ID,
    accountant_ref: ACCOUNTANT_A_REF,
    ledger_scope: "PROJECT_ACCOUNTANT",
    month: "2026-10",
  });
  const entriesUrl = buildVendorEntriesUrl("VND-001", {
    cursor,
    entry_type: "PAYROLL_RECORDED",
    project_id: PROJECT_ID,
    accountant_ref: ACCOUNTANT_A_REF,
    ledger_scope: "PROJECT_ACCOUNTANT",
    month: "2026-10",
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
      project_id: PROJECT_ID,
      accountant_ref: ACCOUNTANT_A_REF,
      ledger_scope: "PROJECT_ACCOUNTANT",
      month: "2026-10",
    },
  });

  // 4. Reconciliations URL & Monthly report URL
  const recUrl = buildVendorReconciliationsUrl("VND-001", {
    page: 3,
    page_size: 15,
    project_id: PROJECT_ID,
    accountant_ref: ACCOUNTANT_A_REF,
    ledger_scope: "PROJECT_ACCOUNTANT",
  });
  assert.deepEqual(parseListVendorReconciliationsQuery(new URL(`http://localhost${recUrl}`)), {
    ok: true,
    value: {
      page: 3,
      page_size: 15,
      project_id: PROJECT_ID,
      accountant_ref: ACCOUNTANT_A_REF,
      ledger_scope: "PROJECT_ACCOUNTANT",
    },
  });

  const reportUrl = buildMonthlyReportUrl({
    month: "2026-10",
    project_id: PROJECT_ID,
    accountant_ref: ACCOUNTANT_A_REF,
    vendor_id: "VND-001",
  });
  assert.deepEqual(parseMonthlyReportQuery(new URL(`http://localhost${reportUrl}`)), {
    ok: true,
    value: {
      month: "2026-10",
      project_id: PROJECT_ID,
      accountant_ref: ACCOUNTANT_A_REF,
      vendor_id: "VND-001",
    },
  });

  assert.equal(buildVendorFinanceContextUrl(), "/api/vendor-finance/context");
  assert.equal(buildVendorDetailUrl("VND-001"), "/api/vendor-finance/vendors/VND-001");
  assert.equal(buildSingleEntryUrl(ENTRY_ID), `/api/vendor-finance/entries/${ENTRY_ID}`);
  assert.equal(buildReverseEntryUrl(ENTRY_ID), `/api/vendor-finance/entries/${ENTRY_ID}/reverse`);
  assert.equal(buildOpeningPreviewUrl(), "/api/vendor-finance/opening-batches/preview");
  assert.equal(buildOpeningApplyUrl(), "/api/vendor-finance/opening-batches/apply");
  assert.equal(buildReserveEvidenceUrl(), "/api/vendor-finance/evidence/reserve");
  assert.equal(buildFinalizeEvidenceUrl(EVIDENCE_ID), `/api/vendor-finance/evidence/${EVIDENCE_ID}/finalize`);
  assert.equal(buildDownloadEvidenceUrl(EVIDENCE_ID), `/api/vendor-finance/evidence/${EVIDENCE_ID}/download`);
  assert.equal(buildAdminProjectAccountantsUrl(), "/api/vendor-finance/admin/project-accountants");
  assert.equal(
    buildAdminEndProjectAccountantUrl(ASSIGNMENT_ID),
    `/api/vendor-finance/admin/project-accountants/${ASSIGNMENT_ID}/end`,
  );
  assert.equal(
    buildAdminProjectVendorsUrl({ project_id: PROJECT_ID, only_linked: true }),
    `/api/vendor-finance/admin/project-vendors?project_id=${PROJECT_ID}&only_linked=true`,
  );
  assert.equal(buildAdminGlobalRolesUrl(), "/api/vendor-finance/admin/global-roles");
  assert.equal(
    buildAdminEndGlobalRoleUrl(ROLE_GRANT_ID),
    `/api/vendor-finance/admin/global-roles/${ROLE_GRANT_ID}/end`,
  );

  // 5. Record entry request -> parseRecordVendorFinanceEntryBody (all 6 normal entry types + mandatory project_id)
  for (const type of VFIN_UI_NORMAL_ENTRY_TYPES) {
    const built = buildRecordEntryRequest({
      project_id: PROJECT_ID,
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
        project_id: PROJECT_ID,
        entry_type: type,
        amount_minor: "12500000",
        effective_date: "2026-10-25",
        reason: "Ghi nhận chứng từ kiểm thử",
        idempotency_key: IDEMPOTENCY_KEY,
      },
    });
  }

  // Disallowed entry type for inactive vendor or missing project blocked before network call
  assert.equal(
    buildRecordEntryRequest({
      project_id: "",
      entry_type: "PAYMENT_RECORDED",
      amount_input: "1000000",
      effective_date: "2026-10-25",
      reason: "Thiếu dự án",
      idempotency_key: IDEMPOTENCY_KEY,
    }).ok,
    false,
  );
  assert.equal(
    buildRecordEntryRequest({
      project_id: PROJECT_ID,
      entry_type: "DEBT_RECORDED",
      amount_input: "1000000",
      effective_date: "2026-10-25",
      reason: "Không cho phép nợ mới trên vendor inactive",
      idempotency_key: IDEMPOTENCY_KEY,
      allowed_entry_types: ["PAYMENT_RECORDED", "ADJUSTMENT_DECREASE"],
    }).ok,
    false,
  );

  // 6. Reverse entry request -> parseReverseVendorFinanceEntryBody
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

  // 7. Opening preview & apply requests (require project_id) -> parsePreviewOpeningBatchBody & parseApplyOpeningBatchBody
  const openingRows = [
    { vendor_id: "VND-001", entry_type: "OPENING_PAYABLE", amount_input: "25.000.000" },
    { vendor_id: "VND-002", entry_type: "OPENING_ADVANCE", amount_input: "0" },
    { vendor_id: "VND-003", entry_type: "OPENING_ADVANCE", amount_input: "4000000" },
  ];
  const previewBuilt = buildOpeningPreviewRequest({
    project_id: PROJECT_ID,
    cutoff_date: "2026-10-01",
    rows: openingRows,
  });
  assert.equal(previewBuilt.ok, true);
  assert.equal(previewBuilt.non_zero_count, 2);
  assert.equal(previewBuilt.zero_count, 1);
  assert.equal(parsePreviewOpeningBatchBody(previewBuilt.request.body).ok, true);

  const applyBuilt = buildOpeningApplyRequest({
    project_id: PROJECT_ID,
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
      project_id: PROJECT_ID,
      cutoff_date: "2026-10-01",
      rows: [{ vendor_id: "VND-001", entry_type: "OPENING_PAYABLE", amount_input: "0" }],
    }).ok,
    false,
  );
  const dupCheck = buildOpeningPreviewRequest({
    project_id: PROJECT_ID,
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
      project_id: PROJECT_ID,
      cutoff_date: "2026-10-01",
      rows: [{ vendor_id: "__system_vendor__", entry_type: "OPENING_PAYABLE", amount_input: "1000" }],
    }).ok,
    false,
  );
  assert.equal(
    buildOpeningPreviewRequest({
      project_id: PROJECT_ID,
      cutoff_date: "2026-10-01",
      rows: Array.from({ length: 201 }, (_, idx) => ({
        vendor_id: `VND-${idx + 1}`,
        entry_type: "OPENING_PAYABLE",
        amount_input: "1000",
      })),
    }).ok,
    false,
  );

  // 8. Create reconciliation request -> parseCreateVendorReconciliationBody
  const recBuilt = buildCreateReconciliationRequest({
    project_id: PROJECT_ID,
    accountant_ref: ACCOUNTANT_A_REF.toUpperCase(),
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
        project_id: PROJECT_ID,
        accountant_ref: ACCOUNTANT_A_REF,
        as_of_date: "2026-10-25",
        confirmed_balance_minor: "-3500000",
        reason: "Vendor xác nhận đang giữ dư ứng 3.5tr",
        idempotency_key: IDEMPOTENCY_KEY,
      },
    },
  );

  // 9. Admin governance requests -> backend parsers
  const assignAcc = buildAssignProjectAccountantRequest({
    project_id: PROJECT_ID,
    accountant_ref: ACCOUNTANT_A_REF,
    valid_from: "2026-10-25",
    expected_version: 0,
    reason: "Phân công kế toán dự án mới",
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(assignAcc.ok, true);
  assert.equal(
    parseAssignProjectAccountantBody(
      assignAcc.request.body,
      assignAcc.request.headers["Idempotency-Key"],
    ).ok,
    true,
  );

  const endAcc = buildEndProjectAccountantRequest({
    expected_version: 1,
    valid_to: "2026-10-31",
    reason: "Bàn giao dự án sang kế toán B",
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(endAcc.ok, true);
  assert.equal(
    parseEndProjectAccountantBody(endAcc.request.body, endAcc.request.headers["Idempotency-Key"]).ok,
    true,
  );

  const setLink = buildSetProjectVendorLinkRequest({
    project_id: PROJECT_ID,
    vendor_id: "VND-001",
    active: true,
    expected_version: 0,
    reason: "Liên kết Vendor vào dự án theo hợp đồng",
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(setLink.ok, true);
  assert.equal(
    parseSetProjectVendorLinkBody(
      setLink.request.body,
      setLink.request.headers["Idempotency-Key"],
    ).ok,
    true,
  );

  const assignRole = buildAssignGlobalRoleRequest({
    account_ref: ACCOUNTANT_A_REF,
    role_code: "GLOBAL_RECONCILER",
    valid_from: "2026-10-25",
    expected_version: 0,
    reason: "Cấp quyền BoD đối soát toàn cục",
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(assignRole.ok, true);
  assert.equal(
    parseAssignGlobalRoleBody(
      assignRole.request.body,
      assignRole.request.headers["Idempotency-Key"],
    ).ok,
    true,
  );

  const endRole = buildEndGlobalRoleRequest({
    expected_version: 1,
    valid_to: null,
    reason: "Kết thúc quyền đối soát toàn cục",
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(endRole.ok, true);
  assert.equal(
    parseEndGlobalRoleBody(endRole.request.body, endRole.request.headers["Idempotency-Key"]).ok,
    true,
  );

  // 10. Reserve & finalize evidence requests -> server parsers
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

test("HTTP response envelope parsers validate all 18 VFIN-02 endpoint contracts and fail closed on tampered invariants, fake revenue, or leaked fields", () => {
  const entry = makeEntryProjection({ evidence: makeEvidenceSummary() });
  const rec = makeReconciliationProjection({ evidence: makeEvidenceSummary() });

  // 0. Context options envelope
  assert.ok(
    parseVendorFinanceContextEnvelope({
      ok: true,
      data: {
        authorization_date: "2026-10-25",
        allowed_actions: {
          visibility_scope: "PROJECT_SCOPED",
          record_scope: "ASSIGNED_PROJECTS",
          reconcile_scope: "ASSIGNED_PROJECTS",
          can_view: true,
          can_record: true,
          can_reconcile: true,
          can_manage_project_assignments: false,
        },
        has_legacy_unallocated: false,
        projects: [
          {
            project_id: PROJECT_ID,
            display_name: "Dự án Tuyển dụng Miền Bắc",
            active: true,
            active_accountant_ref: ACCOUNTANT_A_REF,
            active_accountant_display_name: "Nguyễn Thị Kế Toán A",
            has_active_accountant: true,
            can_record_for_project: true,
            can_reconcile_for_project: true,
            linked_vendors: [
              {
                vendor_id: "VND-001",
                display_name: "Sao Việt",
                vendor_active: true,
                link_active: true,
              },
            ],
          },
        ],
        accountants: [
          {
            accountant_ref: ACCOUNTANT_A_REF,
            display_name: "Nguyễn Thị Kế Toán A",
          },
        ],
      },
    }),
  );

  // 1. Vendor list envelope (with MULTI_LEDGER sub_ledgers)
  const validList = {
    ok: true,
    data: {
      authorization_date: "2026-10-25",
      allowed_actions: {
        visibility_scope: "ALL",
        can_view: true,
        can_record: false,
        can_reconcile: true,
        can_manage_project_assignments: false,
        active_assigned_project_count: 0,
      },
      summary: {
        total_payable_minor: "30000000",
        total_advance_minor: "0",
        net_balance_minor: "30000000",
        vendors_with_payable_count: 1,
        vendors_with_advance_count: 0,
        vendors_with_nonzero_balance_count: 1,
        total_vendor_count: 1,
        uninitialized_vendor_count: 0,
        sub_ledger_count: 2,
      },
      filters: {
        search: null,
        active: "all",
        balance_filter: "all",
        project_id: null,
        accountant_ref: null,
        ledger_scope: "all",
      },
      page: 1,
      page_size: 25,
      total: 1,
      has_more: false,
      vendors: [
        {
          vendor_id: "VND-001",
          display_name: "Sao Việt",
          active: true,
          sub_ledger_count: 2,
          payable_total_minor: "30000000",
          advance_total_minor: "0",
          current_balance_minor: "0",
          balance_direction: "MULTI_LEDGER",
          entry_count: 3,
          has_opening_entry: true,
          eligible_for_opening: false,
          last_effective_date: "2026-10-25",
          last_entry_at: "2026-10-25T09:00:00.000Z",
          last_reconciled_as_of_date: "2026-10-25",
          sub_ledgers: [
            {
              ledger_scope: "PROJECT_ACCOUNTANT",
              project_id: PROJECT_ID,
              project_display_name: "Dự án Tuyển dụng Miền Bắc",
              accountant_ref: ACCOUNTANT_A_REF,
              responsible_accountant_display_name: "Nguyễn Thị Kế Toán A",
              current_balance_minor: "10000000",
              balance_direction: "PAYABLE",
              entry_count: 2,
              has_opening_entry: true,
              eligible_for_opening: false,
              last_reconciled_as_of_date: "2026-10-25",
            },
          ],
        },
      ],
    },
  };
  assert.ok(parseVendorListEnvelope(validList));
  assert.equal(parseVendorListEnvelope({ ...validList, extra: 1 }), null);

  // 2. Vendor detail envelope
  const subLedgerDetail = {
    ledger_scope: "PROJECT_ACCOUNTANT",
    project_id: PROJECT_ID,
    project_display_name: "Dự án Tuyển dụng Miền Bắc",
    project_active: true,
    accountant_ref: ACCOUNTANT_A_REF,
    responsible_accountant_display_name: "Nguyễn Thị Kế Toán A",
    link_active: true,
    is_active_assignment: true,
    current_balance_minor: "10000000",
    balance_direction: "PAYABLE",
    latest_sequence: 3,
    entry_count: 3,
    has_opening_entry: true,
    eligible_for_opening: false,
    can_record_entry: true,
    can_reconcile: true,
  };
  const validDetail = {
    ok: true,
    data: {
      authorization_date: "2026-10-25",
      allowed_actions: {
        visibility_scope: "PROJECT_SCOPED",
        can_view: true,
        can_record: true,
        can_reconcile: true,
        can_manage_project_assignments: false,
        allowed_entry_types: ["DEBT_RECORDED", "PAYMENT_RECORDED"],
      },
      selected_sub_ledger: subLedgerDetail,
      sub_ledgers: [subLedgerDetail],
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
  const nextCursor = encodeVendorEntriesCursor({
    vendor_id: "VND-001",
    before_sequence: 3,
    project_id: PROJECT_ID,
    accountant_ref: ACCOUNTANT_A_REF,
    ledger_scope: "PROJECT_ACCOUNTANT",
    month: null,
  });
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
        allowed_actions: { visibility_scope: "PROJECT_SCOPED", can_view: true, can_record: false },
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
          cursor_sequence: 4,
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

  // 5. Opening preview & apply envelopes (project-bound)
  assert.ok(
    parseOpeningPreviewEnvelope({
      ok: true,
      data: {
        authorization_date: "2026-10-25",
        project_id: PROJECT_ID,
        project_display_name: "Dự án Tuyển dụng Miền Bắc",
        accountant_ref: ACCOUNTANT_A_REF,
        responsible_accountant_display_name: "Nguyễn Thị Kế Toán A",
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
          ledger_scope: "PROJECT_ACCOUNTANT",
          project_id: PROJECT_ID,
          project_display_name_snapshot: "Dự án Tuyển dụng Miền Bắc",
          accountant_ref: ACCOUNTANT_A_REF,
          responsible_accountant_display_name: "Nguyễn Thị Kế Toán A",
          cutoff_date: "2026-10-01",
          vendor_count: 1,
          skipped_zero_count: 0,
          total_payable_minor: "15000000",
          total_advance_minor: "0",
          net_balance_minor: "15000000",
          reason: "Khởi tạo đầu kỳ",
          created_by_display_name: "Nguyễn Thị Kế Toán A",
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

  // 7. Monthly project debt report envelope + fail-closed check against fake revenue ("0")
  const validMonthlyEnvelope = {
    ok: true,
    data: {
      authorization_date: "2026-10-25",
      allowed_actions: {
        visibility_scope: "ALL",
        can_view: true,
        can_record: false,
        can_reconcile: true,
        can_manage_project_assignments: false,
      },
      filters: {
        month: "2026-10",
        project_id: null,
        accountant_ref: null,
        vendor_id: null,
      },
      totals: {
        project_revenue_status: "MISSING_CANONICAL_SOURCE",
        project_revenue_minor: null,
        project_accountant_book_count: 1,
        sub_ledger_count: 1,
        obligations_in_month_minor: "15000000",
        paid_in_month_minor: "5000000",
        advanced_in_month_minor: "0",
        paid_and_advanced_in_month_minor: "5000000",
        closing_payable_minor: "10000000",
        closing_advance_minor: "0",
      },
      project_accountant_summaries: [
        {
          project_id: PROJECT_ID,
          project_display_name: "Dự án Tuyển dụng Miền Bắc",
          project_active: true,
          accountant_ref: ACCOUNTANT_A_REF,
          responsible_accountant_display_name: "Nguyễn Thị Kế Toán A",
          is_currently_assigned: true,
          project_revenue_status: "MISSING_CANONICAL_SOURCE",
          project_revenue_minor: null,
          vendor_count: 1,
          obligations_in_month_minor: "15000000",
          paid_in_month_minor: "5000000",
          advanced_in_month_minor: "0",
          paid_and_advanced_in_month_minor: "5000000",
          closing_payable_minor: "10000000",
          closing_advance_minor: "0",
          in_month_entry_count: 2,
        },
      ],
      rows: [
        {
          project_id: PROJECT_ID,
          project_display_name: "Dự án Tuyển dụng Miền Bắc",
          project_active: true,
          accountant_ref: ACCOUNTANT_A_REF,
          responsible_accountant_display_name: "Nguyễn Thị Kế Toán A",
          is_currently_assigned: true,
          vendor_id: "VND-001",
          vendor_display_name: "Sao Việt",
          vendor_active: true,
          link_active: true,
          project_revenue_status: "MISSING_CANONICAL_SOURCE",
          project_revenue_minor: null,
          balance_before_month_minor: "0",
          opening_payable_in_month_minor: "15000000",
          opening_advance_in_month_minor: "0",
          obligations_in_month_minor: "15000000",
          paid_in_month_minor: "5000000",
          advanced_in_month_minor: "0",
          paid_and_advanced_in_month_minor: "5000000",
          net_change_in_month_minor: "10000000",
          closing_balance_minor: "10000000",
          closing_direction: "PAYABLE",
          closing_payable_minor: "10000000",
          closing_advance_minor: "0",
          current_balance_minor: "10000000",
          in_month_entry_count: 2,
          total_entry_count: 2,
        },
      ],
      legacy_unallocated_rows: [],
    },
  };
  assert.ok(parseMonthlyReportEnvelope(validMonthlyEnvelope));
  assert.equal(
    parseMonthlyReportEnvelope({
      ok: true,
      data: {
        ...validMonthlyEnvelope.data,
        totals: { ...validMonthlyEnvelope.data.totals, project_revenue_minor: "0" },
      },
    }),
    null,
  );

  // 8. Admin governance envelopes (project accountants, vendor links, global roles)
  const sampleAccount = {
    account_ref: ACCOUNTANT_A_REF,
    display_name: "Nguyễn Thị Kế Toán A",
    login_id: "ketoan.a",
    personnel_code: "KT001",
    account_enabled: true,
  };
  const sampleAssignment = {
    assignment_id: ASSIGNMENT_ID,
    project_id: PROJECT_ID,
    version: 1,
    accountant: sampleAccount,
    accountant_in_accounting_department: true,
    valid_from: "2026-10-01",
    valid_to: null,
    state: "ACTIVE",
    assign_reason: "Phân công đầu kỳ",
    end_reason: null,
    created_at: "2026-10-01T08:00:00.000Z",
  };
  assert.ok(
    parseAdminProjectAccountantsEnvelope({
      ok: true,
      data: {
        authorization_date: "2026-10-25",
        eligible_accountants: [sampleAccount],
        page: 1,
        page_size: 25,
        total: 1,
        has_more: false,
        projects: [
          {
            project_id: PROJECT_ID,
            display_name: "Dự án Tuyển dụng Miền Bắc",
            active: true,
            next_version: 2,
            linked_active_vendor_count: 1,
            current_assignment: sampleAssignment,
            assignments: [sampleAssignment],
          },
        ],
      },
    }),
  );
  assert.ok(
    parseAssignProjectAccountantEnvelope({
      ok: true,
      data: {
        assignment_id: ASSIGNMENT_ID,
        project_id: PROJECT_ID,
        version: 1,
        replayed: false,
      },
    }),
  );
  assert.ok(
    parseEndProjectAccountantEnvelope({
      ok: true,
      data: {
        assignment_id: ASSIGNMENT_ID,
        project_id: PROJECT_ID,
        valid_to: "2026-10-31",
        replayed: false,
      },
    }),
  );
  assert.ok(
    parseAdminProjectVendorsEnvelope({
      ok: true,
      data: {
        authorization_date: "2026-10-25",
        project_id: PROJECT_ID,
        project_display_name: "Dự án Tuyển dụng Miền Bắc",
        project_active: true,
        page: 1,
        page_size: 25,
        total: 1,
        has_more: false,
        vendors: [
          {
            vendor_id: "VND-001",
            display_name: "Sao Việt",
            vendor_active: true,
            linked: true,
            link_active: true,
            link_version: 1,
            updated_at: "2026-10-25T09:00:00.000Z",
          },
        ],
      },
    }),
  );
  assert.ok(
    parseSetProjectVendorLinkEnvelope({
      ok: true,
      data: {
        link_id: LINK_ID,
        project_id: PROJECT_ID,
        vendor_id: "VND-001",
        active: true,
        version: 1,
        replayed: false,
      },
    }),
  );
  assert.ok(
    parseAdminGlobalRolesEnvelope({
      ok: true,
      data: {
        authorization_date: "2026-10-25",
        page: 1,
        page_size: 25,
        total: 1,
        has_more: false,
        roles: [
          {
            role_grant_id: ROLE_GRANT_ID,
            account: sampleAccount,
            role_code: "GLOBAL_RECONCILER",
            version: 1,
            valid_from: "2026-10-01",
            valid_to: null,
            state: "ACTIVE",
            grant_reason: "Cấp quyền BoD đối soát",
            end_reason: null,
            created_at: "2026-10-01T08:00:00.000Z",
          },
        ],
        candidates: [
          {
            account: sampleAccount,
            next_version: 2,
            has_open_role: true,
          },
        ],
      },
    }),
  );
  assert.ok(
    parseAssignGlobalRoleEnvelope({
      ok: true,
      data: {
        role_grant_id: ROLE_GRANT_ID,
        account_ref: ACCOUNTANT_A_REF,
        role_code: "GLOBAL_RECONCILER",
        version: 1,
        replayed: false,
      },
    }),
  );
  assert.ok(
    parseEndGlobalRoleEnvelope({
      ok: true,
      data: {
        role_grant_id: ROLE_GRANT_ID,
        account_ref: ACCOUNTANT_A_REF,
        valid_to: "2026-10-31",
        replayed: false,
      },
    }),
  );

  // 9. Evidence reserve, finalize & download envelopes + HTTPS enforcement
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

test("classifyVendorFinanceError maps VFIN-01 and VFIN-02 error codes to sanitized Vietnamese guidance without leaking internal strings", () => {
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

  const unlinked = classifyVendorFinanceError(
    { ok: false, code: "VENDOR_FINANCE_PROJECT_VENDOR_UNLINKED" },
    422,
  );
  assert.equal(unlinked.isWholeBatchRollback, true);
  assert.equal(unlinked.shouldRotateIdempotencyKey, true);
  assert.match(unlinked.message, /chưa được liên kết hợp lệ với dự án/);

  const projectDenied = classifyVendorFinanceError(
    { ok: false, code: "VENDOR_FINANCE_PROJECT_ACCESS_DENIED" },
    403,
  );
  assert.equal(projectDenied.shouldRotateIdempotencyKey, false);
  assert.match(projectDenied.message, /dự án do bạn trực tiếp phụ trách/);

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
  assert.match(recordDenied.message, /không có quyền ghi nhận/);
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
    { url: presignedPutUrl, method: "PUT" },
    { url: `/api/vendor-finance/evidence/${EVIDENCE_ID}/finalize`, method: "POST" },
  ]);

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
    { url: `/api/vendor-finance/evidence/${EVIDENCE_ID}/finalize`, method: "POST" },
    { url: "/api/vendor-finance/evidence/reserve", method: "POST" },
    { url: presignedPutUrl2, method: "PUT" },
    { url: `/api/vendor-finance/evidence/${EVIDENCE_ID_2}/finalize`, method: "POST" },
  ]);

  for (const call of [...callsA, ...callsB]) {
    assert.doesNotMatch(call.url, /\/vendors\/.*\/(entries|reconciliations)/);
  }
});
