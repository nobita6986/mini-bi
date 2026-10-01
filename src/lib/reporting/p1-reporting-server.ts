import "server-only";

import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { parseReportingFilters } from "./p1-filter";
import { computeReporting, reportingQueryFailed } from "./p1-reporting";
import type { ReportingData, ReportingFact, ReportingSource, RunStatus } from "./p1-reporting";

export type ReportingFetchResult =
  | { ok: true; data: ReportingData; generatedAt: string }
  | { ok: false; code: string; message: string };

/**
 * Data access server-only cho reporting BoD P1 (contract p1-reporting/0.1).
 *
 * - CHỈ đọc data_sources + sync_runs + daily_recruitment_breakdown.
 * - Scope lọc ở DB (không tải fixture ra khỏi DB); date/dimension filter trong read-model TS.
 *   Ngưỡng chuyển aggregation xuống SQL/RPC: khi tổng scope facts > ~10k dòng hoặc filter latency đo được > 200ms (P2).
 * - KHÔNG tạo page/API public. P1-W03 phải gate trước khi gọi hàm này.
 * - KHÔNG đọc/trả PII.
 */
export async function fetchReporting(
  params: Record<string, string | string[] | undefined>
): Promise<ReportingFetchResult> {
  try {
    const sb = createServiceSupabaseClient();

    const [sourcesRes, runsRes] = await Promise.all([
      sb
        .from("data_sources")
        .select("id, drive_file_id, active, is_test, last_seen_at, last_successful_sync_at"),
      sb.from("sync_runs").select("source_id, status").order("started_at", { ascending: false }).limit(5000),
    ]);
    const firstErr = [sourcesRes, runsRes].map((r) => r.error).find((e) => e);
    if (firstErr) throw firstErr;

    const latestBySource = new Map<string, RunStatus>();
    for (const r of (runsRes.data ?? []) as { source_id: string; status: RunStatus }[]) {
      if (!latestBySource.has(r.source_id)) latestBySource.set(r.source_id, r.status);
    }

    const rawSources = (sourcesRes.data ?? []) as Omit<ReportingSource, "latest_run_status">[];
    const sources: ReportingSource[] = rawSources.map((s) => ({
      ...s,
      latest_run_status: latestBySource.get(s.id) ?? null,
    }));

    const scopeIds = new Set(sources.filter((s) => s.active && !s.is_test).map((s) => s.id));

    const parsed = parseReportingFilters(params, scopeIds);
    if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };

    // Lọc scope ở DB trước (không tải dữ liệu ngoài reporting scope).
    let query = sb
      .from("daily_recruitment_breakdown")
      .select(
        "source_id, business_date, project_key, project_display, recruiter_key, recruiter_display, provider_type_key, provider_type_display, employment_type_key, employment_type_display, recruited_count"
      );
    if (scopeIds.size > 0) {
      query = query.in("source_id", Array.from(scopeIds));
    }
    const factsRes = await query;
    if (factsRes.error) throw factsRes.error;

    const facts = (factsRes.data ?? []) as ReportingFact[];
    const data = computeReporting(sources, facts, parsed.filters);
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
