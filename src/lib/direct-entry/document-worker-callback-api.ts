import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { DirectEntryRepository } from "./write-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MIME_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);
const CALLBACK_FIELDS = [
  "callback_id",
  "document_id",
  "document_version",
  "event_sequence",
  "attempt",
  "storage_object_ref",
  "checksum_sha256",
  "size_bytes",
  "mime_type",
  "upload_outcome",
  "scan_outcome",
] as const;

type WorkerCallback = {
  callback_id: string;
  document_id: string;
  document_version: number;
  event_sequence: number;
  attempt: number;
  storage_object_ref: string;
  checksum_sha256: string;
  size_bytes: number;
  mime_type: string;
  upload_outcome: "success" | "transient_failure";
  scan_outcome: "pending" | "clean" | "infected" | "suspicious";
};

type Dependencies = {
  repository: DirectEntryRepository;
  secret: string | undefined;
};

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function fail(code: string, status: number): Response {
  return json({ ok: false, code }, status);
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function authenticated(secret: string | undefined, signature: string | null, body: Uint8Array): boolean {
  if (!secret || Buffer.byteLength(secret, "utf8") < 32 ||
      signature === null || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const received = Buffer.from(signature.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function integerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= minimum && value <= maximum;
}

function parsePayload(text: string): WorkerCallback | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== CALLBACK_FIELDS.length ||
      !CALLBACK_FIELDS.every((field) => Object.hasOwn(record, field)) ||
      typeof record.callback_id !== "string" || !UUID.test(record.callback_id) ||
      typeof record.document_id !== "string" || !UUID.test(record.document_id) ||
      !integerBetween(record.document_version, 1, Number.MAX_SAFE_INTEGER) ||
      !integerBetween(record.event_sequence, 1, Number.MAX_SAFE_INTEGER) ||
      !integerBetween(record.attempt, 1, 3) ||
      typeof record.storage_object_ref !== "string" ||
      record.storage_object_ref.length < 1 || record.storage_object_ref.length > 512 ||
      typeof record.checksum_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.checksum_sha256) ||
      !integerBetween(record.size_bytes, 1, MAX_FILE_BYTES) ||
      typeof record.mime_type !== "string" || !MIME_TYPES.has(record.mime_type) ||
      (record.upload_outcome !== "success" && record.upload_outcome !== "transient_failure") ||
      (record.scan_outcome !== "pending" && record.scan_outcome !== "clean" &&
        record.scan_outcome !== "infected" && record.scan_outcome !== "suspicious") ||
      (record.upload_outcome === "transient_failure" && record.scan_outcome !== "pending")) {
    return null;
  }
  return {
    callback_id: record.callback_id,
    document_id: record.document_id,
    document_version: record.document_version,
    event_sequence: record.event_sequence,
    attempt: record.attempt,
    storage_object_ref: record.storage_object_ref,
    checksum_sha256: record.checksum_sha256,
    size_bytes: record.size_bytes,
    mime_type: record.mime_type,
    upload_outcome: record.upload_outcome,
    scan_outcome: record.scan_outcome,
  };
}

export async function receiveDocumentWorkerCallback(
  request: Request,
  flag: string | undefined,
  dependencies: Dependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  const signature = request.headers.get("x-direct-entry-signature");
  if (!dependencies.secret || Buffer.byteLength(dependencies.secret, "utf8") < 32 ||
      signature === null || !/^sha256=[a-f0-9]{64}$/i.test(signature)) {
    return fail("CALLBACK_UNAUTHORIZED", 401);
  }

  const body = await readBoundedBody(request);
  if (!body) return fail("CALLBACK_REQUEST_INVALID", 400);
  if (!authenticated(dependencies.secret, signature, body)) return fail("CALLBACK_UNAUTHORIZED", 401);

  if (request.headers.get("content-type")?.toLowerCase() !== "application/json") {
    return fail("CALLBACK_REQUEST_INVALID", 400);
  }
  const callback = parsePayload(new TextDecoder().decode(body));
  if (!callback) return fail("CALLBACK_REQUEST_INVALID", 400);
  try {
    const result = await dependencies.repository.applyDocumentWorkerCallback(callback);
    if (!result.ok) {
      if (result.kind === "conflict") return fail("DOCUMENT_CALLBACK_CONFLICT", 409);
      if (result.kind === "denied" || result.kind === "not-found") {
        return fail("DOCUMENT_CALLBACK_NOT_FOUND", 404);
      }
      if (result.kind === "invalid") return fail("CALLBACK_REQUEST_INVALID", 400);
      return fail("DOCUMENT_CALLBACK_UNAVAILABLE", 500);
    }
    return json({ ok: true, ...result.data }, 200);
  } catch {
    return fail("DOCUMENT_CALLBACK_UNAVAILABLE", 500);
  }
}

export function signDocumentWorkerCallback(body: Uint8Array, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
