"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DataTableContainer, DATA_TABLE_CLASS, DATA_TABLE_HEAD_CLASS, DATA_TABLE_ROW_CLASS, DATA_TABLE_TD_CLASS, DATA_TABLE_TH_CLASS } from "@/components/ui/data-table";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { StatusBanner } from "@/components/ui/status-banner";

type Filters = { template_id: string; version_id: string; from: string; to: string; team_id: string; assignee_id: string };
type Metric = { metric_key: string; label: string; unit: string; compatible_group: string; sum_value: number | null; avg_value: number | null; min_value: number | null; max_value: number | null; count_valid: number; missing_value_count: number };
type Compliance = { due_count: number; completed_count: number; on_time_count: number; late_submitted_count: number; pending_due_count: number; overdue_missing_count: number; exempted_count: number; pending_review_count: number; completion_rate: number | null };
type Overview = { effective_scope: { kind: "all" | "team"; label: string }; compliance: Compliance; metrics: Metric[] };
type GroupBy = "team" | "assignee" | "period";
type Breakdown = { group_id: string | null; group_label: string; due_count: number; completed_count: number; overdue_missing_count: number; metrics: Metric[] };
type Contribution = { obligation_id: string; submission_id: string | null; revision_no: number | null; assignee_display_name: string; team_display_name: string | null; period_key: string; state: string; submitted_at: string | null; is_late: boolean; has_post_deadline_amendment: boolean; metric_contribution_value: number | null };

const initialFilters: Filters = { template_id: "", version_id: "", from: "", to: "", team_id: "", assignee_id: "" };
const inputClass = "min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";
const number = (value: number | null, digits = 0) => value === null ? "—" : new Intl.NumberFormat("vi-VN", { maximumFractionDigits: digits }).format(value);
const dateTime = (value: string | null) => value ? new Date(value).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "—";

async function getData<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true || !result.data) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
  return result.data as T;
}

function queryString(filters: Filters) {
  const query = new URLSearchParams({ finality: "final" });
  for (const key of Object.keys(filters) as (keyof Filters)[]) if (filters[key].trim()) query.set(key, filters[key].trim());
  return query.toString();
}

export function WorkReportAnalytics() {
  const [draft, setDraft] = useState(initialFilters);
  const [filters, setFilters] = useState<Filters | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>("team");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [rows, setRows] = useState<Breakdown[]>([]);
  const [contributions, setContributions] = useState<Contribution[] | null>(null);
  const [evidence, setEvidence] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(nextFilters: Filters, nextGroup: GroupBy = groupBy) {
    setBusy(true); setError(null); setContributions(null); setEvidence(null);
    const query = queryString(nextFilters);
    try {
      const [summary, breakdown] = await Promise.all([
        getData<Overview>(`/api/work-reports/analytics/overview?${query}`),
        getData<{ items: Breakdown[] }>(`/api/work-reports/analytics/breakdown?${query}&group_by=${nextGroup}&page=1&page_size=50`),
      ]);
      setFilters(nextFilters); setGroupBy(nextGroup); setOverview(summary); setRows(breakdown.items);
    } catch {
      setOverview(null); setRows([]); setError("Không tải được dữ liệu tổng hợp. Hãy kiểm tra mẫu và bộ lọc trong phạm vi quyền hiện hành rồi thử lại.");
    } finally { setBusy(false); }
  }

  async function openContributions(metricKey?: string, row?: Breakdown) {
    if (!filters) return;
    const query = new URLSearchParams(queryString(filters));
    if (metricKey) query.set("metric_key", metricKey);
    if (row?.group_id && groupBy === "team") query.set("target_team_id", row.group_id);
    if (row?.group_id && groupBy === "assignee") query.set("target_assignee_id", row.group_id);
    if (row?.group_id && groupBy === "period") query.set("target_period_key", row.group_id);
    setBusy(true); setError(null); setEvidence(null);
    try {
      const result = await getData<{ items: Contribution[] }>(`/api/work-reports/analytics/contributions?${query}&limit=100`);
      setContributions(result.items);
    } catch { setError("Không tải được danh sách bài nộp đóng góp trong phạm vi quyền hiện hành."); }
    finally { setBusy(false); }
  }

  async function openEvidence(item: Contribution) {
    if (!item.submission_id) return;
    setBusy(true); setError(null);
    try { setEvidence(await getData(`/api/work-reports/submissions/${encodeURIComponent(item.submission_id)}`)); }
    catch { setError("Không mở được bài nộp nguồn trong phạm vi quyền hiện hành."); }
    finally { setBusy(false); }
  }

  return <div className="space-y-4" data-testid="work-report-analytics">
    <FilterToolbar summary="Chỉ tiêu dùng finality=final và snapshot_team mặc định. ID là mã mẫu, phiên bản, nhóm hoặc nhân viên." actions={<Button variant="primary" disabled={busy || !draft.template_id.trim()} onClick={() => void load(draft)}>Áp dụng bộ lọc</Button>}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <label className="space-y-1 text-xs font-medium">Mã mẫu (bắt buộc)<input className={inputClass} value={draft.template_id} onChange={(e) => setDraft({ ...draft, template_id: e.target.value })} aria-label="Mã mẫu" /></label>
        <label className="space-y-1 text-xs font-medium">Mã phiên bản<input className={inputClass} value={draft.version_id} onChange={(e) => setDraft({ ...draft, version_id: e.target.value })} aria-label="Mã phiên bản" /></label>
        <label className="space-y-1 text-xs font-medium">Từ ngày<input className={inputClass} type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} aria-label="Từ ngày" /></label>
        <label className="space-y-1 text-xs font-medium">Đến ngày<input className={inputClass} type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} aria-label="Đến ngày" /></label>
        <label className="space-y-1 text-xs font-medium">Mã nhóm<input className={inputClass} value={draft.team_id} onChange={(e) => setDraft({ ...draft, team_id: e.target.value })} aria-label="Mã nhóm" /></label>
        <label className="space-y-1 text-xs font-medium">Mã nhân viên<input className={inputClass} value={draft.assignee_id} onChange={(e) => setDraft({ ...draft, assignee_id: e.target.value })} aria-label="Mã nhân viên" /></label>
      </div>
    </FilterToolbar>

    {error ? <StatusBanner tone="error" title="Có lỗi khi tải dữ liệu">{error}</StatusBanner> : null}
    {overview ? <>
      <section aria-label="Phạm vi và KPI" className="space-y-3">
        <p className="text-sm text-muted">Phạm vi do máy chủ xác định: <strong className="text-foreground">{overview.effective_scope.label}</strong> · Nhóm theo snapshot tại kỳ · Chỉ bài hoàn tất</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[["Phải nộp", overview.compliance.due_count], ["Đã nộp", overview.compliance.completed_count], ["Hoàn thành", overview.compliance.completion_rate === null ? null : `${number(overview.compliance.completion_rate, 2)}%`], ["Quá hạn, chưa nộp", overview.compliance.overdue_missing_count], ["Đúng hạn", overview.compliance.on_time_count], ["Nộp muộn", overview.compliance.late_submitted_count], ["Chưa đến hạn", overview.compliance.pending_due_count], ["Được miễn", overview.compliance.exempted_count], ["Chờ duyệt", overview.compliance.pending_review_count]].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-border bg-surface p-4 shadow-2xs"><p className="text-xs text-muted">{label}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{value === null ? "—" : value}</p></div>)}
        </div>
      </section>
      <section aria-label="Tổng hợp chỉ tiêu" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{overview.metrics.map((metric) => <article key={`${metric.metric_key}:${metric.compatible_group}`} className="rounded-xl border border-border bg-surface p-4 shadow-2xs"><div className="flex items-start justify-between gap-3"><h2 className="font-semibold">{metric.label}</h2><Button size="sm" onClick={() => void openContributions(metric.metric_key)}>Xem bài đóng góp</Button></div><p className="mt-3 text-2xl font-semibold tabular-nums">{number(metric.sum_value, 2)} <span className="text-sm font-normal text-muted">{metric.unit}</span></p><p className="mt-1 text-xs text-muted">Trung bình {number(metric.avg_value, 2)} · Có số liệu {metric.count_valid} · Bỏ trống {metric.missing_value_count}</p></article>)}</section>
      <section className="space-y-2" aria-label="Bảng phân tích">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">Chi tiết theo nhóm</h2><label className="flex items-center gap-2 text-sm">Nhóm theo<select className={`${inputClass} w-auto`} value={groupBy} onChange={(e) => void load(filters!, e.target.value as GroupBy)}><option value="team">Nhóm</option><option value="assignee">Nhân viên</option><option value="period">Kỳ</option></select></label></div>
        <DataTableContainer><table className={DATA_TABLE_CLASS}><thead className={DATA_TABLE_HEAD_CLASS}><tr><th className={DATA_TABLE_TH_CLASS}>Đơn vị</th><th className={DATA_TABLE_TH_CLASS}>Phải nộp</th><th className={DATA_TABLE_TH_CLASS}>Đã nộp</th><th className={DATA_TABLE_TH_CLASS}>Quá hạn</th><th className={DATA_TABLE_TH_CLASS}>Chỉ tiêu</th><th className={DATA_TABLE_TH_CLASS}>Nguồn</th></tr></thead><tbody>{rows.map((row) => <tr key={`${groupBy}:${row.group_id ?? row.group_label}`} className={DATA_TABLE_ROW_CLASS}><td className={DATA_TABLE_TD_CLASS}>{row.group_label}</td><td className={DATA_TABLE_TD_CLASS}>{row.due_count}</td><td className={DATA_TABLE_TD_CLASS}>{row.completed_count}</td><td className={DATA_TABLE_TD_CLASS}>{row.overdue_missing_count}</td><td className={DATA_TABLE_TD_CLASS}>{row.metrics.map((m) => <div key={`${m.metric_key}:${m.compatible_group}`}>{m.label}: {number(m.sum_value, 2)} {m.unit}</div>)}</td><td className={DATA_TABLE_TD_CLASS}><Button size="sm" onClick={() => void openContributions(undefined, row)}>Xem bài nộp</Button></td></tr>)}</tbody></table>{rows.length === 0 ? <p className="p-4 text-sm text-muted">Không có dữ liệu trong bộ lọc này.</p> : null}</DataTableContainer>
      </section>
    </> : <p className="rounded-xl border border-border bg-surface p-4 text-sm text-muted">Nhập mã mẫu rồi áp dụng bộ lọc để xem tổng hợp.</p>}

    {contributions ? <section aria-label="Bài nộp nguồn" className="space-y-2"><h2 className="text-lg font-semibold">Bài nộp đóng góp ({contributions.length})</h2><DataTableContainer><table className={DATA_TABLE_CLASS}><thead className={DATA_TABLE_HEAD_CLASS}><tr><th className={DATA_TABLE_TH_CLASS}>Mã bài nộp</th><th className={DATA_TABLE_TH_CLASS}>Nhân viên</th><th className={DATA_TABLE_TH_CLASS}>Nhóm / kỳ</th><th className={DATA_TABLE_TH_CLASS}>Trạng thái</th><th className={DATA_TABLE_TH_CLASS}>Nộp lúc</th><th className={DATA_TABLE_TH_CLASS}>Giá trị</th><th className={DATA_TABLE_TH_CLASS}>Nguồn</th></tr></thead><tbody>{contributions.map((item) => <tr key={item.obligation_id} className={DATA_TABLE_ROW_CLASS}><td className={DATA_TABLE_TD_CLASS}>{item.submission_id ? `${item.submission_id} · rev ${item.revision_no ?? "—"}` : item.obligation_id}</td><td className={DATA_TABLE_TD_CLASS}>{item.assignee_display_name}</td><td className={DATA_TABLE_TD_CLASS}>{item.team_display_name ?? "—"} / {item.period_key}</td><td className={DATA_TABLE_TD_CLASS}>{item.state}{item.is_late ? " · Nộp muộn" : ""}{item.has_post_deadline_amendment ? " · Có bổ sung sau hạn" : ""}</td><td className={DATA_TABLE_TD_CLASS}>{dateTime(item.submitted_at)}</td><td className={DATA_TABLE_TD_CLASS}>{number(item.metric_contribution_value, 2)}</td><td className={DATA_TABLE_TD_CLASS}>{item.submission_id ? <Button size="sm" onClick={() => void openEvidence(item)}>Mở bài nộp</Button> : "—"}</td></tr>)}</tbody></table>{contributions.length === 0 ? <p className="p-4 text-sm text-muted">Không có bài nộp phù hợp.</p> : null}</DataTableContainer></section> : null}
    {evidence ? <section aria-label="Bằng chứng bài nộp" className="space-y-2 rounded-xl border border-border bg-surface p-4"><div className="flex items-center justify-between gap-2"><h2 className="font-semibold">Bài nộp nguồn</h2><Button size="sm" onClick={() => setEvidence(null)}>Đóng</Button></div><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-muted p-3 text-xs">{JSON.stringify(evidence, null, 2)}</pre></section> : null}
  </div>;
}
