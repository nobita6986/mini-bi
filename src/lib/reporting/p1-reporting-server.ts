import "server-only";

import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { parseReportingFilters } from "./p1-filter";
import {
  buildReportingFactQuery,
  computeReporting,
  reportingQueryFailed,
} from "./p1-reporting";
import type { ReportingData, ReportingFact, ReportingSource, RunStatus } from "./p1-reporting";
import { paginateAll, REPORTING_FACT_ORDER, REPORTING_PAGE_SIZE } from "./p1-reporting-pagination";

export type ReportingFetchResult =
  | { ok: true; data: ReportingData; generatedAt: string }
  | { ok: false; code: string; message: string };

const FACT_COLUMNS =
  "source_id, business_date, project_key, project_display, recruiter_key, recruiter_display, provider_type_key, provider_type_display, employment_type_key, employment_type_display, recruited_count";

/**
 * Data access server-only cho reporting BoD P1 (contract p1-reporting/0.1).
 *
 * - Source query ngay ở DB bằng active=true AND is_test=false (không tải fixture metadata).
 * - Presence từ view reporting_sources_with_current_facts_v01 (DISTINCT source_id, service-role-only).
 * - Latest run từ view reporting_latest_sync_runs_v01 (deterministic, service-role-only).
 * - Fact query phân trang đầy đủ (page <= 1000) + kiểm tra exact count; không silent truncate.
 * - Scope rỗng => không query presence/facts, trả empty state hợp lệ (coverageRatio=null).
 * - KHÔNG tạo page/API public. P1-W03 phải gate trước khi gọi hàm này. KHÔNG đọc/trả PII.
 */
export async function fetchReporting(
  params: Record<string, string | string[] | undefined>
): Promise<ReportingFetchResult> {
  try {
    const sb = createServiceSupabaseClient();

    // 1. Sources: chỉ reporting scope (active && !is_test) — không tải fixture.
    const sourcesRes = await sb
      .from("data_sources")
      .select("id, drive_file_id, active, is_test, last_seen_at, last_successful_sync_at")
      .eq("active", true)
      .eq("is_test", false);
    if (sourcesRes.error) throw sourcesRes.error;

    const rawSources = (sourcesRes.data ?? []) as Omit<ReportingSource, "latest_run_status">[];
    const scopeIds = new Set(rawSources.map((s) => s.id));

    const parsed = parseReportingFilters(params, scopeIds);
    if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };

    if (scopeIds.size === 0) {
      return {
        ok: true,
        data: computeReporting([], [], parsed.filters, new Set()),
        generatedAt: new Date().toISOString(),
      };
    }

    const scopeIdArray = Array.from(scopeIds);

    // 2. Latest run chính xác cho mỗi source trong scope (view service-role-only).
    const runsRes = await sb
      .from("reporting_latest_sync_runs_v01")
      .select("source_id, status")
      .in("source_id", scopeIdArray);
    if (runsRes.error) throw runsRes.error;

    const latestBySource = new Map<string, RunStatus>();
    for (const r of (runsRes.data ?? []) as { source_id: string; status: RunStatus }[]) {
      latestBySource.set(r.source_id, r.status);
    }

    const sources: ReportingSource[] = rawSources.map((s) => ({
      ...s,
      latest_run_status: latestBySource.get(s.id) ?? null,
    }));

    // 3. Presence từ view (DISTINCT source_id, data-minimal: chỉ UUID).
    const presenceRes = await sb
      .from("reporting_sources_with_current_facts_v01")
      .select("source_id")
      .in("source_id", scopeIdArray);
    if (presenceRes.error) throw presenceRes.error;
    const sourcesWithFacts = new Set<string>((presenceRes.data ?? []).map((r) => r.source_id));

    // 4. Metric facts: lọc scope + source + date + dimensions + order ổn định ở DB.
    const plan = buildReportingFactQuery(parsed.filters, scopeIds);
    let q = sb
      .from("daily_recruitment_breakdown")
      .select(FACT_COLUMNS, { count: "exact" })
      .in("source_id", plan.query.scopeIds);
    if (plan.query.source) q = q.eq("source_id", plan.query.source);
    if (plan.query.from) q = q.gte("business_date", plan.query.from);
    if (plan.query.to) q = q.lte("business_date", plan.query.to);
    if (plan.query.project) q = q.eq("project_key", plan.query.project);
    if (plan.query.recruiter) q = q.eq("recruiter_key", plan.query.recruiter);
    if (plan.query.provider) q = q.eq("provider_type_key", plan.query.provider);
    if (plan.query.employment) q = q.eq("employment_type_key", plan.query.employment);
    for (const col of REPORTING_FACT_ORDER) q = q.order(col);

    const paged = await paginateAll<ReportingFact>(async ([from, to]) => {
      const res = await q.range(from, to);
      if (res.error) {
        return { rows: [], count: null, error: { code: res.error.code, message: res.error.message } };
      }
      return { rows: (res.data ?? []) as ReportingFact[], count: res.count ?? null };
    }, { pageSize: REPORTING_PAGE_SIZE });
    if (!paged.ok) return paged;

    const data = computeReporting(sources, paged.rows, parsed.filters, sourcesWithFacts);
    return { ok: true, data, generatedAt: new Date().toISOString() };
  } catch (error) {
    // Chỉ log mã lỗi (an toàn); không log message/credential/URL/payload.
    const safeCode =
      error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code)
        : "unknown";
    console.error("[p1-reporting] query failed. code=" + safeCode);
    return reportingQueryFailed();
  }
}
