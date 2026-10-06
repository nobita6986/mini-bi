import "server-only";

import type { DirectEntryActor } from "@/lib/auth/direct-entry-v2";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { parseReportingFilters } from "./p1-filter";
import { computeReporting, reportingQueryFailed } from "./p1-reporting";
import type {
  ReportingData,
  ReportingFact,
  ReportingSource,
  RunStatus,
} from "./p1-reporting";
import {
  reportingAudienceFromDb,
  resolveReportingAudienceKind,
} from "./p3-w05a-audience";
import type { ReportingAudience } from "./p3-w05a-audience";
import {
  combineReportingFacts,
  cutoverBlockerError,
  hasCutoverBlocker,
  maskDirectEntryFacts,
  maskLegacyFacts,
  P2_W04A_CUTOVER_BLOCKER_CODE,
  P2_W04A_CUTOVER_DATE,
  P2_W04A_CUTOVER_FAILED_CODE,
  P2_W04A_DIRECT_ENTRY_SOURCE,
  P2_W04A_DIRECT_ENTRY_SOURCE_ID,
} from "./p2-w04a-cutover";
import type {
  CutoverReconciliation,
  DirectEntryReportingFact,
} from "./p2-w04a-cutover";

/**
 * P3-W05A — Actor-scoped cutover read path.
 *
 * Reads authorized facts through the actor-scoped RPC at the DB boundary (never
 * fetches company-wide facts and hides them in React). The audience is resolved
 * server-side (all > team > own) and re-verified inside the RPC.
 *
 * Success shape is byte-compatible with P1's ReportingFetchResult plus an
 * additive `audience` projection for W06C. `data` is a plain ReportingData.
 */

type ScopedFactRow = ReportingFact & {
  first_work_date?: string | null;
  entry_id?: string | null;
  submission_id?: string | null;
  cutoff_date?: string | null;
};

export type CutoverFetchResult =
  | { ok: true; data: ReportingData; generatedAt: string; audience: ReportingAudience | null }
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
 * Read the runtime blocker helper ONCE per request (global cutover invariant).
 */
async function fetchCutoverBlockerCount(params: {
  sb: ReturnType<typeof createServiceSupabaseClient>;
}): Promise<
  { count: number } | { error: { code: string; message: string } }
> {
  const res = await params.sb.rpc(
    "direct_entry_reporting_pre_cutover_blocker_count",
  );
  if (res.error) {
    return { error: { code: res.error.code, message: res.error.message } };
  }
  const count = Number((res.data ?? 0) as unknown);
  if (!Number.isFinite(count) || count < 0) {
    return { error: { code: P2_W04A_CUTOVER_FAILED_CODE, message: "blocker count not a non-negative number" } };
  }
  return { count };
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
    const audienceKind = resolveReportingAudienceKind(actor, new Date().toISOString());

    // 1. Runtime blocker check (one RPC call per request; global invariant).
    const blocker = await fetchCutoverBlockerCount({ sb });
    if ("error" in blocker) {
      return { ok: false, code: blocker.error.code, message: blocker.error.message };
    }

    // 2. Legacy scope (active && !is_test) only for `all`.
    const rawSources: Omit<ReportingSource, "latest_run_status">[] = [];
    let scopeIds = new Set<string>();
    if (audienceKind === "all") {
      const sourcesRes = await sb
        .from("data_sources")
        .select("id, drive_file_id, file_name, active, is_test, last_seen_at, last_successful_sync_at")
        .eq("active", true)
        .eq("is_test", false);
      if (sourcesRes.error) throw sourcesRes.error;
      rawSources.push(...((sourcesRes.data ?? []) as Omit<ReportingSource, "latest_run_status">[]));
      scopeIds = new Set(rawSources.map((s) => s.id));
    }

    // 3. Parse filters. The source filter is legacy-only.
    const parsed = parseReportingFilters(params, audienceKind === "all" ? scopeIds : undefined);
    if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };
    const filters = parsed.filters;
    if (audienceKind !== "all") filters.source = undefined;

    // 4. Actor-scoped facts at the DB boundary (authorized + filtered).
    const factsRes = await sb.rpc("direct_entry_reporting_scoped_facts", {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_filters: filters,
    });
    if (factsRes.error) {
      logSafeError("p3-w05a-facts", factsRes.error);
      return reportingQueryFailed();
    }
    const payload = (factsRes.data ?? {}) as { audience?: unknown; facts?: unknown[] };
    const scopedFacts = (payload.facts ?? []) as ScopedFactRow[];
    const audience = reportingAudienceFromDb(payload.audience);

    // 5. Split + defense-in-depth mask + combine.
    const legacyFactsRaw: ReportingFact[] = [];
    const directEntryFactsRaw: DirectEntryReportingFact[] = [];
    for (const f of scopedFacts) {
      if (f.source_id === P2_W04A_DIRECT_ENTRY_SOURCE_ID) {
        directEntryFactsRaw.push(f as unknown as DirectEntryReportingFact);
      } else {
        legacyFactsRaw.push(f as ReportingFact);
      }
    }
    const maskedDirectEntry = maskDirectEntryFacts(directEntryFactsRaw);
    const legacyFacts = maskLegacyFacts(legacyFactsRaw);

    // 6. Sources + latest run status (legacy only for `all`).
    const latestBySource: Map<string, RunStatus> = new Map();
    if (audienceKind === "all" && rawSources.length > 0) {
      const runsRes = await sb
        .from("reporting_latest_sync_runs_v01")
        .select("source_id, status")
        .in("source_id", rawSources.map((s) => s.id));
      if (runsRes.error) throw runsRes.error;
      for (const r of (runsRes.data ?? []) as { source_id: string; status: RunStatus }[]) {
        latestBySource.set(r.source_id, r.status);
      }
    }
    const sources: ReportingSource[] = rawSources.map((s) => ({
      ...s,
      latest_run_status: latestBySource.get(s.id) ?? null,
    }));
    sources.push(P2_W04A_DIRECT_ENTRY_SOURCE);
    scopeIds.add(P2_W04A_DIRECT_ENTRY_SOURCE_ID);

    // 7. Presence (sourcesWithFacts) for empty-state fidelity.
    const sourcesWithFacts = new Set<string>();
    if (audienceKind === "all" && rawSources.length > 0) {
      const presenceRes = await sb
        .from("reporting_sources_with_current_facts_v01")
        .select("source_id")
        .in("source_id", rawSources.map((s) => s.id));
      if (presenceRes.error) throw presenceRes.error;
      for (const r of (presenceRes.data ?? []) as { source_id: string }[]) {
        sourcesWithFacts.add(r.source_id);
      }
    }
    if (maskedDirectEntry.length > 0) sourcesWithFacts.add(P2_W04A_DIRECT_ENTRY_SOURCE_ID);

    // 8. Reconciliation (overlap_blocker is the authoritative global count).
    const legacy_subtotal = legacyFacts.reduce((a, f) => a + f.recruited_count, 0);
    const direct_entry_subtotal = maskedDirectEntry.length;
    const reconciliation: CutoverReconciliation = {
      legacy_subtotal,
      direct_entry_subtotal,
      overlap_blocker: blocker.count,
      combined_total: legacy_subtotal + direct_entry_subtotal,
      cutoff_date: P2_W04A_CUTOVER_DATE,
    };

    if (hasCutoverBlocker(reconciliation)) {
      const err = cutoverBlockerError(reconciliation);
      console.error(
        "[p3-w05a] cutover blocker: overlap=" + err.reconciliation.overlap_blocker +
          " cutoff=" + err.reconciliation.cutoff_date +
          " legacy=" + err.reconciliation.legacy_subtotal + " de=" + err.reconciliation.direct_entry_subtotal,
      );
      return { ok: false, code: err.code, message: err.message, reconciliation };
    }

    // 9. Concatenate WITHOUT grain-dedupe, then compute.
    const combinedFacts = combineReportingFacts(legacyFacts, maskedDirectEntry);
    const data = computeReporting(sources, combinedFacts, filters, sourcesWithFacts);

    return { ok: true, data, generatedAt: new Date().toISOString(), audience };
  } catch (error) {
    logSafeError("p3-w05a-scoped-reporting", error);
    return reportingQueryFailed();
  }
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
