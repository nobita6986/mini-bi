"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import * as Dialog from "radix-ui/dialog";

import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import {
  buildPersonnelCreateRequest,
  buildPersonnelListQuery,
  buildPersonnelSetActiveRequest,
  buildPersonnelUpdateRequest,
  classifyPersonnelMutation,
  newPersonnelIntentKey,
  personnelConflictsForDialog,
  projectPersonnelItem,
  projectPersonnelListForQuery,
  setPersonnelConflictLock,
  type PersonnelMutationOutcome,
} from "@/lib/admin/personnel-catalog-model";
import type {
  AdminPersonnel,
  AdminPersonnelList,
  PersonnelPosition,
} from "@/lib/direct-entry/personnel-catalog-contract";

type ListState =
  | { kind: "loading" }
  | { kind: "loaded"; list: AdminPersonnelList }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "error" };

type DialogState =
  | { kind: "create" }
  | { kind: "edit"; personnel: AdminPersonnel }
  | { kind: "active"; personnel: AdminPersonnel; active: boolean };

type PersonnelForm = {
  personnelCode: string;
  displayName: string;
  personnelPosition: PersonnelPosition | "";
  validFrom: string;
  reason: string;
};

type MutationIntent = {
  url: string;
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
  operation: "create" | "update" | "set-active";
  recruiterId: string | null;
  lockId: string;
  retryState: "ready" | "retry";
};

type ConflictEntry = { intent: MutationIntent; error: string | null };

const EMPTY_FORM: PersonnelForm = {
  personnelCode: "",
  displayName: "",
  personnelPosition: "",
  validFrom: "",
  reason: "",
};

function responseOutcome(status: number, payload: unknown, intent: MutationIntent) {
  return classifyPersonnelMutation(status, payload, intent.operation);
}

function messageForOutcome(outcome: Exclude<PersonnelMutationOutcome, { kind: "applied" }>): string {
  return outcome.message;
}

function formatHrpDate(value: string | null): string {
  if (!value) return "—";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function positionLabel(value: PersonnelPosition | null): string {
  if (value === "TEAM_LEADER") return "Trưởng nhóm";
  if (value === "STAFF") return "Nhân viên";
  return "Chưa xác định";
}

export function PersonnelCatalogManager() {
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [form, setForm] = useState<PersonnelForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [mutationMessage, setMutationMessage] = useState<string | null>(null);
  const [pendingIntent, setPendingIntent] = useState<MutationIntent | null>(null);
  const [conflictIntents, setConflictIntents] = useState<ReadonlyMap<string, ConflictEntry>>(new Map());
  const [busy, setBusy] = useState(false);
  const [conflictLocks, setConflictLocks] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const listQuery = buildPersonnelListQuery({ search, includeInactive, page });
    if (!listQuery) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      let response: Response;
      try {
        response = await fetch(`/api/admin/catalog/personnel?${listQuery.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setListState({ kind: "unavailable" });
        return;
      }
      if (response.status === 401 || response.status === 403) {
        setListState({ kind: "denied" });
        return;
      }
      if (response.status !== 200) {
        setListState(response.status === 404 || response.status >= 500
          ? { kind: "unavailable" }
          : { kind: "error" });
        return;
      }
      try {
        const list = projectPersonnelListForQuery(await response.json(), {
          search,
          includeInactive,
          page,
        });
        if (!list) {
          setListState({ kind: "error" });
          return;
        }
        const pages = Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size)));
        if (page > pages) {
          setPage(Math.min(1000, pages));
          return;
        }
        setListState({ kind: "loaded", list });
      } catch {
        setListState({ kind: "error" });
      }
    })();
    return () => controller.abort();
  }, [includeInactive, page, reloadToken, search]);

  const reloadList = () => {
    setListState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  const changeForm = useCallback(<K extends keyof PersonnelForm>(field: K, value: PersonnelForm[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFormError(null);
    setMutationMessage(null);
  }, []);

  const startCreate = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setDialog({ kind: "create" });
  };

  const startEdit = (personnel: AdminPersonnel) => {
    setForm({
      personnelCode: personnel.personnel_code ?? "",
      displayName: personnel.display_name,
      personnelPosition: personnel.personnel_position ?? "",
      validFrom: "",
      reason: "",
    });
    setFormError(null);
    setDialog({ kind: "edit", personnel });
  };

  const startActiveChange = (personnel: AdminPersonnel, active: boolean) => {
    setForm({ ...EMPTY_FORM, reason: "" });
    setFormError(null);
    setDialog({ kind: "active", personnel, active });
  };

  const reloadConflictedEntity = useCallback(async (intent: MutationIntent) => {
    setConflictIntents((current) => {
      const next = new Map(current);
      const entry = next.get(intent.lockId);
      if (entry) next.set(intent.lockId, { ...entry, error: null });
      return next;
    });
    setBusy(true);
    try {
      if (intent.recruiterId) {
        const response = await fetch(
          `/api/admin/catalog/personnel/${encodeURIComponent(intent.recruiterId)}`,
          { method: "GET", cache: "no-store", headers: { Accept: "application/json" } },
        );
        if (response.status === 404) {
          setConflictLocks((current) => setPersonnelConflictLock(current, intent.lockId, false));
          setConflictIntents((current) => {
            const next = new Map(current);
            next.delete(intent.lockId);
            return next;
          });
          setMutationMessage("Hồ sơ nhân sự không còn tồn tại hoặc không còn khả dụng. Danh sách đang được cập nhật.");
          setPendingIntent(null);
          setDialog(null);
          setListState({ kind: "loading" });
          setReloadToken((value) => value + 1);
          return;
        }
        if (response.status !== 200) throw new Error("reload");
        const personnel = projectPersonnelItem(await response.json());
        if (!personnel) throw new Error("reload");
        setListState((current) => current.kind === "loaded"
          ? {
              ...current,
              list: {
                ...current.list,
                personnel: current.list.personnel.map((row) =>
                  row.recruiter_id === personnel.recruiter_id ? personnel : row),
              },
            }
          : current);
      } else {
        const code = String(intent.body.personnel_code ?? "");
        const query = buildPersonnelListQuery({
          search: code,
          includeInactive: true,
          page: 1,
        });
        if (!query) throw new Error("reload");
        const response = await fetch(`/api/admin/catalog/personnel?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (response.status !== 200 || !projectPersonnelListForQuery(await response.json(), {
          search: code,
          includeInactive: true,
          page: 1,
        })) {
          throw new Error("reload");
        }
      }
      setConflictLocks((current) => setPersonnelConflictLock(current, intent.lockId, false));
      setConflictIntents((current) => {
        const next = new Map(current);
        next.delete(intent.lockId);
        return next;
      });
      setMutationMessage("Đã tải dữ liệu mới nhất. Bạn có thể bắt đầu thao tác mới.");
      setPendingIntent(null);
      setDialog(null);
      setListState({ kind: "loading" });
      setReloadToken((value) => value + 1);
    } catch {
      setConflictIntents((current) => {
        const next = new Map(current);
        const entry = next.get(intent.lockId);
        if (entry) {
          next.set(intent.lockId, {
            ...entry,
            error: "Không tải được dữ liệu có thẩm quyền. Thao tác vẫn đang bị khóa; hãy thử tải lại.",
          });
        }
        return next;
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const sendIntent = useCallback(async (intent: MutationIntent) => {
    setBusy(true);
    setMutationMessage(null);
    try {
      let response: Response;
      try {
        response = await fetch(intent.url, {
          method: intent.method,
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(intent.body),
        });
      } catch {
        setPendingIntent({ ...intent, retryState: "retry" });
        setMutationMessage("Không nhận được phản hồi. Có thể thử lại đúng thao tác này.");
        return;
      }
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const outcome = responseOutcome(response.status, payload, intent);
      if (outcome.kind === "applied") {
        setPendingIntent(null);
        setDialog(null);
        setForm(EMPTY_FORM);
        setMutationMessage("Đã lưu thay đổi. Danh sách đang được cập nhật.");
          setListState({ kind: "loading" });
          setReloadToken((value) => value + 1);
        return;
      }
      if (outcome.kind === "conflict") {
        setPendingIntent(null);
        setConflictIntents((current) => new Map(current).set(intent.lockId, { intent, error: null }));
        setConflictLocks((current) => setPersonnelConflictLock(current, intent.lockId, true));
        setMutationMessage(messageForOutcome(outcome));
        return;
      }
      if (outcome.kind === "unavailable") {
        setPendingIntent({ ...intent, retryState: "retry" });
      } else {
        setPendingIntent(null);
        setFormError(messageForOutcome(outcome));
      }
      setMutationMessage(outcome.kind === "unavailable" ? messageForOutcome(outcome) : null);
    } finally {
      setBusy(false);
    }
  }, []);

  const submitMutation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    if (!dialog) return;
    if (isConflictLocked) {
      setFormError("Hồ sơ đang bị khóa cho đến khi tải lại dữ liệu có thẩm quyền.");
      return;
    }
    if (pendingIntent) {
      setFormError("Có thao tác chưa nhận được kết quả. Hãy thử lại thao tác đó trước.");
      return;
    }

    const idempotencyKey = newPersonnelIntentKey();
    let request;
    let intent: MutationIntent;
    if (dialog.kind === "create") {
      request = buildPersonnelCreateRequest({
        personnelCode: form.personnelCode,
        displayName: form.displayName,
        personnelPosition: form.personnelPosition,
        validFrom: form.validFrom,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: "/api/admin/catalog/personnel",
        method: "POST",
        body: request.body,
        operation: "create",
        recruiterId: null,
        lockId: "create",
        retryState: "ready",
      };
    } else if (dialog.kind === "edit") {
      if (conflictLocks.has(dialog.personnel.recruiter_id)) {
        setFormError("Hồ sơ đang bị khóa cho đến khi tải lại dữ liệu có thẩm quyền.");
        return;
      }
      request = buildPersonnelUpdateRequest({
        personnelCode: form.personnelCode,
        displayName: form.displayName,
        personnelPosition: form.personnelPosition,
        expectedVersion: dialog.personnel.version,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: `/api/admin/catalog/personnel/${encodeURIComponent(dialog.personnel.recruiter_id)}`,
        method: "PATCH",
        body: request.body,
        operation: "update",
        recruiterId: dialog.personnel.recruiter_id,
        lockId: dialog.personnel.recruiter_id,
        retryState: "ready",
      };
    } else {
      if (conflictLocks.has(dialog.personnel.recruiter_id)) {
        setFormError("Hồ sơ đang bị khóa cho đến khi tải lại dữ liệu có thẩm quyền.");
        return;
      }
      request = buildPersonnelSetActiveRequest({
        active: dialog.active,
        expectedVersion: dialog.personnel.version,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: `/api/admin/catalog/personnel/${encodeURIComponent(dialog.personnel.recruiter_id)}/active`,
        method: "POST",
        body: request.body,
        operation: "set-active",
        recruiterId: dialog.personnel.recruiter_id,
        lockId: dialog.personnel.recruiter_id,
        retryState: "ready",
      };
    }
    setPendingIntent(intent);
    void sendIntent(intent);
  };

  const list = listState.kind === "loaded" ? listState.list : null;
  const pageCount = list
    ? Math.min(1000, Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size))))
    : 1;
  const dialogLockId = dialog === null
    ? null
    : dialog.kind === "create"
      ? "create"
      : dialog.personnel.recruiter_id;
  const isConflictLocked = dialogLockId !== null && conflictLocks.has(dialogLockId);

  return (
    <Dialog.Root
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open && !busy) setDialog(null);
      }}
    >
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Danh mục nhân sự</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Quản lý thông tin hồ sơ HRP. Vị trí trong hồ sơ chỉ là thuộc tính nghiệp vụ,
            không cấp quyền truy cập.
          </p>
        </div>
          <Dialog.Trigger asChild>
            <button
              type="button"
              onClick={startCreate}
              className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              Thêm nhân sự
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
            <Dialog.Content
              onCloseAutoFocus={(event) => {
                if (busy) event.preventDefault();
              }}
              className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-xl focus:outline-none sm:p-6"
              aria-describedby="personnel-dialog-description"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Dialog.Title className="text-xl font-semibold text-foreground">
                    {dialog?.kind === "create" ? "Thêm nhân sự" :
                      dialog?.kind === "edit" ? "Chỉnh sửa nhân sự" :
                        dialog?.active ? "Kích hoạt hồ sơ" : "Ngừng hoạt động hồ sơ"}
                  </Dialog.Title>
                  <Dialog.Description id="personnel-dialog-description" className="mt-1 text-sm text-muted">
                    Mọi thay đổi cần có lý do và được kiểm tra theo phiên bản hiện hành.
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Đóng hộp thoại"
                    disabled={busy}
                    className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </Dialog.Close>
              </div>

              {pendingIntent?.retryState === "retry" ? (
                <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
                  <p>Thử lại đúng thao tác này bằng cùng một khóa để tránh thay đổi trùng lặp.</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void sendIntent(pendingIntent)}
                    className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium disabled:opacity-50"
                  >
                    Thử lại thao tác
                  </button>
                </Alert>
              ) : null}
              {personnelConflictsForDialog(conflictIntents, dialogLockId).map(({ intent, error }) => (
                <ConflictReload
                  key={intent.lockId}
                  message={error}
                  busy={busy}
                  onReload={() => void reloadConflictedEntity(intent)}
                />
              ))}

              {dialog?.kind === "active" ? (
                <div className="mt-5 space-y-4">
                  <p>
                    {dialog.active ? "Bạn sắp kích hoạt hồ sơ" : "Bạn sắp ngừng hoạt động hồ sơ"}{" "}
                    <strong>{dialog.personnel.display_name}</strong>
                    {dialog.personnel.personnel_code
                      ? ` (${dialog.personnel.personnel_code})`
                      : ""}. Thao tác này không xóa dữ liệu.
                  </p>
                  <form onSubmit={submitMutation} className="space-y-4">
                    <ReasonField value={form.reason} onChange={(value) => changeForm("reason", value)} />
                    {formError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{formError}</p> : null}
                    <div className="flex flex-wrap justify-end gap-2">
                      <Dialog.Close asChild>
                        <button type="button" disabled={busy} className="min-h-11 rounded-md border border-border px-4 text-sm">
                          Hủy
                        </button>
                      </Dialog.Close>
                      <button
                        type="submit"
                        disabled={busy || isConflictLocked || pendingIntent !== null}
                        className="min-h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {busy ? "Đang lưu…" : dialog.active ? "Xác nhận kích hoạt" : "Xác nhận ngừng"}
                      </button>
                    </div>
                  </form>
                </div>
              ) : (
                <form onSubmit={submitMutation} className="mt-5 space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      id="personnel-code"
                      label="Mã nhân sự"
                      value={form.personnelCode}
                      maxLength={64}
                      required
                      onChange={(value) => changeForm("personnelCode", value)}
                    />
                    <Field
                      id="personnel-name"
                      label="Họ và tên"
                      value={form.displayName}
                      maxLength={256}
                      required
                      onChange={(value) => changeForm("displayName", value)}
                    />
                    <label className="block text-sm font-medium text-foreground" htmlFor="personnel-position">
                      Vị trí
                      <select
                        id="personnel-position"
                        value={form.personnelPosition}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          changeForm("personnelPosition", value === "STAFF" || value === "TEAM_LEADER" ? value : "");
                        }}
                        required
                        className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
                      >
                        <option value="">Chọn vị trí</option>
                        <option value="STAFF">Nhân viên</option>
                        <option value="TEAM_LEADER">Trưởng nhóm</option>
                      </select>
                      <span className="mt-1 block text-xs font-normal text-muted">
                        Vị trí không tự cấp quyền trong hệ thống.
                      </span>
                    </label>
                    {dialog?.kind === "create" ? (
                      <Field
                        id="personnel-valid-from"
                        label="Ngày hiệu lực HRP"
                        type="date"
                        value={form.validFrom}
                        required
                        onChange={(value) => changeForm("validFrom", value)}
                      />
                    ) : (
                      <div className="text-sm">
                        <span className="font-medium text-foreground">Phiên bản hiện tại</span>
                        <p className="mt-2 text-muted">{dialog?.kind === "edit" ? dialog.personnel.version : "—"}</p>
                      </div>
                    )}
                  </div>
                  <ReasonField value={form.reason} onChange={(value) => changeForm("reason", value)} />
                  {formError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{formError}</p> : null}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Dialog.Close asChild>
                      <button type="button" disabled={busy} className="min-h-11 rounded-md border border-border px-4 text-sm">
                        Hủy
                      </button>
                    </Dialog.Close>
                    <button
                      type="submit"
                      disabled={busy || isConflictLocked || pendingIntent !== null}
                      className="min-h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
                    >
                      {busy ? "Đang lưu…" : dialog?.kind === "create" ? "Tạo nhân sự" : "Lưu thay đổi"}
                    </button>
                  </div>
                </form>
              )}
            </Dialog.Content>
          </Dialog.Portal>

      </header>

      {pendingIntent?.retryState === "retry" ? (
        <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
          <p>Thử lại cùng khóa thao tác để tránh tạo thay đổi trùng lặp.</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void sendIntent(pendingIntent)}
            className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium disabled:opacity-50"
          >
            Thử lại thao tác
          </button>
        </Alert>
      ) : null}

      {dialog === null ? (
        Array.from(conflictIntents.values(), ({ intent, error }) => (
          <ConflictReload
            key={intent.lockId}
            message={error}
            busy={busy}
            onReload={() => void reloadConflictedEntity(intent)}
          />
        ))
      ) : null}

      {mutationMessage ? <Alert tone="info" title="Trạng thái thao tác">{mutationMessage}</Alert> : null}

      <Card>
        <CardHeader
          title="Danh sách nhân sự"
          description={list ? `${list.total} hồ sơ phù hợp` : "Tìm kiếm và lọc hồ sơ nhân sự."}
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const query = buildPersonnelListQuery({ search: searchInput, includeInactive, page: 1 });
            if (!query) {
              setListState({ kind: "error" });
              return;
            }
            setListState({ kind: "loading" });
            setPage(1);
            setSearch(searchInput.trim());
            setReloadToken((value) => value + 1);
          }}
          className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <label htmlFor="personnel-search" className="min-w-0 flex-1 text-sm font-medium">
            Tìm theo tên hoặc mã nhân sự
            <input
              id="personnel-search"
              value={searchInput}
              maxLength={256}
              onChange={(event) => setSearchInput(event.currentTarget.value)}
              className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
            />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => {
                setIncludeInactive(event.currentTarget.checked);
                setListState({ kind: "loading" });
                setPage(1);
              }}
              className="size-4 accent-primary"
            />
            Hiển thị hồ sơ ngừng hoạt động
          </label>
          <button type="submit" className="min-h-11 rounded-md border border-border px-4 text-sm font-medium">
            Tìm kiếm
          </button>
        </form>

        {listState.kind === "loading" ? (
          <p role="status" className="py-8 text-center text-sm text-muted">Đang tải danh sách nhân sự…</p>
        ) : null}
        {listState.kind === "denied" ? (
          <Alert tone="error" title="Không có quyền xem danh sách">
            Tài khoản hiện tại không được phép xem danh mục nhân sự.
          </Alert>
        ) : null}
        {listState.kind === "unavailable" ? (
          <div className="space-y-3">
            <Alert tone="warning" title="Danh sách hiện chưa khả dụng">
              Không thể kết nối hoặc dịch vụ chưa sẵn sàng. Dữ liệu không được thay bằng danh sách rỗng.
            </Alert>
            <button type="button" onClick={reloadList} className="min-h-11 rounded-md border border-border px-4 text-sm">
              Thử tải lại
            </button>
          </div>
        ) : null}
        {listState.kind === "error" ? (
          <div className="space-y-3">
            <ErrorState title="Không thể đọc dữ liệu nhân sự" detail="Phản hồi không đúng hợp đồng API hoặc bộ lọc không hợp lệ." />
            <button type="button" onClick={reloadList} className="min-h-11 rounded-md border border-border px-4 text-sm">
              Thử tải lại
            </button>
          </div>
        ) : null}
        {list ? (
          list.personnel.length === 0 ? (
            <EmptyState
              title="Không có hồ sơ phù hợp"
              description="Thử đổi từ khóa hoặc bật hiển thị hồ sơ ngừng hoạt động."
            />
          ) : (
            <>
              <div role="region" aria-label="Bảng danh sách nhân sự" tabIndex={0} className="overflow-x-auto rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
                <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                  <caption className="sr-only">Danh sách hồ sơ nhân sự</caption>
                  <thead className="bg-muted/20">
                    <tr>
                      <th scope="col" className="px-3 py-3 font-semibold">Nhân sự</th>
                      <th scope="col" className="px-3 py-3 font-semibold">Vị trí</th>
                      <th scope="col" className="px-3 py-3 font-semibold">Trạng thái</th>
                      <th scope="col" className="px-3 py-3 font-semibold">Phiên bản</th>
                      <th scope="col" className="px-3 py-3 font-semibold">Hiệu lực HRP</th>
                      <th scope="col" className="px-3 py-3 font-semibold">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {list.personnel.map((personnel) => (
                      <tr key={personnel.recruiter_id} className="align-top">
                        <th scope="row" className="px-3 py-3 font-medium">
                          <span className="block">{personnel.display_name}</span>
                          <span className="mt-1 block text-xs text-muted">
                            {personnel.personnel_code ?? "Chưa có mã nhân sự"}
                          </span>
                        </th>
                        <td className="px-3 py-3">{positionLabel(personnel.personnel_position)}</td>
                        <td className="px-3 py-3">
                          <span className={personnel.active
                            ? "inline-flex rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
                            : "inline-flex rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground"}>
                            {personnel.active ? "Đang hoạt động" : "Ngừng hoạt động"}
                          </span>
                        </td>
                        <td className="px-3 py-3 tabular-nums">{personnel.version}</td>
                        <td className="px-3 py-3">{formatHrpDate(personnel.hrp_valid_from)}</td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-2">
                            <Dialog.Trigger asChild>
                              <button
                                type="button"
                                onClick={() => startEdit(personnel)}
                                disabled={conflictLocks.has(personnel.recruiter_id)}
                                className="min-h-10 rounded-md border border-border px-3 text-xs font-medium disabled:opacity-50"
                              >
                                Chỉnh sửa
                              </button>
                            </Dialog.Trigger>
                            <Dialog.Trigger asChild>
                              <button
                                type="button"
                                onClick={() => startActiveChange(personnel, !personnel.active)}
                                disabled={conflictLocks.has(personnel.recruiter_id)}
                                className="min-h-10 rounded-md border border-border px-3 text-xs font-medium disabled:opacity-50"
                              >
                                {personnel.active ? "Ngừng hoạt động" : "Kích hoạt"}
                              </button>
                            </Dialog.Trigger>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted">Trang {page} / {pageCount}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => {
                      setListState({ kind: "loading" });
                      setPage((value) => Math.max(1, value - 1));
                    }}
                    className="min-h-11 rounded-md border border-border px-4 text-sm disabled:opacity-50"
                  >
                    Trang trước
                  </button>
                  <button
                    type="button"
                    disabled={page >= pageCount}
                    onClick={() => {
                      setListState({ kind: "loading" });
                      setPage((value) => Math.min(1000, value + 1));
                    }}
                    className="min-h-11 rounded-md border border-border px-4 text-sm disabled:opacity-50"
                  >
                    Trang sau
                  </button>
                </div>
              </div>
            </>
          )
        ) : null}
      </Card>
    </div>
    </Dialog.Root>
  );

}

function Field({
  id,
  label,
  value,
  type = "text",
  maxLength,
  required = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  type?: string;
  maxLength?: number;
  required?: boolean;
  onChange(value: string): void;
}) {
  return (
    <label htmlFor={id} className="block text-sm font-medium text-foreground">
      {label}
      <input
        id={id}
        type={type}
        value={value}
        maxLength={maxLength}
        required={required}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
      />
    </label>
  );
}

function ReasonField({ value, onChange }: { value: string; onChange(value: string): void }) {
  return (
    <label htmlFor="personnel-reason" className="block text-sm font-medium text-foreground">
      Lý do thay đổi <span aria-hidden="true">*</span>
      <textarea
        id="personnel-reason"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        required
        maxLength={4000}
        rows={3}
        className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
    </label>
  );
}

function ConflictReload({ message, busy, onReload }: {
  message: string | null;
  busy: boolean;
  onReload(): void;
}) {
  return (
    <Alert tone="warning" title="Thao tác đang bị khóa do xung đột phiên bản">
      <p>{message ?? "Tải lại hồ sơ có thẩm quyền trước khi bắt đầu thao tác mới."}</p>
      <button type="button" onClick={onReload} disabled={busy} className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium disabled:opacity-50">
        {busy ? "Đang tải…" : "Tải lại hồ sơ"}
      </button>
    </Alert>
  );
}
