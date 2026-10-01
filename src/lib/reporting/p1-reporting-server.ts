import "server-only";

import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { parseReportingFilters } from "./p1-filter";
import { buildReportingFactQuery, computeReporting, reportingQueryFailed } from "./p1-reporting";
import type { ReportingData, ReportingFact, ReportingSource, RunStatus } from "./p1-reporting";

export type ReportingFetchResult =
  | { ok: true; data: ReportingData; generatedAt: string }
  | { ok: false; code: string; message: string };

const FACT_COLUMNS =
  "source_id, business_date, project_key, project_display, recruiter_key, recruiter_display, provider_type_key, provider_type_display, employment_type_key, employment_type_display, recruited_count";

/**
 * Data access server-only cho reporting BoD P1 (contract p1-reporting/0.1).
 *
 * - Source query ngay ở DB bằng active=true AND is_test=false (không tải fixture metadata).
 * - Latest run lấy từ view reporting_latest_sync_runs_v01 (service-role-only, deterministic
 *   started_at DESC, run_id DESC) — không dùng .limit() trên lịch sử.
 * - Fact query lọc scope + source + date + dimensions ngay ở DB; read-model chỉ validate lại.
 * - Scope rỗng => không query facts, trả empty state hợp lệ (coverageRatio=null).
 * - KHÔNG tạo page/API public. P1-W03 phải gate trước khi gọi hàm này.
 * - KHÔNG đọc/trả PII.
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

    // 3. Presence: distinct source_id có fact trong scope (data-minimal: chỉ UUID).
    const presenceRes = await sb
      .from("daily_recruitment_breakdown")
      .select("source_id")
      .in("source_id", scopeIdArray);
    if (presenceRes.error) throw presenceRes.error;
    const sourcesWithFacts = new Set<string>((presenceRes.data ?? []).map((r) => r.source_id));

    // 4. Metric facts: lọc scope + source + date + dimensions ngay ở DB.
    const plan = buildReportingFactQuery(parsed.filters, scopeIds);
    let query = sb
      .from("daily_recruitment_breakdown")
      .select(FACT_COLUMNS)
      .in("source_id", plan.query.scopeIds);
    if (plan.query.source) query = query.eq("source_id", plan.query.source);
    if (plan.query.from) query = query.gte("business_date", plan.query.from);
    if (plan.query.to) query = query.lte("business_date", plan.query.to);
    if (plan.query.project) query = query.eq("project_key", plan.query.project);
    if (plan.query.recruiter) query = query.eq("recruiter_key", plan.query.recruiter);
    if (plan.query.provider) query = query.eq("provider_type_key", plan.query.provider);
    if (plan.query.employment) query = query.eq("employment_type_key", plan.query.employment);
    const factsRes = await query;
    if (factsRes.error) throw factsRes.error;

    const facts = (factsRes.data ?? []) as ReportingFact[];
    const data = computeReporting(sources, facts, parsed.filters, sourcesWithFacts);
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
