import "server-only";

import type { DocumentType } from "../contracts/direct-entry-v1.ts";

export type DocumentUploadRequest = {
  entry_id: string;
  document_id: string;
  document_type: DocumentType;
  version: number;
  storage_key: string;
  checksum_sha256: string;
  size_bytes: number;
  mime_type: string;
  bytes: Uint8Array;
  idempotency_key: string;
};

export type DurableDocumentUpload = {
  kind: "durable";
  document_id: string;
  version: number;
  storage_key: string;
  object_version: string;
  checksum_sha256: string;
};

export type DocumentStorageResult =
  | DurableDocumentUpload
  | { kind: "unavailable" };

export type DocumentStorageAdapter = {
  available(): boolean;
  upload(request: DocumentUploadRequest): Promise<DocumentStorageResult>;
};

export const unavailableDocumentStorageAdapter: DocumentStorageAdapter = {
  available() {
    return false;
  },
  async upload() {
    return { kind: "unavailable" };
  },
};
