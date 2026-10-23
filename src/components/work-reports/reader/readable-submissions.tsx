"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CursorLoadMore } from "@/components/ui/cursor-load-more";
import { DataTableContainer, DATA_TABLE_CLASS, DATA_TABLE_HEAD_CLASS, DATA_TABLE_ROW_CLASS, DATA_TABLE_TD_CLASS, DATA_TABLE_TH_CLASS, RowActionCluster } from "@/components/ui/data-table";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { FormDialog } from "@/components/ui/form-dialog";
import { StatusBanner } from "@/components/ui/status-banner";
import type { WorkReportTemplateSchema } from "@/lib/work-reports/contracts.ts";
import {
  findCurrentRevision,
  formatReaderDateTime,
  mergeReaderItems,
  parseReaderList,
  readerListQuery,
  readerStateLabel,
  WORK_REPORT_READABLE_STATE_LABELS,
  type ReaderListFilters,
  type ReaderListItem,
  type ReaderListPayload,
  type ReaderRevision,
} from "@/lib/work-reports/reader-ui-model.ts";
import { ReportReadonlyContent, ReportReviewHistory, ReportRevisionList } from "./report-readonly-content";

type ReaderDetail = {
  obligation: {
    period_key: string;
    period_start_date: string;
    period_end_date: string;
    due_at: string;
    snapshot_team_display_name: string | null;
    snapshot_team_code: string | null;
    obligation_status: string;
  };
  template: { template_code: string; display_name: string; schema_json: WorkReportTemplateSchema };
  submission: {
    submission_id: string;
    state: string;
    draft_payload_json: Record<string, unknown> | null;
    first_submitted_at: string | null;
    latest_submitted_at: string | null;
    is_late: boolean;
    has_post_deadline_amendment: boolean;
    current_revision_id: string | null;
    version: number;
  } | null;
  latest_review_event: { decision: string; reason: string | null; reviewed_at: string; revision_no?: number } | null;
  revisions: ReaderRevision[];
};

const EMPTY_FILTERS: ReaderListFilters = {
  templateId: "", versionId: "", from: "", to: "", teamId: "", assigneeId: "", state: "",
};

const inputClass = "min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function parseReaderDetail(body: unknown): ReaderDetail | null {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.data)) return null;
  const d = body.data;
  if (!isRecord(d.obligation) || !isRecord(d.template) || !Array.isArray(d.revisions)) return null;
  const template = d.template;
  if (typeof template.display_name !== "string" || !isRecord(template.schema_json)) return null;
  const submission = d.submission === null ? null : isRecord(d.submission) ? d.submission : null;
  const latest = d.latest_review_event === undefined || d.latest_review_event === null
    ? null : isRecord(d.latest_review_event) ? d.latest_review_event : null;
  return {
    obligation: {
      period_key: String(d.obligation.period_key ?? ""),
      period_start_date: String(d.obligation.period_start_date ?? ""),
      period_end_date: String(d.obligation.period_end_date ?? ""),
      due_at: String(d.obligation.due_at ?? ""),
      snapshot_team_display_name: typeof d.obligation.snapshot_team_display_name === "string"
        ? d.obligation.snapshot_team_display_name : null,
      snapshot_team_code: typeof d.obligation.snapshot_team_code === "string"
        ? d.obligation.snapshot_team_code : null,
      obligation_status: String(d.obligation.obligation_status ?? ""),
    },
    template: {
      template_code: String(template.template_code ?? ""),
      display_name: template.display_name,
      schema_json: template.schema_json as WorkReportTemplateSchema,
    },
    submission: submission === null ? null : {
      submission_id: String(submission.submission_id ?? ""),
      state: String(submission.state ?? ""),
      draft_payload_json: isRecord(submission.draft_payload_json) || submission.draft_payload_json === null
        ? submission.draft_payload_json as Record<string, unknown> | null : null,
      first_submitted_at: typeof submission.first_submitted_at === "string" ? submission.first_submitted_at : null,
      latest_submitted_at: typeof submission.latest_submitted_at === "string" ? submission.latest_submitted_at : null,
      is_late: submission.is_late === true,
      has_post_deadline_amendment: submission.has_post_deadline_amendment === true,
      current_revision_id: typeof submission.current_revision_id === "string" ? submission.current_revision_id : null,
      version: Number(submission.version ?? 0),
    },
    latest_review_event: latest === null ? null : {
      decision: String(latest.decision ?? ""),
      reason: typeof latest.reason === "string" ? latest.reason : null,
      reviewed_at: String(latest.reviewed_at ?? ""),
      ...(typeof latest.revision_no === "number" ? { revision_no: latest.revision_no } : {}),
    },
    revisions: d.revisions.map((revision) => ({
      revision_id: String((revision as Record<string, unknown>).revision_id ?? ""),
      revision_no: Number((revision as Record<string, unknown>).revision_no ?? 0),
      payload_json: isRecord((revision as Record<string, unknown>).payload_json)
        ? (revision as Record<string, unknown>).payload_json as Record<string, unknown> : {},
      created_at: String((revision as Record<string, unknown>).created_at ?? ""),
    })),
  };
}

function readerStateTone(state: string): BadgeTone {
  switch (state) {
    case "APPROVED": return "success";
    case "PENDING_REVIEW": return "warning";
    case "REJECTED": return "danger";
    case "COMPLETED": return "info";
    default: return "neutral";
  }
}

export function ReadableSubmissions() {
  const [draft, setDraft] = useState<ReaderListFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<ReaderListFilters>(EMPTY_FILTERS);
  const [payload, setPayload] = useState<ReaderListPayload | null>(null);
  const [items, setItems] = useState<ReaderListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [view, setView] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{ item: ReaderListItem; value: ReaderDetail } | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailView, setDetailView] = useState<"loading" | "ready" | "error">("loading");
  const generation = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const fetchList = useCallback(async (nextFilters: ReaderListFilters, nextCursor: string | null, append: boolean) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const gen = ++generation.current;
    setBusy(true);
    try {
      const response = await fetch("/api/work-reports/submissions" + readerListQuery(nextFilters, nextCursor), {
        cache: "no-store", signal: controller.signal, headers: { accept: "application/json" },
      });
      if (response.status === 403) {
        if (gen === generation.current) { setView("denied"); setError(null); setPayload(null); setItems([]); }
        return;
      }
      const body = await response.json().catch(() => null);
      const parsed = response.ok ? parseReaderList(body) : null;
      if (gen !== generation.current) return;
      if (!parsed) {
        setView("error");
        setError("Không tải được danh sách bài nộp trong phạm vi quyền hiện tại.");
        setPayload(null);
        if (!append) setItems([]);
        return;
      }
      setPayload(parsed);
      setItems((current) => append ? mergeReaderItems(current, parsed.items) : [...parsed.items]);
      setCursor(parsed.next_cursor);
      setView("ready");
      setError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (gen !== generation.current) return;
      setView("error");
      setError("Không tải được danh sách bài nộp trong phạm vi quyền hiện tại.");
      setPayload(null);
      if (!append) setItems([]);
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void fetchList(filters, null, false); }, 0);
    return () => { clearTimeout(timer); generation.current += 1; controllerRef.current?.abort(); };
  }, [filters, fetchList]);

  async function openDetail(item: ReaderListItem) {
    setDetail(null);
    setDetailOpen(true);
    setDetailView("loading");
    try {
      const response = await fetch(`/api/work-reports/submissions/${encodeURIComponent(item.obligation_id)}`, {
        cache: "no-store", headers: { accept: "application/json" },
      });
      const body = await response.json().catch(() => null);
      const value = response.ok ? parseReaderDetail(body) : null;
      if (!value) { setDetailView("error"); return; }
      setDetail({ item, value });
      setDetailView("ready");
    } catch {
      setDetailView("error");
    }
  }

  const templates = payload?.filter_options.templates ?? [];
  const selectedTemplate = templates.find((template) => template.template_id === filters.templateId);
  const versionOptions = selectedTemplate?.versions ?? [];
  const teams = payload?.filter_options.teams ?? [];
  const assignees = payload?.filter_options.assignees ?? [];

  const currentRevision = detail
    ? findCurrentRevision(detail.value.revisions, detail.value.submission?.current_revision_id ?? null)
    : null;
  const teamLabel = detail
    ? (detail.value.obligation.snapshot_team_display_name ?? detail.item.team_display_name ?? "—")
    : "—";

  return (
    <div className="space-y-4">
      <FilterToolbar
        summary={
          <p role="status" aria-live="polite" className="text-xs text-muted">
            {payload ? `Phạm vi: ${payload.effective_scope.label} — ${payload.filter_options.templates.length} mẫu` : "Đang tải bộ lọc…"}
          </p>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-12 lg:items-end">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted lg:col-span-3">Mẫu báo cáo
            <select className={inputClass} value={draft.templateId}
              onChange={(event) => setDraft((current) => ({ ...current, templateId: event.target.value, versionId: "" }))}>
              <option value="">Tất cả mẫu</option>
              {templates.map((template) => (
                <option key={template.template_id} value={template.template_id}>{template.display_name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted lg:col-span-2">Phiên bản
            <select className={inputClass} value={draft.versionId} disabled={!draft.templateId}
              onChange={(event) => setDraft((current) => ({ ...current, versionId: event.target.value }))}>
              <option value="">Tất cả phiên bản</option>
              {versionOptions.map((version) => (
                <option key={version.version_id} value={version.version_id}>v{version.version_no}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted lg:col-span-2">Từ ngày
            <input className={inputClass} type="date" value={draft.from}
              onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted lg:col-span-2">Đến ngày
            <input className={inputClass} type="date" value={draft.to}
              onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted lg:col-span-2">Nhóm
            <select className={inputClass} value={draft.teamId}
              onChange={(event) => setDraft((current) => ({ ...current, teamId: event.target.value }))}>
              <option value="">Tất cả nhóm</option>
              {teams.map((team) => <option key={team.team_id} value={team.team_id}>{team.display_name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted lg:col-span-2">Nhân viên
            <select className={inputClass} value={draft.assigneeId}
              onChange={(event) => setDraft((current) => ({ ...current, assigneeId: event.target.value }))}>
              <option value="">Tất cả nhân viên</option>
              {assignees.map((assignee) => <option key={assignee.app_user_id} value={assignee.app_user_id}>{assignee.display_name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted lg:col-span-2">Trạng thái
            <select className={inputClass} value={draft.state}
              onChange={(event) => setDraft((current) => ({ ...current, state: event.target.value }))}>
              <option value="">Tất cả trạng thái</option>
              {Object.entries(WORK_REPORT_READABLE_STATE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <div className="flex gap-2 lg:col-span-12">
            <Button type="button" disabled={busy} onClick={() => setFilters(draft)}>Lọc</Button>
            <Button type="button" variant="ghost" onClick={() => { setDraft(EMPTY_FILTERS); setFilters(EMPTY_FILTERS); }}>
              Xóa bộ lọc
            </Button>
          </div>
        </div>
      </FilterToolbar>

      {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
      {view === "loading" ? <p role="status" className="py-8 text-center text-sm text-muted">Đang tải bài nộp…</p> : null}
      {view === "denied" ? <StatusBanner tone="warning">Bạn không có quyền xem danh sách bài nộp trong phạm vi này.</StatusBanner> : null}
      {view === "error" ? <StatusBanner tone="error">Không tải được danh sách bài nộp.</StatusBanner> : null}
      {view === "ready" && items.length === 0 ? <StatusBanner>Không có bài nộp nào phù hợp với bộ lọc.</StatusBanner> : null}

      {view === "ready" && items.length > 0 ? (
        <DataTableContainer scrollClassName="overflow-x-auto">
          <table className={DATA_TABLE_CLASS + " min-w-[900px]"}>
            <thead className={DATA_TABLE_HEAD_CLASS}>
              <tr>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Mẫu</th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Phiên bản</th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Người nộp</th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Nhóm</th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Kỳ</th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Trạng thái</th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Nộp gần nhất</th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Hạn</th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Bản</th>
                <th scope="col" className={DATA_TABLE_TH_CLASS + " text-right"}>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.obligation_id} className={DATA_TABLE_ROW_CLASS}>
                  <td className={DATA_TABLE_TD_CLASS} data-card-header="true">{item.template_name}</td>
                  <td className={DATA_TABLE_TD_CLASS} data-label="Phiên bản">v{item.template_version_no}</td>
                  <td className={DATA_TABLE_TD_CLASS} data-label="Người nộp">{item.assignee_display_name}</td>
                  <td className={DATA_TABLE_TD_CLASS} data-label="Nhóm">{item.team_display_name ?? "—"}</td>
                  <td className={DATA_TABLE_TD_CLASS + " font-mono tabular-nums whitespace-nowrap"} data-label="Kỳ">{item.period_key}</td>
                  <td className={DATA_TABLE_TD_CLASS} data-label="Trạng thái">
                    <Badge tone={readerStateTone(item.state)}>{readerStateLabel(item.state)}</Badge>
                  </td>
                  <td className={DATA_TABLE_TD_CLASS + " whitespace-nowrap"} data-label="Nộp gần nhất">{formatReaderDateTime(item.latest_submitted_at)}</td>
                  <td className={DATA_TABLE_TD_CLASS} data-label="Hạn">
                    {item.is_late ? <Badge tone="danger">Nộp muộn</Badge> : <Badge tone="success">Đúng hạn</Badge>}
                    {item.has_post_deadline_amendment ? <span className="ml-1 text-xs text-muted">· sửa sau hạn</span> : null}
                  </td>
                  <td className={DATA_TABLE_TD_CLASS + " font-mono tabular-nums"} data-label="Bản">{item.current_revision_no}</td>
                  <td className={DATA_TABLE_TD_CLASS + " text-right"} data-card-actions="true">
                    <RowActionCluster>
                      <Button size="sm" variant="outline" onClick={() => void openDetail(item)}>Xem báo cáo</Button>
                    </RowActionCluster>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTableContainer>
      ) : null}

      {view === "ready" && payload?.has_more ? (
        <div className="flex justify-center">
          <CursorLoadMore hasMore loading={busy} onLoadMore={() => void fetchList(filters, cursor, true)} />
        </div>
      ) : null}

      <FormDialog
        open={detailOpen}
        onOpenChange={(open) => { if (!open) setDetailOpen(false); }}
        title={detail ? detail.value.template.display_name : "Chi tiết báo cáo"}
        description={detail ? `Phiên bản v${detail.item.template_version_no} · ${detail.item.assignee_display_name}` : undefined}
        descriptionId="reader-detail-desc"
        closeAriaLabel="Đóng chi tiết báo cáo"
        contentClassName="sm:w-[min(44rem,calc(100vw-2rem))]"
      >
        {detailView === "loading" ? <p role="status" className="text-sm text-muted">Đang tải nội dung báo cáo…</p> : null}
        {detailView === "error" ? <StatusBanner tone="error">Không mở được nội dung báo cáo trong phạm vi quyền hiện tại.</StatusBanner> : null}
        {detailView === "ready" && detail ? (
          <div className="space-y-4">
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <p><span className="text-muted">Người nộp:</span> {detail.item.assignee_display_name}</p>
              <p><span className="text-muted">Nhóm:</span> {teamLabel}</p>
              <p><span className="text-muted">Kỳ:</span> {detail.value.obligation.period_key} ({detail.value.obligation.period_start_date} → {detail.value.obligation.period_end_date})</p>
              <p><span className="text-muted">Hạn nộp:</span> {formatReaderDateTime(detail.value.obligation.due_at)}</p>
              <p><span className="text-muted">Nộp lần đầu:</span> {formatReaderDateTime(detail.value.submission?.first_submitted_at ?? null)}</p>
              <p><span className="text-muted">Nộp gần nhất:</span> {formatReaderDateTime(detail.value.submission?.latest_submitted_at ?? null)}</p>
              <p><span className="text-muted">Trạng thái:</span> <Badge tone={readerStateTone(detail.value.submission?.state ?? "")}>{readerStateLabel(detail.value.submission?.state ?? "")}</Badge></p>
              <p className="flex flex-wrap gap-1.5">
                {detail.value.submission?.is_late ? <Badge tone="danger">Nộp muộn</Badge> : null}
                {detail.value.submission?.has_post_deadline_amendment ? <Badge tone="warning">Sửa sau hạn</Badge> : null}
                {currentRevision ? <Badge tone="primary">Bản hiện hành {currentRevision.revision_no}</Badge> : null}
              </p>
            </div>
            <ReportReviewHistory event={detail.value.latest_review_event} />
            <ReportReadonlyContent schema={detail.value.template.schema_json} payload={currentRevision?.payload_json ?? {}} />
            <ReportRevisionList revisions={detail.value.revisions} currentRevisionId={detail.value.submission?.current_revision_id ?? null} />
          </div>
        ) : null}
      </FormDialog>
    </div>
  );
}
