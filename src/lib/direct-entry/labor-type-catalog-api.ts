/**
 * P3.1-W02C - API boundary cho labor type catalog admin (RPC #79).
 *
 * Pipeline thong nhat (giong personnel-catalog-api):
 *   1. DIRECT_ENTRY_API_ENABLED gate
 *   2. same-origin/CSRF (mutation)
 *   3. content-type + JSON bounded
 *   4. quet authority de quy (client khong duoc gui actor/role/capability/scope)
 *   5. strict request projection (reason bat buoc, OCC, idempotency)
 *   6. resolve session server-side -> actor CHI tu session
 *   7. repository/RPC
 *   8. response sanitized (khong forward raw DB message)
 *
 * Module nay KHONG danh gia quyen va KHONG doc truoc DB: DB guard
 * (direct_entry_assert_catalog_operator) la authority cuoi. reporting_key la
 * catalog-owned nen KHONG bao gio nam trong request contract. Khong co UI/nav.
 */
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { readBoundedJson } from "./write-api.ts";
import { LABOR_TYPE_KEY } from "./labor-type-catalog-contract.ts";
import type { LaborTypeCatalogRepository } from "./labor-type-catalog-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASON_MAX = 4000;
const SEARCH_MAX = 256;
const NAME_MAX = 256;
const SORT_MAX = 100000;

export type LaborTypeCatalogDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: LaborTypeCatalogRepository;
};

export type TrustedActor = { auth_subject: string; app_user_id: string };

function respond(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= max ? value : null;
}
function laborTypeKey(value: unknown): string | null {
  return typeof value === "string" && LABOR_TYPE_KEY.test(value) ? value : null;
}
function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}
function version(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function sortOrder(value: unknown): number | null {
  const parsed = version(value);
  return parsed !== null && parsed <= SORT_MAX ? parsed : null;
}
function pageNumber(value: string | null, min: number, max: number,
  fallback: number): number | null {
  // Vang mat => dung gia tri mac dinh da cong bo tren RPC (page 1, page_size 100).
  // Gia tri gui len luon phai nam trong [min, max]; khong bao gio am tham sua.
  if (value === null) return fallback;
  if (!/^\d{1,6}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

async function readMutationBody(request: Request): Promise<Parsed<unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return { ok: false, response: fail("CONTENT_TYPE_INVALID", 400) };
  }
  const body = await readBoundedJson(request);
  if (body === null) return { ok: false, response: fail("BODY_INVALID", 400) };
  return { ok: true, value: body };
}

/** Client khong duoc gui actor/role/capability/scope o bat ky do sau nao. */
function authorityFailure(body: unknown): Response | null {
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
  } catch {
    return fail("LABOR_TYPE_INVALID", 400);
  }
  return null;
}

function idempotencyMismatch(request: Request, key: string): Response | null {
  const header = request.headers.get("idempotency-key");
  if (header !== null && header !== key) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  return null;
}

async function resolveTrustedActor(
  dependencies: LaborTypeCatalogDependencies,
): Promise<Parsed<TrustedActor>> {
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return {
        ok: false,
        response: session.actor.reason === "UNAUTHENTICATED"
          ? fail("UNAUTHENTICATED", 401)
          : fail("ACTOR_NOT_AVAILABLE", 403),
      };
    }
    const actor = session.actor.actor;
    if (!actor || !uuid(actor.auth_subject) || !uuid(actor.app_user_id)) {
      return { ok: false, response: fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    // Actor CHI den tu session server-side; khong bao gio lay tu body/header client.
    return { ok: true, value: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id } };
  } catch {
    console.error("[labor-type-catalog] session unavailable");
    return { ok: false, response: fail("LABOR_TYPE_UNAVAILABLE", 500) };
  }
}

/** Taxonomy sanitized: khong bao gio forward raw DB message. */
export function laborTypeCatalogErrorResponse(kind: string): Response {
  if (kind === "denied") return fail("LABOR_TYPE_DENIED", 403);
  if (kind === "not-found") return fail("LABOR_TYPE_NOT_FOUND", 404);
  if (kind === "conflict") return fail("LABOR_TYPE_CONFLICT", 409);
  if (kind === "invalid") return fail("LABOR_TYPE_INVALID", 400);
  console.error("[labor-type-catalog] unavailable");
  return fail("LABOR_TYPE_UNAVAILABLE", 500);
}

/** Read routes chi can feature gate; browser GET khong bat buoc gui Origin. */
function readPreflight(flag: string | undefined): Response | null {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  return null;
}

/** Mutation routes bat buoc feature gate + same-origin/CSRF. */
function mutationPreflight(request: Request, flag: string | undefined): Response | null {
  const gated = readPreflight(flag);
  if (gated) return gated;
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  return null;
}

export type ListLaborTypesQuery = {
  search: string | null; include_inactive: boolean; page: number; page_size: number;
};
export function laborTypeCatalogListQuery(url: URL): Parsed<ListLaborTypesQuery> {
  const rawSearch = url.searchParams.get("search");
  if (rawSearch !== null && rawSearch.length > SEARCH_MAX) {
    return { ok: false, response: fail("LABOR_TYPE_INVALID", 400) };
  }
  const search = rawSearch !== null && rawSearch.trim() !== "" ? rawSearch.trim() : null;
  // Chi chap nhan absent | "true" | "false". Gia tri khac la 400, khong bao gio
  // am tham mac dinh thanh true.
  const rawIncludeInactive = url.searchParams.get("include_inactive");
  if (rawIncludeInactive !== null && rawIncludeInactive !== "true"
      && rawIncludeInactive !== "false") {
    return { ok: false, response: fail("LABOR_TYPE_INVALID", 400) };
  }
  const include_inactive = rawIncludeInactive !== "false";
  const page = pageNumber(url.searchParams.get("page"), 1, 1000, 1);
  const page_size = pageNumber(url.searchParams.get("page_size"), 1, 100, 100);
  if (page === null || page_size === null) {
    return { ok: false, response: fail("LABOR_TYPE_INVALID", 400) };
  }
  return { ok: true, value: { search, include_inactive, page, page_size } };
}

export type CreateLaborTypeRequest = {
  expected_version: 0; labor_type_key: string; display_name: string;
  sort_order: number; reason: string; idempotency_key: string;
};
export function laborTypeCatalogCreateRequest(body: unknown): Parsed<CreateLaborTypeRequest> {
  const value = record(body);
  // reporting_key KHONG nam trong contract: server tu sinh tu key canonical.
  if (!value || !exact(value, ["expected_version", "labor_type_key", "display_name",
    "sort_order", "reason", "idempotency_key"])) {
    return { ok: false, response: fail("LABOR_TYPE_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const key = laborTypeKey(value.labor_type_key);
  const display_name = text(value.display_name, NAME_MAX);
  const order = sortOrder(value.sort_order);
  const reason = text(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  // create mo mot aggregate moi: expected_version phai dung bang 0.
  if (expected_version !== 0 || !key || !display_name || order === null || !reason
      || !idempotency_key) {
    return { ok: false, response: fail("LABOR_TYPE_INVALID", 400) };
  }
  return { ok: true, value: { expected_version: 0, labor_type_key: key, display_name,
    sort_order: order, reason, idempotency_key } };
}

export type UpdateLaborTypeRequest = {
  expected_version: number; display_name: string; sort_order: number;
  reason: string; idempotency_key: string;
};
export function laborTypeCatalogUpdateRequest(body: unknown): Parsed<UpdateLaborTypeRequest> {
  const value = record(body);
  // Chi display_name + sort_order duoc sua; key va reporting_key la immutable.
  if (!value || !exact(value, ["expected_version", "display_name", "sort_order",
    "reason", "idempotency_key"])) {
    return { ok: false, response: fail("LABOR_TYPE_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const display_name = text(value.display_name, NAME_MAX);
  const order = sortOrder(value.sort_order);
  const reason = text(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (expected_version === null || expected_version < 1 || !display_name || order === null
      || !reason || !idempotency_key) {
    return { ok: false, response: fail("LABOR_TYPE_INVALID", 400) };
  }
  return { ok: true, value: { expected_version, display_name, sort_order: order, reason,
    idempotency_key } };
}

export type SetActiveLaborTypeRequest = {
  active: boolean; expected_version: number; reason: string; idempotency_key: string;
};
export function laborTypeCatalogSetActiveRequest(body: unknown): Parsed<SetActiveLaborTypeRequest> {
  const value = record(body);
  if (!value || !exact(value, ["active", "expected_version", "reason", "idempotency_key"]) ||
      typeof value.active !== "boolean") {
    return { ok: false, response: fail("LABOR_TYPE_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const reason = text(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (expected_version === null || expected_version < 1 || !reason || !idempotency_key) {
    return { ok: false, response: fail("LABOR_TYPE_INVALID", 400) };
  }
  return { ok: true, value: { active: value.active, expected_version, reason, idempotency_key } };
}

async function runMutation<T>(
  request: Request,
  dependencies: LaborTypeCatalogDependencies,
  parsed: Parsed<{ reason: string; idempotency_key: string }>,
  run: (actor: TrustedActor) => Promise<{ ok: true; data: T } | { ok: false; kind: string }>,
): Promise<Response> {
  if (!parsed.ok) return parsed.response;
  const mismatch = idempotencyMismatch(request, parsed.value.idempotency_key);
  if (mismatch) return mismatch;

  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;

  let result: { ok: true; data: T } | { ok: false; kind: string };
  try {
    result = await run(actor.value);
  } catch {
    console.error("[labor-type-catalog] mutation failed");
    return fail("LABOR_TYPE_UNAVAILABLE", 500);
  }
  if (!result.ok) return laborTypeCatalogErrorResponse(result.kind);
  return respond({ ok: true, labor_type: result.data }, 200);
}

export async function listLaborTypeCatalog(
  request: Request, flag: string | undefined, dependencies: LaborTypeCatalogDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const query = laborTypeCatalogListQuery(new URL(request.url));
  if (!query.ok) return query.response;
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.listLaborTypes({ ...actor.value, ...query.value });
    if (!result.ok) return laborTypeCatalogErrorResponse(result.kind);
    return respond({ ok: true, list: result.data }, 200);
  } catch {
    console.error("[labor-type-catalog] list failed");
    return fail("LABOR_TYPE_UNAVAILABLE", 500);
  }
}

export async function getLaborTypeCatalog(
  request: Request, laborTypeKeyParam: string, flag: string | undefined,
  dependencies: LaborTypeCatalogDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const key = laborTypeKey(laborTypeKeyParam);
  if (!key) return fail("LABOR_TYPE_INVALID", 400);
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.getLaborType({
      ...actor.value, labor_type_key: key,
    });
    if (!result.ok) return laborTypeCatalogErrorResponse(result.kind);
    return respond({ ok: true, labor_type: result.data }, 200);
  } catch {
    console.error("[labor-type-catalog] detail failed");
    return fail("LABOR_TYPE_UNAVAILABLE", 500);
  }
}

async function mutationPipeline(
  request: Request, flag: string | undefined, dependencies: LaborTypeCatalogDependencies,
  parse: (body: unknown) => Parsed<{ reason: string; idempotency_key: string }>,
  run: (actor: TrustedActor, value: never) => Promise<{ ok: true; data: unknown } | { ok: false; kind: string }>,
): Promise<Response> {
  const blocked = mutationPreflight(request, flag);
  if (blocked) return blocked;
  const body = await readMutationBody(request);
  if (!body.ok) return body.response;
  const authority = authorityFailure(body.value);
  if (authority) return authority;
  const parsed = parse(body.value);
  if (!parsed.ok) return parsed.response;
  return runMutation(request, dependencies, parsed,
    (actor) => run(actor, parsed.value as never));
}

export function createLaborTypeCatalog(
  request: Request, flag: string | undefined, dependencies: LaborTypeCatalogDependencies,
): Promise<Response> {
  return mutationPipeline(request, flag, dependencies, laborTypeCatalogCreateRequest,
    (actor, value: CreateLaborTypeRequest) =>
      dependencies.repository.createLaborType({ ...actor, ...value }));
}

export function updateLaborTypeCatalog(
  request: Request, laborTypeKeyParam: string, flag: string | undefined,
  dependencies: LaborTypeCatalogDependencies,
): Promise<Response> {
  const key = laborTypeKey(laborTypeKeyParam);
  return mutationPipeline(request, flag, dependencies, laborTypeCatalogUpdateRequest,
    (actor, value: UpdateLaborTypeRequest) => key === null
      ? Promise.resolve({ ok: false as const, kind: "invalid" })
      : dependencies.repository.updateLaborType({ ...actor, labor_type_key: key, ...value }));
}

export function setLaborTypeCatalogActive(
  request: Request, laborTypeKeyParam: string, flag: string | undefined,
  dependencies: LaborTypeCatalogDependencies,
): Promise<Response> {
  const key = laborTypeKey(laborTypeKeyParam);
  return mutationPipeline(request, flag, dependencies, laborTypeCatalogSetActiveRequest,
    (actor, value: SetActiveLaborTypeRequest) => key === null
      ? Promise.resolve({ ok: false as const, kind: "invalid" })
      : dependencies.repository.setLaborTypeActive({ ...actor, labor_type_key: key, ...value }));
}
