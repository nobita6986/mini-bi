"use client";

import { useEffect, useState, type FormEvent } from "react";
import * as Dialog from "radix-ui/dialog";

import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import type {
  ExistingAccount,
  ExistingAccountList,
} from "@/lib/direct-entry/app-user-access-contract";
import {
  buildAccountListQuery,
  buildAccountStateRequest,
  classifyAccountMutation,
  newAccountIntentKey,
  projectAccountItem,
  projectAccountListForQuery,
  type AccountEnabledFilter,
} from "@/lib/admin/account-access-model";

type ListState =
  | { kind: "loading" }
  | { kind: "loaded"; list: ExistingAccountList }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "error" };

type DialogState = { account: ExistingAccount; nextEnabled: boolean };

type MutationIntent = {
  url: string;
  method: "POST";
  operation: "enable" | "disable";
  accountRef: string;
  lockId: string;
  body: Record<string, unknown>;
  retry: boolean;
};

const button = "inline-flex min-h-10 items-center justify-center rounded-md border border-border " +
  "bg-surface px-3 text-sm font-medium text-foreground focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = "inline-flex min-h-10 items-center justify-center rounded-md bg-primary " +
  "px-4 text-sm font-medium text-on-primary focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span className={enabled
      ? "inline-flex whitespace-nowrap rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
      : "inline-flex whitespace-nowrap rounded-full bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-900 dark:bg-slate-700 dark:text-slate-100"}>
      {enabled ? "Đang hoạt động" : "Ngừng hoạt động"}
    </span>
  );
}

export function AccountManager() {
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [enabledFilter, setEnabledFilter] = useState<AccountEnabledFilter>("all");
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingIntent, setPendingIntent] = useState<MutationIntent | null>(null);
  const [conflictIntent, setConflictIntent] = useState<MutationIntent | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const query = buildAccountListQuery({ search, enabled: enabledFilter, page });
      if (!query) {
        setListState({ kind: "error" });
        return;
      }
      let response: Response;
      try {
        response = await fetch(`/api/admin/access/accounts?${query.toString()}`, {
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
        const list = projectAccountListForQuery(await response.json(), {
          search, enabled: enabledFilter, page,
        });
        if (!list) {
          setListState({ kind: "error" });
          return;
        }
        const pageCount = Math.min(1000, Math.max(1,
          Math.ceil(list.total / Math.max(1, list.page_size))));
        if (page > pageCount) {
          setPage(pageCount);
          return;
        }
        setListState({ kind: "loaded", list });
      } catch {
        setListState({ kind: "error" });
      }
    })();
    return () => controller.abort();
  }, [enabledFilter, page, reloadToken, search]);

  const reloadList = () => {
    setListState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  const startStateChange = (account: ExistingAccount, nextEnabled: boolean) => {
    setReason("");
    setFormError(null);
    setDialog({ account, nextEnabled });
  };

  const reloadAuthoritative = async (intent: MutationIntent) => {
    setConflictError(null);
    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/access/accounts/${encodeURIComponent(intent.accountRef)}`,
        { method: "GET", cache: "no-store", headers: { Accept: "application/json" } },
      );
      if (response.status === 404) {
        setConflictIntent(null);
        setPendingIntent(null);
        setDialog(null);
        setNotice("Tài khoản không còn khả dụng. Danh sách đang được cập nhật.");
        reloadList();
        return;
      }
      const account = response.status === 200 ? projectAccountItem(await response.json()) : null;
      if (!account || account.account_ref !== intent.accountRef) {
        throw new Error("authoritative reload failed");
      }
      setConflictIntent(null);
      setConflictError(null);
      setPendingIntent(null);
      setDialog(null);
      setNotice("Đã tải dữ liệu mới nhất từ máy chủ.");
      reloadList();
    } catch {
      setConflictError("Không tải được dữ liệu có thẩm quyền. Thao tác vẫn đang bị khóa; hãy thử tải lại.");
    } finally {
      setBusy(false);
    }
  };

  const sendIntent = async (intent: MutationIntent) => {
    setBusy(true);
    setNotice(null);
    try {
      let response: Response;
      try {
        response = await fetch(intent.url, {
          method: intent.method,
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": String(intent.body.idempotency_key),
          },
          body: JSON.stringify(intent.body),
        });
      } catch {
        setPendingIntent({ ...intent, retry: true });
        setNotice("Không nhận được phản hồi. Có thể thử lại đúng thao tác với cùng khóa idempotency.");
        return;
      }
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const outcome = classifyAccountMutation(response.status, payload);
      if (outcome.kind === "applied" || outcome.kind === "conflict") {
        setPendingIntent(null);
        setConflictIntent(intent);
        setConflictError(null);
        setNotice(outcome.kind === "applied"
          ? "Đã lưu thay đổi. Đang xác minh dữ liệu mới nhất."
          : outcome.message);
        await reloadAuthoritative(intent);
        return;
      }
      if (outcome.kind === "unavailable") {
        setPendingIntent({ ...intent, retry: true });
        setNotice(outcome.message);
        return;
      }
      setPendingIntent(null);
      setFormError(outcome.message);
      if (outcome.kind === "not-found") {
        setDialog(null);
        reloadList();
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    if (!dialog) return;
    if (pendingIntent || conflictIntent) {
      setFormError("Thao tác trước vẫn cần được xác nhận hoặc tải lại dữ liệu.");
      return;
    }
    const request = buildAccountStateRequest({
      expectedVersion: dialog.account.version,
      reason,
      idempotencyKey: newAccountIntentKey(),
    });
    if (!request.ok) {
      setFormError(request.message);
      return;
    }
    const intent: MutationIntent = {
      url: `/api/admin/access/accounts/${encodeURIComponent(dialog.account.account_ref)}/${dialog.nextEnabled ? "enable" : "disable"}`,
      method: "POST",
      operation: dialog.nextEnabled ? "enable" : "disable",
      accountRef: dialog.account.account_ref,
      lockId: dialog.account.account_ref,
      body: request.body,
      retry: false,
    };
    setPendingIntent(intent);
    void sendIntent(intent);
  };

  const list = listState.kind === "loaded" ? listState.list : null;
  const pageCount = list
    ? Math.min(1000, Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size))))
    : 1;
  const locked = busy || pendingIntent !== null || conflictIntent !== null;

  return (
    <>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Tài khoản</h1>
          <p className="mt-1 text-sm text-muted">Quản lý trạng thái hoạt động của tài khoản hiện có. Mọi thay đổi cần có lý do.</p>
        </div>
      </header>

      <Dialog.Root open={dialog !== null}
        onOpenChange={(open) => { if (!open && !busy && !conflictIntent) setDialog(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Content
            onCloseAutoFocus={(event) => { if (busy || conflictIntent) event.preventDefault(); }}
            className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-xl focus:outline-none sm:p-6"
            aria-describedby="account-dialog-description"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-xl font-semibold text-foreground">
                  {dialog?.nextEnabled ? "Kích hoạt tài khoản" : "Ngừng hoạt động tài khoản"}
                </Dialog.Title>
                <Dialog.Description id="account-dialog-description" className="mt-1 text-sm text-muted">
                  Mọi thay đổi cần có lý do; thao tác không xóa dữ liệu hay lịch sử.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button type="button" aria-label="Đóng hộp thoại" disabled={busy || conflictIntent !== null}
                  className={button}>×</button>
              </Dialog.Close>
            </div>
            {pendingIntent?.retry && dialog && pendingIntent.lockId === dialog.account.account_ref ? (
              <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
                <p>Thử lại đúng thao tác với cùng khóa idempotency.</p>
                <button type="button" disabled={busy} className={`${button} mt-2`}
                  onClick={() => void sendIntent(pendingIntent)}>Thử lại thao tác</button>
              </Alert>
            ) : null}
            {conflictIntent && dialog && conflictIntent.lockId === dialog.account.account_ref ? (
              <ConflictReload
                message={conflictError}
                busy={busy}
                onReload={() => void reloadAuthoritative(conflictIntent)}
              />
            ) : null}
            {dialog ? (
              <div className="mt-5 space-y-4">
                <p>
                  Bạn sắp {dialog.nextEnabled ? "kích hoạt" : "ngừng hoạt động"} tài khoản{" "}
                  <strong>{dialog.account.display_name}</strong>.
                </p>
                <form onSubmit={submit} className="space-y-4">
                  <ReasonField value={reason} onChange={(value) => { setReason(value); setFormError(null); setNotice(null); }} />
                  {formError ? <p role="alert" className="text-sm text-red-700">{formError}</p> : null}
                  <button type="submit" disabled={locked} className={primaryButton}>
                    {busy ? "Đang lưu…" : dialog.nextEnabled ? "Xác nhận kích hoạt" : "Xác nhận ngừng"}
                  </button>
                </form>
              </div>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {pendingIntent?.retry && dialog === null ? (
        <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
          <p>Thử lại cùng thao tác với cùng khóa idempotency.</p>
          <button type="button" disabled={busy} className={`${button} mt-2`}
            onClick={() => void sendIntent(pendingIntent)}>Thử lại thao tác</button>
        </Alert>
      ) : null}
      {conflictIntent && dialog === null ? (
        <ConflictReload message={conflictError} busy={busy}
          onReload={() => void reloadAuthoritative(conflictIntent)} />
      ) : null}
      {notice ? <Alert tone="info" title="Trạng thái thao tác">{notice}</Alert> : null}

      <Card>
        <CardHeader title="Danh sách tài khoản"
          description={list ? `${list.total} tài khoản phù hợp` : "Tìm kiếm theo tên hiển thị và lọc theo trạng thái."} />
        <form className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]" onSubmit={(event) => {
          event.preventDefault();
          const query = buildAccountListQuery({ search: searchInput, enabled: enabledFilter, page: 1 });
          if (!query) {
            setListState({ kind: "error" });
            return;
          }
          setPage(1);
          setSearch(searchInput.trim());
          setListState({ kind: "loading" });
        }}>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Tìm kiếm theo tên hiển thị
            <input value={searchInput} maxLength={256} onChange={(event) => setSearchInput(event.target.value)}
              className="min-h-10 rounded-md border border-border bg-surface px-3 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Trạng thái
            <select value={enabledFilter} onChange={(event) => {
              setEnabledFilter(event.target.value as AccountEnabledFilter);
              setPage(1);
              setListState({ kind: "loading" });
            }}
              className="min-h-10 rounded-md border border-border bg-surface px-3 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
              <option value="all">Tất cả</option>
              <option value="true">Đang hoạt động</option>
              <option value="false">Ngừng hoạt động</option>
            </select>
          </label>
          <button type="submit" className={`${button} self-end`}>Tìm kiếm</button>
        </form>

        {listState.kind === "loading" ? <p role="status" className="py-8 text-center text-sm text-muted">Đang tải danh sách tài khoản…</p> : null}
        {listState.kind === "denied" ? <ErrorState title="Không có quyền xem danh sách tài khoản" /> : null}
        {listState.kind === "unavailable" ? (
          <div className="space-y-3">
            <ErrorState title="Dịch vụ tài khoản hiện không khả dụng" />
            <button type="button" className={button} onClick={reloadList}>Thử tải lại</button>
          </div>
        ) : null}
        {listState.kind === "error" ? (
          <div className="space-y-3">
            <ErrorState title="Không tải được danh sách tài khoản" detail="Phản hồi không hợp lệ. Hãy thử tải lại." />
            <button type="button" className={button} onClick={reloadList}>Thử tải lại</button>
          </div>
        ) : null}
        {list ? list.accounts.length === 0 ? (
          <EmptyState title="Chưa có tài khoản phù hợp" description="Thay đổi từ khóa tìm kiếm hoặc bộ lọc trạng thái." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse text-left text-sm">
                <caption className="sr-only">Danh sách tài khoản và trạng thái hoạt động</caption>
                <thead className="border-b border-border text-xs uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-3">Tên hiển thị</th>
                    <th scope="col" className="px-3 py-3">Trạng thái</th>
                    <th scope="col" className="px-3 py-3 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {list.accounts.map((account) => (
                    <tr key={account.account_ref} className="border-b border-border/70 last:border-0">
                      <td className="px-3 py-3 font-medium">{account.display_name}</td>
                      <td className="px-3 py-3"><EnabledBadge enabled={account.enabled} /></td>
                      <td className="px-3 py-3">
                        <div className="flex justify-end gap-2 whitespace-nowrap">
                          <button type="button" className={button} disabled={locked}
                            onClick={() => startStateChange(account, !account.enabled)}>
                            {account.enabled ? "Ngừng hoạt động" : "Kích hoạt"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex flex-col gap-3 border-t border-border pt-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <p aria-live="polite">Trang {page} / {pageCount} · {list.total} kết quả</p>
              <nav aria-label="Phân trang danh sách tài khoản" className="flex items-center gap-2">
                <button type="button" className={button} disabled={page <= 1}
                  onClick={() => { setPage((value) => value - 1); setListState({ kind: "loading" }); }}>
                  Trang trước
                </button>
                <button type="button" className={button} disabled={page >= pageCount}
                  onClick={() => { setPage((value) => value + 1); setListState({ kind: "loading" }); }}>
                  Trang sau
                </button>
              </nav>
            </div>
          </>
        ) : null}
      </Card>
    </>
  );
}

function ReasonField({ value, onChange }: { value: string; onChange(value: string): void }) {
  return (
    <label htmlFor="account-reason" className="flex flex-col gap-1 text-sm font-medium">
      Lý do thay đổi
      <textarea id="account-reason" value={value} maxLength={4000} required rows={3}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-border bg-surface px-3 py-2 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
    </label>
  );
}

function ConflictReload({ message, busy, onReload }: {
  message: string | null; busy: boolean; onReload(): void;
}) {
  return (
    <Alert tone="warning" title="Cần tải lại dữ liệu có thẩm quyền">
      <p>Thao tác đang bị khóa để tránh ghi đè thay đổi mới hơn.</p>
      {message ? <p role="alert">{message}</p> : null}
      <button type="button" disabled={busy} onClick={onReload}
        className="mt-2 inline-flex min-h-10 items-center rounded-md border border-current px-3 font-medium disabled:opacity-50">
        {busy ? "Đang tải…" : "Tải lại dữ liệu"}
      </button>
    </Alert>
  );
}
