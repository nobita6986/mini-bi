/**
 * PRE-W2-P1 - API boundary xuat Excel full-PII (POST).
 *
 * Pipeline: gate -> same-origin/CSRF -> content-type -> body -> strict body allowlist ->
 * server session actor -> repository -> strict envelope -> server XLSX -> sanitized response.
 *
 * The request body carries no authority field: the exact allowlist accepts only
 * scope/project_id/recruiter_id/employment_status/reason, so every client-supplied authority
 * key (auth_subject, app_user_id, capability, scope_kind, ...) is refused as an unknown key.
 *
 * Recruited/managed use the DB-verified row authority; company-wide `all` also requires current
 * all scope and the existing entry_admin or change_review action. Khong bao gio nhan identity/capability/scope tu client va khong
 * forward raw DB message, UUID noi bo hay PII trong JSON loi. Khong log body/rows/PII.
 */
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { readBoundedJson } from "./write-api.ts";
import {
  projectWorkerExportRequest,
  WORKER_EXPORT_ROW_LIMIT,
  type WorkerExportRow,
} from "./worker-export-contract.ts";
import type { WorkerExportRepository } from "./worker-export-repository.ts";
import {
  buildWorkerExportXlsx,
  workerExportFilename,
  WORKER_EXPORT_XLSX_CONTENT_TYPE,
} from "./worker-export-xlsx.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkerExportDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: WorkerExportRepository;
  buildXlsx?(rows: readonly WorkerExportRow[]): Promise<Uint8Array>;
};

function sanitizedHeaders(): Record<string, string> {
  return {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

function fail(code: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, code }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...sanitizedHeaders() },
  });
}

function failLimit(): Response {
  return new Response(JSON.stringify({
    ok: false,
    code: "WORKER_EXPORT_ROW_LIMIT_EXCEEDED",
    limit: WORKER_EXPORT_ROW_LIMIT,
  }), {
    status: 422,
    headers: { "content-type": "application/json; charset=utf-8", ...sanitizedHeaders() },
  });
}

export async function exportWorkers(
  request: Request,
  flag: string | undefined,
  dependencies: WorkerExportDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }

  const body = await readBoundedJson(request);
  if (body === null) return fail("BODY_INVALID", 400);
  const parsed = projectWorkerExportRequest(body);
  if (!parsed) return fail("WORKER_EXPORT_REQUEST_INVALID", 400);

  let session: DirectEntrySessionResult;
  try {
    session = await dependencies.resolveSession();
  } catch {
    console.error("[direct-entry] worker export session unavailable");
    return fail("WORKER_EXPORT_UNAVAILABLE", 503);
  }
  if (!session.actor.ok) {
    return session.actor.reason === "UNAUTHENTICATED"
      ? fail("UNAUTHENTICATED", 401)
      : fail("ACTOR_NOT_AVAILABLE", 403);
  }
  const actor = session.actor.actor;
  if (!actor || typeof actor.auth_subject !== "string" || !UUID.test(actor.auth_subject) ||
      typeof actor.app_user_id !== "string" || !UUID.test(actor.app_user_id)) {
    return fail("ACTOR_NOT_AVAILABLE", 403);
  }

  let result: Awaited<ReturnType<WorkerExportRepository["exportWorkers"]>>;
  try {
    result = await dependencies.repository.exportWorkers({ ...actor, ...parsed });
  } catch {
    console.error("[direct-entry] worker export failed");
    return fail("WORKER_EXPORT_UNAVAILABLE", 503);
  }
  if (!result.ok) {
    if (result.kind === "denied") return fail("WORKER_EXPORT_DENIED", 403);
    if (result.kind === "invalid") return fail("WORKER_EXPORT_REQUEST_INVALID", 400);
    console.error("[direct-entry] worker export unavailable");
    return fail("WORKER_EXPORT_UNAVAILABLE", 503);
  }
  if (result.envelope.status === "too_many_rows") return failLimit();

  const buildXlsx = dependencies.buildXlsx ?? buildWorkerExportXlsx;
  let bytes: Uint8Array;
  try {
    bytes = await buildXlsx(result.envelope.rows);
  } catch {
    console.error("[direct-entry] worker export xlsx build failed");
    return fail("WORKER_EXPORT_UNAVAILABLE", 503);
  }

  // Exact copy of the view's bytes as an ArrayBuffer (BodyInit-safe).
  const xlsxBody = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Response(xlsxBody as ArrayBuffer, {
    status: 200,
    headers: {
      "content-type": WORKER_EXPORT_XLSX_CONTENT_TYPE,
      "content-disposition":
        `attachment; filename="${workerExportFilename(new Date().toISOString().slice(0, 10))}"`,
      ...sanitizedHeaders(),
    },
  });
}
