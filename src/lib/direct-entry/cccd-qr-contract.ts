import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { isCanonicalNationalId } from "../contracts/national-id.ts";

export const CCCD_QR_SOURCE = "CCCD_QR" as const;
export const CCCD_QR_AUTHENTICITY = "UNVERIFIED_QR_TEXT" as const;
export const CCCD_QR_DOCUMENT_TYPES = ["CCCD_FRONT", "CCCD_BACK"] as const;
export type CccdQrDocumentType = (typeof CCCD_QR_DOCUMENT_TYPES)[number];

export const CCCD_QR_STATUSES = [
  "PENDING",
  "SUCCEEDED",
  "NO_QR_FOUND",
  "INVALID_QR",
  "FAILED_RETRYABLE",
] as const;
export type CccdQrStatus = (typeof CCCD_QR_STATUSES)[number];

export const CCCD_QR_ERROR_FIELDS = [
  "payload",
  "national_id",
  "display_name",
  "date_of_birth",
  "gender",
  "address",
  "national_id_issued_at",
] as const;
export type CccdQrErrorField = (typeof CCCD_QR_ERROR_FIELDS)[number];

export const CCCD_QR_ERROR_CODES = [
  "QR_NOT_DETECTED",
  "QR_IMAGE_UNREADABLE",
  "QR_PAYLOAD_EMPTY",
  "QR_FORMAT_INVALID",
  "QR_FIELD_MISSING",
  "QR_NATIONAL_ID_INVALID",
  "QR_NAME_INVALID",
  "QR_DOB_INVALID",
  "QR_GENDER_INVALID",
  "QR_ADDRESS_INVALID",
  "QR_ISSUE_DATE_INVALID",
  "QR_STORAGE_UNAVAILABLE",
  "QR_DECODE_FAILED",
] as const;
export type CccdQrErrorCode = (typeof CCCD_QR_ERROR_CODES)[number];

export type CccdQrGender = "MALE" | "FEMALE" | "OTHER";
export type CccdQrGenderLabel = "Nam" | "Nữ" | "Khác";

export type CccdQrCandidateData = {
  source: typeof CCCD_QR_SOURCE;
  authenticity: typeof CCCD_QR_AUTHENTICITY;
  national_id: string;
  display_name: string;
  date_of_birth: string;
  date_of_birth_iso: string;
  gender: CccdQrGender;
  gender_label: CccdQrGenderLabel;
  address: string;
  national_id_issued_at: string;
  national_id_issued_at_iso: string;
};

export type CccdQrParseResult =
  | { ok: true; data: CccdQrCandidateData }
  | { ok: false; error_code: CccdQrErrorCode; error_field: CccdQrErrorField };

export const CCCD_QR_MERGEABLE_WORKER_FIELDS = [
  "national_id",
  "date_of_birth",
  "gender",
  "address",
  "national_id_issued_at",
] as const;
export type CccdQrMergeableWorkerField = (typeof CCCD_QR_MERGEABLE_WORKER_FIELDS)[number];

export type CccdQrFieldMergeStatus =
  | "eligible_blank"
  | "kept_existing"
  | "applied_to_blank";

export type CccdQrFieldMergePreview = {
  display_name: "kept_existing";
  national_id: CccdQrFieldMergeStatus;
  date_of_birth: CccdQrFieldMergeStatus;
  gender: CccdQrFieldMergeStatus;
  address: CccdQrFieldMergeStatus;
  national_id_issued_at: CccdQrFieldMergeStatus;
};

export type CccdQrProcessRequest = {
  document_id: string | null;
  document_type: CccdQrDocumentType | null;
  apply_blank_fields: boolean;
  expected_entry_version: number | null;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPACT_DATE_REGEX = /^(\d{2})(\d{2})(\d{4})$/;
const SLASH_DATE_REGEX = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/;
const FORMULA_PREFIX_REGEX = /^[=+\-@]/;
const LETTER_CHAR_REGEX = /\p{L}/u;
const PROCESS_REQUEST_KEYS = new Set([
  "document_id",
  "document_type",
  "apply_blank_fields",
  "expected_entry_version",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCccdQrDocumentType(value: unknown): value is CccdQrDocumentType {
  return value === "CCCD_FRONT" || value === "CCCD_BACK";
}

export function isCccdQrStatus(value: unknown): value is CccdQrStatus {
  return typeof value === "string" && (CCCD_QR_STATUSES as readonly string[]).includes(value);
}

export function isCccdQrErrorCode(value: unknown): value is CccdQrErrorCode {
  return typeof value === "string" && (CCCD_QR_ERROR_CODES as readonly string[]).includes(value);
}

export function isCccdQrErrorField(value: unknown): value is CccdQrErrorField {
  return typeof value === "string" && (CCCD_QR_ERROR_FIELDS as readonly string[]).includes(value);
}

export function currentHcmDateIso(now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(now);
}

function parseCccdDate(
  raw: string,
  maxIsoDate: string,
): { uiDate: string; isoDate: string } | null {
  const trimmed = raw.trim();
  let day = "";
  let month = "";
  let year = "";
  const compactMatch = COMPACT_DATE_REGEX.exec(trimmed);
  if (compactMatch) {
    day = compactMatch[1];
    month = compactMatch[2];
    year = compactMatch[3];
  } else {
    const slashMatch = SLASH_DATE_REGEX.exec(trimmed);
    if (!slashMatch) return null;
    day = slashMatch[1];
    month = slashMatch[2];
    year = slashMatch[3];
  }

  const yearNum = Number(year);
  if (!Number.isInteger(yearNum) || yearNum < 1900 || yearNum > 2100) {
    return null;
  }
  const isoDate = `${year}-${month}-${day}`;
  if (!isRealCalendarDate(isoDate)) {
    return null;
  }
  if (isoDate > maxIsoDate) {
    return null;
  }
  return {
    uiDate: `${day}/${month}/${year}`,
    isoDate,
  };
}

function parseCccdGender(
  raw: string,
): { gender: CccdQrGender; label: CccdQrGenderLabel } | null {
  const normalized = raw.trim().normalize("NFC").toUpperCase();
  if (normalized === "NAM" || normalized === "MALE") {
    return { gender: "MALE", label: "Nam" };
  }
  if (normalized === "NỮ" || normalized === "NU" || normalized === "FEMALE") {
    return { gender: "FEMALE", label: "Nữ" };
  }
  if (normalized === "KHÁC" || normalized === "KHAC" || normalized === "OTHER") {
    return { gender: "OTHER", label: "Khác" };
  }
  return null;
}

function normalizeWhitespace(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Parses and validates the official Vietnamese chip-based CCCD QR code payload:
 *   `cccd_12_digits|ignored_cmnd_field|full_name|dob_ddmmyyyy|gender|permanent_address|issue_date_ddmmyyyy`
 *
 * Security invariants:
 * - Never returns or logs raw QR payload or decoded PII inside error objects.
 * - Marks decoded output as `UNVERIFIED_QR_TEXT` (plain-text QR without digital signature verification).
 */
export function parseCccdQrPayload(
  rawPayload: unknown,
  options: { referenceDateIso?: string } = {},
): CccdQrParseResult {
  if (typeof rawPayload !== "string") {
    return { ok: false, error_code: "QR_PAYLOAD_EMPTY", error_field: "payload" };
  }

  // Strip a single trailing CR/LF pair if a scanner appended a line break, then reject control chars.
  const stripped = rawPayload.replace(/\r?\n$/, "").trim();
  if (stripped.length === 0) {
    return { ok: false, error_code: "QR_PAYLOAD_EMPTY", error_field: "payload" };
  }
  if (stripped.length > 2048) {
    return { ok: false, error_code: "QR_FORMAT_INVALID", error_field: "payload" };
  }

  const segments = stripped.split("|");
  // Allow an optional trailing empty segment only when a trailing pipe was encoded after the 7th field.
  const parts = segments.length === 8 && segments[7].trim() === ""
    ? segments.slice(0, 7)
    : segments;

  if (parts.length < 7) {
    return { ok: false, error_code: "QR_FIELD_MISSING", error_field: "payload" };
  }
  if (parts.length > 7) {
    return { ok: false, error_code: "QR_FORMAT_INVALID", error_field: "payload" };
  }

  const [
    rawNationalId,
    , // Legacy CMND is intentionally discarded.
    rawDisplayName,
    rawDob,
    rawGender,
    rawAddress,
    rawIssuedAt,
  ] = parts;

  if (
    [rawNationalId, rawDisplayName, rawDob, rawGender, rawAddress, rawIssuedAt].some((field) =>
      CONTROL_CHAR_REGEX.test(field),
    )
  ) {
    return { ok: false, error_code: "QR_FORMAT_INVALID", error_field: "payload" };
  }

  const nationalId = rawNationalId.trim();
  if (!/^\d{12}$/.test(nationalId) || !isCanonicalNationalId(nationalId) || /^0+$/.test(nationalId)) {
    return { ok: false, error_code: "QR_NATIONAL_ID_INVALID", error_field: "national_id" };
  }

  const displayName = normalizeWhitespace(rawDisplayName.normalize("NFC"));
  if (
    displayName.length < 1 ||
    displayName.length > 256 ||
    FORMULA_PREFIX_REGEX.test(displayName) ||
    !LETTER_CHAR_REGEX.test(displayName)
  ) {
    return { ok: false, error_code: "QR_NAME_INVALID", error_field: "display_name" };
  }

  const maxIsoDate = options.referenceDateIso ?? currentHcmDateIso();
  const dob = parseCccdDate(rawDob, maxIsoDate);
  if (!dob) {
    return { ok: false, error_code: "QR_DOB_INVALID", error_field: "date_of_birth" };
  }

  const gender = parseCccdGender(rawGender);
  if (!gender) {
    return { ok: false, error_code: "QR_GENDER_INVALID", error_field: "gender" };
  }

  const address = normalizeWhitespace(rawAddress.normalize("NFC"));
  if (
    address.length < 1 ||
    address.length > 1024 ||
    FORMULA_PREFIX_REGEX.test(address)
  ) {
    return { ok: false, error_code: "QR_ADDRESS_INVALID", error_field: "address" };
  }

  const issuedAt = parseCccdDate(rawIssuedAt, maxIsoDate);
  if (!issuedAt || issuedAt.isoDate < dob.isoDate) {
    return { ok: false, error_code: "QR_ISSUE_DATE_INVALID", error_field: "national_id_issued_at" };
  }

  return {
    ok: true,
    data: {
      source: CCCD_QR_SOURCE,
      authenticity: CCCD_QR_AUTHENTICITY,
      national_id: nationalId,
      display_name: displayName,
      date_of_birth: dob.uiDate,
      date_of_birth_iso: dob.isoDate,
      gender: gender.gender,
      gender_label: gender.label,
      address,
      national_id_issued_at: issuedAt.uiDate,
      national_id_issued_at_iso: issuedAt.isoDate,
    },
  };
}

export function isBlankWorkerDetailField(fieldValue: unknown): boolean {
  if (fieldValue === undefined || fieldValue === null) return true;
  if (!isRecord(fieldValue)) return false;
  return fieldValue.state === "omitted" || fieldValue.state === "unknown";
}

export function buildCccdQrFieldMergePreview(
  workerDetails: Record<string, unknown> | null | undefined,
  appliedFields: readonly string[] = [],
): CccdQrFieldMergePreview {
  const appliedSet = new Set(appliedFields);
  const details = isRecord(workerDetails) ? workerDetails : {};
  const statusFor = (field: CccdQrMergeableWorkerField): CccdQrFieldMergeStatus => {
    if (appliedSet.has(field)) return "applied_to_blank";
    return isBlankWorkerDetailField(details[field]) ? "eligible_blank" : "kept_existing";
  };

  return {
    display_name: "kept_existing",
    national_id: statusFor("national_id"),
    date_of_birth: statusFor("date_of_birth"),
    gender: statusFor("gender"),
    address: statusFor("address"),
    national_id_issued_at: statusFor("national_id_issued_at"),
  };
}

export function parseCccdQrProcessRequest(
  body: unknown,
): { ok: true; value: CccdQrProcessRequest } | { ok: false; code: string } {
  if (body === undefined || body === null) {
    return {
      ok: true,
      value: {
        document_id: null,
        document_type: null,
        apply_blank_fields: false,
        expected_entry_version: null,
      },
    };
  }
  if (!isRecord(body)) {
    return { ok: false, code: "CCCD_QR_REQUEST_INVALID" };
  }
  for (const key of Object.keys(body)) {
    if (!PROCESS_REQUEST_KEYS.has(key)) {
      return { ok: false, code: "CCCD_QR_REQUEST_INVALID" };
    }
  }

  let documentId: string | null = null;
  if (body.document_id !== undefined && body.document_id !== null) {
    if (typeof body.document_id !== "string" || !UUID_REGEX.test(body.document_id.trim())) {
      return { ok: false, code: "DOCUMENT_ID_INVALID" };
    }
    documentId = body.document_id.trim();
  }

  let documentType: CccdQrDocumentType | null = null;
  if (body.document_type !== undefined && body.document_type !== null) {
    if (!isCccdQrDocumentType(body.document_type)) {
      return { ok: false, code: "DOCUMENT_TYPE_INVALID" };
    }
    documentType = body.document_type;
  }

  let applyBlankFields = false;
  if (body.apply_blank_fields !== undefined) {
    if (typeof body.apply_blank_fields !== "boolean") {
      return { ok: false, code: "CCCD_QR_REQUEST_INVALID" };
    }
    applyBlankFields = body.apply_blank_fields;
  }

  let expectedEntryVersion: number | null = null;
  if (body.expected_entry_version !== undefined && body.expected_entry_version !== null) {
    if (
      typeof body.expected_entry_version !== "number" ||
      !Number.isSafeInteger(body.expected_entry_version) ||
      body.expected_entry_version < 1
    ) {
      return { ok: false, code: "CCCD_QR_REQUEST_INVALID" };
    }
    expectedEntryVersion = body.expected_entry_version;
  }

  if (applyBlankFields && expectedEntryVersion === null) {
    return { ok: false, code: "EXPECTED_ENTRY_VERSION_REQUIRED" };
  }

  return {
    ok: true,
    value: {
      document_id: documentId,
      document_type: documentType,
      apply_blank_fields: applyBlankFields,
      expected_entry_version: expectedEntryVersion,
    },
  };
}
