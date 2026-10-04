/**
 * P1.6-I04C3-R2 - Projection chi tiet mot entry (documents + version).
 *
 * Duoc extract tu DirectEntryDocumentEditor de dung chung cho cot/dialog "Ho so CCCD".
 * Strict-project: chi nhan dung cac field nam trong allow-list; bat ky field la khac
 * (checksum, storage_key, bucket, signed URL, ...) => tra null (fail-closed), khong render.
 */
import type { DocumentType } from "../contracts/direct-entry-v1.ts";

/** Cung allow-list voi projectEntry cua server (write-api.ts). */
const DOCUMENT_KEYS = new Set([
  "document_id", "document_type", "version", "size_bytes", "mime_type",
  "upload_status", "scan_status", "validation_status", "created_at", "updated_at",
]);

export const DETAIL_DOCUMENT_TYPES: readonly DocumentType[] = Object.freeze([
  "CCCD_FRONT",
  "CCCD_BACK",
  "EMPLOYMENT_CONTRACT",
]);

export type DocumentDetailSummary = {
  document_id: string;
  document_type: DocumentType;
  version: number;
  size_bytes: number;
  mime_type: string;
  upload_status: string;
  scan_status: string;
  validation_status: string;
};

export type EntryDetailProjection = {
  documents: DocumentDetailSummary[];
  entryVersion: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDetailDocumentType(value: unknown): value is DocumentType {
  return typeof value === "string" && DETAIL_DOCUMENT_TYPES.some((type) => type === value);
}

/**
 * Doc projection tu body { ok: true, entry: { entry_id, version, documents: [...] } }.
 * Tra null khi thieu truong, sai kieu, sai entry_id hoac co field la.
 */
export function projectEntryDetail(
  value: unknown,
  expectedEntryId: string,
): EntryDetailProjection | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.entry)) return null;
  const entry = value.entry;
  if (entry.entry_id !== expectedEntryId) return null;
  if (typeof entry.version !== "number" || !Number.isSafeInteger(entry.version) ||
      entry.version < 1) return null;
  if (!Array.isArray(entry.documents)) return null;
  const documents: DocumentDetailSummary[] = [];
  for (const document of entry.documents) {
    if (!isRecord(document)) return null;
    if (Object.keys(document).some((key) => !DOCUMENT_KEYS.has(key))) return null;
    if (typeof document.document_id !== "string" || !isDetailDocumentType(document.document_type) ||
        typeof document.version !== "number" || !Number.isSafeInteger(document.version) ||
        typeof document.size_bytes !== "number" || !Number.isSafeInteger(document.size_bytes) ||
        typeof document.mime_type !== "string" ||
        typeof document.upload_status !== "string" ||
        typeof document.scan_status !== "string" ||
        typeof document.validation_status !== "string") return null;
    documents.push({
      document_id: document.document_id,
      document_type: document.document_type,
      version: document.version,
      size_bytes: document.size_bytes,
      mime_type: document.mime_type,
      upload_status: document.upload_status,
      scan_status: document.scan_status,
      validation_status: document.validation_status,
    });
  }
  return { documents, entryVersion: entry.version };
}

export type DetailFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Dung mot GET duy nhat cho mot lan mo ho so. Moi loi (mang/HTTP/projection) => null. */
export async function fetchEntryDetail(
  entryId: string,
  fetchImpl: DetailFetch,
): Promise<EntryDetailProjection | null> {
  try {
    const response = await fetchImpl(
      "/api/direct-entry/entries/" + encodeURIComponent(entryId),
      { cache: "no-store", credentials: "same-origin" },
    );
    if (!response.ok) return null;
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      return null;
    }
    return projectEntryDetail(body, entryId);
  } catch {
    return null;
  }
}
