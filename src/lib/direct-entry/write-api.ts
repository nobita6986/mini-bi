import {
  validateClientBusinessPayload,
} from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import {
  validateEmployeeCode,
  validateWorkerDetails,
  type WorkerDetails,
} from "../contracts/direct-entry-v1.ts";
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import type { DirectEntryRepository } from "./write-repository.ts";

const MAX_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROW_KEYS = new Set([
  "project_id", "first_work_date", "employee_code", "worker", "recruiter_id", "labor_type",
]);
const WORKER_KEYS = new Set([
  "display_name", "date_of_birth", "national_id", "address", "phone",
]);

type WriteDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: DirectEntryRepository;
};

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function error(code: string, status: number): Response {
  return json({ ok: false, code }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkerDetails(value: unknown): value is WorkerDetails {
  if (!isRecord(value) || Object.keys(value).some((key) => !WORKER_KEYS.has(key)) ||
      typeof value.display_name !== "string") return false;
  return ["date_of_birth", "national_id", "address", "phone"].every((key) => {
    const field = value[key];
    if (!isRecord(field)) return false;
    if (field.state === "omitted" || field.state === "unknown" ||
        field.state === "intentionally_blank") return Object.keys(field).length === 1;
    return field.state === "provided" && typeof field.value === "string" &&
      Object.keys(field).length === 2;
  });
}

async function readBoundedJson(request: Request): Promise<unknown | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) return null;
  if (!request.body) return null;

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function projectRows(value: unknown): Array<Record<string, unknown>> | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "rows") ||
      !Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 100) return null;

  const codes: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  for (const item of value.rows) {
    if (!isRecord(item) || Object.keys(item).some((key) => !ROW_KEYS.has(key))) return null;
    const {
      project_id,
      first_work_date,
      employee_code,
      worker,
      recruiter_id,
      labor_type,
    } = item;
    if (typeof project_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(project_id) ||
        typeof first_work_date !== "string" || !isRealCalendarDate(first_work_date) ||
        typeof employee_code !== "string" ||
        typeof recruiter_id !== "string" || !UUID.test(recruiter_id) ||
        (labor_type !== "TEMPORARY" && labor_type !== "PERMANENT") ||
        !isWorkerDetails(worker) ||
        validateWorkerDetails(worker).length > 0 ||
        validateEmployeeCode(employee_code, first_work_date, codes).length > 0) return null;
    codes.push(employee_code);
    rows.push({
      project_id,
      first_work_date,
      employee_code,
      worker_details: worker,
      recruiter_id,
      labor_type,
    });
  }
  return rows;
}

function parseBatchResult(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || Object.keys(value).some((key) =>
    !["submission_id", "state", "version", "entry_ids"].includes(key)
  ) || !UUID.test(String(value.submission_id)) || value.state !== "DRAFT" ||
      typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1 ||
      !Array.isArray(value.entry_ids) ||
      value.entry_ids.length < 1 || value.entry_ids.length > 100 ||
      !value.entry_ids.every((id) => typeof id === "string" && UUID.test(id)) ||
      new Set(value.entry_ids).size !== value.entry_ids.length) return null;
  return {
    submission_id: value.submission_id,
    submission_version: value.version,
    entry_ids: value.entry_ids,
    status: value.state,
  };
}

export async function postDirectEntryBatch(
  request: Request,
  flag: string | undefined,
  dependencies: WriteDependencies,
): Promise<Response> {
  if (flag !== "true") return error("NOT_FOUND", 404);

  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return error("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return error("CONTENT_TYPE_INVALID", 400);
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null || idempotencyKey.length < 1 || idempotencyKey.length > 128 ||
      idempotencyKey.trim().length === 0) return error("IDEMPOTENCY_KEY_INVALID", 400);

  const body = await readBoundedJson(request);
  if (body === null) return error("BODY_INVALID", 400);
  let rows: Array<Record<string, unknown>> | null;
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return error("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
    rows = projectRows(body);
  } catch {
    return error("BATCH_INVALID", 400);
  }
  if (!rows) return error("BATCH_INVALID", 400);

  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? error("UNAUTHENTICATED", 401)
        : error("ACTOR_NOT_AVAILABLE", 403);
    }
    const actor = session.actor.actor;
    const result = await dependencies.repository.createBatch({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      rows,
      idempotency_key: idempotencyKey,
    });
    if (!result.ok) {
      if (result.kind === "conflict") return error("IDEMPOTENCY_CONFLICT", 409);
      if (result.kind === "denied") return error("ACTOR_DENIED", 403);
      if (result.kind === "invalid") return error("BATCH_INVALID", 400);
      console.error("[direct-entry] batch RPC unavailable");
      return error("BATCH_UNAVAILABLE", 500);
    }
    const projection = parseBatchResult(result.data);
    if (!projection) {
      console.error("[direct-entry] batch RPC returned malformed projection");
      return error("BATCH_UNAVAILABLE", 500);
    }
    return json({ ok: true, ...projection }, 201);
  } catch {
    console.error("[direct-entry] batch request failed");
    return error("BATCH_UNAVAILABLE", 500);
  }
}

const ENTRY_UUID = UUID;
const ENTRY_KEYS = new Set([
  "entry_id", "submission_id", "project_id", "first_work_date", "employee_code",
  "worker_details", "recruiter_id", "team_id", "provider_type", "labor_type",
  "version", "scope_kind", "payment", "employment_status", "documents",
]);
const WORKER_PROJECTION_KEYS = new Set(WORKER_KEYS);
const PAYMENT_KEYS = new Set([
  "state", "account_number", "bank_id", "account_holder_name", "version",
]);
const STATUS_KEYS = new Set(["status", "effective_date", "version"]);
const DOCUMENT_KEYS = new Set([
  "document_id", "document_type", "version", "size_bytes", "mime_type",
  "upload_status", "scan_status",
]);

function projectEntry(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !ENTRY_KEYS.has(key)) ||
      !ENTRY_UUID.test(String(value.entry_id)) || !ENTRY_UUID.test(String(value.submission_id)) ||
      typeof value.project_id !== "string" || typeof value.first_work_date !== "string" ||
      !isRealCalendarDate(value.first_work_date) ||
      typeof value.employee_code !== "string" ||
      validateEmployeeCode(value.employee_code, value.first_work_date).length > 0 ||
      typeof value.worker_details !== "object" ||
      value.worker_details === null || Array.isArray(value.worker_details) ||
      typeof value.recruiter_id !== "string" || !ENTRY_UUID.test(value.recruiter_id) ||
      typeof value.team_id !== "string" || !ENTRY_UUID.test(value.team_id) ||
      (value.provider_type !== "hrp" && value.provider_type !== "vendor") ||
      (value.labor_type !== "TEMPORARY" && value.labor_type !== "PERMANENT") ||
      typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1 ||
      (value.scope_kind !== "own" && value.scope_kind !== "team" && value.scope_kind !== "all") ||
      (value.payment !== null && !isRecord(value.payment)) ||
      !isRecord(value.employment_status) ||
      !Array.isArray(value.documents)) return null;
  const worker = value.worker_details as Record<string, unknown>;
  if (Object.keys(worker).some((key) => !WORKER_PROJECTION_KEYS.has(key)) ||
      Object.entries(worker).some(([key, field]) => {
        if (key === "display_name") return typeof field !== "string";
        if (!isRecord(field) || !["provided", "omitted", "unknown", "intentionally_blank"].includes(
          String(field.state),
        )) return true;
        const provided = field.state === "provided";
        return Object.keys(field).length !== (provided ? 2 : 1) ||
          Object.keys(field).some((fieldKey) => fieldKey !== "state" && fieldKey !== "value") ||
          (provided && typeof field.value !== "string");
      })) {
    return null;
  }
  if (value.payment !== null) {
    const payment = value.payment as Record<string, unknown>;
    if (Object.keys(payment).some((key) => !PAYMENT_KEYS.has(key)) ||
        typeof payment.state !== "string" ||
        Object.values(payment).some((field) => field !== null &&
          typeof field !== "string" && typeof field !== "number")) return null;
  }
  const status = value.employment_status as Record<string, unknown>;
  if (Object.keys(status).some((key) => !STATUS_KEYS.has(key)) ||
      typeof status.status !== "string" || typeof status.effective_date !== "string" ||
      !Number.isSafeInteger(status.version)) return null;
  if (value.documents.some((document) => !isRecord(document) ||
      Object.keys(document).some((key) => !DOCUMENT_KEYS.has(key)) ||
      typeof document.document_id !== "string" || !UUID.test(document.document_id) ||
      typeof document.document_type !== "string" ||
      !Number.isSafeInteger(document.version) ||
      typeof document.size_bytes !== "number" || !Number.isSafeInteger(document.size_bytes) ||
      typeof document.mime_type !== "string" ||
      typeof document.upload_status !== "string" ||
      typeof document.scan_status !== "string")) return null;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, child]));
}

type ReadDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: DirectEntryRepository;
};

export async function getDirectEntryEntry(
  entryId: string,
  flag: string | undefined,
  dependencies: ReadDependencies,
): Promise<Response> {
  if (flag !== "true") return error("NOT_FOUND", 404);
  if (!ENTRY_UUID.test(entryId)) return error("ENTRY_ID_INVALID", 400);
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? error("UNAUTHENTICATED", 401)
        : error("ACTOR_NOT_AVAILABLE", 403);
    }
    const actor = session.actor.actor;
    const result = await dependencies.repository.readEntry({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      entry_id: entryId,
    });
    if (!result.ok) {
      if (result.kind === "not-found" || result.kind === "denied") return error("ENTRY_NOT_FOUND", 404);
      console.error("[direct-entry] read projection unavailable");
      return error("ENTRY_UNAVAILABLE", 500);
    }
    const projection = projectEntry(result.data);
    if (!projection) {
      console.error("[direct-entry] read RPC returned malformed projection");
      return error("ENTRY_UNAVAILABLE", 500);
    }
    return json({ ok: true, entry: projection }, 200);
  } catch {
    console.error("[direct-entry] read request failed");
    return error("ENTRY_UNAVAILABLE", 500);
  }
}
