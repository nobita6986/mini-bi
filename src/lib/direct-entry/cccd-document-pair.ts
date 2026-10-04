/**
 * P1.6-I04C3 (addendum) R1 - Pure helper cho cap CCCD hai mat cua mot dong nhap lieu.
 *
 * Khong I/O. Constants MIME/10 MiB duoc IMPORT tu contract hien huu (khong nhan ban).
 * Idempotency: intent fingerprint = entryId + entryVersion + documentType + sha256; API key la UUID
 * ngau nhien duoc luu theo fingerprint (dung resolveIntentKey cua submission-lifecycle).
 * Fingerprint/key KHONG chua ho ten, ma NLĐ, so CCCD, filename hay duong dan.
 */
import {
  DOCUMENT_MAX_BYTES_HARD_LIMIT,
  DOCUMENT_MIME_TYPES,
} from "../contracts/direct-entry-v1.ts";

export const CCCD_DOCUMENT_TYPES = ["CCCD_FRONT", "CCCD_BACK"] as const;
export type CccdDocumentType = (typeof CCCD_DOCUMENT_TYPES)[number];

export const CCCD_SLOT_LABELS: Readonly<Record<CccdDocumentType, string>> = Object.freeze({
  CCCD_FRONT: "CCCD mặt trước",
  CCCD_BACK: "CCCD mặt sau",
});

export const CCCD_MAX_BYTES = DOCUMENT_MAX_BYTES_HARD_LIMIT;
export const CCCD_MIME_TYPES = DOCUMENT_MIME_TYPES;

/** Nhan cot trang thai khi chua co server projection an toan (fail-closed). */
export const CCCD_STATUS_UNKNOWN_LABEL = "Chưa tải trạng thái";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export type CccdDocumentSummary = {
  document_type: string;
  upload_status: string;
  validation_status: string;
  scan_status: string;
};

function isComplete(document: CccdDocumentSummary): boolean {
  return document.upload_status === "READY" &&
    document.validation_status === "VALIDATED" &&
    (document.scan_status === "CLEAN" || document.scan_status === "NOT_REQUIRED");
}

export function cccdSlotComplete(documents: readonly CccdDocumentSummary[]):
  Readonly<Record<CccdDocumentType, boolean>> {
  const result: Record<CccdDocumentType, boolean> = { CCCD_FRONT: false, CCCD_BACK: false };
  for (const type of CCCD_DOCUMENT_TYPES) {
    result[type] = documents.some((document) =>
      document.document_type === type && isComplete(document));
  }
  return result;
}

function progressFrom(complete: Readonly<Record<CccdDocumentType, boolean>>): string {
  const done = CCCD_DOCUMENT_TYPES.filter((type) => complete[type]).length;
  return String(done) + "/2";
}

/** Nhan cot "Ho so CCCD" tu document summary (0/2, 1/2, 2/2). */
export function cccdProgressLabel(documents: readonly CccdDocumentSummary[]): string {
  return progressFrom(cccdSlotComplete(documents));
}

/** Nhan cot tu server projection de xuat (cccd_front_ready/cccd_back_ready). */
export function cccdProgressFromFlags(flags: {
  cccd_front_ready: boolean;
  cccd_back_ready: boolean;
}): string {
  return progressFrom({ CCCD_FRONT: flags.cccd_front_ready, CCCD_BACK: flags.cccd_back_ready });
}

export type CccdUploadFile = {
  documentType: CccdDocumentType;
  sizeBytes: number;
  mimeType: string;
  /** Lowercase SHA-256 hex (64 ky tu) do UI tinh bang Web Crypto tu bytes. */
  sha256: string;
};

export type CccdPlanError = { documentType: CccdDocumentType | null; message: string };

export type CccdUploadPlan =
  | { ok: true; order: readonly CccdDocumentType[];
      fingerprints: Readonly<Record<CccdDocumentType, string>> }
  | { ok: false; errors: CccdPlanError[] };

/** Intent fingerprint: entryId + entryVersion + mat + sha256 (khong PII). */
export function cccdIntentFingerprint(input: {
  entryId: string;
  entryVersion: number;
  documentType: CccdDocumentType;
  sha256: string;
}): string {
  return "cccd:" + input.entryId + ":" + String(input.entryVersion) + ":" +
    input.documentType + ":" + input.sha256;
}

export function isCccdSha256(value: string): boolean {
  return SHA256_HEX.test(value);
}

/**
 * Ke hoach upload 1 hoac 2 mat trong mot luot:
 * - it nhat mot slot, khong trung slot;
 * - validate UUID entry, entry version, size/mime/sha256;
 * - thu tu FRONT truoc BACK (reserve/finalize tuan tu; PUT co the song song).
 */
export function buildCccdUploadPlan(input: {
  entryId: string;
  entryVersion: number;
  files: readonly CccdUploadFile[];
}): CccdUploadPlan {
  if (!UUID.test(input.entryId)) {
    return { ok: false, errors: [{ documentType: null,
      message: "Dòng chưa được lưu trên máy chủ nên chưa thể tải hồ sơ." }] };
  }
  if (!Number.isSafeInteger(input.entryVersion) || input.entryVersion < 1) {
    return { ok: false, errors: [{ documentType: null,
      message: "Phiên bản dòng không hợp lệ; hãy tải lại trạng thái mới." }] };
  }
  if (input.files.length < 1) {
    return { ok: false, errors: [{ documentType: null, message: "Chưa chọn tệp nào." }] };
  }
  const errors: CccdPlanError[] = [];
  const bySlot = new Map<CccdDocumentType, CccdUploadFile[]>();
  for (const file of input.files) {
    const current = bySlot.get(file.documentType) ?? [];
    current.push(file);
    bySlot.set(file.documentType, current);
  }
  for (const [type, files] of bySlot) {
    if (files.length > 1) {
      errors.push({ documentType: type, message: "Chỉ nhận một tệp cho " + CCCD_SLOT_LABELS[type] + "." });
    }
  }
  for (const type of CCCD_DOCUMENT_TYPES) {
    const files = bySlot.get(type);
    if (!files || files.length !== 1) continue;
    const file = files[0];
    if (file.sizeBytes < 1 || file.sizeBytes > CCCD_MAX_BYTES) {
      errors.push({ documentType: type, message: "Tệp phải lớn hơn 0 và không vượt quá 10 MiB." });
      continue;
    }
    if (!CCCD_MIME_TYPES.some((mime) => mime === file.mimeType)) {
      errors.push({ documentType: type, message: "Chỉ chấp nhận JPEG, PNG hoặc PDF." });
      continue;
    }
    if (!isCccdSha256(file.sha256)) {
      errors.push({ documentType: type, message: "Không xác định được nội dung tệp." });
      continue;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const order = CCCD_DOCUMENT_TYPES.filter((type) => bySlot.has(type));
  const fingerprints: Record<string, string> = {};
  for (const type of order) {
    const file = (bySlot.get(type) ?? [])[0];
    fingerprints[type] = cccdIntentFingerprint({ entryId: input.entryId,
      entryVersion: input.entryVersion, documentType: type, sha256: file.sha256 });
  }
  return { ok: true, order,
    fingerprints: fingerprints as Readonly<Record<CccdDocumentType, string>> };
}
