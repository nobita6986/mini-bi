import "server-only";

import type { DirectEntryActor } from "@/lib/auth/direct-entry-v2";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { INVALID_FILTER_CODE } from "./p1-filter";
import { REPORTING_QUERY_FAILED_CODE } from "./p1-reporting";
import type { ReportingData } from "./p1-reporting";
import { computeScopedReportingData } from "./p2-w04a-reporting-server";
import { parseTeamDrillDownRequest } from "./p2-w05b-team-drill-down-parser";
import type { RequestParams } from "./p2-w05b-team-drill-down-parser";
import { resolveReportingAudienceProjection } from "./p3-w05a-audience";
import type { WorkforceOverviewResult } from "./wf01-workforce-snapshot";
import {
  authorizeBucket,
  buildTeamDetail,
  decodeBucket,
  decodeCursor,
  selectBucketFacts,
} from "./p3-w06d-team-report-core";
import type { AudienceKind, TeamFactRow, TeamReportDetail } from "./p3-w06d-team-report-core";

/**
 * P3-W06D-R2 - server-side team-scoped report for a selected bucket.
 *
 * Authority is resolved ENTIRELY on the server from the SAME actor-scoped RPC
 * the dashboard uses (`direct_entry_reporting_scoped_facts`): the audience kind
 * and the authorized fact set come from the DB, never from the client. The
 * client only supplies a canonical `bucket_key`; the pure core verifies it
 * against the authorized facts before any aggregate or row is produced.
 *
 *   - audience `all`  -> any canonical team bucket (and `unknown`);
 *   - audience `team` -> only a team present in the actor's authorized facts
 *                        (i.e. inside the granted team scope); `unknown` denied;
 *   - audience `own`  -> denied.
 *
 * The response reuses the Direct Entry-only read path and sanitized seven-field
 * row list; no cross-team data can leave through a denied bucket.
 */

export type { TeamReportDetail, TeamReportRow } from "./p3-w06d-team-report-core";

export type TeamReportEnvelope = {
  /** The scoped aggregate; null on a "load more" request (cursor present). */
  report: ReportingData | null;
  /** Workforce snapshot is not loaded on team report (null). */
  workforce?: WorkforceOverviewResult | null;
  bucket: { key: string; display: string };
  detail: TeamReportDetail;
};

export type TeamReportResult =
  | { ok: true; data: TeamReportEnvelope }
  | { ok: false; code: string; status: 400 | 403 | 503 };

function invalid(): TeamReportResult {
  return { ok: false, code: INVALID_FILTER_CODE, status: 400 };
}

function unavailable(): TeamReportResult {
  return { ok: false, code: REPORTING_QUERY_FAILED_CODE, status: 503 };
}

function denied(): TeamReportResult {
  return { ok: false, code: REPORTING_QUERY_FAILED_CODE, status: 403 };
}

function rawAudienceKind(value: unknown): AudienceKind | null {
  if (typeof value !== "object" || value === null) return null;
  const kind = (value as Record<string, unknown>).audience;
  return kind === "all" || kind === "team" || kind === "own" ? kind : null;
}

export async function fetchCutoverTeamReport(
  params: RequestParams,
  actor: DirectEntryActor,
): Promise<TeamReportResult> {
  const parsed = parseTeamDrillDownRequest(params);
  if (!parsed.ok) return invalid();
  const { bucket_key: bucketKey, cursor, limit, filters } = parsed.value;

  const decoded = decodeBucket(bucketKey);
  if (!decoded) return invalid();
  if (cursor !== null && decodeCursor(cursor) === null) return invalid();

  try {
    const sb = createServiceSupabaseClient();

    const factsRes = await sb.rpc("direct_entry_reporting_scoped_facts", {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_filters: filters,
    });
    if (factsRes.error) return unavailable();

    const payload = (factsRes.data ?? {}) as {
      audience?: unknown;
      facts?: unknown[];
    };

    // The DB-resolved audience is the sole authority. Fail closed when unusable.
    const audience = resolveReportingAudienceProjection(payload.audience);
    if (audience === null) return unavailable();
    const scopedFacts = (payload.facts ?? []) as TeamFactRow[];

    const teamFacts = selectBucketFacts(scopedFacts, decoded);
    const authorization = authorizeBucket(rawAudienceKind(payload.audience), decoded, teamFacts.length > 0);
    if (authorization === "denied") return denied();
    if (authorization === "invalid") return invalid();

    const built = computeScopedReportingData({
      facts: teamFacts,
      filters,
    });
    if (!built.ok) return unavailable();

    const anchor = teamFacts[0];
    const display = decoded.kind === "unknown"
      ? "Không xác định"
      : (anchor?.team_display_name ?? "") + (anchor?.team_active === false ? " (Đã ngừng hoạt động)" : "");

    return {
      ok: true,
      data: {
        report: cursor === null ? built.data : null,
        workforce: null,
        bucket: { key: bucketKey, display },
        detail: buildTeamDetail({ facts: teamFacts, cursor, limit }),
      },
    };
  } catch {
    return unavailable();
  }
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function teamReportJson(data: TeamReportEnvelope): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: JSON_HEADERS });
}

export function teamReportError(code: string, status: 400 | 403 | 503): Response {
  return new Response(JSON.stringify({ ok: false, code }), { status, headers: JSON_HEADERS });
}
