import { createHash } from "node:crypto";
import {
  DOCUMENT_MAX_BYTES_HARD_LIMIT,
  DOCUMENT_MIME_TYPES,
  type DocumentType,
} from "../contracts/direct-entry-v1.ts";
import { checkDocumentFile } from "./document-upload-contract.ts";

export const DOCUMENT_UPLOAD_URL_TTL_SECONDS = 300;
export const DOCUMENT_DOWNLOAD_URL_TTL_SECONDS = 120;
export const DOCUMENT_STAGING_RETENTION_HOURS = 24;

export const DOCUMENT_BUCKETS = {
  preview: "hrp-bi-preview",
  production: "hrp-bi-product",
} as const;

export type DocumentEnvironment = keyof typeof DOCUMENT_BUCKETS;
export type DocumentMimeType = typeof DOCUMENT_MIME_TYPES[number];

const STORAGE_KEY = new RegExp(
  "^p1\\.6/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/" +
    "(?:CCCD_FRONT|CCCD_BACK|EMPLOYMENT_CONTRACT)/[1-9]\\d*/" +
    "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  "i",
);

export function isOpaqueStorageKey(value: unknown): value is string {
  return typeof value === "string" && STORAGE_KEY.test(value);
}

export function stagingObjectKey(environment: DocumentEnvironment, storageKey: string): string {
  if (!isOpaqueStorageKey(storageKey)) throw new Error("storage key invalid");
  return `${environment}/staging/${storageKey}`;
}

export function finalObjectKey(environment: DocumentEnvironment, storageKey: string): string {
  if (!isOpaqueStorageKey(storageKey)) throw new Error("storage key invalid");
  return `${environment}/final/${storageKey}`;
}

const EXTENSIONS: Record<DocumentMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};

export function genericDownloadName(
  documentType: DocumentType,
  version: number,
  mimeType: DocumentMimeType,
): string {
  return `${documentType.toLowerCase().replaceAll("_", "-")}-v${version}.${EXTENSIONS[mimeType]}`;
}

export function attachmentDisposition(fileName: string): string {
  return `attachment; filename="${fileName}"`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type ContentInspection =
  | { ok: true }
  | { ok: false; code: "DOCUMENT_SIZE_INVALID" | "DOCUMENT_MIME_INVALID" | "DOCUMENT_CONTENT_INVALID" };

function containsAscii(bytes: Uint8Array, needles: readonly string[], limit: number): boolean {
  const text = Buffer.from(bytes.subarray(0, Math.min(bytes.length, limit))).toString("latin1")
    .toLowerCase();
  return needles.some((needle) => text.includes(needle));
}

// Magic bytes plus structural trailers and embedded-markup rejection for polyglot files.
export function inspectDocumentContent(input: {
  document_type: DocumentType;
  mime_type: string;
  bytes: Uint8Array;
}): ContentInspection {
  const basic = checkDocumentFile({
    document_type: input.document_type,
    mime_type: input.mime_type,
    size_bytes: input.bytes.length,
    bytes: input.bytes,
  });
  if (!basic.ok) {
    return {
      ok: false,
      code: basic.code === "DOCUMENT_SIZE_INVALID" || basic.code === "DOCUMENT_MIME_INVALID"
        ? basic.code
        : "DOCUMENT_CONTENT_INVALID",
    };
  }
  const { bytes } = input;
  const markup = ["<script", "<html", "<?php", "<svg", "<!doctype"];
  if (input.mime_type === "application/pdf") {
    const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).toString("latin1");
    if (!tail.includes("%%EOF") || containsAscii(bytes, markup, 1024)) {
      return { ok: false, code: "DOCUMENT_CONTENT_INVALID" };
    }
    return { ok: true };
  }
  if (containsAscii(bytes, markup, bytes.length)) {
    return { ok: false, code: "DOCUMENT_CONTENT_INVALID" };
  }
  if (input.mime_type === "image/png") {
    const iend = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
    const end = bytes.length - iend.length;
    if (end < 8 || !iend.every((byte, index) => bytes[end + index] === byte)) {
      return { ok: false, code: "DOCUMENT_CONTENT_INVALID" };
    }
    return { ok: true };
  }
  let last = bytes.length - 1;
  while (last > 0 && bytes[last] === 0) last -= 1;
  if (last < 3 || bytes[last - 1] !== 0xff || bytes[last] !== 0xd9) {
    return { ok: false, code: "DOCUMENT_CONTENT_INVALID" };
  }
  return { ok: true };
}

export const DOCUMENT_MAX_UPLOAD_BYTES = DOCUMENT_MAX_BYTES_HARD_LIMIT;

export type StagingCleanupDecision = "keep" | "delete-invalid" | "eligible-for-cleanup";

// Cleanup contract only; no scheduler or network call is part of R2A.
export function classifyStagingObject(input: {
  ageHours: number;
  invalid: boolean;
  finalized: boolean;
}): StagingCleanupDecision {
  if (input.invalid) return "delete-invalid";
  if (input.finalized) return "eligible-for-cleanup";
  return input.ageHours >= DOCUMENT_STAGING_RETENTION_HOURS ? "eligible-for-cleanup" : "keep";
}

export const DOCUMENT_RETENTION = {
  stagingAbandonedHours: DOCUMENT_STAGING_RETENTION_HOURS,
  invalidUpload: "delete-immediately",
  acceptedVersions: "retain-no-auto-delete",
  replacement: "new-version-never-overwrites",
  adminPurge: "audited-later-phase",
} as const;
