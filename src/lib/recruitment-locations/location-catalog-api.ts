import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { readBoundedJson } from "../direct-entry/write-api.ts";
import {
  hasExactKeysWithOptionalReason,
  projectOptionalActionReason,
} from "../direct-entry/action-reason.ts";
import type { LocationCatalogRepository } from "./location-catalog-repository.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATALOG_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const REASON_MAX = 4000;
const SEARCH_MAX = 256;
const NAME_MAX = 256;
const MAX_PAYLOAD_DEPTH = 8;

export type LocationCatalogDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: LocationCatalogRepository;
};

export type TrustedLocationActor = {
  auth_subject: string;
  app_user_id: string;
};

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function readUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function readCatalogCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return CATALOG_CODE_PATTERN.test(normalized) ? normalized : null;
}

function readDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= NAME_MAX ? trimmed : null;
}

function readVersion(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function containsClientNormalizedKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_PAYLOAD_DEPTH) return true;
  if (Array.isArray(value)) {
    return value.some((item) => containsClientNormalizedKey(item, depth + 1));
  }
  if (!isPlainRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (key.trim().toLowerCase() === "normalized_key") {
      return true;
    }
    if (containsClientNormalizedKey(nested, depth + 1)) {
      return true;
    }
  }
  return false;
}

async function readMutationBody(request: Request): Promise<Parsed<unknown>> {
  if (
    request.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase() !== "application/json"
  ) {
    return { ok: false, response: fail("CONTENT_TYPE_INVALID", 400) };
  }
  const body = await readBoundedJson(request);
  if (body === null) {
    return { ok: false, response: fail("BODY_INVALID", 400) };
  }
  return { ok: true, value: body };
}

function authorityOrComputedFieldFailure(body: unknown): Response | null {
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
  } catch {
    return fail("LOCATION_CATALOG_INVALID", 400);
  }
  if (containsClientNormalizedKey(body)) {
    return fail("NORMALIZED_KEY_CLIENT_FORBIDDEN", 400);
  }
  return null;
}

function idempotencyMismatch(request: Request, key: string): Response | null {
  const header = request.headers.get("idempotency-key");
  if (header !== null && header.trim().toLowerCase() !== key.toLowerCase()) {
    return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  }
  return null;
}

async function resolveTrustedActor(
  dependencies: LocationCatalogDependencies,
): Promise<Parsed<TrustedLocationActor>> {
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return {
        ok: false,
        response:
          session.actor.reason === "UNAUTHENTICATED"
            ? fail("UNAUTHENTICATED", 401)
            : fail("ACTOR_NOT_AVAILABLE", 403),
      };
    }
    const actor = session.actor.actor;
    const authSubject = actor ? readUuid(actor.auth_subject) : null;
    const appUserId = actor ? readUuid(actor.app_user_id) : null;
    if (!authSubject || !appUserId) {
      return { ok: false, response: fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    return {
      ok: true,
      value: { auth_subject: authSubject, app_user_id: appUserId },
    };
  } catch {
    console.error("[location-catalog] session unavailable");
    return { ok: false, response: fail("LOCATION_CATALOG_UNAVAILABLE", 503) };
  }
}

export function locationCatalogErrorResponse(kind: string): Response {
  if (kind === "denied") return fail("LOCATION_CATALOG_DENIED", 403);
  if (kind === "not-found") return fail("LOCATION_CATALOG_NOT_FOUND", 404);
  if (kind === "conflict") return fail("LOCATION_CATALOG_CONFLICT", 409);
  if (kind === "invalid") return fail("LOCATION_CATALOG_INVALID", 400);
  console.error("[location-catalog] unavailable");
  return fail("LOCATION_CATALOG_UNAVAILABLE", 503);
}

function readPreflight(flag: string | undefined): Response | null {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  return null;
}

function mutationPreflight(
  request: Request,
  flag: string | undefined,
): Response | null {
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

function readPageNumber(
  value: string | null,
  defaultValue: number,
  min: number,
  max: number,
): number | null {
  if (value === null) return defaultValue;
  if (!/^\d{1,6}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

export type ListProvincesQuery = {
  include_inactive: boolean;
  search: string | null;
  page: number;
  page_size: number;
};

export function parseListProvincesQuery(url: URL): Parsed<ListProvincesQuery> {
  for (const key of url.searchParams.keys()) {
    if (
      key !== "include_inactive" &&
      key !== "search" &&
      key !== "page" &&
      key !== "page_size"
    ) {
      return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
    }
  }
  const rawSearch = url.searchParams.get("search");
  if (rawSearch !== null && rawSearch.length > SEARCH_MAX) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }
  const search =
    rawSearch !== null && rawSearch.trim() !== "" ? rawSearch.trim() : null;

  const rawIncludeInactive = url.searchParams.get("include_inactive");
  if (
    rawIncludeInactive !== null &&
    rawIncludeInactive !== "true" &&
    rawIncludeInactive !== "false"
  ) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }
  const include_inactive = rawIncludeInactive !== "false";

  const page = readPageNumber(url.searchParams.get("page"), 1, 1, 1000);
  const page_size = readPageNumber(url.searchParams.get("page_size"), 50, 1, 100);
  if (page === null || page_size === null) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }

  return { ok: true, value: { include_inactive, search, page, page_size } };
}

export type ListIndustrialParksQuery = {
  province_id: string | null;
  include_inactive: boolean;
  search: string | null;
  page: number;
  page_size: number;
};

export function parseListIndustrialParksQuery(
  url: URL,
): Parsed<ListIndustrialParksQuery> {
  for (const key of url.searchParams.keys()) {
    if (
      key !== "province_id" &&
      key !== "include_inactive" &&
      key !== "search" &&
      key !== "page" &&
      key !== "page_size"
    ) {
      return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
    }
  }
  const rawProvinceId = url.searchParams.get("province_id");
  let province_id: string | null = null;
  if (rawProvinceId !== null && rawProvinceId.trim() !== "") {
    province_id = readUuid(rawProvinceId);
    if (!province_id) {
      return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
    }
  }

  const rawSearch = url.searchParams.get("search");
  if (rawSearch !== null && rawSearch.length > SEARCH_MAX) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }
  const search =
    rawSearch !== null && rawSearch.trim() !== "" ? rawSearch.trim() : null;

  const rawIncludeInactive = url.searchParams.get("include_inactive");
  if (
    rawIncludeInactive !== null &&
    rawIncludeInactive !== "true" &&
    rawIncludeInactive !== "false"
  ) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }
  const include_inactive = rawIncludeInactive !== "false";

  const page = readPageNumber(url.searchParams.get("page"), 1, 1, 1000);
  const page_size = readPageNumber(url.searchParams.get("page_size"), 50, 1, 100);
  if (page === null || page_size === null) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }

  return {
    ok: true,
    value: { province_id, include_inactive, search, page, page_size },
  };
}

export type CreateProvinceRequest = {
  expected_version: 0;
  province_code: string;
  display_name: string;
  reason: string | null;
  idempotency_key: string;
};

export function parseCreateProvinceRequest(
  body: unknown,
): Parsed<CreateProvinceRequest> {
  if (
    !isPlainRecord(body) ||
    !hasExactKeysWithOptionalReason(body, [
      "expected_version",
      "province_code",
      "display_name",
      "reason",
      "idempotency_key",
    ])
  ) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }

  const expected_version = readVersion(body.expected_version);
  const province_code = readCatalogCode(body.province_code);
  const display_name = readDisplayName(body.display_name);
  const reason = projectOptionalActionReason(body.reason, REASON_MAX);
  const idempotency_key = readUuid(body.idempotency_key);

  if (
    expected_version !== 0 ||
    !province_code ||
    !display_name ||
    !reason.ok ||
    !idempotency_key
  ) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }

  return {
    ok: true,
    value: {
      expected_version: 0,
      province_code,
      display_name,
      reason: reason.value,
      idempotency_key,
    },
  };
}

export type UpdateProvinceRequest = {
  expected_version: number;
  display_name: string;
  reason: string | null;
  idempotency_key: string;
};

export function parseUpdateProvinceRequest(
  body: unknown,
): Parsed<UpdateProvinceRequest> {
  if (
    !isPlainRecord(body) ||
    !hasExactKeysWithOptionalReason(body, [
      "expected_version",
      "display_name",
      "reason",
      "idempotency_key",
    ])
  ) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }

  const expected_version = readVersion(body.expected_version);
  const display_name = readDisplayName(body.display_name);
  const reason = projectOptionalActionReason(body.reason, REASON_MAX);
  const idempotency_key = readUuid(body.idempotency_key);

  if (
    expected_version === null ||
    expected_version < 1 ||
    !display_name ||
    !reason.ok ||
    !idempotency_key
  ) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }

  return {
    ok: true,
    value: {
      expected_version,
      display_name,
      reason: reason.value,
      idempotency_key,
    },
  };
}

export type SetLocationActiveRequest = {
  active: boolean;
  expected_version: number;
  reason: string | null;
  idempotency_key: string;
};

export function parseSetLocationActiveRequest(
  body: unknown,
): Parsed<SetLocationActiveRequest> {
  if (
    !isPlainRecord(body) ||
    !hasExactKeysWithOptionalReason(body, [
      "active",
      "expected_version",
      "reason",
      "idempotency_key",
    ]) ||
    typeof body.active !== "boolean"
  ) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }

  const expected_version = readVersion(body.expected_version);
  const reason = projectOptionalActionReason(body.reason, REASON_MAX);
  const idempotency_key = readUuid(body.idempotency_key);

  if (
    expected_version === null ||
    expected_version < 1 ||
    !reason.ok ||
    !idempotency_key
  ) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }

  return {
    ok: true,
    value: {
      active: body.active,
      expected_version,
      reason: reason.value,
      idempotency_key,
    },
  };
}

export type CreateIndustrialParkRequest = {
  expected_version: 0;
  province_id: string;
  industrial_park_code: string;
  display_name: string;
  reason: string | null;
  idempotency_key: string;
};

export function parseCreateIndustrialParkRequest(
  body: unknown,
): Parsed<CreateIndustrialParkRequest> {
  if (
    !isPlainRecord(body) ||
    !hasExactKeysWithOptionalReason(body, [
      "expected_version",
      "province_id",
      "industrial_park_code",
      "display_name",
      "reason",
      "idempotency_key",
    ])
  ) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }

  const expected_version = readVersion(body.expected_version);
  const province_id = readUuid(body.province_id);
  const industrial_park_code = readCatalogCode(body.industrial_park_code);
  const display_name = readDisplayName(body.display_name);
  const reason = projectOptionalActionReason(body.reason, REASON_MAX);
  const idempotency_key = readUuid(body.idempotency_key);

  if (
    expected_version !== 0 ||
    !province_id ||
    !industrial_park_code ||
    !display_name ||
    !reason.ok ||
    !idempotency_key
  ) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }

  return {
    ok: true,
    value: {
      expected_version: 0,
      province_id,
      industrial_park_code,
      display_name,
      reason: reason.value,
      idempotency_key,
    },
  };
}

export type UpdateIndustrialParkRequest = {
  expected_version: number;
  province_id: string | null;
  display_name: string | null;
  reason: string | null;
  idempotency_key: string;
};

export function parseUpdateIndustrialParkRequest(
  body: unknown,
): Parsed<UpdateIndustrialParkRequest> {
  if (!isPlainRecord(body)) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }

  const allowedKeys = new Set([
    "expected_version",
    "province_id",
    "display_name",
    "reason",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
    }
  }

  const expected_version = readVersion(body.expected_version);
  const reason = projectOptionalActionReason(body.reason, REASON_MAX);
  const idempotency_key = readUuid(body.idempotency_key);

  let province_id: string | null = null;
  if ("province_id" in body && body.province_id !== undefined && body.province_id !== null) {
    province_id = readUuid(body.province_id);
    if (!province_id) {
      return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
    }
  }

  let display_name: string | null = null;
  if ("display_name" in body && body.display_name !== undefined && body.display_name !== null) {
    display_name = readDisplayName(body.display_name);
    if (!display_name) {
      return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
    }
  }

  if (
    expected_version === null ||
    expected_version < 1 ||
    (province_id === null && display_name === null) ||
    !reason.ok ||
    !idempotency_key
  ) {
    return { ok: false, response: fail("LOCATION_CATALOG_INVALID", 400) };
  }

  return {
    ok: true,
    value: {
      expected_version,
      province_id,
      display_name,
      reason: reason.value,
      idempotency_key,
    },
  };
}

async function runMutation<TInput extends { idempotency_key: string }, TOutput>(
  request: Request,
  flag: string | undefined,
  dependencies: LocationCatalogDependencies,
  parse: (body: unknown) => Parsed<TInput>,
  responseField: "province" | "industrial_park",
  execute: (
    actor: TrustedLocationActor,
    input: TInput,
  ) => Promise<{ ok: true; data: TOutput } | { ok: false; kind: string }>,
): Promise<Response> {
  const blocked = mutationPreflight(request, flag);
  if (blocked) return blocked;

  const body = await readMutationBody(request);
  if (!body.ok) return body.response;

  const forbidden = authorityOrComputedFieldFailure(body.value);
  if (forbidden) return forbidden;

  const parsed = parse(body.value);
  if (!parsed.ok) return parsed.response;

  const mismatch = idempotencyMismatch(request, parsed.value.idempotency_key);
  if (mismatch) return mismatch;

  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;

  try {
    const result = await execute(actor.value, parsed.value);
    if (!result.ok) {
      return locationCatalogErrorResponse(result.kind);
    }
    return respond({ ok: true, [responseField]: result.data }, 200);
  } catch {
    console.error("[location-catalog] mutation failed");
    return fail("LOCATION_CATALOG_UNAVAILABLE", 503);
  }
}

export async function listProvincesCatalog(
  request: Request,
  flag: string | undefined,
  dependencies: LocationCatalogDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;

  const query = parseListProvincesQuery(new URL(request.url));
  if (!query.ok) return query.response;

  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;

  try {
    const result = await dependencies.repository.listProvinces({
      ...actor.value,
      ...query.value,
    });
    if (!result.ok) return locationCatalogErrorResponse(result.kind);
    return respond({ ok: true, list: result.data }, 200);
  } catch {
    console.error("[location-catalog] list provinces failed");
    return fail("LOCATION_CATALOG_UNAVAILABLE", 503);
  }
}

export async function createProvinceCatalog(
  request: Request,
  flag: string | undefined,
  dependencies: LocationCatalogDependencies,
): Promise<Response> {
  return runMutation(
    request,
    flag,
    dependencies,
    parseCreateProvinceRequest,
    "province",
    (actor, input) =>
      dependencies.repository.createProvince({
        ...actor,
        ...input,
      }),
  );
}

export async function updateProvinceCatalog(
  request: Request,
  provinceId: string,
  flag: string | undefined,
  dependencies: LocationCatalogDependencies,
): Promise<Response> {
  const validProvinceId = readUuid(provinceId);
  if (!validProvinceId) {
    const blocked = mutationPreflight(request, flag);
    if (blocked) return blocked;
    return fail("LOCATION_CATALOG_INVALID", 400);
  }

  return runMutation(
    request,
    flag,
    dependencies,
    parseUpdateProvinceRequest,
    "province",
    (actor, input) =>
      dependencies.repository.updateProvince({
        ...actor,
        province_id: validProvinceId,
        ...input,
      }),
  );
}

export async function setProvinceActiveCatalog(
  request: Request,
  provinceId: string,
  flag: string | undefined,
  dependencies: LocationCatalogDependencies,
): Promise<Response> {
  const validProvinceId = readUuid(provinceId);
  if (!validProvinceId) {
    const blocked = mutationPreflight(request, flag);
    if (blocked) return blocked;
    return fail("LOCATION_CATALOG_INVALID", 400);
  }

  return runMutation(
    request,
    flag,
    dependencies,
    parseSetLocationActiveRequest,
    "province",
    (actor, input) =>
      dependencies.repository.setProvinceActive({
        ...actor,
        province_id: validProvinceId,
        ...input,
      }),
  );
}

export async function listIndustrialParksCatalog(
  request: Request,
  flag: string | undefined,
  dependencies: LocationCatalogDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;

  const query = parseListIndustrialParksQuery(new URL(request.url));
  if (!query.ok) return query.response;

  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;

  try {
    const result = await dependencies.repository.listIndustrialParks({
      ...actor.value,
      ...query.value,
    });
    if (!result.ok) return locationCatalogErrorResponse(result.kind);
    return respond({ ok: true, list: result.data }, 200);
  } catch {
    console.error("[location-catalog] list industrial parks failed");
    return fail("LOCATION_CATALOG_UNAVAILABLE", 503);
  }
}

export async function createIndustrialParkCatalog(
  request: Request,
  flag: string | undefined,
  dependencies: LocationCatalogDependencies,
): Promise<Response> {
  return runMutation(
    request,
    flag,
    dependencies,
    parseCreateIndustrialParkRequest,
    "industrial_park",
    (actor, input) =>
      dependencies.repository.createIndustrialPark({
        ...actor,
        ...input,
      }),
  );
}

export async function updateIndustrialParkCatalog(
  request: Request,
  industrialParkId: string,
  flag: string | undefined,
  dependencies: LocationCatalogDependencies,
): Promise<Response> {
  const validParkId = readUuid(industrialParkId);
  if (!validParkId) {
    const blocked = mutationPreflight(request, flag);
    if (blocked) return blocked;
    return fail("LOCATION_CATALOG_INVALID", 400);
  }

  return runMutation(
    request,
    flag,
    dependencies,
    parseUpdateIndustrialParkRequest,
    "industrial_park",
    (actor, input) =>
      dependencies.repository.updateIndustrialPark({
        ...actor,
        industrial_park_id: validParkId,
        ...input,
      }),
  );
}

export async function setIndustrialParkActiveCatalog(
  request: Request,
  industrialParkId: string,
  flag: string | undefined,
  dependencies: LocationCatalogDependencies,
): Promise<Response> {
  const validParkId = readUuid(industrialParkId);
  if (!validParkId) {
    const blocked = mutationPreflight(request, flag);
    if (blocked) return blocked;
    return fail("LOCATION_CATALOG_INVALID", 400);
  }

  return runMutation(
    request,
    flag,
    dependencies,
    parseSetLocationActiveRequest,
    "industrial_park",
    (actor, input) =>
      dependencies.repository.setIndustrialParkActive({
        ...actor,
        industrial_park_id: validParkId,
        ...input,
      }),
  );
}
