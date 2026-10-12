import "server-only";

import type { DirectEntryActor } from "@/lib/auth/direct-entry-v2";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { INVALID_FILTER_CODE } from "./p1-filter";
import { REPORTING_QUERY_FAILED_CODE } from "./p1-reporting";
import { parseTeamDrillDownRequest } from "./p2-w05b-team-drill-down-parser";
import type { RequestParams } from "./p2-w05b-team-drill-down-parser";

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
