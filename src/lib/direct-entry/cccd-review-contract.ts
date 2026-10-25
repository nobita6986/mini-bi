import {
  isCccdQrDocumentType,
  isCccdReconciliationStatus,
  type CccdQrCandidateData,
  type CccdQrDocumentType,
  type CccdQrErrorCode,
  type CccdQrErrorField,
  type CccdQrFieldMergePreview,
  type CccdQrStatus,
  type CccdReconciliationStatus,
} from "./cccd-qr-contract.ts";

export const CCCD_REVIEW_STATUS_FILTERS = [
  "NEEDS_REVIEW",
  "MISMATCH",
  "QR_UNREADABLE",
  "PENDING",
  "MATCHED_INITIAL",
  "RESOLVED",
  "ALL",
] as const;
export type CccdReviewStatusFilter = (typeof CCCD_REVIEW_STATUS_FILTERS)[number];

export const CCCD_REVIEW_RESOLVE_ACTIONS = [
  "UPDATE_ENTERED_CCCD",
  "STANDARDIZE_FROM_QR",
] as const;
export type CccdReviewResolveAction = (typeof CCCD_REVIEW_RESOLVE_ACTIONS)[number];

export const CCCD_REVIEW_STANDARDIZE_FIELDS = [
  "national_id",
  "display_name",
  "date_of_birth",
  "gender",
  "address",
  "national_id_issued_at",
] as const;
export type CccdReviewStandardizeField = (typeof CCCD_REVIEW_STANDARDIZE_FIELDS)[number];

export type CccdReviewQueueSummary = {
  total_count: number;
  needs_review_count: number;
  mismatch_count: number;
  qr_unreadable_count: number;
  pending_count: number;
  matched_initial_count: number;
  resolved_count: number;
};

export type CccdReviewEnteredDetails = {
  display_name: string;
  national_id_masked: string | null;
  national_id: string | null;
  date_of_birth: string | null;
  gender: "MALE" | "FEMALE" | "OTHER" | null;
  address: string | null;
  phone: string | null;
  national_id_issued_at: string | null;
  national_id_issued_place: string | null;
};

export type CccdReviewQrSummary = {
  extraction_id: string | null;
  document_id: string | null;
  document_type: CccdQrDocumentType | null;
  status: CccdQrStatus | null;
  error_code: CccdQrErrorCode | null;
  error_field: CccdQrErrorField | null;
  national_id_masked: string | null;
  national_id: string | null;
  candidate_data: CccdQrCandidateData | null;
  field_merge_preview: CccdQrFieldMergePreview | null;
  applied_fields: string[];
  skipped_fields: string[];
  completed_at: string | null;
};

export type CccdReviewDocumentSummary = {
  document_id: string;
  document_type: CccdQrDocumentType;
  version: number;
  mime_type: string;
  size_bytes: number;
  extraction_status: CccdQrStatus | null;
  reconciliation_status: CccdReconciliationStatus | null;
  error_code: CccdQrErrorCode | null;
  error_field: CccdQrErrorField | null;
  updated_at: string;
};

export type CccdReviewQueueItem = {
  entry_id: string;
  submission_id: string;
  submission_state: string;
  entry_version: number;
  employee_code: string;
  display_name: string;
  project_id: string;
  project_name: string;
  recruiter_id: string;
  recruiter_name: string;
  team_id: string | null;
  team_code: string | null;
  team_name: string | null;
  provider_type: "hrp" | "vendor";
  labor_type: string;
  first_work_date: string;
  created_by_user_id: string;
  created_by_name: string | null;
  created_at: string;
  reconciliation_status: CccdReconciliationStatus;
  entered: CccdReviewEnteredDetails;
  qr: CccdReviewQrSummary;
  documents: {
    cccd_front: CccdReviewDocumentSummary | null;
    cccd_back: CccdReviewDocumentSummary | null;
  };
  resolved_action: string | null;
  resolved_by_user_id: string | null;
  resolved_at: string | null;
  resolution_reason: string | null;
  updated_at: string;
};

export type CccdReviewQueueResponse = {
  scope_kind: string;
  status_filter: CccdReviewStatusFilter;
  limit: number;
  offset: number;
  total_count: number;
  summary: CccdReviewQueueSummary;
  rows: CccdReviewQueueItem[];
};

export type CccdReviewResolveRequest =
  | {
      expected_entry_version: number;
      action: "UPDATE_ENTERED_CCCD";
      national_id: string;
      apply_blank_fields: boolean;
      reason: string | null;
    }
  | {
      expected_entry_version: number;
      action: "STANDARDIZE_FROM_QR";
      fields: CccdReviewStandardizeField[];
      reason: string | null;
    };

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOLVE_REQUEST_KEYS = new Set([
  "expected_entry_version",
  "action",
  "national_id",
  "apply_blank_fields",
  "apply_blank_fields_from_qr",
  "fields",
  "reason",
]);

export const CCCD_REVIEW_FILTER_STATUSES = CCCD_REVIEW_STATUS_FILTERS;
export type CccdReviewFilterStatus = CccdReviewStatusFilter;
export type CccdReviewQueuePage = CccdReviewQueueResponse;

export const CCCD_REVIEW_DEFAULT_PAGE_SIZE = 50;
export const CCCD_REVIEW_PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

export const CCCD_REVIEW_FILTER_LABELS: Readonly<Record<CccdReviewStatusFilter, string>> =
  Object.freeze({
    NEEDS_REVIEW: "Cần Review",
    MISMATCH: "Lệch CCCD",
    QR_UNREADABLE: "Không đọc được QR",
    PENDING: "Chờ đọc QR",
    MATCHED_INITIAL: "Khớp ban đầu",
    RESOLVED: "Đã xử lý",
    ALL: "Tất cả",
  });

export const CCCD_REVIEW_STANDARDIZE_FIELD_LABELS: Readonly<
  Record<CccdReviewStandardizeField, string>
> = Object.freeze({
  national_id: "Số CCCD (12 số)",
  display_name: "Họ và tên",
  date_of_birth: "Ngày sinh",
  gender: "Giới tính",
  address: "Địa chỉ thường trú",
  national_id_issued_at: "Ngày cấp CCCD",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCccdReviewStatusFilter(value: unknown): value is CccdReviewStatusFilter {
  return (
    typeof value === "string" &&
    (CCCD_REVIEW_STATUS_FILTERS as readonly string[]).includes(value)
  );
}

export function isCccdReviewResolveAction(value: unknown): value is CccdReviewResolveAction {
  return (
    typeof value === "string" &&
    (CCCD_REVIEW_RESOLVE_ACTIONS as readonly string[]).includes(value)
  );
}

export function isCccdReviewStandardizeField(value: unknown): value is CccdReviewStandardizeField {
  return (
    typeof value === "string" &&
    (CCCD_REVIEW_STANDARDIZE_FIELDS as readonly string[]).includes(value)
  );
}

export function maskNationalIdForDisplay(nationalId: string | null | undefined): string {
  if (typeof nationalId !== "string") return "—";
  const trimmed = nationalId.trim();
  if (trimmed.length === 12 && /^\d{12}$/.test(trimmed)) {
    return `••••••••${trimmed.slice(8)}`;
  }
  return "—";
}

export const maskCccdValue = maskNationalIdForDisplay;

export function buildCccdReviewQueueQuery(input: {
  status: CccdReviewStatusFilter;
  page?: number;
  page_size?: number;
}): URLSearchParams | null {
  if (!isCccdReviewStatusFilter(input.status)) return null;
  const pageSize = input.page_size ?? CCCD_REVIEW_DEFAULT_PAGE_SIZE;
  const page = input.page ?? 1;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 200 ||
    !Number.isSafeInteger(page) ||
    page < 1
  ) {
    return null;
  }
  const offset = (page - 1) * pageSize;
  const params = new URLSearchParams();
  params.set("status", input.status);
  params.set("limit", String(pageSize));
  params.set("offset", String(offset));
  return params;
}

export function projectCccdReviewQueueResponse(
  body: unknown,
): CccdReviewQueueResponse | null {
  if (!isRecord(body)) return null;
  if (
    !isCccdReviewStatusFilter(body.status_filter) ||
    typeof body.limit !== "number" ||
    typeof body.offset !== "number" ||
    typeof body.total_count !== "number" ||
    !isRecord(body.summary) ||
    !Array.isArray(body.rows)
  ) {
    return null;
  }
  return {
    scope_kind: typeof body.scope_kind === "string" ? body.scope_kind : "scoped",
    status_filter: body.status_filter,
    limit: body.limit,
    offset: body.offset,
    total_count: body.total_count,
    summary: {
      total_count: Number(body.summary.total_count ?? 0) || 0,
      needs_review_count: Number(body.summary.needs_review_count ?? 0) || 0,
      mismatch_count: Number(body.summary.mismatch_count ?? 0) || 0,
      qr_unreadable_count: Number(body.summary.qr_unreadable_count ?? 0) || 0,
      pending_count: Number(body.summary.pending_count ?? 0) || 0,
      matched_initial_count: Number(body.summary.matched_initial_count ?? 0) || 0,
      resolved_count: Number(body.summary.resolved_count ?? 0) || 0,
    },
    rows: body.rows as CccdReviewQueueItem[],
  };
}

export function cccdReviewErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case "NATIONAL_ID_INVALID":
      return "Số CCCD không hợp lệ. Vui lòng nhập đúng 12 chữ số.";
    case "WORKER_ACTIVE_EPISODE_EXISTS":
      return "Số CCCD này đang thuộc một hồ sơ người lao động đang làm việc.";
    case "WORKER_EPISODE_REOPEN_FORBIDDEN":
      return "Không thể gán số CCCD này do quy tắc tái tuyển dụng.";
    case "ENTRY_VERSION_CONFLICT":
      return "Hồ sơ vừa được cập nhật bởi thao tác khác. Vui lòng tải lại danh sách.";
    case "CCCD_REVIEW_DENIED":
    case "DOCUMENT_DENIED":
      return "Tài khoản hiện tại không có quyền thực hiện thao tác này trên hồ sơ.";
    default:
      return "Không thực hiện được thao tác Review thông tin NLĐ. Vui lòng thử lại.";
  }
}

export function parseCccdReviewListQuery(searchParams: URLSearchParams): {
  ok: true;
  value: {
    status_filter: CccdReviewStatusFilter;
    limit: number;
    offset: number;
  };
} | {
  ok: false;
  code: string;
} {
  const rawStatus = searchParams.get("status")?.trim().toUpperCase() || "NEEDS_REVIEW";
  if (!isCccdReviewStatusFilter(rawStatus)) {
    return { ok: false, code: "CCCD_REVIEW_FILTER_INVALID" };
  }

  let limit = 50;
  const rawLimit = searchParams.get("limit");
  if (rawLimit !== null && rawLimit.trim() !== "") {
    const parsedLimit = Number(rawLimit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      return { ok: false, code: "CCCD_REVIEW_PAGINATION_INVALID" };
    }
    limit = parsedLimit;
  }

  let offset = 0;
  const rawOffset = searchParams.get("offset");
  if (rawOffset !== null && rawOffset.trim() !== "") {
    const parsedOffset = Number(rawOffset);
    if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0) {
      return { ok: false, code: "CCCD_REVIEW_PAGINATION_INVALID" };
    }
    offset = parsedOffset;
  }

  return {
    ok: true,
    value: {
      status_filter: rawStatus,
      limit,
      offset,
    },
  };
}

export function parseCccdReviewResolveRequest(
  body: unknown,
): { ok: true; value: CccdReviewResolveRequest } | { ok: false; code: string } {
  if (!isRecord(body)) {
    return { ok: false, code: "CCCD_REVIEW_REQUEST_INVALID" };
  }
  for (const key of Object.keys(body)) {
    if (!RESOLVE_REQUEST_KEYS.has(key)) {
      return { ok: false, code: "CCCD_REVIEW_REQUEST_INVALID" };
    }
  }

  if (
    typeof body.expected_entry_version !== "number" ||
    !Number.isSafeInteger(body.expected_entry_version) ||
    body.expected_entry_version < 1
  ) {
    return { ok: false, code: "EXPECTED_ENTRY_VERSION_REQUIRED" };
  }

  if (!isCccdReviewResolveAction(body.action)) {
    return { ok: false, code: "CCCD_REVIEW_ACTION_INVALID" };
  }

  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string" || body.reason.length > 4000) {
      return { ok: false, code: "CCCD_REVIEW_REASON_INVALID" };
    }
    const trimmedReason = body.reason.trim();
    reason = trimmedReason.length > 0 ? trimmedReason : null;
  }

  if (body.action === "UPDATE_ENTERED_CCCD") {
    if (body.fields !== undefined) {
      return { ok: false, code: "CCCD_REVIEW_REQUEST_INVALID" };
    }
    if (typeof body.national_id !== "string") {
      return { ok: false, code: "NATIONAL_ID_INVALID" };
    }
    const nationalId = body.national_id.trim();
    if (!/^\d{12}$/.test(nationalId) || nationalId === "000000000000") {
      return { ok: false, code: "NATIONAL_ID_INVALID" };
    }
    let applyBlankFields = true;
    const rawApplyBlank =
      body.apply_blank_fields !== undefined
        ? body.apply_blank_fields
        : body.apply_blank_fields_from_qr;
    if (rawApplyBlank !== undefined) {
      if (typeof rawApplyBlank !== "boolean") {
        return { ok: false, code: "CCCD_REVIEW_REQUEST_INVALID" };
      }
      applyBlankFields = rawApplyBlank;
    }
    return {
      ok: true,
      value: {
        expected_entry_version: body.expected_entry_version,
        action: "UPDATE_ENTERED_CCCD",
        national_id: nationalId,
        apply_blank_fields: applyBlankFields,
        reason,
      },
    };
  }

  if (body.national_id !== undefined || body.apply_blank_fields !== undefined) {
    return { ok: false, code: "CCCD_REVIEW_REQUEST_INVALID" };
  }

  let fields: CccdReviewStandardizeField[] = [...CCCD_REVIEW_STANDARDIZE_FIELDS];
  if (body.fields !== undefined) {
    if (!Array.isArray(body.fields) || body.fields.length < 1) {
      return { ok: false, code: "CCCD_REVIEW_FIELDS_INVALID" };
    }
    const dedup = new Set<CccdReviewStandardizeField>();
    for (const item of body.fields) {
      if (!isCccdReviewStandardizeField(item)) {
        return { ok: false, code: "CCCD_REVIEW_FIELDS_INVALID" };
      }
      dedup.add(item);
    }
    fields = [...dedup];
  }

  return {
    ok: true,
    value: {
      expected_entry_version: body.expected_entry_version,
      action: "STANDARDIZE_FROM_QR",
      fields,
      reason,
    },
  };
}

export function isValidReviewEntryId(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value.trim());
}

export { isCccdQrDocumentType, isCccdReconciliationStatus };
