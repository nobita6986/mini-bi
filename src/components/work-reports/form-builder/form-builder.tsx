"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableContainer } from "@/components/ui/data-table";
import { FormDialog } from "@/components/ui/form-dialog";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { useNotify } from "@/components/ui/notify-provider";
import { StatusBanner } from "@/components/ui/status-banner";
import type { WorkReportField, WorkReportFieldType, WorkReportTemplateSchema } from "@/lib/work-reports/contracts";
import {
  allWorkReportFieldTypes,
  createWorkReportField,
  createWorkReportSchema,
  createWorkReportSection,
  isWorkReportMetricFieldType,
  setWorkReportFieldMetric,
  workReportFieldTypeLabels,
} from "@/lib/work-reports/form-builder-model";
import type { TemplateDetail, TemplateListItem, TemplateVersion } from "@/lib/work-reports/template-repository";

type Editor = {
  template: TemplateListItem | null;
  draftVersionId: string | null;
  expectedVersion: number;
  template_code: string;
  display_name: string;
  description: string;
  default_frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "ONCE";
  schema: WorkReportTemplateSchema;
};
const inputClass = "min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";
const frequencies = { DAILY: "Hằng ngày", WEEKLY: "Hằng tuần", MONTHLY: "Hằng tháng", ONCE: "Một lần" } as const;

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== "object" || (body as { ok?: unknown }).ok !== true) {
    const code = body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string"
      ? (body as { code: string }).code : "WORK_REPORT_UNAVAILABLE";
    throw new Error(code);
  }
  return body as Record<string, unknown>;
}

function keyFromLabel(value: string, fallback: string): string {
  const key = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 56);
  return /^[a-z][a-z0-9_]{1,63}$/.test(key) ? key : fallback;
}

export function FormBuilder({ moduleNav }: { moduleNav?: ReactNode }) {
  const notify = useNotify();
  const [items, setItems] = useState<TemplateListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preview, setPreview] = useState<TemplateVersion | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const body = await jsonResponse(await fetch("/api/work-reports/templates", { cache: "no-store" }));
      setItems(Array.isArray(body.items) ? body.items as TemplateListItem[] : []);
      setError(null);
    } catch { setError("Không tải được danh sách mẫu báo cáo."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);

  function newTemplate() {
    setError(null);
    setEditor({ template: null, draftVersionId: null, expectedVersion: 0, template_code: "DAILY_WORK",
      display_name: "Báo cáo công việc hằng ngày", description: "", default_frequency: "DAILY",
      schema: createWorkReportSchema() });
  }

  async function editTemplate(template: TemplateListItem) {
    try {
      const body = await jsonResponse(await fetch(`/api/work-reports/templates/${template.template_id}`, { cache: "no-store" }));
      const detail = body.template as TemplateDetail;
      const draft = detail.versions.find((version) => version.status === "DRAFT");
      if (!draft) throw new Error("WORK_REPORT_DRAFT_NOT_FOUND");
      setEditor({ template, draftVersionId: draft.version_id, expectedVersion: detail.version,
        template_code: detail.template_code, display_name: detail.display_name, description: detail.description ?? "",
        default_frequency: detail.default_frequency as Editor["default_frequency"], schema: draft.schema_json });
    } catch {
      const msg = "Không tải được bản nháp. Hãy tạo bản nháp mới từ phiên bản đã phát hành.";
      setError(msg);
      notify.error({ title: msg });
    }
  }

  async function showPreview(template: TemplateListItem, versionId: string) {
    setError(null);
    try {
      const body = await jsonResponse(await fetch(`/api/work-reports/templates/${template.template_id}/preview?version_id=${encodeURIComponent(versionId)}`, { cache: "no-store" }));
      setPreview(body.version as TemplateVersion);
    } catch {
      const msg = "Không tải được bản xem trước.";
      setError(msg);
      notify.error({ title: msg });
    }
  }

  async function mutate(path: string, body: Record<string, unknown>, successText: string) {
    setSaving(true);
    try {
      await jsonResponse(await fetch(path, { method: "POST", headers: {
        "content-type": "application/json", "idempotency-key": String(body.idempotency_key),
      }, body: JSON.stringify(body) }));
      setError(null);
      notify.success({ title: successText });
      await refresh();
    } catch {
      const msg = "Thao tác không thành công. Kiểm tra quyền hoặc phiên bản hiện tại rồi thử lại.";
      setError(msg);
      notify.error({ title: msg });
    }
    finally { setSaving(false); }
  }

  async function saveDraft() {
    if (!editor) return;
    const key = crypto.randomUUID();
    const normalizedSchema: WorkReportTemplateSchema = {
      ...editor.schema,
      sections: editor.schema.sections.map((section) => ({
        ...section,
        label: section.label.trim(),
        fields: section.fields.map((field) => ({
          ...field,
          label: field.label.replace(/\r\n?/g, "\n").trim(),
        })),
      })),
    };
    const base = { display_name: editor.display_name, description: editor.description.trim() || null,
      default_frequency: editor.default_frequency, schema_json: normalizedSchema, idempotency_key: key };
    setSaving(true);
    try {
      if (editor.template && editor.draftVersionId) {
        await jsonResponse(await fetch(`/api/work-reports/templates/${editor.template.template_id}`, {
          method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify({ ...base, draft_version_id: editor.draftVersionId, expected_version: editor.expectedVersion }),
        }));
      } else {
        await jsonResponse(await fetch("/api/work-reports/templates", {
          method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify({ ...base, template_code: editor.template_code }),
        }));
      }
      setEditor(null);
      setError(null);
      notify.success({ title: "Đã lưu bản nháp mẫu báo cáo." });
      await refresh();
    } catch {
      const msg = "Không lưu được bản nháp. Kiểm tra mã mẫu, nội dung và phiên bản hiện tại.";
      setError(msg);
      notify.error({ title: msg });
    }
    finally { setSaving(false); }
  }

  function patchSection(sectionIndex: number, update: (section: WorkReportTemplateSchema["sections"][number]) => WorkReportTemplateSchema["sections"][number]) {
    setEditor((current) => current ? { ...current, schema: { ...current.schema, sections:
      current.schema.sections.map((section, index) => index === sectionIndex ? update(section) : section) } } : current);
  }
  function patchField(sectionIndex: number, fieldIndex: number, update: (field: WorkReportField) => WorkReportField) {
    patchSection(sectionIndex, (section) => ({ ...section, fields: section.fields.map((field, index) =>
      index === fieldIndex ? update(field) : field) }));
  }
  function nextFieldIndex(): number {
    return Math.max(0, ...((editor?.schema.sections.flatMap((section) => section.fields) ?? [])
      .map((field) => Number(field.field_key.match(/_f(\d+)$/)?.[1] ?? 0)))) + 1;
  }

  return <PageShell>
    <PageHeader title="Quản lý mẫu báo cáo" description="Tạo biểu mẫu, xem trước và quản lý các phiên bản phát hành."
      actions={<Button variant="primary" onClick={newTemplate}>Tạo mẫu</Button>} />
    {moduleNav}
    {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
    {loading ? <p role="status" className="text-sm text-muted">Đang tải mẫu báo cáo…</p> : null}
    {!loading && !items.length ? <StatusBanner tone="info">Chưa có mẫu báo cáo.</StatusBanner> : null}
    {items.length > 0 ? <DataTableContainer>
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead><tr className="border-b border-border text-muted"><th className="p-3">Mẫu</th><th className="p-3">Chu kỳ</th><th className="p-3">Trạng thái</th><th className="p-3">Phiên bản</th><th className="p-3">Thao tác</th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.template_id} className="border-b border-border last:border-0">
          <td className="p-3"><div className="font-medium">{item.display_name}</div><div className="text-xs text-muted">{item.template_code}</div></td>
          <td className="p-3">{frequencies[item.default_frequency as keyof typeof frequencies] ?? item.default_frequency}</td>
          <td className="p-3"><StatusBadge tone={item.status === "ACTIVE" ? "success" : item.status === "ARCHIVED" ? "neutral" : "warning"}>{item.status}</StatusBadge></td>
          <td className="p-3">v{item.version}</td>
          <td className="p-3"><div className="flex flex-wrap gap-2">
            {item.draft_version_id ? <><Button size="sm" onClick={() => void editTemplate(item)}>Sửa nháp</Button><Button size="sm" variant="primary" disabled={saving} onClick={() => { if (window.confirm("Phát hành phiên bản này? Phiên bản sau khi phát hành không thể sửa.")) void mutate(`/api/work-reports/templates/${item.template_id}/publish`, { draft_version_id: item.draft_version_id, expected_version: item.version, idempotency_key: crypto.randomUUID() }, "Đã phát hành phiên bản."); }}>Phát hành</Button></> : null}
            {item.current_published_version_id ? <Button size="sm" onClick={() => void showPreview(item, item.current_published_version_id!)}>Xem trước</Button> : null}
            {item.status === "ACTIVE" && !item.draft_version_id ? <Button size="sm" onClick={() => void mutate(`/api/work-reports/templates/${item.template_id}/clone`, { expected_version: item.version, idempotency_key: crypto.randomUUID() }, "Đã tạo bản nháp phiên bản mới.")}>Tạo phiên bản</Button> : null}
            {item.status !== "ARCHIVED" ? <Button size="sm" variant="danger-outline" onClick={() => { if (window.confirm("Lưu trữ mẫu này? Các assignment hiện hành sẽ bị thu hồi.")) void mutate(`/api/work-reports/templates/${item.template_id}/archive`, { expected_version: item.version, idempotency_key: crypto.randomUUID() }, "Đã lưu trữ mẫu."); }}>Lưu trữ</Button> : null}
          </div></td>
        </tr>)}</tbody>
      </table>
    </DataTableContainer> : null}

    <FormDialog open={editor !== null} onOpenChange={(open) => !open && !saving && setEditor(null)} title={editor?.template ? "Chỉnh sửa bản nháp" : "Tạo mẫu báo cáo"}
      description="Phiên bản đã phát hành được giữ nguyên. Trường chỉ tiêu chỉ hỗ trợ số, Có / Không và lựa chọn."
      contentClassName="sm:w-[min(64rem,calc(100vw-2rem))]" closeDisabled={saving}>
      {editor ? <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {!editor.template ? <label className="space-y-1 text-sm">Mã mẫu<input className={inputClass} maxLength={64} value={editor.template_code} onChange={(event) => setEditor({ ...editor, template_code: event.target.value.toUpperCase() })} /></label> : null}
          <label className="space-y-1 text-sm">Tên mẫu<input className={inputClass} maxLength={256} value={editor.display_name} onChange={(event) => setEditor({ ...editor, display_name: event.target.value })} /></label>
          <label className="space-y-1 text-sm">Chu kỳ<select className={inputClass} value={editor.default_frequency} onChange={(event) => setEditor({ ...editor, default_frequency: event.target.value as Editor["default_frequency"] })}>{Object.entries(frequencies).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="space-y-1 text-sm sm:col-span-2">Mô tả<textarea className={inputClass} maxLength={2000} rows={2} value={editor.description} onChange={(event) => setEditor({ ...editor, description: event.target.value })} /></label>
        </div>
        <div className="space-y-3">{editor.schema.sections.map((section, sectionIndex) => <section key={section.section_key} className="space-y-3 rounded-xl border border-border p-3 sm:p-4">
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"><input aria-label="Tên nhóm" className={inputClass} value={section.label} onChange={(event) => patchSection(sectionIndex, (current) => ({ ...current, label: event.target.value }))} /><input aria-label="Mô tả nhóm" className={inputClass} value={section.description ?? ""} onChange={(event) => patchSection(sectionIndex, (current) => ({ ...current, description: event.target.value || null }))} placeholder="Mô tả nhóm (không bắt buộc)" />
            <Button size="sm" variant="danger-outline" disabled={editor.schema.sections.length === 1} onClick={() => setEditor({ ...editor, schema: { ...editor.schema, sections: editor.schema.sections.filter((_, index) => index !== sectionIndex) } })}>Xóa nhóm</Button>
          </div>
          {section.fields.map((field, fieldIndex) => <div key={`${section.section_key}-${field.field_key}`} className="grid gap-2 rounded-lg bg-muted/5 p-3 md:grid-cols-12">
            <label className="space-y-1 text-xs md:col-span-3">Nhãn<textarea aria-label="Nhãn trường" className={`${inputClass} min-h-[4.25rem] resize-y`} rows={2} maxLength={256} value={field.label} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, label: event.target.value.replace(/\r\n?/g, "\n") }))} /></label>
            <label className="space-y-1 text-xs md:col-span-3">Kiểu trường<select className={inputClass} value={field.field_type} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...createWorkReportField(event.target.value as WorkReportFieldType, section.section_key, nextFieldIndex()), field_key: current.field_key, sort_order: current.sort_order, label: current.label, description: current.description, required: current.required }))}>{allWorkReportFieldTypes.map((type) => <option key={type} value={type}>{workReportFieldTypeLabels[type]}</option>)}</select></label>
            <label className="flex min-h-10 items-center gap-2 self-end text-sm md:col-span-2"><input type="checkbox" checked={field.required} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, required: event.target.checked }))} />Bắt buộc</label>
            <label className="flex min-h-10 items-center gap-2 self-end text-sm md:col-span-2"><input type="checkbox" checked={field.is_metric} disabled={!isWorkReportMetricFieldType(field.field_type)} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => setWorkReportFieldMetric(current, event.target.checked))} />Chỉ tiêu</label>
            <label className="flex min-h-10 items-center gap-2 self-end text-sm md:col-span-2"><input type="checkbox" checked={field.is_dimension} disabled={field.field_type !== "single_select" && field.field_type !== "multi_select"} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, is_dimension: event.target.checked }))} />Chiều</label>
            <div className="flex items-end md:col-span-2"><Button size="sm" variant="danger-outline" disabled={section.fields.length === 1} onClick={() => patchSection(sectionIndex, (current) => ({ ...current, fields: current.fields.filter((_, index) => index !== fieldIndex) }))}>Xóa trường</Button></div>
            <label className="space-y-1 text-xs md:col-span-6">Mô tả trường<input className={inputClass} maxLength={2000} value={field.description ?? ""} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, description: event.target.value || null }))} /></label>
            <FieldDefaultControl field={field} onChange={(default_value) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, default_value }))} />
            {field.is_metric && field.metric_spec ? <label className="space-y-1 text-xs md:col-span-3">Đơn vị<input className={inputClass} maxLength={64} value={field.metric_spec.unit} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, metric_spec: current.metric_spec ? { ...current.metric_spec, unit: event.target.value } : null }))} /></label> : null}
            {field.field_type === "text" || field.field_type === "textarea" ? <div className="grid gap-2 md:col-span-6 md:grid-cols-3"><label className="space-y-1 text-xs">Độ dài tối thiểu<input className={inputClass} type="number" min={0} value={field.validation.min_length ?? 0} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, validation: { ...current.validation, min_length: Number(event.target.value) } }))} /></label><label className="space-y-1 text-xs">Độ dài tối đa<input className={inputClass} type="number" min={1} max={field.field_type === "text" ? 500 : 4000} value={field.validation.max_length ?? 100} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, validation: { ...current.validation, max_length: Number(event.target.value) } }))} /></label>{field.field_type === "text" ? <label className="space-y-1 text-xs">Định dạng<select className={inputClass} value={field.validation.pattern_preset ?? "none"} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, validation: { ...current.validation, pattern_preset: event.target.value as "none" | "code" | "phone" | "email" } }))}><option value="none">Không giới hạn</option><option value="code">Mã</option><option value="phone">Điện thoại</option><option value="email">Email</option></select></label> : null}</div> : null}
            {field.field_type === "integer" || field.field_type === "decimal" ? <div className="grid gap-2 md:col-span-6 md:grid-cols-4"><label className="space-y-1 text-xs">Giá trị nhỏ nhất<input className={inputClass} type="number" value={field.validation.min_value ?? 0} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, validation: { ...current.validation, min_value: Number(event.target.value) } }))} /></label><label className="space-y-1 text-xs">Giá trị lớn nhất<input className={inputClass} type="number" value={field.validation.max_value ?? 1000000} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, validation: { ...current.validation, max_value: Number(event.target.value) } }))} /></label>{field.field_type === "decimal" ? <label className="space-y-1 text-xs">Số chữ số thập phân<input className={inputClass} type="number" min={1} max={4} value={field.validation.decimal_places ?? 2} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, validation: { ...current.validation, decimal_places: Number(event.target.value) } }))} /></label> : null}<label className="flex items-center gap-2 self-end text-xs"><input type="checkbox" checked={field.validation.allow_zero !== false} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, validation: { ...current.validation, allow_zero: event.target.checked } }))} />Cho phép 0</label></div> : null}
            {field.field_type === "date" ? <label className="space-y-1 text-xs md:col-span-4">Giới hạn ngày<select className={inputClass} value={field.validation.min_date_rule ?? "any"} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, validation: { min_date_rule: event.target.value as "any" | "within_period" | "not_future" } }))}><option value="any">Bất kỳ ngày</option><option value="within_period">Trong kỳ báo cáo</option><option value="not_future">Không ở tương lai</option></select></label> : null}
            {field.field_type === "single_select" || field.field_type === "multi_select" ? <label className="space-y-1 text-xs md:col-span-12">Các lựa chọn (mỗi dòng một lựa chọn)<textarea className={inputClass} rows={2} value={(field.options ?? []).map((option) => option.label).join("\n")} onChange={(event) => {
              const labels = event.target.value.split("\n").map((label) => label.trim()).filter(Boolean).slice(0, 50);
              const options = (labels.length ? labels : ["Lựa chọn 1"]).map((label, index) => ({ option_key: keyFromLabel(label, `option_${index + 1}`), label, active: true, sort_order: (index + 1) * 10 }));
              const keys = new Set(options.map((option) => option.option_key));
              patchField(sectionIndex, fieldIndex, (current) => ({ ...current, options, default_value:
                Array.isArray(current.default_value) ? current.default_value.filter((key) => typeof key === "string" && keys.has(key)) :
                  typeof current.default_value === "string" && keys.has(current.default_value) ? current.default_value : null }));
            }} /></label> : null}
            {field.field_type === "multi_select" ? <div className="grid gap-2 md:col-span-6 md:grid-cols-2"><label className="space-y-1 text-xs">Số chọn tối thiểu<input className={inputClass} type="number" min={0} value={field.validation.min_selected ?? 0} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, validation: { ...current.validation, min_selected: Number(event.target.value) } }))} /></label><label className="space-y-1 text-xs">Số chọn tối đa<input className={inputClass} type="number" min={1} max={50} value={field.validation.max_selected ?? 50} onChange={(event) => patchField(sectionIndex, fieldIndex, (current) => ({ ...current, validation: { ...current.validation, max_selected: Number(event.target.value) } }))} /></label></div> : null}
          </div>)}
          <Button size="sm" onClick={() => patchSection(sectionIndex, (current) => ({ ...current,
            fields: [...current.fields, createWorkReportField("text", current.section_key, nextFieldIndex())] }))}>Thêm trường</Button>
        </section>)}
          <Button onClick={() => setEditor({ ...editor, schema: { ...editor.schema,
            sections: [...editor.schema.sections, createWorkReportSection(editor.schema.sections.length + 1)] } })}>Thêm nhóm</Button>
        </div>
        <div className="flex justify-end gap-2 border-t border-border pt-3"><Button disabled={saving} onClick={() => setEditor(null)}>Hủy</Button><Button variant="primary" disabled={saving} onClick={() => void saveDraft()}>{saving ? "Đang lưu…" : "Lưu bản nháp"}</Button></div>
      </div> : null}
    </FormDialog>

    <FormDialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)} title="Xem trước biểu mẫu"
      description={preview ? `Phiên bản ${preview.version_no} · ${preview.status} · checksum ${preview.schema_checksum.slice(0, 12)}` : undefined}
      contentClassName="sm:w-[min(48rem,calc(100vw-2rem))]">
      {preview ? <div className="space-y-5">{preview.schema_json.sections.map((section) => <section key={section.section_key} className="space-y-3">
        <h2 className="font-semibold">{section.label}</h2>{section.fields.map((field) => <PreviewField key={field.field_key} field={field} />)}
      </section>)}<div className="flex justify-end"><Button onClick={() => setPreview(null)}>Đóng</Button></div></div> : null}
    </FormDialog>
  </PageShell>;
}

function PreviewField({ field }: { field: WorkReportField }) {
  return <label className="block space-y-1 text-sm"><span className="block whitespace-pre-line break-words font-medium">{field.label}{field.required ? " *" : ""}</span>
    {field.field_type === "textarea" ? <textarea className={inputClass} rows={3} disabled placeholder={field.description ?? ""} /> :
      field.field_type === "boolean" ? <select className={inputClass} disabled><option>Chọn</option><option>Có</option><option>Không</option></select> :
        field.field_type === "single_select" || field.field_type === "multi_select" ? <select className={inputClass} disabled><option>Chọn</option>{(field.options ?? []).filter((option) => option.active).map((option) => <option key={option.option_key}>{option.label}</option>)}</select> :
          <input className={inputClass} disabled type={field.field_type === "date" ? "date" : field.field_type === "integer" || field.field_type === "decimal" ? "number" : "text"} placeholder={field.description ?? ""} />}
    {field.is_metric ? <span className="block text-xs text-muted">Chỉ tiêu: {field.metric_spec?.metric_key} ({field.metric_spec?.unit})</span> : null}
  </label>;
}

function FieldDefaultControl({ field, onChange }: { field: WorkReportField; onChange(value: unknown): void }) {
  const label = <span className="text-xs font-medium">Giá trị mặc định</span>;
  if (field.field_type === "boolean") return <label className="space-y-1 md:col-span-4">{label}<select className={inputClass} value={typeof field.default_value === "boolean" ? String(field.default_value) : ""} onChange={(event) => onChange(event.target.value === "" ? null : event.target.value === "true")}><option value="">Không đặt</option><option value="true">Có</option><option value="false">Không</option></select></label>;
  if (field.field_type === "single_select") return <label className="space-y-1 md:col-span-4">{label}<select className={inputClass} value={typeof field.default_value === "string" ? field.default_value : ""} onChange={(event) => onChange(event.target.value || null)}><option value="">Không đặt</option>{(field.options ?? []).filter((option) => option.active).map((option) => <option key={option.option_key} value={option.option_key}>{option.label}</option>)}</select></label>;
  if (field.field_type === "multi_select") {
    const selected = Array.isArray(field.default_value) ? field.default_value.filter((value): value is string => typeof value === "string") : [];
    return <fieldset className="space-y-1 md:col-span-6"><legend>{label}</legend><div className="flex flex-wrap gap-x-4 gap-y-2">{(field.options ?? []).filter((option) => option.active).map((option) => <label key={option.option_key} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={selected.includes(option.option_key)} onChange={(event) => onChange(event.target.checked ? [...selected, option.option_key] : selected.filter((key) => key !== option.option_key))} />{option.label}</label>)}</div></fieldset>;
  }
  const type = field.field_type === "integer" || field.field_type === "decimal" ? "number" : field.field_type === "date" ? "date" : "text";
  return <label className="space-y-1 md:col-span-4">{label}<input className={inputClass} type={type} step={field.field_type === "decimal" ? "any" : field.field_type === "integer" ? "1" : undefined} value={field.default_value === null || field.default_value === undefined ? "" : String(field.default_value)} onChange={(event) => {
    const value = event.target.value;
    onChange(value === "" ? null : type === "number" ? Number(value) : value);
  }} /></label>;
}
