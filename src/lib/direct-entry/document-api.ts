import "server-only";

import { createHash } from "node:crypto";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import type { DocumentType } from "../contracts/direct-entry-v1.ts";
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MULTIPART_OVERHEAD_BYTES,
  checkDocumentFile,
  isDocumentType,
} from "./document-upload-contract.ts";
import type {
  DocumentStorageAdapter,
  DocumentUploadRequest,
} from "./document-storage-adapter.ts";
import type { DirectEntryRepository } from "./write-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MULTIPART_BYTES = DOCUMENT_MAX_BYTES + DOCUMENT_MULTIPART_OVERHEAD_BYTES;
const FORM_KEYS = new Set(["file", "document_type", "expected_entry_version", "reason"]);

type Dependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: DirectEntryRepository;
  storage: DocumentStorageAdapter;
};

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function fail(code: string, status: number, details?: Record<string, unknown>): Response {
  return json({ ok: false, code, ...details }, status);
}

async function readBoundedBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_MULTIPART_BYTES)) return null;
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MULTIPART_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bodyBuffer = new ArrayBuffer(size);
    const body = new Uint8Array(bodyBuffer);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function parseMultipart(request: Request): Promise<FormData | null> {
  const body = await readBoundedBody(request);
  if (!body) return null;
  try {
    const headers = new Headers(request.headers);
    headers.set("content-length", String(body.byteLength));
    return await new Request(request.url, {
      method: "POST",
      headers,
      body: body.buffer,
    }).formData();
  } catch {
    return null;
  }
}

type ParsedMultipart =
  | {
      ok: true;
      document_type: DocumentType;
      expected_entry_version: number;
      reason: string | null;
      file: File;
    }
  | { ok: false; code: string };

function parseAuthorityValue(value: FormDataEntryValue): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseMultipartFields(form: FormData): ParsedMultipart {
  const fields = new Map<string, FormDataEntryValue>();
  for (const [key, value] of form.entries()) {
    if (fields.has(key)) return { ok: false, code: "DOCUMENT_REQUEST_INVALID" };
    fields.set(key, value);
  }
  const authorityCheck = validateClientBusinessPayload(Object.fromEntries(
    [...fields]
      .filter(([key]) => key !== "file")
      .map(([key, value]) => [key, parseAuthorityValue(value)]),
  ));
  if (!authorityCheck.ok) {
    return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
  }
  if ([...fields.keys()].some((key) => !FORM_KEYS.has(key))) {
    return { ok: false, code: "DOCUMENT_REQUEST_INVALID" };
  }

  const type = fields.get("document_type");
  const version = fields.get("expected_entry_version");
  const reasonValue = fields.get("reason");
  const file = fields.get("file");
  if (file === undefined) return { ok: false, code: "DOCUMENT_FILE_REQUIRED" };
  if (!(file instanceof File)) return { ok: false, code: "DOCUMENT_FILE_REQUIRED" };
  if (!isDocumentType(type)) return { ok: false, code: "DOCUMENT_TYPE_INVALID" };
  if (typeof version !== "string" || !/^[1-9]\d{0,8}$/.test(version) ||
      !Number.isSafeInteger(Number(version))) {
    return { ok: false, code: "DOCUMENT_REQUEST_INVALID" };
  }
  if (reasonValue !== undefined && (typeof reasonValue !== "string" ||
      reasonValue.trim().length < 1 || reasonValue.length > 4000)) {
    return { ok: false, code: "DOCUMENT_REQUEST_INVALID" };
  }
  return {
    ok: true,
    document_type: type,
    expected_entry_version: Number(version),
    reason: typeof reasonValue === "string" ? reasonValue : null,
    file,
  };
}

export async function uploadDirectEntryDocument(
  request: Request,
  entryId: string,
  flag: string | undefined,
  dependencies: Dependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(entryId)) return fail("ENTRY_ID_INVALID", 400);
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    return fail("CONTENT_TYPE_INVALID", 400);
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null || idempotencyKey.trim() === "" ||
      idempotencyKey.length > 128) return fail("IDEMPOTENCY_KEY_INVALID", 400);

  const form = await parseMultipart(request);
  if (!form) return fail("MULTIPART_INVALID", 400);
  const parsed = parseMultipartFields(form);
  if (!parsed.ok) return fail(parsed.code, 400);
  if (parsed.file.size > DOCUMENT_MAX_BYTES || parsed.file.size < 1) {
    return fail("DOCUMENT_SIZE_INVALID", 400);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await parsed.file.arrayBuffer());
  } catch {
    return fail("DOCUMENT_FILE_REQUIRED", 400);
  }
  if (bytes.byteLength !== parsed.file.size) {
    return fail("DOCUMENT_CONTENT_INVALID", 400);
  }
  const fileCheck = checkDocumentFile({
    document_type: parsed.document_type,
    mime_type: parsed.file.type,
    size_bytes: parsed.file.size,
    bytes,
  });
  if (!fileCheck.ok) return fail(fileCheck.code, 400);

  const checksum = createHash("sha256").update(bytes).digest("hex");
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const actor = session.actor.actor;
    if (!actor.capabilities.includes("document_upload")) return fail("DOCUMENT_DENIED", 403);
    if (!dependencies.storage.available()) {
      return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);
    }
    const trustedActor = {
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
    };

    const reservation = await dependencies.repository.reserveDocumentUpload({
      ...trustedActor,
      entry_id: entryId,
      expected_entry_version: parsed.expected_entry_version,
      document_type: parsed.document_type,
      idempotency_key: idempotencyKey,
      checksum_sha256: checksum,
      size_bytes: parsed.file.size,
      mime_type: parsed.file.type,
      reason: parsed.reason,
    });
    if (!reservation.ok) {
      if (reservation.kind === "conflict") return fail("DOCUMENT_VERSION_CONFLICT", 409);
      if (reservation.kind === "denied" || reservation.kind === "not-found") {
        return fail("ENTRY_NOT_FOUND", 404);
      }
      if (reservation.kind === "invalid") return fail("DOCUMENT_REQUEST_INVALID", 400);
      console.error("[direct-entry] document reservation unavailable");
      return fail("DOCUMENT_UNAVAILABLE", 500);
    }

    if (reservation.data.upload_status === "READY" &&
        reservation.data.scan_status === "CLEAN") {
      return json({
        ok: true,
        document_id: reservation.data.document_id,
        version: reservation.data.version,
        entry_version: reservation.data.entry_version,
        upload_status: reservation.data.upload_status,
        scan_status: reservation.data.scan_status,
        reused: reservation.data.reused,
      }, 200);
    }

    const upload: DocumentUploadRequest = {
      entry_id: entryId,
      document_id: reservation.data.document_id,
      document_type: parsed.document_type,
      version: reservation.data.version,
      storage_key: reservation.data.storage_key,
      checksum_sha256: checksum,
      size_bytes: parsed.file.size,
      mime_type: parsed.file.type,
      bytes,
      idempotency_key: idempotencyKey,
    };
    let stored: Awaited<ReturnType<DocumentStorageAdapter["upload"]>>;
    try {
      stored = await dependencies.storage.upload(upload);
    } catch {
      console.error("[direct-entry] document storage unavailable");
      return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503, {
        document_id: reservation.data.document_id,
        version: reservation.data.version,
        entry_version: reservation.data.entry_version,
        reused: reservation.data.reused,
      });
    }
    if (!stored || stored.kind === "unavailable") {
      return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503, {
        document_id: reservation.data.document_id,
        version: reservation.data.version,
        entry_version: reservation.data.entry_version,
        reused: reservation.data.reused,
      });
    }
    if (stored.document_id !== reservation.data.document_id ||
        stored.version !== reservation.data.version ||
        stored.storage_key !== reservation.data.storage_key ||
        typeof stored.checksum_sha256 !== "string" || stored.checksum_sha256 !== checksum ||
        typeof stored.object_version !== "string" || stored.object_version.length < 1) {
      console.error("[direct-entry] document storage acknowledgement invalid");
      return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503, {
        document_id: reservation.data.document_id,
        version: reservation.data.version,
        entry_version: reservation.data.entry_version,
        reused: reservation.data.reused,
      });
    }
    return json({
      ok: true,
      document_id: reservation.data.document_id,
      version: reservation.data.version,
      entry_version: reservation.data.entry_version,
      upload_status: reservation.data.upload_status,
      scan_status: reservation.data.scan_status,
      reused: reservation.data.reused,
      callback_pending: true,
    }, 202);
  } catch {
    console.error("[direct-entry] document upload request failed");
    return fail("DOCUMENT_UNAVAILABLE", 500);
  }
}
