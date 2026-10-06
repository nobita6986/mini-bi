import "server-only";

import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { parseReportingFilters } from "./p1-filter";
import {
  buildReportingFactQuery,
  computeReporting,
  reportingQueryFailed,
} from "./p1-reporting";
import type {
  ReportingData,
  ReportingFact,
  ReportingSource,
  RunStatus,
} from "./p1-reporting";
import {
  paginateAll,
  REPORTING_FACT_ORDER,
  REPORTING_PAGE_SIZE,
} from "./p1-reporting-pagination";

// Deterministic tie-breaker for the Direct Entry paginated fact read.
// Two eligible DE entries that share the same ReportingFact grain MUST
// paginate deterministically; the SQL view's ORDER BY uses REPORTING_FACT_ORDER
// and appends entry_id as the unique tie-breaker. The TS loader mirrors that
// clause so a Supabase PostgREST range query stays consistent with the view
// definition (otherwise page boundaries could collapse same-grain rows).
const DE_TIE_BREAKER_ORDER = ["entry_id"] as const;
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
 * P2-W04A — Combined cutover read path (R1).
 *
 * Reads both legacy aggregate and the Direct Entry projection view, masks
 * both at the boundary, runs the SQL blocker helper INDEPENDENTLY of the
 * masked view (so a pre-cutoff eligible row can never be hidden behind a
 * silently-bypassed view), concatenates them WITHOUT grain-dedupe so two
 * DE employees that share the same ReportingFact grain each contribute 1,
 * and feeds `computeReporting` to produce the same `ReportingData` shape
 * the dashboard already consumes.
 *
 * The Direct Entry synthetic source is added to the in-memory sources
 * array so `computeReporting` treats DE facts as in-scope. The synthetic
 * source is NOT inserted into `public.data_sources`.
 *
 * Result shape is intentionally identical to P1's `ReportingFetchResult`:
 *
 *   { ok: true, data: ReportingData, generatedAt }
 *   { ok: false, code, message, reconciliation? }
 *
 * No `data.data`. Reconciliation metadata (when the read path returns a
 * cutover blocker) is attached ONLY to the error and is never placed
 * inside `data`. DashboardView consumes `data` exactly as P1 expects.
 */

const LEGACY_FACT_COLUMNS =
  "source_id, business_date, project_key, project_display, recruiter_key, recruiter_display, provider_type_key, provider_type_display, employment_type_key, employment_type_display, recruited_count";

const DIRECT_ENTRY_FACT_COLUMNS =
  "source_id, business_date, project_key, project_display, recruiter_key, recruiter_display, provider_type_key, provider_type_display, employment_type_key, employment_type_display, recruited_count, first_work_date, entry_id, submission_id, cutoff_date";

/**
 * Read-path result for the cutover seam.
 *
 * Success shape is byte-equivalent to `ReportingFetchResult` so the
 * dashboard treats `data` as a plain `ReportingData`. The optional
 * `reconciliation` field only appears on the failure branch.
 */
export type CutoverFetchResult =
  | { ok: true; data: ReportingData; generatedAt: string }
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
  console.error(`[${prefix}] query failed. code=${safeCode}`);
}

/**
 * Fetch legacy masked facts from `daily_recruitment_breakdown`. The
 * server applies the date mask `business_date < cutoff` to the SELECT.
 * The TS-level mask is still applied as defense-in-depth.
 */
async function fetchLegacyFacts(params: {
  sb: ReturnType<typeof createServiceSupabaseClient>;
  plan: ReportingPlanFactQuery;
}): Promise<
  { rows: ReportingFact[]; count: number } | { error: { code: string; message: string } }
> {
  let q = params.sb
    .from("daily_recruitment_breakdown")
    .select(LEGACY_FACT_COLUMNS, { count: "exact" })
    .in("source_id", params.plan.scopeIds);
  // Apply date mask < cutoff at the database boundary. The literal is the
  // single source of truth exported by p2-w04a-cutover; any future
  // rebaseline updates the constant, not this seam.
  q = q.lt("business_date", P2_W04A_CUTOVER_DATE);
  if (params.plan.source) q = q.eq("source_id", params.plan.source);
  if (params.plan.from) q = q.gte("business_date", params.plan.from);
  if (params.plan.to) q = q.lte("business_date", params.plan.to);
  if (params.plan.project) q = q.eq("project_key", params.plan.project);
  if (params.plan.recruiter) q = q.eq("recruiter_key", params.plan.recruiter);
  if (params.plan.provider) q = q.eq("provider_type_key", params.plan.provider);
  if (params.plan.employment) q = q.eq("employment_type_key", params.plan.employment);
  for (const col of REPORTING_FACT_ORDER) q = q.order(col);

  const paged = await paginateAll<ReportingFact>(async ([from, to]) => {
    const res = await q.range(from, to);
    if (res.error) {
      return { rows: [], count: null, error: { code: res.error.code, message: res.error.message } };
    }
    return { rows: (res.data ?? []) as ReportingFact[], count: res.count ?? null };
  }, { pageSize: REPORTING_PAGE_SIZE });
  if (!paged.ok) return { error: { code: paged.code, message: paged.message } };
  return { rows: paged.rows, count: paged.count };
}

/**
 * Fetch Direct Entry masked facts from `direct_entry_reporting_facts_v01`.
 * The SQL view already applies the date mask `first_work_date >= cutoff`,
 * so this loader simply returns whatever the view exposes. The TS-level
 * mask is still applied for defense in depth.
 */
async function fetchDirectEntryFacts(params: {
  sb: ReturnType<typeof createServiceSupabaseClient>;
  filters: import("./p1-filter").ReportingFilters;
}): Promise<
  { rows: DirectEntryReportingFact[]; count: number } | { error: { code: string; message: string } }
> {
  let q = params.sb
    .from("direct_entry_reporting_facts_v01")
    .select(DIRECT_ENTRY_FACT_COLUMNS, { count: "exact" });
  if (params.filters.from) q = q.gte("business_date", params.filters.from);
  if (params.filters.to) q = q.lte("business_date", params.filters.to);
  if (params.filters.project) q = q.eq("project_key", params.filters.project);
  if (params.filters.recruiter) q = q.eq("recruiter_key", params.filters.recruiter);
  if (params.filters.provider) q = q.eq("provider_type_key", params.filters.provider);
  if (params.filters.employment) q = q.eq("employment_type_key", params.filters.employment);
  // ReportingFact grain first; entry_id as the unique tie-breaker (matches
  // the SQL view's ORDER BY). Same-grain DE entries paginate deterministically.
  for (const col of REPORTING_FACT_ORDER) q = q.order(col);
  for (const col of DE_TIE_BREAKER_ORDER) q = q.order(col);

  const paged = await paginateAll<DirectEntryReportingFact>(async ([from, to]) => {
    const res = await q.range(from, to);
    if (res.error) {
      return { rows: [], count: null, error: { code: res.error.code, message: res.error.message } };
    }
    return { rows: (res.data ?? []) as DirectEntryReportingFact[], count: res.count ?? null };
  }, { pageSize: REPORTING_PAGE_SIZE });
  if (!paged.ok) return { error: { code: paged.code, message: paged.message } };
  return { rows: paged.rows, count: paged.count };
}

/**
 * Mirror of `buildReportingFactQuery` but typed privately so we can pass it
 * to the DB loader helpers.
 */
interface ReportingPlanFactQuery {
  scopeIds: string[];
  source?: string;
  from?: string;
  to?: string;
  project?: string;
  recruiter?: string;
  provider?: string;
  employment?: string;
}

/**
 * Read the runtime blocker helper ONCE per request.
 *
 * The blocker helper is INDEPENDENT of `direct_entry_reporting_facts_v01`
 * (which already applies the >= cutoff mask). It re-counts eligible DE
 * rows with first_work_date < cutoff directly from
 * `direct_entries`/`direct_entry_submissions`. The TS seam uses this
 * number as the authoritative source of truth for the fail-closed check,
 * so the blocker survives any silent bypass of the SQL view definition.
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
  // RPC returns the scalar value directly.
  const count = Number((res.data ?? 0) as unknown);
  if (!Number.isFinite(count) || count < 0) {
    return { error: { code: P2_W04A_CUTOVER_FAILED_CODE, message: "blocker count not a non-negative number" } };
  }
  return { count };
}

/**
 * Main read-path entrypoint for the cutover. Returns a `CutoverFetchResult`
 * whose SUCCESS shape is byte-equivalent to P1 `ReportingFetchResult` so
 * the dashboard treats it identically.
 *
 * Cutover block: a non-zero SQL blocker count or a non-zero TS-side detector
 * yields `REPORTING_CUTOVER_BLOCKER` BEFORE any partial Dashboard is
 * constructed. The reconciliation block is attached to the error.
 */
export async function fetchCutoverReporting(
  params: Record<string, string | string[] | undefined>,
): Promise<CutoverFetchResult> {
  try {
    const sb = createServiceSupabaseClient();

    // 1. Runtime blocker check (one RPC call per request; no N+1).
    //    Done BEFORE any expensive fact load so a blocker fails fast.
    const blocker = await fetchCutoverBlockerCount({ sb });
    if ("error" in blocker) {
      return { ok: false, code: blocker.error.code, message: blocker.error.message };
    }

    // 2. Legacy scope (data_sources active && !is_test).
    const sourcesRes = await sb
      .from("data_sources")
      .select("id, drive_file_id, file_name, active, is_test, last_seen_at, last_successful_sync_at")
      .eq("active", true)
      .eq("is_test", false);
    if (sourcesRes.error) throw sourcesRes.error;
    const rawSources = (sourcesRes.data ?? []) as Omit<
      ReportingSource,
      "latest_run_status"
    >[];
    const scopeIds = new Set(rawSources.map((s) => s.id));

    const parsed = parseReportingFilters(params, scopeIds);
    if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };

    const scopeIdArray = Array.from(scopeIds);

    // 3. Latest run for each source (legacy scope only — DE is synthetic).
    const latestBySource: Map<string, RunStatus> = new Map();
    if (scopeIdArray.length > 0) {
      const runsRes = await sb
        .from("reporting_latest_sync_runs_v01")
        .select("source_id, status")
        .in("source_id", scopeIdArray);
      if (runsRes.error) throw runsRes.error;
      for (const r of (runsRes.data ?? []) as { source_id: string; status: RunStatus }[]) {
        latestBySource.set(r.source_id, r.status);
      }
    }

    const sources: ReportingSource[] = rawSources.map((s) => ({
      ...s,
      latest_run_status: latestBySource.get(s.id) ?? null,
    }));

    // Add the synthetic Direct Entry source so computeReporting treats DE
    // facts as in-scope. The source is not in data_sources; it lives only
    // in the in-memory array passed to computeReporting.
    sources.push(P2_W04A_DIRECT_ENTRY_SOURCE);
    scopeIds.add(P2_W04A_DIRECT_ENTRY_SOURCE_ID);

    // 4. Presence from the legacy view (DISTINCT source_id, data-minimal).
    const sourcesWithFacts = new Set<string>();
    if (scopeIdArray.length > 0) {
      const presenceRes = await sb
        .from("reporting_sources_with_current_facts_v01")
        .select("source_id")
        .in("source_id", scopeIdArray);
      if (presenceRes.error) throw presenceRes.error;
      for (const r of (presenceRes.data ?? []) as { source_id: string }[]) {
        sourcesWithFacts.add(r.source_id);
      }
    }
    // DE source is "present" iff its projection view returns >= 1 row.
    // Tracked via a follow-up count on the projection view below if needed.
    // We add it lazily after the DE fact load (Blocker 5 / sourcesWithFacts
    // for empty-state fidelity).

    // 5. Plan and load legacy facts with the date mask applied at the DB.
    const plan = buildReportingFactQuery(parsed.filters, scopeIds);
    const legacyFacts: ReportingFact[] = [];
    if (!plan.skip && scopeIdArray.length > 0) {
      const qplan: ReportingPlanFactQuery = {
        scopeIds: plan.query.scopeIds.filter((id) => id !== P2_W04A_DIRECT_ENTRY_SOURCE_ID),
        source: plan.query.source,
        from: plan.query.from,
        to: plan.query.to,
        project: plan.query.project,
        recruiter: plan.query.recruiter,
        provider: plan.query.provider,
        employment: plan.query.employment,
      };
      const legacyLoad = await fetchLegacyFacts({ sb, plan: qplan });
      if ("error" in legacyLoad) {
        return { ok: false, code: legacyLoad.error.code, message: legacyLoad.error.message };
      }
      const masked = maskLegacyFacts(legacyLoad.rows);
      legacyFacts.push(...masked);
    }

    // 6. Load Direct Entry projection facts. The SQL view already applies
    //    the cutoff mask; TS re-applies as a safety net.
    const deLoad = await fetchDirectEntryFacts({ sb, filters: parsed.filters });
    if ("error" in deLoad) {
      return { ok: false, code: deLoad.error.code, message: deLoad.error.message };
    }
    const directEntryFactsRaw = deLoad.rows;
    const maskedDirectEntry = maskDirectEntryFacts(directEntryFactsRaw);

    // Track DE source presence for empty-state fidelity.
    if (maskedDirectEntry.length > 0) sourcesWithFacts.add(P2_W04A_DIRECT_ENTRY_SOURCE_ID);

    // 7. Build the reconciliation BEFORE combining. The reconciliation is
    //    the source of truth for the cutoff blocker. The runtime blocker
    //    count from step 1 is the AUTHORITATIVE number (it queries DB
    //    directly, independent of the masked view), so the reconciliation
    //    inherits it.
    const legacy_subtotal = legacyFacts.reduce((a, f) => a + f.recruited_count, 0);
    const direct_entry_subtotal = maskedDirectEntry.length;
    const reconciliation: CutoverReconciliation = {
      legacy_subtotal,
      direct_entry_subtotal,
      overlap_blocker: blocker.count, // AUTHORITATIVE runtime count
      combined_total: legacy_subtotal + direct_entry_subtotal,
      cutoff_date: P2_W04A_CUTOVER_DATE,
    };

    if (hasCutoverBlocker(reconciliation)) {
      const err = cutoverBlockerError(reconciliation);
      console.error(
        `[p2-w04a] cutover blocker: overlap=${err.reconciliation.overlap_blocker} ` +
          `cutoff=${err.reconciliation.cutoff_date} ` +
          `legacy=${err.reconciliation.legacy_subtotal} de=${err.reconciliation.direct_entry_subtotal}`,
      );
      return { ok: false, code: err.code, message: err.message, reconciliation };
    }

    // 8. Concatenate the two sources WITHOUT grain-dedupe (Blocker 4).
    //    computeReporting will sum per grain, so two same-grain DE entries
    //    correctly contribute 2.
    const combinedFacts = combineReportingFacts(legacyFacts, maskedDirectEntry);

    const data = computeReporting(sources, combinedFacts, parsed.filters, sourcesWithFacts);

    return { ok: true, data, generatedAt: new Date().toISOString() };
  } catch (error) {
    logSafeError("p2-w04a-cutover", error);
    return reportingQueryFailed();
  }
}

/**
 * Offline read-only reconciliation helper. Runs the SQL reconciliation
 * function inside a READ ONLY transaction and rolls back. Used by the
 * production read-only script (`scripts/p2-w04a-reconcile.mjs`) and the
 * acceptance tests.
 */
export const P2_W04A_RECONCILIATION_SQL = `
  select
    legacy_subtotal,
    direct_entry_subtotal,
    overlap_blocker,
    cutoff_date::text as cutoff_date
  from public.direct_entry_reporting_reconciliation_totals()
`;

/** Cutover blocker code, exposed for callers that want to detect it
 *  without importing the full module.
 */
export { P2_W04A_CUTOVER_BLOCKER_CODE, P2_W04A_CUTOVER_FAILED_CODE };

// Suppress unused-import lint when ReportingData is only used as a type.
export type { ReportingData };