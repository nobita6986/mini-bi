"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DataTableContainer,
  DATA_TABLE_CLASS,
  DATA_TABLE_HEAD_CLASS,
  DATA_TABLE_ROW_CLASS,
  DATA_TABLE_TD_CLASS,
  DATA_TABLE_TH_CLASS,
} from "@/components/ui/data-table";
import { CursorLoadMore } from "@/components/ui/cursor-load-more";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { useNotify } from "@/components/ui/notify-provider";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  ReportReadonlyContent,
  ReportReviewHistory,
  ReportRevisionList,
} from "@/components/work-reports/reader/report-readonly-content";
import { appendUniqueContributions, contributionPageUrl } from "@/lib/work-reports/analytics-ui-model.mjs";
import {
  findCurrentRevision,
  formatReaderDateTime,
  parseReaderDetail,
  readerStateLabel,
  type ReaderDetail,
} from "@/lib/work-reports/reader-ui-model";

type Filters = {
  template_id: string;
  version_id: string;
  from: string;
  to: string;
  team_id: string;
  assignee_id: string;
};
type Finality = "final" | "provisional_included";
type Metric = {
  metric_key: string;
  label: string;
  unit: string;
  compatible_group: string;
  sum_value: number | null;
  avg_value: number | null;
  min_value: number | null;
  max_value: number | null;
  count_valid: number;
  missing_value_count: number;
};
type Compliance = {
  due_count: number;
  completed_count: number;
  on_time_count: number;
  late_submitted_count: number;
  pending_due_count: number;
  overdue_missing_count: number;
  exempted_count: number;
  pending_review_count: number;
  completion_rate: number | null;
};
type Overview = {
  effective_scope: { kind: "all" | "team"; label: string };
  compliance: Compliance;
  metrics: Metric[];
};
type GroupBy = "team" | "assignee" | "period";
type Breakdown = {
  group_id: string | null;
  group_label: string;
  due_count: number;
  completed_count: number;
  overdue_missing_count: number;
  metrics: Metric[];
};
type Contribution = {
  obligation_id: string;
  submission_id: string | null;
  revision_no: number | null;
  assignee_display_name: string;
  team_display_name: string | null;
  period_key: string;
  state: string;
  submitted_at: string | null;
  is_late: boolean;
  has_post_deadline_amendment: boolean;
  metric_contribution_value: number | null;
};

type AnalyticsFilterOptionsPayload = {
  effective_scope: { kind: "all" | "team"; label: string };
  templates: Array<{
    template_id: string;
    template_code: string;
    display_name: string;
    status: string;
    versions: Array<{
      version_id: string;
      version_no: number;
      status: string;
    }>;
  }>;
  teams: Array<{
    team_id: string;
    code: string;
    display_name: string;
  }>;
  assignees: Array<{
    app_user_id: string;
    display_name: string;
    team_ids: string[];
  }>;
};

function defaultDateRange(): { from: string; to: string } {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
  const from = /^\d{4}-\d{2}-\d{2}$/.test(today) ? `${today.slice(0, 8)}01` : "";
  return { from, to: today };
}

function createInitialFilters(): Filters {
  const { from, to } = defaultDateRange();
  return {
    template_id: "",
    version_id: "",
    from,
    to,
    team_id: "",
    assignee_id: "",
  };
}

const inputClass =
  "min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60";
const number = (value: number | null, digits = 0) =>
  value === null ? "—" : new Intl.NumberFormat("vi-VN", { maximumFractionDigits: digits }).format(value);
const dateTime = (value: string | null) =>
  value ? new Date(value).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "—";

async function getData<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true || !result.data) {
    const code =
      typeof result?.code === "string"
        ? result.code
        : response.status === 403
          ? "WORK_REPORT_ACCESS_DENIED"
          : "WORK_REPORT_UNAVAILABLE";
    throw new Error(code);
  }
  return result.data as T;
}

function queryString(filters: Filters, finality: Finality) {
  const query = new URLSearchParams({ finality });
  for (const key of Object.keys(filters) as (keyof Filters)[]) {
    if (filters[key].trim()) query.set(key, filters[key].trim());
  }
  return query.toString();
}

export function WorkReportAnalytics({ canViewSubmissions = true }: { canViewSubmissions?: boolean } = {}) {
  const notify = useNotify();
  const [draft, setDraft] = useState<Filters>(createInitialFilters);
  const [filters, setFilters] = useState<Filters | null>(null);
  const [finality, setFinality] = useState<Finality>("final");
  const [groupBy, setGroupBy] = useState<GroupBy>("team");

  const [options, setOptions] = useState<AnalyticsFilterOptionsPayload | null>(null);
  const [optionsState, setOptionsState] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [optionsReloadToken, setOptionsReloadToken] = useState(0);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [rows, setRows] = useState<Breakdown[]>([]);
  const [contributions, setContributions] = useState<Contribution[] | null>(null);
  const [contributionQuery, setContributionQuery] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<ReaderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getData<AnalyticsFilterOptionsPayload>("/api/work-reports/analytics/options", controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setOptions(payload);
        setOptionsState("ready");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
        setOptions(null);
        setOptionsState(
          code === "WORK_REPORT_ACCESS_DENIED" || code === "WORK_REPORT_SCOPE_DENIED" ? "denied" : "error",
        );
      });
    return () => controller.abort();
  }, [optionsReloadToken]);

  const selectedTemplate = useMemo(
    () => options?.templates.find((tpl) => tpl.template_id === draft.template_id) ?? null,
    [options, draft.template_id],
  );

  const filteredAssignees = useMemo(() => {
    if (!options) return [];
    if (!draft.team_id) return options.assignees;
    return options.assignees.filter((assignee) => assignee.team_ids.includes(draft.team_id));
  }, [options, draft.team_id]);

  async function load(nextFilters: Filters, nextGroup: GroupBy = groupBy, nextFinality: Finality = finality) {
    if (!nextFilters.template_id.trim()) return;
    if (nextFilters.from && nextFilters.to && nextFilters.from > nextFilters.to) {
      setError("Khoảng thời gian không hợp lệ: Từ ngày không được lớn hơn Đến ngày.");
      return;
    }
    setBusy(true); setError(null); setContributions(null); setContributionQuery(null); setNextCursor(null); setEvidence(null);
    const query = queryString(nextFilters, nextFinality);
    try {
      const [summary, breakdown] = await Promise.all([
        getData<Overview>(`/api/work-reports/analytics/overview?${query}`),
        getData<{ items: Breakdown[] }>(
          `/api/work-reports/analytics/breakdown?${query}&group_by=${nextGroup}&page=1&page_size=50`,
        ),
      ]);
      setFilters(nextFilters);
      setGroupBy(nextGroup);
      setFinality(nextFinality);
      setOverview(summary);
      setRows(breakdown.items);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      setOverview(null);
      setRows([]);
      setError(
        code === "WORK_REPORT_SCOPE_DENIED" || code === "WORK_REPORT_ACCESS_DENIED"
          ? "Bộ lọc vượt quá phạm vi quyền tổng hợp báo cáo hiện hành."
          : "Không tải được dữ liệu tổng hợp. Hãy kiểm tra mẫu và bộ lọc trong phạm vi quyền hiện hành rồi thử lại.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function openContributions(metricKey?: string, row?: Breakdown) {
    if (!canViewSubmissions || !filters) return;
    const query = new URLSearchParams(queryString(filters, finality));
    if (metricKey) query.set("metric_key", metricKey);
    if (row?.group_id && groupBy === "team") query.set("target_team_id", row.group_id);
    if (row?.group_id && groupBy === "assignee") query.set("target_assignee_id", row.group_id);
    if (row?.group_id && groupBy === "period") query.set("target_period_key", row.group_id);
    setBusy(true); setError(null); setContributions(null); setContributionQuery(null); setNextCursor(null); setEvidence(null);
    try {
      const baseQuery = query.toString();
      const result = await getData<{ items: Contribution[]; next_cursor: string | null }>(contributionPageUrl(baseQuery));
      setContributions(result.items);
      setContributionQuery(baseQuery);
      setNextCursor(result.next_cursor);
    } catch {
      const msg = "Không tải được danh sách bài nộp đóng góp trong phạm vi quyền hiện hành.";
      setError(msg);
      notify.error({ title: msg });
    } finally {
      setBusy(false);
    }
  }

  async function loadMoreContributions() {
    if (!canViewSubmissions || !contributionQuery || !nextCursor) return;
    setBusy(true);
    setError(null);
    try {
      const result = await getData<{ items: Contribution[]; next_cursor: string | null }>(
        contributionPageUrl(contributionQuery, nextCursor),
      );
      setContributions((current) => (current ? appendUniqueContributions(current, result.items) : result.items));
      setNextCursor(result.next_cursor);
    } catch {
      const msg = "Không tải được trang tiếp theo. Vui lòng thử lại.";
      setError(msg);
      notify.error({ title: msg });
    } finally {
      setBusy(false);
    }
  }

  async function openEvidence(item: Contribution) {
    if (!canViewSubmissions || !item.submission_id) return;
    setBusy(true);
    setError(null);
    try {
      const raw = await getData<unknown>(`/api/work-reports/submissions/${encodeURIComponent(item.submission_id)}`);
      const parsed = parseReaderDetail({ ok: true, data: raw });
      if (!parsed) throw new Error("WORK_REPORT_RESPONSE_INVALID");
      setEvidence(parsed);
    } catch {
      const msg = "Không mở được bài nộp nguồn trong phạm vi quyền hiện hành.";
      setError(msg);
      notify.error({ title: msg });
    } finally {
      setBusy(false);
    }
  }

  function resetDraft() {
    const next = createInitialFilters();
    setDraft(next);
    setError(null);
  }

  const hasEmptyOverviewData =
    overview !== null &&
    overview.compliance.due_count === 0 &&
    overview.compliance.completed_count === 0 &&
    overview.metrics.every((metric) => metric.count_valid === 0);

  const evidencePayload = useMemo(() => {
    if (!evidence) return null;
    const rev = findCurrentRevision(evidence.revisions, evidence.submission?.current_revision_id ?? null);
    return rev?.payload_json ?? evidence.submission?.draft_payload_json ?? {};
  }, [evidence]);

  return (
    <div className="space-y-4" data-testid="work-report-analytics">
      <section
        aria-label="Hướng dẫn sử dụng tổng hợp báo cáo"
        className="rounded-xl border border-border bg-surface p-4 text-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Cách xem số liệu tổng hợp</h2>
          {options ? (
            <span className="text-xs text-muted">
              Phạm vi quyền hiện hành: <strong className="text-foreground">{options.effective_scope.label}</strong>
            </span>
          ) : null}
        </div>
        <ol className="mt-2 grid gap-1.5 text-xs text-muted sm:grid-cols-2 xl:grid-cols-3">
          <li>1. Chọn <strong className="text-foreground">Mẫu báo cáo</strong> cần theo dõi.</li>
          <li>2. Chọn <strong className="text-foreground">khoảng thời gian</strong> và <strong className="text-foreground">chế độ dữ liệu</strong>.</li>
          <li>3. Tùy chọn lọc thu hẹp theo <strong className="text-foreground">Team</strong> hoặc <strong className="text-foreground">nhân viên</strong>.</li>
          <li>4. Nhấn <strong className="text-foreground">Áp dụng bộ lọc</strong> để tính toán.</li>
          <li>5. Đọc <strong className="text-foreground">KPI tuân thủ</strong>, chỉ tiêu và bảng phân tích theo nhóm.</li>
          <li>
            6. {canViewSubmissions
              ? "Mở bài nộp nguồn nếu cần đối chiếu chi tiết."
              : "Tài khoản chỉ có quyền xem tổng hợp; không mở nội dung bài nộp chi tiết."}
          </li>
        </ol>
      </section>

      {optionsState === "loading" ? (
        <p role="status" className="rounded-xl border border-border bg-surface p-4 text-sm text-muted">
          Đang tải danh sách mẫu báo cáo, Team và nhân viên trong phạm vi quyền…
        </p>
      ) : null}

      {optionsState === "denied" ? (
        <StatusBanner tone="warning" title="Chưa có quyền xem số liệu tổng hợp">
          Tab Tổng hợp yêu cầu quyền xem phân tích tổng hợp trong phạm vi được cấp. Nếu bạn có quyền xem bài nộp, hãy chuyển sang tab Bài nộp.
        </StatusBanner>
      ) : null}

      {optionsState === "error" ? (
        <StatusBanner tone="error" title="Không tải được bộ lọc tổng hợp">
          <div className="flex flex-wrap items-center gap-2">
            <span>Không thể tải danh sách lựa chọn từ máy chủ. Vui lòng thử lại.</span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setOptionsState("loading");
                setOptionsReloadToken((value) => value + 1);
              }}
            >
              Thử lại
            </Button>
          </div>
        </StatusBanner>
      ) : null}

      {optionsState === "ready" && options && options.templates.length === 0 ? (
        <StatusBanner tone="info" title="Chưa có mẫu báo cáo trong phạm vi">
          Hiện chưa có mẫu báo cáo đã phát hành hoặc được giao trong phạm vi quyền tổng hợp của bạn.
        </StatusBanner>
      ) : null}

      {optionsState === "ready" && options ? (
        <FilterToolbar
          summary="Tất cả danh sách lựa chọn và số liệu đều được giới hạn theo phạm vi quyền trên máy chủ; nhóm tính theo snapshot Team tại kỳ phát sinh nghĩa vụ."
          actions={
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={resetDraft}>
                Đặt lại bộ lọc
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={busy || !draft.template_id.trim()}
                onClick={() => void load(draft)}
              >
                {busy ? "Đang tổng hợp…" : "Áp dụng bộ lọc"}
              </Button>
            </div>
          }
        >
          <fieldset className="mb-3 space-y-2" aria-label="Trạng thái dữ liệu báo cáo">
            <legend className="text-xs font-medium">Chế độ dữ liệu</legend>
            <div className="flex flex-wrap gap-2">
              <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm">
                <input
                  type="radio"
                  name="work-report-finality"
                  value="final"
                  checked={finality === "final"}
                  onChange={() => (filters ? void load(filters, groupBy, "final") : setFinality("final"))}
                />
                Chốt (Đã duyệt)
              </label>
              <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm">
                <input
                  type="radio"
                  name="work-report-finality"
                  value="provisional_included"
                  checked={finality === "provisional_included"}
                  onChange={() =>
                    filters ? void load(filters, groupBy, "provisional_included") : setFinality("provisional_included")
                  }
                />
                Tạm tính (Chờ duyệt)
              </label>
            </div>
            <p className="text-xs text-muted">
              <strong className="text-foreground">Chốt (Đã duyệt):</strong> chỉ tính báo cáo đã hoàn tất hợp lệ / đã được duyệt.{" "}
              <strong className="text-foreground">Tạm tính (Chờ duyệt):</strong> tính thêm cả báo cáo đã nộp đang đợi duyệt.
            </p>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <label className="space-y-1 text-xs font-medium">
              Mẫu báo cáo (bắt buộc)
              <select
                className={inputClass}
                aria-label="Mẫu báo cáo"
                value={draft.template_id}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    template_id: event.target.value,
                    version_id: "",
                  })
                }
              >
                <option value="">Chọn mẫu báo cáo</option>
                {options.templates.map((tpl) => (
                  <option key={tpl.template_id} value={tpl.template_id}>
                    {tpl.display_name} ({tpl.template_code})
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium">
              Phiên bản biểu mẫu
              <select
                className={inputClass}
                aria-label="Phiên bản biểu mẫu"
                disabled={!selectedTemplate}
                value={draft.version_id}
                onChange={(event) => setDraft({ ...draft, version_id: event.target.value })}
              >
                <option value="">Tất cả phiên bản</option>
                {(selectedTemplate?.versions ?? []).map((ver) => (
                  <option key={ver.version_id} value={ver.version_id}>
                    Phiên bản v{ver.version_no}
                    {ver.status === "ARCHIVED" ? " (Đã lưu trữ)" : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium">
              Từ ngày
              <input
                className={inputClass}
                type="date"
                value={draft.from}
                onChange={(event) => setDraft({ ...draft, from: event.target.value })}
                aria-label="Từ ngày"
              />
            </label>

            <label className="space-y-1 text-xs font-medium">
              Đến ngày
              <input
                className={inputClass}
                type="date"
                value={draft.to}
                onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                aria-label="Đến ngày"
              />
            </label>

            <label className="space-y-1 text-xs font-medium">
              Team hành chính
              <select
                className={inputClass}
                aria-label="Team hành chính"
                value={draft.team_id}
                onChange={(event) => {
                  const nextTeamId = event.target.value;
                  const keepAssignee =
                    !nextTeamId ||
                    options.assignees.some(
                      (assignee) =>
                        assignee.app_user_id === draft.assignee_id && assignee.team_ids.includes(nextTeamId),
                    );
                  setDraft({
                    ...draft,
                    team_id: nextTeamId,
                    assignee_id: keepAssignee ? draft.assignee_id : "",
                  });
                }}
              >
                <option value="">Tất cả Team trong phạm vi</option>
                {options.teams.map((team) => (
                  <option key={team.team_id} value={team.team_id}>
                    {team.display_name} ({team.code})
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium">
              Nhân viên
              <select
                className={inputClass}
                aria-label="Nhân viên"
                value={draft.assignee_id}
                onChange={(event) => setDraft({ ...draft, assignee_id: event.target.value })}
              >
                <option value="">Tất cả nhân viên trong phạm vi</option>
                {filteredAssignees.map((assignee) => (
                  <option key={assignee.app_user_id} value={assignee.app_user_id}>
                    {assignee.display_name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </FilterToolbar>
      ) : null}

      {error ? (
        <StatusBanner tone="error" title="Có lỗi khi tải dữ liệu">
          <div className="flex flex-wrap items-center gap-2">
            <span>{error}</span>
            {(filters?.template_id || draft.template_id) ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void load(filters ?? draft)}
              >
                Thử lại
              </Button>
            ) : null}
          </div>
        </StatusBanner>
      ) : null}

      {busy && !overview ? (
        <p role="status" className="rounded-xl border border-border bg-surface p-4 text-sm text-muted">
          Đang tổng hợp số liệu báo cáo…
        </p>
      ) : null}

      {overview ? (
        <>
          <section aria-label="Phạm vi và KPI" className="space-y-3">
            <p className="text-sm text-muted">
              Phạm vi do máy chủ xác định:{" "}
              <strong className="text-foreground">{overview.effective_scope.label}</strong> ·{" "}
              {finality === "final" ? "Chốt (Đã duyệt)" : "Tạm tính (Chờ duyệt)"} · Nhóm theo snapshot tại kỳ
            </p>
            {hasEmptyOverviewData ? (
              <StatusBanner tone="info" title="Không có dữ liệu phát sinh trong bộ lọc đã chọn">
                Chưa có nghĩa vụ hoặc số liệu chỉ tiêu khớp với mẫu, khoảng thời gian, chế độ dữ liệu và bộ lọc hiện tại. Nếu báo cáo vừa nộp đang chờ duyệt, hãy thử chuyển sang chế độ Tạm tính (Chờ duyệt) hoặc mở rộng khoảng ngày.
              </StatusBanner>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {(
                [
                  ["Phải nộp", overview.compliance.due_count, "Tổng nghĩa vụ đến hạn (không tính miễn/hủy)"],
                  ["Đã nộp", overview.compliance.completed_count, "Số nghĩa vụ đã hoàn tất theo chế độ đang xem"],
                  [
                    "Hoàn thành",
                    overview.compliance.completion_rate === null
                      ? null
                      : `${number(overview.compliance.completion_rate, 2)}%`,
                    "Tỷ lệ Đã nộp / Phải nộp trong kỳ lọc",
                  ],
                  ["Quá hạn, chưa nộp", overview.compliance.overdue_missing_count, "Đã qua hạn nộp nhưng chưa có bài hợp lệ"],
                  ["Đúng hạn", overview.compliance.on_time_count, "Hoàn tất trước hoặc đúng thời điểm đến hạn"],
                  ["Nộp muộn", overview.compliance.late_submitted_count, "Hoàn tất sau thời điểm đến hạn"],
                  ["Chưa đến hạn", overview.compliance.pending_due_count, "Chưa nộp nhưng vẫn còn trong hạn"],
                  ["Được miễn", overview.compliance.exempted_count, "Nghĩa vụ được miễn hợp lệ trong kỳ"],
                  ["Chờ duyệt", overview.compliance.pending_review_count, "Bài đã nộp, đang chờ người duyệt quyết định"],
                ] as const
              ).map(([label, value, hint]) => (
                <div key={label} className="rounded-xl border border-border bg-surface p-4 shadow-2xs">
                  <p className="text-xs font-medium text-foreground">{label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{value === null ? "—" : value}</p>
                  <p className="mt-1 text-xs text-muted">{hint}</p>
                </div>
              ))}
            </div>
          </section>

          <section aria-label="Tổng hợp chỉ tiêu" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {overview.metrics.map((metric) => (
              <article
                key={`${metric.metric_key}:${metric.compatible_group}`}
                className="rounded-xl border border-border bg-surface p-4 shadow-2xs"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="whitespace-pre-line break-words font-semibold">{metric.label}</h2>
                  {canViewSubmissions ? (
                    <Button size="sm" onClick={() => void openContributions(metric.metric_key)}>
                      Xem bài đóng góp
                    </Button>
                  ) : null}
                </div>
                <p className="mt-3 text-2xl font-semibold tabular-nums">
                  {number(metric.sum_value, 2)}{" "}
                  <span className="text-sm font-normal text-muted">{metric.unit}</span>
                </p>
                <p className="mt-1 text-xs text-muted">
                  Trung bình {number(metric.avg_value, 2)} · Có số liệu {metric.count_valid} · Bỏ trống{" "}
                  {metric.missing_value_count}
                </p>
              </article>
            ))}
          </section>

          <section className="space-y-2" aria-label="Bảng phân tích">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Chi tiết theo nhóm</h2>
              <label className="flex items-center gap-2 text-sm">
                Nhóm theo
                <select
                  className={`${inputClass} w-auto`}
                  value={groupBy}
                  onChange={(event) => filters && void load(filters, event.target.value as GroupBy)}
                >
                  <option value="team">Team</option>
                  <option value="assignee">Nhân viên</option>
                  <option value="period">Kỳ</option>
                </select>
              </label>
            </div>
            <DataTableContainer>
              <table className={DATA_TABLE_CLASS}>
                <thead className={DATA_TABLE_HEAD_CLASS}>
                  <tr>
                    <th className={DATA_TABLE_TH_CLASS}>Đơn vị</th>
                    <th className={DATA_TABLE_TH_CLASS}>Phải nộp</th>
                    <th className={DATA_TABLE_TH_CLASS}>Đã nộp</th>
                    <th className={DATA_TABLE_TH_CLASS}>Quá hạn</th>
                    <th className={DATA_TABLE_TH_CLASS}>Chỉ tiêu</th>
                    {canViewSubmissions ? <th className={DATA_TABLE_TH_CLASS}>Nguồn</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${groupBy}:${row.group_id ?? row.group_label}`} className={DATA_TABLE_ROW_CLASS}>
                      <td className={DATA_TABLE_TD_CLASS}>{row.group_label}</td>
                      <td className={DATA_TABLE_TD_CLASS}>{row.due_count}</td>
                      <td className={DATA_TABLE_TD_CLASS}>{row.completed_count}</td>
                      <td className={DATA_TABLE_TD_CLASS}>{row.overdue_missing_count}</td>
                      <td className={DATA_TABLE_TD_CLASS}>
                        {row.metrics.map((m) => (
                          <div key={`${m.metric_key}:${m.compatible_group}`} className="whitespace-pre-line break-words">
                            {m.label}: {number(m.sum_value, 2)} {m.unit}
                          </div>
                        ))}
                      </td>
                      {canViewSubmissions ? (
                        <td className={DATA_TABLE_TD_CLASS}>
                          <Button size="sm" onClick={() => void openContributions(undefined, row)}>
                            Xem bài nộp
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 ? (
                <p className="p-4 text-sm text-muted">
                  Không có dòng dữ liệu phân rã trong bộ lọc này. Hãy kiểm tra khoảng ngày hoặc chế độ dữ liệu.
                </p>
              ) : null}
            </DataTableContainer>
          </section>
        </>
      ) : optionsState === "ready" && !busy ? (
        <p className="rounded-xl border border-border bg-surface p-4 text-sm text-muted">
          Chọn mẫu báo cáo ở bộ lọc phía trên rồi nhấn <strong className="text-foreground">Áp dụng bộ lọc</strong> để xem số liệu tổng hợp.
        </p>
      ) : null}

      {canViewSubmissions && contributions ? (
        <section aria-label="Bài nộp nguồn" className="space-y-2">
          <h2 className="text-lg font-semibold">Bài nộp đóng góp ({contributions.length})</h2>
          <DataTableContainer>
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th className={DATA_TABLE_TH_CLASS}>Nhân viên</th>
                  <th className={DATA_TABLE_TH_CLASS}>Team / kỳ</th>
                  <th className={DATA_TABLE_TH_CLASS}>Bản nộp</th>
                  <th className={DATA_TABLE_TH_CLASS}>Trạng thái</th>
                  <th className={DATA_TABLE_TH_CLASS}>Nộp lúc</th>
                  <th className={DATA_TABLE_TH_CLASS}>Giá trị đóng góp</th>
                  <th className={DATA_TABLE_TH_CLASS}>Nguồn</th>
                </tr>
              </thead>
              <tbody>
                {contributions.map((item) => (
                  <tr key={item.obligation_id} className={DATA_TABLE_ROW_CLASS}>
                    <td className={DATA_TABLE_TD_CLASS}>{item.assignee_display_name}</td>
                    <td className={DATA_TABLE_TD_CLASS}>
                      {item.team_display_name ?? "—"} / {item.period_key}
                    </td>
                    <td className={DATA_TABLE_TD_CLASS}>
                      {item.submission_id ? `Lần ${item.revision_no ?? 1}` : "Chưa nộp"}
                    </td>
                    <td className={DATA_TABLE_TD_CLASS}>
                      {readerStateLabel(item.state)}
                      {item.is_late ? " · Nộp muộn" : ""}
                      {item.has_post_deadline_amendment ? " · Có bổ sung sau hạn" : ""}
                    </td>
                    <td className={DATA_TABLE_TD_CLASS}>{dateTime(item.submitted_at)}</td>
                    <td className={DATA_TABLE_TD_CLASS}>{number(item.metric_contribution_value, 2)}</td>
                    <td className={DATA_TABLE_TD_CLASS}>
                      {item.submission_id ? (
                        <Button size="sm" onClick={() => void openEvidence(item)}>
                          Mở bài nộp
                        </Button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {contributions.length === 0 ? (
              <p className="p-4 text-sm text-muted">Không có bài nộp phù hợp.</p>
            ) : null}
          </DataTableContainer>
          <div className="flex justify-center">
            <CursorLoadMore hasMore={nextCursor !== null} loading={busy} onLoadMore={() => void loadMoreContributions()} />
          </div>
        </section>
      ) : null}

      {canViewSubmissions && evidence && evidencePayload ? (
        <section aria-label="Bằng chứng bài nộp" className="space-y-4 rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">{evidence.template.display_name}</h2>
              <p className="text-xs text-muted">
                Kỳ {evidence.obligation.period_key} ·{" "}
                {evidence.obligation.snapshot_team_display_name ?? "Chưa gắn Team"} · Nộp gần nhất{" "}
                {formatReaderDateTime(evidence.submission?.latest_submitted_at ?? null)}
              </p>
            </div>
            <Button size="sm" onClick={() => setEvidence(null)}>
              Đóng
            </Button>
          </div>
          <ReportReadonlyContent schema={evidence.template.schema_json} payload={evidencePayload} />
          <ReportRevisionList
            revisions={evidence.revisions}
            currentRevisionId={evidence.submission?.current_revision_id ?? null}
          />
          <ReportReviewHistory event={evidence.latest_review_event} />
        </section>
      ) : null}
    </div>
  );
}
