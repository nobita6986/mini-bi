/**
 * Read-model thuần (không có I/O) cho trang pipeline-check.
 *
 * Tách riêng khỏi phần fetch server để có thể unit-test các trạng thái (trống,
 * partial, failed...) mà không cần database. P1 có thể tái sử dụng.
 *
 * KHÔNG chứa và KHÔNG hiển thị dữ liệu cá nhân ứng viên. Chỉ đọc các bảng
 * data_sources, sync_runs, sync_errors, daily_recruitment_breakdown.
 */

export type RunStatus = "running" | "succeeded" | "partial" | "failed";
export type IssueLevel = "error" | "warning";

export interface SourceRow {
  id: string;
  drive_file_id: string;
  file_name: string;
  sheet_name: string;
  active: boolean;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_successful_sync_at: string | null;
}

export interface RunRow {
  run_id: string;
  source_id: string;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  rows_read: number;
  rows_valid: number;
  rows_rejected: number;
  rows_warned: number;
  warning_issues: number;
  error_code: string | null;
}

export interface BreakdownRow {
  source_id: string;
  business_date: string;
  project_display: string;
  recruiter_display: string;
  provider_type_display: string;
  employment_type_display: string;
  recruited_count: number;
}

export interface ErrorRow {
  source_id: string;
  source_row_number: number | null;
  issue_level: IssueLevel;
  error_code: string;
  created_at: string | null;
}

export interface LatestRun {
  runId: string;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  rowsRead: number;
  rowsValid: number;
  rowsRejected: number;
  rowsWarned: number;
  warningIssues: number;
  errorCode: string | null;
}

export interface SourceStatus {
  id: string;
  driveFileId: string;
  fileName: string;
  sheetName: string;
  active: boolean;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastSuccessfulSyncAt: string | null;
  latestRun: LatestRun | null;
}

export interface DimensionBreakdown {
  label: string;
  groups: number;
  recruited: number;
}

export interface PipelineCheckData {
  overview: {
    sourcesTotal: number;
    sourcesActive: number;
    latestRunStatus: RunStatus | null;
    latestRunStartedAt: string | null;
    latestRunFinishedAt: string | null;
    latestSuccessfulSyncAt: string | null;
    totals: {
      rowsRead: number;
      rowsValid: number;
      rowsRejected: number;
      rowsWarned: number;
      warningIssues: number;
    };
  };
  sources: SourceStatus[];
  snapshot: {
    recruitedTotal: number;
    breakdownGroups: number;
    byDateSource: { businessDate: string; fileName: string; recruitedCount: number; groups: number }[];
    byProvider: DimensionBreakdown[];
    byEmployment: DimensionBreakdown[];
    byProject: DimensionBreakdown[];
    byRecruiter: DimensionBreakdown[];
  };
  issues: {
    fileName: string;
    driveFileId: string;
    sourceRowNumber: number | null;
    issueLevel: IssueLevel;
    errorCode: string;
    createdAt: string | null;
  }[];
}

const EMPTY_TOTALS = { rowsRead: 0, rowsValid: 0, rowsRejected: 0, rowsWarned: 0, warningIssues: 0 };

export function computePipelineData(
  sources: SourceRow[],
  runs: RunRow[],
  breakdown: BreakdownRow[],
  errors: ErrorRow[]
): PipelineCheckData {
  const sourceById = new Map<string, SourceRow>(sources.map((s) => [s.id, s]));

  // runs đã được sắp theo started_at giảm dần => lần đầu tiên gặp mỗi source là mới nhất.
  const latestBySource = new Map<string, RunRow>();
  for (const run of runs) {
    if (!latestBySource.has(run.source_id)) latestBySource.set(run.source_id, run);
  }

  const toLatestRun = (sourceId: string): LatestRun | null => {
    const run = latestBySource.get(sourceId);
    if (!run) return null;
    return {
      runId: run.run_id,
      status: run.status,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      rowsRead: run.rows_read,
      rowsValid: run.rows_valid,
      rowsRejected: run.rows_rejected,
      rowsWarned: run.rows_warned,
      warningIssues: run.warning_issues,
      errorCode: run.error_code,
    };
  };

  const sourceStatuses: SourceStatus[] = sources.map((s) => ({
    id: s.id,
    driveFileId: s.drive_file_id,
    fileName: s.file_name,
    sheetName: s.sheet_name,
    active: s.active,
    firstSeenAt: s.first_seen_at,
    lastSeenAt: s.last_seen_at,
    lastSuccessfulSyncAt: s.last_successful_sync_at,
    latestRun: toLatestRun(s.id),
  }));

  const totals = sources.reduce((acc, s) => {
    const run = latestBySource.get(s.id);
    if (!run) return acc;
    acc.rowsRead += run.rows_read;
    acc.rowsValid += run.rows_valid;
    acc.rowsRejected += run.rows_rejected;
    acc.rowsWarned += run.rows_warned;
    acc.warningIssues += run.warning_issues;
    return acc;
  }, { ...EMPTY_TOTALS });

  const overallLatestRun = runs[0] ?? null;
  let latestSuccessfulSyncAt: string | null = null;
  for (const s of sources) {
    if (s.last_successful_sync_at && (!latestSuccessfulSyncAt || s.last_successful_sync_at > latestSuccessfulSyncAt)) {
      latestSuccessfulSyncAt = s.last_successful_sync_at;
    }
  }

  const recruitedTotal = breakdown.reduce((sum, r) => sum + r.recruited_count, 0);

  const dateSourceMap = new Map<string, { businessDate: string; fileName: string; recruitedCount: number; groups: number }>();
  for (const r of breakdown) {
    const src = sourceById.get(r.source_id);
    const key = r.business_date + "|" + r.source_id;
    let row = dateSourceMap.get(key);
    if (!row) {
      row = { businessDate: r.business_date, fileName: src ? src.file_name : "(đã xóa)", recruitedCount: 0, groups: 0 };
      dateSourceMap.set(key, row);
    }
    row.recruitedCount += r.recruited_count;
    row.groups += 1;
  }
  const byDateSource = Array.from(dateSourceMap.values()).sort((a, b) =>
    a.businessDate < b.businessDate ? -1 : a.businessDate > b.businessDate ? 1 : a.fileName.localeCompare(b.fileName)
  );

  const dimension = (key: "project_display" | "recruiter_display" | "provider_type_display" | "employment_type_display"): DimensionBreakdown[] => {
    const map = new Map<string, { groups: number; recruited: number }>();
    for (const r of breakdown) {
      const label = r[key];
      const cur = map.get(label) ?? { groups: 0, recruited: 0 };
      cur.groups += 1;
      cur.recruited += r.recruited_count;
      map.set(label, cur);
    }
    return Array.from(map.entries())
      .map(([label, v]) => ({ label, groups: v.groups, recruited: v.recruited }))
      .sort((a, b) => b.recruited - a.recruited || a.label.localeCompare(b.label));
  };

  const issues = errors.map((e) => {
    const src = sourceById.get(e.source_id);
    return {
      fileName: src ? src.file_name : "(đã xóa)",
      driveFileId: src ? src.drive_file_id : "",
      sourceRowNumber: e.source_row_number,
      issueLevel: e.issue_level,
      errorCode: e.error_code,
      createdAt: e.created_at,
    };
  });

  return {
    overview: {
      sourcesTotal: sources.length,
      sourcesActive: sources.filter((s) => s.active).length,
      latestRunStatus: overallLatestRun ? overallLatestRun.status : null,
      latestRunStartedAt: overallLatestRun ? overallLatestRun.started_at : null,
      latestRunFinishedAt: overallLatestRun ? overallLatestRun.finished_at : null,
      latestSuccessfulSyncAt,
      totals,
    },
    sources: sourceStatuses,
    snapshot: {
      recruitedTotal,
      breakdownGroups: breakdown.length,
      byDateSource,
      byProvider: dimension("provider_type_display"),
      byEmployment: dimension("employment_type_display"),
      byProject: dimension("project_display").slice(0, 10),
      byRecruiter: dimension("recruiter_display").slice(0, 10),
    },
    issues,
  };
}
