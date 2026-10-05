import "server-only";

import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { buildSourceOptions } from "./p1-dashboard";
import type { ReportingOptionsCatalog } from "./p1-dashboard";
import { buildDimensionOptions } from "./p1-reporting";
import type { DimensionOptionRow } from "./p1-reporting";
import { paginateAll, REPORTING_PAGE_SIZE } from "./p1-reporting-pagination";
import { P2_W04A_CUTOVER_FAILED_CODE } from "./p2-w04a-cutover";

/**
 * P2-W04A — Direct Entry cutover dimension options.
 *
 * The legacy `fetchReportingOptions` only reads the legacy dimension
 * view (`reporting_dimension_options_v01`). After cutover, project /
 * recruiter / provider / employment values that exist ONLY in Direct
 * Entry (no legacy aggregate) would silently disappear from the filter
 * catalog, leaving the dashboard unable to filter on them.
 *
 * This module unions the legacy dimension view with the new
 * `direct_entry_reporting_dimension_options_v01` (DE-side rows). The
 * union is fed through the existing `buildDimensionOptions` so the
 * Display / sentinel / tie-break rules stay byte-equivalent to the P1
 * catalog.
 *
 * - Reuses `buildDimensionOptions` (no new filter framework).
 * - No N+1: the two views are queried in parallel inside `paginateAll`,
 *   each with full pagination and exact count.
 * - Option identity = ReportingFact dimension key; `buildDimensionOptions`
 *   groups by (dimension, key), so legacy and DE rows for the SAME key
 *   collapse to one option with the canonical display.
 * - Source options are unchanged (legacy source registry only — DE is
 *   synthetic and intentionally not in the source filter).
 * - Source/status UI is locked out (R0 cleanup); this module does NOT
 *   re-introduce any source-scope filter UI.
 */

export type CutoverOptionsResult =
  | { ok: true; options: ReportingOptionsCatalog }
  | { ok: false; code: string; message: string };

const OPTION_ORDER = ["dimension", "key", "display"] as const;

function logSafeError(prefix: string, error: unknown) {
  const safeCode =
    error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : "unknown";
  console.error(`[${prefix}] query failed. code=${safeCode}`);
}

async function paginateDimensionView(
  sb: ReturnType<typeof createServiceSupabaseClient>,
  view: "reporting_dimension_options_v01" | "direct_entry_reporting_dimension_options_v01",
): Promise<{ rows: DimensionOptionRow[] } | { error: { code: string; message: string } }> {
  let q = sb.from(view).select("dimension, key, display, recruited_count", { count: "exact" });
  for (const col of OPTION_ORDER) q = q.order(col);

  const paged = await paginateAll<DimensionOptionRow>(async ([from, to]) => {
    const res = await q.range(from, to);
    if (res.error) {
      return { rows: [], count: null, error: { code: res.error.code, message: res.error.message } };
    }
    return { rows: (res.data ?? []) as DimensionOptionRow[], count: res.count ?? null };
  }, { pageSize: REPORTING_PAGE_SIZE });
  if (!paged.ok) return { error: { code: paged.code, message: paged.message } };
  return { rows: paged.rows };
}

/**
 * Read the cutover options catalog: legacy options ∪ Direct Entry options.
 *
 * Returns the same `ReportingOptionsCatalog` shape P1 used, so the
 * dashboard's filter UI and option parsing keep working unchanged.
 *
 * Source options: legacy `data_sources` only. The synthetic DE source is
 * not exposed as a filter entry (the dashboard has no source-scope UI
 * by R0 contract; exposing a fake source would be misleading).
 */
export async function fetchCutoverReportingOptions(): Promise<CutoverOptionsResult> {
  try {
    const sb = createServiceSupabaseClient();

    // Run both view reads and the source registry read in parallel.
    const [legacyRes, deRes, sourcesRes] = await Promise.all([
      paginateDimensionView(sb, "reporting_dimension_options_v01"),
      paginateDimensionView(sb, "direct_entry_reporting_dimension_options_v01"),
      sb
        .from("data_sources")
        .select("id, file_name")
        .eq("active", true)
        .eq("is_test", false),
    ]);

    if ("error" in legacyRes) {
      return { ok: false, code: legacyRes.error.code, message: legacyRes.error.message };
    }
    if ("error" in deRes) {
      return { ok: false, code: deRes.error.code, message: deRes.error.message };
    }
    if (sourcesRes.error) {
      return { ok: false, code: sourcesRes.error.code, message: sourcesRes.error.message };
    }

    const sources = (sourcesRes.data ?? []) as { id: string; file_name: string }[];

    // Union the two option sets; buildDimensionOptions groups by
    // (dimension, key) and selects display by the canonical rule, so
    // duplicate keys across legacy + DE collapse to one option whose
    // display is the winner (max recruited_count sum; tie => localeCompare).
    const merged: DimensionOptionRow[] = [...legacyRes.rows, ...deRes.rows];
    return {
      ok: true,
      options: {
        dimensions: buildDimensionOptions(merged),
        sources: buildSourceOptions(sources),
      },
    };
  } catch (error) {
    logSafeError("p2-w04a-cutover-options", error);
    return { ok: false, code: P2_W04A_CUTOVER_FAILED_CODE, message: "Cutover options read path failed." };
  }
}
