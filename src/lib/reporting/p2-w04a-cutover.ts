import type { ReportingFact, ReportingSource } from "./p1-reporting";

/**
 * P2-W04A — Direct Entry reporting cutover contract.
 *
 *   - Cutoff date locked at 2026-10-17 (Asia/Ho_Chi_Minh).
 *   - Legacy facts counted only when business_date < cutoff.
 *   - Direct Entry facts counted only when first_work_date >= cutoff.
 *   - Eligibility: submission.state = 'SUBMITTED' AND deleted_at IS NULL.
 *   - One eligible Direct Entry row => recruited_count = 1.
 *   - Pre-cutoff eligible Direct Entry rows => cutover blocker (fail closed).
 *
 * This file is pure data (no SQL, no IO). The DB-side masks live in
 * `supabase/migrations/20261007020000_p2_w04a_direct_entry_reporting_cutover.sql`.
 * The read-path seam (`src/lib/reporting/p1-reporting-server.ts`) loads both
 * sources and combines them via `combineReportingFacts` / `reconcileCutover`.
 *
 * The TS layer never multiplies rows by revisions/documents/payments/events:
 * the SQL projection itself has grain = entry_id, so the "no double count"
 * guarantee is enforced by the SELECT shape, not by application logic.
 */

/** Hard-coded cutover date. Mirrors `public.direct_entry_reporting_cutoff()`. */
export const P2_W04A_CUTOVER_DATE = "2026-10-17" as const;

/** Synthetic Direct Entry source id. Mirrors `public.direct_entry_reporting_source_id()`. */
export const P2_W04A_DIRECT_ENTRY_SOURCE_ID =
  "00000000-0000-4000-8000-0000de000001";

/** Locked error code for cutover blockers (fail-closed). */
export const P2_W04A_CUTOVER_BLOCKER_CODE = "REPORTING_CUTOVER_BLOCKER";
/** Locked error code for the read path; reuses P1 contract. */
export const P2_W04A_CUTOVER_FAILED_CODE = "REPORTING_QUERY_FAILED";

/**
 * Stable synthetic ReportingSource for the Direct Entry projection. It is
 * marked as `active=true`, `is_test=false`, `latest_run_status="succeeded"`
 * and `last_successful_sync_at` pinned to the cutover date so it renders as
 * "covered" in the existing source-status UI without inventing a
 * data_sources row.
 */
export const P2_W04A_DIRECT_ENTRY_SOURCE: ReportingSource = Object.freeze({
  id: P2_W04A_DIRECT_ENTRY_SOURCE_ID,
  drive_file_id: P2_W04A_DIRECT_ENTRY_SOURCE_ID,
  file_name: "Direct Entry (canonical)",
  active: true,
  is_test: false,
  latest_run_status: "succeeded",
  last_successful_sync_at: `${P2_W04A_CUTOVER_DATE}T00:00:00Z`,
  last_seen_at: `${P2_W04A_CUTOVER_DATE}T00:00:00Z`,
});

/**
 * Cutover reconciliation record. Mirrors the contract requirements:
 *   * legacy_subtotal       = sum(recruited_count) for legacy aggregate
 *                             masked to business_date < cutoff.
 *   * direct_entry_subtotal = count(*) of eligible Direct Entry rows with
 *                             first_work_date >= cutoff.
 *   * overlap_blocker       = count(*) of eligible Direct Entry rows with
 *                             first_work_date < cutoff. Non-zero => blocker.
 *   * combined_total        = legacy_subtotal + direct_entry_subtotal.
 *   * cutoff_date           = the locked cutover date.
 *
 * The reconciliation is always produced. A non-zero overlap_blocker MUST
 * also be surfaced as a hard error by the read path (see `hasCutoverBlocker`).
 */
export interface CutoverReconciliation {
  legacy_subtotal: number;
  direct_entry_subtotal: number;
  overlap_blocker: number;
  combined_total: number;
  cutoff_date: string;
}

/**
 * Combined `ReportingData` result returned by the read path. Wraps the
 * existing P1 `ReportingData` shape plus the cutover reconciliation block.
 * The dashboard UI is expected to render the existing dashboard; this type
 * is for the server-only API response.
 */
export interface CombinedReportingData {
  /** Legacy subtotal (business_date < cutoff). */
  legacy_subtotal: number;
  /** Direct Entry subtotal (first_work_date >= cutoff). */
  direct_entry_subtotal: number;
  /** Eligible Direct Entry rows on the legacy side of the cutoff; >0 = blocker. */
  overlap_blocker: number;
  /** legacy_subtotal + direct_entry_subtotal. */
  combined_total: number;
  /** Locked cutover date. */
  cutoff_date: string;
  /** Pre-existing P1 reporting data (legacy-aggregate + dashboard metadata). */
  data: import("./p1-reporting").ReportingData;
}

/** Read-path result with the cutover contract. */
export type CutoverReportingResult =
  | { ok: true; data: CombinedReportingData; generatedAt: string }
  | {
      ok: false;
      code: string;
      message: string;
      // When the blocker is a cutover blocker, the partial reconciliation
      // is attached so the caller can surface it without re-running the
      // reconciliation query.
      reconciliation?: CutoverReconciliation;
    };

/**
 * Direct Entry reporting fact projection shape. Mirrors the SQL view
 * `public.direct_entry_reporting_facts_v01`. The view returns one row per
 * eligible entry, with `recruited_count = 1` and `first_work_date >=
 * cutoff` already enforced at the database boundary.
 */
export interface DirectEntryReportingFact extends ReportingFact {
  source_id: typeof P2_W04A_DIRECT_ENTRY_SOURCE_ID;
  business_date: string;
  recruited_count: 1;
  first_work_date: string;
  entry_id: string;
  submission_id: string;
  cutoff_date: string;
}

/** Hard-coded cutover. Mirrors the SQL cutoff function. */
export function isAfterCutoff(date: string): boolean {
  return date >= P2_W04A_CUTOVER_DATE;
}

/** True when a date is strictly before the cutover. */
export function isBeforeCutoff(date: string): boolean {
  return date < P2_W04A_CUTOVER_DATE;
}

/**
 * Mask legacy facts to business_date < cutoff. Caller is responsible for
 * having already filtered facts to the legacy aggregate; this only applies
 * the date mask.
 */
export function maskLegacyFacts(futures: ReportingFact[]): ReportingFact[] {
  return futures.filter((f) => isBeforeCutoff(f.business_date));
}

/**
 * Mask Direct Entry projection facts to first_work_date >= cutoff. The
 * SQL projection already applies the date mask, but applying it again
 * here protects the read path against an accidentally-misconfigured
 * service role or a stale view definition.
 */
export function maskDirectEntryFacts(
  futures: DirectEntryReportingFact[],
): DirectEntryReportingFact[] {
  return futures.filter((f) => isAfterCutoff(f.first_work_date));
}

/**
 * Hard-fail check: an eligible Direct Entry row has first_work_date < cutoff.
 * Returns the offending row count (0 = OK, >0 = blocker).
 */
export function detectCutoverBlocker(
  directEntryFacts: DirectEntryReportingFact[],
): number {
  let blocker = 0;
  for (const f of directEntryFacts) {
    if (isBeforeCutoff(f.first_work_date)) blocker += 1;
  }
  return blocker;
}

/**
 * Build a CutoverReconciliation from raw legacy + Direct Entry fact rows.
 * The caller passes already-masked facts (legacy < cutoff, DE >= cutoff). The
 * `overlap_blocker` is computed against the un-masked DE set so the
 * hard-fail check survives even when the SQL view is silently bypassed.
 */
export function buildReconciliation(params: {
  legacyFacts: ReportingFact[];
  directEntryFactsRaw: DirectEntryReportingFact[]; // un-masked; includes potential pre-cutoff rows
}): CutoverReconciliation {
  const maskedLegacy = maskLegacyFacts(params.legacyFacts);
  const maskedDirectEntry = maskDirectEntryFacts(params.directEntryFactsRaw);

  const legacy_subtotal = maskedLegacy.reduce(
    (a, f) => a + f.recruited_count,
    0,
  );
  const direct_entry_subtotal = maskedDirectEntry.length;
  const overlap_blocker = detectCutoverBlocker(params.directEntryFactsRaw);
  return {
    legacy_subtotal,
    direct_entry_subtotal,
    combined_total: legacy_subtotal + direct_entry_subtotal,
    overlap_blocker,
    cutoff_date: P2_W04A_CUTOVER_DATE,
  };
}

/** True when the reconciliation must hard-fail cutover. */
export function hasCutoverBlocker(r: CutoverReconciliation): boolean {
  return r.overlap_blocker > 0;
}

/**
 * Combine legacy masked facts + Direct Entry masked facts into one
 * ReportingFact array, deduplicated by full ReportingFact grain.
 *
 * Legacy facts keep their `source_id` from data_sources. Direct Entry facts
 * use the synthetic DE source id. The synthetic source is appended to the
 * sources list at the seam so the existing `computeReporting` semantics
 * treat DE rows as in-scope.
 */
export function combineReportingFacts(
  legacyFacts: ReportingFact[],
  directEntryFacts: DirectEntryReportingFact[],
): ReportingFact[] {
  const seen = new Set<string>();
  const out: ReportingFact[] = [];
  for (const f of legacyFacts) {
    const key = factGrainKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  for (const f of directEntryFacts) {
    const fwd = f as unknown as ReportingFact;
    const key = factGrainKey(fwd);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fwd);
  }
  return out;
}

function factGrainKey(f: ReportingFact): string {
  return [
    f.source_id,
    f.business_date,
    f.project_key,
    f.recruiter_key,
    f.provider_type_key,
    f.employment_type_key,
  ].join("|");
}

/**
 * Construct the cutover blocker error object. Always uses the locked error
 * code so the dashboard and tests can match it.
 */
export function cutoverBlockerError(r: CutoverReconciliation): {
  ok: false;
  code: string;
  message: string;
  reconciliation: CutoverReconciliation;
} {
  return {
    ok: false,
    code: P2_W04A_CUTOVER_BLOCKER_CODE,
    message:
      `Cutover blocker: ${r.overlap_blocker} eligible Direct Entry row(s) have ` +
      `first_work_date < ${P2_W04A_CUTOVER_DATE}. ` +
      "Cutover must not proceed. Investigate submissions/entries and re-key dates.",
    reconciliation: r,
  };
}

/**
 * Read-only reconciliation helper exposed for the offline reconciliation
 * script and the test harness. Accepts the SQL reconciliation row shape and
 * normalizes bigints to numbers.
 */
export function normalizeReconciliationRow(row: {
  legacy_subtotal: bigint | number | string;
  direct_entry_subtotal: bigint | number | string;
  overlap_blocker: bigint | number | string;
  cutoff_date: string;
}): CutoverReconciliation {
  const legacy = Number(row.legacy_subtotal);
  const direct = Number(row.direct_entry_subtotal);
  const overlap = Number(row.overlap_blocker);
  return {
    legacy_subtotal: legacy,
    direct_entry_subtotal: direct,
    overlap_blocker: overlap,
    combined_total: legacy + direct,
    cutoff_date: row.cutoff_date,
  };
}