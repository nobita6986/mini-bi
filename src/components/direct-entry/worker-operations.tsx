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
  updateWorkerDirectoryFilter,
  visibleWorkerTabs,
  workerListErrorMessage,
  WORKER_LOAD_FAILED_MESSAGE,
  workerRowKey,
  workerStatusLabel,
  workersQuery,
  type PageState,
  type TabPage,
  type WorkerOperationsActor,
  type WorkerOperationsTab,
  type WorkerDirectoryFilters,
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
  buildEntryFieldProposal,
  buildPaymentProposal,
  buildWorkStatusProposal,
  allowedWorkStatusTargets,
  hcmTodayDate,
  proposalErrorMessage,
  projectWorkerDetailsForProposal,
  workerEntryFormFromBaseline,
  WORKER_FORM_FIELDS,
  type WorkerFieldForm,
  type WorkerEntryFieldBaseline,
  type WorkerEntryFieldForm,
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
/** Thong tin/huong dan: mau khac han voi loi (do) va voi thanh cong (xanh la). */
const infoClass =
  "rounded-md border border-sky-500/40 bg-sky-50 p-3 text-sm text-sky-800 " +
  "dark:bg-sky-950/40 dark:text-sky-200";
/** P2.5-HF-R5A: 403 (khong co quyen doc danh muc) KHAC 5xx/network (loi that). */
const CATALOG_DENIED = "CATALOG_DENIED";
const CATALOG_UNAVAILABLE = "CATALOG_UNAVAILABLE";

const successClass =
  "rounded-md border border-emerald-500/40 bg-emerald-50 p-3 text-sm text-emerald-800 " +
  "dark:bg-emerald-950/40 dark:text-emerald-300";

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function httpFailure(status: number): FetchOutcome<never> {
  if (status === 403) return { ok: false, state: "denied", message: workerListErrorMessage(403) };
  if (status >= 500) return { ok: false, state: "unavailable", message: workerListErrorMessage(500) };
  return { ok: false, state: "error", message: workerListErrorMessage(status) };
}

export function WorkerOperations({
  canSeeAllWorkers = false,
  canReview = false,
  canPrivilegedEditWorkers = false,
  actor = null,
}: {
  canSeeAllWorkers?: boolean;
  canReview?: boolean;
  canPrivilegedEditWorkers?: boolean;
  actor?: WorkerOperationsActor | null;
}) {
  const tabs = visibleWorkerTabs(canSeeAllWorkers);
  const [tab, setTab] = useState<WorkerOperationsTab>(
    () => initialWorkerTab(actor, canSeeAllWorkers));
  const [filters, setFilters] = useState<WorkerDirectoryFilters>(
    { status: "", projectId: "", recruiterId: "" });
  const [filterCatalogState, setFilterCatalogState] =
    useState<"loading" | "ready" | "denied" | "unavailable">("loading");
  const [workerPages, setWorkerPages] = useState<Record<WorkerScopeTab, TabPage<WorkerDirectoryRow>>>(
    () => ({ recruited: emptyTabPage(), managed: emptyTabPage(), all: emptyTabPage() }));
  const [submissionPage, setSubmissionPage] =
    useState<TabPage<SubmissionReadItem>>(emptyTabPage);
  const [requestPage, setRequestPage] =
    useState<TabPage<ChangeRequestListItem>>(emptyTabPage);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [drawerRow, setDrawerRow] = useState<WorkerDirectoryRow | null>(null);
  const [drawerMode, setDrawerMode] = useState<"proposal" | "correction">("proposal");
  const [reviewRequest, setReviewRequest] = useState<ChangeRequestListItem | null>(null);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, DraftCatalog>>({});
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** Radix Dialog khong tu tra focus khi khong dung Dialog.Trigger. */
  const drawerOpenerRef = useRef<HTMLElement | null>(null);
  const filterId = useId();
  const projectFilterId = useId();
  const recruiterFilterId = useId();
  const workerQueryGeneration = useRef(0);
  const today = hcmTodayDate();
  const filterCatalog = catalogs[today];

  const catalogFor = useCallback((date: string) => catalogs[date], [catalogs]);
  const ensureCatalog = useCallback((date: string): Promise<DraftCatalog> => {
    const cached = catalogs[date];
    if (cached) return Promise.resolve(cached);
    return fetch(API + "/catalog?effective_date=" + encodeURIComponent(date), {
      headers: { accept: "application/json" },
    })
      .then(async (response) => ({ status: response.status, body: await readJson(response) }))
      .then((result) => {
        if (result.status === 403) throw new Error(CATALOG_DENIED);
        const parsed = result.status === 200
          ? parseDirectEntryCatalogResponse(result.body, date) : null;
        if (parsed === null) throw new Error(CATALOG_UNAVAILABLE);
        setCatalogs((current) => ({ ...current, [date]: parsed }));
        return parsed;
      });
  }, [catalogs]);

  useEffect(() => {
    if (tab === "uploader" || filterCatalog !== undefined) return;
    let active = true;
    ensureCatalog(today).then(
      () => { if (active) setFilterCatalogState("ready"); },
      (error: unknown) => {
        if (active) setFilterCatalogState(
          error instanceof Error && error.message === CATALOG_DENIED ? "denied" : "unavailable");
      },
    );
    return () => { active = false; };
  }, [tab, filterCatalog, ensureCatalog, today]);

  /* ---------- fetchers (khong setState) ---------- */

  const fetchWorkers = useCallback(async (
    scope: WorkerScopeTab, workerFilters: WorkerDirectoryFilters, cursor: string | null,
  ): Promise<FetchOutcome<WorkerDirectoryRow>> => {
    const response = await fetch(API + "/workers" + workersQuery({
      scope, ...workerFilters, cursor,
    }),
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
      () => ({ ok: false as const, state: "unavailable" as PageState, message: WORKER_LOAD_FAILED_MESSAGE }));
    applyRequestPage(outcome, false);
  }, [fetchRequests, applyRequestPage]);

  /* ---------- effect: page 1 cho tab hien tai (moi tab doc lap) ---------- */

  useEffect(() => {
    let active = true;
    if (tab === "uploader") {
      fetchSubmissions(null).then(
        (outcome) => { if (active) applySubmissionPage(outcome, false); },
        () => { if (active) setSubmissionPage((page) => failLoad(page, "unavailable", WORKER_LOAD_FAILED_MESSAGE)); },
      );
    } else {
      const scope = tab as WorkerScopeTab;
      fetchWorkers(scope, filters, null).then(
        (outcome) => { if (active) applyWorkerPage(scope, outcome, false); },
        () => { if (active) applyWorkerPage(scope, { ok: false, state: "unavailable", message: WORKER_LOAD_FAILED_MESSAGE }, false); },
      );
    }
    return () => { active = false; };
  }, [tab, filters, fetchSubmissions, fetchWorkers, applySubmissionPage, applyWorkerPage]);

  useEffect(() => {
    if (!canReview) return;
    let active = true;
    fetchRequests(null).then(
      (outcome) => { if (active) applyRequestPage(outcome, false); },
      () => { if (active) setRequestPage((page) => failLoad(page, "unavailable", WORKER_LOAD_FAILED_MESSAGE)); },
    );
    return () => { active = false; };
  }, [canReview, fetchRequests, applyRequestPage]);

  /* ---------- load more ---------- */

  async function loadMore<T>(
    page: TabPage<T>, fetcher: (cursor: string | null) => Promise<FetchOutcome<T>>,
    apply: (outcome: FetchOutcome<T>, append: boolean) => void,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    if (page.cursor === null || !page.hasMore) return;
    setBusyRequestId("more");
    const outcome = await fetcher(page.cursor).catch(
      () => ({ ok: false as const, state: "unavailable" as PageState, message: WORKER_LOAD_FAILED_MESSAGE }));
    setBusyRequestId(null);
    if (!isCurrent()) return;
    apply(outcome, true);
  }

  function selectTab(next: WorkerOperationsTab, focus = true) {
    if (next === tab) {
      if (focus) tabRefs.current[tabs.indexOf(next)]?.focus();
      return;
    }
    workerQueryGeneration.current += 1;
    setFilters({ status: "", projectId: "", recruiterId: "" });
    if (next === "uploader") setSubmissionPage(resetTabPage());
    else setWorkerPages((pages) => ({ ...pages, [next as WorkerScopeTab]: resetTabPage() }));
    setTab(next);
    if (focus) tabRefs.current[tabs.indexOf(next)]?.focus();
  }

  function changeFilter(field: keyof WorkerDirectoryFilters, value: string) {
    const scope = tabScope(tab);
    if (scope === null) return;
    workerQueryGeneration.current += 1;
    const next = updateWorkerDirectoryFilter({
      page: workerPages[scope], filters, field, value,
    });
    setFilters(next.filters);
    setWorkerPages((pages) => ({ ...pages, [scope]: next.page }));
  }

  const workerPageGeneration = workerQueryGeneration.current;

  async function reload(): Promise<void> {
    setConflict(null);
    if (tab === "uploader") {
      setSubmissionPage(resetTabPage());
      applySubmissionPage(await fetchSubmissions(null).catch(
        () => ({ ok: false as const, state: "unavailable" as PageState, message: WORKER_LOAD_FAILED_MESSAGE })), false);
    } else {
      const scope = tab as WorkerScopeTab;
      workerQueryGeneration.current += 1;
      const generation = workerQueryGeneration.current;
      setWorkerPages((pages) => ({ ...pages, [scope]: resetTabPage() }));
      const outcome = await fetchWorkers(scope, filters, null).catch(
        () => ({ ok: false as const, state: "unavailable" as PageState, message: WORKER_LOAD_FAILED_MESSAGE }));
      if (generation === workerQueryGeneration.current) applyWorkerPage(scope, outcome, false);
    }
    if (canReview) {
      await reloadRequestPage();
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
          className={notice.kind === "error" ? errorClass : successClass}>
          {notice.message}
        </p>
      ) : null}

      {/* P2.5-HF-R3: hang doi "Yeu cau thay doi" dat TRUOC danh sach NLD. */}
      {canReview && requestPage.state === "ready" && requestPage.message !== null ? (
        <div role="alert" className={"flex flex-col gap-2 " + errorClass}>
          <span>{requestPage.message}</span>
          <button type="button" className={buttonClass} onClick={() => void reloadRequestPage()}>
            Thử lại
          </button>
        </div>
      ) : null}
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

      <section
        role="tabpanel"
        id={"workers-panel-" + tab}
        aria-labelledby={"workers-tab-" + tab}
        className="flex flex-col gap-3"
        aria-busy={activePage.state === "loading"}
      >
        <p className="text-sm text-muted">{WORKER_OPERATIONS_TAB_HINTS[tab]}</p>

        {tab === "uploader" ? null : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="flex flex-col gap-1">
                <label htmlFor={filterId} className="text-sm font-medium">Trạng thái làm việc</label>
                <select id={filterId} className={inputClass} value={filters.status}
                  onChange={(event) => changeFilter("status", event.target.value)}>
                  <option value="">Tất cả</option>
                  {WORKER_EMPLOYMENT_STATUSES.map((status) => (
                    <option key={status} value={status}>{workerStatusLabel(status)}</option>
                  ))}
                </select>
              </div>
              {filterCatalog ? (
                <>
                  <div className="flex flex-col gap-1">
                    <label htmlFor={projectFilterId} className="text-sm font-medium">Dự án</label>
                    <select id={projectFilterId} className={inputClass} value={filters.projectId}
                      onChange={(event) => changeFilter("projectId", event.target.value)}>
                      <option value="">Tất cả dự án</option>
                      {filterCatalog.projects.map((project) => (
                        <option key={project.project_id} value={project.project_id}>
                          {project.display_name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor={recruiterFilterId} className="text-sm font-medium">Người tuyển</label>
                    <select id={recruiterFilterId} className={inputClass} value={filters.recruiterId}
                      onChange={(event) => changeFilter("recruiterId", event.target.value)}>
                      <option value="">Tất cả người tuyển</option>
                      {filterCatalog.recruiters.map((recruiter) => (
                        <option key={recruiter.recruiter_id} value={recruiter.recruiter_id}>
                          {recruiter.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              ) : null}
            </div>
            {filterCatalog === undefined && filterCatalogState === "loading" ? (
              <p role="status" className="text-sm text-blue-700 dark:text-blue-300">
                Đang tải bộ lọc dự án và người tuyển…
              </p>
            ) : null}
            {filterCatalogState === "denied" ? (
              <p role="status" className={infoClass}>
                Vai trò hiện tại không có quyền đọc danh mục dự án và người tuyển, nên chỉ lọc được
                theo trạng thái làm việc. Đây là giới hạn quyền, không phải lỗi hệ thống.
              </p>
            ) : null}
            {filterCatalogState === "unavailable" ? (
              <p role="alert" className={errorClass}>
                Không tải được danh mục dự án và người tuyển. Bộ lọc trạng thái vẫn hoạt động.
              </p>
            ) : null}
          </>
        )}

        {activePage.state === "loading" || activePage.state === "idle" ? (
          <p role="status" className={infoClass}>Đang tải dữ liệu…</p>
        ) : null}
        {activePage.state === "empty" ? (
          <p role="status" className={infoClass}>
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

        {/* P2.5-HF-R5A: "Tai them" loi thi GIU rows da tai va phai BAO cho nguoi dung. */}
        {activePage.state === "ready" && activePage.message !== null ? (
          <div role="alert" className={"flex flex-col gap-2 " + errorClass}>
            <span>{activePage.message}</span>
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
            <WorkerTable rows={workerPage.items}
              canPrivilegedEdit={canPrivilegedEditWorkers}
              onPropose={(row, opener) => {
                drawerOpenerRef.current = opener;
                setDrawerMode("proposal");
                setDrawerRow(row);
              }}
              onCorrect={(row, opener) => {
                drawerOpenerRef.current = opener;
                setDrawerMode("correction");
                setDrawerRow(row);
              }} />
            <LoadMore state={workerPage.state} hasMore={workerPage.hasMore}
              busy={busyRequestId === "more"}
              onLoadMore={() => void loadMore(workerPage, (cursor) =>
                fetchWorkers(tab as WorkerScopeTab, filters, cursor), (outcome, append) =>
                applyWorkerPage(tab as WorkerScopeTab, outcome, append),
              () => workerQueryGeneration.current === workerPageGeneration)} />
          </>
        ) : null}
      </section>

      <ProposeDrawer
        key={drawerRow === null ? "none" : drawerRow.entry_id + ":" + drawerMode}
        row={drawerRow}
        mode={drawerMode}
        openerRef={drawerOpenerRef}
        catalogDenied={filterCatalogState === "denied"}
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
  rows, canPrivilegedEdit, onPropose, onCorrect,
}: {
  rows: readonly WorkerDirectoryRow[];
  canPrivilegedEdit: boolean;
  /** P2.5-HF-R5A: nhan kem nut da bam de tra focus khi dong drawer. */
  onPropose: (row: WorkerDirectoryRow, opener: HTMLElement | null) => void;
  onCorrect: (row: WorkerDirectoryRow, opener: HTMLElement | null) => void;
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
                  {cta.show || canPrivilegedEdit ? (
                    <div className="flex flex-col items-start gap-2">
                      {cta.show ? (
                        <button type="button" className={primaryClass}
                          onClick={(event) => onPropose(row, event.currentTarget)}>
                          Đề xuất thay đổi
                        </button>
                      ) : null}
                      {canPrivilegedEdit ? (
                        <button type="button" className={buttonClass}
                          onClick={(event) => onCorrect(row, event.currentTarget)}>
                          Sửa trực tiếp
                        </button>
                      ) : null}
                    </div>
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
  projectId: string;
  firstWorkDate: string;
  employeeCode: string;
  recruiterId: string;
  laborType: "TEMPORARY" | "PERMANENT";
  workerDetails: WorkerDetails | null;
  providerType: "hrp" | "vendor" | null;
  status: WorkerStatus | null;
  effectiveDate: string | null;
  payment: { state: PaymentState; account_number: string | null; bank_id: string | null;
    bank_name: string | null; account_holder_name: string | null } | null;
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
    if (typeof row.version !== "number" || typeof row.project_id !== "string" ||
        typeof row.first_work_date !== "string" || typeof row.employee_code !== "string" ||
        typeof row.recruiter_id !== "string" ||
        (row.labor_type !== "TEMPORARY" && row.labor_type !== "PERMANENT")) return null;
    const details = projectWorkerDetailsForProposal(row.worker_details);
    const status = typeof row.employment_status === "object" && row.employment_status !== null
      ? row.employment_status as Record<string, unknown> : null;
    const payment = typeof row.payment === "object" && row.payment !== null
      ? row.payment as Record<string, unknown> : null;
    return {
      version: row.version,
      projectId: row.project_id,
      firstWorkDate: row.first_work_date,
      employeeCode: row.employee_code,
      recruiterId: row.recruiter_id,
      laborType: row.labor_type,
      workerDetails: details,
      providerType: row.provider_type === "hrp" || row.provider_type === "vendor"
        ? row.provider_type : null,
      status: status && typeof status.status === "string" ? status.status as WorkerStatus : null,
      effectiveDate: status && typeof status.effective_date === "string"
        ? status.effective_date : null,
      payment: payment === null ? null : {
        state: payment.state as PaymentState,
        account_number: typeof payment.account_number === "string" ? payment.account_number : null,
        bank_id: typeof payment.bank_id === "string" ? payment.bank_id : null,
        bank_name: typeof payment.bank_name === "string" ? payment.bank_name : null,
        account_holder_name: typeof payment.account_holder_name === "string"
          ? payment.account_holder_name : null,
      },
    };
  } catch {
    return null;
  }
}

function ProposeDrawer({
  row, mode, openerRef, catalogDenied, catalogFor, ensureCatalog, onOpenChange, onDone, onConflict,
}: {
  row: WorkerDirectoryRow | null;
  mode: "proposal" | "correction";
  openerRef: { current: HTMLElement | null };
  /** True khi catalog bi tu choi (403) — gap #2 da biet; copy phai la gioi han quyen, khong phai loi. */
  catalogDenied: boolean;
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
  const [target, setTarget] = useState<WorkerProposeTarget>("WORKER");
  const [entryForm, setEntryForm] = useState<WorkerEntryFieldForm | null>(null);
  const [paymentState, setPaymentState] = useState<PaymentState>("omitted");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankId, setBankId] = useState("");
  const [accountHolder, setAccountHolder] = useState("");
  const [targetStatus, setTargetStatus] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [leaveReason, setLeaveReason] = useState("");
  const today = hcmTodayDate();
  const catalog = catalogFor(today);
  const entryCatalogDate = entryForm?.first_work_date;
  const entryCatalog = catalogFor(entryCatalogDate ?? today);

  useEffect(() => {
    if (row === null) return;
    let active = true;
    fetchBaseline(row.entry_id).then(
      (value) => {
        if (!active) return;
        setBaseline(value);
        setLoading(false);
        setEffectiveDate(hcmTodayDate());
        if (value?.workerDetails) {
          const entryBaseline: WorkerEntryFieldBaseline = {
            project_id: value.projectId,
            first_work_date: value.firstWorkDate,
            employee_code: value.employeeCode,
            recruiter_id: value.recruiterId,
            labor_type: value.laborType,
            worker_details: value.workerDetails,
          };
          setEntryForm(workerEntryFormFromBaseline(entryBaseline));
        }
        if (value?.payment) {
          setPaymentState(value.payment.state);
          setAccountNumber(value.payment.account_number ?? "");
          setBankId(value.payment.bank_id ?? "");
          setAccountHolder(value.payment.account_holder_name ?? "");
        }
      },
      () => { if (active) { setBaseline(null); setLoading(false); } },
    );
    return () => { active = false; };
  }, [row]);

  useEffect(() => {
    if (row !== null) void ensureCatalog(today).catch(() => undefined);
  }, [row, ensureCatalog, today]);

  useEffect(() => {
    if (row !== null && entryCatalogDate) {
      void ensureCatalog(entryCatalogDate).catch(() => undefined);
    }
  }, [row, entryCatalogDate, ensureCatalog]);

  async function submit(): Promise<void> {
    if (row === null || baseline === null) return;
    const trimmed = reason.trim();
    if (trimmed === "") { setMessage("Lý do là bắt buộc."); return; }
    let proposal: Record<string, unknown> | null = null;
    let targetKind: "ENTRY_FIELD" | "PAYMENT" | "WORK_STATUS" = "ENTRY_FIELD";
    if (mode === "correction" || target === "WORKER") {
      if (entryForm === null || baseline.workerDetails === null) {
        setMessage("Chưa đọc được thông tin người lao động.");
        return;
      }
      const entryBaseline: WorkerEntryFieldBaseline = {
        project_id: baseline.projectId,
        first_work_date: baseline.firstWorkDate,
        employee_code: baseline.employeeCode,
        recruiter_id: baseline.recruiterId,
        labor_type: baseline.laborType,
        worker_details: baseline.workerDetails,
      };
      const built = buildEntryFieldProposal({
        entryId: row.entry_id,
        expectedVersion: baseline.version,
        baseline: entryBaseline,
        form: entryForm,
      });
      if (!built.ok) { setMessage(proposalErrorMessage(built.code)); return; }
      proposal = built.proposal;
      targetKind = "ENTRY_FIELD";
      if (mode === "correction") {
        setBusy(true);
        try {
          const response = await fetch(API + "/entries/" + encodeURIComponent(row.entry_id) +
            "/privileged-edit", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": crypto.randomUUID(),
            },
            credentials: "same-origin",
            body: JSON.stringify({
              expected_entry_version: baseline.version,
              patch: built.proposal,
              reason: trimmed,
            }),
          });
          setBusy(false);
          if (response.status === 409) { onConflict(); return; }
          if (response.status === 403) {
            setMessage("Bạn không còn quyền sửa trực tiếp hồ sơ này.");
            return;
          }
          if (response.status !== 200) {
            setMessage("Không lưu được chỉnh sửa trực tiếp. Vui lòng thử lại.");
            return;
          }
          onDone("Đã lưu chỉnh sửa trực tiếp có ghi nhận lý do.");
        } catch {
          setBusy(false);
          setMessage("Không lưu được chỉnh sửa trực tiếp. Vui lòng thử lại.");
        }
        return;
      }
    } else if (target === "PAYMENT") {
      const activeBankIds = new Set((catalog?.banks ?? []).map((bank) => bank.bank_id));
      const built = buildPaymentProposal({
        baseline: baseline.payment === null ? null : projectPaymentInput({
          state: baseline.payment.state,
          account_number: baseline.payment.account_number,
          bank_id: baseline.payment.bank_id,
          account_holder_name: baseline.payment.account_holder_name,
        }, activeBankIds),
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
        today,
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
          onCloseAutoFocus={(event) => {
            const opener = openerRef.current;
            if (opener && opener.isConnected) {
              event.preventDefault();
              opener.focus();
            }
          }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)]
            w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2
            overflow-hidden rounded-2xl border border-border bg-surface text-foreground shadow-2xl
            outline-none"
        >
          <form className="flex min-h-0 w-full flex-col"
            onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border
              bg-surface px-4 py-4 sm:px-5">
              <div>
                <Dialog.Title className="text-xl font-semibold">
                  {mode === "correction" ? "Sửa trực tiếp hồ sơ" : "Đề xuất thay đổi"}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted">
                  {mode === "correction"
                    ? "Dữ liệu hiện tại được nạp sẵn — chỉnh phần cần sửa và nhập lý do."
                    : "Dữ liệu hiện tại được nạp sẵn — chỉnh phần cần đổi rồi nhập lý do để gửi duyệt."}
                </Dialog.Description>
              </div>
              <button type="button" aria-label="Đóng đề xuất" disabled={busy}
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-full
                  border border-border bg-surface text-xl text-muted hover:bg-muted/10
                  hover:text-foreground focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-ring/40 disabled:opacity-50"
                onClick={() => onOpenChange(false)}>×</button>
            </header>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
              {row !== null ? (
                <section aria-labelledby="proposal-current-profile"
                  className="rounded-xl border border-border bg-muted/10 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 id="proposal-current-profile" className="font-semibold">Hồ sơ hiện tại</h3>
                    <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs
                      font-medium text-muted">Phiên bản {baseline?.version ?? row.entry_version}</span>
                  </div>
                  <dl className="mt-3 grid gap-x-5 gap-y-3 text-sm sm:grid-cols-2">
                    {[
                      ["Họ và tên", row.display_name],
                      ["Mã người lao động", row.employee_code],
                      ["Dự án", row.project_display],
                      ["Ngày bắt đầu làm việc", row.first_work_date],
                      ["Người tuyển / Vendor", row.recruiter_display],
                      ["HRP/Vendor", baseline?.providerType === "hrp" ? "HRP"
                        : baseline?.providerType === "vendor" ? "Vendor" : "—"],
                      ["Loại hình lao động", row.labor_type === "TEMPORARY" ? "Thời vụ" : "Chính thức"],
                      ["Trạng thái làm việc", workerStatusLabel(baseline?.status ?? row.employment_status)],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
                        <dd className="mt-0.5 break-words font-medium text-foreground">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
      ) : null}
              <p className="rounded-md border border-blue-500/30 bg-blue-50 p-3 text-sm text-blue-700
                dark:bg-blue-950/40 dark:text-blue-300">
                Các giá trị hiện tại được nạp sẵn. Chỉ nội dung đã thay đổi mới được gửi; dữ liệu khác
                giữ nguyên theo hồ sơ đang lưu.
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

              {mode === "proposal" ? (
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
              ) : null}

              {(mode === "correction" || target === "WORKER") && entryForm !== null ? (
                <section aria-labelledby="worker-profile-fields" className="space-y-4 rounded-xl
                  border border-border p-4">
                  <div>
                    <h3 id="worker-profile-fields" className="font-semibold">Thông tin người lao động</h3>
                    <p className="mt-1 text-xs text-muted">Chỉnh trên giá trị hiện tại.</p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-display-name" className="text-sm font-medium">Họ và tên</label>
                    <input id="worker-display-name" className={inputClass}
                      value={entryForm.workerDetails.display_name}
                      onChange={(event) => setEntryForm({ ...entryForm,
                        workerDetails: { ...entryForm.workerDetails, display_name: event.target.value } })} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-employee-code" className="text-sm font-medium">
                      Mã người lao động
                    </label>
                    <input id="worker-employee-code" className={inputClass}
                      value={entryForm.employee_code}
                      onChange={(event) => setEntryForm({ ...entryForm,
                        employee_code: event.target.value })} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-project" className="text-sm font-medium">Dự án</label>
                    <select id="worker-project" className={inputClass} value={entryForm.project_id}
                      disabled={loading || entryCatalog === undefined}
                      onChange={(event) => setEntryForm({ ...entryForm, project_id: event.target.value })}>
                      {entryCatalog?.projects.some((project) =>
                        project.project_id === entryForm.project_id) ? null : (
                        <option value={entryForm.project_id}>
                          {(row?.project_display ?? "Dự án hiện tại") + " (hiện tại)"}
                        </option>
                      )}
                      {(entryCatalog?.projects ?? []).map((project) => (
                        <option key={project.project_id} value={project.project_id}>
                          {project.display_name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-first-work-date" className="text-sm font-medium">
                      Ngày bắt đầu làm việc
                    </label>
                    <input id="worker-first-work-date" type="date" className={inputClass}
                      value={entryForm.first_work_date}
                      onChange={(event) => setEntryForm({ ...entryForm,
                        first_work_date: event.target.value })} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-recruiter" className="text-sm font-medium">
                      Người tuyển
                    </label>
                    <select id="worker-recruiter" className={inputClass} value={entryForm.recruiter_id}
                      disabled={loading || entryCatalog === undefined}
                      onChange={(event) => setEntryForm({ ...entryForm,
                        recruiter_id: event.target.value })}>
                      {entryCatalog?.recruiters.some((recruiter) =>
                        recruiter.recruiter_id === entryForm.recruiter_id) ? null : (
                        <option value={entryForm.recruiter_id}>
                          {(row?.recruiter_display ?? "Người tuyển hiện tại") + " (hiện tại)"}
                        </option>
                      )}
                      {(entryCatalog?.recruiters ?? []).map((recruiter) => (
                        <option key={recruiter.recruiter_id} value={recruiter.recruiter_id}>
                          {recruiter.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-labor-type" className="text-sm font-medium">
                      Loại hình lao động
                    </label>
                    <select id="worker-labor-type" className={inputClass} value={entryForm.labor_type}
                      onChange={(event) => setEntryForm({ ...entryForm,
                        labor_type: event.target.value as WorkerEntryFieldForm["labor_type"] })}>
                      <option value="PERMANENT">Chính thức</option>
                      <option value="TEMPORARY">Thời vụ</option>
                    </select>
                  </div>
                  {!loading && entryCatalog === undefined && catalogDenied ? (
                    <p role="status" className={infoClass}>
                      Vai trò hiện tại không có quyền đọc danh mục nên chỉ giữ được dự án và người
                      tuyển hiện tại; không thể chọn giá trị mới.
                    </p>
                  ) : null}
                  {!loading && entryCatalog === undefined && !catalogDenied ? (
                    <p role="alert" className={errorClass}>
                      Không tải được danh mục hiện có. Không thể chọn dự án hoặc người tuyển mới.
                    </p>
                  ) : null}
                  {WORKER_FORM_FIELDS.map((field) => (
                    <div key={field} className="flex flex-col gap-1.5">
                      <label htmlFor={"worker-" + field} className="text-sm font-medium">
                        {WORKER_FIELD_LABELS[field]}
                      </label>
                      <div className="grid gap-2 sm:grid-cols-[11rem_1fr]">
                        <select id={"worker-" + field + "-state"} className={inputClass}
                          aria-label={"Trạng thái " + WORKER_FIELD_LABELS[field]}
                          value={entryForm.workerDetails[field].state}
                          onChange={(event) => {
                            const state = event.target.value as WorkerFieldForm["state"];
                            setEntryForm({
                              ...entryForm,
                              workerDetails: {
                                ...entryForm.workerDetails,
                                [field]: { state, text: state === "provided"
                                  ? entryForm.workerDetails[field].text : "" },
                              },
                            });
                          }}>
                          <option value="provided">Có giá trị</option>
                          <option value="omitted">{OPTIONAL_STATE_LABELS.omitted}</option>
                          <option value="unknown">{OPTIONAL_STATE_LABELS.unknown}</option>
                           {field === "gender" ? null : (
                             <option value="intentionally_blank">
                               {OPTIONAL_STATE_LABELS.intentionally_blank}
                             </option>
                           )}
                        </select>
                        {field === "gender" ? (
                          <select id="worker-gender" className={inputClass}
                            aria-label="Giới tính người lao động"
                            disabled={entryForm.workerDetails.gender.state !== "provided"}
                            value={entryForm.workerDetails.gender.text}
                            onChange={(event) => setEntryForm({ ...entryForm,
                              workerDetails: { ...entryForm.workerDetails,
                                gender: { state: "provided", text: event.target.value } } })}>
                            <option value="">Chọn giới tính</option>
                            <option value="FEMALE">Nữ</option>
                            <option value="MALE">Nam</option>
                            <option value="OTHER">Khác</option>
                          </select>
                        ) : (
                          <input id={"worker-" + field} className={inputClass}
                            aria-label={WORKER_FIELD_LABELS[field] + " người lao động"}
                            inputMode={field === "national_id" || field === "phone" ? "numeric" : undefined}
                            placeholder={field === "date_of_birth" || field === "national_id_issued_at"
                              ? "DD/MM/YYYY" : undefined}
                            disabled={entryForm.workerDetails[field].state !== "provided"}
                            value={entryForm.workerDetails[field].text}
                            onChange={(event) => setEntryForm({
                              ...entryForm,
                              workerDetails: {
                                ...entryForm.workerDetails,
                                [field]: { state: "provided", text: event.target.value },
                              },
                            })} />
                        )}
                      </div>
                    </div>
                  ))}
                </section>
              ) : null}

              {mode === "proposal" && target === "PAYMENT" ? (
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
                    <select id="bank-id" className={inputClass} value={bankId}
                      disabled={paymentState !== "provided"}
                      onChange={(event) => setBankId(event.target.value)}>
                      <option value="">Chọn ngân hàng</option>
                      {bankId !== "" && !(catalog?.banks ?? []).some((bank) => bank.bank_id === bankId) ? (
                        <option value={bankId}>{baseline?.payment?.bank_name ?? "Ngân hàng hiện tại"}</option>
                      ) : null}
                      {(catalog?.banks ?? []).map((bank) => (
                        <option key={bank.bank_id} value={bank.bank_id}>{bank.display_name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="bank-holder" className="text-sm font-medium">Tên chủ tài khoản</label>
                    <input id="bank-holder" className={inputClass} value={accountHolder}
                      disabled={paymentState !== "provided"}
                      onChange={(event) => setAccountHolder(event.target.value)} />
                  </div>
                </>
              ) : null}

              {mode === "proposal" && target === "WORK_STATUS" ? (
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
                      max={today} value={effectiveDate}
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
                <label htmlFor={reasonId} className="text-sm font-medium">
                  {mode === "correction" ? "Lý do chỉnh sửa" : "Lý do đề xuất"}
                </label>
                <textarea id={reasonId} required aria-required="true"
                  maxLength={mode === "correction" ? 1000 : 4000}
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
                {mode === "correction" ? "Lưu chỉnh sửa trực tiếp" : "Gửi đề xuất"}
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
