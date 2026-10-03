import {
  DOCUMENT_MAX_BYTES_HARD_LIMIT,
  DOCUMENT_MIME_TYPES,
  type DocumentType,
} from "../contracts/direct-entry-v1.ts";

export const DOCUMENT_MAX_BYTES = DOCUMENT_MAX_BYTES_HARD_LIMIT;
export const DOCUMENT_MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const DOCUMENT_TYPES: readonly DocumentType[] = [
  "CCCD_FRONT",
  "CCCD_BACK",
  "EMPLOYMENT_CONTRACT",
];
type DocumentMimeType = typeof DOCUMENT_MIME_TYPES[number];

export type DocumentFileCheck =
  | { ok: true; document_type: DocumentType; mime_type: DocumentMimeType }
  | { ok: false; code: "DOCUMENT_TYPE_INVALID" | "DOCUMENT_FILE_REQUIRED" |
      "DOCUMENT_SIZE_INVALID" | "DOCUMENT_MIME_INVALID" | "DOCUMENT_CONTENT_INVALID" };

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === "string" && DOCUMENT_TYPES.some((type) => type === value);
}

function isDocumentMimeType(value: unknown): value is DocumentMimeType {
  return typeof value === "string" &&
    DOCUMENT_MIME_TYPES.some((mimeType) => mimeType === value);
}

export function checkDocumentFile(input: {
  document_type: unknown;
  mime_type: unknown;
  size_bytes: number;
  bytes: Uint8Array;
}): DocumentFileCheck {
  if (!isDocumentType(input.document_type)) {
    return { ok: false, code: "DOCUMENT_TYPE_INVALID" };
  }
  if (!Number.isSafeInteger(input.size_bytes) || input.size_bytes < 1 ||
      input.size_bytes > DOCUMENT_MAX_BYTES) {
    return { ok: false, code: "DOCUMENT_SIZE_INVALID" };
  }
  if (!isDocumentMimeType(input.mime_type)) {
    return { ok: false, code: "DOCUMENT_MIME_INVALID" };
  }

  const bytes = input.bytes;
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const isPdf = bytes.length >= 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46 && bytes[4] === 0x2d;
  if ((input.mime_type === "image/jpeg" && !isJpeg) ||
      (input.mime_type === "image/png" && !isPng) ||
      (input.mime_type === "application/pdf" && !isPdf)) {
    return { ok: false, code: "DOCUMENT_CONTENT_INVALID" };
  }
  return {
    ok: true,
    document_type: input.document_type,
    mime_type: input.mime_type,
  };
}
