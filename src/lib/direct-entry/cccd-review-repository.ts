import "server-only";

import {
  CCCD_QR_AUTHENTICITY,
  CCCD_QR_SOURCE,
  isCccdQrDocumentType,
  isCccdQrErrorCode,
  isCccdQrErrorField,
  isCccdQrStatus,
  isCccdReconciliationStatus,
  normalizeCccdReconciliationStatus,
  type CccdQrCandidateData,
  type CccdQrErrorCode,
  type CccdQrErrorField,
  type CccdQrFieldMergePreview,
  type CccdQrStatus,
  type CccdReconciliationStatus,
} from "./cccd-qr-contract.ts";
import {
  projectReconciliationSummary,
  type CccdReconciliationSummary,
} from "./cccd-qr-repository.ts";
import {
  isCccdReviewStatusFilter,
  type CccdReviewDocumentSummary,
  type CccdReviewEnteredDetails,
  type CccdReviewQrSummary,
  type CccdReviewQueueItem,
  type CccdReviewQueueResponse,
  type CccdReviewQueueSummary,
  type CccdReviewResolveRequest,
  type CccdReviewStatusFilter,
} from "./cccd-review-contract.ts";
import type { OperationResult } from "./write-repository.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type CccdReviewResolveResult = {
  entry_id: string;
  entry_version: number;
  reused: boolean;
  action: "UPDATE_ENTERED_CCCD" | "STANDARDIZE_FROM_QR" | "MANUAL_UPDATE_DETAILS";
  changed_fields: string[];
  reconciliation: CccdReconciliationSummary;
};

export type CccdReviewResolveOutcome =
  | { ok: true; data: CccdReviewResolveResult }
  | {
      ok: false;
      kind: Exclude<OperationResult, { ok: true }>["kind"];
      error_code?: string;
    };

export type CccdReviewRepository = {
  listReviewQueue(input: {
    auth_subject: string;
    app_user_id: string;
    status_filter: CccdReviewStatusFilter;
    limit: number;
    offset: number;
  }): Promise<OperationResult<CccdReviewQueueResponse>>;

  resolveReview(input: {
    auth_subject: string;
    app_user_id: string;
    entry_id: string;
    request: CccdReviewResolveRequest;
    idempotency_key: string;
  }): Promise<CccdReviewResolveOutcome>;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyReviewError(error: { code?: string; message?: string }): {
  kind: Exclude<OperationResult, { ok: true }>["kind"];
  error_code?: string;
} {
  if (error.code === "42501") return { kind: "denied" };
  if (error.code === "P0002") return { kind: "not-found" };
  if (error.code === "40001") return { kind: "conflict" };
  if (error.code === "23505") {
    if (error.message === "worker_active_episode_exists") {
      return { kind: "invalid", error_code: "WORKER_ACTIVE_EPISODE_EXISTS" };
    }
    if (error.message === "worker_episode_reopen_forbidden") {
      return { kind: "invalid", error_code: "WORKER_EPISODE_REOPEN_FORBIDDEN" };
    }
    return { kind: "conflict" };
  }
  if (error.code === "22023") {
    if (error.message === "NATIONAL_ID_INVALID") {
      return { kind: "invalid", error_code: "NATIONAL_ID_INVALID" };
    }
    return { kind: "invalid" };
  }
  console.error("[direct-entry] cccd review RPC failed");
  return { kind: "unavailable" };
}

function projectCandidateData(value: unknown): CccdQrCandidateData | null {
  if (!isRecord(value)) return null;
  if (
    value.source !== CCCD_QR_SOURCE ||
    value.authenticity !== CCCD_QR_AUTHENTICITY ||
    typeof value.national_id !== "string" ||
    !/^\d{12}$/.test(value.national_id) ||
    typeof value.display_name !== "string" ||
    value.display_name.trim().length < 1 ||
    typeof value.date_of_birth !== "string" ||
    typeof value.date_of_birth_iso !== "string" ||
    (value.gender !== "MALE" && value.gender !== "FEMALE" && value.gender !== "OTHER") ||
    (value.gender_label !== "Nam" && value.gender_label !== "Nữ" && value.gender_label !== "Khác") ||
    typeof value.address !== "string" ||
    value.address.trim().length < 1 ||
    typeof value.national_id_issued_at !== "string" ||
    typeof value.national_id_issued_at_iso !== "string"
  ) {
    return null;
  }
  return {
    source: CCCD_QR_SOURCE,
    authenticity: CCCD_QR_AUTHENTICITY,
    national_id: value.national_id,
    display_name: value.display_name,
    date_of_birth: value.date_of_birth,
    date_of_birth_iso: value.date_of_birth_iso,
    gender: value.gender,
    gender_label: value.gender_label,
    address: value.address,
    national_id_issued_at: value.national_id_issued_at,
    national_id_issued_at_iso: value.national_id_issued_at_iso,
  };
}

function projectFieldMergePreview(value: unknown): CccdQrFieldMergePreview | null {
  if (!isRecord(value)) return null;
  const validStatus = (s: unknown): s is "eligible_blank" | "kept_existing" | "applied_to_blank" =>
    s === "eligible_blank" || s === "kept_existing" || s === "applied_to_blank";
  if (
    !validStatus(value.display_name) ||
    !validStatus(value.national_id) ||
    !validStatus(value.date_of_birth) ||
    !validStatus(value.gender) ||
    !validStatus(value.address) ||
    !validStatus(value.national_id_issued_at)
  ) {
    return null;
  }
  return {
    display_name: value.display_name,
    national_id: value.national_id,
    date_of_birth: value.date_of_birth,
    gender: value.gender,
    address: value.address,
    national_id_issued_at: value.national_id_issued_at,
  };
}

function projectStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

function projectEnteredDetails(value: unknown): CccdReviewEnteredDetails | null {
  if (!isRecord(value)) return null;
  if (typeof value.display_name !== "string") return null;
  if (value.national_id_masked !== null && typeof value.national_id_masked !== "string") return null;
  if (value.national_id !== null && typeof value.national_id !== "string") return null;
  if (value.date_of_birth !== null && typeof value.date_of_birth !== "string") return null;
  if (
    value.gender !== null &&
    value.gender !== "MALE" &&
    value.gender !== "FEMALE" &&
    value.gender !== "OTHER"
  ) {
    return null;
  }
  if (value.address !== null && typeof value.address !== "string") return null;
  if (value.phone !== null && typeof value.phone !== "string") return null;
  if (value.national_id_issued_at !== null && typeof value.national_id_issued_at !== "string") {
    return null;
  }
  if (value.national_id_issued_place !== null && typeof value.national_id_issued_place !== "string") {
    return null;
  }
  return {
    display_name: value.display_name,
    national_id_masked: value.national_id_masked ?? null,
    national_id: value.national_id ?? null,
    date_of_birth: value.date_of_birth ?? null,
    gender: value.gender ?? null,
    address: value.address ?? null,
    phone: value.phone ?? null,
    national_id_issued_at: value.national_id_issued_at ?? null,
    national_id_issued_place: value.national_id_issued_place ?? null,
  };
}

function projectQrSummary(value: unknown): CccdReviewQrSummary | null {
  if (!isRecord(value)) return null;
  if (
    value.extraction_id !== null &&
    (typeof value.extraction_id !== "string" || !UUID_REGEX.test(value.extraction_id))
  ) {
    return null;
  }
  if (
    value.document_id !== null &&
    (typeof value.document_id !== "string" || !UUID_REGEX.test(value.document_id))
  ) {
    return null;
  }
  if (value.document_type !== null && !isCccdQrDocumentType(value.document_type)) {
    return null;
  }
  let status: CccdQrStatus | null = null;
  if (value.status !== null && value.status !== undefined) {
    if (!isCccdQrStatus(value.status)) return null;
    status = value.status;
  }
  let errorCode: CccdQrErrorCode | null = null;
  if (value.error_code !== null && value.error_code !== undefined) {
    if (!isCccdQrErrorCode(value.error_code)) return null;
    errorCode = value.error_code;
  }
  let errorField: CccdQrErrorField | null = null;
  if (value.error_field !== null && value.error_field !== undefined) {
    if (!isCccdQrErrorField(value.error_field)) return null;
    errorField = value.error_field;
  }
  if (value.national_id_masked !== null && typeof value.national_id_masked !== "string") {
    return null;
  }
  if (value.national_id !== null && typeof value.national_id !== "string") {
    return null;
  }
  let candidateData: CccdQrCandidateData | null = null;
  if (value.candidate_data !== null && value.candidate_data !== undefined) {
    candidateData = projectCandidateData(value.candidate_data);
    if (!candidateData) return null;
  }
  let fieldMergePreview: CccdQrFieldMergePreview | null = null;
  if (value.field_merge_preview !== null && value.field_merge_preview !== undefined) {
    fieldMergePreview = projectFieldMergePreview(value.field_merge_preview);
    if (!fieldMergePreview) return null;
  }
  const appliedFields = projectStringArray(value.applied_fields);
  const skippedFields = projectStringArray(value.skipped_fields);
  if (!appliedFields || !skippedFields) return null;
  if (value.completed_at !== null && typeof value.completed_at !== "string") {
    return null;
  }
  return {
    extraction_id: value.extraction_id ?? null,
    document_id: value.document_id ?? null,
    document_type: value.document_type ?? null,
    status,
    error_code: errorCode,
    error_field: errorField,
    national_id_masked: value.national_id_masked ?? null,
    national_id: value.national_id ?? null,
    candidate_data: candidateData,
    field_merge_preview: fieldMergePreview,
    applied_fields: appliedFields,
    skipped_fields: skippedFields,
    completed_at: value.completed_at ?? null,
  };
}

function projectDocumentSummary(value: unknown): CccdReviewDocumentSummary | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.document_id !== "string" ||
    !UUID_REGEX.test(value.document_id) ||
    !isCccdQrDocumentType(value.document_type) ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.mime_type !== "string" ||
    typeof value.size_bytes !== "number" ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 1 ||
    typeof value.updated_at !== "string"
  ) {
    return null;
  }
  let extractionStatus: CccdQrStatus | null = null;
  if (value.extraction_status !== null && value.extraction_status !== undefined) {
    if (!isCccdQrStatus(value.extraction_status)) return null;
    extractionStatus = value.extraction_status;
  }
  let reconciliationStatus: CccdReconciliationStatus | null = null;
  if (value.reconciliation_status !== null && value.reconciliation_status !== undefined) {
    if (!isCccdReconciliationStatus(value.reconciliation_status)) return null;
    reconciliationStatus = value.reconciliation_status;
  }
  let errorCode: CccdQrErrorCode | null = null;
  if (value.error_code !== null && value.error_code !== undefined) {
    if (!isCccdQrErrorCode(value.error_code)) return null;
    errorCode = value.error_code;
  }
  let errorField: CccdQrErrorField | null = null;
  if (value.error_field !== null && value.error_field !== undefined) {
    if (!isCccdQrErrorField(value.error_field)) return null;
    errorField = value.error_field;
  }
  return {
    document_id: value.document_id,
    document_type: value.document_type,
    version: value.version,
    mime_type: value.mime_type,
    size_bytes: value.size_bytes,
    extraction_status: extractionStatus,
    reconciliation_status: reconciliationStatus,
    error_code: errorCode,
    error_field: errorField,
    updated_at: value.updated_at,
  };
}

function extractTriStateText(field: unknown): string | null {
  if (typeof field === "string") return field;
  if (isRecord(field) && field.state === "provided" && typeof field.value === "string") {
    return field.value;
  }
  return null;
}

function extractTriStateGender(field: unknown): "MALE" | "FEMALE" | "OTHER" | null {
  const raw = extractTriStateText(field);
  if (raw === "MALE" || raw === "FEMALE" || raw === "OTHER") return raw;
  return null;
}

function projectSqlQueueItem(value: Record<string, unknown>): CccdReviewQueueItem | null {
  const status = normalizeCccdReconciliationStatus(value.reconciliation_status);
  if (
    typeof value.entry_id !== "string" ||
    !UUID_REGEX.test(value.entry_id) ||
    typeof value.entry_version !== "number" ||
    !Number.isSafeInteger(value.entry_version) ||
    value.entry_version < 1 ||
    typeof value.submission_state !== "string" ||
    typeof value.employee_code !== "string" ||
    typeof value.project_id !== "string" ||
    typeof value.recruiter_id !== "string" ||
    !UUID_REGEX.test(value.recruiter_id) ||
    (value.provider_type !== "hrp" && value.provider_type !== "vendor") ||
    typeof value.labor_type !== "string" ||
    typeof value.first_work_date !== "string" ||
    typeof value.created_by_user_id !== "string" ||
    !UUID_REGEX.test(value.created_by_user_id) ||
    !status ||
    typeof value.updated_at !== "string"
  ) {
    return null;
  }

  const workerDetails = isRecord(value.worker_details) ? value.worker_details : {};
  const displayName =
    typeof workerDetails.display_name === "string"
      ? workerDetails.display_name
      : typeof value.display_name === "string"
        ? value.display_name
        : "";

  const entered: CccdReviewEnteredDetails = {
    display_name: displayName,
    national_id_masked:
      typeof value.entered_national_id_masked === "string"
        ? value.entered_national_id_masked
        : null,
    national_id:
      typeof value.entered_national_id === "string" ? value.entered_national_id : null,
    date_of_birth: extractTriStateText(workerDetails.date_of_birth),
    gender: extractTriStateGender(workerDetails.gender),
    address: extractTriStateText(workerDetails.address),
    phone: extractTriStateText(workerDetails.phone),
    national_id_issued_at: extractTriStateText(workerDetails.national_id_issued_at),
    national_id_issued_place: extractTriStateText(workerDetails.national_id_issued_place),
  };

  let cccdFront: CccdReviewDocumentSummary | null = null;
  let cccdBack: CccdReviewDocumentSummary | null = null;
  let matchedQrStatus: CccdQrStatus | null = null;

  if (Array.isArray(value.documents)) {
    for (const rawDoc of value.documents) {
      if (!isRecord(rawDoc)) continue;
      const docType = isCccdQrDocumentType(rawDoc.document_type) ? rawDoc.document_type : null;
      const docId =
        typeof rawDoc.document_id === "string" && UUID_REGEX.test(rawDoc.document_id)
          ? rawDoc.document_id
          : null;
      const docVersion =
        typeof rawDoc.document_version === "number"
          ? rawDoc.document_version
          : typeof rawDoc.version === "number"
            ? rawDoc.version
            : null;
      if (
        !docType ||
        !docId ||
        docVersion === null ||
        !Number.isSafeInteger(docVersion) ||
        docVersion < 1 ||
        typeof rawDoc.mime_type !== "string" ||
        typeof rawDoc.size_bytes !== "number"
      ) {
        continue;
      }
      const qrStatus = isCccdQrStatus(rawDoc.qr_status) ? rawDoc.qr_status : null;
      const qrRecStatus = normalizeCccdReconciliationStatus(rawDoc.qr_reconciliation_status);
      const qrErrCode = isCccdQrErrorCode(rawDoc.qr_error_code) ? rawDoc.qr_error_code : null;
      const qrErrField = isCccdQrErrorField(rawDoc.qr_error_field) ? rawDoc.qr_error_field : null;
      const summary: CccdReviewDocumentSummary = {
        document_id: docId,
        document_type: docType,
        version: docVersion,
        mime_type: rawDoc.mime_type,
        size_bytes: rawDoc.size_bytes,
        extraction_status: qrStatus,
        reconciliation_status: qrRecStatus,
        error_code: qrErrCode,
        error_field: qrErrField,
        updated_at: value.updated_at,
      };
      if (docType === "CCCD_FRONT" && !cccdFront) cccdFront = summary;
      if (docType === "CCCD_BACK" && !cccdBack) cccdBack = summary;
      if (docId === value.matched_document_id && qrStatus) {
        matchedQrStatus = qrStatus;
      }
    }
  }

  const candidateData = projectCandidateData(value.extracted_fields);
  const autoApplied = projectStringArray(value.auto_applied_fields) ?? [];
  const lastErrorCode = isCccdQrErrorCode(value.last_error_code) ? value.last_error_code : null;
  const lastErrorField = isCccdQrErrorField(value.last_error_field) ? value.last_error_field : null;

  const qr: CccdReviewQrSummary = {
    extraction_id: null,
    document_id:
      typeof value.matched_document_id === "string" && UUID_REGEX.test(value.matched_document_id)
        ? value.matched_document_id
        : null,
    document_type: isCccdQrDocumentType(value.matched_document_type)
      ? value.matched_document_type
      : null,
    status:
      matchedQrStatus ??
      (candidateData
        ? "SUCCEEDED"
        : status === "QR_UNREADABLE"
          ? "NO_QR_FOUND"
          : status === "PENDING"
            ? "PENDING"
            : null),
    error_code: lastErrorCode,
    error_field: lastErrorField,
    national_id_masked:
      typeof value.qr_national_id_masked === "string" ? value.qr_national_id_masked : null,
    national_id: typeof value.qr_national_id === "string" ? value.qr_national_id : null,
    candidate_data: candidateData,
    field_merge_preview: null,
    applied_fields: autoApplied,
    skipped_fields: [],
    completed_at: value.updated_at,
  };

  return {
    entry_id: value.entry_id,
    submission_id:
      typeof value.submission_id === "string" && UUID_REGEX.test(value.submission_id)
        ? value.submission_id
        : value.entry_id,
    submission_state: value.submission_state,
    entry_version: value.entry_version,
    employee_code: value.employee_code,
    display_name: displayName,
    project_id: value.project_id,
    project_name:
      typeof value.project_display === "string"
        ? value.project_display
        : typeof value.project_name === "string"
          ? value.project_name
          : value.project_id,
    recruiter_id: value.recruiter_id,
    recruiter_name:
      typeof value.recruiter_display === "string"
        ? value.recruiter_display
        : typeof value.recruiter_name === "string"
          ? value.recruiter_name
          : "",
    team_id:
      typeof value.team_id === "string" && UUID_REGEX.test(value.team_id) ? value.team_id : null,
    team_code: typeof value.team_code === "string" ? value.team_code : null,
    team_name:
      typeof value.team_display === "string"
        ? value.team_display
        : typeof value.team_name === "string"
          ? value.team_name
          : null,
    provider_type: value.provider_type,
    labor_type: value.labor_type,
    first_work_date: value.first_work_date,
    created_by_user_id: value.created_by_user_id,
    created_by_name:
      typeof value.created_by_display === "string"
        ? value.created_by_display
        : typeof value.created_by_name === "string"
          ? value.created_by_name
          : null,
    created_at:
      typeof value.created_at === "string" ? value.created_at : value.updated_at,
    reconciliation_status: status,
    entered,
    qr,
    documents: {
      cccd_front: cccdFront,
      cccd_back: cccdBack,
    },
    resolved_action:
      typeof value.resolution_action === "string"
        ? value.resolution_action
        : typeof value.resolved_action === "string"
          ? value.resolved_action
          : null,
    resolved_by_user_id:
      typeof value.resolved_by_user_id === "string" && UUID_REGEX.test(value.resolved_by_user_id)
        ? value.resolved_by_user_id
        : null,
    resolved_at: typeof value.resolved_at === "string" ? value.resolved_at : null,
    resolution_reason:
      typeof value.resolution_note === "string"
        ? value.resolution_note
        : typeof value.resolution_reason === "string"
          ? value.resolution_reason
          : null,
    updated_at: value.updated_at,
  };
}

function projectQueueItem(value: unknown): CccdReviewQueueItem | null {
  if (!isRecord(value)) return null;
  if ("worker_details" in value || Array.isArray(value.documents)) {
    return projectSqlQueueItem(value);
  }
  const normalizedStatus = normalizeCccdReconciliationStatus(value.reconciliation_status);
  if (
    typeof value.entry_id !== "string" ||
    !UUID_REGEX.test(value.entry_id) ||
    typeof value.submission_id !== "string" ||
    !UUID_REGEX.test(value.submission_id) ||
    typeof value.submission_state !== "string" ||
    typeof value.entry_version !== "number" ||
    !Number.isSafeInteger(value.entry_version) ||
    value.entry_version < 1 ||
    typeof value.employee_code !== "string" ||
    typeof value.display_name !== "string" ||
    typeof value.project_id !== "string" ||
    typeof value.project_name !== "string" ||
    typeof value.recruiter_id !== "string" ||
    !UUID_REGEX.test(value.recruiter_id) ||
    typeof value.recruiter_name !== "string" ||
    (value.team_id !== null && (typeof value.team_id !== "string" || !UUID_REGEX.test(value.team_id))) ||
    (value.team_code !== null && typeof value.team_code !== "string") ||
    (value.team_name !== null && typeof value.team_name !== "string") ||
    (value.provider_type !== "hrp" && value.provider_type !== "vendor") ||
    typeof value.labor_type !== "string" ||
    typeof value.first_work_date !== "string" ||
    typeof value.created_by_user_id !== "string" ||
    !UUID_REGEX.test(value.created_by_user_id) ||
    (value.created_by_name !== null && typeof value.created_by_name !== "string") ||
    typeof value.created_at !== "string" ||
    !normalizedStatus ||
    !isRecord(value.documents) ||
    (value.resolved_action !== null && typeof value.resolved_action !== "string") ||
    (value.resolved_by_user_id !== null &&
      (typeof value.resolved_by_user_id !== "string" || !UUID_REGEX.test(value.resolved_by_user_id))) ||
    (value.resolved_at !== null && typeof value.resolved_at !== "string") ||
    (value.resolution_reason !== null && typeof value.resolution_reason !== "string") ||
    typeof value.updated_at !== "string"
  ) {
    return null;
  }

  const entered = projectEnteredDetails(value.entered);
  const qr = projectQrSummary(value.qr);
  if (!entered || !qr) return null;

  let cccdFront: CccdReviewDocumentSummary | null = null;
  if (value.documents.cccd_front !== null && value.documents.cccd_front !== undefined) {
    cccdFront = projectDocumentSummary(value.documents.cccd_front);
    if (!cccdFront) return null;
  }
  let cccdBack: CccdReviewDocumentSummary | null = null;
  if (value.documents.cccd_back !== null && value.documents.cccd_back !== undefined) {
    cccdBack = projectDocumentSummary(value.documents.cccd_back);
    if (!cccdBack) return null;
  }

  return {
    entry_id: value.entry_id,
    submission_id: value.submission_id,
    submission_state: value.submission_state,
    entry_version: value.entry_version,
    employee_code: value.employee_code,
    display_name: value.display_name,
    project_id: value.project_id,
    project_name: value.project_name,
    recruiter_id: value.recruiter_id,
    recruiter_name: value.recruiter_name,
    team_id: value.team_id ?? null,
    team_code: value.team_code ?? null,
    team_name: value.team_name ?? null,
    provider_type: value.provider_type,
    labor_type: value.labor_type,
    first_work_date: value.first_work_date,
    created_by_user_id: value.created_by_user_id,
    created_by_name: value.created_by_name ?? null,
    created_at: value.created_at,
    reconciliation_status: normalizedStatus,
    entered,
    qr,
    documents: {
      cccd_front: cccdFront,
      cccd_back: cccdBack,
    },
    resolved_action: value.resolved_action ?? null,
    resolved_by_user_id: value.resolved_by_user_id ?? null,
    resolved_at: value.resolved_at ?? null,
    resolution_reason: value.resolution_reason ?? null,
    updated_at: value.updated_at,
  };
}

function projectQueueSummary(value: unknown): CccdReviewQueueSummary | null {
  if (!isRecord(value)) return null;
  if (typeof value.needs_review === "number" && typeof value.all === "number") {
    const total = Number(value.all) || 0;
    const needsReview = Number(value.needs_review) || 0;
    const mismatch = Number(value.mismatch) || 0;
    const qrUnreadable = Number(value.qr_unreadable) || 0;
    const pending = Number(value.pending) || 0;
    const resolved = Number(value.resolved) || 0;
    return {
      total_count: total,
      needs_review_count: needsReview,
      mismatch_count: mismatch,
      qr_unreadable_count: qrUnreadable,
      pending_count: pending,
      matched_initial_count: Number(value.matched_initial ?? 0) || 0,
      resolved_count: resolved,
    };
  }
  const keys = [
    "total_count",
    "needs_review_count",
    "mismatch_count",
    "qr_unreadable_count",
    "pending_count",
    "matched_initial_count",
    "resolved_count",
  ] as const;
  for (const key of keys) {
    if (
      typeof value[key] !== "number" ||
      !Number.isSafeInteger(value[key]) ||
      (value[key] as number) < 0
    ) {
      return null;
    }
  }
  return {
    total_count: value.total_count as number,
    needs_review_count: value.needs_review_count as number,
    mismatch_count: value.mismatch_count as number,
    qr_unreadable_count: value.qr_unreadable_count as number,
    pending_count: value.pending_count as number,
    matched_initial_count: value.matched_initial_count as number,
    resolved_count: value.resolved_count as number,
  };
}

function projectQueueResponse(
  value: unknown,
  fallback?: { status_filter: CccdReviewStatusFilter; limit: number; offset: number },
): CccdReviewQueueResponse | null {
  if (!isRecord(value)) return null;
  const rawItems = Array.isArray(value.rows)
    ? value.rows
    : Array.isArray(value.items)
      ? value.items
      : null;
  if (!rawItems) return null;

  const summary = projectQueueSummary(value.summary ?? value.counts);
  if (!summary) return null;

  const statusFilter = isCccdReviewStatusFilter(value.status_filter)
    ? value.status_filter
    : fallback?.status_filter ?? "NEEDS_REVIEW";
  const limit =
    typeof value.limit === "number" && Number.isSafeInteger(value.limit) && value.limit >= 1
      ? value.limit
      : typeof value.page_size === "number" && Number.isSafeInteger(value.page_size) && value.page_size >= 1
        ? value.page_size
        : fallback?.limit ?? 50;
  const offset =
    typeof value.offset === "number" && Number.isSafeInteger(value.offset) && value.offset >= 0
      ? value.offset
      : typeof value.page === "number" && Number.isSafeInteger(value.page) && value.page >= 1
        ? (value.page - 1) * limit
        : fallback?.offset ?? 0;
  const totalCount =
    typeof value.total_count === "number" && Number.isSafeInteger(value.total_count) && value.total_count >= 0
      ? value.total_count
      : typeof value.total_items === "number" && Number.isSafeInteger(value.total_items) && value.total_items >= 0
        ? value.total_items
        : 0;

  const rows: CccdReviewQueueItem[] = [];
  for (const item of rawItems) {
    const projected = projectQueueItem(item);
    if (!projected) return null;
    rows.push(projected);
  }

  let scopeKind = typeof value.scope_kind === "string" ? value.scope_kind : "scoped";
  if (!value.scope_kind && rawItems.length > 0 && isRecord(rawItems[0]) && typeof rawItems[0].actor_authority === "string") {
    scopeKind = rawItems[0].actor_authority;
  }

  return {
    scope_kind: scopeKind,
    status_filter: fallback?.status_filter ?? statusFilter,
    limit,
    offset,
    total_count: totalCount,
    summary,
    rows,
  };
}

function projectResolveResult(
  value: unknown,
  fallbackAction?: "UPDATE_ENTERED_CCCD" | "STANDARDIZE_FROM_QR" | "MANUAL_UPDATE_DETAILS",
): CccdReviewResolveResult | null {
  if (!isRecord(value)) return null;
  const reconciliation = projectReconciliationSummary(value.reconciliation);
  if (!reconciliation) return null;
  const action =
    value.action === "UPDATE_ENTERED_CCCD" || value.action === "STANDARDIZE_FROM_QR" || value.action === "MANUAL_UPDATE_DETAILS"
      ? value.action
      : reconciliation.resolved_action === "UPDATE_ENTERED_CCCD" ||
          reconciliation.resolved_action === "STANDARDIZE_FROM_QR" ||
          reconciliation.resolved_action === "MANUAL_UPDATE_DETAILS"
        ? reconciliation.resolved_action
        : fallbackAction;
  if (
    typeof value.entry_id !== "string" ||
    !UUID_REGEX.test(value.entry_id) ||
    typeof value.entry_version !== "number" ||
    !Number.isSafeInteger(value.entry_version) ||
    value.entry_version < 1 ||
    typeof value.reused !== "boolean" ||
    !action
  ) {
    return null;
  }
  const changedFields = projectStringArray(value.changed_fields);
  if (!changedFields) return null;

  return {
    entry_id: value.entry_id,
    entry_version: value.entry_version,
    reused: value.reused,
    action,
    changed_fields: changedFields,
    reconciliation,
  };
}

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await client).rpc(name as never, args as never);
}

export function createCccdReviewRepository(rpc?: Rpc): CccdReviewRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  return {
    async listReviewQueue(input) {
      try {
        const pageSize = Math.min(Math.max(input.limit, 1), 100);
        const page = Math.floor(Math.max(input.offset, 0) / pageSize) + 1;
        const sqlStatusFilter =
          input.status_filter === "MATCHED_INITIAL" ? "RESOLVED" : input.status_filter;
        const { data, error } = await callRpc("direct_entry_list_cccd_review_queue", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_status_filter: sqlStatusFilter,
          p_page: page,
          p_page_size: pageSize,
        });
        if (error) {
          const classified = classifyReviewError(error);
          return {
            ok: false,
            kind: classified.kind,
            ...(classified.error_code ? { error_code: classified.error_code } : {}),
          };
        }
        const projected = projectQueueResponse(data, input);
        return projected ? { ok: true, data: projected } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] list cccd review queue RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },

    async resolveReview(input) {
      try {
        const payload =
          input.request.action === "UPDATE_ENTERED_CCCD"
            ? {
                national_id: input.request.national_id,
                apply_blank_fields: input.request.apply_blank_fields,
                apply_blank_fields_from_qr: input.request.apply_blank_fields,
                reason: input.request.reason,
                note: input.request.reason,
              }
            : input.request.action === "MANUAL_UPDATE_DETAILS"
              ? {
                  national_id: input.request.national_id,
                  display_name: input.request.display_name,
                  date_of_birth: input.request.date_of_birth,
                  gender: input.request.gender,
                  address: input.request.address,
                  national_id_issued_at: input.request.national_id_issued_at,
                  reason: input.request.reason,
                  note: input.request.reason,
                }
              : {
                fields: input.request.fields,
                overwrite_existing: true,
                reason: input.request.reason,
                note: input.request.reason,
              };

        const rpcName = input.request.action === "MANUAL_UPDATE_DETAILS"
          ? "direct_entry_apply_cccd_manual_resolution"
          : "direct_entry_resolve_cccd_review";
        const rpcArgs = {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
          p_expected_entry_version: input.request.expected_entry_version,
          p_payload: payload,
          p_idempotency_key: input.idempotency_key,
        };
        if (rpcName === "direct_entry_resolve_cccd_review") {
          Object.assign(rpcArgs, { p_action: input.request.action });
        }
        const { data, error } = await callRpc(rpcName, rpcArgs);
        if (error) {
          const classified = classifyReviewError(error);
          return {
            ok: false,
            kind: classified.kind,
            ...(classified.error_code ? { error_code: classified.error_code } : {}),
          };
        }
        const projected = projectResolveResult(data, input.request.action);
        return projected ? { ok: true, data: projected } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] resolve cccd review RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}

export function createServiceCccdReviewRepository(): CccdReviewRepository {
  return createCccdReviewRepository();
}
