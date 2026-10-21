"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";

type Template = { template_id: string; template_code: string; display_name: string; status: string; current_published_version_id: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function AssignmentManager() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [targetKind, setTargetKind] = useState<"USER" | "TEAM" | "USER_SET">("USER");
  const [targetId, setTargetId] = useState("");
  const [targetUsers, setTargetUsers] = useState("");
  const [frequency, setFrequency] = useState("DAILY");
  const [dueDayOffset, setDueDayOffset] = useState("0");
  const [dueTime, setDueTime] = useState("23:59:59");
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/work-reports/templates", { cache: "no-store" }).then(async (response) => {
      const result = await response.json();
      if (!response.ok || result?.ok !== true || !Array.isArray(result.items)) throw new Error("unavailable");
      if (live) setTemplates(result.items.filter((item: Template) => item.status === "ACTIVE" && item.current_published_version_id));
    }).catch(() => { if (live) setError("Không tải được danh sách mẫu. Vui lòng thử lại."); });
    return () => { live = false; };
  }, []);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null); setMessage(null);
    const ids = targetKind === "USER_SET" ? targetUsers.split(/[\s,;]+/).filter(Boolean) : [];
    if (!templateId || (targetKind !== "USER_SET" && !UUID.test(targetId)) ||
        (targetKind === "USER_SET" && (ids.length === 0 || ids.some((id) => !UUID.test(id))))) {
      setError("Chọn mẫu và nhập mã định danh hợp lệ cho đối tượng được giao."); setBusy(false); return;
    }
    try {
      const idempotency_key = crypto.randomUUID();
      const response = await fetch("/api/work-reports/assignments", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify({ template_id: templateId, target_kind: targetKind,
          target_user_id: targetKind === "USER" ? targetId : null,
          target_team_id: targetKind === "TEAM" ? targetId : null, target_user_ids: ids,
          frequency, is_mandatory: true, due_day_offset: Number(dueDayOffset), due_time_local: dueTime,
          exclude_sundays: false, effective_from: effectiveFrom, effective_to: null, idempotency_key }),
      });
      const result = await response.json();
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      setMessage(`Đã tạo assignment ${result.assignment_id} (version ${result.version}).`);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      setError(code === "WORK_REPORT_SCOPE_DENIED" || code === "WORK_REPORT_ACCESS_DENIED"
        ? "Bạn không có quyền giao báo cáo cho toàn bộ đối tượng đã chọn. Không có assignment nào được tạo."
        : code === "WORK_REPORT_VERSION_CONFLICT" ? "Mẫu đã thay đổi. Tải lại và thử lại."
          : "Không tạo được giao việc. Vui lòng kiểm tra thông tin hoặc thử lại.");
    } finally { setBusy(false); }
  }

  return <div className="space-y-5">
    <StatusBanner tone="warning" title="Giới hạn danh sách hiện tại">
      API đọc assignment và nghĩa vụ theo phạm vi nhóm chưa có trong DB. Không có bảng dữ liệu nào được đọc trực tiếp; server vẫn kiểm tra quyền và scope khi tạo assignment.
    </StatusBanner>
    {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
    {message ? <StatusBanner tone="success">{message}</StatusBanner> : null}
    <form onSubmit={(event) => void create(event)} className="max-w-2xl space-y-4 rounded-xl border border-border p-4 sm:p-6">
      <h2 className="font-semibold">Tạo giao báo cáo</h2>
      <div className="space-y-1.5"><label htmlFor="template" className="text-sm font-medium">Mẫu báo cáo</label>
        <select id="template" required value={templateId} onChange={(event) => setTemplateId(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm">
          <option value="">Chọn mẫu đang hoạt động</option>{templates.map((template) => <option key={template.template_id} value={template.template_id}>{template.display_name} ({template.template_code})</option>)}
        </select>{templates.length === 0 ? <p className="text-xs text-muted">Chưa có mẫu đã publish.</p> : null}</div>
      <div className="space-y-1.5"><label htmlFor="target-kind" className="text-sm font-medium">Đối tượng</label>
        <select id="target-kind" value={targetKind} onChange={(event) => setTargetKind(event.target.value as typeof targetKind)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm">
          <option value="USER">Một nhân viên</option><option value="TEAM">Một nhóm</option><option value="USER_SET">Danh sách nhân viên</option>
        </select></div>
      {targetKind === "USER_SET" ? <div className="space-y-1.5"><label htmlFor="target-users" className="text-sm font-medium">Mã người dùng (UUID, cách nhau bằng dấu phẩy hoặc xuống dòng)</label>
        <textarea id="target-users" required rows={3} value={targetUsers} onChange={(event) => setTargetUsers(event.target.value)} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm" />
      </div> : <div className="space-y-1.5"><label htmlFor="target-id" className="text-sm font-medium">{targetKind === "USER" ? "Mã người dùng" : "Mã nhóm"} (UUID)</label>
        <input id="target-id" required value={targetId} onChange={(event) => setTargetId(event.target.value.trim())} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm" />
      </div>}
      <p className="text-xs text-muted">Mã định danh cần lấy từ nguồn quản trị được phép. Không nhập tên/chức danh làm căn cứ quyền; scope được RPC kiểm tra ở phía server.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm font-medium">Chu kỳ<select value={frequency} onChange={(event) => setFrequency(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal">
          <option value="DAILY">Hằng ngày</option><option value="WEEKLY">Hằng tuần</option><option value="MONTHLY">Hằng tháng</option><option value="ONCE">Một lần</option>
        </select></label>
        <label className="space-y-1.5 text-sm font-medium">Ngày bắt đầu<input type="date" required value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal" /></label>
        <label className="space-y-1.5 text-sm font-medium">Số ngày cộng vào kỳ hạn<input type="number" min="0" max="31" required value={dueDayOffset} onChange={(event) => setDueDayOffset(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal" /></label>
        <label className="space-y-1.5 text-sm font-medium">Giờ đến hạn (giờ Việt Nam)<input type="time" step="1" required value={dueTime} onChange={(event) => setDueTime(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal" /></label>
      </div>
      <Button type="submit" variant="primary" disabled={busy || !templates.length}>{busy ? "Đang tạo…" : "Tạo giao việc"}</Button>
    </form>
  </div>;
}
