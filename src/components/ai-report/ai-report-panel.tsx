"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildReportRequest,
  codeToMessage,
  isFailedJobStatus,
  jobStatusLabel,
  lifecycleLabel,
  reportTitleForPeriod,
  DIMENSIONS,
  DIMENSION_LABELS,
  PERIOD_TYPES,
  type AnalysisView,
  type CapabilityView,
  type Dimension,
  type PeriodType,
  type ReportPeriodView,
} from "@/lib/ai-report/report-contract";
import { createReportController, type FetchResult } from "@/lib/ai-report/report-controller";
import { formatTimestamp, todayDateIso } from "@/lib/format";
import { resolveTabTarget } from "@/components/dashboard/ai-settings-panel-logic";
import { ReportView } from "./report-view";

const POLL_INTERVAL_MS = 2000;
const HISTORY_PATH = "/api/ai/reports/history";

type JobStatusView = { status: string; error_code: string | null; attempts: number; max_attempts: number };
type HistoryItem = { job_id: string; status: string; lifecycle_status: string | null; created_at: string; revision_number: number | null; period: ReportPeriodView };

async function fetchJson(path: string, options: { method: "GET" | "POST"; body?: Record<string, unknown>; signal?: AbortSignal }): Promise<FetchResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method,
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
      headers: options.body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    return { ok: false, httpStatus: 0, code: "AI_INTERNAL", message: "Không kết nối được tới server." };
  }
  let payload: unknown = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const code = typeof record.code === "string" ? record.code : "AI_INTERNAL";
    return { ok: false, httpStatus: response.status, code, message: codeToMessage(code).text };
  }
  return { ok: true, httpStatus: response.status, code: "AI_INTERNAL", record: payload };
}

const inputClass = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary";
const primaryButtonClass = "inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary/90 disabled:opacity-50";
const secondaryButtonClass = "inline-flex h-9 items-center rounded-lg border border-border bg-surface px-3 text-sm font-medium text-foreground hover:bg-surface/80 disabled:opacity-50";

function Skeleton() {
  return (
    <div aria-hidden className="flex animate-pulse flex-col gap-3">
      <div className="h-9 rounded-lg bg-muted/40" />
      <div className="h-24 rounded-2xl bg-muted/40" />
      <div className="h-40 rounded-2xl bg-muted/40" />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1 last:border-b-0">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

export function AiReportPanel() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [capability, setCapability] = useState<CapabilityView | null>(null);
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [periodType, setPeriodType] = useState<PeriodType>("week");
  const [asOf, setAsOf] = useState(() => todayDateIso());
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [dimensions, setDimensions] = useState<Dimension[]>(["project", "provider", "employment"]);
  const [focus, setFocus] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatusView | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisView | null>(null);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  const [revisionNumber, setRevisionNumber] = useState<number | null>(null);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [regenerateReason, setRegenerateReason] = useState("");
  const [reviewOpen, setReviewOpen] = useState<null | "approve" | "reject">(null);
  const [rejectReason, setRejectReason] = useState("");

  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const controllerRef = useRef<ReturnType<typeof createReportController> | null>(null);

  function getController() {
    if (!controllerRef.current) {
      controllerRef.current = createReportController({
        fetchJson,
        interval_ms: POLL_INTERVAL_MS,
        events: {
          onCapability: (cap, err) => { setCapability(cap); setErrorText(err ?? ""); },
          onJob: (id, view, err) => {
            if (err) {
              setErrorText(err);
              setStatusText("Không đọc được trạng thái báo cáo.");
              setJobStatus((cur) => cur ?? { status: "failed_internal", error_code: "AI_INTERNAL", attempts: 0, max_attempts: 1 });
              return;
            }
            if (view) {
              setJobStatus({ status: view.status, error_code: view.error_code, attempts: view.attempts, max_attempts: view.max_attempts });
              if (view.revision) {
                setAnalysis(view.revision.analysis);
                setLifecycle(view.revision.lifecycle_status);
                setRevisionNumber(view.revision.revision_number);
              } else {
                setAnalysis(null); setLifecycle(null); setRevisionNumber(null);
              }
            }
          },
        },
      });
    }
    return controllerRef.current;
  }

  const close = useCallback(() => { setOpen(false); triggerRef.current?.focus(); }, []);
  const requestClose = useCallback(() => { if (busy) return; close(); }, [busy, close]);

  const loadCapability = useCallback(async () => {
    setBusy(true); setErrorText("");
    await getController().loadCapability();
    setBusy(false);
  }, []);

  const loadHistory = useCallback(async (cursor: string | null) => {
    setHistoryLoading(true); setHistoryError("");
    const qs = cursor ? "?cursor=" + encodeURIComponent(cursor) + "&page_size=20" : "?page_size=20";
    const result = await fetchJson(HISTORY_PATH + qs, { method: "GET" });
    setHistoryLoading(false);
    if (!result.ok) { setHistoryError(result.message); return; }
    const record = result.record as Record<string, unknown>;
    const items = Array.isArray(record.items) ? (record.items as HistoryItem[]) : [];
    const next = typeof record.next_cursor === "string" ? record.next_cursor : null;
    const hasMore = record.has_more === true;
    setHistoryItems((cur) => (cursor ? [...cur, ...items] : items));
    setHistoryCursor(next);
    setHistoryHasMore(hasMore);
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => { void loadCapability(); }, 0);
    return () => clearTimeout(timer);
  }, [open, loadCapability]);

  useEffect(() => {
    if (open && capability !== null) {
      const timer = setTimeout(() => { void loadHistory(null); }, 0);
      return () => clearTimeout(timer);
    }
  }, [open, capability, loadHistory]);

  useEffect(() => { if (!open) getController().stopPolling(); }, [open]);
  useEffect(() => () => getController().stopPolling(), []);

  useEffect(() => {
    if (!open) return;
    drawerRef.current?.focus();
    const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=-1])";
    const focusables = () => {
      const nodes = drawerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      return nodes ? Array.from(nodes) : [];
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); requestClose(); return; }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) { event.preventDefault(); drawerRef.current?.focus(); return; }
      const active = document.activeElement;
      const activeIndex = active ? items.indexOf(active as HTMLElement) : -1;
      const inside = drawerRef.current?.contains(active) ?? false;
      const target = resolveTabTarget({ total: items.length, activeIndex, shiftKey: event.shiftKey, inside });
      if (target.prevent && target.index >= 0) { event.preventDefault(); items[target.index].focus(); }
    };
    const onFocusIn = (event: FocusEvent) => {
      const node = event.target as Node | null;
      if (!drawerRef.current || !node) return;
      if (drawerRef.current.contains(node)) return;
      const items = focusables();
      if (items.length > 0) items[0].focus(); else drawerRef.current.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [open, requestClose]);

  useEffect(() => {
    if (open && capability !== null && document.activeElement === drawerRef.current) {
      firstFieldRef.current?.focus();
    }
  }, [open, capability]);

  function toggleDimension(dimension: Dimension) {
    setDimensions((current) => (current.includes(dimension) ? current.filter((item) => item !== dimension) : [...current, dimension]));
  }

  async function handleSubmit() {
    if (busy) return;
    if (asOf.trim() === "") { setErrorText("Vui lòng chọn ngày (as-of)."); return; }
    if (periodType === "custom" && (customFrom.trim() === "" || customTo.trim() === "")) { setErrorText("Kỳ tùy chỉnh cần đủ từ/đến ngày."); return; }
    if (dimensions.length === 0) { setErrorText("Chọn ít nhất một chiều phân tích."); return; }
    setBusy(true); setErrorText(""); setStatusText("Đang gửi yêu cầu tạo báo cáo AI…");
    const body = buildReportRequest({ period_type: periodType, as_of_date: asOf.trim(), custom_from: customFrom.trim() || undefined, custom_to: customTo.trim() || undefined, dimensions, focus: focus.trim() || undefined });
    const result = await getController().enqueue(body);
    setBusy(false);
    if (!result.ok) { setErrorText(result.message); setStatusText("Không tạo được báo cáo AI."); return; }
    setJobId(result.jobId); setAnalysis(null); setLifecycle(null); setRevisionNumber(null);
    setStatusText("Đã gửi yêu cầu. Đang theo dõi trạng thái…");
    void loadHistory(null);
  }

  async function handleRegenerate() {
    if (busy || !jobId) return;
    if (!(capability?.review.regenerate === true)) { setErrorText("Tạo lại báo cáo chưa khả dụng."); return; }
    if (regenerateReason.trim().length < 3) { setErrorText("Lý do tạo lại cần ít nhất 3 ký tự."); return; }
    setBusy(true); setErrorText(""); setStatusText("Đang tạo lại báo cáo AI…");
    const period = periodType === "custom" ? { type: periodType, as_of_date: asOf.trim(), custom_from: customFrom.trim(), custom_to: customTo.trim() } : { type: periodType, as_of_date: asOf.trim() };
    const result = await getController().enqueue({ regenerate_of: jobId, reason: regenerateReason.trim(), period, scope: { dimensions } });
    setBusy(false);
    if (!result.ok) { setErrorText(result.message); setStatusText("Không tạo lại được báo cáo."); return; }
    setRegenerateOpen(false); setRegenerateReason(""); setJobId(result.jobId); setAnalysis(null); setLifecycle(null); setRevisionNumber(null);
    setStatusText("Đã gửi yêu cầu tạo lại. Đang theo dõi…");
    void loadHistory(null);
  }

  async function submitReview() {
    if (busy || !jobId || !revisionNumber || reviewOpen === null) return;
    if (reviewOpen === "reject" && (rejectReason.trim().length < 3)) { setErrorText("Lý do từ chối cần ít nhất 3 ký tự."); return; }
    setBusy(true); setErrorText("");
    const body = { decision: reviewOpen, expected_revision_number: revisionNumber, reason: reviewOpen === "reject" ? rejectReason.trim() : undefined };
    const result = await fetchJson("/api/ai/reports/" + encodeURIComponent(jobId) + "/review", { method: "POST", body });
    setBusy(false);
    if (!result.ok) {
      setErrorText(result.message);
      setStatusText(result.code === "AI_VERSION_CONFLICT" || result.code === "AI_REVIEW_CONFLICT" ? "Quyết định không áp dụng được, đang tải lại…" : "Duyệt báo cáo thất bại.");
      setReviewOpen(null);
      if (result.code === "AI_VERSION_CONFLICT" || result.code === "AI_REVIEW_CONFLICT") { getController().startPolling(jobId); void loadHistory(null); }
      return;
    }
    const record = result.record as Record<string, unknown>;
    const newLifecycle = typeof record.lifecycle_status === "string" ? record.lifecycle_status : reviewOpen === "approve" ? "approved" : "rejected";
    setLifecycle(newLifecycle);
    setReviewOpen(null); setRejectReason("");
    setStatusText(newLifecycle === "approved" ? "Đã duyệt báo cáo." : "Đã từ chối báo cáo.");
    void loadHistory(null);
  }

  function openHistoryItem(id: string) {
    setJobId(id); setAnalysis(null); setLifecycle(null); setRevisionNumber(null); setStatusText("Đang tải lại báo cáo…");
    getController().startPolling(id);
  }

  const unavailable = capability === null ? null : !capability.ai_enabled ? "Báo cáo AI đang tắt." : !capability.config_ready ? "Chưa có cấu hình provider AI hoạt động (AI unavailable)." : null;
  const canApprove = capability?.review.approve === true && lifecycle === "draft";
  const canReject = capability?.review.reject === true && lifecycle === "draft";
  const currentHistoryItem = jobId ? historyItems.find((item) => item.job_id === jobId) ?? null : null;

  return (
    <div className="relative">
      <button ref={triggerRef} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls="ai-report-drawer" onClick={() => (open ? requestClose() : setOpen(true))} className={secondaryButtonClass}>Tạo báo cáo AI</button>
      {open ? (
        <>
          <div aria-hidden onClick={requestClose} className="fixed inset-0 z-40 bg-black/40" />
          <aside ref={drawerRef} id="ai-report-drawer" role="dialog" aria-modal="true" aria-labelledby="ai-report-title" tabIndex={-1} className="fixed inset-0 z-50 flex flex-col gap-4 overflow-y-auto border border-border bg-surface p-4 text-foreground shadow-xl sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[32rem] sm:rounded-l-2xl sm:p-5">
            <header className="flex items-start justify-between gap-3">
              <div>
                <h2 id="ai-report-title" className="text-base font-semibold text-foreground">Báo cáo AI</h2>
                <p className="mt-1 text-sm text-muted">Tạo và xem báo cáo phân tích tuyển dụng (bản nháp AI).</p>
              </div>
              <button type="button" onClick={requestClose} disabled={busy} className={secondaryButtonClass}>Đóng</button>
            </header>
            <p role="status" aria-live="polite" className="rounded-2xl border border-border bg-surface p-3 text-sm text-muted">
              <span>{statusText}</span>
              {errorText ? <span className="mt-1 block font-medium text-foreground">{errorText}</span> : null}
            </p>
            {capability === null ? (
              <Skeleton />
            ) : unavailable ? (
              <p role="alert" className="rounded-2xl border border-border bg-surface p-4 text-sm text-foreground">{unavailable}<span className="mt-1 block text-muted">Dashboard P1 vẫn hoạt động bình thường.</span></p>
            ) : (
              <form onSubmit={(event) => { event.preventDefault(); void handleSubmit(); }} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="ai-report-period" className="text-sm font-medium text-foreground">Kỳ</label>
                  <select id="ai-report-period" value={periodType} onChange={(event) => setPeriodType(event.target.value as PeriodType)} disabled={busy} className={inputClass}>
                    {PERIOD_TYPES.map((type) => (<option key={type} value={type}>{type === "week" ? "Tuần" : type === "month" ? "Tháng" : type === "quarter" ? "Quý" : "Tùy chỉnh"}</option>))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="ai-report-asof" className="text-sm font-medium text-foreground">Ngày chốt (as-of)</label>
                  <input id="ai-report-asof" ref={firstFieldRef} type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} disabled={busy} className={inputClass} />
                </div>
                {periodType === "custom" ? (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1"><label htmlFor="ai-report-from" className="text-sm font-medium text-foreground">Từ</label><input id="ai-report-from" type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} disabled={busy} className={inputClass} /></div>
                    <div className="flex flex-col gap-1"><label htmlFor="ai-report-to" className="text-sm font-medium text-foreground">Đến</label><input id="ai-report-to" type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} disabled={busy} className={inputClass} /></div>
                  </div>
                ) : null}
                <fieldset className="rounded-lg border border-border p-3">
                  <legend className="px-1 text-sm font-medium text-foreground">Chiều phân tích</legend>
                  <div className="flex flex-wrap gap-2">
                    {DIMENSIONS.map((dimension) => (<label key={dimension} className="inline-flex items-center gap-1.5 text-sm text-foreground"><input type="checkbox" checked={dimensions.includes(dimension)} onChange={() => toggleDimension(dimension)} disabled={busy} />{DIMENSION_LABELS[dimension]}</label>))}
                  </div>
                  <p className="mt-1 text-xs text-muted">Người tuyển/Nhóm cần danh mục định danh P1.6 — server sẽ từ chối an toàn nếu chưa sẵn sàng.</p>
                </fieldset>
                <div className="flex flex-col gap-1">
                  <label htmlFor="ai-report-focus" className="text-sm font-medium text-foreground">Mục tiêu phân tích (không bắt buộc)</label>
                  <input id="ai-report-focus" type="text" value={focus} onChange={(event) => setFocus(event.target.value)} disabled={busy} placeholder="Ví dụ: điểm mạnh/yếu, thời điểm, phụ thuộc Vendor" className={inputClass} />
                </div>
                <button type="submit" disabled={busy} className={primaryButtonClass}>Tạo báo cáo AI</button>
              </form>
            )}
            {jobId ? (
              <section aria-label="Trạng thái báo cáo" className="rounded-2xl border border-border bg-surface p-3">
                <h3 className="text-sm font-semibold text-foreground">Báo cáo hiện tại</h3>
                <dl className="mt-2 text-sm">
                  <DetailRow label="Tên báo cáo" value={currentHistoryItem ? reportTitleForPeriod(currentHistoryItem.period) : "Báo cáo AI"} />
                  <DetailRow label="Trạng thái" value={jobStatus ? jobStatusLabel(jobStatus.status) : "—"} />
                  {jobStatus && isFailedJobStatus(jobStatus.status) && jobStatus.error_code ? (<DetailRow label="Lý do" value={codeToMessage(jobStatus.error_code).text} />) : null}
                  {jobStatus ? (<DetailRow label="Lần thử" value={jobStatus.attempts + " / " + jobStatus.max_attempts} />) : null}
                  <DetailRow label="Tạo lúc" value={formatTimestamp(currentHistoryItem?.created_at)} />
                  <DetailRow label="Mã" value={jobId.slice(0, 8)} />
                </dl>
              </section>
            ) : null}
            {analysis ? (<ReportView analysis={analysis} lifecycle={lifecycle} />) : null}
            {analysis ? (
              <section aria-label="Duyệt báo cáo" className="rounded-2xl border border-border bg-surface p-3">
                <h4 className="text-sm font-semibold text-foreground">Duyệt báo cáo</h4>
                {reviewOpen ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <p className="text-sm text-foreground">{reviewOpen === "approve" ? "Duyệt bản nháp này?" : "Từ chối bản nháp này?"}</p>
                    {reviewOpen === "reject" ? (
                      <div className="flex flex-col gap-1">
                        <label htmlFor="ai-review-reason" className="text-sm font-medium text-foreground">Lý do từ chối</label>
                        <textarea id="ai-review-reason" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} rows={2} disabled={busy} className={inputClass} />
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => void submitReview()} disabled={busy} className={primaryButtonClass}>Xác nhận</button>
                      <button type="button" onClick={() => { setReviewOpen(null); setRejectReason(""); }} disabled={busy} className={secondaryButtonClass}>Hủy</button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" onClick={() => setReviewOpen("approve")} disabled={busy || !canApprove} className={primaryButtonClass}>Duyệt</button>
                    <button type="button" onClick={() => setReviewOpen("reject")} disabled={busy || !canReject} className={secondaryButtonClass}>Từ chối</button>
                    <button type="button" onClick={() => setRegenerateOpen(true)} disabled={busy || !(capability?.review.regenerate === true)} className={secondaryButtonClass}>Tạo lại báo cáo</button>
                  </div>
                )}
                {regenerateOpen ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <label htmlFor="ai-report-reason" className="text-sm font-medium text-foreground">Lý do tạo lại</label>
                    <textarea id="ai-report-reason" value={regenerateReason} onChange={(event) => setRegenerateReason(event.target.value)} rows={2} disabled={busy} className={inputClass} />
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => void handleRegenerate()} disabled={busy} className={primaryButtonClass}>Xác nhận tạo lại</button>
                      <button type="button" onClick={() => { setRegenerateOpen(false); setRegenerateReason(""); }} disabled={busy} className={secondaryButtonClass}>Hủy</button>
                    </div>
                  </div>
                ) : null}
                {!canApprove && !canReject && lifecycle !== "draft" ? <p className="mt-2 text-xs text-muted">Báo cáo này đã {lifecycleLabel(lifecycle)}.</p> : null}
                {lifecycle === "draft" && !(canApprove || canReject) ? <p className="mt-2 text-xs text-muted">Duyệt/từ chối sẽ khả dụng khi migration review được áp dụng.</p> : null}
              </section>
            ) : null}
            <section aria-label="Lịch sử báo cáo" className="rounded-2xl border border-border bg-surface p-3">
              <h3 className="text-sm font-semibold text-foreground">Lịch sử</h3>
              {historyLoading && historyItems.length === 0 ? (<p className="mt-2 text-sm text-muted">Đang tải lịch sử…</p>) : null}
              {historyError ? <p className="mt-2 text-sm text-foreground">{historyError}</p> : null}
              {!historyLoading && !historyError && historyItems.length === 0 ? (<p className="mt-2 text-sm text-muted">Chưa có báo cáo nào.</p>) : null}
              {historyItems.length > 0 ? (
                <ul className="mt-2 space-y-1 text-sm">
                  {historyItems.map((item) => (
                    <li key={item.job_id}><button type="button" onClick={() => openHistoryItem(item.job_id)} className="flex w-full items-start justify-between gap-3 rounded-lg px-2 py-2 text-left text-foreground hover:bg-surface/80"><span className="min-w-0"><span className="block font-medium">{reportTitleForPeriod(item.period)}</span><span className="mt-0.5 block font-mono text-xs text-muted">Mã {item.job_id.slice(0, 8)}</span></span><span className="shrink-0 text-right text-muted"><span className="block">{jobStatusLabel(item.status)}{item.lifecycle_status ? " · " + lifecycleLabel(item.lifecycle_status) : ""}</span><span className="block text-xs">{formatTimestamp(item.created_at)}</span></span></button></li>
                  ))}
                </ul>
              ) : null}
              {historyHasMore ? (<button type="button" onClick={() => void loadHistory(historyCursor)} disabled={historyLoading} className={secondaryButtonClass}>Tải thêm</button>) : null}
            </section>
          </aside>
        </>
      ) : null}
    </div>
  );
}
