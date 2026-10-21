"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";
import { validateWorkReportSubmission } from "@/lib/work-reports/schema-validator.ts";
import type { WorkReportTemplateSchema, WorkReportField } from "@/lib/work-reports/contracts.ts";

export type WorkReportRendererDetail = {
  obligation: { obligation_id: string; period_key: string; due_at: string; obligation_status: string;
    period_start_date?: string; period_end_date?: string; reopened_until: string | null; version: number };
  template: { display_name: string; schema_json: WorkReportTemplateSchema };
  submission: { submission_id: string; state: string; draft_payload_json: Record<string, unknown> | null;
    first_submitted_at: string | null; latest_submitted_at: string | null; is_late: boolean;
    has_post_deadline_amendment: boolean; version: number } | null;
  latest_review_event?: { decision: string; reason: string | null; reviewed_at: string } | null;
  revisions: Array<{ revision_id: string; revision_no: number; payload_json: Record<string, unknown>; created_at: string }>;
};

function initialPayload(detail: WorkReportRendererDetail): Record<string, unknown> {
  const payload = { ...(detail.submission?.draft_payload_json ?? {}) };
  for (const section of detail.template.schema_json.sections) {
    for (const field of section.fields) {
      if (!(field.field_key in payload) && field.default_value !== null) payload[field.field_key] = field.default_value;
    }
  }
  return payload;
}

function fieldControl(field: WorkReportField, value: unknown, setValue: (value: unknown) => void, disabled: boolean) {
  const common = { id: field.field_key, disabled, required: field.required,
    className: "min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:opacity-60" };
  if (field.field_type === "textarea") return <textarea {...common} rows={4} maxLength={Number(field.validation.max_length)}
    value={typeof value === "string" ? value : ""} onChange={(event) => setValue(event.target.value)} />;
  if (field.field_type === "boolean") return <select {...common} value={typeof value === "boolean" ? String(value) : ""}
    onChange={(event) => setValue(event.target.value === "" ? null : event.target.value === "true")}>
    <option value="">— Chọn —</option><option value="true">Có</option><option value="false">Không</option>
  </select>;
  if (field.field_type === "single_select") return <select {...common} value={typeof value === "string" ? value : ""}
    onChange={(event) => setValue(event.target.value || null)}>
    <option value="">— Chọn —</option>{(field.options ?? []).filter((item) => item.active).map((item) => <option key={item.option_key} value={item.option_key}>{item.label}</option>)}
  </select>;
  if (field.field_type === "multi_select") return <select {...common} multiple value={Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []}
    onChange={(event) => setValue(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}>
    {(field.options ?? []).filter((item) => item.active).map((item) => <option key={item.option_key} value={item.option_key}>{item.label}</option>)}
  </select>;
  if (field.field_type === "date") return <input {...common} type="date" value={typeof value === "string" ? value : ""}
    onChange={(event) => setValue(event.target.value || null)} />;
  if (field.field_type === "integer" || field.field_type === "decimal") return <input {...common} type="number"
    min={Number(field.validation.min_value)} max={Number(field.validation.max_value)}
    step={field.field_type === "integer" ? "1" : `0.${"0".repeat(Math.max(0, Number(field.validation.decimal_places) - 1))}1`}
    value={typeof value === "number" ? value : ""}
    onChange={(event) => setValue(event.target.value === "" ? null : Number(event.target.value))} />;
  return <input {...common} type="text" maxLength={Number(field.validation.max_length)}
    value={typeof value === "string" ? value : ""} onChange={(event) => setValue(event.target.value)} />;
}

export function WorkReportFormRenderer({ detail, onSaved }: { detail: WorkReportRendererDetail; onSaved?: () => void }) {
  const schema = detail.template.schema_json;
  const [payload, setPayload] = useState<Record<string, unknown>>(() => initialPayload(detail));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // The RPC remains authoritative; this clock only hides actions known to be closed.
  const canEdit = detail.obligation.obligation_status === "ACTIVE" && (detail.submission?.state === "REJECTED" || now === null ||
    now <= Date.parse(detail.obligation.due_at) ||
    (detail.obligation.reopened_until !== null && now <= Date.parse(detail.obligation.reopened_until)));

  async function save(action: "draft" | "submit") {
    setBusy(true); setError(null); setNotice(null);
    if (action === "submit") {
      const validation = validateWorkReportSubmission(schema, payload, {
        period_start_date: detail.obligation.period_start_date,
        period_end_date: detail.obligation.period_end_date,
        today_date: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }),
      });
      if (!validation.ok) {
        setError(`Cần kiểm tra ${validation.issues.length} trường trước khi nộp.`); setBusy(false); return;
      }
    }
    const idempotency_key = crypto.randomUUID();
    try {
      const response = await fetch(`/api/work-reports/submissions/${detail.obligation.obligation_id}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify({ payload_json: payload, expected_version: detail.submission?.version ?? null, idempotency_key }),
      });
      const result = await response.json();
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      setNotice(action === "draft" ? "Đã lưu bản nháp." : "Đã nộp báo cáo.");
      onSaved?.();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      setError(code === "WORK_REPORT_VERSION_CONFLICT" ? "Bản báo cáo đã được cập nhật ở nơi khác. Tải lại trước khi tiếp tục."
        : code === "WORK_REPORT_DEADLINE_PASSED" ? "Đã quá hạn nộp báo cáo."
          : "Không lưu được báo cáo. Vui lòng thử lại.");
    } finally { setBusy(false); }
  }

  return <section className="space-y-5" aria-labelledby="work-report-form-title">
    <div><h2 id="work-report-form-title" className="text-lg font-semibold">{detail.template.display_name}</h2>
      <p className="mt-1 text-sm text-muted">Kỳ {detail.obligation.period_key} · Hạn nộp {new Date(detail.obligation.due_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</p>
      {detail.submission ? <p className="mt-1 text-sm text-muted">Trạng thái: {detail.submission.state}{detail.submission.is_late ? " · Nộp muộn" : ""}{detail.submission.has_post_deadline_amendment ? " · Có chỉnh sửa sau hạn" : ""}</p> : null}
    </div>
    {detail.submission?.state === "REJECTED" ? <StatusBanner tone="warning" title="Báo cáo cần nộp lại">
      {detail.latest_review_event?.reason?.trim() || "Báo cáo đã bị từ chối. Hãy chỉnh sửa và nộp lại."}
    </StatusBanner> : null}
    {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
    {notice ? <StatusBanner tone="success">{notice}</StatusBanner> : null}
    {!canEdit ? <StatusBanner tone="warning">Nghĩa vụ đã đóng hoặc quá hạn. Chỉ có thể xem.</StatusBanner> : null}
    {schema.sections.map((section) => <fieldset key={section.section_key} className="space-y-4 rounded-xl border border-border p-4" disabled={!canEdit || busy}>
      <legend className="px-1 font-medium">{section.label}</legend>
      {section.description ? <p className="text-sm text-muted">{section.description}</p> : null}
      {section.fields.map((field) => <div key={field.field_key} className="space-y-1.5">
        <label htmlFor={field.field_key} className="text-sm font-medium">{field.label}{field.required ? " *" : ""}</label>
        {field.description ? <p className="text-xs text-muted">{field.description}</p> : null}
        {fieldControl(field, payload[field.field_key] ?? field.default_value, (value) => setPayload((current) => ({ ...current, [field.field_key]: value })), !canEdit || busy)}
      </div>)}
    </fieldset>)}
    {detail.revisions.length > 0 ? <details><summary className="cursor-pointer text-sm font-medium">Lịch sử các lần nộp ({detail.revisions.length})</summary>
      <ol className="mt-2 space-y-2 text-sm text-muted">{detail.revisions.map((revision) => <li key={revision.revision_id}>Lần {revision.revision_no} · {new Date(revision.created_at).toLocaleString("vi-VN")}</li>)}</ol>
    </details> : null}
    {canEdit ? <div className="flex flex-wrap gap-2">
      <Button variant="secondary" disabled={busy} onClick={() => void save("draft")}>{busy ? "Đang lưu…" : "Lưu nháp"}</Button>
      <Button variant="primary" disabled={busy} onClick={() => void save("submit")}>{busy ? "Đang xử lý…" : "Nộp báo cáo"}</Button>
    </div> : null}
  </section>;
}
