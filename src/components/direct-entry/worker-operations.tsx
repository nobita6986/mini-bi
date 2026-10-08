"use client";

/**
 * P2.5-W06 - Worker Operations UI.
 *
 * Ba tab KHONG tron quyen: "Tôi đã nhập" (submission API, chi tra cuu),
 * "Người tôi tuyển" (directory scope=recruited), "Dự án tôi quản lý" (scope=managed).
 *
 * Moi CTA de xuat chi duoc render khi server tra allowed_actions.propose_change === true;
 * khi khong co quyen thi CTA VANG MAT (khong chi disable). Khong suy quyen tu role/email/
 * created_by/recruiter_id hay du lieu client.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Dialog } from "radix-ui";

import { AccessDenied } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import {
  BANK_ACCOUNT_SECTION_LABEL,
  WORKER_CONFLICT_MESSAGE,
  WORKER_OPERATIONS_TAB_HINTS,
  WORKER_OPERATIONS_TAB_LABELS,
  WORKER_OPERATIONS_TABS,
  bankAccountSummary,
  isWorkerOperationsTab,
  lastDecisionLabel,
  parseSubmissionPageResponse,
  parseWorkerPageResponse,
  pendingRequestLabel,
  proposeCta,
  tabScope,
  workerListErrorMessage,
  workerStatusLabel,
  type WorkerOperationsTab,
} from "@/lib/direct-entry/worker-operations-model";
import type {
  SubmissionReadItem,
  WorkerDirectoryRow,
} from "@/lib/direct-entry/worker-operations-model";
import { WORKER_EMPLOYMENT_STATUSES } from "@/lib/direct-entry/worker-directory-contract.ts";

const API = "/api/direct-entry";
const PAGE_SIZE = 25;

type ViewState = "loading" | "ready" | "empty" | "denied" | "unavailable" | "error";

type LoadResult = {
  state: ViewState;
  notice?: string;
  workers?: WorkerDirectoryRow[];
  submissions?: SubmissionReadItem[];
};

const tabClass =
  "inline-flex h-10 items-center rounded-md px-3 text-sm font-medium focus-visible:ring-2 " +
  "focus-visible:ring-ring/40";
const buttonClass =
  "inline-flex h-10 items-center justify-center rounded-md border border-input px-3 text-sm " +
  "font-medium focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50";
const primaryClass =
  "inline-flex h-10 items-center justify-center rounded-md bg-primary px-3 text-sm " +
  "font-medium text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring/40 " +
  "disabled:opacity-50";
const inputClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function WorkerOperations({ initialTab = "uploader" }: { initialTab?: WorkerOperationsTab }) {
  const [tab, setTab] = useState<WorkerOperationsTab>(
    isWorkerOperationsTab(initialTab) ? initialTab : "uploader",
  );
  const [state, setState] = useState<ViewState>("loading");
  const [workers, setWorkers] = useState<WorkerDirectoryRow[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionReadItem[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [drawerRow, setDrawerRow] = useState<WorkerDirectoryRow | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const filterId = useId();

  const scope = tabScope(tab);

  const fetchList = useCallback(async (
    nextTab: WorkerOperationsTab, status: string,
  ): Promise<LoadResult> => {
    const nextScope = tabScope(nextTab);
    const headers = { accept: "application/json" };
    if (nextScope === null) {
      const response = await fetch(API + "/submissions?page_size=" + String(PAGE_SIZE), { headers });
      if (response.status === 403) return { state: "denied" };
      if (response.status >= 500) return { state: "unavailable" };
      const parsed = parseSubmissionPageResponse(await readJson(response), { page_size: PAGE_SIZE });
      if (response.status !== 200 || parsed === null) return { state: "error" };
      return { state: parsed.items.length === 0 ? "empty" : "ready",
        submissions: parsed.items, workers: [] };
    }
    let url = API + "/workers?scope=" + nextScope + "&page_size=" + String(PAGE_SIZE);
    if (status !== "") url += "&employment_status=" + encodeURIComponent(status);
    const response = await fetch(url, { headers });
    if (response.status === 403) return { state: "denied" };
    if (response.status >= 500) return { state: "unavailable" };
    if (response.status === 400) return { state: "error", notice: workerListErrorMessage(400) };
    const parsed = parseWorkerPageResponse(await readJson(response), {
      scope: nextScope, page_size: PAGE_SIZE,
    });
    if (response.status !== 200 || parsed === null) return { state: "error" };
    return { state: parsed.items.length === 0 ? "empty" : "ready",
      workers: parsed.items, submissions: [] };
  }, []);

  const applyResult = useCallback((result: LoadResult) => {
    if (result.workers !== undefined) setWorkers(result.workers);
    if (result.submissions !== undefined) setSubmissions(result.submissions);
    setNotice(result.notice ?? null);
    setState(result.state);
  }, []);

  const load = useCallback(async (nextTab: WorkerOperationsTab, status: string) => {
    try {
      applyResult(await fetchList(nextTab, status));
    } catch {
      setState("unavailable");
    }
  }, [applyResult, fetchList]);

  useEffect(() => {
    let active = true;
    fetchList(tab, statusFilter).then(
      (result) => { if (active) applyResult(result); },
      () => { if (active) setState("unavailable"); },
    );
    return () => { active = false; };
  }, [fetchList, tab, statusFilter, applyResult]);

  function selectTab(next: WorkerOperationsTab, focus = true) {
    setTab(next);
    setStatusFilter("");
    if (focus) {
      const index = WORKER_OPERATIONS_TABS.indexOf(next);
      tabRefs.current[index]?.focus();
    }
  }

  function onTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = WORKER_OPERATIONS_TABS.length - 1;
    let next = -1;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next < 0) return;
    event.preventDefault();
    selectTab(WORKER_OPERATIONS_TABS[next]);
  }

  async function reload(): Promise<void> {
    setConflict(null);
    await load(tab, statusFilter);
  }

  if (state === "denied") return <AccessDenied />;
  if (state === "unavailable") return <TemporaryUnavailable />;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Người lao động</h1>
        <p className="text-sm text-muted-foreground">
          Tra cứu theo đúng quan hệ của bạn. Quyền đề xuất thay đổi do hệ thống quyết định.
        </p>
      </header>

      <div role="tablist" aria-label="Quan hệ người lao động" className="flex flex-wrap gap-1 border-b">
        {WORKER_OPERATIONS_TABS.map((value, index) => (
          <button
            key={value}
            ref={(element) => { tabRefs.current[index] = element; }}
            type="button"
            role="tab"
            id={"workers-tab-" + value}
            aria-selected={tab === value}
            aria-controls={"workers-panel-" + value}
            tabIndex={tab === value ? 0 : -1}
            className={tabClass + (tab === value ? " border-b-2 border-primary text-foreground" : " text-muted-foreground")}
            onClick={() => selectTab(value, false)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {WORKER_OPERATIONS_TAB_LABELS[value]}
          </button>
        ))}
      </div>

      {conflict ? (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <span>{conflict}</span>
          <button type="button" className={buttonClass} onClick={() => void reload()}>
            Tải lại dữ liệu
          </button>
        </div>
      ) : null}

      {notice ? (
        <p role="alert" className="rounded-md border border-input p-3 text-sm">{notice}</p>
      ) : null}

      <section
        role="tabpanel"
        id={"workers-panel-" + tab}
        aria-labelledby={"workers-tab-" + tab}
        className="flex flex-col gap-3"
        aria-busy={state === "loading"}
      >
        <p className="text-sm text-muted-foreground">{WORKER_OPERATIONS_TAB_HINTS[tab]}</p>

        {tab === "uploader" ? null : (
          <div className="flex flex-col gap-1 sm:max-w-xs">
            <label htmlFor={filterId} className="text-sm font-medium">Trạng thái làm việc</label>
            <select
              id={filterId}
              className={inputClass}
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">Tất cả</option>
              {WORKER_EMPLOYMENT_STATUSES.map((status) => (
                <option key={status} value={status}>{workerStatusLabel(status)}</option>
              ))}
            </select>
          </div>
        )}

        {state === "loading" ? (
          <p role="status" className="text-sm text-muted-foreground">Đang tải dữ liệu…</p>
        ) : null}
        {state === "empty" ? (
          <p role="status" className="text-sm text-muted-foreground">
            Không có người lao động nào trong quan hệ này.
          </p>
        ) : null}
        {state === "error" ? (
          <div role="alert" className="flex flex-col gap-2 text-sm">
            <span>Không tải được danh sách.</span>
            <button type="button" className={buttonClass} onClick={() => void reload()}>Thử lại</button>
          </div>
        ) : null}

        {state === "ready" && tab === "uploader" ? (
          <SubmissionTable submissions={submissions} />
        ) : null}
        {state === "ready" && tab !== "uploader" ? (
          <WorkerTable
            rows={workers}
            onPropose={(row) => setDrawerRow(row)}
            onConflict={(message) => setConflict(message)}
          />
        ) : null}
      </section>

      <ProposeDrawer
        key={drawerRow === null ? "none" : drawerRow.entry_id}
        row={drawerRow}
        onOpenChange={(open) => { if (!open) setDrawerRow(null); }}
        onDone={(message) => { setNotice(message); setDrawerRow(null); void reload(); }}
        onConflict={() => { setDrawerRow(null); setConflict(WORKER_CONFLICT_MESSAGE); }}
      />
    </main>
  );
}

function SubmissionTable({ submissions }: { submissions: readonly SubmissionReadItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <caption className="sr-only">Hồ sơ bạn đã nhập (chỉ tra cứu)</caption>
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="p-3">Trạng thái</th>
            <th scope="col" className="p-3">Số dòng</th>
            <th scope="col" className="p-3">Cập nhật</th>
          </tr>
        </thead>
        <tbody>
          {submissions.map((item) => (
            <tr key={item.submission_id} className="border-b last:border-0">
              <td className="p-3">{item.state}</td>
              <td className="p-3">{item.entry_count}</td>
              <td className="p-3">{item.updated_at.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkerTable({
  rows, onPropose, onConflict,
}: {
  rows: readonly WorkerDirectoryRow[];
  onPropose: (row: WorkerDirectoryRow) => void;
  onConflict: (message: string) => void;
}) {
  void onConflict;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] border-collapse text-sm">
        <caption className="sr-only">Danh sách người lao động theo quan hệ đã chọn</caption>
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="p-3">Người lao động</th>
            <th scope="col" className="p-3">Mã</th>
            <th scope="col" className="p-3">Dự án</th>
            <th scope="col" className="p-3">Ngày đầu tiên</th>
            <th scope="col" className="p-3">Người tuyển</th>
            <th scope="col" className="p-3">Trạng thái</th>
            <th scope="col" className="p-3">Yêu cầu</th>
            <th scope="col" className="p-3">Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cta = proposeCta(row);
            const bank = bankAccountSummary(row.payment);
            return (
              <tr key={row.entry_id} className="border-b last:border-0 align-top">
                <td className="p-3 font-medium">{row.display_name}</td>
                <td className="p-3">{row.employee_code}</td>
                <td className="p-3">{row.project_display}</td>
                <td className="p-3">{row.first_work_date}</td>
                <td className="p-3">{row.recruiter_display}</td>
                <td className="p-3">
                  {workerStatusLabel(row.employment_status)}
                  {bank ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      <span className="font-medium">{BANK_ACCOUNT_SECTION_LABEL}: </span>
                      {(bank.accountNumber ?? "chưa có") + " · " + (bank.bankId ?? "chưa có") +
                        " · " + (bank.accountHolder ?? "chưa có")}
                    </div>
                  ) : null}
                </td>
                <td className="p-3 text-xs">
                  {pendingRequestLabel(row) ? (
                    <span className="rounded bg-muted/20 px-2 py-1">{pendingRequestLabel(row)}</span>
                  ) : null}
                  {lastDecisionLabel(row) ? (
                    <div className="mt-1 text-muted-foreground">{lastDecisionLabel(row)}</div>
                  ) : null}
                </td>
                <td className="p-3">
                  {cta.show ? (
                    <button type="button" className={primaryClass} onClick={() => onPropose(row)}>
                      Đề xuất thay đổi
                    </button>
                  ) : (
                    <span className="text-xs text-muted-foreground">{cta.message}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type EntryBaseline = {
  version: number;
  workerDetails: Record<string, unknown> | null;
  status: string | null;
  effectiveDate: string | null;
};

async function fetchBaseline(entryId: string): Promise<EntryBaseline | null> {
  try {
    const response = await fetch(API + "/entries/" + encodeURIComponent(entryId), {
      headers: { accept: "application/json" },
    });
    if (response.status !== 200) return null;
    const body = await readJson(response);
    if (typeof body !== "object" || body === null) return null;
    const record = body as Record<string, unknown>;
    const entry = record.entry;
    if (typeof entry !== "object" || entry === null) return null;
    const row = entry as Record<string, unknown>;
    const version = typeof row.version === "number" ? row.version : null;
    if (version === null) return null;
    const details = typeof row.worker_details === "object" && row.worker_details !== null
      ? row.worker_details as Record<string, unknown> : null;
    const status = typeof row.employment_status === "object" && row.employment_status !== null
      ? row.employment_status as Record<string, unknown> : null;
    return {
      version,
      workerDetails: details,
      status: status && typeof status.status === "string" ? status.status : null,
      effectiveDate: status && typeof status.effective_date === "string" ? status.effective_date : null,
    };
  } catch {
    return null;
  }
}

function ProposeDrawer({
  row, onOpenChange, onDone, onConflict,
}: {
  row: WorkerDirectoryRow | null;
  onOpenChange: (open: boolean) => void;
  onDone: (message: string) => void;
  onConflict: () => void;
}) {
  const reasonId = useId();
  const [baseline, setBaseline] = useState<EntryBaseline | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [targetStatus, setTargetStatus] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [leaveReason, setLeaveReason] = useState("");

  useEffect(() => {
    if (row === null) return;
    let active = true;
    fetchBaseline(row.entry_id).then(
      (value) => { if (active) { setBaseline(value); setLoading(false); } },
      () => { if (active) { setBaseline(null); setLoading(false); } },
    );
    return () => { active = false; };
  }, [row]);

  async function submit(): Promise<void> {
    if (row === null || baseline === null) return;
    const trimmed = reason.trim();
    if (trimmed === "") { setMessage("Lý do là bắt buộc."); return; }
    if (targetStatus === "") { setMessage("Chọn trạng thái làm việc mới."); return; }
    setBusy(true);
    try {
      const { buildWorkStatusProposal, buildChangeRequestItem, proposalErrorMessage } =
        await import("@/lib/direct-entry/change-request-proposal-builders");
      const built = buildWorkStatusProposal({
        baseline: baseline.status === null ? null : {
          status: baseline.status as "UNCONFIRMED" | "ON" | "OFF",
          effective_date: baseline.effectiveDate ?? row.first_work_date,
        },
        status: targetStatus as "UNCONFIRMED" | "ON" | "OFF",
        effectiveDate: effectiveDate === "" ? (baseline.effectiveDate ?? row.first_work_date) : effectiveDate,
        leaveReason,
        today: new Date().toISOString().slice(0, 10),
      });
      if (!built.ok) { setBusy(false); setMessage(proposalErrorMessage(built.code)); return; }
      const item = buildChangeRequestItem({
        entryId: row.entry_id,
        expectedVersion: row.entry_version,
        targetKind: "WORK_STATUS",
        proposal: built.proposal,
      });
      if (item === null) { setBusy(false); setMessage("Đề xuất không hợp lệ."); return; }
      const response = await fetch(API + "/change-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [item], reason: trimmed, idempotency_key: crypto.randomUUID(),
        }),
      });
      setBusy(false);
      if (response.status === 409) { onConflict(); return; }
      if (response.status === 403) { setMessage("Bạn không còn quyền đề xuất thay đổi."); return; }
      if (response.status !== 200 && response.status !== 201) {
        setMessage("Không gửi được yêu cầu thay đổi. Vui lòng thử lại.");
        return;
      }
      onDone("Đã gửi yêu cầu thay đổi trạng thái làm việc.");
    } catch {
      setBusy(false);
      setMessage("Không gửi được yêu cầu thay đổi. Vui lòng thử lại.");
    }
  }

  return (
    <Dialog.Root open={row !== null} onOpenChange={(open) => { if (!open && !busy) onOpenChange(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[min(94vw,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-card p-4 shadow-lg">
          <form className="flex flex-col gap-3"
            onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <Dialog.Title className="text-base font-medium">Đề xuất thay đổi</Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground">
              {row === null ? "" : row.display_name + " · " + row.employee_code}
            </Dialog.Description>
            <p className="text-xs text-muted-foreground">
              Thông tin định danh, dự án, ngày đầu tiên, người tuyển và loại hình lao động
              là trường được bảo vệ: chỉ xem, không đề xuất thay đổi.
            </p>
            {loading ? <p role="status" className="text-sm">Đang tải dữ liệu…</p> : null}
            {!loading && baseline === null ? (
              <p role="alert" className="text-sm">Không đọc được dữ liệu hiện tại của dòng này.</p>
            ) : null}
            <div className="flex flex-col gap-1">
              <label htmlFor="worker-target-status" className="text-sm font-medium">Trạng thái làm việc mới</label>
              <select id="worker-target-status" className={inputClass} value={targetStatus}
                onChange={(event) => setTargetStatus(event.target.value)}>
                <option value="">Chọn trạng thái</option>
                <option value="ON">Đang làm</option>
                <option value="OFF">Đã nghỉ</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="worker-effective-date" className="text-sm font-medium">Ngày hiệu lực</label>
              <input id="worker-effective-date" className={inputClass} value={effectiveDate}
                placeholder={baseline?.effectiveDate ?? row?.first_work_date ?? ""}
                onChange={(event) => setEffectiveDate(event.target.value)} />
            </div>
            {targetStatus === "OFF" ? (
              <div className="flex flex-col gap-1">
                <label htmlFor="worker-leave-reason" className="text-sm font-medium">Lý do nghỉ</label>
                <input id="worker-leave-reason" className={inputClass} value={leaveReason}
                  onChange={(event) => setLeaveReason(event.target.value)} />
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <label htmlFor={reasonId} className="text-sm font-medium">Lý do đề xuất</label>
              <textarea id={reasonId} required aria-required="true"
                className="min-h-20 w-full rounded-md border border-input bg-background p-3 text-sm"
                value={reason} onChange={(event) => setReason(event.target.value)} />
            </div>
            {message ? <p role="alert" className="text-sm">{message}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={buttonClass} disabled={busy}
                onClick={() => onOpenChange(false)}>Huỷ</button>
              <button type="submit" className={primaryClass} disabled={busy} aria-busy={busy}>
                Gửi đề xuất
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
