/**
 * P1.6-I04C3-R2 - Transport that cho pipeline CCCD, dung lai cac route hien huu:
 *   POST /api/direct-entry/entries/{entryId}/documents              (reserve)
 *   PUT  <signed url>                                              (upload bytes)
 *   POST /api/direct-entry/entries/{entryId}/documents/{id}/finalize
 *
 * Request KHONG chua filename, duong dan, ho ten, ma NLĐ, so CCCD, checksum hay storage key.
 * Signed URL chi ton tai trong tham so cua mot lan fetch, khong duoc render hay log.
 */
import type { CccdDocumentSummary, CccdDocumentType } from "./cccd-document-pair.ts";
import type {
  CccdFinalizeOutcome,
  CccdReserveOutcome,
  CccdTransport,
} from "./cccd-upload-runner.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codeOf(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.code === "string" && body.code.length > 0
    ? body.code
    : fallback;
}

function isEntryVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function projectReserveResponse(status: number, body: unknown): CccdReserveOutcome {
  if (status === 409) return { kind: "conflict", code: codeOf(body, "DOCUMENT_VERSION_CONFLICT") };
  if (status >= 500) return { kind: "retryable", code: codeOf(body, "DOCUMENT_STORAGE_UNAVAILABLE") };
  if (status >= 200 && status < 300) {
    if (!isRecord(body) || body.ok !== true) {
      // 2xx nhung khong doc duoc: fail-closed, khong coi la da reserve.
      return { kind: "retryable", code: "DOCUMENT_RESPONSE_INVALID" };
    }
    if (typeof body.document_id !== "string" || !isEntryVersion(body.entry_version)) {
      return { kind: "retryable", code: "DOCUMENT_RESPONSE_INVALID" };
    }
    let upload: { url: string; headers: Record<string, string> } | null = null;
    if (body.upload !== undefined && body.upload !== null) {
      if (!isRecord(body.upload) || body.upload.method !== "PUT" ||
          typeof body.upload.url !== "string" || !isRecord(body.upload.headers)) {
        return { kind: "retryable", code: "DOCUMENT_RESPONSE_INVALID" };
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(body.upload.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      upload = { url: body.upload.url, headers };
    }
    return {
      kind: "reserved",
      documentId: body.document_id,
      entryVersion: body.entry_version,
      upload,
    };
  }
  return { kind: "rejected", code: codeOf(body, "DOCUMENT_UPLOAD_FAILED") };
}

export function projectFinalizeResponse(
  status: number,
  body: unknown,
  documentType: CccdDocumentType,
): CccdFinalizeOutcome {
  if (status === 409) return { kind: "conflict", code: codeOf(body, "DOCUMENT_VERSION_CONFLICT") };
  if (status >= 500) return { kind: "retryable", code: codeOf(body, "DOCUMENT_FINALIZE_UNAVAILABLE") };
  if (status >= 200 && status < 300) {
    if (!isRecord(body) || body.ok !== true || !isEntryVersion(body.entry_version) ||
        typeof body.upload_status !== "string" ||
        typeof body.validation_status !== "string" ||
        typeof body.scan_status !== "string") {
      return { kind: "retryable", code: "DOCUMENT_RESPONSE_INVALID" };
    }
    const document: CccdDocumentSummary = {
      document_type: documentType,
      upload_status: body.upload_status,
      validation_status: body.validation_status,
      scan_status: body.scan_status,
    };
    return { kind: "finalized", entryVersion: body.entry_version, document };
  }
  return { kind: "rejected", code: codeOf(body, "DOCUMENT_UPLOAD_FAILED") };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export type CccdTransportFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function createCccdTransport(input: {
  entryId: string;
  reason: string | null;
  /** Bytes cua tung mat; chi duoc dung lam body cua PUT, khong vao fingerprint/idempotency. */
  blobs: Readonly<Partial<Record<CccdDocumentType, Blob>>>;
  fetchImpl: CccdTransportFetch;
  reloadDetail(): Promise<
    { entryVersion: number; documents: readonly CccdDocumentSummary[] } | null
  >;
}): CccdTransport {
  const base = "/api/direct-entry/entries/" + encodeURIComponent(input.entryId) + "/documents";
  const post = async (url: string, key: string, body: unknown) => {
    const response = await input.fetchImpl(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Idempotency-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await readJson(response) };
  };

  return {
    async reserve(request) {
      const body: Record<string, unknown> = {
        document_type: request.documentType,
        expected_entry_version: request.entryVersion,
        size_bytes: request.sizeBytes,
        mime_type: request.mimeType,
      };
      if (input.reason !== null && input.reason !== "") body.reason = input.reason;
      let posted;
      try {
        posted = await post(base, request.idempotencyKey, body);
      } catch {
        return { kind: "retryable", code: "DOCUMENT_STORAGE_UNAVAILABLE" };
      }
      return projectReserveResponse(posted.status, posted.body);
    },

    async put(request) {
      const blob = input.blobs[request.documentType];
      if (!blob) return { ok: false, code: "DOCUMENT_UPLOAD_MISSING" };
      try {
        const response = await input.fetchImpl(request.url, {
          method: "PUT",
          headers: { ...request.headers },
          body: blob,
        });
        return response.ok ? { ok: true } : { ok: false, code: "DOCUMENT_STORAGE_UNAVAILABLE" };
      } catch {
        return { ok: false, code: "DOCUMENT_STORAGE_UNAVAILABLE" };
      }
    },

    async finalize(request) {
      const url = base + "/" + encodeURIComponent(request.documentId) + "/finalize";
      let posted;
      try {
        posted = await post(url, request.idempotencyKey,
          { expected_entry_version: request.entryVersion });
      } catch {
        return { kind: "retryable", code: "DOCUMENT_FINALIZE_UNAVAILABLE" };
      }
      return projectFinalizeResponse(posted.status, posted.body, request.documentType);
    },

    reloadDetail: input.reloadDetail,
  };
}
