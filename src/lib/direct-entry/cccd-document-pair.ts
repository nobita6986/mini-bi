/**
 * P1.6-I04C3 (addendum) - Pure helper cho cap CCCD hai mat cua mot dong nhap lieu.
 *
 * Khong I/O, khong goi API: module nay chi tinh trang thai 0/2..2/2, validate file va dung ke
 * hoach upload (thu tu reserve/finalize tuan tu, PUT song song). Idempotency key chi gom
 * entry_id + mat + chu ky noi dung, KHONG chua ho ten / ma NLĐ / so CCCD hay bat ky PII nao.
 */

export const CCCD_DOCUMENT_TYPES = ["CCCD_FRONT", "CCCD_BACK"] as const;
export type CccdDocumentType = (typeof CCCD_DOCUMENT_TYPES)[number];

export const CCCD_SLOT_LABELS: Readonly<Record<CccdDocumentType, string>> = Object.freeze({
  CCCD_FRONT: "CCCD mặt trước",
  CCCD_BACK: "CCCD mặt sau",
});

/** Cung gioi han voi document editor hien huu (khong tu dat rule moi). */
export const CCCD_MAX_BYTES = 10 * 1024 * 1024;
export const CCCD_MIME_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;

export type CccdDocumentSummary = {
  document_type: string;
  upload_status: string;
  validation_status: string;
  scan_status?: string;
};

function isComplete(document: CccdDocumentSummary): boolean {
  return document.upload_status === "READY" &&
    document.validation_status === "VALIDATED" &&
    (document.scan_status === undefined || document.scan_status === "NOT_REQUIRED" ||
      document.scan_status === "CLEAN");
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

/** Nhan cot "Ho so CCCD": 0/2, 1/2 hoac 2/2. */
export function cccdProgressLabel(documents: readonly CccdDocumentSummary[]): string {
  const complete = cccdSlotComplete(documents);
  const done = CCCD_DOCUMENT_TYPES.filter((type) => complete[type]).length;
  return String(done) + "/2";
}

export type CccdUploadFile = {
  documentType: CccdDocumentType;
  sizeBytes: number;
  mimeType: string;
  /** Chu ky noi dung (vd hash) do tang UI tinh; KHONG chua PII. */
  contentSignature: string;
};

export type CccdPlanError = { documentType: CccdDocumentType | null; message: string };

export type CccdUploadPlan =
  | { ok: true; order: readonly CccdDocumentType[]; intentKeys: Readonly<Record<CccdDocumentType, string>> }
  | { ok: false; errors: CccdPlanError[] };

/** Key idempotency: chi entry_id + mat + chu ky noi dung (khong PII). */
export function cccdIntentKey(input: {
  entryId: string;
  documentType: CccdDocumentType;
  contentSignature: string;
}): string {
  return "cccd:" + input.entryId + ":" + input.documentType + ":" + input.contentSignature;
}

/**
 * Dung ke hoach upload cho dung hai mat trong mot luot:
 * - phai co du va duy nhat moi mat mot file;
 * - validate size/mime theo gioi han hien huu;
 * - thu tu reserve/finalize tuan tu CCCD_FRONT -> CCCD_BACK (PUT co the song song).
 */
export function buildCccdUploadPlan(input: {
  entryId: string;
  entryVersion: number;
  files: readonly CccdUploadFile[];
}): CccdUploadPlan {
  const errors: CccdPlanError[] = [];
  if (!input.entryId) {
    return { ok: false, errors: [{ documentType: null,
      message: "Dòng chưa được lưu trên máy chủ nên chưa thể tải hồ sơ." }] };
  }
  if (!Number.isSafeInteger(input.entryVersion) || input.entryVersion < 1) {
    return { ok: false, errors: [{ documentType: null,
      message: "Phiên bản dòng không hợp lệ; hãy tải lại trạng thái mới." }] };
  }
  const bySlot = new Map<CccdDocumentType, CccdUploadFile[]>();
  for (const file of input.files) {
    const current = bySlot.get(file.documentType) ?? [];
    current.push(file);
    bySlot.set(file.documentType, current);
  }
  for (const type of CCCD_DOCUMENT_TYPES) {
    const files = bySlot.get(type) ?? [];
    if (files.length === 0) {
      errors.push({ documentType: type, message: "Thiếu tệp cho " + CCCD_SLOT_LABELS[type] + "." });
      continue;
    }
    if (files.length > 1) {
      errors.push({ documentType: type, message: "Chỉ nhận một tệp cho " + CCCD_SLOT_LABELS[type] + "." });
      continue;
    }
    const file = files[0];
    if (file.sizeBytes < 1 || file.sizeBytes > CCCD_MAX_BYTES) {
      errors.push({ documentType: type, message: "Tệp phải lớn hơn 0 và không vượt quá 10 MiB." });
      continue;
    }
    if (!CCCD_MIME_TYPES.some((mime) => mime === file.mimeType)) {
      errors.push({ documentType: type, message: "Chỉ chấp nhận JPEG, PNG hoặc PDF." });
      continue;
    }
    if (file.contentSignature.trim() === "") {
      errors.push({ documentType: type, message: "Không xác định được nội dung tệp." });
      continue;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const intentKeys: Record<CccdDocumentType, string> = { CCCD_FRONT: "", CCCD_BACK: "" };
  for (const type of CCCD_DOCUMENT_TYPES) {
    const file = (bySlot.get(type) ?? [])[0];
    intentKeys[type] = cccdIntentKey({ entryId: input.entryId, documentType: type,
      contentSignature: file.contentSignature.trim() });
  }
  return { ok: true, order: CCCD_DOCUMENT_TYPES, intentKeys };
}
