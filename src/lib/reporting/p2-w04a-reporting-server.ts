import "server-only";

import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { parseReportingFilters } from "./p1-filter";
import {
  buildReportingFactQuery,
  computeReporting,
} from "./p1-reporting";
import type { ReportingFact, ReportingData, RunStatus } from "./p1-reporting";
import { paginateAll, REPORTING_FACT_ORDER, REPORTING_PAGE_SIZE } from "./p1-reporting-pagination";
import {
  buildReconciliation,
  combineReportingFacts,
  cutoverBlockerError,
  hasCutoverBlocker,
  maskDirectEntryFacts,
  maskLegacyFacts,
  P2_W04A_CUTOVER_BLOCKER_CODE,
  P2_W04A_CUTOVER_FAILED_CODE,
  P2_W04A_DIRECT_ENTRY_SOURCE,
  P2_W04A_DIRECT_ENTRY_SOURCE_ID,
} from "./p2-w04a-cutover";
import type {
  CombinedReportingData,
  CutoverReconciliation,
  CutoverReportingResult,
  DirectEntryReportingFact,
} from "./p2-w04a-cutover";

/**
 * P2-W04A — Combined cutover read path.
 *
 * Reads both legacy aggregate and the Direct Entry projection view, masks
 * both at the boundary, combines them into a single `ReportingFact[]` and
 * produces a unified `ReportingData` shape (so the existing P1 dashboard
 * continues to work unchanged).
 *
 * The Direct Entry synthetic source is added to the in-memory sources
 * array so `computeReporting` treats DE facts as in-scope. The synthetic
 * source is NOT inserted into `public.data_sources`.
 *
 * If an eligible Direct Entry row has first_work_date < cutoff, the read
 * path returns a hard-fail cutover blocker. The reconciliation is attached
 * to the error so callers can surface the diagnostic data without
 * re-querying.
 */

const LEGACY_FACT_COLUMNS =
  "source_id, business_date, project_key, project_display, recruiter_key, recruiter_display, provider_type_key, provider_type_display, employment_type_key, employment_type_display, recruited_count";

const DIRECT_ENTRY_FACT_COLUMNS =
  "source_id, business_date, project_key, project_display, recruiter_key, recruiter_display, provider_type_key, provider_type_display, employment_type_key, employment_type_display, recruited_count, first_work_date, entry_id, submission_id, cutoff_date";

/** Combined read-path result. Keeps the existing P1 type so the dashboard
 *  does not need to change.
 */
export type CutoverFetchResult =
  | { ok: true; data: CombinedReportingData; generatedAt: string }
  | { ok: false; code: string; message: string; reconciliation?: CutoverReconciliation };

function logSafeError(prefix: string, error: unknown) {
  const safeCode =
    error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : "unknown";
  console.error(`[${prefix}] query failed. code=${safeCode}`);
}

/**
 * Fetches legacy masked facts from `daily_recruitment_breakdown`. The
 * server applies the date mask `business_date < cutoff` to the SELECT.
 * The TS-level mask is still applied as a defense-in-depth.
 */
async function fetchLegacyFacts(params: {
  sb: ReturnType<typeof createServiceSupabaseClient>;
  plan: ReportingPlanFactQuery;
}): Promise<{ rows: ReportingFact[]; count: number } | { error: { code: string; message: string } }> {
  let q = params.sb
    .from("daily_recruitment_breakdown")
    .select(LEGACY_FACT_COLUMNS, { count: "exact" })
    .in("source_id", params.plan.scopeIds);
  // Apply date mask < cutoff at the database boundary.
  q = q.lt("business_date", "2026-10-17");
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
 * Fetches Direct Entry masked facts from `direct_entry_reporting_facts_v01`.
 * The SQL view already applies the date mask `first_work_date >= cutoff`,
 * so this loader simply returns whatever the view exposes. The TS-level
 * mask is still applied for defense in depth.
 */
async function fetchDirectEntryFacts(params: {
  sb: ReturnType<typeof createServiceSupabaseClient>;
  filters: import("./p1-filter").ReportingFilters;
}): Promise<{ rows: DirectEntryReportingFact[]; count: number } | { error: { code: string; message: string } }> {
  let q = params.sb
    .from("direct_entry_reporting_facts_v01")
    .select(DIRECT_ENTRY_FACT_COLUMNS, { count: "exact" });
  if (params.filters.from) q = q.gte("business_date", params.filters.from);
  if (params.filters.to) q = q.lte("business_date", params.filters.to);
  if (params.filters.project) q = q.eq("project_key", params.filters.project);
  if (params.filters.recruiter) q = q.eq("recruiter_key", params.filters.recruiter);
  if (params.filters.provider) q = q.eq("provider_type_key", params.filters.provider);
  if (params.filters.employment) q = q.eq("employment_type_key", params.filters.employment);
  for (const col of REPORTING_FACT_ORDER) q = q.order(col);

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
 * Main read-path entrypoint for the cutover. Returns a `CutoverFetchResult`
 * that extends the P1 `ReportingData` with a reconciliation block. The
 * dashboard treats the returned `data` field identically to the legacy
 * shape; only the additional `legacy_subtotal` / `direct_entry_subtotal` /
 * `overlap_blocker` / `combined_total` / `cutoff_date` fields are new.
 */
export async function fetchCutoverReporting(
  params: Record<string, string | string[] | undefined>,
): Promise<CutoverFetchResult> {
  try {
    const sb = createServiceSupabaseClient();

    // 1. Legacy scope (data_sources active && !is_test).
    const sourcesRes = await sb
      .from("data_sources")
      .select("id, drive_file_id, file_name, active, is_test, last_seen_at, last_successful_sync_at")
      .eq("active", true)
      .eq("is_test", false);
    if (sourcesRes.error) throw sourcesRes.error;
    const rawSources = (sourcesRes.data ?? []) as Omit<
      import("./p1-reporting").ReportingSource,
      "latest_run_status"
    >[];
    const scopeIds = new Set(rawSources.map((s) => s.id));

    const parsed = parseReportingFilters(params, scopeIds);
    if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };

    if (scopeIds.size === 0) {
      // No legacy sources: the dashboard can still render if there are DE
      // facts. We still go through the full path.
    }

    const scopeIdArray = Array.from(scopeIds);

    // 2. Latest run for each source.
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

    const sources: ReportingData["sources"][number] extends never
      ? never
      : import("./p1-reporting").ReportingSource[] = rawSources.map((s) => ({
      ...s,
      latest_run_status: latestBySource.get(s.id) ?? null,
    }));

    // Add the synthetic Direct Entry source so computeReporting treats DE
    // facts as in-scope. The source is not in data_sources; it lives only
    // in the in-memory array passed to computeReporting.
    sources.push(P2_W04A_DIRECT_ENTRY_SOURCE);
    scopeIds.add(P2_W04A_DIRECT_ENTRY_SOURCE_ID);

    // 3. Presence from the legacy view (DISTINCT source_id, data-minimal).
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

    // 4. Plan and load legacy facts with the date mask applied at the DB.
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
      // Defense-in-depth: mask in TS as well.
      const masked = maskLegacyFacts(legacyLoad.rows);
      legacyFacts.push(...masked);
    }

    // 5. Load Direct Entry projection facts. The SQL view already applies
    //    the cutoff mask; TS re-applies as a safety net.
    const deLoad = await fetchDirectEntryFacts({ sb, filters: parsed.filters });
    if ("error" in deLoad) {
      return { ok: false, code: deLoad.error.code, message: deLoad.error.message };
    }
    const directEntryFactsRaw = deLoad.rows;
    const maskedDirectEntry = maskDirectEntryFacts(directEntryFactsRaw);

    // 6. Build the reconciliation BEFORE combining. The reconciliation is
    //    the source of truth for the cutoff blocker.
    const reconciliation = buildReconciliation({
      legacyFacts,
      directEntryFactsRaw,
    });
    if (hasCutoverBlocker(reconciliation)) {
      const err = cutoverBlockerError(reconciliation);
      console.error(
        `[p2-w04a] cutover blocker: overlap=${err.reconciliation.overlap_blocker} ` +
          `cutoff=${err.reconciliation.cutoff_date} ` +
          `legacy=${err.reconciliation.legacy_subtotal} de=${err.reconciliation.direct_entry_subtotal}`,
      );
      return { ok: false, code: err.code, message: err.message, reconciliation };
    }

    // 7. Combine the two sources and feed computeReporting. The synthetic
    //    DE source_id is in `sources` so `computeReporting` keeps DE rows.
    const combinedFacts = combineReportingFacts(legacyFacts, maskedDirectEntry);

    const data = computeReporting(sources, combinedFacts, parsed.filters, sourcesWithFacts);

    // 8. If legacy scope is empty but DE has facts, computeReporting will
    //    report noSources=true. The dashboard treats that as empty; that's
    //    acceptable. The reconciliation still records the DE subtotal.

    const combined: CombinedReportingData = {
      legacy_subtotal: reconciliation.legacy_subtotal,
      direct_entry_subtotal: reconciliation.direct_entry_subtotal,
      overlap_blocker: reconciliation.overlap_blocker,
      combined_total: reconciliation.combined_total,
      cutoff_date: reconciliation.cutoff_date,
      data,
    };

    return { ok: true, data: combined, generatedAt: new Date().toISOString() };
  } catch (error) {
    logSafeError("p2-w04a-cutover", error);
    return { ok: false, code: P2_W04A_CUTOVER_FAILED_CODE, message: "Cutover read path failed." };
  }
}

/**
 * Offline read-only reconciliation helper. Runs the SQL reconciliation
 * function inside a READ ONLY transaction and rolls back. Used by the
 * production read-only script (`scripts/p2-w04a-reconcile.mjs`) and the
 * acceptance tests.
 *
 * Implementation note: this helper does NOT open its own pg client — it
 * returns the SQL that should be executed inside the read-only transaction
 * (BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout; <sql>;
 * ROLLBACK;). The script wraps the SQL with the transaction itself.
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
// Suppress unused-import lint for ReportingFetchResult — not used directly here
// but the existing module export is kept for compatibility.
export type { CutoverReportingResult };

// Suppress unused-import lint for paginateAll (already imported above).
void paginateAll;