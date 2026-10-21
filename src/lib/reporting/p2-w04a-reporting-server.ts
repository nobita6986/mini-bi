import "server-only";

import type { DirectEntryActor } from "@/lib/auth/direct-entry-v2";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { parseReportingFilters } from "./p1-filter";
import type { ReportingFilters } from "./p1-filter";
import { resolvePriorPeriodComparisonForActor } from "./p1-period-comparison";
import type { PeriodComparisonResult } from "./p1-period-comparison";
import { computeReporting, reportingQueryFailed } from "./p1-reporting";
import type {
  ReportingData,
  ReportingFact,
} from "./p1-reporting";
import { resolveReportingAudienceProjection } from "./p3-w05a-audience";
import type { ReportingAudience } from "./p3-w05a-audience";
import {
  P2_W04A_CUTOVER_BLOCKER_CODE,
  P2_W04A_CUTOVER_FAILED_CODE,
  P2_W04A_DIRECT_ENTRY_SOURCE,
  P2_W04A_DIRECT_ENTRY_SOURCE_ID,
} from "./p2-w04a-cutover";
import type { CutoverReconciliation } from "./p2-w04a-cutover";

/**
 * P3-W05A-R1 - DB-authoritative scoped cutover read path.
 *
 * Reads authorized facts AND source metadata through one actor-scoped RPC at
 * the DB boundary. The DB-resolved audience (all > team > own, HCM date) is the
 * single authority for both facts and metadata: no TypeScript/UTC audience
 * inference, no pre-RPC global metadata read (no TOCTOU leak).
 */

type ScopedFactRow = ReportingFact & {
  first_work_date?: string | null;
  entry_id?: string | null;
  submission_id?: string | null;
  cutoff_date?: string | null;
};

export type CutoverFetchResult =
  | { ok: true; data: ReportingData; generatedAt: string; comparison?: PeriodComparisonResult; audience: ReportingAudience }
  | {
      ok: false;
      code: string;
      message: string;
      reconciliation?: CutoverReconciliation;
    };

function logSafeError(prefix: string, error: unknown) {
  const safeCode =
    error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : "unknown";
  console.error("[" + prefix + "] query failed. code=" + safeCode);
}

/**
 * Main read-path entrypoint. `actor` is a mandatory input (the page resolves
 * it once via resolveActorForRequest and passes it server-side).
 */
export async function fetchCutoverReporting(
  params: Record<string, string | string[] | undefined>,
  actor: DirectEntryActor,
): Promise<CutoverFetchResult> {
  try {
    const sb = createServiceSupabaseClient();

    // Parse only business dimensions; this report is based on Direct Entry.
    const parsed = parseReportingFilters(params, undefined);
    if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };
    const filters = parsed.filters;
    filters.source = undefined;

    // Facts and audience remain gated together by the same DB-authoritative RPC.
    const factsRes = await sb.rpc("direct_entry_reporting_scoped_facts", {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_filters: filters,
    });
    if (factsRes.error) {
      logSafeError("p3-w05a-facts", factsRes.error);
      return reportingQueryFailed();
    }
    const payload = (factsRes.data ?? {}) as {
      audience?: unknown;
      facts?: unknown[];
    };
    const scopedFacts = (payload.facts ?? []) as ScopedFactRow[];

    // Fail closed and keep the scope label inclusive. A successful response
    // without a usable audience must not become facts under a guessed scope, and
    // a team audience resolved from several effective grants must never read as
    // one named team (the DB only labels the first one).
    const audience = resolveReportingAudienceProjection(payload.audience);
    if (audience === null) {
      logSafeError("p3-w05a-audience", "audience payload missing or malformed");
      return reportingQueryFailed();
    }
    // The report has one canonical source; no external-source metadata or cutoff.
    const built = computeScopedReportingData({
      facts: scopedFacts,
      filters,
    });
    if (!built.ok) {
      return { ok: false, code: built.code, message: built.message, reconciliation: built.reconciliation };
    }

    const comparison = await resolvePriorPeriodComparisonForActor({
      actor,
      filters,
      currentTotal: built.data.recruitedTotal,
      expectedAudienceKind: audience.kind,
      callScopedFactsRpc: (args) => sb.rpc("direct_entry_reporting_scoped_facts", args),
    });

    return { ok: true, data: built.data, generatedAt: new Date().toISOString(), comparison, audience };
  } catch (error) {
    logSafeError("p3-w05a-scoped-reporting", error);
    return reportingQueryFailed();
  }
}

export type ScopedReportingBuild =
  | { ok: true; data: ReportingData }
  | { ok: false; code: string; message: string; reconciliation?: CutoverReconciliation };

/**
 * P3-W05A / P3-W06D-R2 - build ReportingData from an already-authorized Direct Entry fact set.
 *
 * Shared by the company/scope read path (`fetchCutoverReporting`) and the
 * team-scoped read (`fetchCutoverTeamReport`) so the canonical source and
 * read-model are expressed exactly once.
 *
 * `facts` MUST already be scoped and authorized at the DB boundary (audience +
 * filters); this builder runs the pure read-model without adding a second date
 * eligibility rule or mixing another source.
 */
export function computeScopedReportingData(input: {
  facts: ReportingFact[];
  filters: ReportingFilters;
}): ScopedReportingBuild {
  const { facts, filters } = input;
  const directEntryFacts = facts.filter((fact) => fact.source_id === P2_W04A_DIRECT_ENTRY_SOURCE_ID);
  const sourcesWithFacts = directEntryFacts.length > 0
    ? new Set([P2_W04A_DIRECT_ENTRY_SOURCE_ID])
    : new Set<string>();
  const data = computeReporting(
    [P2_W04A_DIRECT_ENTRY_SOURCE],
    directEntryFacts,
    filters,
    sourcesWithFacts,
  );
  return { ok: true, data };
}

/**
 * Offline read-only reconciliation helper (unchanged from W04A/W04B).
 */
export const P2_W04A_RECONCILIATION_SQL = `
  select
    legacy_subtotal,
    direct_entry_subtotal,
    overlap_blocker,
    cutoff_date::text as cutoff_date
  from public.direct_entry_reporting_reconciliation_totals()
`;

export { P2_W04A_CUTOVER_BLOCKER_CODE, P2_W04A_CUTOVER_FAILED_CODE };
export type { ReportingData };
