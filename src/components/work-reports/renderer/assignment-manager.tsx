"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { StatusBanner } from "@/components/ui/status-banner";
import type {
  WorkReportAssignmentSummary,
  WorkReportEligibleGroupUser,
  WorkReportGroupItem,
} from "@/lib/work-reports/assignment-repository";

type Template = {
  template_id: string;
  template_code: string;
  display_name: string;
  default_frequency: string;
  current_published_version_id: string;
};
type Team = { team_id: string; code: string; display_name: string };
type User = { app_user_id: string; display_name: string };

type GroupEditorState = {
  group: WorkReportGroupItem | null;
  display_name: string;
  description: string;
  member_user_ids: string[];
};

const controlClass =
  "min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

export function AssignmentManager() {
  const notify = useNotify();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [assignments, setAssignments] = useState<WorkReportAssignmentSummary[]>([]);
  const [groups, setGroups] = useState<WorkReportGroupItem[]>([]);
  const [eligibleUsers, setEligibleUsers] = useState<WorkReportEligibleGroupUser[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupEditor, setGroupEditor] = useState<GroupEditorState | null>(null);
  const [groupFormError, setGroupFormError] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberTeamFilter, setMemberTeamFilter] = useState("");

  const [teamId, setTeamId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [loadedTeamId, setLoadedTeamId] = useState<string | null>(null);
  const [targetKind, setTargetKind] = useState<"USER" | "TEAM" | "USER_SET" | "GROUP">("USER");
  const [targetId, setTargetId] = useState("");
  const [targetUsers, setTargetUsers] = useState<string[]>([]);
  const [targetGroupId, setTargetGroupId] = useState("");
  const [frequency, setFrequency] = useState("DAILY");
  const [dueDayOffset, setDueDayOffset] = useState("0");
  const [dueTime, setDueTime] = useState("23:59:59");
  const [effectiveFrom, setEffectiveFrom] = useState(() =>
    new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trackingLoadedTeamId, setTrackingLoadedTeamId] = useState<string | null>(null);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const templatesLoaded = loadedTeamId === teamId;

  const fetchGroupsPayload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/work-reports/groups", { cache: "no-store", signal });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true || !Array.isArray(result.groups) || !Array.isArray(result.eligible_users)) {
      const cause = new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      if (response.status === 403) cause.message = "WORK_REPORT_ACCESS_DENIED";
      throw cause;
    }
    return {
      groups: result.groups as WorkReportGroupItem[],
      eligibleUsers: result.eligible_users as WorkReportEligibleGroupUser[],
    };
  }, []);

  const reloadGroups = useCallback(async () => {
    setGroupsLoading(true);
    try {
      const next = await fetchGroupsPayload();
      setGroups(next.groups);
      setEligibleUsers(next.eligibleUsers);
      setGroupsError(null);
    } catch (cause: unknown) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      setGroups([]);
      setEligibleUsers([]);
      setGroupsError(
        code === "WORK_REPORT_ACCESS_DENIED"
          ? "Bạn không có quyền quản lý nhóm báo cáo trong phạm vi hiện tại."
          : "Không tải được danh sách nhóm báo cáo tùy chỉnh. Vui lòng thử lại.",
      );
    } finally {
      setGroupsLoading(false);
    }
  }, [fetchGroupsPayload]);

  useEffect(() => {
    const controller = new AbortController();
    fetchGroupsPayload(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setGroups(next.groups);
        setEligibleUsers(next.eligibleUsers);
        setGroupsError(null);
        setGroupsLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
        setGroups([]);
        setEligibleUsers([]);
        setGroupsError(
          code === "WORK_REPORT_ACCESS_DENIED"
            ? "Bạn không có quyền quản lý nhóm báo cáo trong phạm vi hiện tại."
            : "Không tải được danh sách nhóm báo cáo tùy chỉnh. Vui lòng thử lại.",
        );
        setGroupsLoading(false);
      });
    return () => controller.abort();
  }, [fetchGroupsPayload]);

  useEffect(() => {
    const controller = new AbortController();
    const query = teamId ? `?team_id=${encodeURIComponent(teamId)}` : "";
    fetch(`/api/work-reports/assignments${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json().catch(() => null);
        if (
          !response.ok ||
          result?.ok !== true ||
          !Array.isArray(result.templates) ||
          !Array.isArray(result.teams) ||
          !Array.isArray(result.users)
        ) {
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
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
        setTemplates([]);
        setTeams([]);
        setUsers([]);
        setError(
          code === "WORK_REPORT_ACCESS_DENIED"
            ? "Không thể tải mẫu và đối tượng giao báo cáo trong phạm vi quyền hiện tại."
            : "Không tải được dữ liệu giao báo cáo. Vui lòng thử lại.",
        );
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
        setTrackingError(
          code === "WORK_REPORT_ACCESS_DENIED"
            ? "Bạn không có quyền theo dõi assignment trong phạm vi này."
            : "Không tải được danh sách giao báo cáo. Vui lòng thử lại.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setTrackingLoadedTeamId(teamId);
      });
    return () => controller.abort();
  }, [teamId]);

  const activeGroups = useMemo(() => groups.filter((group) => group.active), [groups]);
  const selectedGroup = useMemo(
    () => activeGroups.find((group) => group.group_id === targetGroupId) ?? null,
    [activeGroups, targetGroupId],
  );

  const memberCandidateTeams = useMemo(() => {
    const map = new Map<string, string>();
    for (const user of eligibleUsers) {
      if (user.team_id && user.team_display_name) {
        map.set(user.team_id, user.team_code ? `${user.team_display_name} (${user.team_code})` : user.team_display_name);
      }
    }
    return Array.from(map.entries())
      .map(([id, label]) => ({ team_id: id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, "vi"));
  }, [eligibleUsers]);

  const hasNoTeamEligibleUsers = useMemo(
    () => eligibleUsers.some((user) => user.team_id === null),
    [eligibleUsers],
  );

  const filteredEligibleUsers = useMemo(() => {
    const keyword = memberSearch.trim().toLocaleLowerCase("vi");
    return eligibleUsers.filter((user) => {
      if (memberTeamFilter === "__NO_TEAM__" && user.team_id !== null) return false;
      if (memberTeamFilter && memberTeamFilter !== "__NO_TEAM__" && user.team_id !== memberTeamFilter) return false;
      if (!keyword) return true;
      const teamText = `${user.team_display_name ?? ""} ${user.team_code ?? ""}`.toLocaleLowerCase("vi");
      return user.display_name.toLocaleLowerCase("vi").includes(keyword) || teamText.includes(keyword);
    });
  }, [eligibleUsers, memberSearch, memberTeamFilter]);

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

  function openNewGroupDialog() {
    setGroupFormError(null);
    setMemberSearch("");
    setMemberTeamFilter("");
    setGroupEditor({
      group: null,
      display_name: "",
      description: "",
      member_user_ids: [],
    });
  }

  function openEditGroupDialog(group: WorkReportGroupItem) {
    setGroupFormError(null);
    setMemberSearch("");
    setMemberTeamFilter("");
    const eligibleSet = new Set(eligibleUsers.map((user) => user.app_user_id));
    setGroupEditor({
      group,
      display_name: group.display_name,
      description: group.description ?? "",
      member_user_ids: group.members
        .map((member) => member.app_user_id)
        .filter((id) => eligibleSet.has(id)),
    });
  }

  function toggleGroupMember(appUserId: string, checked: boolean) {
    setGroupEditor((current) => {
      if (!current) return current;
      const exists = current.member_user_ids.includes(appUserId);
      if (checked && !exists) {
        return { ...current, member_user_ids: [...current.member_user_ids, appUserId] };
      }
      if (!checked && exists) {
        return { ...current, member_user_ids: current.member_user_ids.filter((id) => id !== appUserId) };
      }
      return current;
    });
  }

  async function saveGroup() {
    if (!groupEditor) return;
    const trimmedName = groupEditor.display_name.trim();
    const trimmedDesc = groupEditor.description.trim();
    if (!trimmedName) {
      setGroupFormError("Vui lòng nhập tên nhóm báo cáo.");
      return;
    }
    if (groupEditor.member_user_ids.length === 0) {
      setGroupFormError("Vui lòng chọn ít nhất một thành viên đang hoạt động trong phạm vi quyền.");
      return;
    }
    setGroupBusy(true);
    setGroupFormError(null);
    try {
      const idempotency_key = crypto.randomUUID();
      const isEdit = groupEditor.group !== null;
      const url = isEdit ? `/api/work-reports/groups/${groupEditor.group!.group_id}` : "/api/work-reports/groups";
      const response = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify(
          isEdit
            ? {
                expected_version: groupEditor.group!.version,
                display_name: trimmedName,
                description: trimmedDesc || null,
                member_user_ids: groupEditor.member_user_ids,
                idempotency_key,
              }
            : {
                display_name: trimmedName,
                description: trimmedDesc || null,
                member_user_ids: groupEditor.member_user_ids,
                idempotency_key,
              },
        ),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      notify.success({
        title: isEdit ? "Đã cập nhật nhóm báo cáo." : "Đã tạo nhóm báo cáo mới.",
      });
      if (!isEdit && typeof result.group_id === "string") {
        setTargetGroupId(result.group_id);
      }
      setGroupEditor(null);
      await Promise.all([reloadGroups(), reloadAssignments()]);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      const msg =
        code === "WORK_REPORT_SCOPE_DENIED" || code === "WORK_REPORT_ACCESS_DENIED"
          ? "Bạn không có quyền với toàn bộ thành viên trong nhóm. Thao tác đã bị từ chối toàn bộ."
          : code === "WORK_REPORT_VERSION_CONFLICT"
            ? "Nhóm báo cáo vừa được cập nhật ở nơi khác. Hãy đóng hộp thoại và tải lại."
            : "Không lưu được nhóm báo cáo. Kiểm tra danh sách thành viên đủ điều kiện rồi thử lại.";
      setGroupFormError(msg);
      if (code === "WORK_REPORT_VERSION_CONFLICT") notify.warning({ title: msg });
      else notify.error({ title: msg });
    } finally {
      setGroupBusy(false);
    }
  }

  async function toggleGroupActive(group: WorkReportGroupItem, nextActive: boolean) {
    if (
      !nextActive &&
      !window.confirm(
        `Ngừng sử dụng nhóm "${group.display_name}"? Nhóm không bị xóa vật lý; nghĩa vụ và bài nộp đã phát sinh được giữ nguyên, các kỳ chưa phát sinh sẽ không tiếp tục tạo nghĩa vụ mới từ nhóm này.`,
      )
    ) {
      return;
    }
    setGroupBusy(true);
    setGroupsError(null);
    try {
      const idempotency_key = crypto.randomUUID();
      const response = await fetch(`/api/work-reports/groups/${group.group_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify({
          expected_version: group.version,
          active: nextActive,
          idempotency_key,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      if (!nextActive && targetGroupId === group.group_id) {
        setTargetGroupId("");
      }
      notify.success({
        title: nextActive ? "Đã kích hoạt lại nhóm báo cáo." : "Đã ngừng sử dụng nhóm báo cáo.",
      });
      await Promise.all([reloadGroups(), reloadAssignments()]);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      const msg =
        code === "WORK_REPORT_SCOPE_DENIED" || code === "WORK_REPORT_ACCESS_DENIED"
          ? "Bạn không có quyền với toàn bộ thành viên trong nhóm này."
          : code === "WORK_REPORT_VERSION_CONFLICT"
            ? "Nhóm báo cáo vừa được thay đổi ở nơi khác. Đang tải lại danh sách."
            : "Không cập nhật được trạng thái nhóm báo cáo. Kiểm tra thành viên đủ điều kiện rồi thử lại.";
      setGroupsError(msg);
      if (code === "WORK_REPORT_VERSION_CONFLICT") {
        notify.warning({ title: msg });
        await reloadGroups();
      } else {
        notify.error({ title: msg });
      }
    } finally {
      setGroupBusy(false);
    }
  }

  async function updateAssignment(assignment: WorkReportAssignmentSummary, state: "ACTIVE" | "PAUSED" | "REVOKED") {
    if (state === "REVOKED" && !window.confirm("Thu hồi giao báo cáo này? Các nghĩa vụ đã nộp được giữ nguyên.")) return;
    setTrackingBusy(true);
    setTrackingError(null);
    try {
      const idempotency_key = crypto.randomUUID();
      const response = await fetch(`/api/work-reports/assignments/${assignment.assignment_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify({ expected_version: assignment.version, state, idempotency_key }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      notify.success({
        title:
          state === "PAUSED"
            ? "Đã tạm dừng giao báo cáo."
            : state === "REVOKED"
              ? "Đã thu hồi giao báo cáo."
              : "Đã kích hoạt lại giao báo cáo.",
      });
      await reloadAssignments();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      const isConflict = code === "WORK_REPORT_VERSION_CONFLICT";
      const msg = isConflict
        ? "Giao báo cáo vừa được thay đổi ở nơi khác. Danh sách đã cũ; vui lòng tải lại."
        : code === "WORK_REPORT_ACCESS_DENIED" || code === "WORK_REPORT_SCOPE_DENIED"
          ? "Bạn không có quyền với toàn bộ thành viên của giao báo cáo này."
          : code === "WORK_REPORT_REQUEST_INVALID"
            ? "Không thể kích hoạt giao báo cáo khi nhóm báo cáo đang ngừng sử dụng."
            : "Không cập nhật được giao báo cáo. Vui lòng thử lại.";
      setTrackingError(msg);
      if (isConflict) notify.warning({ title: msg });
      else notify.error({ title: msg });
    } finally {
      setTrackingBusy(false);
    }
  }

  async function refreshProgress() {
    setTrackingBusy(true);
    setTrackingError(null);
    try {
      const business_date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
      const response = await fetch("/api/work-reports/assignments/materialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business_date }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      notify.success({ title: "Đã cập nhật nghĩa vụ cho kỳ hiện tại." });
      await reloadAssignments();
    } catch {
      const msg = "Không cập nhật được tiến độ nghĩa vụ. Vui lòng thử lại.";
      setTrackingError(msg);
      notify.error({ title: msg });
    } finally {
      setTrackingBusy(false);
    }
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const ids = targetKind === "USER_SET" ? targetUsers : [];
    const missingRequired =
      !templateId ||
      (targetKind === "GROUP"
        ? !targetGroupId
        : !teamId || (targetKind === "USER" && !targetId) || (targetKind === "USER_SET" && ids.length === 0));
    if (missingRequired) {
      setError("Chọn mẫu, nhóm và đối tượng được giao.");
      setBusy(false);
      return;
    }
    try {
      const idempotency_key = crypto.randomUUID();
      const response = await fetch("/api/work-reports/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify({
          template_id: templateId,
          target_kind: targetKind,
          target_user_id: targetKind === "USER" ? targetId : null,
          target_team_id: targetKind === "TEAM" ? teamId : null,
          target_group_id: targetKind === "GROUP" ? targetGroupId : null,
          target_user_ids: ids,
          frequency,
          is_mandatory: true,
          due_day_offset: Number(dueDayOffset),
          due_time_local: dueTime,
          exclude_sundays: false,
          effective_from: effectiveFrom,
          effective_to: null,
          idempotency_key,
        }),
      });
      const result = await response.json();
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      notify.success({ title: `Đã tạo assignment ${result.assignment_id} (version ${result.version}).` });
      await Promise.all([reloadAssignments(), reloadGroups()]);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      const msg =
        code === "WORK_REPORT_SCOPE_DENIED" || code === "WORK_REPORT_ACCESS_DENIED"
          ? "Bạn không có quyền giao báo cáo cho toàn bộ đối tượng đã chọn. Không có assignment nào được tạo."
          : code === "WORK_REPORT_VERSION_CONFLICT"
            ? "Giao báo cáo cho đối tượng này đã tồn tại hoặc mẫu đã thay đổi. Tải lại và thử lại."
            : "Không tạo được giao việc. Vui lòng kiểm tra thông tin hoặc thử lại.";
      setError(msg);
      if (code === "WORK_REPORT_VERSION_CONFLICT") notify.warning({ title: msg });
      else notify.error({ title: msg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <StatusBanner tone="info" title="Phạm vi giao báo cáo">
        Mẫu, nhóm, nhân viên và assignment được tải theo quyền hiện tại; máy chủ kiểm tra lại scope trước mọi thao tác.
      </StatusBanner>
      {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}

      <form onSubmit={(event) => void create(event)} className="max-w-2xl space-y-4 rounded-xl border border-border p-4 sm:p-6">
        <h2 className="font-semibold">Tạo giao báo cáo</h2>
        <div className="space-y-1.5">
          <label htmlFor="team" className="text-sm font-medium">
            {targetKind === "GROUP" ? "Lọc theo Team hành chính (tùy chọn)" : "Nhóm trong phạm vi được giao"}
          </label>
          <select
            id="team"
            required={targetKind !== "GROUP"}
            value={teamId}
            onChange={(event) => {
              setTeamId(event.target.value);
              setTargetId("");
              setTargetUsers([]);
            }}
            className={controlClass}
          >
            <option value="">
              {targetKind === "GROUP" ? "Tất cả Team trong phạm vi" : "Chọn nhóm"}
            </option>
            {teams.map((team) => (
              <option key={team.team_id} value={team.team_id}>
                {team.display_name} ({team.code})
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="template" className="text-sm font-medium">Mẫu báo cáo</label>
          <select
            id="template"
            required
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
            className={controlClass}
          >
            <option value="">Chọn mẫu đang hoạt động</option>
            {templates.map((template) => (
              <option key={template.template_id} value={template.template_id}>
                {template.display_name} ({template.template_code})
              </option>
            ))}
          </select>
          {templatesLoaded && !error && templates.length === 0 ? (
            <p className="text-xs text-muted">Chưa có mẫu đã publish.</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="target-kind" className="text-sm font-medium">Đối tượng</label>
          <select
            id="target-kind"
            value={targetKind}
            onChange={(event) => setTargetKind(event.target.value as typeof targetKind)}
            className={controlClass}
          >
            <option value="USER">Một nhân viên</option>
            <option value="TEAM">Một nhóm (Team hành chính)</option>
            <option value="USER_SET">Danh sách nhân viên</option>
            <option value="GROUP">Nhóm báo cáo tùy chỉnh</option>
          </select>
        </div>

        {targetKind === "USER_SET" ? (
          <div className="space-y-1.5">
            <label htmlFor="target-users" className="text-sm font-medium">Nhân viên</label>
            <select
              id="target-users"
              required
              multiple
              value={targetUsers}
              onChange={(event) =>
                setTargetUsers(Array.from(event.target.selectedOptions, (option) => option.value))
              }
              className="min-h-32 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              {users.map((user) => (
                <option key={user.app_user_id} value={user.app_user_id}>
                  {user.display_name}
                </option>
              ))}
            </select>
          </div>
        ) : targetKind === "USER" ? (
          <div className="space-y-1.5">
            <label htmlFor="target-id" className="text-sm font-medium">Nhân viên</label>
            <select
              id="target-id"
              required
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
              className={controlClass}
            >
              <option value="">Chọn nhân viên</option>
              {users.map((user) => (
                <option key={user.app_user_id} value={user.app_user_id}>
                  {user.display_name}
                </option>
              ))}
            </select>
          </div>
        ) : targetKind === "GROUP" ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="target-group" className="text-sm font-medium">Nhóm báo cáo tùy chỉnh</label>
              <Button type="button" size="sm" variant="secondary" onClick={openNewGroupDialog}>
                Tạo nhóm báo cáo mới
              </Button>
            </div>
            <select
              id="target-group"
              required
              value={targetGroupId}
              onChange={(event) => setTargetGroupId(event.target.value)}
              className={controlClass}
            >
              <option value="">Chọn nhóm báo cáo đang sử dụng</option>
              {activeGroups.map((group) => (
                <option key={group.group_id} value={group.group_id}>
                  {group.display_name} ({group.members.length} thành viên)
                </option>
              ))}
            </select>
            {!groupsLoading && activeGroups.length === 0 ? (
              <p className="text-xs text-muted">
                Chưa có nhóm báo cáo đang sử dụng trong phạm vi quyền. Hãy tạo nhóm báo cáo mới trước khi giao.
              </p>
            ) : null}
            {selectedGroup ? (
              <div className="rounded-lg bg-subtle p-3 text-xs text-muted">
                <span className="font-medium text-foreground">
                  Thành viên hiện tại ({selectedGroup.members.length}):
                </span>{" "}
                {selectedGroup.members
                  .map(
                    (member) =>
                      `${member.display_name}${member.team_display_name ? ` (${member.team_display_name})` : ""}`,
                  )
                  .join(", ")}
              </div>
            ) : null}
          </div>
        ) : null}

        <p className="text-xs text-muted">
          Danh sách nhân viên được xác định từ liên kết tài khoản và thành viên nhóm hiện hành. Scope vẫn được kiểm tra lại trong RPC khi tạo assignment.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm font-medium">
            Chu kỳ
            <select
              value={frequency}
              onChange={(event) => setFrequency(event.target.value)}
              className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal"
            >
              <option value="DAILY">Hằng ngày</option>
              <option value="WEEKLY">Hằng tuần</option>
              <option value="MONTHLY">Hằng tháng</option>
              <option value="ONCE">Một lần</option>
            </select>
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            Ngày bắt đầu
            <input
              type="date"
              required
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
              className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal"
            />
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            Số ngày cộng vào kỳ hạn
            <input
              type="number"
              min="0"
              max="31"
              required
              value={dueDayOffset}
              onChange={(event) => setDueDayOffset(event.target.value)}
              className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal"
            />
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            Giờ đến hạn (giờ Việt Nam)
            <input
              type="time"
              step="1"
              required
              value={dueTime}
              onChange={(event) => setDueTime(event.target.value)}
              className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal"
            />
          </label>
        </div>

        <Button
          type="submit"
          variant="primary"
          disabled={
            busy ||
            !templates.length ||
            (!teamId && targetKind !== "GROUP") ||
            (targetKind === "GROUP" && !targetGroupId) ||
            !templatesLoaded
          }
        >
          {busy ? "Đang tạo…" : "Tạo giao việc"}
        </Button>
      </form>

      <section className="space-y-3" aria-labelledby="custom-groups-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="custom-groups-title" className="text-lg font-semibold">Nhóm báo cáo tùy chỉnh</h2>
            <p className="text-sm text-muted">
              Danh sách người nhận tái sử dụng xuyên nhiều Team hành chính (ví dụ: Nhóm Tuyển dụng, Nhóm QLDA, Nhóm Tổ trưởng).
            </p>
            <p className="text-xs text-muted">
              Đây là nhóm phục vụ phân công báo cáo, không thay đổi Team hành chính, Phòng ban hay quyền dữ liệu. Thay đổi thành viên chỉ áp dụng cho nghĩa vụ chưa phát sinh; nghĩa vụ và bài nộp đã tạo được giữ nguyên.
            </p>
          </div>
          <Button type="button" variant="secondary" disabled={groupBusy} onClick={openNewGroupDialog}>
            Tạo nhóm báo cáo
          </Button>
        </div>

        {groupsError ? (
          <StatusBanner tone="error">
            <div className="flex flex-wrap items-center gap-2">
              <span>{groupsError}</span>
              <Button type="button" size="sm" variant="secondary" onClick={() => void reloadGroups()}>
                Thử lại
              </Button>
            </div>
          </StatusBanner>
        ) : null}

        {groupsLoading ? (
          <p role="status" className="text-sm text-muted">Đang tải nhóm báo cáo tùy chỉnh…</p>
        ) : groups.length === 0 ? (
          <p className="rounded-lg border border-border p-4 text-sm text-muted">
            Chưa có nhóm báo cáo tùy chỉnh trong phạm vi quyền hiện tại.
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => (
              <article key={group.group_id} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{group.display_name}</h3>
                      <StatusBadge tone={group.active ? "success" : "neutral"}>
                        {group.active ? "Đang sử dụng" : "Ngừng sử dụng"}
                      </StatusBadge>
                    </div>
                    {group.description ? <p className="text-sm text-muted">{group.description}</p> : null}
                    <p className="text-xs text-muted">
                      {group.members.length} thành viên · {group.assignment_count} giao báo cáo tham chiếu · phiên bản v{group.version}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={groupBusy}
                      onClick={() => openEditGroupDialog(group)}
                    >
                      Sửa nhóm
                    </Button>
                    {group.active ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={groupBusy}
                        onClick={() => void toggleGroupActive(group, false)}
                      >
                        Ngừng sử dụng
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={groupBusy}
                        onClick={() => void toggleGroupActive(group, true)}
                      >
                        Sử dụng lại
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {group.members.map((member) => (
                    <span
                      key={member.app_user_id}
                      className="inline-flex items-center gap-1 rounded-md bg-subtle px-2.5 py-1 text-xs"
                    >
                      <span className="font-medium text-foreground">{member.display_name}</span>
                      <span className="text-muted">
                        ({member.team_display_name ?? "Chưa gắn Team"}
                        {!member.enabled ? " · Ngừng hoạt động" : ""})
                      </span>
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="assignment-tracking-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="assignment-tracking-title" className="text-lg font-semibold">Giao báo cáo đã tạo</h2>
            <p className="text-sm text-muted">Theo dõi tiến độ nghĩa vụ; danh sách không hiển thị nội dung bài nộp.</p>
            <p className="text-xs text-muted">Cập nhật sẽ phát sinh nghĩa vụ cho toàn bộ scope hiện được cấp quyền.</p>
          </div>
          <Button type="button" variant="secondary" disabled={trackingBusy} onClick={() => void refreshProgress()}>
            {trackingBusy ? "Đang cập nhật…" : "Cập nhật tiến độ kỳ hiện tại"}
          </Button>
        </div>
        {trackingError ? <StatusBanner tone="error">{trackingError}</StatusBanner> : null}
        {trackingLoadedTeamId !== teamId ? (
          <p role="status" className="text-sm text-muted">Đang tải danh sách giao báo cáo…</p>
        ) : assignments.length === 0 ? (
          <p className="rounded-lg border border-border p-4 text-sm text-muted">
            Chưa có giao báo cáo trong phạm vi này.
          </p>
        ) : (
          <div className="space-y-3">
            {assignments.map((assignment) => (
              <article key={assignment.assignment_id} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h3 className="font-semibold">{assignment.template_name}</h3>
                    <p className="text-sm text-muted">
                      {targetKindLabel(assignment.target_kind)}: {assignment.target_label} · {frequencyLabel(assignment.frequency)} · {stateLabel(assignment.state)}
                    </p>
                    <p className="text-xs text-muted">
                      Từ {assignment.effective_from}
                      {assignment.effective_to ? ` đến ${assignment.effective_to}` : " · không có ngày kết thúc"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {assignment.state === "ACTIVE" ? (
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={trackingBusy}
                        onClick={() => void updateAssignment(assignment, "PAUSED")}
                      >
                        Tạm dừng
                      </Button>
                    ) : null}
                    {assignment.state === "PAUSED" ? (
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={trackingBusy}
                        onClick={() => void updateAssignment(assignment, "ACTIVE")}
                      >
                        Kích hoạt
                      </Button>
                    ) : null}
                    {assignment.state !== "REVOKED" ? (
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={trackingBusy}
                        onClick={() => void updateAssignment(assignment, "REVOKED")}
                      >
                        Thu hồi
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
                  <Progress label="Tổng nghĩa vụ" value={assignment.obligation_total} />
                  <Progress label="Đã nộp" value={assignment.submitted_count} />
                  <Progress label="Chưa bắt đầu" value={assignment.not_started_count} />
                  <Progress label="Đang nháp" value={assignment.draft_count} />
                  <Progress label="Miễn / huỷ" value={assignment.exempted_count + assignment.cancelled_count} />
                </div>
                {assignment.obligation_total === 0 ? (
                  <p className="mt-2 text-xs text-muted">Chưa có nghĩa vụ được phát sinh cho assignment này.</p>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <FormDialog
        open={groupEditor !== null}
        onOpenChange={(open) => {
          if (!open && !groupBusy) {
            setGroupEditor(null);
            setGroupFormError(null);
          }
        }}
        title={groupEditor?.group ? "Chỉnh sửa nhóm báo cáo" : "Tạo nhóm báo cáo tùy chỉnh"}
        description="Chọn các tài khoản đang hoạt động thuộc phạm vi quyền quản lý báo cáo. Có thể chọn thành viên từ nhiều Team hành chính khác nhau."
        contentClassName="sm:w-[min(44rem,calc(100vw-2rem))]"
        closeDisabled={groupBusy}
      >
        {groupEditor ? (
          <div className="space-y-4">
            {groupFormError ? <StatusBanner tone="error">{groupFormError}</StatusBanner> : null}
            <label className="block space-y-1 text-sm font-medium">
              Tên nhóm báo cáo
              <input
                type="text"
                maxLength={160}
                required
                placeholder="Ví dụ: Nhóm Tuyển dụng, Nhóm QLDA, Nhóm Tổ trưởng"
                value={groupEditor.display_name}
                onChange={(event) =>
                  setGroupEditor((current) => (current ? { ...current, display_name: event.target.value } : current))
                }
                className={`${controlClass} font-normal`}
              />
            </label>
            <label className="block space-y-1 text-sm font-medium">
              Mô tả (tùy chọn)
              <textarea
                rows={2}
                maxLength={1000}
                placeholder="Mục đích sử dụng nhóm phân công báo cáo"
                value={groupEditor.description}
                onChange={(event) =>
                  setGroupEditor((current) => (current ? { ...current, description: event.target.value } : current))
                }
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm font-normal text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </label>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  Thành viên nhóm ({groupEditor.member_user_ids.length} đã chọn)
                </span>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={filteredEligibleUsers.length === 0}
                    onClick={() =>
                      setGroupEditor((current) => {
                        if (!current) return current;
                        const merged = new Set([
                          ...current.member_user_ids,
                          ...filteredEligibleUsers.map((user) => user.app_user_id),
                        ]);
                        return { ...current, member_user_ids: Array.from(merged) };
                      })
                    }
                  >
                    Chọn đang lọc
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={groupEditor.member_user_ids.length === 0}
                    onClick={() =>
                      setGroupEditor((current) => {
                        if (!current) return current;
                        const visible = new Set(filteredEligibleUsers.map((user) => user.app_user_id));
                        return {
                          ...current,
                          member_user_ids: current.member_user_ids.filter((id) => !visible.has(id)),
                        };
                      })
                    }
                  >
                    Bỏ chọn đang lọc
                  </Button>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  type="search"
                  aria-label="Tìm nhân viên theo tên"
                  placeholder="Tìm theo tên nhân viên hoặc Team…"
                  value={memberSearch}
                  onChange={(event) => setMemberSearch(event.target.value)}
                  className="min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm"
                />
                <select
                  aria-label="Lọc nhân viên theo Team"
                  value={memberTeamFilter}
                  onChange={(event) => setMemberTeamFilter(event.target.value)}
                  className="min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm"
                >
                  <option value="">Tất cả Team trong phạm vi</option>
                  {memberCandidateTeams.map((team) => (
                    <option key={team.team_id} value={team.team_id}>
                      {team.label}
                    </option>
                  ))}
                  {hasNoTeamEligibleUsers ? <option value="__NO_TEAM__">Chưa gắn Team hành chính</option> : null}
                </select>
              </div>

              <div
                role="group"
                aria-label="Danh sách tài khoản đủ điều kiện nhận báo cáo"
                className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-2"
              >
                {filteredEligibleUsers.length === 0 ? (
                  <p className="p-2 text-xs text-muted">Không có tài khoản đủ điều kiện phù hợp bộ lọc.</p>
                ) : (
                  filteredEligibleUsers.map((user) => {
                    const checked = groupEditor.member_user_ids.includes(user.app_user_id);
                    return (
                      <label
                        key={user.app_user_id}
                        className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-subtle"
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => toggleGroupMember(user.app_user_id, event.target.checked)}
                          />
                          <span>{user.display_name}</span>
                        </span>
                        <span className="text-xs text-muted">
                          {user.team_display_name
                            ? user.team_code
                              ? `${user.team_display_name} (${user.team_code})`
                              : user.team_display_name
                            : "Chưa gắn Team"}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
              <p className="text-xs text-muted">
                Cập nhật thành viên chỉ áp dụng cho các kỳ nghĩa vụ chưa được phát sinh; lịch sử nghĩa vụ và bài nộp cũ không đổi.
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button type="button" disabled={groupBusy} onClick={() => setGroupEditor(null)}>
                Hủy
              </Button>
              <Button type="button" variant="primary" disabled={groupBusy} onClick={() => void saveGroup()}>
                {groupBusy ? "Đang lưu…" : groupEditor.group ? "Lưu thay đổi" : "Tạo nhóm"}
              </Button>
            </div>
          </div>
        ) : null}
      </FormDialog>
    </div>
  );
}

function targetKindLabel(value: string) {
  return (
    ({
      USER: "Nhân viên",
      TEAM: "Team",
      USER_SET: "Danh sách",
      GROUP: "Nhóm báo cáo",
    } as Record<string, string>)[value] ?? value
  );
}

function frequencyLabel(value: string) {
  return (
    ({ DAILY: "hằng ngày", WEEKLY: "hằng tuần", MONTHLY: "hằng tháng", ONCE: "một lần" } as Record<string, string>)[
      value
    ] ?? value
  );
}

function stateLabel(value: string) {
  return (
    ({ ACTIVE: "đang hoạt động", PAUSED: "đã tạm dừng", REVOKED: "đã thu hồi" } as Record<string, string>)[value] ??
    value
  );
}

function Progress({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-subtle px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  );
}
