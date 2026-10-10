"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import * as Dialog from "radix-ui/dialog";

import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import {
  buildAssignMembershipRequest,
  buildMembershipListQuery,
  buildTeamCatalogListQuery,
  buildUnassignMembershipRequest,
  classifyMembershipMutation,
  MEMBERSHIP_PAGE_SIZE,
  newMembershipIntentKey,
  projectActiveTeams,
  projectMembershipList,
  setMembershipConflictLock,
  type AdminTeam,
  type AdminTeamMembership,
  type AdminTeamMembershipList,
  type MembershipMutationOutcome,
} from "@/lib/admin/team-membership-model";
import {
  projectPersonnelItem,
} from "@/lib/admin/personnel-catalog-model";
import type { AdminPersonnel } from "@/lib/direct-entry/personnel-catalog-contract";
import type { MembershipState } from "@/lib/direct-entry/team-membership-contract";

type ReadState<T> =
  | { kind: "loading" }
  | { kind: "loaded"; list: T }
  | { kind: "unauthenticated" }
  | { kind: "denied" }
  | { kind: "not-found" }
  | { kind: "unavailable" }
  | { kind: "error" };

type MembershipLists = Record<MembershipState, ReadState<AdminTeamMembershipList>>;
type MembershipPages = Record<MembershipState, number>;
type TeamState =
  | { kind: "idle" | "loading" }
  | { kind: "loaded"; teams: readonly AdminTeam[]; total: number; page: number }
  | { kind: "unauthenticated" | "denied" | "not-found" | "unavailable" | "error" };

type Operation =
  | { kind: "assign" }
  | { kind: "move"; currentTeamId: string; expectedVersion: number }
  | { kind: "close"; membership: AdminTeamMembership; cancelScheduled: boolean };

type MutationIntent = {
  url: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
  operation: "assign" | "move" | "unassign";
  recruiterId: string;
  retry: boolean;
};

type Conflict = { personnel: AdminPersonnel; error: string | null };

const STATES: readonly MembershipState[] = ["CURRENT", "SCHEDULED", "HISTORY"];
const INITIAL_LISTS: MembershipLists = {
  CURRENT: { kind: "loading" },
  SCHEDULED: { kind: "loading" },
  HISTORY: { kind: "loading" },
};
const INITIAL_PAGES: MembershipPages = { CURRENT: 1, SCHEDULED: 1, HISTORY: 1 };
const EMPTY_FORM = { teamId: "", date: "", reason: "" };

function stateLabel(state: MembershipState): string {
  if (state === "CURRENT") return "Đang hiệu lực";
  if (state === "SCHEDULED") return "Đã lên lịch";
  return "Lịch sử";
}

function formatDate(value: string | null): string {
  if (!value) return "Không có ngày kết thúc";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

async function readMembershipList(
  recruiterId: string,
  state: MembershipState,
  page: number,
): Promise<ReadState<AdminTeamMembershipList>> {
  const query = buildMembershipListQuery(recruiterId, state, page);
  if (!query) return { kind: "error" };
  let response: Response;
  try {
    response = await fetch(`/api/admin/catalog/team-memberships?${query.toString()}`, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (response.status === 401) return { kind: "unauthenticated" };
  if (response.status === 403) return { kind: "denied" };
  if (response.status === 404) return { kind: "not-found" };
  if (response.status >= 500) return { kind: "unavailable" };
  if (response.status !== 200) return { kind: "error" };
  try {
    const list = projectMembershipList(await response.json(), { recruiterId, state, page });
    return list ? { kind: "loaded", list } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

function outcomeMessage(outcome: Exclude<MembershipMutationOutcome, { kind: "applied" }>): string {
  return outcome.message;
}

function statusDescription(kind: Exclude<ReadState<unknown>, { kind: "loaded" | "loading" }>["kind"]): string {
  if (kind === "unauthenticated") return "Phiên đăng nhập không còn hiệu lực.";
  if (kind === "denied") return "Bạn không có quyền xem dữ liệu nhóm.";
  if (kind === "not-found") return "Dữ liệu không còn khả dụng.";
  if (kind === "unavailable") return "Dịch vụ hiện chưa khả dụng.";
  return "Phản hồi không hợp lệ; dữ liệu chưa được hiển thị.";
}

export function PersonnelTeamMembershipManager({
  personnel,
  onClose,
  onOpen,
  onConflictLock,
  onPersonnelReloaded,
  onPersonnelUnavailable,
}: {
  personnel: AdminPersonnel | null;
  onClose(): void;
  onOpen(personnel: AdminPersonnel, trigger: HTMLButtonElement): void;
  onConflictLock(recruiterId: string, locked: boolean): void;
  onPersonnelReloaded(personnel: AdminPersonnel): void;
  onPersonnelUnavailable(): void;
}) {
  const [lists, setLists] = useState<MembershipLists>(INITIAL_LISTS);
  const [listsRecruiterId, setListsRecruiterId] = useState<string | null>(null);
  const [pages, setPages] = useState<MembershipPages>(INITIAL_PAGES);
  const [teamState, setTeamState] = useState<TeamState>({ kind: "idle" });
  const [operation, setOperation] = useState<Operation | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingIntent, setPendingIntent] = useState<MutationIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<ReadonlyMap<string, Conflict>>(new Map());
  const [locks, setLocks] = useState<ReadonlySet<string>>(new Set());
  const generation = useRef(0);
  const recruiterId = personnel?.recruiter_id;
  const visibleLists = listsRecruiterId === recruiterId ? lists : INITIAL_LISTS;
  const visiblePages = listsRecruiterId === recruiterId ? pages : INITIAL_PAGES;

  const lockEntity = useCallback((recruiterId: string, locked: boolean) => {
    setLocks((current) => setMembershipConflictLock(current, recruiterId, locked));
    onConflictLock(recruiterId, locked);
  }, [onConflictLock]);

  useEffect(() => {
    if (!recruiterId) return;
    const requestGeneration = ++generation.current;
    void Promise.all(STATES.map((state) => readMembershipList(recruiterId, state, 1)))
      .then((results) => {
        if (generation.current !== requestGeneration) return;
        setLists({
          CURRENT: results[0]!,
          SCHEDULED: results[1]!,
          HISTORY: results[2]!,
        });
        setListsRecruiterId(recruiterId);
        setPages(INITIAL_PAGES);
      });
    return () => {
      if (generation.current === requestGeneration) generation.current += 1;
    };
  }, [recruiterId]);

  const loadOneState = useCallback(async (state: MembershipState, page: number) => {
    if (!personnel) return;
    const recruiterId = personnel.recruiter_id;
    const requestGeneration = generation.current;
    setPages((current) => ({ ...current, [state]: page }));
    setLists((current) => ({ ...current, [state]: { kind: "loading" } }));
    const result = await readMembershipList(recruiterId, state, page);
    if (generation.current === requestGeneration) {
      setLists((current) => ({ ...current, [state]: result }));
    }
  }, [personnel]);

  const loadTeamPage = useCallback(async (page: number, append: boolean) => {
    const existingTeams = append && teamState.kind === "loaded" ? teamState.teams : [];
    const query = buildTeamCatalogListQuery(page);
    if (!query) {
      setTeamState({ kind: "error" });
      return;
    }
    setTeamState({ kind: "loading" });
    let response: Response;
    try {
      response = await fetch(`/api/admin/catalog/teams?${query.toString()}`, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
    } catch {
      setTeamState({ kind: "unavailable" });
      return;
    }
    if (response.status === 401) return setTeamState({ kind: "unauthenticated" });
    if (response.status === 403) return setTeamState({ kind: "denied" });
    if (response.status === 404) return setTeamState({ kind: "not-found" });
    if (response.status >= 500) return setTeamState({ kind: "unavailable" });
    if (response.status !== 200) return setTeamState({ kind: "error" });
    try {
      const list = projectActiveTeams(await response.json(), page);
      if (!list) return setTeamState({ kind: "error" });
      const byId = new Map(existingTeams.map((team) => [team.team_id, team]));
      for (const team of list.teams) byId.set(team.team_id, team);
      setTeamState({ kind: "loaded", teams: Array.from(byId.values()), total: list.total, page });
    } catch {
      setTeamState({ kind: "error" });
    }
  }, [teamState]);

  const ensureTeams = useCallback(() => {
    if (teamState.kind === "idle" || teamState.kind === "unavailable" ||
        teamState.kind === "error" || teamState.kind === "not-found") {
      void loadTeamPage(1, false);
    }
  }, [loadTeamPage, teamState.kind]);

  const refreshAuthoritative = useCallback(async (
    recruiterId: string,
    requestGeneration: number,
  ): Promise<{ complete: boolean; missing: boolean }> => {
    setListsRecruiterId(null);
    setLists({ CURRENT: { kind: "loading" }, SCHEDULED: { kind: "loading" }, HISTORY: { kind: "loading" } });
    setPages(INITIAL_PAGES);
    const detailPromise = (async () => {
      try {
        const response = await fetch(
          `/api/admin/catalog/personnel/${encodeURIComponent(recruiterId)}`,
          { method: "GET", cache: "no-store", headers: { Accept: "application/json" } },
        );
        if (response.status === 404) return { kind: "not-found" as const };
        if (response.status === 401) return { kind: "unauthenticated" as const };
        if (response.status === 403) return { kind: "denied" as const };
        if (response.status !== 200) return { kind: "error" as const };
        const authoritative = projectPersonnelItem(await response.json());
        return authoritative?.recruiter_id === recruiterId
          ? { kind: "loaded" as const, personnel: authoritative }
          : { kind: "error" as const };
      } catch {
        return { kind: "error" as const };
      }
    })();
    const listPromise = Promise.all(STATES.map((state) => readMembershipList(recruiterId, state, 1)));
    const [detail, results] = await Promise.all([detailPromise, listPromise]);
    if (generation.current !== requestGeneration) return { complete: false, missing: false };
    const nextLists: MembershipLists = {
      CURRENT: results[0]!,
      SCHEDULED: results[1]!,
      HISTORY: results[2]!,
    };
    setListsRecruiterId(recruiterId);
    setLists(nextLists);
    if (detail.kind === "loaded") onPersonnelReloaded(detail.personnel);
    if (detail.kind === "not-found") {
      setLists({
        CURRENT: { kind: "not-found" },
        SCHEDULED: { kind: "not-found" },
        HISTORY: { kind: "not-found" },
      });
      onPersonnelUnavailable();
      return { complete: false, missing: true };
    }
    const complete = detail.kind === "loaded" && results.every((result) => result.kind === "loaded");
    return { complete, missing: false };
  }, [onPersonnelReloaded, onPersonnelUnavailable]);

  const reloadConflictedPersonnel = useCallback(async (recruiterId: string) => {
    const conflict = conflicts.get(recruiterId);
    if (!conflict) return;
    setConflicts((current) => new Map(current).set(recruiterId, { ...conflict, error: null }));
    setBusy(true);
    const requestGeneration = generation.current;
    try {
      const result = await refreshAuthoritative(recruiterId, requestGeneration);
      if (generation.current !== requestGeneration) return;
      if (result.missing) {
        setConflicts((current) => {
          const next = new Map(current);
          next.delete(recruiterId);
          return next;
        });
        lockEntity(recruiterId, false);
        setMessage("Hồ sơ không còn tồn tại hoặc không còn khả dụng.");
        return;
      }
      if (!result.complete) throw new Error("authoritative reload incomplete");
      setConflicts((current) => {
        const next = new Map(current);
        next.delete(recruiterId);
        return next;
      });
      lockEntity(recruiterId, false);
      setMessage("Đã tải lại hồ sơ và cả ba nhóm membership.");
    } catch {
      setConflicts((current) => {
        const next = new Map(current);
        const entry = next.get(recruiterId);
        if (entry) next.set(recruiterId, {
          ...entry,
          error: "Không tải đủ dữ liệu có thẩm quyền. Khóa vẫn được giữ; hãy thử lại.",
        });
        return next;
      });
    } finally {
      setBusy(false);
    }
  }, [conflicts, lockEntity, refreshAuthoritative]);

  const sendIntent = useCallback(async (intent: MutationIntent) => {
    setBusy(true);
    setFormError(null);
    setMessage(null);
    let response: Response;
    try {
      response = await fetch(intent.url, {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": intent.idempotencyKey,
        },
        body: JSON.stringify(intent.body),
      });
    } catch {
      setPendingIntent({ ...intent, retry: true });
      setFormError("Không nhận được phản hồi. Có thể thử lại cùng thao tác và khóa.");
      setBusy(false);
      return;
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const outcome = classifyMembershipMutation(
      response.status,
      payload,
      intent.recruiterId,
      intent.operation,
    );
    if (outcome.kind === "conflict") {
      setPendingIntent(null);
      if (personnel?.recruiter_id === intent.recruiterId) {
        setConflicts((current) => new Map(current).set(intent.recruiterId, {
          personnel,
          error: null,
        }));
      }
      lockEntity(intent.recruiterId, true);
      setFormError(outcome.message);
      setBusy(false);
      return;
    }
    if (outcome.kind !== "applied") {
      setPendingIntent(outcome.kind === "unavailable" ? { ...intent, retry: true } : null);
      setFormError(outcomeMessage(outcome));
      setBusy(false);
      return;
    }

    setPendingIntent(null);
    setOperation(null);
    setForm(EMPTY_FORM);
    const requestGeneration = generation.current;
    const refresh = await refreshAuthoritative(intent.recruiterId, requestGeneration);
    if (generation.current === requestGeneration && !refresh.complete) {
      setMessage("Thay đổi đã được ghi nhận nhưng chưa tải đủ dữ liệu mới nhất. Hãy thử tải lại.");
    }
    setBusy(false);
  }, [lockEntity, personnel, refreshAuthoritative]);

  const startAssign = () => {
    if (!personnel) return;
    setOperation({ kind: "assign" });
    setForm(EMPTY_FORM);
    setFormError(null);
    setMessage(null);
    ensureTeams();
  };

  const startMove = (membership: AdminTeamMembership) => {
    setOperation({
      kind: "move",
      currentTeamId: membership.team_id,
      expectedVersion: membership.recruiter_version,
    });
    setForm(EMPTY_FORM);
    setFormError(null);
    setMessage(null);
    ensureTeams();
  };

  const startClose = (membership: AdminTeamMembership, cancelScheduled: boolean) => {
    setOperation({ kind: "close", membership, cancelScheduled });
    setForm({ ...EMPTY_FORM, date: cancelScheduled ? membership.valid_from : "" });
    setFormError(null);
    setMessage(null);
  };

  const submitOperation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    if (!personnel || !operation) return;
    if (locks.has(personnel.recruiter_id)) {
      setFormError("Hồ sơ đang bị khóa cho đến khi tải lại dữ liệu có thẩm quyền.");
      return;
    }
    if (pendingIntent) {
      setFormError("Thao tác trước chưa có kết quả xác nhận. Hãy thử lại thao tác đó.");
      return;
    }
    const idempotencyKey = newMembershipIntentKey();
    const request = operation.kind === "close"
      ? buildUnassignMembershipRequest({
          recruiterId: personnel.recruiter_id,
          validTo: form.date,
          expectedVersion: operation.membership.recruiter_version,
          reason: form.reason,
          idempotencyKey,
        })
      : buildAssignMembershipRequest({
          recruiterId: personnel.recruiter_id,
          teamId: form.teamId,
          validFrom: form.date,
          expectedVersion: operation.kind === "move" ? operation.expectedVersion : personnel.version,
          reason: form.reason,
          idempotencyKey,
          move: operation.kind === "move",
        });
    if (!request.ok) {
      setFormError(request.message);
      return;
    }
    const intent: MutationIntent = {
      ...request.request,
      operation: operation.kind === "close" ? "unassign" : operation.kind,
      recruiterId: personnel.recruiter_id,
      retry: false,
    };
    setPendingIntent(intent);
    void sendIntent(intent);
  };

  const activeConflict = personnel ? conflicts.get(personnel.recruiter_id) : undefined;
  const current = visibleLists.CURRENT.kind === "loaded" ? visibleLists.CURRENT.list : null;
  const scheduled = visibleLists.SCHEDULED.kind === "loaded" ? visibleLists.SCHEDULED.list : null;
  const hasOpenMembership = Boolean(current?.memberships.length || scheduled?.memberships.length);
  const activeListLock = personnel ? locks.has(personnel.recruiter_id) : false;
  const closeDialog = () => {
    if (busy) return;
    setOperation(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    onClose();
  };

  return (
    <>
      {personnel ? (
        <Dialog.Root
          open
          onOpenChange={(open) => {
            if (!open) closeDialog();
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
            <Dialog.Content
              onCloseAutoFocus={(event) => event.preventDefault()}
              aria-describedby="membership-dialog-description"
              className="fixed left-1/2 top-1/2 z-50 max-h-[92dvh] w-[min(64rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-xl focus:outline-none sm:p-6"
            >
              <header className="flex items-start justify-between gap-4">
                <div>
                  <Dialog.Title className="text-xl font-semibold">Quản lý nhóm</Dialog.Title>
                  <Dialog.Description id="membership-dialog-description" className="mt-1 text-sm text-muted">
                    {personnel.display_name}
                    {personnel.personnel_code ? ` · ${personnel.personnel_code}` : ""}
                  </Dialog.Description>
                  <p className="mt-1 text-xs text-muted">
                    Phiên bản hồ sơ hiện tại: {personnel.version}
                  </p>
                </div>
                <Dialog.Close asChild>
                  <button type="button" aria-label="Đóng quản lý nhóm" disabled={busy}
                    className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
                    <span aria-hidden="true">×</span>
                  </button>
                </Dialog.Close>
              </header>

              {activeConflict ? (
                <div className="mt-4">
                  <Alert tone="warning" title="Thao tác đang bị khóa do xung đột phiên bản">
                    <p>{activeConflict.error ?? "Tải lại hồ sơ và ba nhóm membership trước khi tiếp tục."}</p>
                    <button type="button" disabled={busy}
                      onClick={() => void reloadConflictedPersonnel(personnel.recruiter_id)}
                      className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium disabled:opacity-50">
                      {busy ? "Đang tải…" : "Tải lại hồ sơ"}
                    </button>
                  </Alert>
                </div>
              ) : null}
              {message ? <div className="mt-4" role="status"><Alert tone="info" title="Trạng thái">{message}</Alert></div> : null}
              {pendingIntent?.retry ? (
                <div className="mt-4">
                  <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
                    <p>Thử lại đúng thao tác này bằng cùng khóa idempotency.</p>
                    <button type="button" disabled={busy} onClick={() => void sendIntent(pendingIntent)}
                      className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium">
                      Thử lại thao tác
                    </button>
                  </Alert>
                </div>
              ) : null}

              <div className="mt-5 flex flex-wrap gap-2">
                {!hasOpenMembership ? (
                  <button type="button" disabled={!personnel.active || activeListLock}
                    onClick={startAssign}
                    className="min-h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
                    Gán nhóm
                  </button>
                ) : null}
                {!personnel.active && !hasOpenMembership ? (
                  <p className="self-center text-sm text-muted">Hồ sơ ngừng hoạt động; chỉ có thể xem lịch sử hoặc đóng membership hiện có.</p>
                ) : null}
              </div>

              <div className="mt-5 grid gap-4">
                {STATES.map((state) => (
                  <MembershipSection
                    key={state}
                    state={state}
                    readState={visibleLists[state]}
                    page={visiblePages[state]}
                    onPage={(page) => void loadOneState(state, page)}
                    onRetry={() => void loadOneState(state, visiblePages[state])}
                    onMove={personnel.active && (state === "CURRENT" || state === "SCHEDULED")
                      ? (membership) => startMove(membership) : undefined}
                    onClose={state === "CURRENT"
                      ? (membership) => startClose(membership, false) : undefined}
                    onCancelScheduled={state === "SCHEDULED"
                      ? (membership) => startClose(membership, true) : undefined}
                    disabled={busy || activeListLock}
                  />
                ))}
              </div>

              {operation ? (
                <Card className="mt-5">
                  <CardHeader
                    title={operation.kind === "assign" ? "Gán nhóm"
                      : operation.kind === "move" ? "Chuyển nhóm"
                        : operation.cancelScheduled ? "Hủy lịch gán nhóm" : "Bỏ gán nhóm"}
                    description="Lý do bắt buộc. Mọi thay đổi được kiểm tra theo phiên bản hồ sơ hiện hành."
                  />
                  {operation.kind !== "close" ? (
                    <div className="mb-4">
                      {teamState.kind === "loading" ? <p role="status">Đang tải nhóm khả dụng…</p> : null}
                      {teamState.kind === "unauthenticated" || teamState.kind === "denied" ||
                        teamState.kind === "not-found" || teamState.kind === "unavailable" ||
                        teamState.kind === "error" ? (
                          <div className="space-y-2">
                            <Alert tone="error" title="Không thể tải danh sách nhóm">
                              {statusDescription(teamState.kind)}
                            </Alert>
                            <button type="button" onClick={() => void loadTeamPage(1, false)}
                              className="min-h-10 rounded-md border border-border px-3 text-sm">Thử tải lại nhóm</button>
                          </div>
                        ) : null}
                      {teamState.kind === "loaded" ? (
                        <div className="flex flex-wrap items-center gap-3">
                          <p className="text-sm text-muted" role="status">
                            Đang hiển thị {teamState.teams.length} nhóm đang hoạt động.
                          </p>
                          {teamState.teams.length === 0 ? (
                            <p role="status" className="text-sm">Không có nhóm đang hoạt động để chọn.</p>
                          ) : null}
                          {teamState.teams.length < teamState.total ? (
                            <button type="button" onClick={() => void loadTeamPage(teamState.page + 1, true)}
                              className="min-h-10 rounded-md border border-border px-3 text-sm">
                              Tải thêm nhóm
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <form onSubmit={submitOperation} className="space-y-4">
                    {operation.kind !== "close" ? (
                      <label htmlFor="membership-team" className="block text-sm font-medium">
                        Nhóm đang hoạt động <span aria-hidden="true">*</span>
                        <select id="membership-team" required value={form.teamId}
                          onChange={(event) => setForm((value) => ({ ...value, teamId: event.currentTarget.value }))}
                          disabled={teamState.kind !== "loaded" || activeListLock}
                          className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-3">
                          <option value="">Chọn nhóm</option>
                          {teamState.kind === "loaded" ? teamState.teams
                            .filter((team) => operation.kind !== "move" || team.team_id !== operation.currentTeamId)
                            .map((team) => <option key={team.team_id} value={team.team_id}>{team.display_name} ({team.code})</option>)
                            : null}
                        </select>
                      </label>
                    ) : (
                      <p className="text-sm">
                        {operation.cancelScheduled
                          ? "Lịch sẽ được hủy bằng cách ghi nhận ngày kết thúc bằng ngày bắt đầu; lịch sử kiểm toán vẫn được giữ."
                          : `Nhóm: ${operation.membership.team_display_name}. Hồ sơ vẫn được giữ; không có dữ liệu nào bị xóa.`}
                      </p>
                    )}
                    <label htmlFor="membership-effective-date" className="block text-sm font-medium">
                      {operation.kind === "close"
                        ? operation.cancelScheduled ? "Ngày hủy lịch" : "Có hiệu lực đến ngày"
                        : "Có hiệu lực từ ngày"} <span aria-hidden="true">*</span>
                      <input id="membership-effective-date" type="date" required value={form.date}
                        readOnly={operation.kind === "close" && operation.cancelScheduled}
                        onChange={(event) => setForm((value) => ({ ...value, date: event.currentTarget.value }))}
                        className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-3" />
                    </label>
                    <label htmlFor="membership-reason" className="block text-sm font-medium">
                      Lý do <span aria-hidden="true">*</span>
                      <textarea id="membership-reason" required maxLength={4000} rows={3} value={form.reason}
                        onChange={(event) => setForm((value) => ({ ...value, reason: event.currentTarget.value }))}
                        className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2" />
                    </label>
                    {formError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{formError}</p> : null}
                    <div className="flex flex-wrap justify-end gap-2">
                      <button type="button" disabled={busy} onClick={() => setOperation(null)}
                        className="min-h-11 rounded-md border border-border px-4 text-sm">Hủy thao tác</button>
                      <button type="submit"
                        disabled={busy || activeListLock || pendingIntent !== null ||
                          (operation.kind !== "close" && teamState.kind !== "loaded")}
                        className="min-h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
                        {busy ? "Đang xử lý…" : operation.kind === "assign" ? "Xác nhận gán"
                          : operation.kind === "move" ? "Xác nhận chuyển"
                            : operation.cancelScheduled ? "Xác nhận hủy lịch" : "Xác nhận bỏ gán"}
                      </button>
                    </div>
                  </form>
                </Card>
              ) : null}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}

      {personnel === null && conflicts.size > 0 ? (
        <section aria-label="Membership cần tải lại" className="space-y-3">
          {Array.from(conflicts, ([recruiterId, conflict]) => (
            <Alert key={recruiterId} tone="warning" title="Membership đang bị khóa">
              <p>{conflict.personnel.display_name}: tải lại dữ liệu có thẩm quyền trước khi thao tác.</p>
              <button type="button" onClick={(event) => onOpen(conflict.personnel, event.currentTarget)}
                className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium">
                Mở quản lý nhóm
              </button>
            </Alert>
          ))}
        </section>
      ) : null}
    </>
  );
}

function MembershipSection({
  state,
  readState,
  page,
  onPage,
  onRetry,
  onMove,
  onClose,
  onCancelScheduled,
  disabled,
}: {
  state: MembershipState;
  readState: ReadState<AdminTeamMembershipList>;
  page: number;
  onPage(page: number): void;
  onRetry(): void;
  onMove?: (membership: AdminTeamMembership) => void;
  onClose?: (membership: AdminTeamMembership) => void;
  onCancelScheduled?: (membership: AdminTeamMembership) => void;
  disabled: boolean;
}) {
  const list = readState.kind === "loaded" ? readState.list : null;
  const pageCount = list
    ? Math.max(1, Math.ceil(list.total / MEMBERSHIP_PAGE_SIZE))
    : 1;
  return (
    <Card>
      <CardHeader
        title={stateLabel(state)}
        description={list ? `${list.total} membership` : "Dữ liệu được tải riêng theo từng trạng thái."}
      />
      {readState.kind === "loading" ? <p role="status" className="py-5 text-sm">Đang tải {stateLabel(state).toLowerCase()}…</p> : null}
      {readState.kind === "unauthenticated" || readState.kind === "denied" ||
        readState.kind === "not-found" || readState.kind === "unavailable" ? (
          <div className="space-y-3">
            <Alert tone={readState.kind === "denied" || readState.kind === "unauthenticated" ? "error" : "warning"}
              title="Không thể đọc membership">
              {statusDescription(readState.kind)}
            </Alert>
            <button type="button" onClick={onRetry} disabled={disabled}
              className="min-h-10 rounded-md border border-border px-3 text-sm">Thử tải lại</button>
          </div>
        ) : null}
      {readState.kind === "error" ? (
        <div className="space-y-3">
          <ErrorState title="Phản hồi membership không hợp lệ" detail="Không hiển thị dữ liệu một phần." />
          <button type="button" onClick={onRetry} disabled={disabled}
            className="min-h-10 rounded-md border border-border px-3 text-sm">Thử tải lại</button>
        </div>
      ) : null}
      {list ? list.memberships.length === 0 ? (
        <EmptyState title={`Chưa có membership ${stateLabel(state).toLowerCase()}.`} />
      ) : (
        <>
          <div role="region" aria-label={`Bảng ${stateLabel(state).toLowerCase()}`} tabIndex={0}
            className="overflow-x-auto rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <caption className="sr-only">{stateLabel(state)} của hồ sơ</caption>
              <thead className="bg-muted/20"><tr>
                <th scope="col" className="px-3 py-3">Nhóm</th>
                <th scope="col" className="px-3 py-3">Hiệu lực từ</th>
                <th scope="col" className="px-3 py-3">Hiệu lực đến</th>
                <th scope="col" className="px-3 py-3">Trạng thái</th>
                {state !== "HISTORY" ? <th scope="col" className="px-3 py-3">Thao tác</th> : null}
              </tr></thead>
              <tbody className="divide-y divide-border">
                {list.memberships.map((membership) => (
                  <tr key={membership.membership_id}>
                    <th scope="row" className="px-3 py-3 font-medium">{membership.team_display_name}</th>
                    <td className="px-3 py-3">{formatDate(membership.valid_from)}</td>
                    <td className="px-3 py-3">{formatDate(membership.valid_to)}</td>
                    <td className="px-3 py-3">{stateLabel(membership.state)}</td>
                    {state !== "HISTORY" ? (
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-2">
                          {onMove ? <button type="button" disabled={disabled} onClick={() => onMove(membership)}
                            className="min-h-10 rounded-md border border-border px-3 text-xs disabled:opacity-50">Chuyển nhóm</button> : null}
                          {onClose ? <button type="button" disabled={disabled} onClick={() => onClose(membership)}
                            className="min-h-10 rounded-md border border-border px-3 text-xs disabled:opacity-50">Bỏ gán</button> : null}
                          {onCancelScheduled ? <button type="button" disabled={disabled} onClick={() => onCancelScheduled(membership)}
                            className="min-h-10 rounded-md border border-border px-3 text-xs disabled:opacity-50">Hủy lịch</button> : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">Trang {page} / {pageCount}</p>
            <div className="flex gap-2">
              <button type="button" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}
                className="min-h-10 rounded-md border border-border px-3 text-sm disabled:opacity-50">Trang trước</button>
              <button type="button" disabled={disabled || page >= pageCount} onClick={() => onPage(page + 1)}
                className="min-h-10 rounded-md border border-border px-3 text-sm disabled:opacity-50">Trang sau</button>
            </div>
          </div>
        </>
      ) : null}
    </Card>
  );
}
