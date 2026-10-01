import "server-only";

import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { buildSourceOptions } from "./p1-dashboard";
import type { ReportingOptionsCatalog } from "./p1-dashboard";
import { buildDimensionOptions, reportingQueryFailed } from "./p1-reporting";
import type { DimensionOptionRow } from "./p1-reporting";
import { paginateAll, REPORTING_PAGE_SIZE } from "./p1-reporting-pagination";

export type ReportingOptionsResult =
  | { ok: true; options: ReportingOptionsCatalog }
  | { ok: false; code: string; message: string };

const OPTION_ORDER = ["dimension", "key", "display"] as const;

/**
 * Danh mục filter (project/recruiter/provider/employment/source) cho dashboard.
 *
 * - Dimension options đọc từ view reporting_dimension_options_v01 (scope đã lọc ở DB),
 *   phân trang đầy đủ + exact count (không truncate).
 * - Source options lấy từ toàn reporting scope, hiển thị file_name.
 * - KHÔNG phụ thuộc kết quả đã filter (luôn trả catalog đầy đủ).
 */
export async function fetchReportingOptions(): Promise<ReportingOptionsResult> {
  try {
    const sb = createServiceSupabaseClient();

    const sourcesRes = await sb
      .from("data_sources")
      .select("id, file_name")
      .eq("active", true)
      .eq("is_test", false);
    if (sourcesRes.error) throw sourcesRes.error;
    const sources = (sourcesRes.data ?? []) as { id: string; file_name: string }[];

    let q = sb
      .from("reporting_dimension_options_v01")
      .select("dimension, key, display, recruited_count", { count: "exact" });
    for (const col of OPTION_ORDER) q = q.order(col);

    const paged = await paginateAll<DimensionOptionRow>(async ([from, to]) => {
      const res = await q.range(from, to);
      if (res.error) {
        return { rows: [], count: null, error: { code: res.error.code, message: res.error.message } };
      }
      return { rows: (res.data ?? []) as DimensionOptionRow[], count: res.count ?? null };
    }, { pageSize: REPORTING_PAGE_SIZE });
    if (!paged.ok) return paged;

    return {
      ok: true,
      options: {
        dimensions: buildDimensionOptions(paged.rows),
        sources: buildSourceOptions(sources),
      },
    };
  } catch (error) {
    const safeCode =
      error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code)
        : "unknown";
    console.error("[p1-options] query failed. code=" + safeCode);
    return reportingQueryFailed();
  }
}
