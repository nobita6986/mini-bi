/**
 * VFIN-01 — Canonical Backend/API Contract for Vendor Finance & Debt Management.
 *
 * Principles (docs/plans/vendor-finance-agent-ready-masterplan.md):
 *  - Whole VND stored as `bigint`; API boundary transports money ONLY as canonical
 *    decimal strings (`"0"`, `"1500000"`, `"-500000"`) to avoid `Number.MAX_SAFE_INTEGER` loss.
 *  - Server derives sign (`balance_delta_minor`), `balance_before_minor`, `balance_after_minor`,
 *    `vendor_sequence`, `document_no`, `vendor_display_name_snapshot`, `system_balance_minor`,
 *    `difference_minor`, and actor identity. Client-supplied authority or computed balance/doc
 *    fields are strictly rejected (`CLIENT_AUTHORITY_FIELD_FORBIDDEN`).
 *  - Every response projection is FAIL-CLOSED (`null` on missing/extra/malformed fields) and
 *    never exposes `app_user_id`, `auth_subject`, email, `storage_key`, or raw SQL details.
 */

import { createHash } from "node:crypto";
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";

export const VENDOR_FINANCE_CONTRACT_VERSION = "vendor-finance/1.0" as const;

export const VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI =
  "Chứng từ ghi nhận nội bộ trên hệ thống BI, không phải xác nhận giao dịch ngân hàng hoặc chứng minh tiền đã được chuyển." as const;

export const VENDOR_FINANCE_MAX_REASON_LENGTH = 4000;
export const VENDOR_FINANCE_MAX_SEARCH_LENGTH = 120;
export const VENDOR_FINANCE_MAX_OPENING_BATCH_ITEMS = 200;
export const VENDOR_FINANCE_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB = 10_485_760
export const VENDOR_FINANCE_EVIDENCE_UPLOAD_URL_TTL_SECONDS = 300;
export const VENDOR_FINANCE_EVIDENCE_DOWNLOAD_URL_TTL_SECONDS = 120;

export const PG_BIGINT_MAX = BigInt("9223372036854775807");
export const PG_BIGINT_MIN = BigInt("-9223372036854775808");
const ZERO_BIGINT = BigInt(0);
const ONE_BIGINT = BigInt(1);

export const VENDOR_FINANCE_ENTRY_TYPES = [
  "OPENING_PAYABLE",
  "OPENING_ADVANCE",
  "DEBT_RECORDED",
  "PAYROLL_RECORDED",
  "PAYMENT_RECORDED",
  "ADVANCE_RECORDED",
  "ADJUSTMENT_INCREASE",
  "ADJUSTMENT_DECREASE",
  "REVERSAL",
] as const;

export type VendorFinanceEntryType = (typeof VENDOR_FINANCE_ENTRY_TYPES)[number];

export const NORMAL_VENDOR_FINANCE_ENTRY_TYPES = [
  "DEBT_RECORDED",
  "PAYROLL_RECORDED",
  "PAYMENT_RECORDED",
  "ADVANCE_RECORDED",
  "ADJUSTMENT_INCREASE",
  "ADJUSTMENT_DECREASE",
] as const;

export type NormalVendorFinanceEntryType = (typeof NORMAL_VENDOR_FINANCE_ENTRY_TYPES)[number];

export const OPENING_VENDOR_FINANCE_ENTRY_TYPES = [
  "OPENING_PAYABLE",
  "OPENING_ADVANCE",
] as const;

export type OpeningVendorFinanceEntryType = (typeof OPENING_VENDOR_FINANCE_ENTRY_TYPES)[number];

export const VENDOR_FINANCE_DOCUMENT_KINDS = [
  "PAYROLL_VOUCHER",
  "PAYMENT_VOUCHER",
  "ADVANCE_VOUCHER",
  "DEBT_ADJUSTMENT_VOUCHER",
  "OPENING_BALANCE_VOUCHER",
] as const;

export type VendorFinanceDocumentKind = (typeof VENDOR_FINANCE_DOCUMENT_KINDS)[number];

export const VENDOR_FINANCE_EVIDENCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
] as const;

export type VendorFinanceEvidenceMimeType = (typeof VENDOR_FINANCE_EVIDENCE_MIME_TYPES)[number];

export const VENDOR_FINANCE_EVIDENCE_TARGET_KINDS = [
  "ENTRY",
  "RECONCILIATION",
] as const;

export type VendorFinanceEvidenceTargetKind = (typeof VENDOR_FINANCE_EVIDENCE_TARGET_KINDS)[number];

export type VendorFinanceBalanceDirection = "PAYABLE" | "BALANCED" | "ADVANCE";
export type VendorFinanceActiveFilter = "all" | "active" | "inactive";
export type VendorFinanceBalanceFilter =
  | "all"
  | "payable"
  | "advance"
  | "nonzero"
  | "uninitialized";

export type VendorFinanceAuthoritySource =
  | "full_admin"
  | "accounting_department"
  | "direct_grant_record"
  | "direct_grant_view"
  | "none";

export type VendorFinanceErrorCode =
  | "UNAUTHENTICATED"
  | "ACTOR_NOT_AVAILABLE"
  | "CSRF_ORIGIN_DENIED"
  | "CLIENT_AUTHORITY_FIELD_FORBIDDEN"
  | "REQUEST_BODY_TOO_LARGE"
  | "INVALID_JSON"
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_KEY_MISMATCH"
  | "VENDOR_FINANCE_ACCESS_DENIED"
  | "VENDOR_FINANCE_RECORD_DENIED"
  | "VENDOR_FINANCE_QUERY_INVALID"
  | "VENDOR_FINANCE_SEARCH_INVALID"
  | "VENDOR_FINANCE_CURSOR_INVALID"
  | "VENDOR_FINANCE_PAYLOAD_INVALID"
  | "VENDOR_FINANCE_VENDOR_INVALID"
  | "VENDOR_FINANCE_VENDOR_NOT_FOUND"
  | "VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN"
  | "VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED"
  | "VENDOR_FINANCE_ENTRY_INVALID"
  | "VENDOR_FINANCE_ENTRY_NOT_FOUND"
  | "VENDOR_FINANCE_ENTRY_TYPE_INVALID"
  | "VENDOR_FINANCE_ENTRY_ALREADY_REVERSED"
  | "VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL"
  | "VENDOR_FINANCE_AMOUNT_INVALID"
  | "VENDOR_FINANCE_AMOUNT_OVERFLOW"
  | "VENDOR_FINANCE_DATE_INVALID"
  | "VENDOR_FINANCE_REASON_INVALID"
  | "VENDOR_FINANCE_OPENING_BATCH_INVALID"
  | "VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID"
  | "VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR"
  | "VENDOR_FINANCE_OPENING_BATCH_EMPTY"
  | "VENDOR_FINANCE_RECONCILIATION_NOT_FOUND"
  | "VENDOR_FINANCE_IDEMPOTENCY_CONFLICT"
  | "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID"
  | "VENDOR_FINANCE_EVIDENCE_NOT_FOUND"
  | "VENDOR_FINANCE_EVIDENCE_MIME_INVALID"
  | "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID"
  | "VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID"
  | "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID"
  | "VENDOR_FINANCE_EVIDENCE_UPLOAD_MISSING"
  | "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED"
  | "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED"
  | "VENDOR_FINANCE_STORAGE_UNAVAILABLE"
  | "VENDOR_FINANCE_UNAVAILABLE";

export function vendorFinanceHttpStatusForError(code: VendorFinanceErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "ACTOR_NOT_AVAILABLE":
    case "CSRF_ORIGIN_DENIED":
    case "VENDOR_FINANCE_ACCESS_DENIED":
    case "VENDOR_FINANCE_RECORD_DENIED":
      return 403;
    case "CLIENT_AUTHORITY_FIELD_FORBIDDEN":
    case "INVALID_JSON":
    case "IDEMPOTENCY_KEY_INVALID":
    case "IDEMPOTENCY_KEY_MISMATCH":
    case "VENDOR_FINANCE_QUERY_INVALID":
    case "VENDOR_FINANCE_SEARCH_INVALID":
    case "VENDOR_FINANCE_CURSOR_INVALID":
    case "VENDOR_FINANCE_VENDOR_INVALID":
    case "VENDOR_FINANCE_ENTRY_INVALID":
    case "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID":
      return 400;
    case "VENDOR_FINANCE_VENDOR_NOT_FOUND":
    case "VENDOR_FINANCE_ENTRY_NOT_FOUND":
    case "VENDOR_FINANCE_RECONCILIATION_NOT_FOUND":
    case "VENDOR_FINANCE_EVIDENCE_NOT_FOUND":
      return 404;
    case "VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN":
    case "VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED":
    case "VENDOR_FINANCE_ENTRY_ALREADY_REVERSED":
    case "VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL":
    case "VENDOR_FINANCE_IDEMPOTENCY_CONFLICT":
    case "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED":
    case "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED":
      return 409;
    case "REQUEST_BODY_TOO_LARGE":
      return 413;
    case "VENDOR_FINANCE_PAYLOAD_INVALID":
    case "VENDOR_FINANCE_ENTRY_TYPE_INVALID":
    case "VENDOR_FINANCE_AMOUNT_INVALID":
    case "VENDOR_FINANCE_AMOUNT_OVERFLOW":
    case "VENDOR_FINANCE_DATE_INVALID":
    case "VENDOR_FINANCE_REASON_INVALID":
    case "VENDOR_FINANCE_OPENING_BATCH_INVALID":
    case "VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID":
    case "VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR":
    case "VENDOR_FINANCE_OPENING_BATCH_EMPTY":
    case "VENDOR_FINANCE_EVIDENCE_MIME_INVALID":
    case "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID":
    case "VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID":
    case "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID":
    case "VENDOR_FINANCE_EVIDENCE_UPLOAD_MISSING":
      return 422;
    case "VENDOR_FINANCE_STORAGE_UNAVAILABLE":
    case "VENDOR_FINANCE_UNAVAILABLE":
      return 503;
  }
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VENDOR_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DOCUMENT_NO_REGEX = /^VFIN-[0-9]{4}-[0-9]{6,}$/;
const POSITIVE_DECIMAL_REGEX = /^[1-9][0-9]{0,18}$/;
const SIGNED_DECIMAL_REGEX = /^-?(?:0|[1-9][0-9]{0,18})$/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const FORBIDDEN_TEXT_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const FORBIDDEN_SINGLE_LINE_CONTROL_CHARS = /[\x00-\x1F\x7F]/;

const FORBIDDEN_COMPUTED_FINANCE_FIELDS = new Set([
  "balancedelta",
  "balancedeltaminor",
  "balancebefore",
  "balancebeforeminor",
  "balanceafter",
  "balanceafterminor",
  "currentbalance",
  "currentbalanceminor",
  "documentno",
  "vendorsequence",
  "vendordisplaynamesnapshot",
  "systembalance",
  "systembalanceminor",
  "differenceminor",
  "ledgersequenceatreconciliation",
  "createdbydisplayname",
  "createdbydisplaynamesnapshot",
  "authoritysource",
  "storagekey",
  "openingbatchid",
  "reversesentryid",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

function allowedKeysOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function normalizeFieldKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function containsForbiddenFinanceField(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenFinanceField(item, depth + 1));
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_COMPUTED_FINANCE_FIELDS.has(normalizeFieldKey(key))) {
      return true;
    }
    if (containsForbiddenFinanceField(child, depth + 1)) {
      return true;
    }
  }
  return false;
}

export function checkForbiddenVendorFinanceClientFields(
  payload: unknown,
): { ok: true } | { ok: false; code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" } {
  const baseCheck = validateClientBusinessPayload(payload);
  if (!baseCheck.ok) {
    return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
  }
  if (containsForbiddenFinanceField(payload)) {
    return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
  }
  return { ok: true };
}

export function isCanonicalVendorId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "__system_vendor__" &&
    VENDOR_ID_REGEX.test(value)
  );
}

export function parseVendorIdParam(
  raw: unknown,
): { ok: true; vendor_id: string } | { ok: false; code: "VENDOR_FINANCE_VENDOR_INVALID" } {
  if (!isCanonicalVendorId(raw)) {
    return { ok: false, code: "VENDOR_FINANCE_VENDOR_INVALID" };
  }
  return { ok: true, vendor_id: raw };
}

export function parseUuidParam<TCode extends VendorFinanceErrorCode>(
  raw: unknown,
  errorCode: TCode,
): { ok: true; id: string } | { ok: false; code: TCode } {
  if (typeof raw !== "string" || !UUID_REGEX.test(raw)) {
    return { ok: false, code: errorCode };
  }
  return { ok: true, id: raw.toLowerCase() };
}

/**
 * Parses a positive whole-VND decimal string (`"1"` .. `"9223372036854775807"`).
 * Rejects numbers/floats, `"0"`, negatives, leading `+` or `0`, scientific notation, and `bigint` overflow.
 */
export function parsePositiveMinorAmount(
  value: unknown,
):
  | { ok: true; canonical: string; value: bigint }
  | { ok: false; code: "VENDOR_FINANCE_AMOUNT_INVALID" | "VENDOR_FINANCE_AMOUNT_OVERFLOW" } {
  if (typeof value !== "string" || !POSITIVE_DECIMAL_REGEX.test(value)) {
    // Distinguish pure positive integer strings with >= 19 digits that overflow int8.
    if (typeof value === "string" && /^[1-9][0-9]{19,}$/.test(value)) {
      return { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" };
    }
    return { ok: false, code: "VENDOR_FINANCE_AMOUNT_INVALID" };
  }
  const parsed = BigInt(value);
  if (parsed < ONE_BIGINT || parsed > PG_BIGINT_MAX) {
    return { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" };
  }
  return { ok: true, canonical: parsed.toString(), value: parsed };
}

/**
 * Parses a non-negative whole-VND decimal string (`"0"` .. `"9223372036854775807"`)
 * used ONLY by opening balance batch rows where `"0"` is skipped per §4.2.
 */
export function parseNonNegativeMinorAmount(
  value: unknown,
):
  | { ok: true; canonical: string; value: bigint }
  | { ok: false; code: "VENDOR_FINANCE_AMOUNT_INVALID" | "VENDOR_FINANCE_AMOUNT_OVERFLOW" } {
  if (value === "0") {
    return { ok: true, canonical: "0", value: ZERO_BIGINT };
  }
  return parsePositiveMinorAmount(value);
}

/**
 * Parses a signed whole-VND decimal string (`"-9223372036854775808"` .. `"9223372036854775807"`)
 * used for reconciliation `confirmed_balance_minor` and response projections.
 */
export function parseSignedMinorAmount(
  value: unknown,
):
  | { ok: true; canonical: string; value: bigint }
  | { ok: false; code: "VENDOR_FINANCE_AMOUNT_INVALID" | "VENDOR_FINANCE_AMOUNT_OVERFLOW" } {
  if (typeof value !== "string" || value === "-0") {
    return { ok: false, code: "VENDOR_FINANCE_AMOUNT_INVALID" };
  }
  if (!SIGNED_DECIMAL_REGEX.test(value)) {
    if (/^-?[1-9][0-9]{19,}$/.test(value)) {
      return { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" };
    }
    return { ok: false, code: "VENDOR_FINANCE_AMOUNT_INVALID" };
  }
  const parsed = BigInt(value);
  if (parsed < PG_BIGINT_MIN || parsed > PG_BIGINT_MAX) {
    return { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" };
  }
  return { ok: true, canonical: parsed.toString(), value: parsed };
}

export function parseReasonText(
  value: unknown,
): { ok: true; reason: string } | { ok: false; code: "VENDOR_FINANCE_REASON_INVALID" } {
  if (typeof value !== "string") {
    return { ok: false, code: "VENDOR_FINANCE_REASON_INVALID" };
  }
  const trimmed = value.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > VENDOR_FINANCE_MAX_REASON_LENGTH ||
    FORBIDDEN_TEXT_CONTROL_CHARS.test(trimmed)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_REASON_INVALID" };
  }
  return { ok: true, reason: trimmed };
}

export function parseBusinessCalendarDate(
  value: unknown,
): { ok: true; date: string } | { ok: false; code: "VENDOR_FINANCE_DATE_INVALID" } {
  if (typeof value !== "string" || !isRealCalendarDate(value)) {
    return { ok: false, code: "VENDOR_FINANCE_DATE_INVALID" };
  }
  const year = Number(value.slice(0, 4));
  if (!Number.isInteger(year) || year < 1970 || year > 2999) {
    return { ok: false, code: "VENDOR_FINANCE_DATE_INVALID" };
  }
  return { ok: true, date: value };
}

export function resolveIdempotencyKey(
  headerValue: string | null,
  bodyValue: unknown,
):
  | { ok: true; idempotency_key: string }
  | { ok: false; code: "IDEMPOTENCY_KEY_INVALID" | "IDEMPOTENCY_KEY_MISMATCH" } {
  if (typeof bodyValue !== "string" || !UUID_REGEX.test(bodyValue)) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }
  const normalizedBody = bodyValue.toLowerCase();
  if (headerValue !== null) {
    const trimmedHeader = headerValue.trim();
    if (!UUID_REGEX.test(trimmedHeader)) {
      return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
    }
    if (trimmedHeader.toLowerCase() !== normalizedBody) {
      return { ok: false, code: "IDEMPOTENCY_KEY_MISMATCH" };
    }
  }
  return { ok: true, idempotency_key: normalizedBody };
}

// -----------------------------------------------------------------------------
// Keyset cursor codec (`GET /api/vendor-finance/vendors/[vendorId]/entries`)
// -----------------------------------------------------------------------------
export function encodeVendorEntriesCursor(input: {
  vendor_id: string;
  before_sequence: number;
}): string {
  const payload = JSON.stringify({
    v: 1,
    vendor_id: input.vendor_id,
    before_sequence: input.before_sequence,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeVendorEntriesCursor(
  rawCursor: string,
  expectedVendorId: string,
):
  | { ok: true; before_sequence: number }
  | { ok: false; code: "VENDOR_FINANCE_CURSOR_INVALID" } {
  if (
    typeof rawCursor !== "string" ||
    rawCursor.length < 4 ||
    rawCursor.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(rawCursor)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_CURSOR_INVALID" };
  }
  try {
    const decodedText = Buffer.from(rawCursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decodedText);
    if (
      !isRecord(parsed) ||
      !exactKeys(parsed, ["v", "vendor_id", "before_sequence"]) ||
      parsed.v !== 1 ||
      parsed.vendor_id !== expectedVendorId ||
      typeof parsed.before_sequence !== "number" ||
      !Number.isSafeInteger(parsed.before_sequence) ||
      parsed.before_sequence < 1
    ) {
      return { ok: false, code: "VENDOR_FINANCE_CURSOR_INVALID" };
    }
    return { ok: true, before_sequence: parsed.before_sequence };
  } catch {
    return { ok: false, code: "VENDOR_FINANCE_CURSOR_INVALID" };
  }
}

// -----------------------------------------------------------------------------
// Query & Mutation Request Parsers
// -----------------------------------------------------------------------------
export type ListVendorFinanceVendorsQuery = {
  search: string | null;
  active: VendorFinanceActiveFilter;
  balance_filter: VendorFinanceBalanceFilter;
  page: number;
  page_size: number;
};

const LIST_VENDORS_QUERY_KEYS = [
  "search",
  "active",
  "balance_filter",
  "page",
  "page_size",
] as const;

function parseBoundedIntParam(
  raw: string | null,
  defaultValue: number,
  min: number,
  max: number,
): number | null {
  if (raw === null) return defaultValue;
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

export function parseListVendorFinanceVendorsQuery(
  url: URL,
):
  | { ok: true; value: ListVendorFinanceVendorsQuery }
  | { ok: false; code: "VENDOR_FINANCE_QUERY_INVALID" | "VENDOR_FINANCE_SEARCH_INVALID" } {
  const allowed = new Set<string>(LIST_VENDORS_QUERY_KEYS);
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || seen.has(key)) {
      return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
    }
    seen.add(key);
    if (url.searchParams.getAll(key).length > 1) {
      return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
    }
  }

  let search: string | null = null;
  const rawSearch = url.searchParams.get("search");
  if (rawSearch !== null) {
    const trimmed = rawSearch.trim();
    if (trimmed.length > 0) {
      if (
        trimmed.length > VENDOR_FINANCE_MAX_SEARCH_LENGTH ||
        FORBIDDEN_SINGLE_LINE_CONTROL_CHARS.test(trimmed)
      ) {
        return { ok: false, code: "VENDOR_FINANCE_SEARCH_INVALID" };
      }
      search = trimmed;
    }
  }

  const rawActive = url.searchParams.get("active") ?? "all";
  if (rawActive !== "all" && rawActive !== "active" && rawActive !== "inactive") {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  const rawBalance = url.searchParams.get("balance_filter") ?? "all";
  if (
    rawBalance !== "all" &&
    rawBalance !== "payable" &&
    rawBalance !== "advance" &&
    rawBalance !== "nonzero" &&
    rawBalance !== "uninitialized"
  ) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  const page = parseBoundedIntParam(url.searchParams.get("page"), 1, 1, 1000);
  const pageSize = parseBoundedIntParam(url.searchParams.get("page_size"), 25, 1, 100);
  if (page === null || pageSize === null) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  return {
    ok: true,
    value: {
      search,
      active: rawActive,
      balance_filter: rawBalance,
      page,
      page_size: pageSize,
    },
  };
}

export function parseNoQueryParams(
  url: URL,
): { ok: true } | { ok: false; code: "VENDOR_FINANCE_QUERY_INVALID" } {
  for (const _key of url.searchParams.keys()) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }
  return { ok: true };
}

export type ListVendorFinanceEntriesQuery = {
  before_sequence: number | null;
  entry_type: VendorFinanceEntryType | null;
  page_size: number;
};

export function parseListVendorFinanceEntriesQuery(
  url: URL,
  vendorId: string,
):
  | { ok: true; value: ListVendorFinanceEntriesQuery }
  | {
      ok: false;
      code:
        | "VENDOR_FINANCE_QUERY_INVALID"
        | "VENDOR_FINANCE_CURSOR_INVALID"
        | "VENDOR_FINANCE_ENTRY_TYPE_INVALID";
    } {
  const allowed = new Set(["cursor", "entry_type", "page_size"]);
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || seen.has(key)) {
      return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
    }
    seen.add(key);
    if (url.searchParams.getAll(key).length > 1) {
      return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
    }
  }

  let beforeSequence: number | null = null;
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor !== null && rawCursor !== "") {
    const decoded = decodeVendorEntriesCursor(rawCursor, vendorId);
    if (!decoded.ok) return decoded;
    beforeSequence = decoded.before_sequence;
  }

  let entryType: VendorFinanceEntryType | null = null;
  const rawEntryType = url.searchParams.get("entry_type");
  if (rawEntryType !== null && rawEntryType !== "") {
    if (!(VENDOR_FINANCE_ENTRY_TYPES as readonly string[]).includes(rawEntryType)) {
      return { ok: false, code: "VENDOR_FINANCE_ENTRY_TYPE_INVALID" };
    }
    entryType = rawEntryType as VendorFinanceEntryType;
  }

  const pageSize = parseBoundedIntParam(url.searchParams.get("page_size"), 25, 1, 100);
  if (pageSize === null) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  return {
    ok: true,
    value: {
      before_sequence: beforeSequence,
      entry_type: entryType,
      page_size: pageSize,
    },
  };
}

export function parseListVendorReconciliationsQuery(
  url: URL,
):
  | { ok: true; value: { page: number; page_size: number } }
  | { ok: false; code: "VENDOR_FINANCE_QUERY_INVALID" } {
  const allowed = new Set(["page", "page_size"]);
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || seen.has(key)) {
      return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
    }
    seen.add(key);
    if (url.searchParams.getAll(key).length > 1) {
      return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
    }
  }
  const page = parseBoundedIntParam(url.searchParams.get("page"), 1, 1, 1000);
  const pageSize = parseBoundedIntParam(url.searchParams.get("page_size"), 25, 1, 100);
  if (page === null || pageSize === null) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }
  return { ok: true, value: { page, page_size: pageSize } };
}

// 1. Record Normal Entry (`POST /api/vendor-finance/vendors/[vendorId]/entries`)
export type RecordVendorFinanceEntryBody = {
  entry_type: NormalVendorFinanceEntryType;
  amount_minor: string;
  effective_date: string;
  reason: string;
  idempotency_key: string;
};

export function parseRecordVendorFinanceEntryBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: RecordVendorFinanceEntryBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !exactKeys(body, [
      "entry_type",
      "amount_minor",
      "effective_date",
      "reason",
      "idempotency_key",
    ])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  if (
    typeof body.entry_type !== "string" ||
    !(NORMAL_VENDOR_FINANCE_ENTRY_TYPES as readonly string[]).includes(body.entry_type)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_ENTRY_TYPE_INVALID" };
  }

  const amount = parsePositiveMinorAmount(body.amount_minor);
  if (!amount.ok) return amount;

  const effectiveDate = parseBusinessCalendarDate(body.effective_date);
  if (!effectiveDate.ok) return effectiveDate;

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      entry_type: body.entry_type as NormalVendorFinanceEntryType,
      amount_minor: amount.canonical,
      effective_date: effectiveDate.date,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

// 2. Reverse Entry (`POST /api/vendor-finance/entries/[entryId]/reverse`)
export type ReverseVendorFinanceEntryBody = {
  effective_date: string | null;
  reason: string;
  idempotency_key: string;
};

export function parseReverseVendorFinanceEntryBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: ReverseVendorFinanceEntryBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !allowedKeysOnly(body, ["effective_date", "reason", "idempotency_key"]) ||
    !("reason" in body) ||
    !("idempotency_key" in body)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  let effectiveDate: string | null = null;
  if (body.effective_date !== undefined && body.effective_date !== null) {
    const parsedDate = parseBusinessCalendarDate(body.effective_date);
    if (!parsedDate.ok) return parsedDate;
    effectiveDate = parsedDate.date;
  }

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      effective_date: effectiveDate,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

// 3. Opening Balance Preview & Apply (`POST /api/vendor-finance/opening-batches/preview` & `/apply`)
export type OpeningBatchItemInput = {
  vendor_id: string;
  entry_type: OpeningVendorFinanceEntryType;
  amount_minor: string;
};

export type PreviewOpeningBatchBody = {
  cutoff_date: string;
  items: readonly OpeningBatchItemInput[];
};

export type ApplyOpeningBatchBody = {
  cutoff_date: string;
  items: readonly OpeningBatchItemInput[];
  reason: string;
  idempotency_key: string;
};

function parseOpeningBatchItems(
  rawItems: unknown,
):
  | { ok: true; items: OpeningBatchItemInput[] }
  | { ok: false; code: VendorFinanceErrorCode } {
  if (!Array.isArray(rawItems)) {
    return { ok: false, code: "VENDOR_FINANCE_OPENING_BATCH_INVALID" };
  }
  if (rawItems.length < 1 || rawItems.length > VENDOR_FINANCE_MAX_OPENING_BATCH_ITEMS) {
    return { ok: false, code: "VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID" };
  }

  const seenVendors = new Set<string>();
  const items: OpeningBatchItemInput[] = [];
  let nonZeroCount = 0;

  for (const rawItem of rawItems) {
    if (!isRecord(rawItem) || !exactKeys(rawItem, ["vendor_id", "entry_type", "amount_minor"])) {
      return { ok: false, code: "VENDOR_FINANCE_OPENING_BATCH_INVALID" };
    }
    if (!isCanonicalVendorId(rawItem.vendor_id)) {
      return { ok: false, code: "VENDOR_FINANCE_VENDOR_INVALID" };
    }
    if (seenVendors.has(rawItem.vendor_id)) {
      return { ok: false, code: "VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR" };
    }
    seenVendors.add(rawItem.vendor_id);

    if (
      typeof rawItem.entry_type !== "string" ||
      !(OPENING_VENDOR_FINANCE_ENTRY_TYPES as readonly string[]).includes(rawItem.entry_type)
    ) {
      return { ok: false, code: "VENDOR_FINANCE_ENTRY_TYPE_INVALID" };
    }

    const amount = parseNonNegativeMinorAmount(rawItem.amount_minor);
    if (!amount.ok) return amount;
    if (amount.value > ZERO_BIGINT) {
      nonZeroCount += 1;
    }

    items.push({
      vendor_id: rawItem.vendor_id,
      entry_type: rawItem.entry_type as OpeningVendorFinanceEntryType,
      amount_minor: amount.canonical,
    });
  }

  if (nonZeroCount === 0) {
    return { ok: false, code: "VENDOR_FINANCE_OPENING_BATCH_EMPTY" };
  }

  return { ok: true, items };
}

export function parsePreviewOpeningBatchBody(
  body: unknown,
):
  | { ok: true; value: PreviewOpeningBatchBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (!isRecord(body) || !exactKeys(body, ["cutoff_date", "items"])) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  const cutoffDate = parseBusinessCalendarDate(body.cutoff_date);
  if (!cutoffDate.ok) return cutoffDate;

  const items = parseOpeningBatchItems(body.items);
  if (!items.ok) return items;

  return {
    ok: true,
    value: {
      cutoff_date: cutoffDate.date,
      items: items.items,
    },
  };
}

export function parseApplyOpeningBatchBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: ApplyOpeningBatchBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !exactKeys(body, ["cutoff_date", "items", "reason", "idempotency_key"])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  const cutoffDate = parseBusinessCalendarDate(body.cutoff_date);
  if (!cutoffDate.ok) return cutoffDate;

  const items = parseOpeningBatchItems(body.items);
  if (!items.ok) return items;

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      cutoff_date: cutoffDate.date,
      items: items.items,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

// 4. Create Reconciliation (`POST /api/vendor-finance/vendors/[vendorId]/reconciliations`)
export type CreateVendorReconciliationBody = {
  as_of_date: string;
  confirmed_balance_minor: string;
  reason: string;
  idempotency_key: string;
};

export function parseCreateVendorReconciliationBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: CreateVendorReconciliationBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !exactKeys(body, [
      "as_of_date",
      "confirmed_balance_minor",
      "reason",
      "idempotency_key",
    ])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  const asOfDate = parseBusinessCalendarDate(body.as_of_date);
  if (!asOfDate.ok) return asOfDate;

  const confirmed = parseSignedMinorAmount(body.confirmed_balance_minor);
  if (!confirmed.ok) return confirmed;

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      as_of_date: asOfDate.date,
      confirmed_balance_minor: confirmed.canonical,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

// 5. Evidence Reserve & Finalize (`POST /api/vendor-finance/evidence/reserve` & `/finalize`)
export type ReserveVendorFinanceEvidenceBody = {
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  idempotency_key: string;
};

export function parseReserveVendorFinanceEvidenceBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: ReserveVendorFinanceEvidenceBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !exactKeys(body, [
      "target_kind",
      "target_id",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "idempotency_key",
    ])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  if (
    typeof body.target_kind !== "string" ||
    !(VENDOR_FINANCE_EVIDENCE_TARGET_KINDS as readonly string[]).includes(body.target_kind) ||
    typeof body.target_id !== "string" ||
    !UUID_REGEX.test(body.target_id)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID" };
  }

  if (
    typeof body.mime_type !== "string" ||
    !(VENDOR_FINANCE_EVIDENCE_MIME_TYPES as readonly string[]).includes(body.mime_type)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_MIME_INVALID" };
  }

  if (
    typeof body.size_bytes !== "number" ||
    !Number.isSafeInteger(body.size_bytes) ||
    body.size_bytes < 1 ||
    body.size_bytes > VENDOR_FINANCE_EVIDENCE_MAX_BYTES
  ) {
    return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID" };
  }

  if (typeof body.checksum_sha256 !== "string" || !SHA256_HEX_REGEX.test(body.checksum_sha256)) {
    return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID" };
  }

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      target_kind: body.target_kind as VendorFinanceEvidenceTargetKind,
      target_id: body.target_id.toLowerCase(),
      mime_type: body.mime_type as VendorFinanceEvidenceMimeType,
      size_bytes: body.size_bytes,
      checksum_sha256: body.checksum_sha256.toLowerCase(),
      idempotency_key: idem.idempotency_key,
    },
  };
}

export function parseFinalizeVendorFinanceEvidenceBody(
  body: unknown,
): { ok: true } | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (!isRecord(body) || !exactKeys(body, [])) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }
  return { ok: true };
}

// -----------------------------------------------------------------------------
// Deterministic SHA-256 Request Fingerprints
// -----------------------------------------------------------------------------
function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function computeRecordEntryFingerprint(input: {
  vendor_id: string;
  entry_type: NormalVendorFinanceEntryType;
  amount_minor: string;
  effective_date: string;
  reason: string;
}): string {
  return sha256Json({
    op: "RECORD_ENTRY",
    vendor_id: input.vendor_id,
    entry_type: input.entry_type,
    amount_minor: input.amount_minor,
    effective_date: input.effective_date,
    reason: input.reason,
  });
}

export function computeReverseEntryFingerprint(input: {
  entry_id: string;
  effective_date: string | null;
  reason: string;
}): string {
  return sha256Json({
    op: "REVERSE_ENTRY",
    entry_id: input.entry_id,
    effective_date: input.effective_date,
    reason: input.reason,
  });
}

export function computeApplyOpeningBatchFingerprint(input: {
  cutoff_date: string;
  items: readonly OpeningBatchItemInput[];
  reason: string;
}): string {
  const normalizedItems = [...input.items]
    .filter((item) => item.amount_minor !== "0")
    .sort((a, b) => a.vendor_id.localeCompare(b.vendor_id))
    .map((item) => ({
      vendor_id: item.vendor_id,
      entry_type: item.entry_type,
      amount_minor: item.amount_minor,
    }));
  return sha256Json({
    op: "APPLY_OPENING_BATCH",
    cutoff_date: input.cutoff_date,
    items: normalizedItems,
    reason: input.reason,
  });
}

export function computeCreateReconciliationFingerprint(input: {
  vendor_id: string;
  as_of_date: string;
  confirmed_balance_minor: string;
  reason: string;
}): string {
  return sha256Json({
    op: "CREATE_RECONCILIATION",
    vendor_id: input.vendor_id,
    as_of_date: input.as_of_date,
    confirmed_balance_minor: input.confirmed_balance_minor,
    reason: input.reason,
  });
}

export function computeReserveEvidenceFingerprint(input: {
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
}): string {
  return sha256Json({
    op: "RESERVE_EVIDENCE",
    target_kind: input.target_kind,
    target_id: input.target_id,
    mime_type: input.mime_type,
    size_bytes: input.size_bytes,
    checksum_sha256: input.checksum_sha256,
  });
}

// -----------------------------------------------------------------------------
// Fail-Closed Response Projections (Server -> Client Contract)
// -----------------------------------------------------------------------------
export type VendorFinanceActorAccessProjection = {
  authorization_date: string;
  can_view: boolean;
  can_record: boolean;
  authority_source: VendorFinanceAuthoritySource;
};

export type VendorFinanceEvidenceSummary = {
  evidence_id: string;
  status: "READY";
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  finalized_at: string;
};

export type VendorFinanceEntryProjection = {
  entry_id: string;
  vendor_id: string;
  vendor_display_name_snapshot: string;
  vendor_active: boolean;
  vendor_sequence: number;
  document_no: string;
  document_kind: VendorFinanceDocumentKind;
  document_title_vi: string;
  entry_type: VendorFinanceEntryType;
  amount_minor: string;
  balance_before_minor: string;
  balance_delta_minor: string;
  balance_after_minor: string;
  effective_date: string;
  reason: string;
  opening_batch_id: string | null;
  reverses_entry_id: string | null;
  reverses_document_no: string | null;
  reversed_by_entry_id: string | null;
  reversed_by_document_no: string | null;
  can_reverse: boolean;
  can_attach_evidence: boolean;
  evidence: VendorFinanceEvidenceSummary | null;
  created_by_display_name: string;
  created_at: string;
  internal_disclaimer: string;
};

export type VendorFinanceReconciliationProjection = {
  reconciliation_id: string;
  vendor_id: string;
  as_of_date: string;
  system_balance_minor: string;
  confirmed_balance_minor: string;
  difference_minor: string;
  ledger_sequence_at_reconciliation: number;
  reason: string;
  can_attach_evidence: boolean;
  evidence: VendorFinanceEvidenceSummary | null;
  created_by_display_name: string;
  created_at: string;
};

export type VendorFinanceCompanySummary = {
  total_payable_minor: string;
  total_advance_minor: string;
  net_balance_minor: string;
  vendors_with_payable_count: number;
  vendors_with_advance_count: number;
  vendors_with_nonzero_balance_count: number;
  total_vendor_count: number;
  uninitialized_vendor_count: number;
};

export type VendorFinanceListItem = {
  vendor_id: string;
  display_name: string;
  active: boolean;
  current_balance_minor: string;
  balance_direction: VendorFinanceBalanceDirection;
  entry_count: number;
  has_opening_entry: boolean;
  eligible_for_opening: boolean;
  last_effective_date: string | null;
  last_entry_at: string | null;
  last_reconciled_as_of_date: string | null;
};

export type VendorFinanceVendorListResponse = {
  authorization_date: string;
  allowed_actions: {
    can_view: boolean;
    can_record: boolean;
  };
  summary: VendorFinanceCompanySummary;
  filters: {
    search: string | null;
    active: VendorFinanceActiveFilter;
    balance_filter: VendorFinanceBalanceFilter;
  };
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  vendors: readonly VendorFinanceListItem[];
};

export type VendorFinanceCategoryTotals = {
  opening_payable_minor: string;
  opening_advance_minor: string;
  debt_recorded_minor: string;
  payroll_recorded_minor: string;
  payment_recorded_minor: string;
  advance_recorded_minor: string;
  adjustment_increase_minor: string;
  adjustment_decrease_minor: string;
  reversed_entry_count: number;
};

export type VendorFinanceVendorDetailResponse = {
  authorization_date: string;
  allowed_actions: {
    can_view: boolean;
    can_record: boolean;
    can_reconcile: boolean;
    allowed_entry_types: readonly NormalVendorFinanceEntryType[];
  };
  vendor: {
    vendor_id: string;
    display_name: string;
    active: boolean;
    current_balance_minor: string;
    balance_direction: VendorFinanceBalanceDirection;
    latest_sequence: number;
    entry_count: number;
    has_opening_entry: boolean;
    eligible_for_opening: boolean;
    totals: VendorFinanceCategoryTotals;
    latest_reconciliation: VendorFinanceReconciliationProjection | null;
    recent_reconciliations: readonly VendorFinanceReconciliationProjection[];
  };
};

export type VendorFinanceEntriesPageResponse = {
  authorization_date: string;
  vendor_id: string;
  page_size: number;
  has_more: boolean;
  next_cursor: string | null;
  entries: readonly VendorFinanceEntryProjection[];
};

export type VendorFinanceSingleEntryResponse = {
  authorization_date: string;
  allowed_actions: {
    can_view: boolean;
    can_record: boolean;
  };
  entry: VendorFinanceEntryProjection;
};

export type VendorFinanceReconciliationsPageResponse = {
  authorization_date: string;
  vendor_id: string;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  reconciliations: readonly VendorFinanceReconciliationProjection[];
};

export type VendorFinanceOpeningPreviewItem = {
  vendor_id: string;
  display_name: string;
  active: boolean;
  entry_type: OpeningVendorFinanceEntryType;
  amount_minor: string;
  balance_delta_minor: string;
};

export type VendorFinanceOpeningPreviewResponse = {
  authorization_date: string;
  cutoff_date: string;
  vendor_count: number;
  skipped_zero_count: number;
  total_payable_minor: string;
  total_advance_minor: string;
  net_balance_minor: string;
  items: readonly VendorFinanceOpeningPreviewItem[];
};

export type VendorFinanceOpeningBatchHeader = {
  batch_id: string;
  cutoff_date: string;
  vendor_count: number;
  skipped_zero_count: number;
  total_payable_minor: string;
  total_advance_minor: string;
  net_balance_minor: string;
  reason: string;
  created_by_display_name: string;
  created_at: string;
};

export type VendorFinanceOpeningApplyResponse = {
  batch: VendorFinanceOpeningBatchHeader;
  entries: readonly VendorFinanceEntryProjection[];
  replayed: boolean;
};

export type VendorFinanceEvidenceReserveResponse = {
  evidence_id: string;
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  upload: {
    method: "PUT";
    url: string;
    expires_at: string;
    headers: Readonly<Record<string, string>>;
  };
  replayed: boolean;
};

export type VendorFinanceEvidenceFinalizeResponse = {
  evidence: VendorFinanceEvidenceSummary & {
    target_kind: VendorFinanceEvidenceTargetKind;
    target_id: string;
  };
  replayed: boolean;
};

export type VendorFinanceEvidenceDownloadResponse = {
  evidence_id: string;
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  download: {
    url: string;
    expires_at: string;
  };
};

// Internal projection helpers
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

function signedMoneyStr(value: unknown): string | null {
  const parsed = parseSignedMinorAmount(value);
  return parsed.ok ? parsed.canonical : null;
}

function nonNegativeMoneyStr(value: unknown): string | null {
  const parsed = parseNonNegativeMinorAmount(value);
  return parsed.ok ? parsed.canonical : null;
}

function positiveMoneyStr(value: unknown): string | null {
  const parsed = parsePositiveMinorAmount(value);
  return parsed.ok ? parsed.canonical : null;
}

function uuidStr(value: unknown): string | null {
  return typeof value === "string" && UUID_REGEX.test(value) ? value.toLowerCase() : null;
}

function nullableUuidStr(value: unknown): string | null | undefined {
  return value === null ? null : (uuidStr(value) ?? undefined);
}

function dateStr(value: unknown): string | null {
  const parsed = parseBusinessCalendarDate(value);
  return parsed.ok ? parsed.date : null;
}

function nullableDateStr(value: unknown): string | null | undefined {
  return value === null ? null : (dateStr(value) ?? undefined);
}

export function projectActorAccess(value: unknown): VendorFinanceActorAccessProjection | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["authorization_date", "can_view", "can_record", "authority_source"])
  ) {
    return null;
  }
  const authorizationDate = dateStr(value.authorization_date);
  const canView = boolVal(value.can_view);
  const canRecord = boolVal(value.can_record);
  const source = value.authority_source;
  if (
    authorizationDate === null ||
    canView === null ||
    canRecord === null ||
    (source !== "full_admin" &&
      source !== "accounting_department" &&
      source !== "direct_grant_record" &&
      source !== "direct_grant_view" &&
      source !== "none")
  ) {
    return null;
  }
  if (canRecord && !canView) return null;
  return {
    authorization_date: authorizationDate,
    can_view: canView,
    can_record: canRecord,
    authority_source: source,
  };
}

export function projectEvidenceSummary(value: unknown): VendorFinanceEvidenceSummary | null {
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
    sizeBytes > VENDOR_FINANCE_EVIDENCE_MAX_BYTES ||
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

export function projectVendorFinanceEntry(value: unknown): VendorFinanceEntryProjection | null {
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
  const vendorId = isCanonicalVendorId(value.vendor_id) ? value.vendor_id : null;
  const vendorDisplayNameSnapshot = nonEmptyStr(value.vendor_display_name_snapshot);
  const vendorActive = boolVal(value.vendor_active);
  const vendorSequence = posInt(value.vendor_sequence);
  const documentNo =
    typeof value.document_no === "string" && DOCUMENT_NO_REGEX.test(value.document_no)
      ? value.document_no
      : null;
  const documentKind =
    typeof value.document_kind === "string" &&
    (VENDOR_FINANCE_DOCUMENT_KINDS as readonly string[]).includes(value.document_kind)
      ? (value.document_kind as VendorFinanceDocumentKind)
      : null;
  const documentTitleVi = nonEmptyStr(value.document_title_vi);
  const entryType =
    typeof value.entry_type === "string" &&
    (VENDOR_FINANCE_ENTRY_TYPES as readonly string[]).includes(value.entry_type)
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
  const evidence = value.evidence === null ? null : projectEvidenceSummary(value.evidence);
  const createdByDisplayName = nonEmptyStr(value.created_by_display_name);
  const createdAt = nonEmptyStr(value.created_at);
  const disclaimer =
    value.internal_disclaimer === VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI
      ? VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI
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

export function projectVendorReconciliation(
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
  const vendorId = isCanonicalVendorId(value.vendor_id) ? value.vendor_id : null;
  const asOfDate = dateStr(value.as_of_date);
  const systemBalanceMinor = signedMoneyStr(value.system_balance_minor);
  const confirmedBalanceMinor = signedMoneyStr(value.confirmed_balance_minor);
  const differenceMinor = signedMoneyStr(value.difference_minor);
  const ledgerSeq = nonNegInt(value.ledger_sequence_at_reconciliation);
  const reason = nonEmptyStr(value.reason);
  const canAttachEvidence = boolVal(value.can_attach_evidence);
  const evidence = value.evidence === null ? null : projectEvidenceSummary(value.evidence);
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

export function projectVendorFinanceVendorList(
  value: unknown,
): VendorFinanceVendorListResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "authorization_date",
      "allowed_actions",
      "summary",
      "filters",
      "page",
      "page_size",
      "total",
      "has_more",
      "vendors",
    ])
  ) {
    return null;
  }

  const authorizationDate = dateStr(value.authorization_date);
  if (
    !isRecord(value.allowed_actions) ||
    !exactKeys(value.allowed_actions, ["can_view", "can_record"]) ||
    !isRecord(value.summary) ||
    !exactKeys(value.summary, [
      "total_payable_minor",
      "total_advance_minor",
      "net_balance_minor",
      "vendors_with_payable_count",
      "vendors_with_advance_count",
      "vendors_with_nonzero_balance_count",
      "total_vendor_count",
      "uninitialized_vendor_count",
    ]) ||
    !isRecord(value.filters) ||
    !exactKeys(value.filters, ["search", "active", "balance_filter"]) ||
    !Array.isArray(value.vendors)
  ) {
    return null;
  }

  const canView = boolVal(value.allowed_actions.can_view);
  const canRecord = boolVal(value.allowed_actions.can_record);
  const totalPayable = nonNegativeMoneyStr(value.summary.total_payable_minor);
  const totalAdvance = nonNegativeMoneyStr(value.summary.total_advance_minor);
  const netBalance = signedMoneyStr(value.summary.net_balance_minor);
  const payableCount = nonNegInt(value.summary.vendors_with_payable_count);
  const advanceCount = nonNegInt(value.summary.vendors_with_advance_count);
  const nonzeroCount = nonNegInt(value.summary.vendors_with_nonzero_balance_count);
  const totalVendorCount = nonNegInt(value.summary.total_vendor_count);
  const uninitializedCount = nonNegInt(value.summary.uninitialized_vendor_count);

  const search = nullableStr(value.filters.search);
  const active = value.filters.active;
  const balanceFilter = value.filters.balance_filter;
  const page = posInt(value.page);
  const pageSize = posInt(value.page_size);
  const total = nonNegInt(value.total);
  const hasMore = boolVal(value.has_more);

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
  for (const item of value.vendors) {
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
    const vendorId = isCanonicalVendorId(item.vendor_id) ? item.vendor_id : null;
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

  return {
    authorization_date: authorizationDate,
    allowed_actions: { can_view: true, can_record: canRecord },
    summary: {
      total_payable_minor: totalPayable,
      total_advance_minor: totalAdvance,
      net_balance_minor: netBalance,
      vendors_with_payable_count: payableCount,
      vendors_with_advance_count: advanceCount,
      vendors_with_nonzero_balance_count: nonzeroCount,
      total_vendor_count: totalVendorCount,
      uninitialized_vendor_count: uninitializedCount,
    },
    filters: { search, active, balance_filter: balanceFilter },
    page,
    page_size: pageSize,
    total,
    has_more: hasMore,
    vendors,
  };
}

export function projectVendorFinanceVendorDetail(
  value: unknown,
): VendorFinanceVendorDetailResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["authorization_date", "allowed_actions", "vendor"]) ||
    !isRecord(value.allowed_actions) ||
    !exactKeys(value.allowed_actions, [
      "can_view",
      "can_record",
      "can_reconcile",
      "allowed_entry_types",
    ]) ||
    !Array.isArray(value.allowed_actions.allowed_entry_types) ||
    !isRecord(value.vendor) ||
    !exactKeys(value.vendor, [
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
    !isRecord(value.vendor.totals) ||
    !exactKeys(value.vendor.totals, [
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
    !Array.isArray(value.vendor.recent_reconciliations)
  ) {
    return null;
  }

  const authorizationDate = dateStr(value.authorization_date);
  const canView = boolVal(value.allowed_actions.can_view);
  const canRecord = boolVal(value.allowed_actions.can_record);
  const canReconcile = boolVal(value.allowed_actions.can_reconcile);
  const allowedEntryTypes: NormalVendorFinanceEntryType[] = [];
  for (const rawType of value.allowed_actions.allowed_entry_types) {
    if (
      typeof rawType !== "string" ||
      !(NORMAL_VENDOR_FINANCE_ENTRY_TYPES as readonly string[]).includes(rawType)
    ) {
      return null;
    }
    allowedEntryTypes.push(rawType as NormalVendorFinanceEntryType);
  }

  const v = value.vendor;
  if (!isRecord(v.totals) || !Array.isArray(v.recent_reconciliations)) {
    return null;
  }
  const vendorId = isCanonicalVendorId(v.vendor_id) ? v.vendor_id : null;
  const displayName = nonEmptyStr(v.display_name);
  const active = boolVal(v.active);
  const currentBalance = signedMoneyStr(v.current_balance_minor);
  const direction = v.balance_direction;
  const latestSeq = nonNegInt(v.latest_sequence);
  const entryCount = nonNegInt(v.entry_count);
  const hasOpening = boolVal(v.has_opening_entry);
  const eligible = boolVal(v.eligible_for_opening);

  const t = v.totals;
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
      : projectVendorReconciliation(v.latest_reconciliation);

  const recentRecs: VendorFinanceReconciliationProjection[] = [];
  for (const item of v.recent_reconciliations) {
    const projected = projectVendorReconciliation(item);
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
      totals: {
        opening_payable_minor: openingPayable,
        opening_advance_minor: openingAdvance,
        debt_recorded_minor: debtRecorded,
        payroll_recorded_minor: payrollRecorded,
        payment_recorded_minor: paymentRecorded,
        advance_recorded_minor: advanceRecorded,
        adjustment_increase_minor: adjustmentInc,
        adjustment_decrease_minor: adjustmentDec,
        reversed_entry_count: reversedCount,
      },
      latest_reconciliation: latestRec,
      recent_reconciliations: recentRecs,
    },
  };
}

export function projectVendorFinanceEntriesPage(
  value: unknown,
): VendorFinanceEntriesPageResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "authorization_date",
      "vendor_id",
      "page_size",
      "has_more",
      "next_before_sequence",
      "entries",
    ]) ||
    !Array.isArray(value.entries)
  ) {
    return null;
  }

  const authorizationDate = dateStr(value.authorization_date);
  const vendorId = isCanonicalVendorId(value.vendor_id) ? value.vendor_id : null;
  const pageSize = posInt(value.page_size);
  const hasMore = boolVal(value.has_more);
  const nextBeforeSeq =
    value.next_before_sequence === null ? null : posInt(value.next_before_sequence);

  if (
    authorizationDate === null ||
    vendorId === null ||
    pageSize === null ||
    hasMore === null ||
    (value.next_before_sequence !== null && nextBeforeSeq === null) ||
    (hasMore && nextBeforeSeq === null) ||
    (!hasMore && nextBeforeSeq !== null)
  ) {
    return null;
  }

  const entries: VendorFinanceEntryProjection[] = [];
  for (const item of value.entries) {
    const projected = projectVendorFinanceEntry(item);
    if (!projected || projected.vendor_id !== vendorId) return null;
    entries.push(projected);
  }

  return {
    authorization_date: authorizationDate,
    vendor_id: vendorId,
    page_size: pageSize,
    has_more: hasMore,
    next_cursor:
      hasMore && nextBeforeSeq !== null
        ? encodeVendorEntriesCursor({ vendor_id: vendorId, before_sequence: nextBeforeSeq })
        : null,
    entries,
  };
}

export function projectVendorFinanceSingleEntry(
  value: unknown,
): VendorFinanceSingleEntryResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["authorization_date", "allowed_actions", "entry"]) ||
    !isRecord(value.allowed_actions) ||
    !exactKeys(value.allowed_actions, ["can_view", "can_record"])
  ) {
    return null;
  }
  const authorizationDate = dateStr(value.authorization_date);
  const canView = boolVal(value.allowed_actions.can_view);
  const canRecord = boolVal(value.allowed_actions.can_record);
  const entry = projectVendorFinanceEntry(value.entry);
  if (authorizationDate === null || canView !== true || canRecord === null || entry === null) {
    return null;
  }
  return {
    authorization_date: authorizationDate,
    allowed_actions: { can_view: true, can_record: canRecord },
    entry,
  };
}

export function projectVendorReconciliationsPage(
  value: unknown,
): VendorFinanceReconciliationsPageResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "authorization_date",
      "vendor_id",
      "page",
      "page_size",
      "total",
      "has_more",
      "reconciliations",
    ]) ||
    !Array.isArray(value.reconciliations)
  ) {
    return null;
  }
  const authorizationDate = dateStr(value.authorization_date);
  const vendorId = isCanonicalVendorId(value.vendor_id) ? value.vendor_id : null;
  const page = posInt(value.page);
  const pageSize = posInt(value.page_size);
  const total = nonNegInt(value.total);
  const hasMore = boolVal(value.has_more);
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
  for (const item of value.reconciliations) {
    const projected = projectVendorReconciliation(item);
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

export function projectRecordEntryMutation(
  value: unknown,
): { entry: VendorFinanceEntryProjection; replayed: boolean } | null {
  if (!isRecord(value) || !exactKeys(value, ["entry", "replayed"])) return null;
  const entry = projectVendorFinanceEntry(value.entry);
  const replayed = boolVal(value.replayed);
  if (!entry || replayed === null) return null;
  return { entry, replayed };
}

export function projectReverseEntryMutation(
  value: unknown,
): {
  reversal_entry: VendorFinanceEntryProjection;
  reversed_entry: VendorFinanceEntryProjection;
  replayed: boolean;
} | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["reversal_entry", "reversed_entry", "replayed"])
  ) {
    return null;
  }
  const reversal = projectVendorFinanceEntry(value.reversal_entry);
  const reversed = projectVendorFinanceEntry(value.reversed_entry);
  const replayed = boolVal(value.replayed);
  if (!reversal || !reversed || replayed === null) return null;
  return { reversal_entry: reversal, reversed_entry: reversed, replayed };
}

export function projectOpeningPreview(
  value: unknown,
): VendorFinanceOpeningPreviewResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "authorization_date",
      "cutoff_date",
      "vendor_count",
      "skipped_zero_count",
      "total_payable_minor",
      "total_advance_minor",
      "net_balance_minor",
      "items",
    ]) ||
    !Array.isArray(value.items)
  ) {
    return null;
  }
  const authorizationDate = dateStr(value.authorization_date);
  const cutoffDate = dateStr(value.cutoff_date);
  const vendorCount = posInt(value.vendor_count);
  const skippedZero = nonNegInt(value.skipped_zero_count);
  const totalPayable = nonNegativeMoneyStr(value.total_payable_minor);
  const totalAdvance = nonNegativeMoneyStr(value.total_advance_minor);
  const netBalance = signedMoneyStr(value.net_balance_minor);
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
  for (const rawItem of value.items) {
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
    const vendorId = isCanonicalVendorId(rawItem.vendor_id) ? rawItem.vendor_id : null;
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

export function projectOpeningApplyMutation(
  value: unknown,
): VendorFinanceOpeningApplyResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["batch", "entries", "replayed"]) ||
    !isRecord(value.batch) ||
    !exactKeys(value.batch, [
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
    !Array.isArray(value.entries)
  ) {
    return null;
  }

  const b = value.batch;
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
  const replayed = boolVal(value.replayed);

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
  for (const item of value.entries) {
    const projected = projectVendorFinanceEntry(item);
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

export function projectCreateReconciliationMutation(
  value: unknown,
): { reconciliation: VendorFinanceReconciliationProjection; replayed: boolean } | null {
  if (!isRecord(value) || !exactKeys(value, ["reconciliation", "replayed"])) return null;
  const reconciliation = projectVendorReconciliation(value.reconciliation);
  const replayed = boolVal(value.replayed);
  if (!reconciliation || replayed === null) return null;
  return { reconciliation, replayed };
}
