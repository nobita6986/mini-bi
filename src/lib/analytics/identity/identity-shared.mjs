/**
 * P1.5-W02 — Shared runtime helpers cho identity/membership projection.
 *
 * Module .mjs có chủ đích: các module .ts của package import bằng specifier có extension
 * (`./identity-shared.mjs`) nên Node chạy test trực tiếp được mà không cần
 * `allowImportingTsExtensions` (không sửa tsconfig).
 *
 * Thuần: không DB, không mạng, không secret, không PII.
 */

export const IDENTITY_PROJECTION_VERSION = "identity-projection/1.0";

/** Stable id space của contract (synthetic trong test/fixture; P1.6 sẽ cấp id thật). */
export const RECRUITER_ID_PREFIX = "rcr_";
export const TEAM_ID_PREFIX = "team_";

/** Sentinel key của reporting layer (không bao giờ tự gán team). */
export const SENTINEL_KEYS = ["__unknown__", "__invalid__"];

/** Fact provider key hợp lệ theo catalog ingestion. */
export const PROVIDER_FACT_KEYS = ["hrp", "vendor", "__unknown__", "__invalid__"];

/** @type {readonly ["mapped", "unmapped", "ambiguous"]} */
export const CLASSIFICATIONS = ["mapped", "unmapped", "ambiguous"];
/** @type {readonly ["available", "partial", "unavailable", "ambiguous"]} */
export const TEAM_AVAILABILITIES = ["available", "partial", "unavailable", "ambiguous"];

/** Reason code ở mức fact. */
export const IDENTITY_REASON = {
  RECRUITER_MAPPED: "RECRUITER_MAPPED",
  RECRUITER_ALIAS_NOT_FOUND: "RECRUITER_ALIAS_NOT_FOUND",
  RECRUITER_ALIAS_AMBIGUOUS: "RECRUITER_ALIAS_AMBIGUOUS",
  RECRUITER_KEY_SENTINEL: "RECRUITER_KEY_SENTINEL",
  RECRUITER_KEY_INVALID: "RECRUITER_KEY_INVALID",
  TEAM_MAPPED: "TEAM_MAPPED",
  TEAM_MEMBERSHIP_NOT_FOUND: "TEAM_MEMBERSHIP_NOT_FOUND",
  TEAM_MEMBERSHIP_AMBIGUOUS: "TEAM_MEMBERSHIP_AMBIGUOUS",
  PROVIDER_MATCH: "PROVIDER_MATCH",
  PROVIDER_MISMATCH: "PROVIDER_MISMATCH",
  PROVIDER_MEMBERSHIP_NOT_FOUND: "PROVIDER_MEMBERSHIP_NOT_FOUND",
  PROVIDER_MEMBERSHIP_AMBIGUOUS: "PROVIDER_MEMBERSHIP_AMBIGUOUS",
};

/** Reason code ở mức availability của team coverage (khớp contract team_mapping R2). */
/** @type {Readonly<Record<"available" | "partial" | "unavailable" | "ambiguous", string>>} */
export const TEAM_MAPPING_REASON = {
  available: "TEAM_MAPPING_AVAILABLE",
  partial: "TEAM_MAPPING_PARTIAL",
  unavailable: "TEAM_MAPPING_UNAVAILABLE",
  ambiguous: "TEAM_MAPPING_AMBIGUOUS",
};

/** Reason code phát ra như quality issue riêng (không đổi classification). */
export const QUALITY_REASON_CODES = [
  IDENTITY_REASON.RECRUITER_ALIAS_NOT_FOUND,
  IDENTITY_REASON.RECRUITER_ALIAS_AMBIGUOUS,
  IDENTITY_REASON.RECRUITER_KEY_SENTINEL,
  IDENTITY_REASON.RECRUITER_KEY_INVALID,
  IDENTITY_REASON.TEAM_MEMBERSHIP_NOT_FOUND,
  IDENTITY_REASON.TEAM_MEMBERSHIP_AMBIGUOUS,
  IDENTITY_REASON.PROVIDER_MISMATCH,
  IDENTITY_REASON.PROVIDER_MEMBERSHIP_NOT_FOUND,
  IDENTITY_REASON.PROVIDER_MEMBERSHIP_AMBIGUOUS,
];

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const OPAQUE_REF_RE = /^(?:recruiter|team|project)_[0-9]{2,}$/;

export function isIsoDate(value) {
  return typeof value === "string" && ISO_DATE_RE.test(value);
}

/** Chuẩn hóa reporting key: NFC -> trim -> gộp khoảng trắng -> lowercase (mirror DB). */
export function normalizeReportingKey(value) {
  if (typeof value !== "string") return null;
  const collapsed = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;
  return collapsed.toLowerCase();
}

/** Interval nửa mở [valid_from, valid_to) theo business_date (YYYY-MM-DD so sánh chuỗi). */
export function isWithinInterval(date, validFrom, validTo) {
  if (!isIsoDate(date) || !isIsoDate(validFrom)) return false;
  if (date < validFrom) return false;
  if (validTo === null || validTo === undefined) return true;
  if (!isIsoDate(validTo)) return false;
  return date < validTo;
}

/** So sánh ổn định cho sort deterministic. */
export function compareStable(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Opaque ref dạng recruiter_01 / team_01 (1-based, 2 chữ số). */
export function formatOpaqueRef(prefix, ordinal) {
  return prefix + "_" + String(ordinal).padStart(2, "0");
}

/** Sort key chuẩn cho resolved fact — KHÔNG phụ thuộc thứ tự input/DB. */
export function resolvedFactSortKey(row) {
  return [row.business_date, row.recruiter_key, row.provider_type_key, String(row.recruited_count).padStart(12, "0"), row.classification, row.reason_codes.join("|")].join("\u0000");
}
