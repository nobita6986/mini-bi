import "server-only";

import { createServiceSupabaseClient } from "../supabase/server.ts";
import {
  isOpaqueSalaryAdvanceEvidenceStorageKey,
  isOpaqueWorkerPortraitStorageKey,
} from "./r2-salary-advance-evidence-storage.ts";
import {
  isPlainObject,
  type SalaryAdvanceActorContext,
  type SalaryAdvanceErrorCode,
  type SalaryAdvanceEvidenceMimeType,
  type SalaryAdvanceEvidenceReviewDecision,
  type SalaryAdvanceEvidenceReviewState,
  type SalaryAdvanceHistoryPeriodMode,
  type SalaryAdvanceMutationDetailResponse,
  type SalaryAdvancePaymentMethod,
  type SalaryAdvanceQueue,
  type SalaryAdvanceRequestDetail,
  type SalaryAdvanceRequestListResponse,
  type SalaryAdvanceRequestState,
  type SalaryAdvanceTransitionAction,
  type SalaryAdvanceWorkerHistoryResponse,
  type SalaryAdvanceWorkerListResponse,
} from "./salary-advance-contract.ts";

export type SalaryAdvanceRpcCaller = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type SalaryAdvanceActorRef = {
  auth_subject: string;
  app_user_id: string;
};

export type SalaryAdvanceRepoResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: SalaryAdvanceErrorCode };

export type SalaryAdvanceReserveEvidenceRecord = {
  request_id: string;
  upload_id: string;
  expected_version: number;
  storage_key: string;
  mime_type: SalaryAdvanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  expires_at: string;
  superseded_storage_key: string | null;
  replayed: boolean;
};

export type SalaryAdvanceFinalizeContextRecord =
  | {
      status: "REPLAYED";
      result_payload: SalaryAdvanceMutationDetailResponse;
    }
  | {
      status: "READY_TO_FINALIZE";
      request_id: string;
      upload_id: string;
      expected_version: number;
      storage_key: string;
      mime_type: SalaryAdvanceEvidenceMimeType;
      size_bytes: number;
      checksum_sha256: string;
    };

export type SalaryAdvanceEvidencePreviewContextRecord = {
  request_id: string;
  evidence_version: number;
  storage_key: string;
  mime_type: SalaryAdvanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
};

export type SalaryAdvanceWorkerPortraitContextRecord = {
  request_id: string;
  worker_entry_id: string;
  document_id: string;
  version: number;
  storage_key: string;
  mime_type: SalaryAdvanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
};

export type SalaryAdvanceRepository = {
  getActorContext(
    actor: SalaryAdvanceActorRef,
  ): Promise<SalaryAdvanceRepoResult<SalaryAdvanceActorContext>>;

  listProjectWorkers(
    input: SalaryAdvanceActorRef & {
      project_id: string;
      search: string | null;
      cursor: string | null;
      page_size: number;
    },
  ): Promise<SalaryAdvanceRepoResult<SalaryAdvanceWorkerListResponse>>;

  listRequests(
    input: SalaryAdvanceActorRef & {
      queue: SalaryAdvanceQueue;
      project_id: string | null;
      request_state: SalaryAdvanceRequestState | null;
      evidence_review_state: SalaryAdvanceEvidenceReviewState | null;
      search: string | null;
      cursor: string | null;
      page_size: number;
    },
  ): Promise<SalaryAdvanceRepoResult<SalaryAdvanceRequestListResponse>>;

  getRequestDetail(
    input: SalaryAdvanceActorRef & {
      request_id: string;
    },
  ): Promise<SalaryAdvanceRepoResult<SalaryAdvanceRequestDetail>>;

  createRequest(
    input: SalaryAdvanceActorRef & {
      project_id: string;
      worker_entry_id: string;
      requested_amount_vnd: string;
      payment_method?: SalaryAdvancePaymentMethod;
      initial_content: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<SalaryAdvanceRepoResult<SalaryAdvanceMutationDetailResponse>>;

  postMessage(
    input: SalaryAdvanceActorRef & {
      request_id: string;
      expected_version: number;
      message_text: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<SalaryAdvanceRepoResult<SalaryAdvanceMutationDetailResponse>>;

  transitionRequest(
    input: SalaryAdvanceActorRef & {
      request_id: string;
      action: SalaryAdvanceTransitionAction;
      expected_version: number;
      message_text: string | null;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<SalaryAdvanceRepoResult<SalaryAdvanceMutationDetailResponse>>;

  reserveEvidence(
    input: SalaryAdvanceActorRef & {
      request_id: string;
      expected_version: number;
      mime_type: SalaryAdvanceEvidenceMimeType;
      size_bytes: number;
      checksum_sha256: string;
      caption_note: string | null;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<SalaryAdvanceRepoResult<SalaryAdvanceReserveEvidenceRecord>>;

  getEvidenceFinalizeContext(
    input: SalaryAdvanceActorRef & {
      request_id: string;
      upload_id: string;
      expected_version: number;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<SalaryAdvanceRepoResult<SalaryAdvanceFinalizeContextRecord>>;

  finalizeEvidence(
    input: SalaryAdvanceActorRef & {
      request_id: string;
      upload_id: string;
      expected_version: number;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<SalaryAdvanceRepoResult<SalaryAdvanceMutationDetailResponse>>;

  reviewEvidence(
    input: SalaryAdvanceActorRef & {
      request_id: string;
      expected_version: number;
      evidence_version: number;
      decision: SalaryAdvanceEvidenceReviewDecision;
      expected_worker_portrait_document_id: string | null;
      expected_worker_portrait_version: number | null;
      note: string | null;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<SalaryAdvanceRepoResult<SalaryAdvanceMutationDetailResponse>>;

  getEvidencePreviewContext(
    input: SalaryAdvanceActorRef & {
      request_id: string;
      evidence_version: number | null;
    },
  ): Promise<
    SalaryAdvanceRepoResult<SalaryAdvanceEvidencePreviewContextRecord>
  >;

  getWorkerPortraitContext(
    input: SalaryAdvanceActorRef & {
      request_id: string;
      expected_document_id: string | null;
    },
  ): Promise<SalaryAdvanceRepoResult<SalaryAdvanceWorkerPortraitContextRecord>>;

  listWorkerHistory(
    input: SalaryAdvanceActorRef & {
      request_id: string;
      period_mode: SalaryAdvanceHistoryPeriodMode;
      month: string | null;
      from_date: string | null;
      to_date: string | null;
      cursor: string | null;
      page_size: number;
    },
  ): Promise<SalaryAdvanceRepoResult<SalaryAdvanceWorkerHistoryResponse>>;
};

const KNOWN_ERROR_MESSAGES: ReadonlySet<SalaryAdvanceErrorCode> = new Set([
  "SALARY_ADVANCE_ACCESS_DENIED",
  "SALARY_ADVANCE_QUERY_INVALID",
  "SALARY_ADVANCE_PROJECT_INVALID",
  "SALARY_ADVANCE_PROJECT_NOT_FOUND",
  "SALARY_ADVANCE_PROJECT_INACTIVE",
  "SALARY_ADVANCE_PROJECT_ACCOUNTANT_UNASSIGNED",
  "SALARY_ADVANCE_WORKER_INVALID",
  "SALARY_ADVANCE_WORKER_NOT_FOUND",
  "SALARY_ADVANCE_WORKER_PROJECT_MISMATCH",
  "SALARY_ADVANCE_WORKER_INELIGIBLE_STATUS",
  "SALARY_ADVANCE_WORKER_VENDOR_RECRUITED",
  "SALARY_ADVANCE_WORKER_MULTI_PROJECT_ON",
  "SALARY_ADVANCE_WORKER_DUPLICATE_CCCD",
  "SALARY_ADVANCE_PAYMENT_METHOD_INVALID",
  "SALARY_ADVANCE_BANK_ACCOUNT_MISSING",
  "SALARY_ADVANCE_BANK_ACCOUNT_NOT_SELF_OWNED",
  "SALARY_ADVANCE_AMOUNT_INVALID",
  "SALARY_ADVANCE_CONTENT_INVALID",
  "SALARY_ADVANCE_MESSAGE_REQUIRED",
  "SALARY_ADVANCE_REASON_REQUIRED",
  "SALARY_ADVANCE_NOTE_INVALID",
  "SALARY_ADVANCE_ACTION_INVALID",
  "SALARY_ADVANCE_DECISION_INVALID",
  "SALARY_ADVANCE_REQUEST_INVALID",
  "SALARY_ADVANCE_REQUEST_NOT_FOUND",
  "SALARY_ADVANCE_STATE_CONFLICT",
  "SALARY_ADVANCE_VERSION_CONFLICT",
  "SALARY_ADVANCE_IDEMPOTENCY_INVALID",
  "SALARY_ADVANCE_IDEMPOTENCY_CONFLICT",
  "SALARY_ADVANCE_EVIDENCE_MIME_INVALID",
  "SALARY_ADVANCE_EVIDENCE_SIZE_INVALID",
  "SALARY_ADVANCE_EVIDENCE_CHECKSUM_INVALID",
  "SALARY_ADVANCE_EVIDENCE_NOT_FOUND",
  "SALARY_ADVANCE_EVIDENCE_VERSION_INVALID",
  "SALARY_ADVANCE_EVIDENCE_VERSION_CONFLICT",
  "SALARY_ADVANCE_UPLOAD_SUPERSEDED",
  "SALARY_ADVANCE_UPLOAD_EXPIRED",
  "SALARY_ADVANCE_PORTRAIT_LOCK_INVALID",
  "SALARY_ADVANCE_WORKER_PORTRAIT_MISSING",
  "SALARY_ADVANCE_WORKER_PORTRAIT_NOT_FOUND",
  "SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT",
]);

function mapRpcError(error: {
  code?: string;
  message?: string;
}): SalaryAdvanceErrorCode {
  const msg = typeof error.message === "string" ? error.message.trim() : "";
  if (KNOWN_ERROR_MESSAGES.has(msg as SalaryAdvanceErrorCode)) {
    return msg as SalaryAdvanceErrorCode;
  }
  for (const candidate of KNOWN_ERROR_MESSAGES) {
    if (msg.includes(candidate)) {
      return candidate;
    }
  }

  switch (error.code) {
    case "42501":
      return "SALARY_ADVANCE_ACCESS_DENIED";
    case "P0002":
      return "SALARY_ADVANCE_REQUEST_NOT_FOUND";
    case "23505":
      return "SALARY_ADVANCE_IDEMPOTENCY_CONFLICT";
    case "PT409":
    case "40001":
    case "40900":
      return "SALARY_ADVANCE_VERSION_CONFLICT";
    case "22023":
      return "SALARY_ADVANCE_REQUEST_INVALID";
    default:
      return "SALARY_ADVANCE_UNAVAILABLE";
  }
}

function defaultServiceRpcCaller(): SalaryAdvanceRpcCaller {
  let supabase: ReturnType<typeof createServiceSupabaseClient> | null = null;
  return async (fn, args) => {
    supabase ??= createServiceSupabaseClient();
    const { data, error } = await supabase.rpc(fn as never, args as never);
    return {
      data,
      error: error
        ? {
            code: typeof error.code === "string" ? error.code : undefined,
            message:
              typeof error.message === "string" ? error.message : undefined,
          }
        : null,
    };
  };
}

export function createSalaryAdvanceRepository(
  callRpc: SalaryAdvanceRpcCaller = defaultServiceRpcCaller(),
): SalaryAdvanceRepository {
  async function invoke<T>(
    fn: string,
    args: Record<string, unknown>,
    project: (raw: unknown) => T | null,
  ): Promise<SalaryAdvanceRepoResult<T>> {
    try {
      const { data, error } = await callRpc(fn, args);
      if (error) {
        return { ok: false, code: mapRpcError(error) };
      }
      const projected = project(data);
      if (!projected) {
        return { ok: false, code: "SALARY_ADVANCE_UNAVAILABLE" };
      }
      return { ok: true, data: projected };
    } catch {
      return { ok: false, code: "SALARY_ADVANCE_UNAVAILABLE" };
    }
  }

  return {
    getActorContext(actor) {
      return invoke(
        "salary_advance_get_actor_context",
        {
          p_auth_subject: actor.auth_subject,
          p_app_user_id: actor.app_user_id,
        },
        (raw) => {
          if (
            !isPlainObject(raw) ||
            typeof raw.app_user_id !== "string" ||
            typeof raw.display_name !== "string" ||
            typeof raw.is_project_manager !== "boolean" ||
            typeof raw.is_project_accountant !== "boolean" ||
            typeof raw.is_supervisory_viewer !== "boolean" ||
            typeof raw.is_full_admin !== "boolean" ||
            typeof raw.is_bod !== "boolean" ||
            !Array.isArray(raw.managed_projects) ||
            !Array.isArray(raw.accountant_projects) ||
            !Array.isArray(raw.supervisory_projects) ||
            typeof raw.authorization_date !== "string"
          ) {
            return null;
          }
          return raw as unknown as SalaryAdvanceActorContext;
        },
      );
    },

    listProjectWorkers(input) {
      return invoke(
        "salary_advance_list_project_workers",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_project_id: input.project_id,
          p_search: input.search,
          p_cursor: input.cursor,
          p_page_size: input.page_size,
        },
        (raw) => {
          if (
            !isPlainObject(raw) ||
            typeof raw.project_id !== "string" ||
            !Array.isArray(raw.workers) ||
            typeof raw.has_more !== "boolean" ||
            (raw.next_cursor !== null && typeof raw.next_cursor !== "string")
          ) {
            return null;
          }
          return raw as unknown as SalaryAdvanceWorkerListResponse;
        },
      );
    },

    listRequests(input) {
      return invoke(
        "salary_advance_list_requests",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_queue: input.queue,
          p_project_id: input.project_id,
          p_request_state: input.request_state,
          p_evidence_review_state: input.evidence_review_state,
          p_search: input.search,
          p_cursor: input.cursor,
          p_page_size: input.page_size,
        },
        (raw) => {
          if (
            !isPlainObject(raw) ||
            !Array.isArray(raw.requests) ||
            typeof raw.has_more !== "boolean" ||
            (raw.next_cursor !== null && typeof raw.next_cursor !== "string")
          ) {
            return null;
          }
          return raw as unknown as SalaryAdvanceRequestListResponse;
        },
      );
    },

    getRequestDetail(input) {
      return invoke(
        "salary_advance_get_request_detail",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_request_id: input.request_id,
        },
        (raw) => {
          if (
            !isPlainObject(raw) ||
            !isPlainObject(raw.request) ||
            !Array.isArray(raw.events) ||
            !Array.isArray(raw.evidence_versions)
          ) {
            return null;
          }
          return raw as unknown as SalaryAdvanceRequestDetail;
        },
      );
    },

    createRequest(input) {
      return invoke(
        "salary_advance_create_request",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_project_id: input.project_id,
          p_worker_entry_id: input.worker_entry_id,
          p_requested_amount_vnd: input.requested_amount_vnd,
          p_initial_content: input.initial_content,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
          p_payment_method: input.payment_method ?? "CASH",
        },
        (raw) => {
          if (
            !isPlainObject(raw) ||
            !isPlainObject(raw.request) ||
            !Array.isArray(raw.events) ||
            !Array.isArray(raw.evidence_versions) ||
            typeof raw.replayed !== "boolean"
          ) {
            return null;
          }
          return raw as unknown as SalaryAdvanceMutationDetailResponse;
        },
      );
    },

    postMessage(input) {
      return invoke(
        "salary_advance_post_message",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_request_id: input.request_id,
          p_expected_version: input.expected_version,
          p_message_text: input.message_text,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        (raw) => {
          if (
            !isPlainObject(raw) ||
            !isPlainObject(raw.request) ||
            !Array.isArray(raw.events) ||
            !Array.isArray(raw.evidence_versions) ||
            typeof raw.replayed !== "boolean"
          ) {
            return null;
          }
          return raw as unknown as SalaryAdvanceMutationDetailResponse;
        },
      );
    },

    transitionRequest(input) {
      return invoke(
        "salary_advance_transition_request",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_request_id: input.request_id,
          p_action: input.action,
          p_expected_version: input.expected_version,
          p_message_text: input.message_text,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        (raw) => {
          if (
            !isPlainObject(raw) ||
            !isPlainObject(raw.request) ||
            !Array.isArray(raw.events) ||
            !Array.isArray(raw.evidence_versions) ||
            typeof raw.replayed !== "boolean"
          ) {
            return null;
          }
          return raw as unknown as SalaryAdvanceMutationDetailResponse;
        },
      );
    },

    reserveEvidence(input) {
      return invoke(
        "salary_advance_reserve_evidence",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_request_id: input.request_id,
          p_expected_version: input.expected_version,
          p_mime_type: input.mime_type,
          p_size_bytes: input.size_bytes,
          p_checksum_sha256: input.checksum_sha256,
          p_caption_note: input.caption_note,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        (raw) => {
          if (
            !isPlainObject(raw) ||
            typeof raw.request_id !== "string" ||
            typeof raw.upload_id !== "string" ||
            typeof raw.expected_version !== "number" ||
            !isOpaqueSalaryAdvanceEvidenceStorageKey(raw.storage_key) ||
            (raw.mime_type !== "image/jpeg" && raw.mime_type !== "image/png") ||
            typeof raw.size_bytes !== "number" ||
            typeof raw.checksum_sha256 !== "string" ||
            typeof raw.expires_at !== "string" ||
            typeof raw.replayed !== "boolean" ||
            (raw.superseded_storage_key !== null &&
              raw.superseded_storage_key !== undefined &&
              !isOpaqueSalaryAdvanceEvidenceStorageKey(
                raw.superseded_storage_key,
              ))
          ) {
            return null;
          }
          return {
            request_id: raw.request_id,
            upload_id: raw.upload_id,
            expected_version: raw.expected_version,
            storage_key: raw.storage_key,
            mime_type: raw.mime_type,
            size_bytes: raw.size_bytes,
            checksum_sha256: raw.checksum_sha256,
            expires_at: raw.expires_at,
            superseded_storage_key:
              typeof raw.superseded_storage_key === "string"
                ? raw.superseded_storage_key
                : null,
            replayed: raw.replayed,
          };
        },
      );
    },

    getEvidenceFinalizeContext(input) {
      return invoke(
        "salary_advance_get_evidence_finalize_context",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_request_id: input.request_id,
          p_upload_id: input.upload_id,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        (raw) => {
          if (!isPlainObject(raw)) return null;
          if (raw.status === "REPLAYED") {
            if (
              !isPlainObject(raw.result_payload) ||
              !isPlainObject(raw.result_payload.request) ||
              !Array.isArray(raw.result_payload.events) ||
              !Array.isArray(raw.result_payload.evidence_versions) ||
              typeof raw.result_payload.replayed !== "boolean"
            ) {
              return null;
            }
            return {
              status: "REPLAYED",
              result_payload:
                raw.result_payload as unknown as SalaryAdvanceMutationDetailResponse,
            };
          }
          if (
            raw.status === "READY_TO_FINALIZE" &&
            typeof raw.request_id === "string" &&
            typeof raw.upload_id === "string" &&
            typeof raw.expected_version === "number" &&
            isOpaqueSalaryAdvanceEvidenceStorageKey(raw.storage_key) &&
            (raw.mime_type === "image/jpeg" || raw.mime_type === "image/png") &&
            typeof raw.size_bytes === "number" &&
            typeof raw.checksum_sha256 === "string"
          ) {
            return {
              status: "READY_TO_FINALIZE",
              request_id: raw.request_id,
              upload_id: raw.upload_id,
              expected_version: raw.expected_version,
              storage_key: raw.storage_key,
              mime_type: raw.mime_type,
              size_bytes: raw.size_bytes,
              checksum_sha256: raw.checksum_sha256,
            };
          }
          return null;
        },
      );
    },

    finalizeEvidence(input) {
      return invoke(
        "salary_advance_finalize_evidence",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_request_id: input.request_id,
          p_upload_id: input.upload_id,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        (raw) => {
          if (
            !isPlainObject(raw) ||
            !isPlainObject(raw.request) ||
            !Array.isArray(raw.events) ||
            !Array.isArray(raw.evidence_versions) ||
            typeof raw.replayed !== "boolean"
          ) {
            return null;
          }
          return raw as unknown as SalaryAdvanceMutationDetailResponse;
        },
      );
    },

    reviewEvidence(input) {
      return invoke(
        "salary_advance_review_evidence",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_request_id: input.request_id,
          p_expected_version: input.expected_version,
          p_evidence_version: input.evidence_version,
          p_decision: input.decision,
          p_expected_worker_portrait_document_id:
            input.expected_worker_portrait_document_id,
          p_expected_worker_portrait_version:
            input.expected_worker_portrait_version,
          p_note: input.note,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        (raw) => {
          if (
            !isPlainObject(raw) ||
            !isPlainObject(raw.request) ||
            !Array.isArray(raw.events) ||
            !Array.isArray(raw.evidence_versions) ||
            typeof raw.replayed !== "boolean"
          ) {
            return null;
          }
          return raw as unknown as SalaryAdvanceMutationDetailResponse;
        },
      );
    },

    getEvidencePreviewContext(input) {
      return invoke(
        "salary_advance_get_evidence_preview_context",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_request_id: input.request_id,
          p_evidence_version: input.evidence_version,
        },
        (raw) => {
          if (
            !isPlainObject(raw) ||
            typeof raw.request_id !== "string" ||
            typeof raw.evidence_version !== "number" ||
            !isOpaqueSalaryAdvanceEvidenceStorageKey(raw.storage_key) ||
            (raw.mime_type !== "image/jpeg" && raw.mime_type !== "image/png") ||
            typeof raw.size_bytes !== "number" ||
            typeof raw.checksum_sha256 !== "string"
          ) {
            return null;
          }
          return {
            request_id: raw.request_id,
            evidence_version: raw.evidence_version,
            storage_key: raw.storage_key,
            mime_type: raw.mime_type,
            size_bytes: raw.size_bytes,
            checksum_sha256: raw.checksum_sha256,
          };
        },
      );
    },

    getWorkerPortraitContext(input) {
      return invoke(
        "salary_advance_get_worker_portrait_context",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_request_id: input.request_id,
          p_expected_document_id: input.expected_document_id,
        },
        (raw) => {
          if (
            !isPlainObject(raw) ||
            typeof raw.request_id !== "string" ||
            typeof raw.worker_entry_id !== "string" ||
            typeof raw.document_id !== "string" ||
            typeof raw.version !== "number" ||
            !isOpaqueWorkerPortraitStorageKey(raw.storage_key) ||
            (raw.mime_type !== "image/jpeg" && raw.mime_type !== "image/png") ||
            typeof raw.size_bytes !== "number" ||
            typeof raw.checksum_sha256 !== "string"
          ) {
            return null;
          }
          return {
            request_id: raw.request_id,
            worker_entry_id: raw.worker_entry_id,
            document_id: raw.document_id,
            version: raw.version,
            storage_key: raw.storage_key,
            mime_type: raw.mime_type,
            size_bytes: raw.size_bytes,
            checksum_sha256: raw.checksum_sha256,
          };
        },
      );
    },

    listWorkerHistory(input) {
      return invoke(
        "salary_advance_list_worker_history",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_request_id: input.request_id,
          p_period_mode: input.period_mode,
          p_month: input.month,
          p_from_date: input.from_date,
          p_to_date: input.to_date,
          p_cursor: input.cursor,
          p_page_size: input.page_size,
        },
        (raw) => {
          if (
            !isPlainObject(raw) ||
            typeof raw.request_id !== "string" ||
            typeof raw.worker_entry_id !== "string" ||
            typeof raw.worker_employee_code !== "string" ||
            typeof raw.worker_display_name !== "string" ||
            typeof raw.period_mode !== "string" ||
            typeof raw.total_count !== "number" ||
            !Number.isSafeInteger(raw.total_count) ||
            raw.total_count < 0 ||
            typeof raw.total_amount_vnd !== "string" ||
            !/^\d+$/.test(raw.total_amount_vnd) ||
            !Array.isArray(raw.items) ||
            typeof raw.has_more !== "boolean" ||
            (raw.next_cursor !== null && typeof raw.next_cursor !== "string")
          ) {
            return null;
          }
          return raw as unknown as SalaryAdvanceWorkerHistoryResponse;
        },
      );
    },
  };
}
