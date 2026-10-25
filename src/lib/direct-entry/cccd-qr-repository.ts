import "server-only";

import {
  CCCD_QR_AUTHENTICITY,
  CCCD_QR_SOURCE,
  isCccdQrDocumentType,
  isCccdQrErrorCode,
  isCccdQrErrorField,
  isCccdQrStatus,
  type CccdQrCandidateData,
  type CccdQrDocumentType,
  type CccdQrErrorCode,
  type CccdQrErrorField,
  type CccdQrFieldMergePreview,
  type CccdQrStatus,
} from "./cccd-qr-contract.ts";
import type { OperationResult } from "./write-repository.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type CccdQrExtractionRecord = {
  extraction_id: string;
  entry_id: string;
  document_id: string;
  document_type: CccdQrDocumentType;
  document_version: number;
  status: CccdQrStatus;
  error_code: CccdQrErrorCode | null;
  error_field: CccdQrErrorField | null;
  candidate_data: CccdQrCandidateData | null;
  field_merge_preview: CccdQrFieldMergePreview | null;
  applied_fields: string[];
  skipped_fields: string[];
  attempts: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type CccdQrPreparedContext = {
  entry_id: string;
  entry_version: number;
  document_id: string;
  document_type: CccdQrDocumentType;
  document_version: number;
  storage_key: string;
  mime_type: "image/jpeg" | "image/png";
  size_bytes: number;
  checksum_sha256: string;
  extraction: CccdQrExtractionRecord;
};

export type CccdQrCompletionResult = {
  entry_id: string;
  entry_version: number;
  reused: boolean;
  extraction: CccdQrExtractionRecord;
};

export type CccdQrReadEligibleDocument = {
  document_id: string;
  document_type: CccdQrDocumentType;
  document_version: number;
  mime_type: "image/jpeg" | "image/png";
};

export type CccdQrReadResult = {
  entry_id: string;
  entry_version: number;
  latest: CccdQrExtractionRecord | null;
  extractions: CccdQrExtractionRecord[];
  eligible_documents: CccdQrReadEligibleDocument[];
};

export type CccdQrRepository = {
  prepareExtraction(input: {
    auth_subject: string;
    app_user_id: string;
    entry_id: string;
    document_id?: string | null;
    document_type?: CccdQrDocumentType | null;
  }): Promise<OperationResult<CccdQrPreparedContext>>;

  completeExtraction(input: {
    auth_subject: string;
    app_user_id: string;
    entry_id: string;
    document_id: string;
    status: Exclude<CccdQrStatus, "PENDING">;
    error_code: CccdQrErrorCode | null;
    error_field: CccdQrErrorField | null;
    candidate_data: CccdQrCandidateData | null;
    apply_blank_fields: boolean;
    expected_entry_version: number | null;
    idempotency_key: string | null;
  }): Promise<OperationResult<CccdQrCompletionResult>>;

  getExtractions(input: {
    auth_subject: string;
    app_user_id: string;
    entry_id: string;
    document_id?: string | null;
  }): Promise<OperationResult<CccdQrReadResult>>;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_REGEX = /^[a-f0-9]{64}$/;
const STORAGE_KEY_REGEX =
  /^p1\.6\/[0-9a-f-]{36}\/(?:CCCD_FRONT|CCCD_BACK)\/[1-9]\d*\/[0-9a-f-]{36}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyError(
  error: { code?: string; message?: string },
): Exclude<OperationResult, { ok: true }>["kind"] {
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "40001" || error.code === "23505") return "conflict";
  if (error.code === "22023") return "invalid";
  console.error("[direct-entry] cccd qr RPC failed");
  return "unavailable";
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
    value.display_name !== "kept_existing" ||
    !validStatus(value.national_id) ||
    !validStatus(value.date_of_birth) ||
    !validStatus(value.gender) ||
    !validStatus(value.address) ||
    !validStatus(value.national_id_issued_at)
  ) {
    return null;
  }
  return {
    display_name: "kept_existing",
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

export function projectExtractionRecord(value: unknown): CccdQrExtractionRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.extraction_id !== "string" ||
    !UUID_REGEX.test(value.extraction_id) ||
    typeof value.entry_id !== "string" ||
    !UUID_REGEX.test(value.entry_id) ||
    typeof value.document_id !== "string" ||
    !UUID_REGEX.test(value.document_id) ||
    !isCccdQrDocumentType(value.document_type) ||
    typeof value.document_version !== "number" ||
    !Number.isSafeInteger(value.document_version) ||
    value.document_version < 1 ||
    !isCccdQrStatus(value.status) ||
    typeof value.attempts !== "number" ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 0 ||
    typeof value.created_at !== "string" ||
    typeof value.updated_at !== "string" ||
    (value.completed_at !== null && typeof value.completed_at !== "string")
  ) {
    return null;
  }

  const appliedFields = projectStringArray(value.applied_fields);
  const skippedFields = projectStringArray(value.skipped_fields);
  if (!appliedFields || !skippedFields) return null;

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

  if (value.status === "SUCCEEDED" && (!candidateData || errorCode !== null)) {
    return null;
  }
  if (value.status !== "SUCCEEDED" && candidateData !== null) {
    return null;
  }

  return {
    extraction_id: value.extraction_id,
    entry_id: value.entry_id,
    document_id: value.document_id,
    document_type: value.document_type,
    document_version: value.document_version,
    status: value.status,
    error_code: errorCode,
    error_field: errorField,
    candidate_data: candidateData,
    field_merge_preview: fieldMergePreview,
    applied_fields: appliedFields,
    skipped_fields: skippedFields,
    attempts: value.attempts,
    created_at: value.created_at,
    updated_at: value.updated_at,
    completed_at: value.completed_at ?? null,
  };
}

function projectPreparedContext(value: unknown): CccdQrPreparedContext | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.entry_id !== "string" ||
    !UUID_REGEX.test(value.entry_id) ||
    typeof value.entry_version !== "number" ||
    !Number.isSafeInteger(value.entry_version) ||
    value.entry_version < 1 ||
    typeof value.document_id !== "string" ||
    !UUID_REGEX.test(value.document_id) ||
    !isCccdQrDocumentType(value.document_type) ||
    typeof value.document_version !== "number" ||
    !Number.isSafeInteger(value.document_version) ||
    value.document_version < 1 ||
    typeof value.storage_key !== "string" ||
    !STORAGE_KEY_REGEX.test(value.storage_key) ||
    (value.mime_type !== "image/jpeg" && value.mime_type !== "image/png") ||
    typeof value.size_bytes !== "number" ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 1 ||
    typeof value.checksum_sha256 !== "string" ||
    !SHA256_REGEX.test(value.checksum_sha256)
  ) {
    return null;
  }
  const extraction = projectExtractionRecord(value.extraction);
  if (!extraction) return null;
  return {
    entry_id: value.entry_id,
    entry_version: value.entry_version,
    document_id: value.document_id,
    document_type: value.document_type,
    document_version: value.document_version,
    storage_key: value.storage_key,
    mime_type: value.mime_type,
    size_bytes: value.size_bytes,
    checksum_sha256: value.checksum_sha256,
    extraction,
  };
}

function projectCompletionResult(value: unknown): CccdQrCompletionResult | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.entry_id !== "string" ||
    !UUID_REGEX.test(value.entry_id) ||
    typeof value.entry_version !== "number" ||
    !Number.isSafeInteger(value.entry_version) ||
    value.entry_version < 1 ||
    typeof value.reused !== "boolean"
  ) {
    return null;
  }
  const extraction = projectExtractionRecord(value.extraction);
  if (!extraction) return null;
  return {
    entry_id: value.entry_id,
    entry_version: value.entry_version,
    reused: value.reused,
    extraction,
  };
}

function projectReadResult(value: unknown): CccdQrReadResult | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.entry_id !== "string" ||
    !UUID_REGEX.test(value.entry_id) ||
    typeof value.entry_version !== "number" ||
    !Number.isSafeInteger(value.entry_version) ||
    value.entry_version < 1 ||
    !Array.isArray(value.extractions) ||
    !Array.isArray(value.eligible_documents)
  ) {
    return null;
  }

  let latest: CccdQrExtractionRecord | null = null;
  if (value.latest !== null && value.latest !== undefined) {
    latest = projectExtractionRecord(value.latest);
    if (!latest) return null;
  }

  const extractions: CccdQrExtractionRecord[] = [];
  for (const item of value.extractions) {
    const projected = projectExtractionRecord(item);
    if (!projected) return null;
    extractions.push(projected);
  }

  const eligibleDocuments: CccdQrReadEligibleDocument[] = [];
  for (const doc of value.eligible_documents) {
    if (
      !isRecord(doc) ||
      typeof doc.document_id !== "string" ||
      !UUID_REGEX.test(doc.document_id) ||
      !isCccdQrDocumentType(doc.document_type) ||
      typeof doc.document_version !== "number" ||
      !Number.isSafeInteger(doc.document_version) ||
      doc.document_version < 1 ||
      (doc.mime_type !== "image/jpeg" && doc.mime_type !== "image/png")
    ) {
      return null;
    }
    eligibleDocuments.push({
      document_id: doc.document_id,
      document_type: doc.document_type,
      document_version: doc.document_version,
      mime_type: doc.mime_type,
    });
  }

  return {
    entry_id: value.entry_id,
    entry_version: value.entry_version,
    latest,
    extractions,
    eligible_documents: eligibleDocuments,
  };
}

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await client).rpc(name as never, args as never);
}

export function createCccdQrRepository(rpc?: Rpc): CccdQrRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async prepareExtraction(input) {
      try {
        const { data, error } = await callRpc("direct_entry_prepare_cccd_qr_extraction", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
          p_document_id: input.document_id ?? null,
          p_document_type: input.document_type ?? null,
        });
        if (error) return { ok: false, kind: classifyError(error) };
        const projected = projectPreparedContext(data);
        return projected ? { ok: true, data: projected } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] prepare cccd qr extraction RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },

    async completeExtraction(input) {
      try {
        const { data, error } = await callRpc("direct_entry_complete_cccd_qr_extraction", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
          p_document_id: input.document_id,
          p_status: input.status,
          p_error_code: input.error_code,
          p_error_field: input.error_field,
          p_candidate_data: input.candidate_data,
          p_apply_blank_fields: input.apply_blank_fields,
          p_expected_entry_version: input.expected_entry_version,
          p_idempotency_key: input.idempotency_key,
        });
        if (error) return { ok: false, kind: classifyError(error) };
        const projected = projectCompletionResult(data);
        return projected ? { ok: true, data: projected } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] complete cccd qr extraction RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },

    async getExtractions(input) {
      try {
        const { data, error } = await callRpc("direct_entry_get_cccd_qr_extractions", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
          p_document_id: input.document_id ?? null,
        });
        if (error) return { ok: false, kind: classifyError(error) };
        const projected = projectReadResult(data);
        return projected ? { ok: true, data: projected } : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] get cccd qr extractions RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}

export function createServiceCccdQrRepository(): CccdQrRepository {
  return createCccdQrRepository();
}
