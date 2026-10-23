"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CursorLoadMore } from "@/components/ui/cursor-load-more";
import { DataTableContainer, DATA_TABLE_CLASS, DATA_TABLE_HEAD_CLASS, DATA_TABLE_ROW_CLASS, DATA_TABLE_TD_CLASS, DATA_TABLE_TH_CLASS, RowActionCluster } from "@/components/ui/data-table";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { FormDialog } from "@/components/ui/form-dialog";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  findCurrentRevision,
  formatReaderDateTime,
  mergeReaderItems,
  parseReaderDetail,
  parseReaderList,
  readerListQuery,
  readerStateLabel,
  WORK_REPORT_READABLE_STATE_LABELS,
  type ReaderDetail,
  type ReaderListFilters,
  type ReaderListItem,
  type ReaderListPayload,
} from "@/lib/work-reports/reader-ui-model.ts";
import { ReportReadonlyContent, ReportReviewHistory, ReportRevisionList } from "./report-readonly-content";

const EMPTY_FILTERS: ReaderListFilters = {
  templateId: "", versionId: "", from: "", to: "", teamId: "", assigneeId: "", state: "",
};

const inputClass = "min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

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
  const [reloadToken, setReloadToken] = useState(0);
  const generation = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const detailGeneration = useRef(0);
  const detailControllerRef = useRef<AbortController | null>(null);

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
  }, [filters, fetchList, reloadToken]);

  useEffect(() => {
    return () => { detailGeneration.current += 1; detailControllerRef.current?.abort(); };
  }, []);

  async function openDetail(item: ReaderListItem) {
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    const gen = ++detailGeneration.current;
    setDetail(null);
    setDetailOpen(true);
    setDetailView("loading");
    try {
      const response = await fetch(`/api/work-reports/submissions/${encodeURIComponent(item.obligation_id)}`, {
        cache: "no-store", signal: controller.signal, headers: { accept: "application/json" },
      });
      const body = await response.json().catch(() => null);
      const value = response.ok ? parseReaderDetail(body) : null;
      if (gen !== detailGeneration.current) return;
      if (!value) { setDetailView("error"); return; }
      setDetail({ item, value });
      setDetailView("ready");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (gen !== detailGeneration.current) return;
      setDetailView("error");
    }
  }

  function closeDetail() {
    detailGeneration.current += 1;
    detailControllerRef.current?.abort();
    setDetailOpen(false);
  }

  const templates = payload?.filter_options.templates ?? [];
  const selectedTemplate = templates.find((template) => template.template_id === draft.templateId);
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

      {view === "loading" ? <p role="status" className="py-8 text-center text-sm text-muted">Đang tải bài nộp…</p> : null}
      {view === "denied" ? <StatusBanner tone="warning">Bạn không có quyền xem danh sách bài nộp trong phạm vi này.</StatusBanner> : null}
      {view === "error" ? (
        <StatusBanner tone="error">
          <div className="flex flex-wrap items-center gap-2">
            <span>{error ?? "Không tải được danh sách bài nộp."}</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => setReloadToken((value) => value + 1)}>Thử lại</Button>
          </div>
        </StatusBanner>
      ) : null}
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
        onOpenChange={(open) => { if (!open) closeDetail(); }}
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
