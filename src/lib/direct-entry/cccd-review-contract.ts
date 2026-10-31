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
  "MANUAL_UPDATE_DETAILS",
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
    }
  | {
      expected_entry_version: number;
      action: "MANUAL_UPDATE_DETAILS";
      national_id: string;
      display_name: string;
      date_of_birth: string | null;
      gender: "MALE" | "FEMALE" | "OTHER" | null;
      address: string | null;
      national_id_issued_at: string | null;
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
  "display_name",
  "date_of_birth",
  "gender",
  "address",
  "national_id_issued_at",
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

  if (body.action === "MANUAL_UPDATE_DETAILS") {
    if (
      body.fields !== undefined ||
      body.apply_blank_fields !== undefined ||
      body.apply_blank_fields_from_qr !== undefined
    ) {
      return { ok: false, code: "CCCD_REVIEW_REQUEST_INVALID" };
    }
    if (
      typeof body.national_id !== "string" ||
      !/^\d{12}$/.test(body.national_id.trim()) ||
      body.national_id.trim() === "000000000000"
    ) {
      return { ok: false, code: "NATIONAL_ID_INVALID" };
    }
    if (
      typeof body.display_name !== "string" ||
      body.display_name.trim().length > 256 ||
      /[\u0000-\u001f\u007f]/.test(body.display_name)
    ) {
      return { ok: false, code: "CCCD_REVIEW_REQUEST_INVALID" };
    }
    const optionalText = (
      key: "date_of_birth" | "address" | "national_id_issued_at",
      max: number,
    ) => {
      const value = body[key];
      if (
        value === undefined ||
        value === null ||
        (typeof value === "string" && value.trim() === "")
      ) {
        return { ok: true as const, value: null };
      }
      if (
        typeof value !== "string" ||
        value.trim().length > max ||
        /[\u0000-\u001f\u007f]/.test(value)
      ) {
        return { ok: false as const };
      }
      return { ok: true as const, value: value.trim() };
    };
    const dob = optionalText("date_of_birth", 10);
    const address = optionalText("address", 1024);
    const issuedAt = optionalText("national_id_issued_at", 10);
    const gender = body.gender;
    if (
      !dob.ok ||
      !address.ok ||
      !issuedAt.ok ||
      (gender !== undefined &&
        gender !== null &&
        gender !== "MALE" &&
        gender !== "FEMALE" &&
        gender !== "OTHER")
    ) {
      return { ok: false, code: "CCCD_REVIEW_REQUEST_INVALID" };
    }
    return {
      ok: true,
      value: {
        expected_entry_version: body.expected_entry_version,
        action: "MANUAL_UPDATE_DETAILS",
        national_id: body.national_id.trim(),
        display_name: body.display_name.trim(),
        date_of_birth: dob.value,
        gender: gender === undefined ? null : gender as "MALE" | "FEMALE" | "OTHER" | null,
        address: address.value,
        national_id_issued_at: issuedAt.value,
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

export const REVIEW_PANEL_MODES = ["CCCD_RECONCILIATION", "MISSING_DOCUMENTS"] as const;
export type ReviewPanelMode = (typeof REVIEW_PANEL_MODES)[number];

export const MISSING_DOCUMENT_TYPES = [
  "WORKER_PORTRAIT",
  "CCCD_FRONT",
  "CCCD_BACK",
  "EMPLOYMENT_CONTRACT",
] as const;
export type MissingDocumentType = (typeof MISSING_DOCUMENT_TYPES)[number];

export const MISSING_DOCUMENT_FILTER_TYPES = ["ALL", ...MISSING_DOCUMENT_TYPES] as const;
export type MissingDocumentFilterType = (typeof MISSING_DOCUMENT_FILTER_TYPES)[number];

export const MISSING_DOCUMENT_EMPLOYMENT_STATUSES = ["ALL", "ON", "UNCONFIRMED"] as const;
export type MissingDocumentEmploymentStatus =
  (typeof MISSING_DOCUMENT_EMPLOYMENT_STATUSES)[number];

export const MISSING_DOCUMENT_TYPE_LABELS: Readonly<Record<MissingDocumentType, string>> =
  Object.freeze({
    WORKER_PORTRAIT: "Ảnh NLĐ",
    CCCD_FRONT: "CCCD mặt trước",
    CCCD_BACK: "CCCD mặt sau",
    EMPLOYMENT_CONTRACT: "Hợp đồng lao động",
  });

export const MISSING_DOCUMENT_FILTER_LABELS: Readonly<Record<MissingDocumentFilterType, string>> =
  Object.freeze({
    ALL: "Tất cả hồ sơ thiếu",
    WORKER_PORTRAIT: "Thiếu Ảnh NLĐ",
    CCCD_FRONT: "Thiếu CCCD mặt trước",
    CCCD_BACK: "Thiếu CCCD mặt sau",
    EMPLOYMENT_CONTRACT: "Thiếu Hợp đồng lao động",
  });

export const MISSING_DOCUMENT_EMPLOYMENT_STATUS_LABELS: Readonly<
  Record<MissingDocumentEmploymentStatus, string>
> = Object.freeze({
  ALL: "Tất cả (Đang làm + Chưa xác nhận)",
  ON: "Đang làm việc (ON)",
  UNCONFIRMED: "Chưa xác nhận (UNCONFIRMED)",
});

export type MissingDocumentExistingDoc = {
  document_id: string;
  document_type: MissingDocumentType;
  document_version: number;
  mime_type: string;
  size_bytes: number;
  updated_at: string;
};

export type MissingDocumentWorkerItem = {
  entry_id: string;
  entry_version: number;
  employee_code: string;
  display_name: string;
  national_id: string | null;
  project_id: string;
  project_display: string;
  recruiter_id: string;
  recruiter_display: string;
  first_work_date: string;
  employment_status: "ON" | "UNCONFIRMED";
  created_by_user_id: string;
  created_by_display: string;
  missing_documents: MissingDocumentType[];
  can_upload: boolean;
  documents: MissingDocumentExistingDoc[];
};

export type MissingDocumentSummary = {
  total_workers: number;
  missing_worker_portrait: number;
  missing_cccd_front: number;
  missing_cccd_back: number;
  missing_employment_contract: number;
};

export type MissingDocumentProjectOption = {
  project_id: string;
  project_display: string;
};

export type MissingDocumentWorkersResponse = {
  scope_kind: "all" | "project" | "recruited";
  can_upload: boolean;
  filter_missing_type: MissingDocumentFilterType;
  filter_employment_status: MissingDocumentEmploymentStatus;
  filter_project_id: string | null;
  filter_search: string | null;
  page: number;
  page_size: number;
  total_count: number;
  has_more: boolean;
  summary: MissingDocumentSummary;
  project_options: MissingDocumentProjectOption[];
  items: MissingDocumentWorkerItem[];
};

export function isMissingDocumentType(value: unknown): value is MissingDocumentType {
  return (
    typeof value === "string" &&
    (MISSING_DOCUMENT_TYPES as readonly string[]).includes(value)
  );
}

export function isMissingDocumentFilterType(value: unknown): value is MissingDocumentFilterType {
  return (
    typeof value === "string" &&
    (MISSING_DOCUMENT_FILTER_TYPES as readonly string[]).includes(value)
  );
}

export function isMissingDocumentEmploymentStatus(
  value: unknown,
): value is MissingDocumentEmploymentStatus {
  return (
    typeof value === "string" &&
    (MISSING_DOCUMENT_EMPLOYMENT_STATUSES as readonly string[]).includes(value)
  );
}

export function hasMissingDocumentWorkersFilter(input: {
  missing_type?: MissingDocumentFilterType;
  employment_status?: MissingDocumentEmploymentStatus;
  project_id?: string | null;
  q?: string | null;
}): boolean {
  return (
    (input.missing_type ?? "ALL") !== "ALL" ||
    (input.employment_status ?? "ALL") !== "ALL" ||
    Boolean(input.project_id?.trim()) ||
    Boolean(input.q?.trim())
  );
}

export function buildMissingDocumentWorkersQuery(input: {
  missing_type?: MissingDocumentFilterType;
  employment_status?: MissingDocumentEmploymentStatus;
  project_id?: string | null;
  q?: string | null;
  page?: number;
  page_size?: number;
}): URLSearchParams | null {
  const missingType = input.missing_type ?? "ALL";
  const employmentStatus = input.employment_status ?? "ALL";
  if (
    !isMissingDocumentFilterType(missingType) ||
    !isMissingDocumentEmploymentStatus(employmentStatus)
  ) {
    return null;
  }
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? 25;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  ) {
    return null;
  }
  const params = new URLSearchParams();
  params.set("missing_type", missingType);
  params.set("employment_status", employmentStatus);
  if (typeof input.project_id === "string" && input.project_id.trim() !== "") {
    params.set("project_id", input.project_id.trim());
  }
  if (typeof input.q === "string" && input.q.trim() !== "") {
    params.set("q", input.q.trim());
  }
  params.set("page", String(page));
  params.set("page_size", String(pageSize));
  return params;
}

export function parseMissingDocumentWorkersQuery(searchParams: URLSearchParams):
  | {
      ok: true;
      value: {
        missing_type: MissingDocumentFilterType;
        employment_status: MissingDocumentEmploymentStatus;
        project_id: string | null;
        search: string | null;
        page: number;
        page_size: number;
      };
    }
  | {
      ok: false;
      code: string;
    } {
  const rawMissingType = searchParams.get("missing_type")?.trim().toUpperCase() || "ALL";
  if (!isMissingDocumentFilterType(rawMissingType)) {
    return { ok: false, code: "MISSING_DOCUMENTS_FILTER_INVALID" };
  }

  const rawEmploymentStatus = searchParams.get("employment_status")?.trim().toUpperCase() || "ALL";
  if (!isMissingDocumentEmploymentStatus(rawEmploymentStatus)) {
    return { ok: false, code: "MISSING_DOCUMENTS_FILTER_INVALID" };
  }

  let projectId: string | null = null;
  const rawProjectId = searchParams.get("project_id");
  if (rawProjectId !== null && rawProjectId.trim() !== "") {
    const trimmed = rawProjectId.trim();
    if (trimmed.length > 128 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      return { ok: false, code: "MISSING_DOCUMENTS_FILTER_INVALID" };
    }
    projectId = trimmed;
  }

  let search: string | null = null;
  const rawSearch = searchParams.get("q");
  if (rawSearch !== null && rawSearch.trim() !== "") {
    const trimmed = rawSearch.trim();
    if (trimmed.length > 100 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      return { ok: false, code: "MISSING_DOCUMENTS_FILTER_INVALID" };
    }
    search = trimmed;
  }

  if (
    !hasMissingDocumentWorkersFilter({
      missing_type: rawMissingType,
      employment_status: rawEmploymentStatus,
      project_id: projectId,
      q: search,
    })
  ) {
    return { ok: false, code: "MISSING_DOCUMENTS_FILTER_REQUIRED" };
  }

  let page = 1;
  const rawPage = searchParams.get("page");
  if (rawPage !== null && rawPage.trim() !== "") {
    const parsedPage = Number(rawPage);
    if (!Number.isSafeInteger(parsedPage) || parsedPage < 1 || parsedPage > 1000) {
      return { ok: false, code: "MISSING_DOCUMENTS_PAGINATION_INVALID" };
    }
    page = parsedPage;
  }

  let pageSize = 25;
  const rawPageSize = searchParams.get("page_size");
  if (rawPageSize !== null && rawPageSize.trim() !== "") {
    const parsedPageSize = Number(rawPageSize);
    if (!Number.isSafeInteger(parsedPageSize) || parsedPageSize < 1 || parsedPageSize > 100) {
      return { ok: false, code: "MISSING_DOCUMENTS_PAGINATION_INVALID" };
    }
    pageSize = parsedPageSize;
  }

  return {
    ok: true,
    value: {
      missing_type: rawMissingType,
      employment_status: rawEmploymentStatus,
      project_id: projectId,
      search,
      page,
      page_size: pageSize,
    },
  };
}

export function projectMissingDocumentWorkersResponse(
  body: unknown,
): MissingDocumentWorkersResponse | null {
  if (!isRecord(body)) return null;
  const scopeKind = body.scope_kind;
  if (scopeKind !== "all" && scopeKind !== "project" && scopeKind !== "recruited") {
    return null;
  }
  if (
    typeof body.can_upload !== "boolean" ||
    !isMissingDocumentFilterType(body.filter_missing_type) ||
    !isMissingDocumentEmploymentStatus(body.filter_employment_status) ||
    (body.filter_project_id !== null && typeof body.filter_project_id !== "string") ||
    (body.filter_search !== null && typeof body.filter_search !== "string") ||
    typeof body.page !== "number" ||
    !Number.isSafeInteger(body.page) ||
    body.page < 1 ||
    typeof body.page_size !== "number" ||
    !Number.isSafeInteger(body.page_size) ||
    body.page_size < 1 ||
    typeof body.total_count !== "number" ||
    !Number.isSafeInteger(body.total_count) ||
    body.total_count < 0 ||
    typeof body.has_more !== "boolean" ||
    !isRecord(body.summary) ||
    !Array.isArray(body.project_options) ||
    !Array.isArray(body.items)
  ) {
    return null;
  }

  const summary: MissingDocumentSummary = {
    total_workers: Number(body.summary.total_workers ?? 0) || 0,
    missing_worker_portrait: Number(body.summary.missing_worker_portrait ?? 0) || 0,
    missing_cccd_front: Number(body.summary.missing_cccd_front ?? 0) || 0,
    missing_cccd_back: Number(body.summary.missing_cccd_back ?? 0) || 0,
    missing_employment_contract: Number(body.summary.missing_employment_contract ?? 0) || 0,
  };

  const projectOptions: MissingDocumentProjectOption[] = [];
  for (const rawOpt of body.project_options) {
    if (
      !isRecord(rawOpt) ||
      typeof rawOpt.project_id !== "string" ||
      rawOpt.project_id.trim() === "" ||
      typeof rawOpt.project_display !== "string"
    ) {
      return null;
    }
    projectOptions.push({
      project_id: rawOpt.project_id,
      project_display: rawOpt.project_display,
    });
  }

  const items: MissingDocumentWorkerItem[] = [];
  for (const rawItem of body.items) {
    if (
      !isRecord(rawItem) ||
      typeof rawItem.entry_id !== "string" ||
      !UUID_REGEX.test(rawItem.entry_id) ||
      typeof rawItem.entry_version !== "number" ||
      !Number.isSafeInteger(rawItem.entry_version) ||
      rawItem.entry_version < 1 ||
      typeof rawItem.employee_code !== "string" ||
      typeof rawItem.display_name !== "string" ||
      (rawItem.national_id !== null && typeof rawItem.national_id !== "string") ||
      typeof rawItem.project_id !== "string" ||
      typeof rawItem.project_display !== "string" ||
      typeof rawItem.recruiter_id !== "string" ||
      !UUID_REGEX.test(rawItem.recruiter_id) ||
      typeof rawItem.recruiter_display !== "string" ||
      typeof rawItem.first_work_date !== "string" ||
      (rawItem.employment_status !== "ON" && rawItem.employment_status !== "UNCONFIRMED") ||
      typeof rawItem.created_by_user_id !== "string" ||
      !UUID_REGEX.test(rawItem.created_by_user_id) ||
      typeof rawItem.created_by_display !== "string" ||
      typeof rawItem.can_upload !== "boolean" ||
      !Array.isArray(rawItem.missing_documents) ||
      !Array.isArray(rawItem.documents)
    ) {
      return null;
    }

    const missingDocs: MissingDocumentType[] = [];
    for (const m of rawItem.missing_documents) {
      if (!isMissingDocumentType(m)) return null;
      missingDocs.push(m);
    }

    const docs: MissingDocumentExistingDoc[] = [];
    for (const d of rawItem.documents) {
      if (
        !isRecord(d) ||
        "storage_key" in d ||
        typeof d.document_id !== "string" ||
        !UUID_REGEX.test(d.document_id) ||
        !isMissingDocumentType(d.document_type) ||
        typeof d.document_version !== "number" ||
        !Number.isSafeInteger(d.document_version) ||
        d.document_version < 1 ||
        typeof d.mime_type !== "string" ||
        typeof d.size_bytes !== "number" ||
        !Number.isSafeInteger(d.size_bytes) ||
        d.size_bytes < 1 ||
        typeof d.updated_at !== "string"
      ) {
        return null;
      }
      docs.push({
        document_id: d.document_id,
        document_type: d.document_type,
        document_version: d.document_version,
        mime_type: d.mime_type,
        size_bytes: d.size_bytes,
        updated_at: d.updated_at,
      });
    }

    items.push({
      entry_id: rawItem.entry_id,
      entry_version: rawItem.entry_version,
      employee_code: rawItem.employee_code,
      display_name: rawItem.display_name,
      national_id: rawItem.national_id ?? null,
      project_id: rawItem.project_id,
      project_display: rawItem.project_display,
      recruiter_id: rawItem.recruiter_id,
      recruiter_display: rawItem.recruiter_display,
      first_work_date: rawItem.first_work_date,
      employment_status: rawItem.employment_status,
      created_by_user_id: rawItem.created_by_user_id,
      created_by_display: rawItem.created_by_display,
      missing_documents: missingDocs,
      can_upload: rawItem.can_upload,
      documents: docs,
    });
  }

  return {
    scope_kind: scopeKind,
    can_upload: body.can_upload,
    filter_missing_type: body.filter_missing_type,
    filter_employment_status: body.filter_employment_status,
    filter_project_id: body.filter_project_id ?? null,
    filter_search: body.filter_search ?? null,
    page: body.page,
    page_size: body.page_size,
    total_count: body.total_count,
    has_more: body.has_more,
    summary,
    project_options: projectOptions,
    items,
  };
}

export { isCccdQrDocumentType, isCccdReconciliationStatus };
