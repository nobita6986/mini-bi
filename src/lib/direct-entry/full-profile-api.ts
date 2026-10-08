import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import {
  FULL_PROFILE_MAX_BODY_BYTES,
  parseFullProfilePayload,
} from "./full-profile-contract.ts";
import type { createFullProfileRepository } from "./full-profile-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CLIENT_CODES = new Set([
  "BANK_NOT_ACTIVE", "BATCH_INVALID", "BATCH_SIZE_INVALID",
  "CLIENT_AUTHORITY_FIELD_FORBIDDEN", "CONTRACT_VERSION_UNSUPPORTED",
  "EMPLOYEE_CODE_DUPLICATE", "EMPLOYEE_CODE_FORMAT",
  "EMPLOYEE_CODE_LEGACY_QUARANTINE", "EMPLOYEE_CODE_YEAR",
  "EMPLOYEE_CODE_SEQUENCE_EXHAUSTED",
  "GENERAL_NOTE_INVALID", "GENERAL_NOTE_TOO_LONG", "GENDER_VOCABULARY_INVALID",
  "NATIONAL_ID_DUPLICATE", "NATIONAL_ID_INVALID", "NATIONAL_ID_ISSUED_PLACE_INVALID",
  "OFF_REQUIRES_DATE_AND_REASON", "PASTE_VALUE_FORMAT",
  "PAYMENT_DETAILS_INVALID", "PROFILE_DATE_INVALID",
  "PROJECT_NOT_ACTIVE", "RECRUITER_MEMBERSHIP_INVALID", "RECRUITER_NOT_ACTIVE",
  "WORKER_ACTIVE_EPISODE_EXISTS", "WORKER_EPISODE_REOPEN_FORBIDDEN",
]);

type Repository = ReturnType<typeof createFullProfileRepository>;
type Dependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: Pick<Repository, "createFullProfileBatch">;
};

type ReadBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; kind: "invalid" | "too-large" };

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

async function readBoundedJson(request: Request): Promise<ReadBodyResult> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return { ok: false, kind: "invalid" };
    if (length > FULL_PROFILE_MAX_BODY_BYTES) return { ok: false, kind: "too-large" };
  }
  if (!request.body) return { ok: false, kind: "invalid" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FULL_PROFILE_MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, kind: "too-large" };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, kind: "invalid" };
  } finally {
    reader.releaseLock();
  }
}

function projectResult(value: unknown, expectedCount: number, expectedYears?: readonly string[]): {
  submission_id: string;
  state: "DRAFT";
  version: number;
  entry_ids: string[];
  employee_codes?: string[];
  replayed: boolean;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expectedKeys = expectedYears
    ? ["employee_codes", "entry_ids", "replayed", "state", "submission_id", "version"]
    : ["entry_ids", "replayed", "state", "submission_id", "version"];
  if (Object.keys(record).sort().join(",") !== expectedKeys.sort().join(",") ||
      typeof record.submission_id !== "string" || !UUID.test(record.submission_id) ||
      record.state !== "DRAFT" || typeof record.version !== "number" ||
      !Number.isSafeInteger(record.version) || record.version < 1 ||
      typeof record.replayed !== "boolean" || !Array.isArray(record.entry_ids) ||
      record.entry_ids.length !== expectedCount ||
      !record.entry_ids.every((id) => typeof id === "string" && UUID.test(id)) ||
      new Set(record.entry_ids).size !== record.entry_ids.length) return null;
  let employeeCodes: string[] | undefined;
  if (expectedYears) {
    if (!Array.isArray(record.employee_codes) || record.employee_codes.length !== expectedCount ||
        !record.employee_codes.every((code, index) =>
          typeof code === "string" &&
          /^hrp-\d{4}-\d{6}$/.test(code) &&
          code.slice(4, 8) === expectedYears[index]) ||
        new Set(record.employee_codes).size !== record.employee_codes.length) return null;
    employeeCodes = record.employee_codes as string[];
  }
  return {
    submission_id: record.submission_id,
    state: "DRAFT",
    version: record.version,
    entry_ids: record.entry_ids as string[],
    ...(employeeCodes ? { employee_codes: employeeCodes } : {}),
    replayed: record.replayed,
  };
}

export async function postFullProfileBatch(
  request: Request,
  flag: string | undefined,
  dependencies: Dependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null || !UUID.test(idempotencyKey)) {
    return fail("IDEMPOTENCY_KEY_INVALID", 400);
  }

  const body = await readBoundedJson(request);
  if (!body.ok) {
    return body.kind === "too-large"
      ? fail("BODY_TOO_LARGE", 413)
      : fail("BODY_INVALID", 400);
  }
  const parsed = parseFullProfilePayload(body.value);
  if (!parsed.ok) {
    const first = parsed.issues[0];
    return fail(SAFE_CLIENT_CODES.has(first.code) ? first.code : "BATCH_INVALID", 400);
  }

  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const result = await dependencies.repository.createFullProfileBatch({
      auth_subject: session.actor.actor.auth_subject,
      app_user_id: session.actor.actor.app_user_id,
      payload: parsed.payload,
      idempotency_key: idempotencyKey,
    });
    if (!result.ok) {
      if (result.kind === "conflict") return fail("IDEMPOTENCY_CONFLICT", 409);
      if (result.kind === "denied") return fail("ACTOR_DENIED", 403);
      if (result.kind === "invalid") {
        const code = result.code && SAFE_CLIENT_CODES.has(result.code)
          ? result.code
          : "BATCH_INVALID";
        return fail(code, 400);
      }
      console.error("[direct-entry] full-profile batch unavailable");
      return fail("BATCH_UNAVAILABLE", 500);
    }
    const expectedYears = parsed.payload.contract_version === "worker-profile/1.1"
      ? parsed.payload.rows.map((row) => row.first_work_date.slice(0, 4))
      : undefined;
    const projection = projectResult(result.data, parsed.payload.rows.length, expectedYears);
    if (!projection) {
      console.error("[direct-entry] full-profile batch returned malformed projection");
      return fail("BATCH_UNAVAILABLE", 500);
    }
    const { replayed, ...safeResult } = projection;
    return respond({ ok: true, ...safeResult }, replayed ? 200 : 201);
  } catch {
    console.error("[direct-entry] full-profile batch request failed");
    return fail("BATCH_UNAVAILABLE", 500);
  }
}
