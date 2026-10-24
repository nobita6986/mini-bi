/**
 * VFIN-01 — Browser-safe Client UI Model, VND BigInt Formatters, Fail-Closed Envelope Parsers,
 * Request Builders, Sanitized Error Classifier, and Two-Phase Evidence Upload Runner.
 *
 * Strict invariants:
 * - Zero runtime Node, server-only, or direct database client imports.
 * - Zero floating-point arithmetic (`Number` / `parseFloat`) on monetary amounts; all money
 *   values stay canonical integer strings at the API boundary and use `BigInt` only for
 *   exact validation, ledger/reconciliation invariant verification, and thousand-grouped display.
 * - Client never computes or sends authority/computed fields (`balance_*`, `document_no`,
 *   `system_balance_minor`, `difference_minor`, `app_user_id`, `storage_key`, etc.).
 */

import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import type { ActorResolution } from "../auth/direct-entry-v2.ts";
import type { DirectEntryPageDecision } from "../auth/direct-entry-page-access.ts";
import {
  vendorFinanceNavPredicate,
  vendorFinanceRecordNavPredicate,
  type NavActorProjection,
} from "../navigation/registry-capability.ts";
import type {
  ApplyOpeningBatchBody,
  CreateVendorReconciliationBody,
  NormalVendorFinanceEntryType,
  OpeningBatchItemInput,
  OpeningVendorFinanceEntryType,
  PreviewOpeningBatchBody,
  RecordVendorFinanceEntryBody,
  ReserveVendorFinanceEvidenceBody,
  ReverseVendorFinanceEntryBody,
  VendorFinanceActiveFilter,
  VendorFinanceBalanceDirection,
  VendorFinanceBalanceFilter,
  VendorFinanceCategoryTotals,
  VendorFinanceCompanySummary,
  VendorFinanceDocumentKind,
  VendorFinanceEntriesPageResponse,
  VendorFinanceEntryProjection,
  VendorFinanceEntryType,
  VendorFinanceErrorCode,
  VendorFinanceEvidenceDownloadResponse,
  VendorFinanceEvidenceFinalizeResponse,
  VendorFinanceEvidenceMimeType,
  VendorFinanceEvidenceReserveResponse,
  VendorFinanceEvidenceSummary,
  VendorFinanceEvidenceTargetKind,
  VendorFinanceListItem,
  VendorFinanceOpeningApplyResponse,
  VendorFinanceOpeningPreviewItem,
  VendorFinanceOpeningPreviewResponse,
  VendorFinanceReconciliationProjection,
  VendorFinanceReconciliationsPageResponse,
  VendorFinanceSingleEntryResponse,
  VendorFinanceVendorDetailResponse,
  VendorFinanceVendorListResponse,
} from "./vendor-finance-contract.ts";

// -----------------------------------------------------------------------------
// 1. Canonical Browser-Safe Constants & Display Metadata
// -----------------------------------------------------------------------------
export const VFIN_UI_CONTRACT_VERSION = "vendor-finance/1.0" as const;

export const VFIN_UI_INTERNAL_DISCLAIMER_VI =
  "Chứng từ ghi nhận nội bộ trên hệ thống BI, không phải xác nhận giao dịch ngân hàng hoặc chứng minh tiền đã được chuyển." as const;

export const VFIN_UI_MAX_REASON_LENGTH = 4000;
export const VFIN_UI_MAX_SEARCH_LENGTH = 120;
export const VFIN_UI_MAX_OPENING_BATCH_ITEMS = 200;
export const VFIN_UI_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB = 10_485_760

export const VFIN_UI_PG_BIGINT_MAX = BigInt("9223372036854775807");
export const VFIN_UI_PG_BIGINT_MIN = BigInt("-9223372036854775808");
const ZERO_BIGINT = BigInt(0);
const ONE_BIGINT = BigInt(1);

export const VFIN_UI_ENTRY_TYPES = [
  "OPENING_PAYABLE",
  "OPENING_ADVANCE",
  "DEBT_RECORDED",
  "PAYROLL_RECORDED",
  "PAYMENT_RECORDED",
  "ADVANCE_RECORDED",
  "ADJUSTMENT_INCREASE",
  "ADJUSTMENT_DECREASE",
  "REVERSAL",
] as const satisfies readonly VendorFinanceEntryType[];

export const VFIN_UI_NORMAL_ENTRY_TYPES = [
  "DEBT_RECORDED",
  "PAYROLL_RECORDED",
  "PAYMENT_RECORDED",
  "ADVANCE_RECORDED",
  "ADJUSTMENT_INCREASE",
  "ADJUSTMENT_DECREASE",
] as const satisfies readonly NormalVendorFinanceEntryType[];

export const VFIN_UI_OPENING_ENTRY_TYPES = [
  "OPENING_PAYABLE",
  "OPENING_ADVANCE",
] as const satisfies readonly OpeningVendorFinanceEntryType[];

export const VFIN_UI_DOCUMENT_KINDS = [
  "PAYROLL_VOUCHER",
  "PAYMENT_VOUCHER",
  "ADVANCE_VOUCHER",
  "DEBT_ADJUSTMENT_VOUCHER",
  "OPENING_BALANCE_VOUCHER",
] as const satisfies readonly VendorFinanceDocumentKind[];

export const VFIN_UI_EVIDENCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
] as const satisfies readonly VendorFinanceEvidenceMimeType[];

export const VFIN_UI_EVIDENCE_TARGET_KINDS = [
  "ENTRY",
  "RECONCILIATION",
] as const satisfies readonly VendorFinanceEvidenceTargetKind[];

export const VFIN_UI_ACTIVE_FILTERS = [
  "all",
  "active",
  "inactive",
] as const satisfies readonly VendorFinanceActiveFilter[];

export const VFIN_UI_BALANCE_FILTERS = [
  "all",
  "payable",
  "advance",
  "nonzero",
  "uninitialized",
] as const satisfies readonly VendorFinanceBalanceFilter[];

export const ENTRY_TYPE_LABELS_VI: Readonly<Record<VendorFinanceEntryType, string>> = {
  OPENING_PAYABLE: "Số dư đầu kỳ phải trả",
  OPENING_ADVANCE: "Số dư đầu kỳ dư ứng",
  DEBT_RECORDED: "Ghi nhận phát sinh công nợ",
  PAYROLL_RECORDED: "Ghi nhận lương phải trả",
  PAYMENT_RECORDED: "Thanh toán cho Vendor",
  ADVANCE_RECORDED: "Tạm ứng cho Vendor",
  ADJUSTMENT_INCREASE: "Điều chỉnh tăng phải trả",
  ADJUSTMENT_DECREASE: "Điều chỉnh giảm phải trả",
  REVERSAL: "Hoàn tác bút toán",
};

export const ENTRY_TYPE_DIRECTION_HINTS_VI: Readonly<
  Record<NormalVendorFinanceEntryType, { deltaSign: "+" | "-"; description: string }>
> = {
  DEBT_RECORDED: {
    deltaSign: "+",
    description: "Tăng số dư phải trả cho Vendor (+).",
  },
  PAYROLL_RECORDED: {
    deltaSign: "+",
    description: "Ghi nhận bảng lương phải trả cho Vendor (+).",
  },
  PAYMENT_RECORDED: {
    deltaSign: "-",
    description: "Thanh toán tiền cho Vendor — giảm phải trả (-).",
  },
  ADVANCE_RECORDED: {
    deltaSign: "-",
    description: "Chi tạm ứng cho Vendor — giảm phải trả hoặc tạo dư ứng (-).",
  },
  ADJUSTMENT_INCREASE: {
    deltaSign: "+",
    description: "Điều chỉnh tăng công nợ phải trả cho Vendor (+).",
  },
  ADJUSTMENT_DECREASE: {
    deltaSign: "-",
    description: "Điều chỉnh giảm công nợ phải trả cho Vendor (-).",
  },
};

export const ACTIVE_FILTER_LABELS_VI: Readonly<Record<VendorFinanceActiveFilter, string>> = {
  all: "Tất cả trạng thái",
  active: "Đang hoạt động",
  inactive: "Ngừng hoạt động",
};

export const BALANCE_FILTER_LABELS_VI: Readonly<Record<VendorFinanceBalanceFilter, string>> = {
  all: "Tất cả số dư",
  payable: "Còn phải trả (> 0)",
  advance: "Đang dư ứng (< 0)",
  nonzero: "Còn công nợ / dư ứng (≠ 0)",
  uninitialized: "Chưa khởi tạo đầu kỳ",
};

export type UiBadgeTone = "success" | "warning" | "danger" | "info" | "neutral" | "primary";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VENDOR_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DOCUMENT_NO_REGEX = /^VFIN-[0-9]{4}-[0-9]{6,}$/;
const POSITIVE_DECIMAL_REGEX = /^[1-9][0-9]{0,18}$/;
const SIGNED_DECIMAL_REGEX = /^-?(?:0|[1-9][0-9]{0,18})$/;
const GROUPED_THOUSANDS_INTEGER_REGEX = /^-?[1-9][0-9]{0,2}(?:([.,\s])[0-9]{3})+$/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const CURSOR_TOKEN_REGEX = /^[A-Za-z0-9_-]{4,512}$/;
const FORBIDDEN_TEXT_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const FORBIDDEN_SINGLE_LINE_CONTROL_CHARS = /[\x00-\x1F\x7F]/;

// -----------------------------------------------------------------------------
// 2. Server Page Gate Pure Decision (`decideVendorFinancePageAccess`)
// -----------------------------------------------------------------------------
export type VendorFinanceServerAccessResult =
  | { ok: true; can_view: boolean; can_record: boolean }
  | { ok: false; code: string };

export function decideVendorFinancePageAccess(input: {
  enabledFlag: string | undefined;
  requiredMode: "view" | "record";
  actor: ActorResolution | null;
  serverAccess?: VendorFinanceServerAccessResult | null;
}): DirectEntryPageDecision {
  if (input.enabledFlag !== "true") {
    return "NOT_FOUND";
  }
  const actor = input.actor;
  if (!actor) {
    return "TEMPORARY_UNAVAILABLE";
  }
  if (!actor.ok) {
    if (actor.reason === "UNAUTHENTICATED") {
      return "REDIRECT_LOGIN";
    }
    if (actor.reason === "ACTOR_MAPPING_MISSING" || actor.reason === "ACTOR_DISABLED") {
      return "ACCOUNT_UNAVAILABLE";
    }
    return "TEMPORARY_UNAVAILABLE";
  }

  const baseProjection: NavActorProjection = {
    capabilities: actor.actor.capabilities,
    scopes: actor.actor.scopes.map((scope) => ({ kind: scope.kind })),
  };

  if (vendorFinanceRecordNavPredicate(baseProjection)) {
    return "ALLOW";
  }
  if (input.requiredMode === "view" && vendorFinanceNavPredicate(baseProjection)) {
    return "ALLOW";
  }

  const serverAccess = input.serverAccess;
  if (!serverAccess) {
    return "TEMPORARY_UNAVAILABLE";
  }
  if (!serverAccess.ok) {
    if (serverAccess.code === "ACTOR_NOT_AVAILABLE") {
      return "ACCOUNT_UNAVAILABLE";
    }
    if (
      serverAccess.code === "VENDOR_FINANCE_ACCESS_DENIED" ||
      serverAccess.code === "VENDOR_FINANCE_RECORD_DENIED"
    ) {
      return "ACCESS_DENIED";
    }
    return "TEMPORARY_UNAVAILABLE";
  }

  const enrichedProjection: NavActorProjection = {
    ...baseProjection,
    hasVendorFinanceAccess: serverAccess.can_view,
    hasVendorFinanceRecordAccess: serverAccess.can_view && serverAccess.can_record,
  };

  const allowed =
    input.requiredMode === "record"
      ? vendorFinanceRecordNavPredicate(enrichedProjection)
      : vendorFinanceNavPredicate(enrichedProjection);
  return allowed ? "ALLOW" : "ACCESS_DENIED";
}

// -----------------------------------------------------------------------------
// 3. BigInt-Only Whole-VND Parsing & Display Formatting (Zero Float Math)
// -----------------------------------------------------------------------------
function groupDigitsThousands(unsignedDigits: string): string {
  return unsignedDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function parseCanonicalSignedMoneyBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || value === "-0" || !SIGNED_DECIMAL_REGEX.test(value)) {
    return null;
  }
  const parsed = BigInt(value);
  if (parsed < VFIN_UI_PG_BIGINT_MIN || parsed > VFIN_UI_PG_BIGINT_MAX) {
    return null;
  }
  return parsed;
}

export function parseCanonicalNonNegativeMoneyBigInt(value: unknown): bigint | null {
  const parsed = parseCanonicalSignedMoneyBigInt(value);
  if (parsed === null || parsed < ZERO_BIGINT) return null;
  return parsed;
}

export function parseCanonicalPositiveMoneyBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !POSITIVE_DECIMAL_REGEX.test(value)) {
    return null;
  }
  const parsed = BigInt(value);
  if (parsed < ONE_BIGINT || parsed > VFIN_UI_PG_BIGINT_MAX) {
    return null;
  }
  return parsed;
}

/**
 * Formats a canonical signed integer VND string (`"1500000"`, `"-250000"`, `"0"`)
 * into Vietnamese display format (`"1.500.000 ₫"`, `"-250.000 ₫"`, `"0 ₫"`),
 * preserving exact digits up to `int8` limits without `Number` conversion.
 */
export function formatVndMinor(canonical: string): string {
  const parsed = parseCanonicalSignedMoneyBigInt(canonical);
  if (parsed === null) {
    return "—";
  }
  const normalized = parsed.toString();
  if (normalized.startsWith("-")) {
    return `-${groupDigitsThousands(normalized.slice(1))} ₫`;
  }
  return `${groupDigitsThousands(normalized)} ₫`;
}

/**
 * Formats a signed ledger delta or difference with explicit `+` for positive amounts.
 */
export function formatSignedVndDelta(canonical: string): string {
  const parsed = parseCanonicalSignedMoneyBigInt(canonical);
  if (parsed === null) {
    return "—";
  }
  if (parsed === ZERO_BIGINT) {
    return "0 ₫";
  }
  if (parsed > ZERO_BIGINT) {
    return `+${groupDigitsThousands(parsed.toString())} ₫`;
  }
  return `-${groupDigitsThousands(parsed.toString().slice(1))} ₫`;
}

/**
 * Formats the absolute value of a canonical money string (`"-250000"` -> `"250.000 ₫"`).
 */
export function formatAbsoluteVndMinor(canonical: string): string {
  const parsed = parseCanonicalSignedMoneyBigInt(canonical);
  if (parsed === null) {
    return "—";
  }
  const absDigits = parsed < ZERO_BIGINT ? parsed.toString().slice(1) : parsed.toString();
  return `${groupDigitsThousands(absDigits)} ₫`;
}

export function formatVendorBalancePresentation(input: {
  current_balance_minor: string;
  balance_direction: VendorFinanceBalanceDirection;
  entry_count: number;
  has_opening_entry: boolean;
}): {
  amountText: string;
  signedText: string;
  statusLabel: string;
  tone: UiBadgeTone;
} {
  if (!input.has_opening_entry && input.entry_count === 0) {
    return {
      amountText: "0 ₫",
      signedText: "0 ₫",
      statusLabel: "Chưa khởi tạo đầu kỳ",
      tone: "neutral",
    };
  }
  switch (input.balance_direction) {
    case "PAYABLE":
      return {
        amountText: formatVndMinor(input.current_balance_minor),
        signedText: formatSignedVndDelta(input.current_balance_minor),
        statusLabel: "Phải trả Vendor",
        tone: "warning",
      };
    case "ADVANCE":
      return {
        amountText: formatAbsoluteVndMinor(input.current_balance_minor),
        signedText: formatVndMinor(input.current_balance_minor),
        statusLabel: "Vendor dư ứng",
        tone: "info",
      };
    case "BALANCED":
      return {
        amountText: "0 ₫",
        signedText: "0 ₫",
        statusLabel: "Cân bằng",
        tone: "success",
      };
  }
}

export type NormalizedVndInputResult =
  | { ok: true; canonical: string; value: bigint }
  | { ok: false; code: "VENDOR_FINANCE_AMOUNT_INVALID" | "VENDOR_FINANCE_AMOUNT_OVERFLOW"; message: string };

function extractRawVndIntegerDigits(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.startsWith("+") || trimmed === "-0") {
    return null;
  }
  if (/^-?(?:0|[1-9][0-9]*)$/.test(trimmed)) {
    return trimmed;
  }
  // Accept consistent 3-digit thousand grouping (`1.500.000`, `1,500,000`, `1 500 000`)
  // while rejecting fractional inputs like `100.5` or `100,50` or mixed separators `1.500,000`.
  if (GROUPED_THOUSANDS_INTEGER_REGEX.test(trimmed)) {
    const separators = trimmed.match(/[.,\s]/g) ?? [];
    const uniqueSeparators = new Set(separators);
    if (uniqueSeparators.size === 1) {
      return trimmed.replace(/[.,\s]/g, "");
    }
  }
  return null;
}

export function normalizePositiveVndInput(raw: string): NormalizedVndInputResult {
  const digits = extractRawVndIntegerDigits(raw);
  if (digits === null || digits === "0" || digits.startsWith("-")) {
    return {
      ok: false,
      code: "VENDOR_FINANCE_AMOUNT_INVALID",
      message: "Vui lòng nhập số tiền VND nguyên dương hợp lệ (không có số lẻ thập phân).",
    };
  }
  if (digits.length > 19) {
    return {
      ok: false,
      code: "VENDOR_FINANCE_AMOUNT_OVERFLOW",
      message: "Số tiền vượt giới hạn tối đa cho phép của hệ thống.",
    };
  }
  const value = BigInt(digits);
  if (value < ONE_BIGINT || value > VFIN_UI_PG_BIGINT_MAX) {
    return {
      ok: false,
      code: "VENDOR_FINANCE_AMOUNT_OVERFLOW",
      message: "Số tiền vượt giới hạn tối đa cho phép của hệ thống.",
    };
  }
  return { ok: true, canonical: value.toString(), value };
}

export function normalizeNonNegativeVndInput(raw: string): NormalizedVndInputResult {
  const digits = extractRawVndIntegerDigits(raw);
  if (digits === null || digits.startsWith("-")) {
    return {
      ok: false,
      code: "VENDOR_FINANCE_AMOUNT_INVALID",
      message: "Số tiền đầu kỳ phải là số nguyên VND không âm (nhập 0 nếu bỏ qua Vendor này).",
    };
  }
  if (digits === "0") {
    return { ok: true, canonical: "0", value: ZERO_BIGINT };
  }
  return normalizePositiveVndInput(digits);
}

export function normalizeSignedVndInput(raw: string): NormalizedVndInputResult {
  const digits = extractRawVndIntegerDigits(raw);
  if (digits === null) {
    return {
      ok: false,
      code: "VENDOR_FINANCE_AMOUNT_INVALID",
      message:
        "Số dư xác nhận phải là số nguyên VND hợp lệ (dương nếu còn phải trả, âm nếu Vendor đang dư ứng, hoặc 0).",
    };
  }
  const unsigned = digits.startsWith("-") ? digits.slice(1) : digits;
  if (unsigned.length > 19) {
    return {
      ok: false,
      code: "VENDOR_FINANCE_AMOUNT_OVERFLOW",
      message: "Số dư vượt giới hạn tối đa cho phép của hệ thống.",
    };
  }
  const value = BigInt(digits);
  if (value < VFIN_UI_PG_BIGINT_MIN || value > VFIN_UI_PG_BIGINT_MAX) {
    return {
      ok: false,
      code: "VENDOR_FINANCE_AMOUNT_OVERFLOW",
      message: "Số dư vượt giới hạn tối đa cho phép của hệ thống.",
    };
  }
  return { ok: true, canonical: value.toString(), value };
}

/**
 * Pure client-side preview calculation for the Reconciliation dialog ONLY
 * (`difference = confirmed - system`), using `BigInt` with zero float math.
 * Server remains the sole authority when saving.
 */
export function computeReconciliationDifferencePreview(
  systemBalanceMinor: string,
  confirmedBalanceMinor: string,
): string | null {
  const sys = parseCanonicalSignedMoneyBigInt(systemBalanceMinor);
  const conf = parseCanonicalSignedMoneyBigInt(confirmedBalanceMinor);
  if (sys === null || conf === null) return null;
  const diff = conf - sys;
  if (diff < VFIN_UI_PG_BIGINT_MIN || diff > VFIN_UI_PG_BIGINT_MAX) {
    return null;
  }
  return diff.toString();
}

export function formatVietnamDateLabel(isoDate: string | null | undefined): string {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return "—";
  }
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

export function formatTimestampVi(isoTimestamp: string | null | undefined): string {
  if (!isoTimestamp) return "—";
  const parsed = Date.parse(isoTimestamp);
  if (!Number.isFinite(parsed)) return isoTimestamp;
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(parsed));
}

export function formatFileSizeVi(sizeBytes: number): string {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return "—";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) {
    const kbTenths = Math.round((sizeBytes * 10) / 1024);
    return `${(kbTenths / 10).toFixed(1)} KB`;
  }
  const mbTenths = Math.round((sizeBytes * 10) / (1024 * 1024));
  return `${(mbTenths / 10).toFixed(1)} MB`;
}

// -----------------------------------------------------------------------------
// 4. Route & API URL Builders
// -----------------------------------------------------------------------------
export function isCanonicalUiVendorId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "__system_vendor__" &&
    VENDOR_ID_REGEX.test(value)
  );
}

export function isUuidString(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}

export function buildVendorListUrl(params?: {
  search?: string | null;
  active?: VendorFinanceActiveFilter;
  balance_filter?: VendorFinanceBalanceFilter;
  page?: number;
  page_size?: number;
}): string {
  const sp = new URLSearchParams();
  if (params?.search !== undefined && params.search !== null) {
    const trimmed = params.search.trim();
    if (trimmed.length > 0) {
      sp.set("search", trimmed.slice(0, VFIN_UI_MAX_SEARCH_LENGTH));
    }
  }
  if (params?.active && params.active !== "all") {
    sp.set("active", params.active);
  }
  if (params?.balance_filter && params.balance_filter !== "all") {
    sp.set("balance_filter", params.balance_filter);
  }
  if (params?.page && Number.isSafeInteger(params.page) && params.page > 1) {
    sp.set("page", String(params.page));
  }
  if (params?.page_size && Number.isSafeInteger(params.page_size)) {
    sp.set("page_size", String(params.page_size));
  }
  const qs = sp.toString();
  return qs ? `/api/vendor-finance/vendors?${qs}` : "/api/vendor-finance/vendors";
}

export function buildVendorDetailUrl(vendorId: string): string {
  return `/api/vendor-finance/vendors/${encodeURIComponent(vendorId)}`;
}

export function buildVendorEntriesUrl(
  vendorId: string,
  params?: {
    cursor?: string | null;
    entry_type?: VendorFinanceEntryType | null;
    page_size?: number;
  },
): string {
  const sp = new URLSearchParams();
  if (params?.cursor) {
    sp.set("cursor", params.cursor);
  }
  if (params?.entry_type) {
    sp.set("entry_type", params.entry_type);
  }
  if (params?.page_size && Number.isSafeInteger(params.page_size)) {
    sp.set("page_size", String(params.page_size));
  }
  const qs = sp.toString();
  const base = `/api/vendor-finance/vendors/${encodeURIComponent(vendorId)}/entries`;
  return qs ? `${base}?${qs}` : base;
}

export function buildSingleEntryUrl(entryId: string): string {
  return `/api/vendor-finance/entries/${encodeURIComponent(entryId)}`;
}

export function buildReverseEntryUrl(entryId: string): string {
  return `/api/vendor-finance/entries/${encodeURIComponent(entryId)}/reverse`;
}

export function buildOpeningPreviewUrl(): string {
  return "/api/vendor-finance/opening-batches/preview";
}

export function buildOpeningApplyUrl(): string {
  return "/api/vendor-finance/opening-batches/apply";
}

export function buildVendorReconciliationsUrl(
  vendorId: string,
  params?: {
    page?: number;
    page_size?: number;
  },
): string {
  const sp = new URLSearchParams();
  if (params?.page && Number.isSafeInteger(params.page) && params.page > 1) {
    sp.set("page", String(params.page));
  }
  if (params?.page_size && Number.isSafeInteger(params.page_size)) {
    sp.set("page_size", String(params.page_size));
  }
  const qs = sp.toString();
  const base = `/api/vendor-finance/vendors/${encodeURIComponent(vendorId)}/reconciliations`;
  return qs ? `${base}?${qs}` : base;
}

export function buildReserveEvidenceUrl(): string {
  return "/api/vendor-finance/evidence/reserve";
}

export function buildFinalizeEvidenceUrl(evidenceId: string): string {
  return `/api/vendor-finance/evidence/${encodeURIComponent(evidenceId)}/finalize`;
}

export function buildDownloadEvidenceUrl(evidenceId: string): string {
  return `/api/vendor-finance/evidence/${encodeURIComponent(evidenceId)}/download`;
}

// -----------------------------------------------------------------------------
// 5. Client Request Builders (Strict Contract Parity, Zero Authority Fields)
// -----------------------------------------------------------------------------
export function createClientIdempotencyKey(): string {
  return globalThis.crypto.randomUUID().toLowerCase();
}

export function validateUiCalendarDate(
  raw: string,
): { ok: true; date: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!isRealCalendarDate(trimmed)) {
    return { ok: false, message: "Ngày hiệu lực không hợp lệ (định dạng YYYY-MM-DD)." };
  }
  const year = Number(trimmed.slice(0, 4));
  if (!Number.isInteger(year) || year < 1970 || year > 2999) {
    return { ok: false, message: "Năm của ngày hiệu lực phải nằm trong khoảng 1970–2999." };
  }
  return { ok: true, date: trimmed };
}

export function validateUiReasonText(
  raw: string,
): { ok: true; reason: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed.length < 1) {
    return { ok: false, message: "Vui lòng nhập lý do ghi nhận." };
  }
  if (trimmed.length > VFIN_UI_MAX_REASON_LENGTH) {
    return {
      ok: false,
      message: `Lý do không được vượt quá ${VFIN_UI_MAX_REASON_LENGTH} ký tự.`,
    };
  }
  if (FORBIDDEN_TEXT_CONTROL_CHARS.test(trimmed)) {
    return { ok: false, message: "Lý do chứa ký tự điều khiển không hợp lệ." };
  }
  return { ok: true, reason: trimmed };
}

export function validateUiSearchInput(
  raw: string,
): { ok: true; search: string | null } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, search: null };
  if (trimmed.length > VFIN_UI_MAX_SEARCH_LENGTH) {
    return {
      ok: false,
      message: `Từ khóa tìm kiếm không được vượt quá ${VFIN_UI_MAX_SEARCH_LENGTH} ký tự.`,
    };
  }
  if (FORBIDDEN_SINGLE_LINE_CONTROL_CHARS.test(trimmed)) {
    return { ok: false, message: "Từ khóa tìm kiếm chứa ký tự không hợp lệ." };
  }
  return { ok: true, search: trimmed };
}

export type BuiltJsonRequest<TBody> = {
  headers: Readonly<Record<string, string>>;
  body: TBody;
};

export function buildRecordEntryRequest(input: {
  entry_type: string;
  amount_input: string;
  effective_date: string;
  reason: string;
  idempotency_key: string;
  allowed_entry_types?: readonly NormalVendorFinanceEntryType[];
}):
  | { ok: true; request: BuiltJsonRequest<RecordVendorFinanceEntryBody> }
  | { ok: false; message: string } {
  if (!(VFIN_UI_NORMAL_ENTRY_TYPES as readonly string[]).includes(input.entry_type)) {
    return { ok: false, message: "Loại bút toán không hợp lệ." };
  }
  const entryType = input.entry_type as NormalVendorFinanceEntryType;
  if (input.allowed_entry_types && !input.allowed_entry_types.includes(entryType)) {
    return {
      ok: false,
      message: "Loại bút toán này không được phép áp dụng cho trạng thái Vendor hiện tại.",
    };
  }
  const amount = normalizePositiveVndInput(input.amount_input);
  if (!amount.ok) {
    return { ok: false, message: amount.message };
  }
  const effectiveDate = validateUiCalendarDate(input.effective_date);
  if (!effectiveDate.ok) {
    return { ok: false, message: effectiveDate.message };
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) {
    return { ok: false, message: reason.message };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        entry_type: entryType,
        amount_minor: amount.canonical,
        effective_date: effectiveDate.date,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export function buildReverseEntryRequest(input: {
  effective_date: string | null | undefined;
  reason: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<ReverseVendorFinanceEntryBody> }
  | { ok: false; message: string } {
  let effectiveDate: string | null = null;
  if (typeof input.effective_date === "string" && input.effective_date.trim().length > 0) {
    const parsedDate = validateUiCalendarDate(input.effective_date);
    if (!parsedDate.ok) {
      return { ok: false, message: parsedDate.message };
    }
    effectiveDate = parsedDate.date;
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) {
    return { ok: false, message: reason.message };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        effective_date: effectiveDate,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export type OpeningDraftRowInput = {
  vendor_id: string;
  entry_type: string;
  amount_input: string;
};

function normalizeOpeningDraftItems(
  rows: readonly OpeningDraftRowInput[],
):
  | {
      ok: true;
      items: OpeningBatchItemInput[];
      non_zero_count: number;
      zero_count: number;
    }
  | { ok: false; message: string; invalid_vendor_id?: string } {
  if (rows.length < 1) {
    return {
      ok: false,
      message: "Vui lòng chọn ít nhất một Vendor chưa khởi tạo để lập lô số dư đầu kỳ.",
    };
  }
  if (rows.length > VFIN_UI_MAX_OPENING_BATCH_ITEMS) {
    return {
      ok: false,
      message: `Mỗi lô khởi tạo tối đa ${VFIN_UI_MAX_OPENING_BATCH_ITEMS} Vendor.`,
    };
  }

  const seenVendors = new Set<string>();
  const items: OpeningBatchItemInput[] = [];
  let nonZeroCount = 0;
  let zeroCount = 0;

  for (const row of rows) {
    if (!isCanonicalUiVendorId(row.vendor_id)) {
      return {
        ok: false,
        message: "Mã Vendor trong danh sách đầu kỳ không hợp lệ.",
      };
    }
    if (seenVendors.has(row.vendor_id)) {
      return {
        ok: false,
        invalid_vendor_id: row.vendor_id,
        message: `Vendor "${row.vendor_id}" bị trùng lặp trong cùng một lô đầu kỳ.`,
      };
    }
    seenVendors.add(row.vendor_id);

    if (!(VFIN_UI_OPENING_ENTRY_TYPES as readonly string[]).includes(row.entry_type)) {
      return {
        ok: false,
        invalid_vendor_id: row.vendor_id,
        message: "Loại số dư đầu kỳ không hợp lệ (chỉ chấp nhận Phải trả hoặc Dư ứng).",
      };
    }
    const amount = normalizeNonNegativeVndInput(row.amount_input);
    if (!amount.ok) {
      return {
        ok: false,
        invalid_vendor_id: row.vendor_id,
        message: `${amount.message} (Vendor: ${row.vendor_id}).`,
      };
    }
    if (amount.value > ZERO_BIGINT) {
      nonZeroCount += 1;
    } else {
      zeroCount += 1;
    }
    items.push({
      vendor_id: row.vendor_id,
      entry_type: row.entry_type as OpeningVendorFinanceEntryType,
      amount_minor: amount.canonical,
    });
  }

  if (nonZeroCount === 0) {
    return {
      ok: false,
      message:
        "Lô khởi tạo phải có ít nhất một Vendor có số dư lớn hơn 0 ₫ (các dòng 0 ₫ sẽ được hệ thống bỏ qua).",
    };
  }

  return {
    ok: true,
    items,
    non_zero_count: nonZeroCount,
    zero_count: zeroCount,
  };
}

export function buildOpeningPreviewRequest(input: {
  cutoff_date: string;
  rows: readonly OpeningDraftRowInput[];
}):
  | {
      ok: true;
      request: BuiltJsonRequest<PreviewOpeningBatchBody>;
      non_zero_count: number;
      zero_count: number;
    }
  | { ok: false; message: string; invalid_vendor_id?: string } {
  const cutoffDate = validateUiCalendarDate(input.cutoff_date);
  if (!cutoffDate.ok) {
    return { ok: false, message: "Ngày chốt số dư đầu kỳ (cutoff date) không hợp lệ." };
  }
  const normalized = normalizeOpeningDraftItems(input.rows);
  if (!normalized.ok) {
    return normalized;
  }
  return {
    ok: true,
    non_zero_count: normalized.non_zero_count,
    zero_count: normalized.zero_count,
    request: {
      headers: { "Content-Type": "application/json" },
      body: {
        cutoff_date: cutoffDate.date,
        items: normalized.items,
      },
    },
  };
}

export function buildOpeningApplyRequest(input: {
  cutoff_date: string;
  rows: readonly OpeningDraftRowInput[];
  reason: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<ApplyOpeningBatchBody> }
  | { ok: false; message: string; invalid_vendor_id?: string } {
  const previewBuilt = buildOpeningPreviewRequest({
    cutoff_date: input.cutoff_date,
    rows: input.rows,
  });
  if (!previewBuilt.ok) {
    return previewBuilt;
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) {
    return { ok: false, message: reason.message };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        cutoff_date: previewBuilt.request.body.cutoff_date,
        items: previewBuilt.request.body.items,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export function buildCreateReconciliationRequest(input: {
  as_of_date: string;
  confirmed_balance_input: string;
  reason: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<CreateVendorReconciliationBody> }
  | { ok: false; message: string } {
  const asOfDate = validateUiCalendarDate(input.as_of_date);
  if (!asOfDate.ok) {
    return { ok: false, message: "Ngày chốt đối soát không hợp lệ." };
  }
  const confirmed = normalizeSignedVndInput(input.confirmed_balance_input);
  if (!confirmed.ok) {
    return { ok: false, message: confirmed.message };
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) {
    return { ok: false, message: reason.message };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        as_of_date: asOfDate.date,
        confirmed_balance_minor: confirmed.canonical,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export function buildReserveEvidenceRequest(input: {
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<ReserveVendorFinanceEvidenceBody> }
  | { ok: false; message: string } {
  if (!(VFIN_UI_EVIDENCE_TARGET_KINDS as readonly string[]).includes(input.target_kind)) {
    return { ok: false, message: "Đối tượng đính kèm bằng chứng không hợp lệ." };
  }
  if (!isUuidString(input.target_id)) {
    return { ok: false, message: "Mã bút toán/đối soát để đính kèm ảnh không hợp lệ." };
  }
  if (!(VFIN_UI_EVIDENCE_MIME_TYPES as readonly string[]).includes(input.mime_type)) {
    return { ok: false, message: "Ảnh bằng chứng chỉ hỗ trợ định dạng JPEG hoặc PNG." };
  }
  if (
    !Number.isSafeInteger(input.size_bytes) ||
    input.size_bytes < 1 ||
    input.size_bytes > VFIN_UI_EVIDENCE_MAX_BYTES
  ) {
    return { ok: false, message: "Dung lượng ảnh bằng chứng phải từ 1 byte đến tối đa 10 MB." };
  }
  if (!SHA256_HEX_REGEX.test(input.checksum_sha256)) {
    return { ok: false, message: "Mã băm kiểm tra toàn vẹn ảnh (SHA-256) không hợp lệ." };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        target_kind: input.target_kind,
        target_id: input.target_id.toLowerCase(),
        mime_type: input.mime_type,
        size_bytes: input.size_bytes,
        checksum_sha256: input.checksum_sha256.toLowerCase(),
        idempotency_key: idem,
      },
    },
  };
}

export function buildFinalizeEvidenceRequest(): BuiltJsonRequest<Record<string, never>> {
  return {
    headers: { "Content-Type": "application/json" },
    body: {},
  };
}

// -----------------------------------------------------------------------------
// 6. Fail-Closed HTTP Envelope Parsers (`{ ok: true, data }`)
// -----------------------------------------------------------------------------
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

function nonEmptyStr(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nullableStr(value: unknown): string | null | undefined {
  return value === null ? null : (nonEmptyStr(value) ?? undefined);
}

function nonNegInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function posInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function boolVal(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function uuidStr(value: unknown): string | null {
  return isUuidString(value) ? value.toLowerCase() : null;
}

function nullableUuidStr(value: unknown): string | null | undefined {
  return value === null ? null : (uuidStr(value) ?? undefined);
}

function dateStr(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const check = validateUiCalendarDate(value);
  return check.ok ? check.date : null;
}

function nullableDateStr(value: unknown): string | null | undefined {
  return value === null ? null : (dateStr(value) ?? undefined);
}

function signedMoneyStr(value: unknown): string | null {
  const parsed = parseCanonicalSignedMoneyBigInt(value);
  return parsed === null ? null : parsed.toString();
}

function nonNegativeMoneyStr(value: unknown): string | null {
  const parsed = parseCanonicalNonNegativeMoneyBigInt(value);
  return parsed === null ? null : parsed.toString();
}

function positiveMoneyStr(value: unknown): string | null {
  const parsed = parseCanonicalPositiveMoneyBigInt(value);
  return parsed === null ? null : parsed.toString();
}

function isHttpsPresignedUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 4096) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function unwrapOkDataEnvelope(envelope: unknown): unknown | null {
  if (!isRecord(envelope) || !exactKeys(envelope, ["ok", "data"]) || envelope.ok !== true) {
    return null;
  }
  return envelope.data;
}

export function parseEvidenceSummaryProjection(value: unknown): VendorFinanceEvidenceSummary | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "evidence_id",
      "status",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "finalized_at",
    ])
  ) {
    return null;
  }
  const evidenceId = uuidStr(value.evidence_id);
  const mimeType =
    value.mime_type === "image/jpeg" || value.mime_type === "image/png" ? value.mime_type : null;
  const sizeBytes = posInt(value.size_bytes);
  const checksum =
    typeof value.checksum_sha256 === "string" && SHA256_HEX_REGEX.test(value.checksum_sha256)
      ? value.checksum_sha256.toLowerCase()
      : null;
  const finalizedAt = nonEmptyStr(value.finalized_at);
  if (
    value.status !== "READY" ||
    evidenceId === null ||
    mimeType === null ||
    sizeBytes === null ||
    sizeBytes > VFIN_UI_EVIDENCE_MAX_BYTES ||
    checksum === null ||
    finalizedAt === null
  ) {
    return null;
  }
  return {
    evidence_id: evidenceId,
    status: "READY",
    mime_type: mimeType,
    size_bytes: sizeBytes,
    checksum_sha256: checksum,
    finalized_at: finalizedAt,
  };
}

export function parseEntryProjection(value: unknown): VendorFinanceEntryProjection | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "entry_id",
      "vendor_id",
      "vendor_display_name_snapshot",
      "vendor_active",
      "vendor_sequence",
      "document_no",
      "document_kind",
      "document_title_vi",
      "entry_type",
      "amount_minor",
      "balance_before_minor",
      "balance_delta_minor",
      "balance_after_minor",
      "effective_date",
      "reason",
      "opening_batch_id",
      "reverses_entry_id",
      "reverses_document_no",
      "reversed_by_entry_id",
      "reversed_by_document_no",
      "can_reverse",
      "can_attach_evidence",
      "evidence",
      "created_by_display_name",
      "created_at",
      "internal_disclaimer",
    ])
  ) {
    return null;
  }
  const entryId = uuidStr(value.entry_id);
  const vendorId = isCanonicalUiVendorId(value.vendor_id) ? value.vendor_id : null;
  const vendorDisplayNameSnapshot = nonEmptyStr(value.vendor_display_name_snapshot);
  const vendorActive = boolVal(value.vendor_active);
  const vendorSequence = posInt(value.vendor_sequence);
  const documentNo =
    typeof value.document_no === "string" && DOCUMENT_NO_REGEX.test(value.document_no)
      ? value.document_no
      : null;
  const documentKind =
    typeof value.document_kind === "string" &&
    (VFIN_UI_DOCUMENT_KINDS as readonly string[]).includes(value.document_kind)
      ? (value.document_kind as VendorFinanceDocumentKind)
      : null;
  const documentTitleVi = nonEmptyStr(value.document_title_vi);
  const entryType =
    typeof value.entry_type === "string" &&
    (VFIN_UI_ENTRY_TYPES as readonly string[]).includes(value.entry_type)
      ? (value.entry_type as VendorFinanceEntryType)
      : null;
  const amountMinor = positiveMoneyStr(value.amount_minor);
  const balanceBeforeMinor = signedMoneyStr(value.balance_before_minor);
  const balanceDeltaMinor = signedMoneyStr(value.balance_delta_minor);
  const balanceAfterMinor = signedMoneyStr(value.balance_after_minor);
  const effectiveDate = dateStr(value.effective_date);
  const reason = nonEmptyStr(value.reason);
  const openingBatchId = nullableUuidStr(value.opening_batch_id);
  const reversesEntryId = nullableUuidStr(value.reverses_entry_id);
  const reversesDocNo = nullableStr(value.reverses_document_no);
  const reversedByEntryId = nullableUuidStr(value.reversed_by_entry_id);
  const reversedByDocNo = nullableStr(value.reversed_by_document_no);
  const canReverse = boolVal(value.can_reverse);
  const canAttachEvidence = boolVal(value.can_attach_evidence);
  const evidence = value.evidence === null ? null : parseEvidenceSummaryProjection(value.evidence);
  const createdByDisplayName = nonEmptyStr(value.created_by_display_name);
  const createdAt = nonEmptyStr(value.created_at);
  const disclaimer =
    value.internal_disclaimer === VFIN_UI_INTERNAL_DISCLAIMER_VI
      ? VFIN_UI_INTERNAL_DISCLAIMER_VI
      : null;

  if (
    entryId === null ||
    vendorId === null ||
    vendorDisplayNameSnapshot === null ||
    vendorActive === null ||
    vendorSequence === null ||
    documentNo === null ||
    documentKind === null ||
    documentTitleVi === null ||
    entryType === null ||
    amountMinor === null ||
    balanceBeforeMinor === null ||
    balanceDeltaMinor === null ||
    balanceAfterMinor === null ||
    effectiveDate === null ||
    reason === null ||
    openingBatchId === undefined ||
    reversesEntryId === undefined ||
    reversesDocNo === undefined ||
    reversedByEntryId === undefined ||
    reversedByDocNo === undefined ||
    canReverse === null ||
    canAttachEvidence === null ||
    (value.evidence !== null && evidence === null) ||
    createdByDisplayName === null ||
    createdAt === null ||
    disclaimer === null
  ) {
    return null;
  }

  if (BigInt(balanceBeforeMinor) + BigInt(balanceDeltaMinor) !== BigInt(balanceAfterMinor)) {
    return null;
  }

  return {
    entry_id: entryId,
    vendor_id: vendorId,
    vendor_display_name_snapshot: vendorDisplayNameSnapshot,
    vendor_active: vendorActive,
    vendor_sequence: vendorSequence,
    document_no: documentNo,
    document_kind: documentKind,
    document_title_vi: documentTitleVi,
    entry_type: entryType,
    amount_minor: amountMinor,
    balance_before_minor: balanceBeforeMinor,
    balance_delta_minor: balanceDeltaMinor,
    balance_after_minor: balanceAfterMinor,
    effective_date: effectiveDate,
    reason,
    opening_batch_id: openingBatchId,
    reverses_entry_id: reversesEntryId,
    reverses_document_no: reversesDocNo,
    reversed_by_entry_id: reversedByEntryId,
    reversed_by_document_no: reversedByDocNo,
    can_reverse: canReverse,
    can_attach_evidence: canAttachEvidence,
    evidence,
    created_by_display_name: createdByDisplayName,
    created_at: createdAt,
    internal_disclaimer: disclaimer,
  };
}

export function parseReconciliationProjection(
  value: unknown,
): VendorFinanceReconciliationProjection | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "reconciliation_id",
      "vendor_id",
      "as_of_date",
      "system_balance_minor",
      "confirmed_balance_minor",
      "difference_minor",
      "ledger_sequence_at_reconciliation",
      "reason",
      "can_attach_evidence",
      "evidence",
      "created_by_display_name",
      "created_at",
    ])
  ) {
    return null;
  }
  const reconciliationId = uuidStr(value.reconciliation_id);
  const vendorId = isCanonicalUiVendorId(value.vendor_id) ? value.vendor_id : null;
  const asOfDate = dateStr(value.as_of_date);
  const systemBalanceMinor = signedMoneyStr(value.system_balance_minor);
  const confirmedBalanceMinor = signedMoneyStr(value.confirmed_balance_minor);
  const differenceMinor = signedMoneyStr(value.difference_minor);
  const ledgerSeq = nonNegInt(value.ledger_sequence_at_reconciliation);
  const reason = nonEmptyStr(value.reason);
  const canAttachEvidence = boolVal(value.can_attach_evidence);
  const evidence = value.evidence === null ? null : parseEvidenceSummaryProjection(value.evidence);
  const createdByDisplayName = nonEmptyStr(value.created_by_display_name);
  const createdAt = nonEmptyStr(value.created_at);

  if (
    reconciliationId === null ||
    vendorId === null ||
    asOfDate === null ||
    systemBalanceMinor === null ||
    confirmedBalanceMinor === null ||
    differenceMinor === null ||
    ledgerSeq === null ||
    reason === null ||
    canAttachEvidence === null ||
    (value.evidence !== null && evidence === null) ||
    createdByDisplayName === null ||
    createdAt === null
  ) {
    return null;
  }

  if (BigInt(confirmedBalanceMinor) - BigInt(systemBalanceMinor) !== BigInt(differenceMinor)) {
    return null;
  }

  return {
    reconciliation_id: reconciliationId,
    vendor_id: vendorId,
    as_of_date: asOfDate,
    system_balance_minor: systemBalanceMinor,
    confirmed_balance_minor: confirmedBalanceMinor,
    difference_minor: differenceMinor,
    ledger_sequence_at_reconciliation: ledgerSeq,
    reason,
    can_attach_evidence: canAttachEvidence,
    evidence,
    created_by_display_name: createdByDisplayName,
    created_at: createdAt,
  };
}

export function parseVendorListEnvelope(envelope: unknown): VendorFinanceVendorListResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "authorization_date",
      "allowed_actions",
      "summary",
      "filters",
      "page",
      "page_size",
      "total",
      "has_more",
      "vendors",
    ]) ||
    !isRecord(data.allowed_actions) ||
    !exactKeys(data.allowed_actions, ["can_view", "can_record"]) ||
    !isRecord(data.summary) ||
    !exactKeys(data.summary, [
      "total_payable_minor",
      "total_advance_minor",
      "net_balance_minor",
      "vendors_with_payable_count",
      "vendors_with_advance_count",
      "vendors_with_nonzero_balance_count",
      "total_vendor_count",
      "uninitialized_vendor_count",
    ]) ||
    !isRecord(data.filters) ||
    !exactKeys(data.filters, ["search", "active", "balance_filter"]) ||
    !Array.isArray(data.vendors)
  ) {
    return null;
  }

  const authorizationDate = dateStr(data.authorization_date);
  const canView = boolVal(data.allowed_actions.can_view);
  const canRecord = boolVal(data.allowed_actions.can_record);
  const totalPayable = nonNegativeMoneyStr(data.summary.total_payable_minor);
  const totalAdvance = nonNegativeMoneyStr(data.summary.total_advance_minor);
  const netBalance = signedMoneyStr(data.summary.net_balance_minor);
  const payableCount = nonNegInt(data.summary.vendors_with_payable_count);
  const advanceCount = nonNegInt(data.summary.vendors_with_advance_count);
  const nonzeroCount = nonNegInt(data.summary.vendors_with_nonzero_balance_count);
  const totalVendorCount = nonNegInt(data.summary.total_vendor_count);
  const uninitializedCount = nonNegInt(data.summary.uninitialized_vendor_count);

  const search = nullableStr(data.filters.search);
  const active = data.filters.active;
  const balanceFilter = data.filters.balance_filter;
  const page = posInt(data.page);
  const pageSize = posInt(data.page_size);
  const total = nonNegInt(data.total);
  const hasMore = boolVal(data.has_more);

  if (
    authorizationDate === null ||
    canView !== true ||
    canRecord === null ||
    totalPayable === null ||
    totalAdvance === null ||
    netBalance === null ||
    payableCount === null ||
    advanceCount === null ||
    nonzeroCount === null ||
    totalVendorCount === null ||
    uninitializedCount === null ||
    search === undefined ||
    (active !== "all" && active !== "active" && active !== "inactive") ||
    (balanceFilter !== "all" &&
      balanceFilter !== "payable" &&
      balanceFilter !== "advance" &&
      balanceFilter !== "nonzero" &&
      balanceFilter !== "uninitialized") ||
    page === null ||
    pageSize === null ||
    total === null ||
    hasMore === null
  ) {
    return null;
  }

  const vendors: VendorFinanceListItem[] = [];
  for (const item of data.vendors) {
    if (
      !isRecord(item) ||
      !exactKeys(item, [
        "vendor_id",
        "display_name",
        "active",
        "current_balance_minor",
        "balance_direction",
        "entry_count",
        "has_opening_entry",
        "eligible_for_opening",
        "last_effective_date",
        "last_entry_at",
        "last_reconciled_as_of_date",
      ])
    ) {
      return null;
    }
    const vendorId = isCanonicalUiVendorId(item.vendor_id) ? item.vendor_id : null;
    const displayName = nonEmptyStr(item.display_name);
    const itemActive = boolVal(item.active);
    const currentBalance = signedMoneyStr(item.current_balance_minor);
    const direction = item.balance_direction;
    const entryCount = nonNegInt(item.entry_count);
    const hasOpening = boolVal(item.has_opening_entry);
    const eligible = boolVal(item.eligible_for_opening);
    const lastEffectiveDate = nullableDateStr(item.last_effective_date);
    const lastEntryAt = nullableStr(item.last_entry_at);
    const lastReconciled = nullableDateStr(item.last_reconciled_as_of_date);

    if (
      vendorId === null ||
      displayName === null ||
      itemActive === null ||
      currentBalance === null ||
      (direction !== "PAYABLE" && direction !== "BALANCED" && direction !== "ADVANCE") ||
      entryCount === null ||
      hasOpening === null ||
      eligible === null ||
      lastEffectiveDate === undefined ||
      lastEntryAt === undefined ||
      lastReconciled === undefined
    ) {
      return null;
    }
    vendors.push({
      vendor_id: vendorId,
      display_name: displayName,
      active: itemActive,
      current_balance_minor: currentBalance,
      balance_direction: direction,
      entry_count: entryCount,
      has_opening_entry: hasOpening,
      eligible_for_opening: eligible,
      last_effective_date: lastEffectiveDate,
      last_entry_at: lastEntryAt,
      last_reconciled_as_of_date: lastReconciled,
    });
  }

  const summary: VendorFinanceCompanySummary = {
    total_payable_minor: totalPayable,
    total_advance_minor: totalAdvance,
    net_balance_minor: netBalance,
    vendors_with_payable_count: payableCount,
    vendors_with_advance_count: advanceCount,
    vendors_with_nonzero_balance_count: nonzeroCount,
    total_vendor_count: totalVendorCount,
    uninitialized_vendor_count: uninitializedCount,
  };

  return {
    authorization_date: authorizationDate,
    allowed_actions: { can_view: true, can_record: canRecord },
    summary,
    filters: { search, active, balance_filter: balanceFilter },
    page,
    page_size: pageSize,
    total,
    has_more: hasMore,
    vendors,
  };
}

export function parseVendorDetailEnvelope(
  envelope: unknown,
): VendorFinanceVendorDetailResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, ["authorization_date", "allowed_actions", "vendor"]) ||
    !isRecord(data.allowed_actions) ||
    !exactKeys(data.allowed_actions, [
      "can_view",
      "can_record",
      "can_reconcile",
      "allowed_entry_types",
    ]) ||
    !Array.isArray(data.allowed_actions.allowed_entry_types) ||
    !isRecord(data.vendor) ||
    !exactKeys(data.vendor, [
      "vendor_id",
      "display_name",
      "active",
      "current_balance_minor",
      "balance_direction",
      "latest_sequence",
      "entry_count",
      "has_opening_entry",
      "eligible_for_opening",
      "totals",
      "latest_reconciliation",
      "recent_reconciliations",
    ]) ||
    !isRecord(data.vendor.totals) ||
    !exactKeys(data.vendor.totals, [
      "opening_payable_minor",
      "opening_advance_minor",
      "debt_recorded_minor",
      "payroll_recorded_minor",
      "payment_recorded_minor",
      "advance_recorded_minor",
      "adjustment_increase_minor",
      "adjustment_decrease_minor",
      "reversed_entry_count",
    ]) ||
    !Array.isArray(data.vendor.recent_reconciliations)
  ) {
    return null;
  }

  const authorizationDate = dateStr(data.authorization_date);
  const canView = boolVal(data.allowed_actions.can_view);
  const canRecord = boolVal(data.allowed_actions.can_record);
  const canReconcile = boolVal(data.allowed_actions.can_reconcile);
  const allowedEntryTypes: NormalVendorFinanceEntryType[] = [];
  for (const rawType of data.allowed_actions.allowed_entry_types) {
    if (
      typeof rawType !== "string" ||
      !(VFIN_UI_NORMAL_ENTRY_TYPES as readonly string[]).includes(rawType)
    ) {
      return null;
    }
    allowedEntryTypes.push(rawType as NormalVendorFinanceEntryType);
  }

  const v = data.vendor;
  const vendorId = isCanonicalUiVendorId(v.vendor_id) ? v.vendor_id : null;
  const displayName = nonEmptyStr(v.display_name);
  const active = boolVal(v.active);
  const currentBalance = signedMoneyStr(v.current_balance_minor);
  const direction = v.balance_direction;
  const latestSeq = nonNegInt(v.latest_sequence);
  const entryCount = nonNegInt(v.entry_count);
  const hasOpening = boolVal(v.has_opening_entry);
  const eligible = boolVal(v.eligible_for_opening);

  const t = v.totals as Record<string, unknown>;
  const openingPayable = nonNegativeMoneyStr(t.opening_payable_minor);
  const openingAdvance = nonNegativeMoneyStr(t.opening_advance_minor);
  const debtRecorded = nonNegativeMoneyStr(t.debt_recorded_minor);
  const payrollRecorded = nonNegativeMoneyStr(t.payroll_recorded_minor);
  const paymentRecorded = nonNegativeMoneyStr(t.payment_recorded_minor);
  const advanceRecorded = nonNegativeMoneyStr(t.advance_recorded_minor);
  const adjustmentInc = nonNegativeMoneyStr(t.adjustment_increase_minor);
  const adjustmentDec = nonNegativeMoneyStr(t.adjustment_decrease_minor);
  const reversedCount = nonNegInt(t.reversed_entry_count);

  const latestRec =
    v.latest_reconciliation === null
      ? null
      : parseReconciliationProjection(v.latest_reconciliation);

  const recentRecs: VendorFinanceReconciliationProjection[] = [];
  for (const item of v.recent_reconciliations as unknown[]) {
    const projected = parseReconciliationProjection(item);
    if (!projected) return null;
    recentRecs.push(projected);
  }

  if (
    authorizationDate === null ||
    canView !== true ||
    canRecord === null ||
    canReconcile === null ||
    vendorId === null ||
    displayName === null ||
    active === null ||
    currentBalance === null ||
    (direction !== "PAYABLE" && direction !== "BALANCED" && direction !== "ADVANCE") ||
    latestSeq === null ||
    entryCount === null ||
    hasOpening === null ||
    eligible === null ||
    openingPayable === null ||
    openingAdvance === null ||
    debtRecorded === null ||
    payrollRecorded === null ||
    paymentRecorded === null ||
    advanceRecorded === null ||
    adjustmentInc === null ||
    adjustmentDec === null ||
    reversedCount === null ||
    (v.latest_reconciliation !== null && latestRec === null)
  ) {
    return null;
  }

  const totals: VendorFinanceCategoryTotals = {
    opening_payable_minor: openingPayable,
    opening_advance_minor: openingAdvance,
    debt_recorded_minor: debtRecorded,
    payroll_recorded_minor: payrollRecorded,
    payment_recorded_minor: paymentRecorded,
    advance_recorded_minor: advanceRecorded,
    adjustment_increase_minor: adjustmentInc,
    adjustment_decrease_minor: adjustmentDec,
    reversed_entry_count: reversedCount,
  };

  return {
    authorization_date: authorizationDate,
    allowed_actions: {
      can_view: true,
      can_record: canRecord,
      can_reconcile: canReconcile,
      allowed_entry_types: allowedEntryTypes,
    },
    vendor: {
      vendor_id: vendorId,
      display_name: displayName,
      active,
      current_balance_minor: currentBalance,
      balance_direction: direction,
      latest_sequence: latestSeq,
      entry_count: entryCount,
      has_opening_entry: hasOpening,
      eligible_for_opening: eligible,
      totals,
      latest_reconciliation: latestRec,
      recent_reconciliations: recentRecs,
    },
  };
}

export function parseVendorEntriesPageEnvelope(
  envelope: unknown,
): VendorFinanceEntriesPageResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "authorization_date",
      "vendor_id",
      "page_size",
      "has_more",
      "next_cursor",
      "entries",
    ]) ||
    !Array.isArray(data.entries)
  ) {
    return null;
  }

  const authorizationDate = dateStr(data.authorization_date);
  const vendorId = isCanonicalUiVendorId(data.vendor_id) ? data.vendor_id : null;
  const pageSize = posInt(data.page_size);
  const hasMore = boolVal(data.has_more);
  const nextCursor =
    data.next_cursor === null
      ? null
      : typeof data.next_cursor === "string" && CURSOR_TOKEN_REGEX.test(data.next_cursor)
        ? data.next_cursor
        : undefined;

  if (
    authorizationDate === null ||
    vendorId === null ||
    pageSize === null ||
    hasMore === null ||
    nextCursor === undefined ||
    (hasMore && nextCursor === null) ||
    (!hasMore && nextCursor !== null)
  ) {
    return null;
  }

  const entries: VendorFinanceEntryProjection[] = [];
  for (const item of data.entries) {
    const projected = parseEntryProjection(item);
    if (!projected || projected.vendor_id !== vendorId) return null;
    entries.push(projected);
  }

  return {
    authorization_date: authorizationDate,
    vendor_id: vendorId,
    page_size: pageSize,
    has_more: hasMore,
    next_cursor: nextCursor,
    entries,
  };
}

export function parseSingleEntryEnvelope(
  envelope: unknown,
): VendorFinanceSingleEntryResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, ["authorization_date", "allowed_actions", "entry"]) ||
    !isRecord(data.allowed_actions) ||
    !exactKeys(data.allowed_actions, ["can_view", "can_record"])
  ) {
    return null;
  }
  const authorizationDate = dateStr(data.authorization_date);
  const canView = boolVal(data.allowed_actions.can_view);
  const canRecord = boolVal(data.allowed_actions.can_record);
  const entry = parseEntryProjection(data.entry);
  if (authorizationDate === null || canView !== true || canRecord === null || entry === null) {
    return null;
  }
  return {
    authorization_date: authorizationDate,
    allowed_actions: { can_view: true, can_record: canRecord },
    entry,
  };
}

export function parseRecordEntryEnvelope(
  envelope: unknown,
): { entry: VendorFinanceEntryProjection; replayed: boolean } | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (!isRecord(data) || !exactKeys(data, ["entry", "replayed"])) return null;
  const entry = parseEntryProjection(data.entry);
  const replayed = boolVal(data.replayed);
  if (!entry || replayed === null) return null;
  return { entry, replayed };
}

export function parseReverseEntryEnvelope(
  envelope: unknown,
): {
  reversal_entry: VendorFinanceEntryProjection;
  reversed_entry: VendorFinanceEntryProjection;
  replayed: boolean;
} | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (!isRecord(data) || !exactKeys(data, ["reversal_entry", "reversed_entry", "replayed"])) {
    return null;
  }
  const reversal = parseEntryProjection(data.reversal_entry);
  const reversed = parseEntryProjection(data.reversed_entry);
  const replayed = boolVal(data.replayed);
  if (!reversal || !reversed || replayed === null) return null;
  return { reversal_entry: reversal, reversed_entry: reversed, replayed };
}

export function parseOpeningPreviewEnvelope(
  envelope: unknown,
): VendorFinanceOpeningPreviewResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "authorization_date",
      "cutoff_date",
      "vendor_count",
      "skipped_zero_count",
      "total_payable_minor",
      "total_advance_minor",
      "net_balance_minor",
      "items",
    ]) ||
    !Array.isArray(data.items)
  ) {
    return null;
  }
  const authorizationDate = dateStr(data.authorization_date);
  const cutoffDate = dateStr(data.cutoff_date);
  const vendorCount = posInt(data.vendor_count);
  const skippedZero = nonNegInt(data.skipped_zero_count);
  const totalPayable = nonNegativeMoneyStr(data.total_payable_minor);
  const totalAdvance = nonNegativeMoneyStr(data.total_advance_minor);
  const netBalance = signedMoneyStr(data.net_balance_minor);
  if (
    authorizationDate === null ||
    cutoffDate === null ||
    vendorCount === null ||
    skippedZero === null ||
    totalPayable === null ||
    totalAdvance === null ||
    netBalance === null
  ) {
    return null;
  }

  const items: VendorFinanceOpeningPreviewItem[] = [];
  for (const rawItem of data.items) {
    if (
      !isRecord(rawItem) ||
      !exactKeys(rawItem, [
        "vendor_id",
        "display_name",
        "active",
        "entry_type",
        "amount_minor",
        "balance_delta_minor",
      ])
    ) {
      return null;
    }
    const vendorId = isCanonicalUiVendorId(rawItem.vendor_id) ? rawItem.vendor_id : null;
    const displayName = nonEmptyStr(rawItem.display_name);
    const active = boolVal(rawItem.active);
    const entryType =
      rawItem.entry_type === "OPENING_PAYABLE" || rawItem.entry_type === "OPENING_ADVANCE"
        ? rawItem.entry_type
        : null;
    const amountMinor = positiveMoneyStr(rawItem.amount_minor);
    const deltaMinor = signedMoneyStr(rawItem.balance_delta_minor);
    if (
      vendorId === null ||
      displayName === null ||
      active === null ||
      entryType === null ||
      amountMinor === null ||
      deltaMinor === null
    ) {
      return null;
    }
    items.push({
      vendor_id: vendorId,
      display_name: displayName,
      active,
      entry_type: entryType,
      amount_minor: amountMinor,
      balance_delta_minor: deltaMinor,
    });
  }
  if (items.length !== vendorCount) return null;

  return {
    authorization_date: authorizationDate,
    cutoff_date: cutoffDate,
    vendor_count: vendorCount,
    skipped_zero_count: skippedZero,
    total_payable_minor: totalPayable,
    total_advance_minor: totalAdvance,
    net_balance_minor: netBalance,
    items,
  };
}

export function parseOpeningApplyEnvelope(
  envelope: unknown,
): VendorFinanceOpeningApplyResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, ["batch", "entries", "replayed"]) ||
    !isRecord(data.batch) ||
    !exactKeys(data.batch, [
      "batch_id",
      "cutoff_date",
      "vendor_count",
      "skipped_zero_count",
      "total_payable_minor",
      "total_advance_minor",
      "net_balance_minor",
      "reason",
      "created_by_display_name",
      "created_at",
    ]) ||
    !Array.isArray(data.entries)
  ) {
    return null;
  }

  const b = data.batch;
  const batchId = uuidStr(b.batch_id);
  const cutoffDate = dateStr(b.cutoff_date);
  const vendorCount = posInt(b.vendor_count);
  const skippedZero = nonNegInt(b.skipped_zero_count);
  const totalPayable = nonNegativeMoneyStr(b.total_payable_minor);
  const totalAdvance = nonNegativeMoneyStr(b.total_advance_minor);
  const netBalance = signedMoneyStr(b.net_balance_minor);
  const reason = nonEmptyStr(b.reason);
  const createdBy = nonEmptyStr(b.created_by_display_name);
  const createdAt = nonEmptyStr(b.created_at);
  const replayed = boolVal(data.replayed);

  if (
    batchId === null ||
    cutoffDate === null ||
    vendorCount === null ||
    skippedZero === null ||
    totalPayable === null ||
    totalAdvance === null ||
    netBalance === null ||
    reason === null ||
    createdBy === null ||
    createdAt === null ||
    replayed === null
  ) {
    return null;
  }

  const entries: VendorFinanceEntryProjection[] = [];
  for (const item of data.entries) {
    const projected = parseEntryProjection(item);
    if (!projected) return null;
    entries.push(projected);
  }
  if (entries.length !== vendorCount) return null;

  return {
    batch: {
      batch_id: batchId,
      cutoff_date: cutoffDate,
      vendor_count: vendorCount,
      skipped_zero_count: skippedZero,
      total_payable_minor: totalPayable,
      total_advance_minor: totalAdvance,
      net_balance_minor: netBalance,
      reason,
      created_by_display_name: createdBy,
      created_at: createdAt,
    },
    entries,
    replayed,
  };
}

export function parseVendorReconciliationsPageEnvelope(
  envelope: unknown,
): VendorFinanceReconciliationsPageResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "authorization_date",
      "vendor_id",
      "page",
      "page_size",
      "total",
      "has_more",
      "reconciliations",
    ]) ||
    !Array.isArray(data.reconciliations)
  ) {
    return null;
  }
  const authorizationDate = dateStr(data.authorization_date);
  const vendorId = isCanonicalUiVendorId(data.vendor_id) ? data.vendor_id : null;
  const page = posInt(data.page);
  const pageSize = posInt(data.page_size);
  const total = nonNegInt(data.total);
  const hasMore = boolVal(data.has_more);
  if (
    authorizationDate === null ||
    vendorId === null ||
    page === null ||
    pageSize === null ||
    total === null ||
    hasMore === null
  ) {
    return null;
  }
  const reconciliations: VendorFinanceReconciliationProjection[] = [];
  for (const item of data.reconciliations) {
    const projected = parseReconciliationProjection(item);
    if (!projected || projected.vendor_id !== vendorId) return null;
    reconciliations.push(projected);
  }
  return {
    authorization_date: authorizationDate,
    vendor_id: vendorId,
    page,
    page_size: pageSize,
    total,
    has_more: hasMore,
    reconciliations,
  };
}

export function parseCreateReconciliationEnvelope(
  envelope: unknown,
): { reconciliation: VendorFinanceReconciliationProjection; replayed: boolean } | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (!isRecord(data) || !exactKeys(data, ["reconciliation", "replayed"])) return null;
  const reconciliation = parseReconciliationProjection(data.reconciliation);
  const replayed = boolVal(data.replayed);
  if (!reconciliation || replayed === null) return null;
  return { reconciliation, replayed };
}

export function parseEvidenceReserveEnvelope(
  envelope: unknown,
): VendorFinanceEvidenceReserveResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "evidence_id",
      "target_kind",
      "target_id",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "upload",
      "replayed",
    ]) ||
    !isRecord(data.upload) ||
    !exactKeys(data.upload, ["method", "url", "expires_at", "headers"]) ||
    !isRecord(data.upload.headers)
  ) {
    return null;
  }

  const evidenceId = uuidStr(data.evidence_id);
  const targetKind =
    data.target_kind === "ENTRY" || data.target_kind === "RECONCILIATION"
      ? data.target_kind
      : null;
  const targetId = uuidStr(data.target_id);
  const mimeType =
    data.mime_type === "image/jpeg" || data.mime_type === "image/png" ? data.mime_type : null;
  const sizeBytes = posInt(data.size_bytes);
  const checksum =
    typeof data.checksum_sha256 === "string" && SHA256_HEX_REGEX.test(data.checksum_sha256)
      ? data.checksum_sha256.toLowerCase()
      : null;
  const replayed = boolVal(data.replayed);
  const uploadUrl = isHttpsPresignedUrl(data.upload.url) ? data.upload.url : null;
  const expiresAt = nonEmptyStr(data.upload.expires_at);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.upload.headers)) {
    if (typeof v !== "string" || k.trim().length === 0) {
      return null;
    }
    headers[k] = v;
  }

  if (
    evidenceId === null ||
    targetKind === null ||
    targetId === null ||
    mimeType === null ||
    sizeBytes === null ||
    sizeBytes > VFIN_UI_EVIDENCE_MAX_BYTES ||
    checksum === null ||
    replayed === null ||
    data.upload.method !== "PUT" ||
    uploadUrl === null ||
    expiresAt === null
  ) {
    return null;
  }

  return {
    evidence_id: evidenceId,
    target_kind: targetKind,
    target_id: targetId,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    checksum_sha256: checksum,
    upload: {
      method: "PUT",
      url: uploadUrl,
      expires_at: expiresAt,
      headers,
    },
    replayed,
  };
}

export function parseEvidenceFinalizeEnvelope(
  envelope: unknown,
): VendorFinanceEvidenceFinalizeResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, ["evidence", "replayed"]) ||
    !isRecord(data.evidence)
  ) {
    return null;
  }
  const ev = data.evidence;
  if (
    !exactKeys(ev, [
      "evidence_id",
      "target_kind",
      "target_id",
      "status",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "finalized_at",
    ]) ||
    (ev.target_kind !== "ENTRY" && ev.target_kind !== "RECONCILIATION") ||
    !isUuidString(ev.target_id)
  ) {
    return null;
  }
  const summary = parseEvidenceSummaryProjection({
    evidence_id: ev.evidence_id,
    status: ev.status,
    mime_type: ev.mime_type,
    size_bytes: ev.size_bytes,
    checksum_sha256: ev.checksum_sha256,
    finalized_at: ev.finalized_at,
  });
  const replayed = boolVal(data.replayed);
  if (!summary || replayed === null) return null;
  return {
    evidence: {
      ...summary,
      target_kind: ev.target_kind,
      target_id: ev.target_id.toLowerCase(),
    },
    replayed,
  };
}

export function parseEvidenceDownloadEnvelope(
  envelope: unknown,
): VendorFinanceEvidenceDownloadResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "evidence_id",
      "target_kind",
      "target_id",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "download",
    ]) ||
    !isRecord(data.download) ||
    !exactKeys(data.download, ["url", "expires_at"])
  ) {
    return null;
  }
  const evidenceId = uuidStr(data.evidence_id);
  const targetKind =
    data.target_kind === "ENTRY" || data.target_kind === "RECONCILIATION"
      ? data.target_kind
      : null;
  const targetId = uuidStr(data.target_id);
  const mimeType =
    data.mime_type === "image/jpeg" || data.mime_type === "image/png" ? data.mime_type : null;
  const sizeBytes = posInt(data.size_bytes);
  const checksum =
    typeof data.checksum_sha256 === "string" && SHA256_HEX_REGEX.test(data.checksum_sha256)
      ? data.checksum_sha256.toLowerCase()
      : null;
  const downloadUrl = isHttpsPresignedUrl(data.download.url) ? data.download.url : null;
  const expiresAt = nonEmptyStr(data.download.expires_at);

  if (
    evidenceId === null ||
    targetKind === null ||
    targetId === null ||
    mimeType === null ||
    sizeBytes === null ||
    sizeBytes > VFIN_UI_EVIDENCE_MAX_BYTES ||
    checksum === null ||
    downloadUrl === null ||
    expiresAt === null
  ) {
    return null;
  }

  return {
    evidence_id: evidenceId,
    target_kind: targetKind,
    target_id: targetId,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    checksum_sha256: checksum,
    download: {
      url: downloadUrl,
      expires_at: expiresAt,
    },
  };
}

// -----------------------------------------------------------------------------
// 7. Sanitized Vietnamese Error Classifier (Fail-Closed, Zero Raw Leaks)
// -----------------------------------------------------------------------------
export type ClassifiedVendorFinanceError = {
  code: string;
  message: string;
  shouldRotateIdempotencyKey: boolean;
  isWholeBatchRollback: boolean;
};

export function extractVendorFinanceErrorCode(payload: unknown): string | null {
  if (!isRecord(payload) || payload.ok !== false) return null;
  if (typeof payload.code === "string" && /^[A-Z0-9_]{3,80}$/.test(payload.code)) {
    return payload.code;
  }
  if (
    isRecord(payload.error) &&
    typeof payload.error.code === "string" &&
    /^[A-Z0-9_]{3,80}$/.test(payload.error.code)
  ) {
    return payload.error.code;
  }
  return null;
}

export function classifyVendorFinanceError(
  payload: unknown,
  httpStatus?: number,
): ClassifiedVendorFinanceError {
  const code = extractVendorFinanceErrorCode(payload) ?? "UNKNOWN_ERROR";

  switch (code as VendorFinanceErrorCode | "NOT_FOUND" | "UNKNOWN_ERROR") {
    case "UNAUTHENTICATED":
      return {
        code,
        message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "ACTOR_NOT_AVAILABLE":
      return {
        code,
        message: "Tài khoản hiện không khả dụng để thực hiện thao tác này.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "CSRF_ORIGIN_DENIED":
      return {
        code,
        message: "Yêu cầu bị từ chối do nguồn gửi không hợp lệ. Vui lòng tải lại trang.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_ACCESS_DENIED":
      return {
        code,
        message: "Bạn không có quyền truy cập phân hệ Tài chính Vendor.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_RECORD_DENIED":
      return {
        code,
        message:
          "Tài khoản của bạn chỉ có quyền xem, không có quyền ghi nhận, hoàn tác hoặc đối soát tài chính Vendor.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "IDEMPOTENCY_KEY_INVALID":
    case "IDEMPOTENCY_KEY_MISMATCH":
    case "VENDOR_FINANCE_IDEMPOTENCY_CONFLICT":
      return {
        code,
        message:
          "Mã chống gửi trùng đã được dùng cho một nội dung khác. Hệ thống đã tạo mã mới, vui lòng kiểm tra lại và gửi lại.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_VENDOR_NOT_FOUND":
    case "VENDOR_FINANCE_VENDOR_INVALID":
      return {
        code,
        message: "Không tìm thấy Vendor hợp lệ trong hệ thống.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN":
      return {
        code,
        message:
          "Vendor đã ngừng hoạt động: chỉ được ghi nhận bút toán tất toán hoặc điều chỉnh cho phép theo quy định.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED":
      return {
        code,
        message:
          "Một hoặc nhiều Vendor trong lô đã phát sinh giao dịch hoặc đã khởi tạo đầu kỳ trước đó. Toàn bộ lô đầu kỳ đã được hủy nguyên vẹn (chưa ghi bất kỳ bút toán nào).",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_ENTRY_NOT_FOUND":
    case "VENDOR_FINANCE_ENTRY_INVALID":
      return {
        code,
        message: "Không tìm thấy bút toán hoặc chứng từ yêu cầu.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_ENTRY_TYPE_INVALID":
      return {
        code,
        message: "Loại bút toán không hợp lệ đối với thao tác này.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_ENTRY_ALREADY_REVERSED":
      return {
        code,
        message: "Bút toán này đã được hoàn tác trước đó; mỗi bút toán chỉ được hoàn tác một lần.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL":
      return {
        code,
        message: "Không thể hoàn tác một bút toán hoàn tác (REVERSAL).",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_AMOUNT_INVALID":
      return {
        code,
        message: "Số tiền không hợp lệ. Vui lòng nhập số nguyên VND đúng quy định.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_AMOUNT_OVERFLOW":
      return {
        code,
        message: "Số tiền hoặc tổng số dư vượt giới hạn an toàn của hệ thống.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_DATE_INVALID":
      return {
        code,
        message: "Ngày hiệu lực hoặc ngày chốt không hợp lệ.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_REASON_INVALID":
      return {
        code,
        message: "Lý do ghi nhận không hợp lệ hoặc vượt quá giới hạn ký tự.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_OPENING_BATCH_INVALID":
      return {
        code,
        message:
          "Dữ liệu lô khởi tạo công nợ đầu kỳ không hợp lệ. Toàn bộ lô đã bị từ chối, chưa có bút toán nào được ghi.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID":
      return {
        code,
        message: `Số lượng dòng trong lô đầu kỳ phải từ 1 đến ${VFIN_UI_MAX_OPENING_BATCH_ITEMS} Vendor. Toàn bộ lô chưa được ghi.`,
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR":
      return {
        code,
        message:
          "Lô khởi tạo có Vendor bị trùng lặp. Toàn bộ lô đã bị từ chối nguyên vẹn, chưa có bút toán nào được ghi.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_OPENING_BATCH_EMPTY":
      return {
        code,
        message:
          "Lô khởi tạo phải có ít nhất một Vendor có số dư lớn hơn 0 ₫. Chưa có bút toán nào được ghi.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_RECONCILIATION_NOT_FOUND":
      return {
        code,
        message: "Không tìm thấy bản ghi đối soát yêu cầu.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID":
    case "VENDOR_FINANCE_EVIDENCE_NOT_FOUND":
      return {
        code,
        message: "Không tìm thấy thông tin ảnh bằng chứng hoặc đối tượng liên kết.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EVIDENCE_MIME_INVALID":
    case "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID":
      return {
        code,
        message: "Tệp tải lên không phải ảnh JPEG hoặc PNG hợp lệ.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID":
      return {
        code,
        message: "Dung lượng ảnh bằng chứng không hợp lệ (tối đa 10 MB).",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID":
      return {
        code,
        message: "Ảnh tải lên không khớp mã kiểm tra toàn vẹn (SHA-256). Vui lòng thử tải lại ảnh.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EVIDENCE_UPLOAD_MISSING":
      return {
        code,
        message: "Ảnh bằng chứng chưa được tải lên kho lưu trữ thành công. Vui lòng bấm Thử tải lại ảnh.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED":
      return {
        code,
        message: "Bút toán hoặc kỳ đối soát này đã có ảnh bằng chứng được xác nhận trước đó.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED":
      return {
        code,
        message: "Phiên tải ảnh bằng chứng đã hết hạn. Vui lòng bấm Thử tải lại ảnh để cấp phiên mới.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_STORAGE_UNAVAILABLE":
      return {
        code,
        message:
          "Kho lưu trữ ảnh bằng chứng tạm thời gián đoạn. Bút toán tiền đã lưu vẫn an toàn; bạn có thể thử tải lại ảnh sau.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_SEARCH_INVALID":
    case "VENDOR_FINANCE_QUERY_INVALID":
    case "VENDOR_FINANCE_CURSOR_INVALID":
      return {
        code,
        message: "Tham số tra cứu hoặc phân trang không hợp lệ.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "CLIENT_AUTHORITY_FIELD_FORBIDDEN":
    case "VENDOR_FINANCE_PAYLOAD_INVALID":
    case "INVALID_JSON":
    case "REQUEST_BODY_TOO_LARGE":
      return {
        code,
        message: "Dữ liệu gửi lên không đúng định dạng quy định của hệ thống.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "NOT_FOUND":
      return {
        code,
        message: "Tính năng hoặc tài nguyên hiện không khả dụng.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_UNAVAILABLE":
    default: {
      if (httpStatus === 401) {
        return {
          code: "UNAUTHENTICATED",
          message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
          shouldRotateIdempotencyKey: false,
          isWholeBatchRollback: false,
        };
      }
      if (httpStatus === 403) {
        return {
          code: "VENDOR_FINANCE_ACCESS_DENIED",
          message: "Bạn không có quyền thực hiện thao tác này.",
          shouldRotateIdempotencyKey: false,
          isWholeBatchRollback: false,
        };
      }
      return {
        code,
        message: "Hệ thống tạm thời gián đoạn hoặc chưa phản hồi hợp lệ. Vui lòng thử lại.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    }
  }
}

// -----------------------------------------------------------------------------
// 8. Browser Evidence File Preflight, SHA-256 & Safe Two-Phase Upload Runner
// -----------------------------------------------------------------------------
export type ClientEvidenceFileLike = {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export function validateEvidenceFilePreflight(file: {
  name?: string;
  type: string;
  size: number;
}):
  | { ok: true; mime_type: VendorFinanceEvidenceMimeType; size_bytes: number }
  | { ok: false; message: string } {
  if (file.type !== "image/jpeg" && file.type !== "image/png") {
    return {
      ok: false,
      message: "Chỉ chấp nhận tệp ảnh bằng chứng định dạng JPEG (.jpg, .jpeg) hoặc PNG (.png).",
    };
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1) {
    return {
      ok: false,
      message: "Tệp ảnh bằng chứng đang rỗng (0 byte). Vui lòng chọn tệp hợp lệ.",
    };
  }
  if (file.size > VFIN_UI_EVIDENCE_MAX_BYTES) {
    return {
      ok: false,
      message: `Ảnh bằng chứng vượt quá giới hạn 10 MB (hiện tại: ${formatFileSizeVi(file.size)}).`,
    };
  }
  return {
    ok: true,
    mime_type: file.type,
    size_bytes: file.size,
  };
}

export async function computeBrowserSha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WEB_CRYPTO_UNAVAILABLE");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export type EvidenceUploadResumeState = {
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  evidence_id: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  upload_url: string;
  upload_headers: Readonly<Record<string, string>>;
  expires_at: string;
  put_completed: boolean;
};

export type EvidenceUploadStepResult =
  | {
      ok: true;
      evidence: VendorFinanceEvidenceSummary;
      replayed: boolean;
    }
  | {
      ok: false;
      stage: "preflight" | "reserve" | "put" | "finalize";
      code: string;
      message: string;
      alreadyAttached: boolean;
      resumeState: EvidenceUploadResumeState | null;
    };

function isReservationStillUsable(expiresAt: string, nowMs: number): boolean {
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return false;
  return parsed > nowMs + 15_000;
}

async function readSafeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Executes `reserve -> PUT -> finalize` strictly against an ALREADY COMMITTED
 * `entry_id` or `reconciliation_id`.
 *
 * Guarantee:
 * - Never calls `POST .../entries` or `POST .../reconciliations`.
 * - If `PUT` or `finalize` fails on a transient error, returns `resumeState` so
 *   retrying can resume or cleanly create a fresh reservation on the same `target_id`
 *   without duplicating or losing the committed money entry.
 */
export async function uploadEvidenceForCommittedTarget(input: {
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  file: ClientEvidenceFileLike;
  resumeState?: EvidenceUploadResumeState | null;
  fetchImpl?: typeof fetch;
  createIdempotencyKey?: () => string;
  nowMs?: () => number;
}): Promise<EvidenceUploadStepResult> {
  const fetchFn = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const makeIdemKey = input.createIdempotencyKey ?? createClientIdempotencyKey;
  const getNowMs = input.nowMs ?? (() => Date.now());

  const preflight = validateEvidenceFilePreflight(input.file);
  if (!preflight.ok) {
    return {
      ok: false,
      stage: "preflight",
      code: "VENDOR_FINANCE_EVIDENCE_MIME_INVALID",
      message: preflight.message,
      alreadyAttached: false,
      resumeState: null,
    };
  }

  let buffer: ArrayBuffer;
  let checksumSha256: string;
  try {
    buffer = await input.file.arrayBuffer();
    if (buffer.byteLength !== preflight.size_bytes) {
      return {
        ok: false,
        stage: "preflight",
        code: "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID",
        message: "Kích thước tệp ảnh đã thay đổi trong lúc đọc. Vui lòng chọn lại tệp ảnh.",
        alreadyAttached: false,
        resumeState: null,
      };
    }
    checksumSha256 = await computeBrowserSha256Hex(buffer);
  } catch {
    return {
      ok: false,
      stage: "preflight",
      code: "WEB_CRYPTO_READ_FAILED",
      message:
        "Trình duyệt không thể đọc hoặc tính mã kiểm tra SHA-256 cho ảnh (yêu cầu kết nối HTTPS an toàn).",
      alreadyAttached: false,
      resumeState: null,
    };
  }

  const normalizedTargetId = input.target_id.toLowerCase();

  const tryFinalize = async (
    state: EvidenceUploadResumeState,
  ): Promise<
    | { kind: "done"; evidence: VendorFinanceEvidenceSummary; replayed: boolean }
    | { kind: "need_fresh_reserve" }
    | { kind: "error"; result: Extract<EvidenceUploadStepResult, { ok: false }> }
  > => {
    const finalizeReq = buildFinalizeEvidenceRequest();
    let finalizeRes: Response;
    try {
      finalizeRes = await fetchFn(buildFinalizeEvidenceUrl(state.evidence_id), {
        method: "POST",
        headers: finalizeReq.headers,
        body: JSON.stringify(finalizeReq.body),
      });
    } catch {
      return {
        kind: "error",
        result: {
          ok: false,
          stage: "finalize",
          code: "NETWORK_ERROR",
          message:
            "Mất kết nối khi xác nhận hoàn tất ảnh bằng chứng. Bút toán đã lưu an toàn; hãy bấm Thử tải lại ảnh.",
          alreadyAttached: false,
          resumeState: state,
        },
      };
    }

    const finalizePayload = await readSafeJson(finalizeRes);
    if (!finalizeRes.ok) {
      const classified = classifyVendorFinanceError(finalizePayload, finalizeRes.status);
      if (
        classified.code === "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED" ||
        classified.code === "VENDOR_FINANCE_EVIDENCE_UPLOAD_MISSING" ||
        classified.code === "VENDOR_FINANCE_EVIDENCE_NOT_FOUND"
      ) {
        return { kind: "need_fresh_reserve" };
      }
      return {
        kind: "error",
        result: {
          ok: false,
          stage: "finalize",
          code: classified.code,
          message: classified.message,
          alreadyAttached: classified.code === "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED",
          resumeState:
            classified.code === "VENDOR_FINANCE_STORAGE_UNAVAILABLE" ||
            classified.code === "VENDOR_FINANCE_UNAVAILABLE"
              ? state
              : null,
        },
      };
    }

    const parsedFinalize = parseEvidenceFinalizeEnvelope(finalizePayload);
    if (!parsedFinalize) {
      return {
        kind: "error",
        result: {
          ok: false,
          stage: "finalize",
          code: "INVALID_RESPONSE",
          message:
            "Phản hồi xác nhận ảnh từ máy chủ không hợp lệ. Vui lòng tải lại dữ liệu trước khi thử lại.",
          alreadyAttached: false,
          resumeState: null,
        },
      };
    }

    return {
      kind: "done",
      evidence: {
        evidence_id: parsedFinalize.evidence.evidence_id,
        status: "READY",
        mime_type: parsedFinalize.evidence.mime_type,
        size_bytes: parsedFinalize.evidence.size_bytes,
        checksum_sha256: parsedFinalize.evidence.checksum_sha256,
        finalized_at: parsedFinalize.evidence.finalized_at,
      },
      replayed: parsedFinalize.replayed,
    };
  };

  const tryPutAndFinalize = async (
    state: EvidenceUploadResumeState,
    allowFallbackReserve: boolean,
  ): Promise<
    | { kind: "done"; evidence: VendorFinanceEvidenceSummary; replayed: boolean }
    | { kind: "need_fresh_reserve" }
    | { kind: "error"; result: Extract<EvidenceUploadStepResult, { ok: false }> }
  > => {
    let currentState = state;
    if (!currentState.put_completed) {
      let putRes: Response;
      try {
        putRes = await fetchFn(currentState.upload_url, {
          method: "PUT",
          headers: currentState.upload_headers,
          body: buffer,
        });
      } catch {
        return {
          kind: "error",
          result: {
            ok: false,
            stage: "put",
            code: "STORAGE_PUT_NETWORK_ERROR",
            message:
              "Tải ảnh lên kho lưu trữ không thành công do lỗi kết nối. Bút toán đã lưu an toàn; hãy bấm Thử tải lại ảnh.",
            alreadyAttached: false,
            resumeState: currentState,
          },
        };
      }

      if (!putRes.ok) {
        if (allowFallbackReserve && (putRes.status === 401 || putRes.status === 403)) {
          return { kind: "need_fresh_reserve" };
        }
        return {
          kind: "error",
          result: {
            ok: false,
            stage: "put",
            code: `STORAGE_PUT_${putRes.status}`,
            message:
              "Kho lưu trữ từ chối hoặc tạm thời lỗi khi nhận tệp ảnh. Bút toán đã lưu an toàn; hãy bấm Thử tải lại ảnh.",
            alreadyAttached: false,
            resumeState: putRes.status >= 500 ? currentState : null,
          },
        };
      }

      currentState = { ...currentState, put_completed: true };
    }

    return tryFinalize(currentState);
  };

  // Attempt resume if same target + same file + non-expired reservation
  const existing = input.resumeState ?? null;
  if (
    existing &&
    existing.target_kind === input.target_kind &&
    existing.target_id === normalizedTargetId &&
    existing.mime_type === preflight.mime_type &&
    existing.size_bytes === preflight.size_bytes &&
    existing.checksum_sha256 === checksumSha256 &&
    isReservationStillUsable(existing.expires_at, getNowMs())
  ) {
    const resumed = await tryPutAndFinalize(existing, true);
    if (resumed.kind === "done") {
      return { ok: true, evidence: resumed.evidence, replayed: resumed.replayed };
    }
    if (resumed.kind === "error") {
      return resumed.result;
    }
    // `need_fresh_reserve`: fall through to reserve a fresh upload slot!
  }

  // Step 1: Reserve a fresh upload slot on the committed `target_id`
  const reserveBuilt = buildReserveEvidenceRequest({
    target_kind: input.target_kind,
    target_id: normalizedTargetId,
    mime_type: preflight.mime_type,
    size_bytes: preflight.size_bytes,
    checksum_sha256: checksumSha256,
    idempotency_key: makeIdemKey(),
  });
  if (!reserveBuilt.ok) {
    return {
      ok: false,
      stage: "reserve",
      code: "VENDOR_FINANCE_PAYLOAD_INVALID",
      message: reserveBuilt.message,
      alreadyAttached: false,
      resumeState: null,
    };
  }

  let reserveRes: Response;
  try {
    reserveRes = await fetchFn(buildReserveEvidenceUrl(), {
      method: "POST",
      headers: reserveBuilt.request.headers,
      body: JSON.stringify(reserveBuilt.request.body),
    });
  } catch {
    return {
      ok: false,
      stage: "reserve",
      code: "NETWORK_ERROR",
      message:
        "Mất kết nối khi khởi tạo phiên tải ảnh bằng chứng. Bút toán đã lưu an toàn; hãy bấm Thử tải lại ảnh.",
      alreadyAttached: false,
      resumeState: null,
    };
  }

  const reservePayload = await readSafeJson(reserveRes);
  if (!reserveRes.ok) {
    const classified = classifyVendorFinanceError(reservePayload, reserveRes.status);
    return {
      ok: false,
      stage: "reserve",
      code: classified.code,
      message: classified.message,
      alreadyAttached: classified.code === "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED",
      resumeState: null,
    };
  }

  const parsedReserve = parseEvidenceReserveEnvelope(reservePayload);
  if (!parsedReserve) {
    return {
      ok: false,
      stage: "reserve",
      code: "INVALID_RESPONSE",
      message: "Phản hồi cấp phiên tải ảnh từ máy chủ không hợp lệ.",
      alreadyAttached: false,
      resumeState: null,
    };
  }

  const freshState: EvidenceUploadResumeState = {
    target_kind: parsedReserve.target_kind,
    target_id: parsedReserve.target_id,
    evidence_id: parsedReserve.evidence_id,
    mime_type: parsedReserve.mime_type,
    size_bytes: parsedReserve.size_bytes,
    checksum_sha256: parsedReserve.checksum_sha256,
    upload_url: parsedReserve.upload.url,
    upload_headers: parsedReserve.upload.headers,
    expires_at: parsedReserve.upload.expires_at,
    put_completed: false,
  };

  // Step 2 & 3: PUT to presigned R2 URL -> Finalize on server
  const freshAttempt = await tryPutAndFinalize(freshState, false);
  if (freshAttempt.kind === "done") {
    return { ok: true, evidence: freshAttempt.evidence, replayed: freshAttempt.replayed };
  }
  if (freshAttempt.kind === "error") {
    return freshAttempt.result;
  }
  return {
    ok: false,
    stage: "finalize",
    code: "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED",
    message: "Phiên tải ảnh bằng chứng đã hết hạn. Vui lòng bấm Thử tải lại ảnh.",
    alreadyAttached: false,
    resumeState: null,
  };
}
