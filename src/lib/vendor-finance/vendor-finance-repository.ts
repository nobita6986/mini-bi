import "server-only";

import { isOpaqueVfinEvidenceStorageKey } from "./r2-evidence-storage.ts";
import {
  VENDOR_FINANCE_EVIDENCE_MAX_BYTES,
  VENDOR_FINANCE_EVIDENCE_UPLOAD_URL_TTL_SECONDS,
  projectActorAccess,
  projectCreateReconciliationMutation,
  projectEvidenceSummary,
  projectOpeningApplyMutation,
  projectOpeningPreview,
  projectRecordEntryMutation,
  projectReverseEntryMutation,
  projectVendorFinanceEntriesPage,
  projectVendorFinanceSingleEntry,
  projectVendorFinanceVendorDetail,
  projectVendorFinanceVendorList,
  projectVendorReconciliationsPage,
  type NormalVendorFinanceEntryType,
  type OpeningBatchItemInput,
  type VendorFinanceActiveFilter,
  type VendorFinanceActorAccessProjection,
  type VendorFinanceBalanceFilter,
  type VendorFinanceEntriesPageResponse,
  type VendorFinanceEntryProjection,
  type VendorFinanceEntryType,
  type VendorFinanceErrorCode,
  type VendorFinanceEvidenceFinalizeResponse,
  type VendorFinanceEvidenceMimeType,
  type VendorFinanceEvidenceTargetKind,
  type VendorFinanceOpeningApplyResponse,
  type VendorFinanceOpeningPreviewResponse,
  type VendorFinanceReconciliationProjection,
  type VendorFinanceReconciliationsPageResponse,
  type VendorFinanceSingleEntryResponse,
  type VendorFinanceVendorDetailResponse,
  type VendorFinanceVendorListResponse,
} from "./vendor-finance-contract.ts";

export type VendorFinanceRpcCaller = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type VendorFinanceActorRef = {
  auth_subject: string;
  app_user_id: string;
};

export type VendorFinanceRepoResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: VendorFinanceErrorCode };

export type EvidenceReservationRecord = {
  reservation: {
    evidence_id: string;
    target_kind: VendorFinanceEvidenceTargetKind;
    target_id: string;
    status: "RESERVED";
    storage_key: string;
    mime_type: VendorFinanceEvidenceMimeType;
    size_bytes: number;
    checksum_sha256: string;
    reserved_at: string;
    expires_at: string;
  };
  superseded_storage_keys: readonly string[];
  replayed: boolean;
};

export type EvidenceReservationInfoRecord = {
  evidence_id: string;
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  status: "RESERVED" | "READY" | "FAILED" | "EXPIRED";
  storage_key: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  expires_at: string;
  finalized_at: string | null;
  is_expired: boolean;
};

export type EvidenceDownloadRecord = {
  evidence_id: string;
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  storage_key: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  finalized_at: string;
};

export type VendorFinanceRepository = {
  getActorAccess(
    actor: VendorFinanceActorRef,
  ): Promise<VendorFinanceRepoResult<VendorFinanceActorAccessProjection>>;

  listVendors(
    input: VendorFinanceActorRef & {
      search: string | null;
      active: VendorFinanceActiveFilter;
      balance_filter: VendorFinanceBalanceFilter;
      page: number;
      page_size: number;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceVendorListResponse>>;

  getVendor(
    input: VendorFinanceActorRef & { vendor_id: string },
  ): Promise<VendorFinanceRepoResult<VendorFinanceVendorDetailResponse>>;

  listVendorEntries(
    input: VendorFinanceActorRef & {
      vendor_id: string;
      before_sequence: number | null;
      entry_type: VendorFinanceEntryType | null;
      page_size: number;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceEntriesPageResponse>>;

  getEntry(
    input: VendorFinanceActorRef & { entry_id: string },
  ): Promise<VendorFinanceRepoResult<VendorFinanceSingleEntryResponse>>;

  listVendorReconciliations(
    input: VendorFinanceActorRef & {
      vendor_id: string;
      page: number;
      page_size: number;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceReconciliationsPageResponse>>;

  recordEntry(
    input: VendorFinanceActorRef & {
      vendor_id: string;
      entry_type: NormalVendorFinanceEntryType;
      amount_minor: string;
      effective_date: string;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<
    VendorFinanceRepoResult<{ entry: VendorFinanceEntryProjection; replayed: boolean }>
  >;

  reverseEntry(
    input: VendorFinanceActorRef & {
      entry_id: string;
      effective_date: string | null;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<
    VendorFinanceRepoResult<{
      reversal_entry: VendorFinanceEntryProjection;
      reversed_entry: VendorFinanceEntryProjection;
      replayed: boolean;
    }>
  >;

  previewOpeningBatch(
    input: VendorFinanceActorRef & {
      cutoff_date: string;
      items: readonly OpeningBatchItemInput[];
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceOpeningPreviewResponse>>;

  applyOpeningBatch(
    input: VendorFinanceActorRef & {
      cutoff_date: string;
      items: readonly OpeningBatchItemInput[];
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceOpeningApplyResponse>>;

  createReconciliation(
    input: VendorFinanceActorRef & {
      vendor_id: string;
      as_of_date: string;
      confirmed_balance_minor: string;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<
    VendorFinanceRepoResult<{
      reconciliation: VendorFinanceReconciliationProjection;
      replayed: boolean;
    }>
  >;

  reserveEvidence(
    input: VendorFinanceActorRef & {
      target_kind: VendorFinanceEvidenceTargetKind;
      target_id: string;
      mime_type: VendorFinanceEvidenceMimeType;
      size_bytes: number;
      checksum_sha256: string;
      ttl_seconds?: number;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<VendorFinanceRepoResult<EvidenceReservationRecord>>;

  getEvidenceReservationInfo(
    input: VendorFinanceActorRef & { evidence_id: string },
  ): Promise<VendorFinanceRepoResult<EvidenceReservationInfoRecord>>;

  finalizeEvidenceReady(
    input: VendorFinanceActorRef & { evidence_id: string },
  ): Promise<VendorFinanceRepoResult<VendorFinanceEvidenceFinalizeResponse>>;

  failEvidenceReservation(
    input: VendorFinanceActorRef & {
      evidence_id: string;
      failure_code: string;
    },
  ): Promise<VendorFinanceRepoResult<{ evidence_id: string; status: "FAILED" }>>;

  getEvidenceDownload(
    input: VendorFinanceActorRef & { evidence_id: string },
  ): Promise<VendorFinanceRepoResult<EvidenceDownloadRecord>>;

  markEvidenceCleaned(
    input: VendorFinanceActorRef & { evidence_id: string },
  ): Promise<VendorFinanceRepoResult<{ evidence_id: string; cleaned: true }>>;
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;

const KNOWN_RPC_TOKENS: ReadonlyArray<readonly [string, VendorFinanceErrorCode]> = [
  ["VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN", "VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN"],
  ["VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR", "VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR"],
  ["VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED", "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED"],
  ["VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED", "VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED"],
  ["VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID", "VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID"],
  ["VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED", "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED"],
  ["VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID", "VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID"],
  ["VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL", "VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL"],
  ["VENDOR_FINANCE_RECONCILIATION_NOT_FOUND", "VENDOR_FINANCE_RECONCILIATION_NOT_FOUND"],
  ["VENDOR_FINANCE_ENTRY_ALREADY_REVERSED", "VENDOR_FINANCE_ENTRY_ALREADY_REVERSED"],
  ["VENDOR_FINANCE_EVIDENCE_TARGET_INVALID", "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID"],
  ["VENDOR_FINANCE_OPENING_BATCH_INVALID", "VENDOR_FINANCE_OPENING_BATCH_INVALID"],
  ["VENDOR_FINANCE_EVIDENCE_MIME_INVALID", "VENDOR_FINANCE_EVIDENCE_MIME_INVALID"],
  ["VENDOR_FINANCE_EVIDENCE_SIZE_INVALID", "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID"],
  ["VENDOR_FINANCE_IDEMPOTENCY_CONFLICT", "VENDOR_FINANCE_IDEMPOTENCY_CONFLICT"],
  ["VENDOR_FINANCE_OPENING_BATCH_EMPTY", "VENDOR_FINANCE_OPENING_BATCH_EMPTY"],
  ["VENDOR_FINANCE_IDEMPOTENCY_INVALID", "IDEMPOTENCY_KEY_INVALID"],
  ["VENDOR_FINANCE_EVIDENCE_NOT_FOUND", "VENDOR_FINANCE_EVIDENCE_NOT_FOUND"],
  ["VENDOR_FINANCE_ENTRY_TYPE_INVALID", "VENDOR_FINANCE_ENTRY_TYPE_INVALID"],
  ["VENDOR_FINANCE_VENDOR_NOT_FOUND", "VENDOR_FINANCE_VENDOR_NOT_FOUND"],
  ["VENDOR_FINANCE_EVIDENCE_INVALID", "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID"],
  ["VENDOR_FINANCE_ENTRY_NOT_FOUND", "VENDOR_FINANCE_ENTRY_NOT_FOUND"],
  ["VENDOR_FINANCE_AMOUNT_OVERFLOW", "VENDOR_FINANCE_AMOUNT_OVERFLOW"],
  ["VENDOR_FINANCE_AMOUNT_INVALID", "VENDOR_FINANCE_AMOUNT_INVALID"],
  ["VENDOR_FINANCE_REASON_INVALID", "VENDOR_FINANCE_REASON_INVALID"],
  ["VENDOR_FINANCE_SEARCH_INVALID", "VENDOR_FINANCE_SEARCH_INVALID"],
  ["VENDOR_FINANCE_VENDOR_INVALID", "VENDOR_FINANCE_VENDOR_INVALID"],
  ["VENDOR_FINANCE_ACCESS_DENIED", "VENDOR_FINANCE_ACCESS_DENIED"],
  ["VENDOR_FINANCE_RECORD_DENIED", "VENDOR_FINANCE_RECORD_DENIED"],
  ["VENDOR_FINANCE_QUERY_INVALID", "VENDOR_FINANCE_QUERY_INVALID"],
  ["VENDOR_FINANCE_ENTRY_INVALID", "VENDOR_FINANCE_ENTRY_INVALID"],
  ["VENDOR_FINANCE_DATE_INVALID", "VENDOR_FINANCE_DATE_INVALID"],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

function serviceRoleRpc(): VendorFinanceRpcCaller {
  const clientPromise = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await clientPromise).rpc(name, args);
}

export function classifyVendorFinanceRpcError(
  error: { code?: string; message?: string },
  mode: "read" | "mutation",
): VendorFinanceErrorCode {
  const trimmed = typeof error.message === "string" ? error.message.trim() : "";

  for (const [token, mapped] of KNOWN_RPC_TOKENS) {
    if (trimmed === token) {
      return mapped;
    }
  }
  for (const [token, mapped] of KNOWN_RPC_TOKENS) {
    if (trimmed.includes(token)) {
      return mapped;
    }
  }

  if (trimmed.includes("actor mapping denied")) {
    return "ACTOR_NOT_AVAILABLE";
  }

  if (error.code === "42501") {
    return mode === "mutation"
      ? "VENDOR_FINANCE_RECORD_DENIED"
      : "VENDOR_FINANCE_ACCESS_DENIED";
  }
  if (error.code === "P0002") {
    return "VENDOR_FINANCE_VENDOR_NOT_FOUND";
  }
  if (error.code === "22003") {
    return "VENDOR_FINANCE_AMOUNT_OVERFLOW";
  }
  if (error.code === "23505") {
    return "VENDOR_FINANCE_IDEMPOTENCY_CONFLICT";
  }
  if (error.code === "40900") {
    return "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED";
  }
  if (error.code === "22023" || error.code === "23514") {
    return mode === "mutation"
      ? "VENDOR_FINANCE_PAYLOAD_INVALID"
      : "VENDOR_FINANCE_QUERY_INVALID";
  }

  return "VENDOR_FINANCE_UNAVAILABLE";
}

function projectEvidenceReservationRecord(value: unknown): EvidenceReservationRecord | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["reservation", "superseded_storage_keys", "replayed"]) ||
    !isRecord(value.reservation) ||
    !exactKeys(value.reservation, [
      "evidence_id",
      "target_kind",
      "target_id",
      "status",
      "storage_key",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "reserved_at",
      "expires_at",
    ]) ||
    !Array.isArray(value.superseded_storage_keys) ||
    typeof value.replayed !== "boolean"
  ) {
    return null;
  }

  const r = value.reservation;
  if (
    typeof r.evidence_id !== "string" ||
    !UUID_REGEX.test(r.evidence_id) ||
    (r.target_kind !== "ENTRY" && r.target_kind !== "RECONCILIATION") ||
    typeof r.target_id !== "string" ||
    !UUID_REGEX.test(r.target_id) ||
    r.status !== "RESERVED" ||
    !isOpaqueVfinEvidenceStorageKey(r.storage_key) ||
    (r.mime_type !== "image/jpeg" && r.mime_type !== "image/png") ||
    typeof r.size_bytes !== "number" ||
    !Number.isSafeInteger(r.size_bytes) ||
    r.size_bytes < 1 ||
    r.size_bytes > VENDOR_FINANCE_EVIDENCE_MAX_BYTES ||
    typeof r.checksum_sha256 !== "string" ||
    !SHA256_HEX_REGEX.test(r.checksum_sha256) ||
    typeof r.reserved_at !== "string" ||
    r.reserved_at.length === 0 ||
    typeof r.expires_at !== "string" ||
    r.expires_at.length === 0
  ) {
    return null;
  }

  const superseded: string[] = [];
  for (const item of value.superseded_storage_keys) {
    if (!isOpaqueVfinEvidenceStorageKey(item)) {
      return null;
    }
    superseded.push(item);
  }

  return {
    reservation: {
      evidence_id: r.evidence_id.toLowerCase(),
      target_kind: r.target_kind,
      target_id: r.target_id.toLowerCase(),
      status: "RESERVED",
      storage_key: r.storage_key,
      mime_type: r.mime_type,
      size_bytes: r.size_bytes,
      checksum_sha256: r.checksum_sha256.toLowerCase(),
      reserved_at: r.reserved_at,
      expires_at: r.expires_at,
    },
    superseded_storage_keys: superseded,
    replayed: value.replayed,
  };
}

function projectEvidenceReservationInfoRecord(
  value: unknown,
): EvidenceReservationInfoRecord | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "evidence_id",
      "target_kind",
      "target_id",
      "status",
      "storage_key",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "expires_at",
      "finalized_at",
      "is_expired",
    ])
  ) {
    return null;
  }

  if (
    typeof value.evidence_id !== "string" ||
    !UUID_REGEX.test(value.evidence_id) ||
    (value.target_kind !== "ENTRY" && value.target_kind !== "RECONCILIATION") ||
    typeof value.target_id !== "string" ||
    !UUID_REGEX.test(value.target_id) ||
    (value.status !== "RESERVED" &&
      value.status !== "READY" &&
      value.status !== "FAILED" &&
      value.status !== "EXPIRED") ||
    !isOpaqueVfinEvidenceStorageKey(value.storage_key) ||
    (value.mime_type !== "image/jpeg" && value.mime_type !== "image/png") ||
    typeof value.size_bytes !== "number" ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 1 ||
    value.size_bytes > VENDOR_FINANCE_EVIDENCE_MAX_BYTES ||
    typeof value.checksum_sha256 !== "string" ||
    !SHA256_HEX_REGEX.test(value.checksum_sha256) ||
    typeof value.expires_at !== "string" ||
    value.expires_at.length === 0 ||
    (value.finalized_at !== null &&
      (typeof value.finalized_at !== "string" || value.finalized_at.length === 0)) ||
    typeof value.is_expired !== "boolean"
  ) {
    return null;
  }

  return {
    evidence_id: value.evidence_id.toLowerCase(),
    target_kind: value.target_kind,
    target_id: value.target_id.toLowerCase(),
    status: value.status,
    storage_key: value.storage_key,
    mime_type: value.mime_type,
    size_bytes: value.size_bytes,
    checksum_sha256: value.checksum_sha256.toLowerCase(),
    expires_at: value.expires_at,
    finalized_at: value.finalized_at,
    is_expired: value.is_expired,
  };
}

function projectEvidenceFinalizeRecord(
  value: unknown,
): VendorFinanceEvidenceFinalizeResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["evidence", "replayed"]) ||
    !isRecord(value.evidence) ||
    typeof value.replayed !== "boolean"
  ) {
    return null;
  }

  const ev = value.evidence;
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
    typeof ev.target_id !== "string" ||
    !UUID_REGEX.test(ev.target_id)
  ) {
    return null;
  }

  const summary = projectEvidenceSummary({
    evidence_id: ev.evidence_id,
    status: ev.status,
    mime_type: ev.mime_type,
    size_bytes: ev.size_bytes,
    checksum_sha256: ev.checksum_sha256,
    finalized_at: ev.finalized_at,
  });
  if (!summary) return null;

  return {
    evidence: {
      ...summary,
      target_kind: ev.target_kind,
      target_id: ev.target_id.toLowerCase(),
    },
    replayed: value.replayed,
  };
}

function projectEvidenceDownloadRecord(value: unknown): EvidenceDownloadRecord | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "evidence_id",
      "target_kind",
      "target_id",
      "storage_key",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "finalized_at",
    ])
  ) {
    return null;
  }

  if (
    typeof value.evidence_id !== "string" ||
    !UUID_REGEX.test(value.evidence_id) ||
    (value.target_kind !== "ENTRY" && value.target_kind !== "RECONCILIATION") ||
    typeof value.target_id !== "string" ||
    !UUID_REGEX.test(value.target_id) ||
    !isOpaqueVfinEvidenceStorageKey(value.storage_key) ||
    (value.mime_type !== "image/jpeg" && value.mime_type !== "image/png") ||
    typeof value.size_bytes !== "number" ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 1 ||
    value.size_bytes > VENDOR_FINANCE_EVIDENCE_MAX_BYTES ||
    typeof value.checksum_sha256 !== "string" ||
    !SHA256_HEX_REGEX.test(value.checksum_sha256) ||
    typeof value.finalized_at !== "string" ||
    value.finalized_at.length === 0
  ) {
    return null;
  }

  return {
    evidence_id: value.evidence_id.toLowerCase(),
    target_kind: value.target_kind,
    target_id: value.target_id.toLowerCase(),
    storage_key: value.storage_key,
    mime_type: value.mime_type,
    size_bytes: value.size_bytes,
    checksum_sha256: value.checksum_sha256.toLowerCase(),
    finalized_at: value.finalized_at,
  };
}

export function createVendorFinanceRepository(
  rpc?: VendorFinanceRpcCaller,
): VendorFinanceRepository {
  let resolvedRpc = rpc;

  async function callProjected<T>(
    operation: string,
    mode: "read" | "mutation",
    fnName: string,
    args: Record<string, unknown>,
    projector: (raw: unknown) => T | null,
  ): Promise<VendorFinanceRepoResult<T>> {
    try {
      resolvedRpc ??= serviceRoleRpc();
      const result = await resolvedRpc(fnName, args);
      if (result.error) {
        return {
          ok: false,
          code: classifyVendorFinanceRpcError(result.error, mode),
        };
      }
      const projected = projector(result.data);
      if (!projected) {
        console.error(`[vendor-finance] ${operation} returned non-canonical projection`);
        return { ok: false, code: "VENDOR_FINANCE_UNAVAILABLE" };
      }
      return { ok: true, data: projected };
    } catch {
      console.error(`[vendor-finance] ${operation} RPC failed`);
      return { ok: false, code: "VENDOR_FINANCE_UNAVAILABLE" };
    }
  }

  return {
    getActorAccess(actor) {
      return callProjected(
        "getActorAccess",
        "read",
        "vendor_finance_get_actor_access",
        {
          p_auth_subject: actor.auth_subject,
          p_app_user_id: actor.app_user_id,
        },
        projectActorAccess,
      );
    },

    listVendors(input) {
      return callProjected(
        "listVendors",
        "read",
        "vendor_finance_list_vendors",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_active_filter: input.active,
          p_balance_filter: input.balance_filter,
          p_page: input.page,
          p_page_size: input.page_size,
        },
        projectVendorFinanceVendorList,
      );
    },

    getVendor(input) {
      return callProjected(
        "getVendor",
        "read",
        "vendor_finance_get_vendor",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
        },
        projectVendorFinanceVendorDetail,
      );
    },

    listVendorEntries(input) {
      return callProjected(
        "listVendorEntries",
        "read",
        "vendor_finance_list_vendor_entries",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_before_sequence: input.before_sequence,
          p_entry_type: input.entry_type,
          p_page_size: input.page_size,
        },
        projectVendorFinanceEntriesPage,
      );
    },

    getEntry(input) {
      return callProjected(
        "getEntry",
        "read",
        "vendor_finance_get_entry",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
        },
        projectVendorFinanceSingleEntry,
      );
    },

    listVendorReconciliations(input) {
      return callProjected(
        "listVendorReconciliations",
        "read",
        "vendor_finance_list_vendor_reconciliations",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_page: input.page,
          p_page_size: input.page_size,
        },
        projectVendorReconciliationsPage,
      );
    },

    recordEntry(input) {
      return callProjected(
        "recordEntry",
        "mutation",
        "vendor_finance_record_entry",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_entry_type: input.entry_type,
          p_amount_minor: input.amount_minor,
          p_effective_date: input.effective_date,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectRecordEntryMutation,
      );
    },

    reverseEntry(input) {
      return callProjected(
        "reverseEntry",
        "mutation",
        "vendor_finance_reverse_entry",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
          p_effective_date: input.effective_date,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectReverseEntryMutation,
      );
    },

    previewOpeningBatch(input) {
      return callProjected(
        "previewOpeningBatch",
        "mutation",
        "vendor_finance_preview_opening_batch",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_cutoff_date: input.cutoff_date,
          p_items: input.items,
        },
        projectOpeningPreview,
      );
    },

    applyOpeningBatch(input) {
      return callProjected(
        "applyOpeningBatch",
        "mutation",
        "vendor_finance_apply_opening_batch",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_cutoff_date: input.cutoff_date,
          p_items: input.items,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectOpeningApplyMutation,
      );
    },

    createReconciliation(input) {
      return callProjected(
        "createReconciliation",
        "mutation",
        "vendor_finance_create_reconciliation",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_as_of_date: input.as_of_date,
          p_confirmed_balance_minor: input.confirmed_balance_minor,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectCreateReconciliationMutation,
      );
    },

    reserveEvidence(input) {
      return callProjected(
        "reserveEvidence",
        "mutation",
        "vendor_finance_reserve_evidence",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_target_kind: input.target_kind,
          p_target_id: input.target_id,
          p_mime_type: input.mime_type,
          p_size_bytes: input.size_bytes,
          p_checksum_sha256: input.checksum_sha256,
          p_ttl_seconds: input.ttl_seconds ?? VENDOR_FINANCE_EVIDENCE_UPLOAD_URL_TTL_SECONDS,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectEvidenceReservationRecord,
      );
    },

    getEvidenceReservationInfo(input) {
      return callProjected(
        "getEvidenceReservationInfo",
        "mutation",
        "vendor_finance_complete_evidence",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_evidence_id: input.evidence_id,
          p_outcome: "INFO",
          p_failure_code: null,
        },
        projectEvidenceReservationInfoRecord,
      );
    },

    finalizeEvidenceReady(input) {
      return callProjected(
        "finalizeEvidenceReady",
        "mutation",
        "vendor_finance_complete_evidence",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_evidence_id: input.evidence_id,
          p_outcome: "READY",
          p_failure_code: null,
        },
        projectEvidenceFinalizeRecord,
      );
    },

    failEvidenceReservation(input) {
      return callProjected(
        "failEvidenceReservation",
        "mutation",
        "vendor_finance_complete_evidence",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_evidence_id: input.evidence_id,
          p_outcome: "FAILED",
          p_failure_code: input.failure_code,
        },
        (raw) => {
          if (
            !isRecord(raw) ||
            !exactKeys(raw, ["evidence_id", "status", "failure_code"]) ||
            typeof raw.evidence_id !== "string" ||
            !UUID_REGEX.test(raw.evidence_id) ||
            raw.status !== "FAILED"
          ) {
            return null;
          }
          return { evidence_id: raw.evidence_id.toLowerCase(), status: "FAILED" as const };
        },
      );
    },

    getEvidenceDownload(input) {
      return callProjected(
        "getEvidenceDownload",
        "read",
        "vendor_finance_get_evidence_download",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_evidence_id: input.evidence_id,
        },
        projectEvidenceDownloadRecord,
      );
    },

    markEvidenceCleaned(input) {
      return callProjected(
        "markEvidenceCleaned",
        "mutation",
        "vendor_finance_mark_evidence_cleaned",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_evidence_id: input.evidence_id,
        },
        (raw) => {
          if (
            !isRecord(raw) ||
            !exactKeys(raw, ["evidence_id", "cleaned"]) ||
            typeof raw.evidence_id !== "string" ||
            !UUID_REGEX.test(raw.evidence_id) ||
            raw.cleaned !== true
          ) {
            return null;
          }
          return { evidence_id: raw.evidence_id.toLowerCase(), cleaned: true as const };
        },
      );
    },
  };
}
