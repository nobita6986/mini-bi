import { createHash } from "node:crypto";

export const SALARY_ADVANCE_REQUEST_STATES = [
  "OPEN",
  "NEEDS_INFO",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
  "HANDLED_EXTERNALLY",
] as const;

export type SalaryAdvanceRequestState =
  (typeof SALARY_ADVANCE_REQUEST_STATES)[number];

export const SALARY_ADVANCE_EVIDENCE_REVIEW_STATES = [
  "NOT_UPLOADED",
  "PENDING_REVIEW",
  "REVIEWED",
  "RETAKE_REQUIRED",
] as const;

export type SalaryAdvanceEvidenceReviewState =
  (typeof SALARY_ADVANCE_EVIDENCE_REVIEW_STATES)[number];

export const SALARY_ADVANCE_QUEUES = [
  "ALL",
  "PM",
  "ACCOUNTANT",
  "SUPERVISORY",
] as const;

export type SalaryAdvanceQueue = (typeof SALARY_ADVANCE_QUEUES)[number];

export const SALARY_ADVANCE_TRANSITION_ACTIONS = [
  "REQUEST_INFO",
  "PROVIDE_INFO",
  "APPROVE",
  "REJECT",
  "WITHDRAW",
  "MARK_HANDLED_EXTERNALLY",
] as const;

export type SalaryAdvanceTransitionAction =
  (typeof SALARY_ADVANCE_TRANSITION_ACTIONS)[number];

export const SALARY_ADVANCE_EVIDENCE_REVIEW_DECISIONS = [
  "REVIEWED",
  "RETAKE_REQUIRED",
] as const;

export type SalaryAdvanceEvidenceReviewDecision =
  (typeof SALARY_ADVANCE_EVIDENCE_REVIEW_DECISIONS)[number];

export const SALARY_ADVANCE_EVIDENCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
] as const;

export type SalaryAdvanceEvidenceMimeType =
  (typeof SALARY_ADVANCE_EVIDENCE_MIME_TYPES)[number];

export const SALARY_ADVANCE_EVENT_TYPES = [
  "REQUEST_CREATED",
  "MESSAGE_POSTED",
  "INFO_REQUESTED",
  "INFO_PROVIDED",
  "REQUEST_APPROVED",
  "REQUEST_REJECTED",
  "REQUEST_WITHDRAWN",
  "HANDLED_EXTERNALLY_MARKED",
  "EVIDENCE_UPLOADED",
  "EVIDENCE_REVIEWED",
  "EVIDENCE_RETAKE_REQUESTED",
] as const;

export type SalaryAdvanceEventType =
  (typeof SALARY_ADVANCE_EVENT_TYPES)[number];

export const SALARY_ADVANCE_ACTOR_ROLES = [
  "PROJECT_MANAGER",
  "PROJECT_ACCOUNTANT",
] as const;

export type SalaryAdvanceActorRole =
  (typeof SALARY_ADVANCE_ACTOR_ROLES)[number];

export const SALARY_ADVANCE_PAYMENT_METHODS = [
  "CASH",
  "BANK_TRANSFER",
] as const;

export type SalaryAdvancePaymentMethod =
  (typeof SALARY_ADVANCE_PAYMENT_METHODS)[number];

export const SALARY_ADVANCE_EVIDENCE_KINDS = [
  "CASH_HANDOVER_PHOTO",
  "BANK_TRANSFER_RECEIPT",
] as const;

export type SalaryAdvanceEvidenceKind =
  (typeof SALARY_ADVANCE_EVIDENCE_KINDS)[number];

export const SALARY_ADVANCE_WORKER_EMPLOYMENT_STATUSES = [
  "ON",
  "OFF",
  "UNCONFIRMED",
] as const;

export type SalaryAdvanceWorkerEmploymentStatus =
  (typeof SALARY_ADVANCE_WORKER_EMPLOYMENT_STATUSES)[number];

export const SALARY_ADVANCE_WORKER_INELIGIBLE_REASONS = [
  "WORKER_STATUS_OFF",
  "WORKER_STATUS_UNCONFIRMED",
  "WORKER_MULTI_PROJECT_ON",
  "WORKER_DUPLICATE_CCCD",
] as const;

export type SalaryAdvanceWorkerIneligibleReason =
  (typeof SALARY_ADVANCE_WORKER_INELIGIBLE_REASONS)[number];

export const SALARY_ADVANCE_BANK_INELIGIBLE_REASONS = [
  "BANK_ACCOUNT_MISSING",
  "BANK_ACCOUNT_NOT_SELF_OWNED",
] as const;

export type SalaryAdvanceBankIneligibleReason =
  (typeof SALARY_ADVANCE_BANK_INELIGIBLE_REASONS)[number];

export const SALARY_ADVANCE_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024; // 10_485_760
export const SALARY_ADVANCE_EVIDENCE_UPLOAD_URL_TTL_SECONDS = 900; // 15 minutes
export const SALARY_ADVANCE_EXPORT_PAGE_SIZE = 100;
export const MAX_SALARY_ADVANCE_EXPORT_ROWS = 5_000;
export const MAX_PG_BIGINT = BigInt("9223372036854775807");

export type SalaryAdvanceErrorCode =
  | "UNAUTHENTICATED"
  | "ACTOR_NOT_AVAILABLE"
  | "CSRF_ORIGIN_DENIED"
  | "CLIENT_AUTHORITY_FIELD_FORBIDDEN"
  | "INVALID_JSON"
  | "REQUEST_BODY_TOO_LARGE"
  | "SALARY_ADVANCE_ACCESS_DENIED"
  | "SALARY_ADVANCE_QUERY_INVALID"
  | "SALARY_ADVANCE_PROJECT_INVALID"
  | "SALARY_ADVANCE_PROJECT_NOT_FOUND"
  | "SALARY_ADVANCE_PROJECT_INACTIVE"
  | "SALARY_ADVANCE_PROJECT_ACCOUNTANT_UNASSIGNED"
  | "SALARY_ADVANCE_WORKER_INVALID"
  | "SALARY_ADVANCE_WORKER_NOT_FOUND"
  | "SALARY_ADVANCE_WORKER_PROJECT_MISMATCH"
  | "SALARY_ADVANCE_WORKER_INELIGIBLE_STATUS"
  | "SALARY_ADVANCE_WORKER_MULTI_PROJECT_ON"
  | "SALARY_ADVANCE_WORKER_DUPLICATE_CCCD"
  | "SALARY_ADVANCE_PAYMENT_METHOD_INVALID"
  | "SALARY_ADVANCE_BANK_ACCOUNT_MISSING"
  | "SALARY_ADVANCE_BANK_ACCOUNT_NOT_SELF_OWNED"
  | "SALARY_ADVANCE_AMOUNT_INVALID"
  | "SALARY_ADVANCE_CONTENT_INVALID"
  | "SALARY_ADVANCE_MESSAGE_REQUIRED"
  | "SALARY_ADVANCE_REASON_REQUIRED"
  | "SALARY_ADVANCE_NOTE_INVALID"
  | "SALARY_ADVANCE_ACTION_INVALID"
  | "SALARY_ADVANCE_DECISION_INVALID"
  | "SALARY_ADVANCE_REQUEST_INVALID"
  | "SALARY_ADVANCE_REQUEST_NOT_FOUND"
  | "SALARY_ADVANCE_STATE_CONFLICT"
  | "SALARY_ADVANCE_VERSION_CONFLICT"
  | "SALARY_ADVANCE_IDEMPOTENCY_INVALID"
  | "SALARY_ADVANCE_IDEMPOTENCY_CONFLICT"
  | "SALARY_ADVANCE_EVIDENCE_MIME_INVALID"
  | "SALARY_ADVANCE_EVIDENCE_SIZE_INVALID"
  | "SALARY_ADVANCE_EVIDENCE_CHECKSUM_INVALID"
  | "SALARY_ADVANCE_EVIDENCE_CONTENT_INVALID"
  | "SALARY_ADVANCE_EVIDENCE_UPLOAD_MISSING"
  | "SALARY_ADVANCE_EVIDENCE_NOT_FOUND"
  | "SALARY_ADVANCE_EVIDENCE_VERSION_INVALID"
  | "SALARY_ADVANCE_EVIDENCE_VERSION_CONFLICT"
  | "SALARY_ADVANCE_UPLOAD_ID_INVALID"
  | "SALARY_ADVANCE_UPLOAD_SUPERSEDED"
  | "SALARY_ADVANCE_UPLOAD_EXPIRED"
  | "SALARY_ADVANCE_PORTRAIT_LOCK_INVALID"
  | "SALARY_ADVANCE_WORKER_PORTRAIT_MISSING"
  | "SALARY_ADVANCE_WORKER_PORTRAIT_NOT_FOUND"
  | "SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT"
  | "SALARY_ADVANCE_EXPORT_LIMIT_EXCEEDED"
  | "SALARY_ADVANCE_EXPORT_INCOMPLETE"
  | "SALARY_ADVANCE_STORAGE_UNAVAILABLE"
  | "SALARY_ADVANCE_UNAVAILABLE";

export function salaryAdvanceHttpStatusForError(
  code: SalaryAdvanceErrorCode,
): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "ACTOR_NOT_AVAILABLE":
    case "CSRF_ORIGIN_DENIED":
    case "SALARY_ADVANCE_ACCESS_DENIED":
      return 403;
    case "SALARY_ADVANCE_PROJECT_NOT_FOUND":
    case "SALARY_ADVANCE_WORKER_NOT_FOUND":
    case "SALARY_ADVANCE_REQUEST_NOT_FOUND":
    case "SALARY_ADVANCE_EVIDENCE_NOT_FOUND":
    case "SALARY_ADVANCE_WORKER_PORTRAIT_NOT_FOUND":
      return 404;
    case "SALARY_ADVANCE_PROJECT_INACTIVE":
    case "SALARY_ADVANCE_PROJECT_ACCOUNTANT_UNASSIGNED":
    case "SALARY_ADVANCE_WORKER_INELIGIBLE_STATUS":
    case "SALARY_ADVANCE_WORKER_MULTI_PROJECT_ON":
    case "SALARY_ADVANCE_WORKER_DUPLICATE_CCCD":
    case "SALARY_ADVANCE_BANK_ACCOUNT_MISSING":
    case "SALARY_ADVANCE_BANK_ACCOUNT_NOT_SELF_OWNED":
    case "SALARY_ADVANCE_STATE_CONFLICT":
    case "SALARY_ADVANCE_VERSION_CONFLICT":
    case "SALARY_ADVANCE_IDEMPOTENCY_CONFLICT":
    case "SALARY_ADVANCE_EVIDENCE_UPLOAD_MISSING":
    case "SALARY_ADVANCE_EVIDENCE_VERSION_CONFLICT":
    case "SALARY_ADVANCE_UPLOAD_SUPERSEDED":
    case "SALARY_ADVANCE_UPLOAD_EXPIRED":
    case "SALARY_ADVANCE_WORKER_PORTRAIT_MISSING":
    case "SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT":
      return 409;
    case "REQUEST_BODY_TOO_LARGE":
      return 413;
    case "SALARY_ADVANCE_EVIDENCE_MIME_INVALID":
    case "SALARY_ADVANCE_EVIDENCE_SIZE_INVALID":
    case "SALARY_ADVANCE_EVIDENCE_CHECKSUM_INVALID":
    case "SALARY_ADVANCE_EVIDENCE_CONTENT_INVALID":
    case "SALARY_ADVANCE_EXPORT_LIMIT_EXCEEDED":
      return 422;
    case "SALARY_ADVANCE_EXPORT_INCOMPLETE":
    case "SALARY_ADVANCE_STORAGE_UNAVAILABLE":
    case "SALARY_ADVANCE_UNAVAILABLE":
      return 503;
    case "CLIENT_AUTHORITY_FIELD_FORBIDDEN":
    case "INVALID_JSON":
    case "SALARY_ADVANCE_QUERY_INVALID":
    case "SALARY_ADVANCE_PROJECT_INVALID":
    case "SALARY_ADVANCE_WORKER_INVALID":
    case "SALARY_ADVANCE_WORKER_PROJECT_MISMATCH":
    case "SALARY_ADVANCE_PAYMENT_METHOD_INVALID":
    case "SALARY_ADVANCE_AMOUNT_INVALID":
    case "SALARY_ADVANCE_CONTENT_INVALID":
    case "SALARY_ADVANCE_MESSAGE_REQUIRED":
    case "SALARY_ADVANCE_REASON_REQUIRED":
    case "SALARY_ADVANCE_NOTE_INVALID":
    case "SALARY_ADVANCE_ACTION_INVALID":
    case "SALARY_ADVANCE_DECISION_INVALID":
    case "SALARY_ADVANCE_REQUEST_INVALID":
    case "SALARY_ADVANCE_IDEMPOTENCY_INVALID":
    case "SALARY_ADVANCE_EVIDENCE_VERSION_INVALID":
    case "SALARY_ADVANCE_UPLOAD_ID_INVALID":
    case "SALARY_ADVANCE_PORTRAIT_LOCK_INVALID":
      return 400;
  }
}

export type SalaryAdvanceManagedProjectOption = {
  project_id: string;
  display_name: string;
  active: boolean;
  has_active_accountant: boolean;
  accountant_user_id: string | null;
  accountant_display_name: string | null;
};

export type SalaryAdvanceProjectOption = {
  project_id: string;
  display_name: string;
  active: boolean;
};

export type SalaryAdvanceActorContext = {
  app_user_id: string;
  display_name: string;
  is_project_manager: boolean;
  is_project_accountant: boolean;
  is_supervisory_viewer: boolean;
  is_full_admin: boolean;
  is_bod: boolean;
  managed_projects: SalaryAdvanceManagedProjectOption[];
  accountant_projects: SalaryAdvanceProjectOption[];
  supervisory_projects: SalaryAdvanceProjectOption[];
  authorization_date: string;
};

export type SalaryAdvanceWorkerBankAccountInfo = {
  has_bank_account: boolean;
  bank_id: string | null;
  institution_name: string | null;
  account_number: string | null;
  account_number_masked: string | null;
  account_holder_name: string | null;
  is_self_owned: boolean;
};

export type SalaryAdvancePaymentDestinationSnapshot = {
  bank_id: string | null;
  institution_name: string;
  account_number: string;
  account_number_masked: string;
  account_holder_name: string;
};

export type SalaryAdvanceWorkerEligibilitySummary = {
  employment_status: SalaryAdvanceWorkerEmploymentStatus;
  active_on_project_count: number;
  has_duplicate_cccd: boolean;
  is_eligible: boolean;
  ineligible_reasons: SalaryAdvanceWorkerIneligibleReason[];
};

export type SalaryAdvanceWorkerOption = {
  worker_entry_id: string;
  employee_code: string;
  display_name: string;
  first_work_date: string;
  has_portrait: boolean;
  employment_status?: SalaryAdvanceWorkerEmploymentStatus;
  active_on_project_count?: number;
  has_duplicate_cccd?: boolean;
  is_eligible?: boolean;
  ineligible_reasons?: SalaryAdvanceWorkerIneligibleReason[];
  bank_transfer_eligible?: boolean;
  bank_ineligible_reason?: SalaryAdvanceBankIneligibleReason | null;
  bank_account?: SalaryAdvanceWorkerBankAccountInfo;
};

export type SalaryAdvanceWorkerListResponse = {
  project_id: string;
  workers: SalaryAdvanceWorkerOption[];
  has_more: boolean;
  next_cursor: string | null;
};

export type SalaryAdvanceWorkerPortraitMeta = {
  document_id: string;
  version: number;
  mime_type: SalaryAdvanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
};

export type SalaryAdvanceCurrentEvidenceMeta = {
  evidence_version: number;
  evidence_kind?: SalaryAdvanceEvidenceKind;
  mime_type: SalaryAdvanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  uploaded_by_user_id: string;
  uploaded_by_display_name: string;
  uploaded_at: string;
  reviewed_by_user_id: string | null;
  reviewed_by_display_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  reviewed_worker_portrait_document_id: string | null;
  reviewed_worker_portrait_version: number | null;
};

export type SalaryAdvanceAllowedActions = {
  can_post_message: boolean;
  can_provide_info: boolean;
  can_withdraw: boolean;
  can_upload_evidence: boolean;
  can_request_info: boolean;
  can_approve: boolean;
  can_reject: boolean;
  can_mark_handled_externally: boolean;
  can_review_evidence: boolean;
};

export type SalaryAdvanceRequestSummary = {
  request_id: string;
  project_id: string;
  project_display_name: string;
  worker_entry_id: string;
  worker_employee_code: string;
  worker_display_name: string;
  worker_portrait: SalaryAdvanceWorkerPortraitMeta | null;
  worker_eligibility?: SalaryAdvanceWorkerEligibilitySummary;
  requested_amount_vnd: string;
  payment_method?: SalaryAdvancePaymentMethod;
  payment_destination_snapshot?: SalaryAdvancePaymentDestinationSnapshot | null;
  initial_content: string;
  request_state: SalaryAdvanceRequestState;
  evidence_review_state: SalaryAdvanceEvidenceReviewState;
  version: number;
  created_by_user_id: string;
  created_by_display_name: string;
  decided_by_user_id: string | null;
  decided_by_display_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  handled_externally_by_user_id: string | null;
  handled_externally_by_display_name: string | null;
  handled_externally_at: string | null;
  handled_externally_note: string | null;
  withdrawn_by_user_id: string | null;
  withdrawn_by_display_name: string | null;
  withdrawn_at: string | null;
  withdrawn_note: string | null;
  current_evidence: SalaryAdvanceCurrentEvidenceMeta | null;
  current_project_accountant: {
    app_user_id: string;
    display_name: string;
  } | null;
  allowed_actions: SalaryAdvanceAllowedActions;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
};

export type SalaryAdvanceEventItem = {
  event_id: string;
  event_seq: number;
  event_type: SalaryAdvanceEventType;
  actor_user_id: string;
  actor_display_name: string;
  actor_role: SalaryAdvanceActorRole;
  from_request_state: SalaryAdvanceRequestState | null;
  to_request_state: SalaryAdvanceRequestState;
  from_evidence_review_state: SalaryAdvanceEvidenceReviewState | null;
  to_evidence_review_state: SalaryAdvanceEvidenceReviewState;
  message_text: string | null;
  evidence_version: number | null;
  evidence_kind?: SalaryAdvanceEvidenceKind | null;
  evidence_mime_type: SalaryAdvanceEvidenceMimeType | null;
  evidence_size_bytes: number | null;
  evidence_checksum_sha256: string | null;
  reviewed_worker_portrait_document_id: string | null;
  reviewed_worker_portrait_version: number | null;
  created_at: string;
};

export type SalaryAdvanceEvidenceVersionItem = {
  evidence_version: number;
  evidence_kind?: SalaryAdvanceEvidenceKind;
  event_id: string;
  mime_type: SalaryAdvanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  caption_note: string | null;
  uploaded_by_user_id: string;
  uploaded_by_display_name: string;
  uploaded_at: string;
};

export type SalaryAdvanceRequestDetail = {
  request: SalaryAdvanceRequestSummary;
  events: SalaryAdvanceEventItem[];
  evidence_versions: SalaryAdvanceEvidenceVersionItem[];
};

export type SalaryAdvanceMutationDetailResponse = SalaryAdvanceRequestDetail & {
  replayed: boolean;
};

export type SalaryAdvanceRequestListResponse = {
  requests: SalaryAdvanceRequestSummary[];
  has_more: boolean;
  next_cursor: string | null;
};

export type SalaryAdvanceEvidenceReserveResponse = {
  request_id: string;
  upload_id: string;
  expected_version: number;
  mime_type: SalaryAdvanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  expires_at: string;
  upload: {
    method: "PUT";
    url: string;
    expires_at: string;
    headers: Record<string, string>;
  };
  replayed: boolean;
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const POSITIVE_INT_STRING_REGEX = /^[1-9][0-9]{0,18}$/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const IDEMPOTENCY_KEY_REGEX = /^[^\x00-\x1F\x7F]{8,128}$/;

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function parseUuidParam(
  raw: string,
  errorCode: SalaryAdvanceErrorCode = "SALARY_ADVANCE_REQUEST_INVALID",
): { ok: true; id: string } | { ok: false; code: SalaryAdvanceErrorCode } {
  const trimmed = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!UUID_REGEX.test(trimmed)) {
    return { ok: false, code: errorCode };
  }
  return { ok: true, id: trimmed };
}

export function parseProjectIdParam(
  raw: string,
): { ok: true; project_id: string } | { ok: false; code: "SALARY_ADVANCE_PROJECT_INVALID" } {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!PROJECT_ID_REGEX.test(trimmed)) {
    return { ok: false, code: "SALARY_ADVANCE_PROJECT_INVALID" };
  }
  return { ok: true, project_id: trimmed };
}

export function parseEvidenceVersionParam(
  raw: string,
): { ok: true; version: number } | { ok: false; code: "SALARY_ADVANCE_EVIDENCE_VERSION_INVALID" } {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!/^[1-9][0-9]{0,5}$/.test(trimmed)) {
    return { ok: false, code: "SALARY_ADVANCE_EVIDENCE_VERSION_INVALID" };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { ok: false, code: "SALARY_ADVANCE_EVIDENCE_VERSION_INVALID" };
  }
  return { ok: true, version: parsed };
}

export function parsePositiveAmountVnd(
  value: unknown,
): { ok: true; value: string } | { ok: false; code: "SALARY_ADVANCE_AMOUNT_INVALID" } {
  if (typeof value !== "string") {
    return { ok: false, code: "SALARY_ADVANCE_AMOUNT_INVALID" };
  }
  const trimmed = value.trim();
  if (!POSITIVE_INT_STRING_REGEX.test(trimmed)) {
    return { ok: false, code: "SALARY_ADVANCE_AMOUNT_INVALID" };
  }
  try {
    const parsed = BigInt(trimmed);
    if (parsed < BigInt(1) || parsed > MAX_PG_BIGINT) {
      return { ok: false, code: "SALARY_ADVANCE_AMOUNT_INVALID" };
    }
    return { ok: true, value: trimmed };
  } catch {
    return { ok: false, code: "SALARY_ADVANCE_AMOUNT_INVALID" };
  }
}

export function parseIdempotencyKeyHeader(
  headerValue: string | null,
  bodyValue?: unknown,
): { ok: true; key: string } | { ok: false; code: "SALARY_ADVANCE_IDEMPOTENCY_INVALID" } {
  const raw =
    typeof headerValue === "string" && headerValue.trim().length > 0
      ? headerValue.trim()
      : typeof bodyValue === "string"
        ? bodyValue.trim()
        : "";
  if (!IDEMPOTENCY_KEY_REGEX.test(raw)) {
    return { ok: false, code: "SALARY_ADVANCE_IDEMPOTENCY_INVALID" };
  }
  if (
    typeof headerValue === "string" &&
    headerValue.trim().length > 0 &&
    typeof bodyValue === "string" &&
    bodyValue.trim().length > 0 &&
    headerValue.trim() !== bodyValue.trim()
  ) {
    return { ok: false, code: "SALARY_ADVANCE_IDEMPOTENCY_INVALID" };
  }
  return { ok: true, key: raw };
}

function validateTextField(
  raw: unknown,
  minLen: number,
  maxLen: number,
  allowNull: boolean,
  errorCode: SalaryAdvanceErrorCode,
): { ok: true; value: string | null } | { ok: false; code: SalaryAdvanceErrorCode } {
  if (raw === undefined || raw === null) {
    if (allowNull) return { ok: true, value: null };
    return { ok: false, code: errorCode };
  }
  if (typeof raw !== "string") {
    return { ok: false, code: errorCode };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    if (allowNull) return { ok: true, value: null };
    return { ok: false, code: errorCode };
  }
  if (
    trimmed.length < minLen ||
    trimmed.length > maxLen ||
    CONTROL_CHAR_REGEX.test(trimmed)
  ) {
    return { ok: false, code: errorCode };
  }
  return { ok: true, value: trimmed };
}

function parsePositiveVersion(
  raw: unknown,
): { ok: true; value: number } | { ok: false; code: "SALARY_ADVANCE_REQUEST_INVALID" } {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    return { ok: false, code: "SALARY_ADVANCE_REQUEST_INVALID" };
  }
  return { ok: true, value: raw };
}

export function parseNoQueryParams(
  url: URL,
): { ok: true } | { ok: false; code: "SALARY_ADVANCE_QUERY_INVALID" } {
  for (const _ of url.searchParams.keys()) {
    return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
  }
  return { ok: true };
}

export function parseListProjectWorkersQuery(
  url: URL,
):
  | {
      ok: true;
      value: {
        search: string | null;
        cursor: string | null;
        page_size: number;
      };
    }
  | { ok: false; code: "SALARY_ADVANCE_QUERY_INVALID" } {
  const allowed = new Set(["search", "cursor", "page_size"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
  }

  const rawSearch = url.searchParams.get("search");
  const searchRes = validateTextField(
    rawSearch,
    1,
    120,
    true,
    "SALARY_ADVANCE_QUERY_INVALID",
  );
  if (!searchRes.ok) return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };

  const rawCursor = url.searchParams.get("cursor");
  let cursor: string | null = null;
  if (rawCursor !== null && rawCursor.trim().length > 0) {
    const trimmedCursor = rawCursor.trim();
    if (
      !/^[^|]+\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        trimmedCursor,
      )
    ) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
    cursor = trimmedCursor;
  }

  const rawPageSize = url.searchParams.get("page_size");
  let pageSize = 25;
  if (rawPageSize !== null && rawPageSize.trim().length > 0) {
    if (!/^\d+$/.test(rawPageSize.trim())) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
    const parsed = Number(rawPageSize.trim());
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
    pageSize = parsed;
  }

  return {
    ok: true,
    value: {
      search: searchRes.value,
      cursor,
      page_size: pageSize,
    },
  };
}

export function parseListSalaryAdvanceRequestsQuery(
  url: URL,
):
  | {
      ok: true;
      value: {
        queue: SalaryAdvanceQueue;
        project_id: string | null;
        request_state: SalaryAdvanceRequestState | null;
        evidence_review_state: SalaryAdvanceEvidenceReviewState | null;
        search: string | null;
        cursor: string | null;
        page_size: number;
      };
    }
  | { ok: false; code: SalaryAdvanceErrorCode } {
  const allowed = new Set([
    "queue",
    "project_id",
    "request_state",
    "evidence_review_state",
    "search",
    "cursor",
    "page_size",
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
  }

  const rawQueue = url.searchParams.get("queue");
  let queue: SalaryAdvanceQueue = "ALL";
  if (rawQueue !== null && rawQueue.trim().length > 0) {
    const upper = rawQueue.trim().toUpperCase();
    if (
      !SALARY_ADVANCE_QUEUES.includes(upper as SalaryAdvanceQueue)
    ) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
    queue = upper as SalaryAdvanceQueue;
  }

  const rawProjectId = url.searchParams.get("project_id");
  let projectId: string | null = null;
  if (rawProjectId !== null && rawProjectId.trim().length > 0) {
    const parsedProj = parseProjectIdParam(rawProjectId);
    if (!parsedProj.ok) return parsedProj;
    projectId = parsedProj.project_id;
  }

  const rawReqState = url.searchParams.get("request_state");
  let requestState: SalaryAdvanceRequestState | null = null;
  if (rawReqState !== null && rawReqState.trim().length > 0) {
    const upper = rawReqState.trim().toUpperCase();
    if (
      !SALARY_ADVANCE_REQUEST_STATES.includes(
        upper as SalaryAdvanceRequestState,
      )
    ) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
    requestState = upper as SalaryAdvanceRequestState;
  }

  const rawEvState = url.searchParams.get("evidence_review_state");
  let evidenceReviewState: SalaryAdvanceEvidenceReviewState | null = null;
  if (rawEvState !== null && rawEvState.trim().length > 0) {
    const upper = rawEvState.trim().toUpperCase();
    if (
      !SALARY_ADVANCE_EVIDENCE_REVIEW_STATES.includes(
        upper as SalaryAdvanceEvidenceReviewState,
      )
    ) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
    evidenceReviewState = upper as SalaryAdvanceEvidenceReviewState;
  }

  const rawSearch = url.searchParams.get("search");
  const searchRes = validateTextField(
    rawSearch,
    1,
    120,
    true,
    "SALARY_ADVANCE_QUERY_INVALID",
  );
  if (!searchRes.ok) return searchRes;

  const rawCursor = url.searchParams.get("cursor");
  let cursor: string | null = null;
  if (rawCursor !== null && rawCursor.trim().length > 0) {
    const trimmed = rawCursor.trim();
    if (
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        trimmed,
      )
    ) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
    cursor = trimmed;
  }

  const rawPageSize = url.searchParams.get("page_size");
  let pageSize = 25;
  if (rawPageSize !== null && rawPageSize.trim().length > 0) {
    if (!/^\d+$/.test(rawPageSize.trim())) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
    const parsed = Number(rawPageSize.trim());
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
    pageSize = parsed;
  }

  return {
    ok: true,
    value: {
      queue,
      project_id: projectId,
      request_state: requestState,
      evidence_review_state: evidenceReviewState,
      search: searchRes.value,
      cursor,
      page_size: pageSize,
    },
  };
}

export function parseExportSalaryAdvanceRequestsQuery(
  url: URL,
):
  | {
      ok: true;
      value: {
        project_id: string | null;
        request_state: SalaryAdvanceRequestState | null;
        evidence_review_state: SalaryAdvanceEvidenceReviewState | null;
        search: string | null;
      };
    }
  | { ok: false; code: SalaryAdvanceErrorCode } {
  const allowed = new Set([
    "project_id",
    "request_state",
    "evidence_review_state",
    "search",
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
  }

  const rawProjectId = url.searchParams.get("project_id");
  let projectId: string | null = null;
  if (rawProjectId !== null && rawProjectId.trim().length > 0) {
    const parsedProj = parseProjectIdParam(rawProjectId);
    if (!parsedProj.ok) return parsedProj;
    projectId = parsedProj.project_id;
  }

  const rawReqState = url.searchParams.get("request_state");
  let requestState: SalaryAdvanceRequestState | null = null;
  if (rawReqState !== null && rawReqState.trim().length > 0) {
    const upper = rawReqState.trim().toUpperCase();
    if (
      !SALARY_ADVANCE_REQUEST_STATES.includes(
        upper as SalaryAdvanceRequestState,
      )
    ) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
    requestState = upper as SalaryAdvanceRequestState;
  }

  const rawEvState = url.searchParams.get("evidence_review_state");
  let evidenceReviewState: SalaryAdvanceEvidenceReviewState | null = null;
  if (rawEvState !== null && rawEvState.trim().length > 0) {
    const upper = rawEvState.trim().toUpperCase();
    if (
      !SALARY_ADVANCE_EVIDENCE_REVIEW_STATES.includes(
        upper as SalaryAdvanceEvidenceReviewState,
      )
    ) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
    evidenceReviewState = upper as SalaryAdvanceEvidenceReviewState;
  }

  const rawSearch = url.searchParams.get("search");
  const searchRes = validateTextField(
    rawSearch,
    1,
    120,
    true,
    "SALARY_ADVANCE_QUERY_INVALID",
  );
  if (!searchRes.ok) return searchRes;

  return {
    ok: true,
    value: {
      project_id: projectId,
      request_state: requestState,
      evidence_review_state: evidenceReviewState,
      search: searchRes.value,
    },
  };
}

export function parseWorkerPortraitQuery(
  url: URL,
):
  | { ok: true; value: { expected_document_id: string | null } }
  | { ok: false; code: SalaryAdvanceErrorCode } {
  const allowed = new Set(["expected_document_id"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      return { ok: false, code: "SALARY_ADVANCE_QUERY_INVALID" };
    }
  }
  const rawDocId = url.searchParams.get("expected_document_id");
  if (rawDocId === null || rawDocId.trim().length === 0) {
    return { ok: true, value: { expected_document_id: null } };
  }
  const parsed = parseUuidParam(rawDocId, "SALARY_ADVANCE_PORTRAIT_LOCK_INVALID");
  if (!parsed.ok) return parsed;
  return { ok: true, value: { expected_document_id: parsed.id } };
}

export function normalizeSalaryAdvancePersonName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSelfOwnedBankAccountNameMatch(
  workerDisplayName: unknown,
  accountHolderName: unknown,
): boolean {
  const normalizedWorker = normalizeSalaryAdvancePersonName(workerDisplayName);
  const normalizedHolder = normalizeSalaryAdvancePersonName(accountHolderName);
  return normalizedWorker.length > 0 && normalizedWorker === normalizedHolder;
}

export function parseCreateSalaryAdvanceRequestBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | {
      ok: true;
      value: {
        project_id: string;
        worker_entry_id: string;
        requested_amount_vnd: string;
        payment_method: SalaryAdvancePaymentMethod;
        initial_content: string;
        idempotency_key: string;
      };
    }
  | { ok: false; code: SalaryAdvanceErrorCode } {
  if (!isPlainObject(body)) {
    return { ok: false, code: "SALARY_ADVANCE_REQUEST_INVALID" };
  }
  const allowedKeys = new Set([
    "project_id",
    "worker_entry_id",
    "requested_amount_vnd",
    "payment_method",
    "initial_content",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "SALARY_ADVANCE_REQUEST_INVALID" };
    }
  }

  const idem = parseIdempotencyKeyHeader(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  const proj = parseProjectIdParam(
    typeof body.project_id === "string" ? body.project_id : "",
  );
  if (!proj.ok) return proj;

  const worker = parseUuidParam(
    typeof body.worker_entry_id === "string" ? body.worker_entry_id : "",
    "SALARY_ADVANCE_WORKER_INVALID",
  );
  if (!worker.ok) return worker;

  const amount = parsePositiveAmountVnd(body.requested_amount_vnd);
  if (!amount.ok) return amount;

  const rawPaymentMethod =
    typeof body.payment_method === "string"
      ? body.payment_method.trim().toUpperCase()
      : "";
  if (
    !SALARY_ADVANCE_PAYMENT_METHODS.includes(
      rawPaymentMethod as SalaryAdvancePaymentMethod,
    )
  ) {
    return { ok: false, code: "SALARY_ADVANCE_PAYMENT_METHOD_INVALID" };
  }
  const paymentMethod = rawPaymentMethod as SalaryAdvancePaymentMethod;

  const content = validateTextField(
    body.initial_content,
    1,
    2000,
    false,
    "SALARY_ADVANCE_CONTENT_INVALID",
  );
  if (!content.ok || content.value === null) {
    return { ok: false, code: "SALARY_ADVANCE_CONTENT_INVALID" };
  }

  return {
    ok: true,
    value: {
      project_id: proj.project_id,
      worker_entry_id: worker.id,
      requested_amount_vnd: amount.value,
      payment_method: paymentMethod,
      initial_content: content.value,
      idempotency_key: idem.key,
    },
  };
}

export function parsePostSalaryAdvanceMessageBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | {
      ok: true;
      value: {
        expected_version: number;
        message_text: string;
        idempotency_key: string;
      };
    }
  | { ok: false; code: SalaryAdvanceErrorCode } {
  if (!isPlainObject(body)) {
    return { ok: false, code: "SALARY_ADVANCE_REQUEST_INVALID" };
  }
  const allowedKeys = new Set([
    "expected_version",
    "message_text",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "SALARY_ADVANCE_REQUEST_INVALID" };
    }
  }

  const idem = parseIdempotencyKeyHeader(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  const ver = parsePositiveVersion(body.expected_version);
  if (!ver.ok) return ver;

  const msg = validateTextField(
    body.message_text,
    1,
    2000,
    false,
    "SALARY_ADVANCE_MESSAGE_REQUIRED",
  );
  if (!msg.ok || msg.value === null) {
    return { ok: false, code: "SALARY_ADVANCE_MESSAGE_REQUIRED" };
  }

  return {
    ok: true,
    value: {
      expected_version: ver.value,
      message_text: msg.value,
      idempotency_key: idem.key,
    },
  };
}

export function parseTransitionSalaryAdvanceRequestBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | {
      ok: true;
      value: {
        action: SalaryAdvanceTransitionAction;
        expected_version: number;
        message_text: string | null;
        idempotency_key: string;
      };
    }
  | { ok: false; code: SalaryAdvanceErrorCode } {
  if (!isPlainObject(body)) {
    return { ok: false, code: "SALARY_ADVANCE_REQUEST_INVALID" };
  }
  const allowedKeys = new Set([
    "action",
    "expected_version",
    "message_text",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "SALARY_ADVANCE_REQUEST_INVALID" };
    }
  }

  const idem = parseIdempotencyKeyHeader(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  const rawAction =
    typeof body.action === "string" ? body.action.trim().toUpperCase() : "";
  if (
    !SALARY_ADVANCE_TRANSITION_ACTIONS.includes(
      rawAction as SalaryAdvanceTransitionAction,
    )
  ) {
    return { ok: false, code: "SALARY_ADVANCE_ACTION_INVALID" };
  }
  const action = rawAction as SalaryAdvanceTransitionAction;

  const ver = parsePositiveVersion(body.expected_version);
  if (!ver.ok) return ver;

  if (action === "REQUEST_INFO" || action === "PROVIDE_INFO") {
    const msg = validateTextField(
      body.message_text,
      1,
      2000,
      false,
      "SALARY_ADVANCE_MESSAGE_REQUIRED",
    );
    if (!msg.ok || msg.value === null) {
      return { ok: false, code: "SALARY_ADVANCE_MESSAGE_REQUIRED" };
    }
    return {
      ok: true,
      value: {
        action,
        expected_version: ver.value,
        message_text: msg.value,
        idempotency_key: idem.key,
      },
    };
  }

  if (action === "REJECT") {
    const reason = validateTextField(
      body.message_text,
      1,
      1000,
      false,
      "SALARY_ADVANCE_REASON_REQUIRED",
    );
    if (!reason.ok || reason.value === null) {
      return { ok: false, code: "SALARY_ADVANCE_REASON_REQUIRED" };
    }
    return {
      ok: true,
      value: {
        action,
        expected_version: ver.value,
        message_text: reason.value,
        idempotency_key: idem.key,
      },
    };
  }

  const note = validateTextField(
    body.message_text,
    1,
    1000,
    true,
    "SALARY_ADVANCE_NOTE_INVALID",
  );
  if (!note.ok) return note;

  return {
    ok: true,
    value: {
      action,
      expected_version: ver.value,
      message_text: note.value,
      idempotency_key: idem.key,
    },
  };
}

export function parseReserveSalaryAdvanceEvidenceBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | {
      ok: true;
      value: {
        expected_version: number;
        mime_type: SalaryAdvanceEvidenceMimeType;
        size_bytes: number;
        checksum_sha256: string;
        caption_note: string | null;
        idempotency_key: string;
      };
    }
  | { ok: false; code: SalaryAdvanceErrorCode } {
  if (!isPlainObject(body)) {
    return { ok: false, code: "SALARY_ADVANCE_REQUEST_INVALID" };
  }
  const allowedKeys = new Set([
    "expected_version",
    "mime_type",
    "size_bytes",
    "checksum_sha256",
    "caption_note",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "SALARY_ADVANCE_REQUEST_INVALID" };
    }
  }

  const idem = parseIdempotencyKeyHeader(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  const ver = parsePositiveVersion(body.expected_version);
  if (!ver.ok) return ver;

  if (
    body.mime_type !== "image/jpeg" &&
    body.mime_type !== "image/png"
  ) {
    return { ok: false, code: "SALARY_ADVANCE_EVIDENCE_MIME_INVALID" };
  }

  if (
    typeof body.size_bytes !== "number" ||
    !Number.isSafeInteger(body.size_bytes) ||
    body.size_bytes < 1 ||
    body.size_bytes > SALARY_ADVANCE_EVIDENCE_MAX_BYTES
  ) {
    return { ok: false, code: "SALARY_ADVANCE_EVIDENCE_SIZE_INVALID" };
  }

  const rawChecksum =
    typeof body.checksum_sha256 === "string"
      ? body.checksum_sha256.trim().toLowerCase()
      : "";
  if (!SHA256_HEX_REGEX.test(rawChecksum)) {
    return { ok: false, code: "SALARY_ADVANCE_EVIDENCE_CHECKSUM_INVALID" };
  }

  const caption = validateTextField(
    body.caption_note,
    1,
    1000,
    true,
    "SALARY_ADVANCE_NOTE_INVALID",
  );
  if (!caption.ok) return caption;

  return {
    ok: true,
    value: {
      expected_version: ver.value,
      mime_type: body.mime_type,
      size_bytes: body.size_bytes,
      checksum_sha256: rawChecksum,
      caption_note: caption.value,
      idempotency_key: idem.key,
    },
  };
}

export function parseFinalizeSalaryAdvanceEvidenceBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | {
      ok: true;
      value: {
        expected_version: number;
        idempotency_key: string;
      };
    }
  | { ok: false; code: SalaryAdvanceErrorCode } {
  if (!isPlainObject(body)) {
    return { ok: false, code: "SALARY_ADVANCE_REQUEST_INVALID" };
  }
  const allowedKeys = new Set(["expected_version", "idempotency_key"]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "SALARY_ADVANCE_REQUEST_INVALID" };
    }
  }

  const idem = parseIdempotencyKeyHeader(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  const ver = parsePositiveVersion(body.expected_version);
  if (!ver.ok) return ver;

  return {
    ok: true,
    value: {
      expected_version: ver.value,
      idempotency_key: idem.key,
    },
  };
}

export function parseReviewSalaryAdvanceEvidenceBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | {
      ok: true;
      value: {
        expected_version: number;
        evidence_version: number;
        decision: SalaryAdvanceEvidenceReviewDecision;
        evidence_kind: SalaryAdvanceEvidenceKind;
        expected_worker_portrait_document_id: string | null;
        expected_worker_portrait_version: number | null;
        note: string | null;
        idempotency_key: string;
      };
    }
  | { ok: false; code: SalaryAdvanceErrorCode } {
  if (!isPlainObject(body)) {
    return { ok: false, code: "SALARY_ADVANCE_REQUEST_INVALID" };
  }
  const allowedKeys = new Set([
    "expected_version",
    "evidence_version",
    "decision",
    "evidence_kind",
    "expected_worker_portrait_document_id",
    "expected_worker_portrait_version",
    "note",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "SALARY_ADVANCE_REQUEST_INVALID" };
    }
  }

  const idem = parseIdempotencyKeyHeader(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  const ver = parsePositiveVersion(body.expected_version);
  if (!ver.ok) return ver;

  if (
    typeof body.evidence_version !== "number" ||
    !Number.isSafeInteger(body.evidence_version) ||
    body.evidence_version < 1
  ) {
    return { ok: false, code: "SALARY_ADVANCE_EVIDENCE_VERSION_INVALID" };
  }

  const rawDecision =
    typeof body.decision === "string" ? body.decision.trim().toUpperCase() : "";
  if (
    !SALARY_ADVANCE_EVIDENCE_REVIEW_DECISIONS.includes(
      rawDecision as SalaryAdvanceEvidenceReviewDecision,
    )
  ) {
    return { ok: false, code: "SALARY_ADVANCE_DECISION_INVALID" };
  }
  const decision = rawDecision as SalaryAdvanceEvidenceReviewDecision;

  let evidenceKind: SalaryAdvanceEvidenceKind = "CASH_HANDOVER_PHOTO";
  if (body.evidence_kind !== undefined && body.evidence_kind !== null) {
    const rawKind =
      typeof body.evidence_kind === "string"
        ? body.evidence_kind.trim().toUpperCase()
        : "";
    if (
      !SALARY_ADVANCE_EVIDENCE_KINDS.includes(
        rawKind as SalaryAdvanceEvidenceKind,
      )
    ) {
      return { ok: false, code: "SALARY_ADVANCE_REQUEST_INVALID" };
    }
    evidenceKind = rawKind as SalaryAdvanceEvidenceKind;
  }

  let portraitDocId: string | null = null;
  let portraitVer: number | null = null;

  if (evidenceKind === "BANK_TRANSFER_RECEIPT") {
    if (
      (body.expected_worker_portrait_document_id !== undefined &&
        body.expected_worker_portrait_document_id !== null) ||
      (body.expected_worker_portrait_version !== undefined &&
        body.expected_worker_portrait_version !== null)
    ) {
      return { ok: false, code: "SALARY_ADVANCE_PORTRAIT_LOCK_INVALID" };
    }
  } else if (decision === "REVIEWED") {
    const parsedDoc = parseUuidParam(
      typeof body.expected_worker_portrait_document_id === "string"
        ? body.expected_worker_portrait_document_id
        : "",
      "SALARY_ADVANCE_PORTRAIT_LOCK_INVALID",
    );
    if (!parsedDoc.ok) return parsedDoc;
    if (
      typeof body.expected_worker_portrait_version !== "number" ||
      !Number.isSafeInteger(body.expected_worker_portrait_version) ||
      body.expected_worker_portrait_version < 1
    ) {
      return { ok: false, code: "SALARY_ADVANCE_PORTRAIT_LOCK_INVALID" };
    }
    portraitDocId = parsedDoc.id;
    portraitVer = body.expected_worker_portrait_version;
  } else {
    if (
      body.expected_worker_portrait_document_id !== undefined &&
      body.expected_worker_portrait_document_id !== null
    ) {
      const parsedDoc = parseUuidParam(
        typeof body.expected_worker_portrait_document_id === "string"
          ? body.expected_worker_portrait_document_id
          : "",
        "SALARY_ADVANCE_PORTRAIT_LOCK_INVALID",
      );
      if (!parsedDoc.ok) return parsedDoc;
      portraitDocId = parsedDoc.id;
    }
    if (
      body.expected_worker_portrait_version !== undefined &&
      body.expected_worker_portrait_version !== null
    ) {
      if (
        typeof body.expected_worker_portrait_version !== "number" ||
        !Number.isSafeInteger(body.expected_worker_portrait_version) ||
        body.expected_worker_portrait_version < 1
      ) {
        return { ok: false, code: "SALARY_ADVANCE_PORTRAIT_LOCK_INVALID" };
      }
      portraitVer = body.expected_worker_portrait_version;
    }
  }

  // Note is optional for both `REVIEWED` and `RETAKE_REQUIRED`.
  const note = validateTextField(
    body.note,
    1,
    1000,
    true,
    "SALARY_ADVANCE_NOTE_INVALID",
  );
  if (!note.ok) return note;

  return {
    ok: true,
    value: {
      expected_version: ver.value,
      evidence_version: body.evidence_version,
      decision,
      evidence_kind: evidenceKind,
      expected_worker_portrait_document_id: portraitDocId,
      expected_worker_portrait_version: portraitVer,
      note: note.value,
      idempotency_key: idem.key,
    },
  };
}

function sha256Json(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export function computeCreateRequestFingerprint(input: {
  project_id: string;
  worker_entry_id: string;
  requested_amount_vnd: string;
  payment_method?: SalaryAdvancePaymentMethod;
  initial_content: string;
}): string {
  return sha256Json({
    op: "CREATE_REQUEST",
    project_id: input.project_id,
    worker_entry_id: input.worker_entry_id,
    requested_amount_vnd: input.requested_amount_vnd,
    ...(input.payment_method ? { payment_method: input.payment_method } : {}),
    initial_content: input.initial_content,
  });
}

export function computePostMessageFingerprint(input: {
  request_id: string;
  expected_version: number;
  message_text: string;
}): string {
  return sha256Json({
    op: "POST_MESSAGE",
    request_id: input.request_id,
    expected_version: input.expected_version,
    message_text: input.message_text,
  });
}

export function computeTransitionRequestFingerprint(input: {
  request_id: string;
  action: SalaryAdvanceTransitionAction;
  expected_version: number;
  message_text: string | null;
}): string {
  return sha256Json({
    op: "TRANSITION_REQUEST",
    request_id: input.request_id,
    action: input.action,
    expected_version: input.expected_version,
    message_text: input.message_text,
  });
}

export function computeReserveEvidenceFingerprint(input: {
  request_id: string;
  expected_version: number;
  mime_type: SalaryAdvanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  caption_note: string | null;
}): string {
  return sha256Json({
    op: "RESERVE_EVIDENCE",
    request_id: input.request_id,
    expected_version: input.expected_version,
    mime_type: input.mime_type,
    size_bytes: input.size_bytes,
    checksum_sha256: input.checksum_sha256,
    caption_note: input.caption_note,
  });
}

export function computeFinalizeEvidenceFingerprint(input: {
  request_id: string;
  upload_id: string;
  expected_version: number;
}): string {
  return sha256Json({
    op: "FINALIZE_EVIDENCE",
    request_id: input.request_id,
    upload_id: input.upload_id,
    expected_version: input.expected_version,
  });
}

export function computeReviewEvidenceFingerprint(input: {
  request_id: string;
  expected_version: number;
  evidence_version: number;
  decision: SalaryAdvanceEvidenceReviewDecision;
  expected_worker_portrait_document_id: string | null;
  expected_worker_portrait_version: number | null;
  note: string | null;
}): string {
  return sha256Json({
    op: "REVIEW_EVIDENCE",
    request_id: input.request_id,
    expected_version: input.expected_version,
    evidence_version: input.evidence_version,
    decision: input.decision,
    expected_worker_portrait_document_id:
      input.expected_worker_portrait_document_id,
    expected_worker_portrait_version: input.expected_worker_portrait_version,
    note: input.note,
  });
}
