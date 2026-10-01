import type { ReportingFilters } from "./p1-filter";

export type RunStatus = "running" | "succeeded" | "partial" | "failed";

/** Source sau khi join latest run status (đầu vào của read-model). */
export interface ReportingSource {
  id: string;
  drive_file_id: string;
  active: boolean;
  is_test: boolean;
  latest_run_status: RunStatus | null;
  last_successful_sync_at: string | null;
  last_seen_at: string | null;
}

/** Fact của snapshot hiện hành (có cả key và display). */
export interface ReportingFact {
  source_id: string;
  business_date: string;
  project_key: string;
  project_display: string;
  recruiter_key: string;
  recruiter_display: string;
  provider_type_key: string;
  provider_type_display: string;
  employment_type_key: string;
  employment_type_display: string;
  recruited_count: number;
}

export type ReportingSourceStatus = "covered" | "incomplete" | "stale_snapshot" | "never_succeeded" | "no_run";

export interface ReportingSourceStatusRow {
  id: string;
  drive_file_id: string;
  latestRunStatus: RunStatus | null;
  lastSuccessfulSyncAt: string | null;
  lastSeenAt: string | null;
  contributes: boolean;
  status: ReportingSourceStatus;
}

export interface ReportingCoverage {
  expected: number;
  succeeded: number;
  partial: number;
  failed: number;
  neverSucceeded: number;
  coverageRatio: number | null;
}

export interface ReportingData {
  applied: ReportingFilters;
  recruitedTotal: number;
  byDate: Record<string, number>;
  byProject: Record<string, number>;
  byRecruiter: Record<string, number>;
  byProvider: Record<string, number>;
  byEmployment: Record<string, number>;
  coverage: ReportingCoverage;
  sources: ReportingSourceStatusRow[];
  dateExtent: { min: string | null; max: string | null };
  empty: { noSources: boolean; noFacts: boolean };
}

export const REPORTING_QUERY_FAILED_CODE = "REPORTING_QUERY_FAILED";
export const REPORTING_QUERY_FAILED_MESSAGE =
  "Không tải được dữ liệu báo cáo. Đây không phải trạng thái không có dữ liệu.";

export type ReportingComputeResult =
  | { ok: true; data: ReportingData }
  | { ok: false; code: string; message: string };

/** Kết quả lỗi query — KHÔNG bao giờ là dữ liệu với số 0. */
export function reportingQueryFailed(): { ok: false; code: string; message: string } {
  return { ok: false, code: REPORTING_QUERY_FAILED_CODE, message: REPORTING_QUERY_FAILED_MESSAGE };
}

function groupBy(rows: ReportingFact[], key: keyof ReportingFact): Record<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const k = String(row[key]);
    map.set(k, (map.get(k) ?? 0) + row.recruited_count);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/**
 * Read-model thuần cho reporting BoD P1 (contract p1-reporting/0.1).
 *
 * - Scope = active=true AND is_test=false.
 * - Facts được lọc theo scope + date + dimension + source (AND).
 * - Sum recruited_count (không đếm dòng aggregate).
 */
export function computeReporting(
  sources: ReportingSource[],
  facts: ReportingFact[],
  filters: ReportingFilters
): ReportingData {
  const scope = sources.filter((s) => s.active && !s.is_test);
  const scopeIds = new Set(scope.map((s) => s.id));

  const scopeFacts = facts.filter((f) => scopeIds.has(f.source_id));

  let rows = scopeFacts;
  if (filters.source) rows = rows.filter((f) => f.source_id === filters.source);
  if (filters.from) rows = rows.filter((f) => f.business_date >= filters.from!);
  if (filters.to) rows = rows.filter((f) => f.business_date <= filters.to!);
  if (filters.project) rows = rows.filter((f) => f.project_key === filters.project);
  if (filters.recruiter) rows = rows.filter((f) => f.recruiter_key === filters.recruiter);
  if (filters.provider) rows = rows.filter((f) => f.provider_type_key === filters.provider);
  if (filters.employment) rows = rows.filter((f) => f.employment_type_key === filters.employment);

  const recruitedTotal = rows.reduce((a, r) => a + r.recruited_count, 0);

  const succeeded = scope.filter((s) => s.latest_run_status === "succeeded").length;
  const partial = scope.filter((s) => s.latest_run_status === "partial").length;
  const failed = scope.filter((s) => s.latest_run_status === "failed").length;
  const neverSucceeded = scope.filter((s) => s.last_successful_sync_at === null).length;
  const coverageRatio = scope.length === 0 ? null : (scope.length - neverSucceeded) / scope.length;

  // contributes = đã từng có snapshot (last_successful_sync_at khác null), không phụ thuộc filter.
  const sourceRows: ReportingSourceStatusRow[] = scope.map((s) => {
    const contributes = s.last_successful_sync_at !== null;
    let status: ReportingSourceStatus;
    if (s.latest_run_status === "succeeded") status = "covered";
    else if (s.latest_run_status === "partial") status = "incomplete";
    else if (s.latest_run_status === "failed") status = contributes ? "stale_snapshot" : "never_succeeded";
    else status = contributes ? "stale_snapshot" : "no_run";
    return {
      id: s.id,
      drive_file_id: s.drive_file_id,
      latestRunStatus: s.latest_run_status,
      lastSuccessfulSyncAt: s.last_successful_sync_at,
      lastSeenAt: s.last_seen_at,
      contributes,
      status,
    };
  });

  let minDate: string | null = null;
  let maxDate: string | null = null;
  for (const f of scopeFacts) {
    if (minDate === null || f.business_date < minDate) minDate = f.business_date;
    if (maxDate === null || f.business_date > maxDate) maxDate = f.business_date;
  }

  return {
    applied: filters,
    recruitedTotal,
    byDate: groupBy(rows, "business_date"),
    byProject: groupBy(rows, "project_display"),
    byRecruiter: groupBy(rows, "recruiter_display"),
    byProvider: groupBy(rows, "provider_type_display"),
    byEmployment: groupBy(rows, "employment_type_display"),
    coverage: { expected: scope.length, succeeded, partial, failed, neverSucceeded, coverageRatio },
    sources: sourceRows,
    dateExtent: { min: minDate, max: maxDate },
    empty: { noSources: scope.length === 0, noFacts: scope.length > 0 && rows.length === 0 },
  };
}
