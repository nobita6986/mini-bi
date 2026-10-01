import "server-only";

import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { computePipelineData } from "./pipeline-check";
import type {
  BreakdownRow,
  ErrorRow,
  PipelineCheckData,
  RunRow,
  SourceRow,
} from "./pipeline-check";
import { sanitizePipelineError } from "./pipeline-check-safety";

export type PipelineCheckResult =
  | { ok: true; data: PipelineCheckData; generatedAt: string }
  | { ok: false; code: string; message: string };

/**
 * Đọc dữ liệu vận hành từ Supabase (server-only, dùng service-role key).
 *
 * CHỈ đọc 4 bảng: data_sources, sync_runs, sync_errors, daily_recruitment_breakdown.
 * KHÔNG đọc/hiển thị dữ liệu ứng viên hay PII. KHÔNG ghi dữ liệu.
 *
 * Khi lỗi: KHÔNG trả raw provider message ra UI — chỉ trả code + thông báo ổn định.
 */
export async function fetchPipelineCheck(): Promise<PipelineCheckResult> {
  try {
    const sb = createServiceSupabaseClient();

    const [sourcesRes, runsRes, breakdownRes, errorsRes] = await Promise.all([
      sb
        .from("data_sources")
        .select("id, drive_file_id, file_name, sheet_name, active, first_seen_at, last_seen_at, last_successful_sync_at")
        .order("created_at", { ascending: true }),
      sb
        .from("sync_runs")
        .select("run_id, source_id, status, started_at, finished_at, rows_read, rows_valid, rows_rejected, rows_warned, warning_issues, error_code")
        .order("started_at", { ascending: false }),
      sb
        .from("daily_recruitment_breakdown")
        .select("source_id, business_date, project_display, recruiter_display, provider_type_display, employment_type_display, recruited_count"),
      sb
        .from("sync_errors")
        .select("source_id, source_row_number, issue_level, error_code, created_at")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    const firstError = [sourcesRes, runsRes, breakdownRes, errorsRes].map((r) => r.error).find((e) => e);
    if (firstError) {
      throw firstError;
    }

    const data = computePipelineData(
      (sourcesRes.data as SourceRow[] | null) ?? [],
      (runsRes.data as RunRow[] | null) ?? [],
      (breakdownRes.data as BreakdownRow[] | null) ?? [],
      (errorsRes.data as ErrorRow[] | null) ?? []
    );

    return { ok: true, data, generatedAt: new Date().toISOString() };
  } catch (error) {
    // Chỉ log mã lỗi (an toàn) để chẩn đoán server-side. KHÔNG log message,
    // credential, authorization header, URL chứa secret hay payload nhạy cảm.
    const safeCode =
      error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code)
        : "unknown";
    console.error("[pipeline-check] query failed. code=" + safeCode);
    return { ok: false, ...sanitizePipelineError() };
  }
}
