"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildReportRequest,
  codeToMessage,
  confidenceLabel,
  findingCategoryLabel,
  groupFindings,
  isActiveJobStatus,
  isFailedJobStatus,
  jobStatusLabel,
  lifecycleLabel,
  DIMENSIONS,
  DIMENSION_LABELS,
  PERIOD_TYPES,
  type AnalysisView,
  type CapabilityView,
  type Dimension,
  type PeriodType,
} from "@/lib/ai-report/report-contract";

const REPORTS_PATH = "/api/ai/reports";
const CAPABILITY_PATH = "/api/ai/reports/capability";

type JobStatusView = { status: string; error_code: string | null; attempts: number; max_attempts: number };
type HistoryItem = { job_id: string; status: string };
type CallResult =
  | { ok: true; httpStatus: number; code: string; record: Record<string, unknown> }
  | { ok: false; httpStatus: number; code: string; message: string };

function analysisPath(jobId: string): string {
  return REPORTS_PATH + "/" + encodeURIComponent(jobId) + "/analysis";
}

async function callJson(path: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<CallResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, httpStatus: 0, code: "AI_INTERNAL", message: "Không kết nối được tới server." };
  }
  let payload: unknown = null;
  try { payload = await response.json(); } catch { payload = null; }
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const code = typeof record.code === "string" ? record.code : "AI_INTERNAL";
  if (!response.ok || record.ok !== true) {
    return { ok: false, httpStatus: response.status, code, message: codeToMessage(code).text };
  }
  return { ok: true, httpStatus: response.status, code, record };
}

const inputClass = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary";
const primaryButtonClass = "inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary/90 disabled:opacity-50";
const secondaryButtonClass = "inline-flex h-9 items-center rounded-lg border border-border bg-surface px-3 text-sm font-medium text-foreground hover:bg-surface/80 disabled:opacity-50";

function todayIso(): string { return new Date().toISOString().slice(0, 10); }

export function AiReportPanel() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [capability, setCapability] = useState<CapabilityView | null>(null);
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [periodType, setPeriodType] = useState<PeriodType>("week");
  const [asOf, setAsOf] = useState(todayIso());
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [dimensions, setDimensions] = useState<Dimension[]>(["project", "provider", "employment"]);
  const [focus, setFocus] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatusView | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisView | null>(null);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [regenerateReason, setRegenerateReason] = useState("");

  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const close = useCallback(() => { setOpen(false); triggerRef.current?.focus(); }, []);
  const requestClose = useCallback(() => { if (busy) return; close(); }, [busy, close]);

  const loadCapability = useCallback(async () => {
    setBusy(true); setErrorText("");
    const result = await callJson(CAPABILITY_PATH, "GET");
    if (result.ok) {
      setCapability(result.record as unknown as CapabilityView);
    } else {
      setCapability({ ai_enabled: false, config_ready: false, review: { approve: false, reject: false, regenerate: true, reason: result.code } });
      setErrorText(result.message);
    }
    setBusy(false);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  function applyStatus(record: Record<string, unknown>): string {
    setJobStatus({
      status: String(record.status ?? ""),
      error_code: typeof record.error_code === "string" ? record.error_code : null,
      attempts: Number(record.attempts ?? 0),
      max_attempts: Number(record.max_attempts ?? 0),
    });
    const revision = record.revision as { lifecycle_status?: string; analysis?: AnalysisView } | null;
    if (revision && revision.analysis) { setAnalysis(revision.analysis); setLifecycle(revision.lifecycle_status ?? "draft"); }
    else { setAnalysis(null); setLifecycle(null); }
    return String(record.status ?? "");
  }

  const startPolling = useCallback((id: string) => {
    stopPolling();
    void callJson(analysisPath(id), "GET").then((result) => { if (result.ok) { const status = applyStatus(result.record); if (!isActiveJobStatus(status)) stopPolling(); } });
    pollRef.current = setInterval(async () => {
      const result = await callJson(analysisPath(id), "GET");
      if (!result.ok) return;
      const status = applyStatus(result.record);
      if (!isActiveJobStatus(status)) { stopPolling(); if (result.record.revision) setStatusText("Đã có bản nháp AI."); }
    }, 2000);
  }, [stopPolling]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => { void loadCapability(); }, 0);
    return () => clearTimeout(timer);
  }, [open, loadCapability]);

  useEffect(() => {
    if (!open) return;
    firstFieldRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); requestClose(); } };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, requestClose]);

  useEffect(() => () => stopPolling(), [stopPolling]);

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
    const result = await callJson(REPORTS_PATH, "POST", body);
    setBusy(false);
    if (!result.ok) { setErrorText(result.message); setStatusText("Không tạo được báo cáo AI."); return; }
    const id = String(result.record.request_id ?? result.record.job_id ?? "");
    if (id === "") { setErrorText("Server không trả về mã báo cáo."); return; }
    setJobId(id); setAnalysis(null); setLifecycle(null);
    setHistory((current) => [{ job_id: id, status: "requested" }, ...current.filter((item) => item.job_id !== id)]);
    setStatusText("Đã gửi yêu cầu. Đang theo dõi trạng thái…");
    startPolling(id);
  }

  async function handleRegenerate() {
    if (busy || !jobId) return;
    if (regenerateReason.trim().length < 3) { setErrorText("Lý do tạo lại cần ít nhất 3 ký tự."); return; }
    setBusy(true); setErrorText(""); setStatusText("Đang tạo lại báo cáo AI…");
    const period = periodType === "custom" ? { type: periodType, as_of_date: asOf.trim(), custom_from: customFrom.trim(), custom_to: customTo.trim() } : { type: periodType, as_of_date: asOf.trim() };
    const result = await callJson(REPORTS_PATH, "POST", { regenerate_of: jobId, reason: regenerateReason.trim(), period, scope: { dimensions } });
    setBusy(false);
    if (!result.ok) { setErrorText(result.message); setStatusText("Không tạo lại được báo cáo."); return; }
    const id = String(result.record.request_id ?? result.record.job_id ?? "");
    setRegenerateOpen(false); setRegenerateReason(""); setJobId(id); setAnalysis(null); setLifecycle(null);
    setHistory((current) => [{ job_id: id, status: "requested" }, ...current]);
    setStatusText("Đã gửi yêu cầu tạo lại. Đang theo dõi…");
    startPolling(id);
  }

  function openHistoryItem(id: string) { setJobId(id); setAnalysis(null); setLifecycle(null); setStatusText("Đang tải lại báo cáo…"); startPolling(id); }

  const unavailable = capability === null ? null : !capability.ai_enabled ? "Báo cáo AI đang tắt." : !capability.config_ready ? "Chưa có cấu hình provider AI hoạt động (AI unavailable)." : null;

  return (
    <div className="relative">
      <button ref={triggerRef} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls="ai-report-drawer" onClick={() => (open ? requestClose() : setOpen(true))} className={secondaryButtonClass}>Tạo báo cáo AI</button>
      {open ? (
        <>
          <div aria-hidden onClick={requestClose} className="fixed inset-0 z-40 bg-black/40" />
          <aside id="ai-report-drawer" role="dialog" aria-modal="true" aria-labelledby="ai-report-title" className="fixed inset-0 z-50 flex flex-col gap-4 overflow-y-auto border border-border bg-surface p-4 text-foreground shadow-xl sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[32rem] sm:rounded-l-2xl sm:p-5">
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
            {unavailable ? (
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
                  <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted">Trạng thái</dt><dd className="text-right font-medium text-foreground">{jobStatus ? jobStatusLabel(jobStatus.status) : "—"}</dd></div>
                  {jobStatus && isFailedJobStatus(jobStatus.status) && jobStatus.error_code ? (<div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted">Lý do</dt><dd className="text-right font-medium text-foreground">{codeToMessage(jobStatus.error_code).text}</dd></div>) : null}
                  {jobStatus ? (<div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted">Lần thử</dt><dd className="text-right font-medium text-foreground">{jobStatus.attempts + " / " + jobStatus.max_attempts}</dd></div>) : null}
                  <div className="flex items-baseline justify-between gap-3 py-1"><dt className="text-muted">Mã</dt><dd className="text-right font-medium text-foreground">{jobId.slice(0, 8)}</dd></div>
                </dl>
              </section>
            ) : null}
            {analysis ? (
              <section aria-label="Nội dung báo cáo" className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center rounded-full border border-border bg-surface px-2 py-0.5 text-xs font-medium text-foreground">{lifecycleLabel(lifecycle)}</span>
                  {lifecycle === "draft" ? <p className="text-xs text-muted">Bản nháp do AI tạo, chưa phải dữ liệu đã duyệt.</p> : null}
                </div>
                <div className="rounded-2xl border border-border bg-surface p-3">
                  <h4 className="text-sm font-semibold text-foreground">Tóm tắt điều hành</h4>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{analysis.executive_analysis}</p>
                  <p className="mt-2 text-xs text-muted">Kỳ so sánh: {analysis.period_ref}</p>
                </div>
                {groupFindings(analysis.findings).map((group) => (
                  <div key={group.key} className="rounded-2xl border border-border bg-surface p-3">
                    <h4 className="text-sm font-semibold text-foreground">{group.label}</h4>
                    <ul className="mt-2 space-y-2">
                      {group.items.map((finding) => (
                        <li key={finding.finding_id} className="rounded-lg border border-border/60 p-2 text-sm">
                          <div className="flex items-center justify-between gap-2"><span className="font-medium text-foreground">{finding.headline}</span><span className="text-xs text-muted">{findingCategoryLabel(finding.category)} · {confidenceLabel(finding.confidence)}</span></div>
                          <p className="mt-1 text-foreground">{finding.analysis}</p>
                          {finding.recommended_action ? <p className="mt-1 text-muted">Đề xuất: {finding.recommended_action}</p> : null}
                          {finding.limitations.length > 0 ? <p className="mt-1 text-xs text-muted">Giới hạn: {finding.limitations.join(" · ")}</p> : null}
                          <p className="mt-1 text-xs text-muted">Minh chứng: {finding.evidence_refs.join(", ")}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {analysis.overall_limitations.length > 0 ? (
                  <div className="rounded-2xl border border-border bg-surface p-3">
                    <h4 className="text-sm font-semibold text-foreground">Cảnh báo dữ liệu</h4>
                    <ul className="mt-2 list-disc pl-5 text-sm text-foreground">{analysis.overall_limitations.map((limitation, index) => (<li key={index}>{limitation}</li>))}</ul>
                  </div>
                ) : null}
                <div className="rounded-2xl border border-border bg-surface p-3">
                  <h4 className="text-sm font-semibold text-foreground">Duyệt báo cáo</h4>
                  {regenerateOpen ? (
                    <div className="mt-2 flex flex-col gap-2">
                      <label htmlFor="ai-report-reason" className="text-sm font-medium text-foreground">Lý do tạo lại</label>
                      <textarea id="ai-report-reason" value={regenerateReason} onChange={(event) => setRegenerateReason(event.target.value)} rows={2} disabled={busy} className={inputClass} />
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => void handleRegenerate()} disabled={busy} className={primaryButtonClass}>Xác nhận tạo lại</button>
                        <button type="button" onClick={() => { setRegenerateOpen(false); setRegenerateReason(""); }} disabled={busy} className={secondaryButtonClass}>Hủy</button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" onClick={() => setRegenerateOpen(true)} disabled={busy} className={secondaryButtonClass}>Tạo lại báo cáo</button>
                      <button type="button" disabled title="Chưa khả dụng — chờ RPC duyệt revision (W05)" className={secondaryButtonClass}>Duyệt</button>
                      <button type="button" disabled title="Chưa khả dụng — chờ RPC duyệt revision (W05)" className={secondaryButtonClass}>Từ chối</button>
                    </div>
                  )}
                  <p className="mt-2 text-xs text-muted">Duyệt/từ chối sẽ được bật khi T0 bổ sung RPC duyệt revision (W05).</p>
                </div>
              </section>
            ) : null}
            {history.length > 0 ? (
              <section aria-label="Lịch sử báo cáo" className="rounded-2xl border border-border bg-surface p-3">
                <h3 className="text-sm font-semibold text-foreground">Lịch sử (phiên này)</h3>
                <ul className="mt-2 space-y-1 text-sm">
                  {history.map((item) => (
                    <li key={item.job_id}><button type="button" onClick={() => openHistoryItem(item.job_id)} className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left text-foreground hover:bg-surface/80"><span className="font-mono text-xs">{item.job_id.slice(0, 8)}</span><span className="text-muted">{jobStatusLabel(item.status)}</span></button></li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-muted">Lịch sử bền vững qua phiên cần RPC danh sách (chờ T0).</p>
              </section>
            ) : null}
          </aside>
        </>
      ) : null}
    </div>
  );
}