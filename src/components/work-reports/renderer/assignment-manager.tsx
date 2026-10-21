"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";
import type { WorkReportAssignmentSummary } from "@/lib/work-reports/assignment-repository";

type Template = { template_id: string; template_code: string; display_name: string; default_frequency: string; current_published_version_id: string };
type Team = { team_id: string; code: string; display_name: string };
type User = { app_user_id: string; display_name: string };

export function AssignmentManager() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [assignments, setAssignments] = useState<WorkReportAssignmentSummary[]>([]);
  const [teamId, setTeamId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [loadedTeamId, setLoadedTeamId] = useState<string | null>(null);
  const [targetKind, setTargetKind] = useState<"USER" | "TEAM" | "USER_SET">("USER");
  const [targetId, setTargetId] = useState("");
  const [targetUsers, setTargetUsers] = useState<string[]>([]);
  const [frequency, setFrequency] = useState("DAILY");
  const [dueDayOffset, setDueDayOffset] = useState("0");
  const [dueTime, setDueTime] = useState("23:59:59");
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [trackingLoadedTeamId, setTrackingLoadedTeamId] = useState<string | null>(null);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const templatesLoaded = loadedTeamId === teamId;

  useEffect(() => {
    const controller = new AbortController();
    const query = teamId ? `?team_id=${encodeURIComponent(teamId)}` : "";
    fetch(`/api/work-reports/assignments${query}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true || !Array.isArray(result.templates) ||
          !Array.isArray(result.teams) || !Array.isArray(result.users)) {
        const cause = new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
        if (response.status === 403) cause.message = "WORK_REPORT_ACCESS_DENIED";
        throw cause;
      }
      setTemplates(result.templates);
      setTeams(result.teams);
      setUsers(result.users);
      if (!teamId && result.teams.length === 1) setTeamId(result.teams[0].team_id);
      setError(null);
      setLoadedTeamId(teamId);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      setTemplates([]);
      setTeams([]);
      setUsers([]);
      setError(code === "WORK_REPORT_ACCESS_DENIED"
        ? "Không thể tải mẫu và đối tượng giao báo cáo trong phạm vi quyền hiện tại."
        : "Không tải được dữ liệu giao báo cáo. Vui lòng thử lại.");
      setLoadedTeamId(teamId);
    });
    fetch(`/api/work-reports/assignments/tracking${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json().catch(() => null);
        if (!response.ok || result?.ok !== true || !Array.isArray(result.items)) {
          throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
        }
        setAssignments(result.items);
        setTrackingError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
        setAssignments([]);
        setTrackingError(code === "WORK_REPORT_ACCESS_DENIED"
          ? "Bạn không có quyền theo dõi assignment trong phạm vi này."
          : "Không tải được danh sách giao báo cáo. Vui lòng thử lại.");
      })
      .finally(() => { if (!controller.signal.aborted) setTrackingLoadedTeamId(teamId); });
    return () => controller.abort();
  }, [teamId]);

  async function reloadAssignments() {
    const query = teamId ? `?team_id=${encodeURIComponent(teamId)}` : "";
    try {
      const response = await fetch(`/api/work-reports/assignments/tracking${query}`, { cache: "no-store" });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true || !Array.isArray(result.items)) throw new Error("WORK_REPORT_UNAVAILABLE");
      setAssignments(result.items);
      setTrackingError(null);
    } catch {
      setTrackingError("Không tải được danh sách giao báo cáo. Vui lòng thử lại.");
    }
  }

  async function updateAssignment(assignment: WorkReportAssignmentSummary, state: "ACTIVE" | "PAUSED" | "REVOKED") {
    if (state === "REVOKED" && !window.confirm("Thu hồi giao báo cáo này? Các nghĩa vụ đã nộp được giữ nguyên.")) return;
    setTrackingBusy(true); setTrackingError(null); setMessage(null);
    try {
      const idempotency_key = crypto.randomUUID();
      const response = await fetch(`/api/work-reports/assignments/${assignment.assignment_id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify({ expected_version: assignment.version, state, idempotency_key }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      setMessage(state === "PAUSED" ? "Đã tạm dừng giao báo cáo." : state === "REVOKED" ? "Đã thu hồi giao báo cáo." : "Đã kích hoạt lại giao báo cáo.");
      await reloadAssignments();
    } catch (cause) {
      setTrackingError(cause instanceof Error && cause.message === "WORK_REPORT_VERSION_CONFLICT"
        ? "Giao báo cáo vừa được thay đổi ở nơi khác. Danh sách đã cũ; vui lòng tải lại."
        : "Không cập nhật được giao báo cáo. Vui lòng thử lại.");
    } finally { setTrackingBusy(false); }
  }

  async function refreshProgress() {
    setTrackingBusy(true); setTrackingError(null); setMessage(null);
    try {
      const business_date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
      const response = await fetch("/api/work-reports/assignments/materialize", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ business_date }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      setMessage("Đã cập nhật nghĩa vụ cho kỳ hiện tại.");
      await reloadAssignments();
    } catch {
      setTrackingError("Không cập nhật được tiến độ nghĩa vụ. Vui lòng thử lại.");
    } finally { setTrackingBusy(false); }
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null); setMessage(null);
    const ids = targetKind === "USER_SET" ? targetUsers : [];
    if (!templateId || !teamId || (targetKind === "USER" && !targetId) ||
        (targetKind === "USER_SET" && ids.length === 0)) {
      setError("Chọn mẫu, nhóm và đối tượng được giao."); setBusy(false); return;
    }
    try {
      const idempotency_key = crypto.randomUUID();
      const response = await fetch("/api/work-reports/assignments", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify({ template_id: templateId, target_kind: targetKind,
          target_user_id: targetKind === "USER" ? targetId : null,
          target_team_id: targetKind === "TEAM" ? teamId : null, target_user_ids: ids,
          frequency, is_mandatory: true, due_day_offset: Number(dueDayOffset), due_time_local: dueTime,
          exclude_sundays: false, effective_from: effectiveFrom, effective_to: null, idempotency_key }),
      });
      const result = await response.json();
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      setMessage(`Đã tạo assignment ${result.assignment_id} (version ${result.version}).`);
      await reloadAssignments();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      setError(code === "WORK_REPORT_SCOPE_DENIED" || code === "WORK_REPORT_ACCESS_DENIED"
        ? "Bạn không có quyền giao báo cáo cho toàn bộ đối tượng đã chọn. Không có assignment nào được tạo."
        : code === "WORK_REPORT_VERSION_CONFLICT" ? "Mẫu đã thay đổi. Tải lại và thử lại."
          : "Không tạo được giao việc. Vui lòng kiểm tra thông tin hoặc thử lại.");
    } finally { setBusy(false); }
  }

  return <div className="space-y-5">
    <StatusBanner tone="info" title="Phạm vi giao báo cáo">
      Mẫu, nhóm, nhân viên và assignment được tải theo quyền hiện tại; máy chủ kiểm tra lại scope trước mọi thao tác.
    </StatusBanner>
    {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
    {message ? <StatusBanner tone="success">{message}</StatusBanner> : null}
    <form onSubmit={(event) => void create(event)} className="max-w-2xl space-y-4 rounded-xl border border-border p-4 sm:p-6">
      <h2 className="font-semibold">Tạo giao báo cáo</h2>
      <div className="space-y-1.5"><label htmlFor="team" className="text-sm font-medium">Nhóm trong phạm vi được giao</label>
        <select id="team" required value={teamId} onChange={(event) => { setTeamId(event.target.value); setTargetId(""); setTargetUsers([]); }} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm">
          <option value="">Chọn nhóm</option>{teams.map((team) => <option key={team.team_id} value={team.team_id}>{team.display_name} ({team.code})</option>)}
        </select></div>
      <div className="space-y-1.5"><label htmlFor="template" className="text-sm font-medium">Mẫu báo cáo</label>
        <select id="template" required value={templateId} onChange={(event) => setTemplateId(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm">
          <option value="">Chọn mẫu đang hoạt động</option>{templates.map((template) => <option key={template.template_id} value={template.template_id}>{template.display_name} ({template.template_code})</option>)}
        </select>{templatesLoaded && !error && templates.length === 0 ? <p className="text-xs text-muted">Chưa có mẫu đã publish.</p> : null}</div>
      <div className="space-y-1.5"><label htmlFor="target-kind" className="text-sm font-medium">Đối tượng</label>
        <select id="target-kind" value={targetKind} onChange={(event) => setTargetKind(event.target.value as typeof targetKind)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm">
          <option value="USER">Một nhân viên</option><option value="TEAM">Một nhóm</option><option value="USER_SET">Danh sách nhân viên</option>
        </select></div>
      {targetKind === "USER_SET" ? <div className="space-y-1.5"><label htmlFor="target-users" className="text-sm font-medium">Nhân viên</label>
        <select id="target-users" required multiple value={targetUsers} onChange={(event) => setTargetUsers(Array.from(event.target.selectedOptions, (option) => option.value))} className="min-h-32 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm">
          {users.map((user) => <option key={user.app_user_id} value={user.app_user_id}>{user.display_name}</option>)}
        </select>
      </div> : targetKind === "USER" ? <div className="space-y-1.5"><label htmlFor="target-id" className="text-sm font-medium">Nhân viên</label>
        <select id="target-id" required value={targetId} onChange={(event) => setTargetId(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm">
          <option value="">Chọn nhân viên</option>{users.map((user) => <option key={user.app_user_id} value={user.app_user_id}>{user.display_name}</option>)}
        </select>
      </div> : null}
      <p className="text-xs text-muted">Danh sách nhân viên được xác định từ liên kết tài khoản và thành viên nhóm hiện hành. Scope vẫn được kiểm tra lại trong RPC khi tạo assignment.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm font-medium">Chu kỳ<select value={frequency} onChange={(event) => setFrequency(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal">
          <option value="DAILY">Hằng ngày</option><option value="WEEKLY">Hằng tuần</option><option value="MONTHLY">Hằng tháng</option><option value="ONCE">Một lần</option>
        </select></label>
        <label className="space-y-1.5 text-sm font-medium">Ngày bắt đầu<input type="date" required value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal" /></label>
        <label className="space-y-1.5 text-sm font-medium">Số ngày cộng vào kỳ hạn<input type="number" min="0" max="31" required value={dueDayOffset} onChange={(event) => setDueDayOffset(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal" /></label>
        <label className="space-y-1.5 text-sm font-medium">Giờ đến hạn (giờ Việt Nam)<input type="time" step="1" required value={dueTime} onChange={(event) => setDueTime(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal" /></label>
      </div>
      <Button type="submit" variant="primary" disabled={busy || !templates.length || !teamId || !templatesLoaded}>{busy ? "Đang tạo…" : "Tạo giao việc"}</Button>
    </form>
    <section className="space-y-3" aria-labelledby="assignment-tracking-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 id="assignment-tracking-title" className="text-lg font-semibold">Giao báo cáo đã tạo</h2>
          <p className="text-sm text-muted">Theo dõi tiến độ nghĩa vụ; danh sách không hiển thị nội dung bài nộp.</p>
          <p className="text-xs text-muted">Cập nhật sẽ phát sinh nghĩa vụ cho toàn bộ scope hiện được cấp quyền.</p></div>
        <Button type="button" variant="secondary" disabled={trackingBusy} onClick={() => void refreshProgress()}>
          {trackingBusy ? "Đang cập nhật…" : "Cập nhật tiến độ kỳ hiện tại"}
        </Button>
      </div>
      {trackingError ? <StatusBanner tone="error">{trackingError}</StatusBanner> : null}
      {trackingLoadedTeamId !== teamId ? <p role="status" className="text-sm text-muted">Đang tải danh sách giao báo cáo…</p>
        : assignments.length === 0 ? <p className="rounded-lg border border-border p-4 text-sm text-muted">Chưa có giao báo cáo trong phạm vi này.</p>
          : <div className="space-y-3">{assignments.map((assignment) => <article key={assignment.assignment_id} className="rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1"><h3 className="font-semibold">{assignment.template_name}</h3>
                <p className="text-sm text-muted">{assignment.target_label} · {frequencyLabel(assignment.frequency)} · {stateLabel(assignment.state)}</p>
                <p className="text-xs text-muted">Từ {assignment.effective_from}{assignment.effective_to ? ` đến ${assignment.effective_to}` : " · không có ngày kết thúc"}</p></div>
              <div className="flex flex-wrap gap-2">
                {assignment.state === "ACTIVE" ? <Button type="button" variant="secondary" disabled={trackingBusy} onClick={() => void updateAssignment(assignment, "PAUSED")}>Tạm dừng</Button> : null}
                {assignment.state === "PAUSED" ? <Button type="button" variant="secondary" disabled={trackingBusy} onClick={() => void updateAssignment(assignment, "ACTIVE")}>Kích hoạt</Button> : null}
                {assignment.state !== "REVOKED" ? <Button type="button" variant="secondary" disabled={trackingBusy} onClick={() => void updateAssignment(assignment, "REVOKED")}>Thu hồi</Button> : null}
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
              <Progress label="Tổng nghĩa vụ" value={assignment.obligation_total} />
              <Progress label="Đã nộp" value={assignment.submitted_count} />
              <Progress label="Chưa bắt đầu" value={assignment.not_started_count} />
              <Progress label="Đang nháp" value={assignment.draft_count} />
              <Progress label="Miễn / huỷ" value={assignment.exempted_count + assignment.cancelled_count} />
            </div>
            {assignment.obligation_total === 0 ? <p className="mt-2 text-xs text-muted">Chưa có nghĩa vụ được phát sinh cho assignment này.</p> : null}
          </article>)}</div>}
    </section>
  </div>;
}

function frequencyLabel(value: string) {
  return ({ DAILY: "hằng ngày", WEEKLY: "hằng tuần", MONTHLY: "hằng tháng", ONCE: "một lần" } as Record<string, string>)[value] ?? value;
}

function stateLabel(value: string) {
  return ({ ACTIVE: "đang hoạt động", PAUSED: "đã tạm dừng", REVOKED: "đã thu hồi" } as Record<string, string>)[value] ?? value;
}

function Progress({ label, value }: { label: string; value: number }) {
  return <div className="rounded-md bg-subtle px-3 py-2"><div className="text-xs text-muted">{label}</div><div className="font-medium tabular-nums">{value}</div></div>;
}
