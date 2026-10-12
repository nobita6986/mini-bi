import "server-only";

import type { DirectEntryActor } from "@/lib/auth/direct-entry-v2";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { INVALID_FILTER_CODE, parseReportingFilters } from "./p1-filter";
import { REPORTING_QUERY_FAILED_CODE } from "./p1-reporting";

type RequestParams = Record<string, string | string[] | undefined>;

const ALLOWED_KEYS = new Set([
  "bucket_key", "from", "to", "project", "recruiter", "provider", "employment", "cursor", "limit",
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_BUCKET_KEY = "unknown";
const TEAM_BUCKET_RE = /^team\.([A-Za-z0-9_-]+)$/;

export type TeamDrillDownFilters = {
  bucket_key: string;
  cursor: string | null;
  limit: number;
  filters: {
    from?: string;
    to?: string;
    project?: string;
    recruiter?: string;
    provider?: string;
    employment?: string;
  };
};

export type TeamDrillDownRow = {
  business_date: string;
  project_display: string;
  recruiter_display: string;
  provider_type_display: string;
  employment_type_display: string;
  recruited_count: number;
  first_work_date: string;
};

export type TeamDrillDownEnvelope = {
  bucket: { key: string; display: string };
  rows: TeamDrillDownRow[];
  nextCursor: string | null;
  total: number;
  applied: {
    from: string | null;
    to: string | null;
    project: string | null;
    recruiter: string | null;
    provider: string | null;
    employment: string | null;
  };
  legacy_aggregate_total: {
    recruited_count: number;
    from: string | null;
    to: string | null;
    cutover_date: string;
  } | null;
};

type TeamDrillDownResult =
  | { ok: true; data: TeamDrillDownEnvelope }
  | { ok: false; code: string; status: 400 | 403 | 503 };

function invalidResult(): TeamDrillDownResult {
  return { ok: false, code: INVALID_FILTER_CODE, status: 400 };
}

function parserInvalid(): { ok: false; code: typeof INVALID_FILTER_CODE } {
  return { ok: false, code: INVALID_FILTER_CODE };
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

function isCanonicalTeamCode(value: string): boolean {
  return value.length >= 1 && value.length <= 128
    && value === value.trim()
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function validBucketKey(value: string): boolean {
  if (value === UNKNOWN_BUCKET_KEY) return true;
  if (value === "__unknown__") return false;
  const match = TEAM_BUCKET_RE.exec(value);
  if (!match || value.length < 7 || value.length > 688) return false;
  const decoded = decodeBase64Url(match[1]);
  if (!decoded) return false;
  const code = decoded.toString("utf8");
  return Buffer.from(code, "utf8").equals(decoded) && isCanonicalTeamCode(code);
}

function validCursor(value: string): boolean {
  const decoded = decodeBase64Url(value);
  if (!decoded) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "business_date,entry_id,recruiter_display") return false;
  return typeof record.business_date === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(record.business_date)
    && typeof record.entry_id === "string"
    && UUID_RE.test(record.entry_id)
    && typeof record.recruiter_display === "string"
    && record.recruiter_display.length > 0;
}

export function parseTeamDrillDownRequest(params: RequestParams):
  | { ok: true; value: TeamDrillDownFilters }
  | { ok: false; code: typeof INVALID_FILTER_CODE } {
  for (const key of Object.keys(params)) {
    if (!ALLOWED_KEYS.has(key)) return parserInvalid();
  }
  const bucketKey = firstValue(params.bucket_key);
  if (!bucketKey || !validBucketKey(bucketKey)) return parserInvalid();

  const cursorValue = firstValue(params.cursor);
  if (params.cursor !== undefined && (!cursorValue || !validCursor(cursorValue))) return parserInvalid();

  const rawLimit = firstValue(params.limit);
  let limit = 25;
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit)) return parserInvalid();
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return parserInvalid();
  }

  const filterParams: RequestParams = {};
  for (const key of ["from", "to", "project", "recruiter", "provider", "employment"] as const) {
    if (params[key] !== undefined) filterParams[key] = params[key];
  }
  const parsed = parseReportingFilters(filterParams, undefined);
  if (!parsed.ok) return parserInvalid();

  return {
    ok: true,
    value: {
      bucket_key: bucketKey,
      cursor: cursorValue ?? null,
      limit,
      filters: parsed.filters,
    },
  };
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function projectEnvelope(value: unknown): TeamDrillDownEnvelope | null {
  if (typeof value !== "object" || value === null) return null;
  const envelope = value as Record<string, unknown>;
  if (!hasOnlyKeys(envelope, ["bucket", "rows", "nextCursor", "total", "applied", "legacy_aggregate_total"])) return null;
  if (typeof envelope.bucket !== "object" || envelope.bucket === null) return null;
  const bucket = envelope.bucket as Record<string, unknown>;
  if (!hasOnlyKeys(bucket, ["key", "display"]) || typeof bucket.key !== "string" || typeof bucket.display !== "string") return null;
  if (!Array.isArray(envelope.rows) || typeof envelope.nextCursor !== "string" && envelope.nextCursor !== null) return null;
  const total = envelope.total;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) return null;
  if (typeof envelope.applied !== "object" || envelope.applied === null) return null;
  const applied = envelope.applied as Record<string, unknown>;
  const appliedKeys = ["from", "to", "project", "recruiter", "provider", "employment"] as const;
  if (!hasOnlyKeys(applied, appliedKeys) || appliedKeys.some((key) => applied[key] !== null && typeof applied[key] !== "string")) return null;

  const rows: TeamDrillDownRow[] = [];
  for (const raw of envelope.rows) {
    if (typeof raw !== "object" || raw === null) return null;
    const row = raw as Record<string, unknown>;
    const rowKeys = ["business_date", "project_display", "recruiter_display", "provider_type_display", "employment_type_display", "recruited_count", "first_work_date"] as const;
    if (!hasOnlyKeys(row, rowKeys)) return null;
    if (rowKeys.some((key) => key !== "recruited_count" && typeof row[key] !== "string")) return null;
    const recruitedCount = row.recruited_count;
    if (typeof recruitedCount !== "number" || !Number.isSafeInteger(recruitedCount) || recruitedCount < 0) return null;
    rows.push({ ...row, recruited_count: recruitedCount } as unknown as TeamDrillDownRow);
  }

  let legacy: TeamDrillDownEnvelope["legacy_aggregate_total"] = null;
  if (envelope.legacy_aggregate_total !== null) {
    if (typeof envelope.legacy_aggregate_total !== "object" || envelope.legacy_aggregate_total === null) return null;
    const raw = envelope.legacy_aggregate_total as Record<string, unknown>;
    const keys = ["recruited_count", "from", "to", "cutover_date"] as const;
    const recruitedCount = raw.recruited_count;
    if (!hasOnlyKeys(raw, keys) || typeof recruitedCount !== "number" || !Number.isSafeInteger(recruitedCount) || recruitedCount < 0) return null;
    if (keys.slice(1).some((key) => raw[key] !== null && typeof raw[key] !== "string")) return null;
    legacy = { ...raw, recruited_count: recruitedCount } as TeamDrillDownEnvelope["legacy_aggregate_total"];
  }
  return { bucket: bucket as TeamDrillDownEnvelope["bucket"], rows, nextCursor: envelope.nextCursor, total, applied: applied as TeamDrillDownEnvelope["applied"], legacy_aggregate_total: legacy };
}

export async function fetchCutoverTeamDrillDown(
  params: RequestParams,
  actor: DirectEntryActor,
): Promise<TeamDrillDownResult> {
  const parsed = parseTeamDrillDownRequest(params);
  if (!parsed.ok) return { ok: false, code: parsed.code, status: 400 };
  try {
    const result = await createServiceSupabaseClient().rpc("direct_entry_reporting_team_drill_down", {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_bucket_key: parsed.value.bucket_key,
      p_filters: parsed.value.filters,
      p_cursor: parsed.value.cursor,
      p_limit: parsed.value.limit,
    });
    if (result.error) {
      if (result.error.code === "42501") return { ok: false, code: REPORTING_QUERY_FAILED_CODE, status: 403 };
      if (result.error.code === "22023") return invalidResult();
      return { ok: false, code: REPORTING_QUERY_FAILED_CODE, status: 503 };
    }
    const data = projectEnvelope(result.data);
    if (!data) return { ok: false, code: REPORTING_QUERY_FAILED_CODE, status: 503 };
    return { ok: true, data };
  } catch {
    return { ok: false, code: REPORTING_QUERY_FAILED_CODE, status: 503 };
  }
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function drillDownJson(data: TeamDrillDownEnvelope): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: JSON_HEADERS });
}

export function drillDownError(code: string, status: 400 | 403 | 503): Response {
  return new Response(JSON.stringify({ ok: false, code }), { status, headers: JSON_HEADERS });
}
