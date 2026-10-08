"use client";

/**
 * P2.5-W06-R2 - Worker Operations UI.
 *
 * Bon view KHONG tron quyen. Moi tab giu page state rieng: 403 cua mot audience chi la
 * loi CUC BO trong tab do, khong thao ca trang/review queue/tab khac.
 *
 * Pagination: projectSubmissionListPage / projectWorkerDirectoryPage /
 * projectChangeRequestListPage; append dedupe theo stable id; doi tab/filter reset cursor.
 * CTA de xuat chi render khi server tra allowed_actions.propose_change === true.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Dialog } from "radix-ui";

import { DirectEntryChangeRequestList } from "@/components/direct-entry/direct-entry-change-request-list";
import { DirectEntryChangeRequestReviewer } from "@/components/direct-entry/direct-entry-change-request-reviewer";
import {
  BANK_ACCOUNT_SECTION_LABEL,
  WORKER_CONFLICT_MESSAGE,
  WORKER_OPERATIONS_TAB_HINTS,
  WORKER_OPERATIONS_TAB_LABELS,
  WORKER_PAGE_SIZE,
  WORKER_PROPOSE_TARGETS,
  WORKER_PROPOSE_TARGET_LABELS,
  WORKER_REQUEST_PAGE_SIZE,
  applyPage,
  bankAccountSummary,
  emptyTabPage,
  failLoad,
  initialWorkerTab,
  lastDecisionLabel,
  parseChangeRequestPageResponse,
  parseSubmissionPageResponse,
  parseWorkerPageResponse,
  pendingRequestLabel,
  proposeCta,
  relationDenialIsEmpty,
  requestRowKey,
  requestsQuery,
  resetTabPage,
  submissionRowKey,
  submissionsQuery,
  tabScope,
  visibleWorkerTabs,
  workerListErrorMessage,
  workerRowKey,
  workerStatusLabel,
  workersQuery,
  type PageState,
  type TabPage,
  type WorkerOperationsActor,
  type WorkerOperationsTab,
  type WorkerProposeTarget,
} from "@/lib/direct-entry/worker-operations-model";
import type {
  ChangeRequestListItem,
  SubmissionReadItem,
  WorkerDirectoryRow,
} from "@/lib/direct-entry/worker-operations-model";
import { WORKER_EMPLOYMENT_STATUSES } from "@/lib/direct-entry/worker-directory-contract.ts";
import {
  buildChangeRequestItem,
  buildPaymentProposal,
  buildWorkerDetailsProposal,
  buildWorkStatusProposal,
  allowedWorkStatusTargets,
  hcmTodayDate,
  proposalErrorMessage,
  projectWorkerDetailsForProposal,
  workerFormFromDetails,
  WORKER_FORM_FIELDS,
  type WorkerFieldForm,
  type WorkerForm,
} from "@/lib/direct-entry/change-request-proposal-builders";
import { parseDirectEntryCatalogResponse } from "@/lib/direct-entry/catalog-response";
import {
  OPTIONAL_STATE_LABELS,
  PAYMENT_STATE_LABELS,
  WORKER_FIELD_LABELS,
} from "@/lib/direct-entry/change-request-read-projection";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";
import { projectPaymentInput, type PaymentState } from "@/lib/direct-entry/payment-contract";
import type { WorkerDetails, WorkerStatus } from "@/lib/contracts/direct-entry-v1";

const API = "/api/direct-entry";

type WorkerScopeTab = "recruited" | "managed" | "all";
type Incoming<T> = { items: readonly T[]; next_cursor: string | null; has_more: boolean };
type FetchOutcome<T> = { ok: true; page: Incoming<T> } | { ok: false; state: PageState; message: string | null };
type Notice = { kind: "success" | "error"; message: string };

const tabClass =
  "inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring/40";
const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-surface " +
  "px-3 text-sm font-medium text-foreground outline-none hover:bg-muted/10 " +
  "focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-3 text-sm " +
  "font-medium text-on-primary outline-none hover:bg-primary/90 focus-visible:ring-2 " +
  "focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
const inputClass =
  "min-h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground " +
  "outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed " +
  "disabled:bg-muted/10 disabled:text-muted";
const errorClass =
  "rounded-md border border-red-500/40 bg-red-50 p-3 text-sm text-red-700 " +
  "dark:bg-red-950/40 dark:text-red-300";

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function httpFailure(status: number): FetchOutcome<never> {
  if (status === 403) return { ok: false, state: "denied", message: workerListErrorMessage(403) };
  if (status >= 500) return { ok: false, state: "unavailable", message: null };
  return { ok: false, state: "error", message: workerListErrorMessage(status) };
}

export function WorkerOperations({
  canSeeAllWorkers = false,
  canReview = false,
  actor = null,
}: {
  canSeeAllWorkers?: boolean;
  canReview?: boolean;
  actor?: WorkerOperationsActor | null;
}) {
  const tabs = visibleWorkerTabs(canSeeAllWorkers);
  const [tab, setTab] = useState<WorkerOperationsTab>(
    () => initialWorkerTab(actor, canSeeAllWorkers));
  const [statusFilter, setStatusFilter] = useState("");
  const [workerPages, setWorkerPages] = useState<Record<WorkerScopeTab, TabPage<WorkerDirectoryRow>>>(
    () => ({ recruited: emptyTabPage(), managed: emptyTabPage(), all: emptyTabPage() }));
  const [submissionPage, setSubmissionPage] =
    useState<TabPage<SubmissionReadItem>>(emptyTabPage);
  const [requestPage, setRequestPage] =
    useState<TabPage<ChangeRequestListItem>>(emptyTabPage);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [drawerRow, setDrawerRow] = useState<WorkerDirectoryRow | null>(null);
  const [reviewRequest, setReviewRequest] = useState<ChangeRequestListItem | null>(null);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, DraftCatalog>>({});
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const filterId = useId();

  const catalogFor = useCallback((date: string) => catalogs[date], [catalogs]);
  const ensureCatalog = useCallback((date: string): Promise<DraftCatalog> => {
    const cached = catalogs[date];
    if (cached) return Promise.resolve(cached);
    return fetch(API + "/catalog?effective_date=" + encodeURIComponent(date), {
      headers: { accept: "application/json" },
    })
      .then((response) => readJson(response))
      .then((body) => {
        const parsed = parseDirectEntryCatalogResponse(body, date);
        if (parsed === null) throw new Error("CATALOG_UNAVAILABLE");
        setCatalogs((current) => ({ ...current, [date]: parsed }));
        return parsed;
      });
  }, [catalogs]);

  /* ---------- fetchers (khong setState) ---------- */

  const fetchWorkers = useCallback(async (
    scope: WorkerScopeTab, status: string, cursor: string | null,
  ): Promise<FetchOutcome<WorkerDirectoryRow>> => {
    const response = await fetch(API + "/workers" + workersQuery({ scope, status, cursor }),
      { headers: { accept: "application/json" } });
    const payload = await readJson(response);
    if (response.status !== 200) {
      if (relationDenialIsEmpty(scope, response.status)) {
        return { ok: true, page: { items: [], next_cursor: null, has_more: false } };
      }
      return httpFailure(response.status);
    }
    const parsed = parseWorkerPageResponse(payload, { scope, page_size: WORKER_PAGE_SIZE });
    if (parsed === null) return { ok: false, state: "error", message: workerListErrorMessage(200) };
    return { ok: true, page: { items: parsed.items, next_cursor: parsed.next_cursor,
      has_more: parsed.has_more } };
  }, []);

  const fetchSubmissions = useCallback(async (
    cursor: string | null,
  ): Promise<FetchOutcome<SubmissionReadItem>> => {
    const response = await fetch(API + "/submissions" + submissionsQuery(cursor),
      { headers: { accept: "application/json" } });
    const payload = await readJson(response);
    if (response.status !== 200) return httpFailure(response.status);
    const parsed = parseSubmissionPageResponse(payload, { page_size: WORKER_PAGE_SIZE });
    if (parsed === null) return { ok: false, state: "error", message: workerListErrorMessage(200) };
    return { ok: true, page: { items: parsed.items, next_cursor: parsed.next_cursor,
      has_more: parsed.has_more } };
  }, []);

  const fetchRequests = useCallback(async (
    cursor: string | null,
  ): Promise<FetchOutcome<ChangeRequestListItem>> => {
    const response = await fetch(API + "/change-requests" + requestsQuery(cursor),
      { headers: { accept: "application/json" } });
    const payload = await readJson(response);
    if (response.status !== 200) return httpFailure(response.status);
    const parsed = parseChangeRequestPageResponse(payload, { page_size: WORKER_REQUEST_PAGE_SIZE });
    if (parsed === null) return { ok: false, state: "error", message: workerListErrorMessage(200) };
    return { ok: true, page: { items: parsed.requests, next_cursor: parsed.next_cursor,
      has_more: parsed.has_more } };
  }, []);

  /* ---------- appliers ---------- */

  const applyWorkerPage = useCallback((
    scope: WorkerScopeTab, outcome: FetchOutcome<WorkerDirectoryRow>, append: boolean,
  ) => {
    setWorkerPages((pages) => ({
      ...pages,
      [scope]: outcome.ok
        ? applyPage(pages[scope], outcome.page, workerRowKey, append)
        : failLoad(pages[scope], outcome.state, outcome.message),
    }));
  }, []);

  const applySubmissionPage = useCallback((
    outcome: FetchOutcome<SubmissionReadItem>, append: boolean,
  ) => {
    setSubmissionPage((page) => outcome.ok
      ? applyPage(page, outcome.page, submissionRowKey, append)
      : failLoad(page, outcome.state, outcome.message));
  }, []);

  const applyRequestPage = useCallback((
    outcome: FetchOutcome<ChangeRequestListItem>, append: boolean,
  ) => {
    setRequestPage((page) => outcome.ok
      ? applyPage(page, outcome.page, requestRowKey, append)
      : failLoad(page, outcome.state, outcome.message));
  }, []);

  const reloadRequestPage = useCallback(async (): Promise<void> => {
    setRequestPage(resetTabPage());
    const outcome = await fetchRequests(null).catch(
      () => ({ ok: false as const, state: "unavailable" as PageState, message: null }));
    applyRequestPage(outcome, false);
  }, [fetchRequests, applyRequestPage]);

  /* ---------- effect: page 1 cho tab hien tai (moi tab doc lap) ---------- */

  useEffect(() => {
    let active = true;
    if (tab === "uploader") {
      fetchSubmissions(null).then(
        (outcome) => { if (active) applySubmissionPage(outcome, false); },
        () => { if (active) setSubmissionPage((page) => failLoad(page, "unavailable", null)); },
      );
    } else {
      const scope = tab as WorkerScopeTab;
      fetchWorkers(scope, statusFilter, null).then(
        (outcome) => { if (active) applyWorkerPage(scope, outcome, false); },
        () => { if (active) applyWorkerPage(scope, { ok: false, state: "unavailable", message: null }, false); },
      );
    }
    return () => { active = false; };
  }, [tab, statusFilter, fetchSubmissions, fetchWorkers, applySubmissionPage, applyWorkerPage]);

  useEffect(() => {
    if (!canReview) return;
    let active = true;
    fetchRequests(null).then(
      (outcome) => { if (active) applyRequestPage(outcome, false); },
      () => { if (active) setRequestPage((page) => failLoad(page, "unavailable", null)); },
    );
    return () => { active = false; };
  }, [canReview, fetchRequests, applyRequestPage]);

  /* ---------- load more ---------- */

  async function loadMore<T>(
    page: TabPage<T>, fetcher: (cursor: string | null) => Promise<FetchOutcome<T>>,
    apply: (outcome: FetchOutcome<T>, append: boolean) => void,
  ): Promise<void> {
    if (page.cursor === null || !page.hasMore) return;
    setBusyRequestId("more");
    const outcome = await fetcher(page.cursor).catch(
      () => ({ ok: false as const, state: "unavailable" as PageState, message: null }));
    setBusyRequestId(null);
    apply(outcome, true);
  }

  function selectTab(next: WorkerOperationsTab, focus = true) {
    if (next === tab) {
      if (focus) tabRefs.current[tabs.indexOf(next)]?.focus();
      return;
    }
    setStatusFilter("");
    if (next === "uploader") setSubmissionPage(resetTabPage());
    else setWorkerPages((pages) => ({ ...pages, [next as WorkerScopeTab]: resetTabPage() }));
    setTab(next);
    if (focus) tabRefs.current[tabs.indexOf(next)]?.focus();
  }

  function changeFilter(value: string) {
    setStatusFilter(value);
    const scope = tabScope(tab);
    if (scope !== null && scope !== undefined && scope !== "recruited" && scope !== "managed" && scope !== "all") return;
    if (scope !== null && scope !== undefined) {
      setWorkerPages((pages) => ({ ...pages, [scope as WorkerScopeTab]: resetTabPage() }));
    }
  }

  function onTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = tabs.length - 1;
    let next = -1;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next < 0) return;
    event.preventDefault();
    selectTab(tabs[next]);
  }

  async function reload(): Promise<void> {
    setConflict(null);
    if (tab === "uploader") {
      setSubmissionPage(resetTabPage());
      applySubmissionPage(await fetchSubmissions(null).catch(
        () => ({ ok: false as const, state: "unavailable" as PageState, message: null })), false);
    } else {
      const scope = tab as WorkerScopeTab;
      setWorkerPages((pages) => ({ ...pages, [scope]: resetTabPage() }));
      applyWorkerPage(scope, await fetchWorkers(scope, statusFilter, null).catch(
        () => ({ ok: false as const, state: "unavailable" as PageState, message: null })), false);
    }
    if (canReview) {
      await reloadRequestPage();
    }
  }

  async function withdrawRequest(request: ChangeRequestListItem): Promise<void> {
    setBusyRequestId(request.request_id);
    try {
      const response = await fetch(
        API + "/change-requests/" + encodeURIComponent(request.request_id) + "/withdraw",
        { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ expected_version: request.version,
            idempotency_key: crypto.randomUUID() }) });
      setBusyRequestId(null);
      if (response.status === 409) { setConflict(WORKER_CONFLICT_MESSAGE); return; }
      if (response.status !== 200 && response.status !== 201) {
        setNotice({ kind: "error", message: "Không rút được yêu cầu thay đổi." });
        return;
      }
      setNotice({ kind: "success", message: "Đã rút yêu cầu thay đổi." });
      await reloadRequestPage();
    } catch {
      setBusyRequestId(null);
      setNotice({ kind: "error", message: "Không rút được yêu cầu thay đổi." });
    }
  }

  const scope = tabScope(tab);
  const workerPage = scope === null ? null : workerPages[scope as WorkerScopeTab];
  const activePage: { state: PageState; message: string | null } =
    workerPage ?? submissionPage;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Người lao động</h1>
        <p className="text-sm text-muted">
          Tra cứu theo đúng quan hệ của bạn. Quyền đề xuất thay đổi do hệ thống quyết định.
        </p>
      </header>

      <div role="tablist" aria-label="Quan hệ người lao động" className="flex flex-wrap gap-1 border-b">
        {tabs.map((value, index) => (
          <button
            key={value}
            ref={(element) => { tabRefs.current[index] = element; }}
            type="button"
            role="tab"
            id={"workers-tab-" + value}
            aria-selected={tab === value}
            aria-controls={"workers-panel-" + value}
            tabIndex={tab === value ? 0 : -1}
            className={tabClass + (tab === value
              ? " border-b-2 border-primary text-foreground" : " text-muted")}
            onClick={() => selectTab(value, false)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {WORKER_OPERATIONS_TAB_LABELS[value]}
          </button>
        ))}
      </div>

      {conflict ? (
        <div role="alert"
          className={"flex flex-col gap-2 " + errorClass}>
          <span>{conflict}</span>
          <button type="button" className={buttonClass} onClick={() => void reload()}>
            Tải lại dữ liệu
          </button>
        </div>
      ) : null}

      {notice ? (
        <p role={notice.kind === "error" ? "alert" : "status"}
          className={notice.kind === "error"
            ? errorClass
            : "rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300"}>
          {notice.message}
        </p>
      ) : null}

      <section
        role="tabpanel"
        id={"workers-panel-" + tab}
        aria-labelledby={"workers-tab-" + tab}
        className="flex flex-col gap-3"
        aria-busy={activePage.state === "loading"}
      >
        <p className="text-sm text-muted">{WORKER_OPERATIONS_TAB_HINTS[tab]}</p>

        {tab === "uploader" ? null : (
          <div className="flex flex-col gap-1 sm:max-w-xs">
            <label htmlFor={filterId} className="text-sm font-medium">Trạng thái làm việc</label>
            <select id={filterId} className={inputClass} value={statusFilter}
              onChange={(event) => changeFilter(event.target.value)}>
              <option value="">Tất cả</option>
              {WORKER_EMPLOYMENT_STATUSES.map((status) => (
                <option key={status} value={status}>{workerStatusLabel(status)}</option>
              ))}
            </select>
          </div>
        )}

        {activePage.state === "loading" || activePage.state === "idle" ? (
          <p role="status" className="text-sm text-blue-700 dark:text-blue-300">Đang tải dữ liệu…</p>
        ) : null}
        {activePage.state === "empty" ? (
          <p role="status"
            className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
            0 người lao động trong quan hệ này.
          </p>
        ) : null}
        {activePage.state === "error" || activePage.state === "denied" ||
         activePage.state === "unavailable" ? (
          <div role="alert"
            className={"flex flex-col gap-2 " + errorClass}>
            <span>{activePage.message ?? "Không tải được danh sách trong quan hệ này."}</span>
            <button type="button" className={buttonClass} onClick={() => void reload()}>
              Thử lại
            </button>
          </div>
        ) : null}

        {tab === "uploader" && submissionPage.state === "ready" ? (
          <>
            <SubmissionTable submissions={submissionPage.items} />
            <LoadMore state={submissionPage.state} hasMore={submissionPage.hasMore}
              busy={busyRequestId === "more"}
              onLoadMore={() => void loadMore(submissionPage, fetchSubmissions, applySubmissionPage)} />
          </>
        ) : null}
        {workerPage !== null && workerPage.state === "ready" ? (
          <>
            <WorkerTable rows={workerPage.items} onPropose={(row) => setDrawerRow(row)} />
            <LoadMore state={workerPage.state} hasMore={workerPage.hasMore}
              busy={busyRequestId === "more"}
              onLoadMore={() => void loadMore(workerPage, (cursor) =>
                fetchWorkers(tab as WorkerScopeTab, statusFilter, cursor), (outcome, append) =>
                applyWorkerPage(tab as WorkerScopeTab, outcome, append))} />
          </>
        ) : null}
      </section>

      {canReview ? (
        <DirectEntryChangeRequestList
          state={requestPage.state === "ready" || requestPage.state === "empty"
            ? "ready" : requestPage.state === "loading" || requestPage.state === "idle"
              ? "loading" : "error"}
          message={requestPage.message ?? ""}
          requests={requestPage.items}
          hasMore={requestPage.hasMore}
          busyRequestId={busyRequestId}
          onLoadMore={() => void loadMore(requestPage, fetchRequests, applyRequestPage)}
          onWithdraw={(request) => { void withdrawRequest(request); }}
          onReview={(request) => setReviewRequest(request)}
        />
      ) : null}

      <ProposeDrawer
        key={drawerRow === null ? "none" : drawerRow.entry_id}
        row={drawerRow}
        catalogFor={catalogFor}
        ensureCatalog={ensureCatalog}
        onOpenChange={(open) => { if (!open) setDrawerRow(null); }}
        onDone={(message) => {
          setNotice({ kind: "success", message }); setDrawerRow(null); void reload();
        }}
        onConflict={() => { setDrawerRow(null); setConflict(WORKER_CONFLICT_MESSAGE); }}
      />

      {canReview ? (
        <DirectEntryChangeRequestReviewer
          request={reviewRequest}
          onOpenChange={(open) => { if (!open) setReviewRequest(null); }}
          catalogFor={catalogFor}
          ensureCatalog={ensureCatalog}
          onDecided={(message) => {
            setNotice({ kind: "success", message });
            setReviewRequest(null);
            void reloadRequestPage();
          }}
          onConflict={(message) => { setConflict(message); setReviewRequest(null); }}
        />
      ) : null}
    </main>
  );
}

function LoadMore({
  state, hasMore, busy, onLoadMore,
}: { state: PageState; hasMore: boolean; busy: boolean; onLoadMore: () => void }) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center">
      <button type="button" className={buttonClass} disabled={busy || state === "loading"}
        onClick={onLoadMore}>
        Tải thêm
      </button>
    </div>
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
  rows, onPropose,
}: {
  rows: readonly WorkerDirectoryRow[];
  onPropose: (row: WorkerDirectoryRow) => void;
}) {
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
                    <div className="mt-1 text-xs text-muted">
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
                    <div className="mt-1 text-muted">{lastDecisionLabel(row)}</div>
                  ) : null}
                </td>
                <td className="p-3">
                  {cta.show ? (
                    <button type="button" className={primaryClass} onClick={() => onPropose(row)}>
                      Đề xuất thay đổi
                    </button>
                  ) : (
                    <span className="text-xs text-muted">{cta.message}</span>
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
  workerDetails: WorkerDetails | null;
  status: WorkerStatus | null;
  effectiveDate: string | null;
  payment: { state: PaymentState; account_number: string | null; bank_id: string | null;
    account_holder_name: string | null } | null;
};

async function fetchBaseline(entryId: string): Promise<EntryBaseline | null> {
  try {
    const response = await fetch(API + "/entries/" + encodeURIComponent(entryId), {
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status !== 200) return null;
    const body = await readJson(response);
    if (typeof body !== "object" || body === null) return null;
    const entry = (body as Record<string, unknown>).entry;
    if (typeof entry !== "object" || entry === null) return null;
    const row = entry as Record<string, unknown>;
    if (typeof row.version !== "number") return null;
    const details = projectWorkerDetailsForProposal(row.worker_details);
    const status = typeof row.employment_status === "object" && row.employment_status !== null
      ? row.employment_status as Record<string, unknown> : null;
    const payment = typeof row.payment === "object" && row.payment !== null
      ? row.payment as Record<string, unknown> : null;
    return {
      version: row.version,
      workerDetails: details,
      status: status && typeof status.status === "string" ? status.status as WorkerStatus : null,
      effectiveDate: status && typeof status.effective_date === "string"
        ? status.effective_date : null,
      payment: payment === null ? null : {
        state: payment.state as PaymentState,
        account_number: typeof payment.account_number === "string" ? payment.account_number : null,
        bank_id: typeof payment.bank_id === "string" ? payment.bank_id : null,
        account_holder_name: typeof payment.account_holder_name === "string"
          ? payment.account_holder_name : null,
      },
    };
  } catch {
    return null;
  }
}

function ProposeDrawer({
  row, catalogFor, ensureCatalog, onOpenChange, onDone, onConflict,
}: {
  row: WorkerDirectoryRow | null;
  catalogFor: (date: string) => DraftCatalog | undefined;
  ensureCatalog: (date: string) => Promise<DraftCatalog>;
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
  const [target, setTarget] = useState<WorkerProposeTarget>("WORK_STATUS");
  const [workerForm, setWorkerForm] = useState<WorkerForm | null>(null);
  const [paymentState, setPaymentState] = useState<PaymentState>("omitted");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankId, setBankId] = useState("");
  const [accountHolder, setAccountHolder] = useState("");
  const [targetStatus, setTargetStatus] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [leaveReason, setLeaveReason] = useState("");

  useEffect(() => {
    if (row === null) return;
    let active = true;
    fetchBaseline(row.entry_id).then(
      (value) => {
        if (!active) return;
        setBaseline(value);
        setLoading(false);
        setEffectiveDate(hcmTodayDate());
        if (value?.workerDetails) setWorkerForm(workerFormFromDetails(value.workerDetails));
        if (value?.payment) {
          setPaymentState(value.payment.state);
          setAccountNumber(value.payment.account_number ?? "");
          setBankId(value.payment.bank_id ?? "");
          setAccountHolder(value.payment.account_holder_name ?? "");
        }
      },
      () => { if (active) { setBaseline(null); setLoading(false); } },
    );
    void ensureCatalog(hcmTodayDate()).catch(() => undefined);
    return () => { active = false; };
  }, [row, ensureCatalog]);

  async function submit(): Promise<void> {
    if (row === null || baseline === null) return;
    const trimmed = reason.trim();
    if (trimmed === "") { setMessage("Lý do là bắt buộc."); return; }
    let proposal: Record<string, unknown> | null = null;
    let targetKind: "ENTRY_FIELD" | "PAYMENT" | "WORK_STATUS" = "ENTRY_FIELD";
    if (target === "WORKER") {
      if (workerForm === null || baseline.workerDetails === null) {
        setMessage("Chưa đọc được thông tin người lao động.");
        return;
      }
      const built = buildWorkerDetailsProposal(baseline.workerDetails, workerForm);
      if (!built.ok) { setMessage(proposalErrorMessage(built.code)); return; }
      proposal = built.proposal;
      targetKind = "ENTRY_FIELD";
    } else if (target === "PAYMENT") {
      const catalog = catalogFor(hcmTodayDate());
      const activeBankIds = new Set((catalog?.banks ?? []).map((bank) => bank.bank_id));
      const built = buildPaymentProposal({
        baseline: baseline.payment === null ? null : projectPaymentInput(baseline.payment, activeBankIds),
        draft: { state: paymentState, account_number: accountNumber === "" ? null : accountNumber,
          bank_id: bankId === "" ? null : bankId,
          account_holder_name: accountHolder === "" ? null : accountHolder },
        activeBankIds,
      });
      if (!built.ok) { setMessage(proposalErrorMessage(built.code)); return; }
      proposal = built.proposal;
      targetKind = "PAYMENT";
    } else {
      if (targetStatus === "") { setMessage("Chọn trạng thái làm việc mới."); return; }
      const built = buildWorkStatusProposal({
        baseline: baseline.status === null ? null : {
          status: baseline.status, effective_date: baseline.effectiveDate ?? row.first_work_date },
        status: targetStatus as WorkerStatus,
        effectiveDate: effectiveDate === "" ? (baseline.effectiveDate ?? row.first_work_date) : effectiveDate,
        leaveReason,
        today: hcmTodayDate(),
      });
      if (!built.ok) { setMessage(proposalErrorMessage(built.code)); return; }
      proposal = built.proposal;
      targetKind = "WORK_STATUS";
    }
    const item = buildChangeRequestItem({
      entryId: row.entry_id, expectedVersion: baseline.version,
      targetKind, proposal: proposal as Record<string, unknown>,
    });
    if (item === null) { setMessage("Đề xuất không hợp lệ."); return; }
    setBusy(true);
    try {
      const response = await fetch(API + "/change-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [item], reason: trimmed, idempotency_key: crypto.randomUUID() }),
      });
      setBusy(false);
      if (response.status === 409) { onConflict(); return; }
      if (response.status === 403) { setMessage("Bạn không còn quyền đề xuất thay đổi."); return; }
      if (response.status !== 200 && response.status !== 201) {
        setMessage("Không gửi được yêu cầu thay đổi. Vui lòng thử lại.");
        return;
      }
      onDone("Đã gửi yêu cầu thay đổi.");
    } catch {
      setBusy(false);
      setMessage("Không gửi được yêu cầu thay đổi. Vui lòng thử lại.");
    }
  }

  return (
    <Dialog.Root open={row !== null} onOpenChange={(open) => { if (!open && !busy) onOpenChange(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)]
            w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2
            overflow-hidden rounded-2xl border border-border bg-surface text-foreground shadow-2xl
            outline-none"
        >
          <form className="flex min-h-0 w-full flex-col"
            onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <header className="shrink-0 border-b border-border px-4 py-4 sm:px-5">
              <Dialog.Title className="text-lg font-semibold">Đề xuất thay đổi</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted">
                {row === null ? "" : row.display_name + " · " + row.employee_code}
              </Dialog.Description>
            </header>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
              <p className="rounded-md border border-border bg-muted/10 p-3 text-xs text-muted">
                Mã người lao động, dự án, ngày đầu tiên, người tuyển và loại hình lao động là
                trường được bảo vệ: chỉ xem, không đề xuất thay đổi. Tên người lao động giữ nguyên.
              </p>
              {loading ? (
                <p role="status" className="rounded-md border border-blue-500/30 bg-blue-50 p-3 text-sm
                  text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                  Đang tải dữ liệu…
                </p>
              ) : null}
              {!loading && baseline === null ? (
                <p role="alert" className={errorClass}>
                  Không đọc được dữ liệu hiện tại của dòng này. Vui lòng đóng và thử lại.
                </p>
              ) : null}

              <div className="flex flex-col gap-1.5">
                <label htmlFor="propose-target" className="text-sm font-medium">Nội dung đề xuất</label>
                <select id="propose-target" className={inputClass} value={target}
                  disabled={loading || baseline === null}
                  onChange={(event) => { setTarget(event.target.value as WorkerProposeTarget); setMessage(null); }}>
                  {WORKER_PROPOSE_TARGETS.map((value) => (
                    <option key={value} value={value}>{WORKER_PROPOSE_TARGET_LABELS[value]}</option>
                  ))}
                </select>
              </div>

              {target === "WORKER" && workerForm !== null ? (
                <>
                  {WORKER_FORM_FIELDS.map((field) => (
                    <div key={field} className="flex flex-col gap-1.5">
                      <label htmlFor={"worker-" + field} className="text-sm font-medium">
                        {WORKER_FIELD_LABELS[field]}
                      </label>
                      <div className="grid gap-2 sm:grid-cols-[11rem_1fr]">
                        <select id={"worker-" + field + "-state"} className={inputClass}
                          aria-label={"Trạng thái " + WORKER_FIELD_LABELS[field]}
                          value={workerForm[field].state}
                          onChange={(event) => {
                            const state = event.target.value as WorkerFieldForm["state"];
                            setWorkerForm({
                              ...workerForm,
                              [field]: { state, text: state === "provided" ? workerForm[field].text : "" },
                            });
                          }}>
                          <option value="provided">Có giá trị</option>
                          <option value="omitted">{OPTIONAL_STATE_LABELS.omitted}</option>
                          <option value="unknown">{OPTIONAL_STATE_LABELS.unknown}</option>
                          <option value="intentionally_blank">{OPTIONAL_STATE_LABELS.intentionally_blank}</option>
                        </select>
                        <input id={"worker-" + field} className={inputClass}
                          aria-label={WORKER_FIELD_LABELS[field] + " người lao động"}
                          disabled={workerForm[field].state !== "provided"}
                          value={workerForm[field].text}
                          onChange={(event) => setWorkerForm({
                            ...workerForm,
                            [field]: { state: "provided", text: event.target.value },
                          })} />
                      </div>
                    </div>
                  ))}
                  <p className="text-xs text-muted">
                    Tên người lao động: {workerForm.display_name} (giữ nguyên)
                  </p>
                </>
              ) : null}

              {target === "PAYMENT" ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="bank-state" className="text-sm font-medium">
                      Trạng thái thông tin tài khoản ngân hàng
                    </label>
                    <select id="bank-state" className={inputClass} value={paymentState}
                      onChange={(event) => setPaymentState(event.target.value as PaymentState)}>
                      <option value="omitted">{PAYMENT_STATE_LABELS.omitted}</option>
                      <option value="unknown">{PAYMENT_STATE_LABELS.unknown}</option>
                      <option value="intentionally_blank">{PAYMENT_STATE_LABELS.intentionally_blank}</option>
                      <option value="provided">{PAYMENT_STATE_LABELS.provided}</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="bank-account" className="text-sm font-medium">Số tài khoản</label>
                    <input id="bank-account" className={inputClass} value={accountNumber}
                      disabled={paymentState !== "provided"}
                      onChange={(event) => setAccountNumber(event.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="bank-id" className="text-sm font-medium">Ngân hàng</label>
                    <input id="bank-id" className={inputClass} value={bankId}
                      disabled={paymentState !== "provided"}
                      onChange={(event) => setBankId(event.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="bank-holder" className="text-sm font-medium">Tên chủ tài khoản</label>
                    <input id="bank-holder" className={inputClass} value={accountHolder}
                      disabled={paymentState !== "provided"}
                      onChange={(event) => setAccountHolder(event.target.value)} />
                  </div>
                </>
              ) : null}

              {target === "WORK_STATUS" ? (
                <>
                  <p className="text-sm text-muted">
                    Trạng thái hiện tại: <strong className="text-foreground">
                      {workerStatusLabel(baseline?.status ?? row?.employment_status ?? null)}
                    </strong>
                  </p>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-target-status" className="text-sm font-medium">
                      Trạng thái làm việc mới
                    </label>
                    <select id="worker-target-status" className={inputClass} value={targetStatus}
                      disabled={loading || baseline?.status == null}
                      onChange={(event) => { setTargetStatus(event.target.value); setMessage(null); }}>
                      <option value="">Chọn trạng thái</option>
                      {allowedWorkStatusTargets(baseline?.status ?? null).map((status) => (
                        <option key={status} value={status}>{workerStatusLabel(status)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-effective-date" className="text-sm font-medium">Ngày hiệu lực</label>
                    <input id="worker-effective-date" type="date" className={inputClass}
                      min={baseline?.effectiveDate ?? row?.first_work_date ?? undefined}
                      max={hcmTodayDate()} value={effectiveDate}
                      disabled={loading || baseline === null}
                      onChange={(event) => setEffectiveDate(event.target.value)} />
                  </div>
                  {targetStatus === "OFF" ? (
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="worker-leave-reason" className="text-sm font-medium">Lý do nghỉ</label>
                      <input id="worker-leave-reason" className={inputClass} value={leaveReason}
                        required aria-required="true"
                        onChange={(event) => setLeaveReason(event.target.value)} />
                    </div>
                  ) : null}
                </>
              ) : null}

              <div className="flex flex-col gap-1.5">
                <label htmlFor={reasonId} className="text-sm font-medium">Lý do đề xuất</label>
                <textarea id={reasonId} required aria-required="true"
                  className="min-h-24 w-full rounded-md border border-border bg-surface p-3 text-sm
                    text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  value={reason} onChange={(event) => setReason(event.target.value)} />
              </div>
              {message ? <p role="alert" className={errorClass}>{message}</p> : null}
            </div>

            <footer className="flex shrink-0 justify-end gap-2 border-t border-border bg-surface px-4 py-3 sm:px-5">
              <button type="button" className={buttonClass} disabled={busy}
                onClick={() => onOpenChange(false)}>Huỷ</button>
              <button type="submit" className={primaryClass}
                disabled={busy || loading || baseline === null} aria-busy={busy}>
                Gửi đề xuất
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
