"use client";

/**
 * P2.5-W06-R2 - Worker Operations UI.
 *
 * Cac view KHONG tron quyen. Moi tab giu page state rieng: 403 cua mot audience chi la
 * loi CUC BO trong tab do, khong thao ca trang/tab khac.
 *
 * Pagination: projectSubmissionListPage / projectWorkerDirectoryPage;
 * append dedupe theo stable id; doi tab/filter reset cursor.
 * Direct-edit and proposal CTAs use their server-projected row actions.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Dialog } from "radix-ui";

import { WorkerDetailDialog } from "@/components/direct-entry/worker-detail-dialog";
import { StatusBadge, submissionStateBadgeProps } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { CursorLoadMore } from "@/components/ui/cursor-load-more";
import {
  DATA_TABLE_CLASS,
  DATA_TABLE_HEAD_CLASS,
  DATA_TABLE_ROW_CLASS,
  DATA_TABLE_TD_CLASS,
  DATA_TABLE_TH_CLASS,
  DataTableContainer,
  RowActionCluster,
} from "@/components/ui/data-table";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { PageHeader } from "@/components/ui/page-shell";
import { useNotify } from "@/components/ui/notify-provider";
import { formatHcmDateTime, shortRef } from "@/lib/direct-entry/submission-lifecycle";
import {
  BANK_ACCOUNT_SECTION_LABEL,
  WORKER_CONFLICT_MESSAGE,
  WORKER_OPERATIONS_TAB_HINTS,
  WORKER_OPERATIONS_TAB_LABELS,
  WORKER_PAGE_SIZE,
  WORKER_PROPOSE_TARGETS,
  WORKER_PROPOSE_TARGET_LABELS,
  applyPage,
  bankAccountSummary,
  emptyTabPage,
  failLoad,
  initialWorkerTab,
  lastDecisionLabel,
  parseSubmissionPageResponse,
  parseWorkerPageResponse,
  pendingRequestLabel,
  privilegedEditErrorMessage,
  proposeCta,
  relationDenialIsEmpty,
  resetTabPage,
  submissionRowKey,
  submissionsQuery,
  tabScope,
  updateWorkerDirectoryFilter,
  visibleWorkerTabs,
  workerListErrorMessage,
  WORKER_LOAD_FAILED_MESSAGE,
  workerNameAvailability,
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
import {
  buildWorkerExportRequest,
  exportScopeForTab,
  isUsableWorkerExportBlob,
  workerExportErrorMessage,
  workerExportFilename,
  workerExportRequestMessage,
  WORKER_EXPORT_EMPTY_FILE_MESSAGE,
  WORKER_EXPORT_REASON_MAX,
  type WorkerExportScope,
} from "@/lib/direct-entry/worker-export-ui-model";
import type { SubmissionReadItem, WorkerDirectoryRow } from "@/lib/direct-entry/worker-operations-model";
import {
  WORKER_EMPLOYMENT_STATUSES,
  type WorkerDirectorySummary,
} from "@/lib/direct-entry/worker-directory-contract.ts";
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
import { isCanonicalLaborTypeKey } from "@/lib/contracts/direct-entry-v1";
import { sortedActiveLaborTypes } from "@/lib/direct-entry/labor-type-catalog-ui";

const API = "/api/direct-entry";

type WorkerScopeTab = "recruited" | "managed" | "team" | "all";
type Incoming<T> = {
  items: readonly T[];
  next_cursor: string | null;
  has_more: boolean;
  summary?: WorkerDirectorySummary;
};
type FetchOutcome<T> = { ok: true; page: Incoming<T> } | { ok: false; state: PageState; message: string | null };

const tabClass =
  "inline-flex min-h-11 items-center rounded-t-lg px-3.5 text-sm font-medium whitespace-nowrap transition-colors outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring/40";
const buttonClass = buttonClasses({ variant: "secondary", size: "md" });
const primaryClass = buttonClasses({ variant: "primary", size: "md" });
const inputClass =
  "min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-base sm:text-sm text-foreground " +
  "outline-none transition-colors focus:border-primary focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed " +
  "disabled:bg-muted/10 disabled:text-muted";
const errorClass =
  "rounded-lg border border-red-500/40 bg-red-50 p-3 text-sm text-red-700 " +
  "dark:bg-red-950/40 dark:text-red-300";
/** Thong tin/huong dan: mau khac han voi loi (do) va voi thanh cong (xanh la). */
const infoClass =
  "rounded-lg border border-sky-500/40 bg-sky-50 p-3 text-sm text-sky-800 " +
  "dark:bg-sky-950/40 dark:text-sky-200";
/** P2.5-HF-R5A: 403 (khong co quyen doc danh muc) KHAC 5xx/network (loi that). */
const CATALOG_DENIED = "CATALOG_DENIED";
const CATALOG_UNAVAILABLE = "CATALOG_UNAVAILABLE";

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
  canSeeTeamWorkers = false,
  canExport = false,
  canExportAll = false,
  actor = null,
}: {
  canSeeAllWorkers?: boolean;
  /** Server-projected team audience controls only tab visibility; the RPC rechecks access. */
  canSeeTeamWorkers?: boolean;
  /** Resolved business actor may use recruited/managed/team export; the RPC enforces row authority. */
  canExport?: boolean;
  /** Admin/BoD/Kế toán xuat toan bo (all scope): export caps + all scope + (entry_admin|change_review). */
  canExportAll?: boolean;
  actor?: WorkerOperationsActor | null;
}) {
  const tabs = visibleWorkerTabs(canSeeAllWorkers, canSeeTeamWorkers);
  /** W2S1: capability document_upload do server-resolved actor quyet dinh, khong suy tu tab/role. */
  const canUploadDocuments = actor?.capabilities.includes("document_upload") === true;
  const [tab, setTab] = useState<WorkerOperationsTab>(
    () => initialWorkerTab(actor, canSeeAllWorkers, canSeeTeamWorkers));
  const [filters, setFilters] = useState<WorkerDirectoryFilters>(
    { search: "", status: "", projectId: "", recruiterId: "" });
  const [filterCatalogState, setFilterCatalogState] =
    useState<"loading" | "ready" | "denied" | "unavailable">("loading");
  const [workerPages, setWorkerPages] = useState<Record<WorkerScopeTab, TabPage<WorkerDirectoryRow>>>(
    () => ({ recruited: emptyTabPage(), managed: emptyTabPage(), team: emptyTabPage(), all: emptyTabPage() }));
  const [workerSummary, setWorkerSummary] = useState<WorkerDirectorySummary | null>(null);
  const [submissionPage, setSubmissionPage] =
    useState<TabPage<SubmissionReadItem>>(emptyTabPage);
  const notify = useNotify();
  const [conflict, setConflict] = useState<string | null>(null);
  const [drawerRow, setDrawerRow] = useState<WorkerDirectoryRow | null>(null);
  const [drawerMode, setDrawerMode] = useState<"proposal" | "correction">("proposal");
  /** W2S1: mot dialog chi tiet NLĐ dung chung cho moi danh sach; khong route thu hai. */
  const [detailRow, setDetailRow] = useState<WorkerDirectoryRow | null>(null);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [catalogs, setCatalogs] = useState<Record<string, DraftCatalog>>({});
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** Radix Dialog khong tu tra focus khi khong dung Dialog.Trigger. */
  const drawerOpenerRef = useRef<HTMLElement | null>(null);
  const detailOpenerRef = useRef<HTMLElement | null>(null);
  const filterId = useId();
  const projectFilterId = useId();
  const recruiterFilterId = useId();
  const searchId = useId();
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
        return { ok: true, page: { items: [], next_cursor: null, has_more: false,
          summary: { total_workers: 0, project_count: 0, recruiter_count: 0 } } };
      }
      return httpFailure(response.status);
    }
    const parsed = parseWorkerPageResponse(payload, { scope, page_size: WORKER_PAGE_SIZE });
    if (parsed === null) return { ok: false, state: "error", message: workerListErrorMessage(200) };
    return { ok: true, page: { items: parsed.items, next_cursor: parsed.next_cursor,
      has_more: parsed.has_more, summary: parsed.summary } };
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

  /* ---------- appliers ---------- */

  const applyWorkerPage = useCallback((
    scope: WorkerScopeTab, outcome: FetchOutcome<WorkerDirectoryRow>, append: boolean,
  ) => {
    if (outcome.ok) setWorkerSummary(outcome.page.summary ?? null);
    else if (!append) setWorkerSummary(null);
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
    if (!outcome.ok) {
      notify.error({
        title: outcome.message ?? WORKER_LOAD_FAILED_MESSAGE,
        dedupeKey: "worker-load-more-err",
      });
    }
    apply(outcome, true);
  }

  function selectTab(next: WorkerOperationsTab, focus = true) {
    if (next === tab) {
      if (focus) tabRefs.current[tabs.indexOf(next)]?.focus();
      return;
    }
    workerQueryGeneration.current += 1;
    setWorkerSummary(null);
    setFilters({ search: "", status: "", projectId: "", recruiterId: "" });
    if (next === "uploader") setSubmissionPage(resetTabPage());
    else setWorkerPages((pages) => ({ ...pages, [next as WorkerScopeTab]: resetTabPage() }));
    setTab(next);
    if (focus) tabRefs.current[tabs.indexOf(next)]?.focus();
  }

  function changeFilter(field: keyof WorkerDirectoryFilters, value: string) {
    const scope = tabScope(tab);
    if (scope === null) return;
    workerQueryGeneration.current += 1;
    setWorkerSummary(null);
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
      setWorkerSummary(null);
      setWorkerPages((pages) => ({ ...pages, [scope]: resetTabPage() }));
      const outcome = await fetchWorkers(scope, filters, null).catch(
        () => ({ ok: false as const, state: "unavailable" as PageState, message: WORKER_LOAD_FAILED_MESSAGE }));
      if (generation === workerQueryGeneration.current) applyWorkerPage(scope, outcome, false);
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

  const scope = tabScope(tab);
  const exportScope = exportScopeForTab(tab);
  const canExportThisTab = exportScope === "all" ? canExportAll : canExport;
  const workerPage = scope === null ? null : workerPages[scope as WorkerScopeTab];
  const activePage: { state: PageState; message: string | null } =
    workerPage ?? submissionPage;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-3.5 py-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:gap-5 sm:px-6 sm:py-6 lg:px-8 overflow-x-clip">
      <PageHeader
        title="Người lao động"
        badge={
          <StatusBadge tone="primary">
            {tab === "uploader"
              ? `${submissionPage.items.length} đợt`
              : workerSummary !== null
                ? `${workerSummary.total_workers.toLocaleString("vi-VN")} hồ sơ`
                : `${workerPage?.items.length ?? 0} hồ sơ`}
          </StatusBadge>
        }
        description={
          <>
            Tra cứu theo đúng quan hệ của bạn. Quyền sửa và đề xuất thay đổi do hệ thống quyết định.{" "}
            <span className="hidden sm:inline">
              Các tab là những quan hệ có thể chồng lấp; cùng một NLĐ xuất hiện ở nhiều tab không phải hồ sơ trùng.
            </span>
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/direct-entry/change-requests"
              className={buttonClass}
              data-testid="worker-change-request-module-link"
            >
              Yêu cầu thay đổi
            </Link>
            {canExportThisTab && exportScope !== null ? (
              <div className="flex flex-col items-start gap-1 sm:items-end">
                <button type="button" className={primaryClass} onClick={() => setExportOpen(true)}>
                  Xuất Excel
                </button>
                <p className="max-w-xs text-[11px] leading-snug text-muted sm:text-right">
                  Xuất theo tab và bộ lọc trạng thái, dự án, người tuyển; không áp dụng từ khóa tìm kiếm.
                </p>
              </div>
            ) : null}
          </div>
        }
      />

      <div role="tablist" aria-label="Quan hệ người lao động" className="flex flex-wrap gap-1 border-b border-border">
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
              ? " border-b-2 border-primary bg-primary/5 text-foreground" : " text-muted hover:text-foreground")}
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

      <section
        role="tabpanel"
        id={"workers-panel-" + tab}
        aria-labelledby={"workers-tab-" + tab}
        className="flex flex-col gap-3.5"
        aria-busy={activePage.state === "loading"}
      >
        <p className="text-xs sm:text-sm text-muted">{WORKER_OPERATIONS_TAB_HINTS[tab]}</p>

        {tab === "uploader" ? null : (
          <>
            <FilterToolbar
              summary={
                <p role="status" aria-live="polite" data-testid="worker-filter-summary"
                  className="text-xs sm:text-sm text-muted">
                  {workerSummary === null ? "Đang tính tổng theo bộ lọc…" : (
                    <>
                      Tổng số NLĐ: {workerSummary.total_workers.toLocaleString("vi-VN")} — trong{" "}
                      {workerSummary.project_count.toLocaleString("vi-VN")} dự án và{" "}
                      {workerSummary.recruiter_count.toLocaleString("vi-VN")} người tuyển; trạng thái làm việc:{" "}
                      {filters.status === "" ? "Tất cả" : workerStatusLabel(filters.status)}.
                      {filters.search.trim() === "" ? null : <> Từ khóa: “{filters.search.trim()}”.</>}
                    </>
                  )}
                </p>
              }
            >
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-12 lg:items-end">
                <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-5">
                  <label htmlFor={searchId} className="text-xs font-medium text-muted">Tìm kiếm người lao động</label>
                  <div className="flex items-center gap-2">
                    <input id={searchId} type="search" className={inputClass}
                      placeholder="Tìm theo tên hoặc mã người lao động..."
                      maxLength={100} value={filters.search}
                      onChange={(event) => changeFilter("search", event.target.value)} />
                    <button type="button" className={buttonClass} disabled={filters.search === ""}
                      onClick={() => changeFilter("search", "")}>
                      Xóa tìm kiếm
                    </button>
                  </div>
                </div>
                <div className="flex flex-col gap-1 lg:col-span-2">
                  <label htmlFor={filterId} className="text-xs font-medium text-muted">Trạng thái làm việc</label>
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
                    <div className="flex flex-col gap-1 lg:col-span-3">
                      <label htmlFor={projectFilterId} className="text-xs font-medium text-muted">Dự án</label>
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
                    <div className="flex flex-col gap-1 lg:col-span-2">
                      <label htmlFor={recruiterFilterId} className="text-xs font-medium text-muted">Người tuyển</label>
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
            </FilterToolbar>
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
            {filters.search.trim() === ""
              ? "0 người lao động trong quan hệ này."
              : "Không tìm thấy người lao động phù hợp với từ khóa và bộ lọc hiện tại."}
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
              onViewDetail={(row, opener) => {
                detailOpenerRef.current = opener;
                setDetailRow(row);
              }}
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

      <WorkerExportDialog
        key={exportOpen ? "export-open" : "export-closed"}
        open={exportOpen}
        scope={exportScope}
        filters={filters}
        onOpenChange={(open) => { if (!open) setExportOpen(false); }}
        onDone={(message) => {
          setExportOpen(false);
          notify.success({ title: message, dedupeKey: "worker-export-done" });
        }}
      />

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
          setDrawerRow(null);
          void reload();
          notify.success({
            title: message,
            dedupeKey: "worker-mutation:" + message,
            action: message.includes("Đã gửi yêu cầu thay đổi")
              ? {
                  label: "Mở Yêu cầu thay đổi",
                  href: "/direct-entry/change-requests",
                  dataTestId: "worker-change-request-module-link",
                }
              : undefined,
          });
        }}
        onConflict={() => {
          setDrawerRow(null);
          setConflict(WORKER_CONFLICT_MESSAGE);
          notify.warning({ title: WORKER_CONFLICT_MESSAGE, dedupeKey: "worker-conflict" });
        }}
      />

      <WorkerDetailDialog
        key={detailRow === null ? "none" : detailRow.entry_id}
        row={detailRow}
        canUploadDocuments={canUploadDocuments}
        openerRef={detailOpenerRef}
        onOpenChange={(open) => { if (!open) setDetailRow(null); }}
      />

    </main>
  );
}

function LoadMore({
  state, hasMore, busy, onLoadMore,
}: { state: PageState; hasMore: boolean; busy: boolean; onLoadMore: () => void }) {
  return (
    <div className="flex justify-center">
      <CursorLoadMore
        hasMore={hasMore}
        loading={busy || state === "loading"}
        label="Tải thêm"
        onLoadMore={onLoadMore}
      />
    </div>
  );
}

function SubmissionTable({ submissions }: { submissions: readonly SubmissionReadItem[] }) {
  return (
    <DataTableContainer className="max-w-5xl" scrollClassName="overflow-x-auto">
      <table className={DATA_TABLE_CLASS + " min-w-[640px]"}>
        <caption className="sr-only">Hồ sơ bạn đã nhập (chỉ tra cứu)</caption>
        <thead className={DATA_TABLE_HEAD_CLASS}>
          <tr>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Trạng thái</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Số dòng</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Cập nhật</th>
          </tr>
        </thead>
        <tbody>
          {submissions.map((item) => {
            const badge = submissionStateBadgeProps(item.state);
            const refCode = shortRef(item.submission_id);
            const formattedUpdatedAt = formatHcmDateTime(item.updated_at);
            return (
              <tr key={item.submission_id} className={DATA_TABLE_ROW_CLASS}>
                <td className={DATA_TABLE_TD_CLASS} data-card-header="true">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={badge.tone} dot>{badge.label}</StatusBadge>
                    <span className="font-mono text-xs text-muted" title="Mã đợt rút gọn">
                      #{refCode}
                    </span>
                  </div>
                </td>
                <td className={DATA_TABLE_TD_CLASS + " font-mono text-xs tabular-nums whitespace-nowrap"} data-label="Số dòng">
                  {item.entry_count} dòng
                </td>
                <td className={DATA_TABLE_TD_CLASS + " font-mono text-xs tabular-nums text-muted whitespace-nowrap"} data-label="Cập nhật">
                  {formattedUpdatedAt}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </DataTableContainer>
  );
}

function WorkerTable({
  rows, onViewDetail, onPropose, onCorrect,
}: {
  rows: readonly WorkerDirectoryRow[];
  /** W2S1: mo dialog chi tiet dung chung; `allowed_actions.view` luon true theo server. */
  onViewDetail: (row: WorkerDirectoryRow, opener: HTMLElement | null) => void;
  /** P2.5-HF-R5A: nhan kem nut da bam de tra focus khi dong drawer. */
  onPropose: (row: WorkerDirectoryRow, opener: HTMLElement | null) => void;
  onCorrect: (row: WorkerDirectoryRow, opener: HTMLElement | null) => void;
}) {
  const rowSecondaryBtn = buttonClasses({ variant: "secondary", size: "sm" });
  const rowPrimaryBtn = buttonClasses({ variant: "primary", size: "sm" });
  const rowSoftBtn = buttonClasses({ variant: "soft", size: "sm" });
  return (
    <DataTableContainer scrollClassName="overflow-x-auto">
      <table className={DATA_TABLE_CLASS + " min-w-[900px]"}>
        <caption className="sr-only">Danh sách người lao động theo quan hệ đã chọn</caption>
        <thead className={DATA_TABLE_HEAD_CLASS}>
          <tr>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Người lao động</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Mã</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Dự án</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Ngày đầu tiên</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Người tuyển</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Trạng thái</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Yêu cầu</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS + " text-right"}>Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cta = proposeCta(row);
            const canDirectEdit = row.allowed_actions.direct_edit;
            const bank = bankAccountSummary(row.payment);
            const statusTone = row.employment_status === "ON"
              ? "success"
              : row.employment_status === "UNCONFIRMED"
                ? "warning"
                : "neutral";
            return (
              <tr key={row.entry_id} className={DATA_TABLE_ROW_CLASS}>
                <td className={DATA_TABLE_TD_CLASS + " font-semibold"} data-card-header="true">
                  {row.display_name}
                </td>
                <td className={DATA_TABLE_TD_CLASS + " font-mono text-xs whitespace-nowrap text-muted"} data-label="Mã NLĐ">
                  {row.employee_code}
                </td>
                <td className={DATA_TABLE_TD_CLASS} data-label="Dự án">
                  {row.project_display}
                </td>
                <td className={DATA_TABLE_TD_CLASS + " font-mono text-xs tabular-nums whitespace-nowrap"} data-label="Ngày đầu tiên">
                  {row.first_work_date}
                </td>
                <td className={DATA_TABLE_TD_CLASS} data-label="Người tuyển">
                  {row.recruiter_display}
                </td>
                <td className={DATA_TABLE_TD_CLASS} data-label="Trạng thái">
                  <StatusBadge tone={statusTone} dot>
                    {workerStatusLabel(row.employment_status)}
                  </StatusBadge>
                  {bank ? (
                    <div className="mt-1 text-xs text-muted line-clamp-1">
                      <span className="font-medium">{BANK_ACCOUNT_SECTION_LABEL}: </span>
                      {(bank.accountNumber ?? "chưa có") + " · " + (bank.bankId ?? "chưa có") +
                        " · " + (bank.accountHolder ?? "chưa có")}
                    </div>
                  ) : null}
                </td>
                <td className={DATA_TABLE_TD_CLASS + " text-xs"} data-label="Yêu cầu">
                  {pendingRequestLabel(row) ? (
                    <StatusBadge tone="warning">{pendingRequestLabel(row)}</StatusBadge>
                  ) : null}
                  {lastDecisionLabel(row) ? (
                    <div className="mt-1 text-muted">{lastDecisionLabel(row)}</div>
                  ) : null}
                </td>
                <td className={DATA_TABLE_TD_CLASS + " text-right"} data-card-actions="true">
                  <RowActionCluster>
                    <button type="button" className={rowSecondaryBtn}
                      onClick={(event) => onViewDetail(row, event.currentTarget)}>
                      Xem chi tiết
                    </button>
                    {!canDirectEdit && cta.show ? (
                      <button type="button" className={rowSoftBtn}
                        onClick={(event) => onPropose(row, event.currentTarget)}>
                        Đề xuất thay đổi
                      </button>
                    ) : null}
                    {canDirectEdit ? (
                      <button type="button" className={rowPrimaryBtn}
                        onClick={(event) => onCorrect(row, event.currentTarget)}>
                        Sửa trực tiếp
                      </button>
                    ) : null}
                    {cta.show || canDirectEdit ? null : (
                      <span className="text-xs text-muted">{cta.message}</span>
                    )}
                  </RowActionCluster>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </DataTableContainer>
  );
}

type EntryBaseline = {
  version: number;
  projectId: string;
  firstWorkDate: string;
  employeeCode: string;
  recruiterId: string;
  laborType: string;
  laborTypeDisplay: string;
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
        !isCanonicalLaborTypeKey(row.labor_type) ||
        typeof row.labor_type_display !== "string" || row.labor_type_display.length === 0) return null;
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
      laborTypeDisplay: row.labor_type_display,
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
  const notify = useNotify();
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
  // The row has already passed server-side worker view and scope; edits still require the existing action.
  const workerFieldMode = mode === "correction" || target === "WORKER";
  const nameAvailability = workerNameAvailability({
    proposeChange: mode === "correction" ? true : row?.allowed_actions.propose_change === true,
    hasBaseline: entryForm !== null,
  });

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
    const actionReason = trimmed === "" ? null : trimmed;
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
      if (mode === "correction") {
        const patch: Record<string, unknown> = built.ok ? { ...built.proposal } : {};
        if (!built.ok && built.code !== "WORKER_UNCHANGED") {
          setMessage(proposalErrorMessage(built.code));
          return;
        }
        if (targetStatus !== "") {
          const status = buildWorkStatusProposal({
            baseline: baseline.status === null ? null : {
              status: baseline.status, effective_date: baseline.effectiveDate ?? row.first_work_date,
            },
            status: targetStatus as WorkerStatus,
            effectiveDate: effectiveDate === ""
              ? (baseline.effectiveDate ?? row.first_work_date) : effectiveDate,
            leaveReason,
            today,
          });
          if (!status.ok) { setMessage(proposalErrorMessage(status.code)); return; }
          patch.employment_status = status.proposal;
        }
        if (Object.keys(patch).length === 0) {
          setMessage("Hồ sơ chưa có thay đổi.");
          return;
        }
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
              patch,
              reason: actionReason,
            }),
          });
          setBusy(false);
          if (response.status !== 200) {
            const payload = await response.json().catch(() => null);
            const errorCode =
              typeof payload === "object" &&
              payload !== null &&
              typeof (payload as { code?: unknown }).code === "string"
                ? (payload as { code: string }).code
                : undefined;
            if (response.status === 409 && (errorCode === undefined || errorCode === "VERSION_CONFLICT")) {
              onConflict();
              return;
            }
            notify.error({
              title: privilegedEditErrorMessage(response.status, errorCode),
              dedupeKey: "worker-privileged-edit-err",
            });
            return;
          }
          onDone("Đã lưu chỉnh sửa trực tiếp.");
        } catch {
          setBusy(false);
          notify.error({
            title: "Không lưu được chỉnh sửa trực tiếp. Vui lòng thử lại.",
            dedupeKey: "worker-privileged-edit-err",
          });
        }
        return;
      }
      if (!built.ok) { setMessage(proposalErrorMessage(built.code)); return; }
      proposal = built.proposal;
      targetKind = "ENTRY_FIELD";
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
        body: JSON.stringify({ items: [item], reason: actionReason, idempotency_key: crypto.randomUUID() }),
      });
      setBusy(false);
      if (response.status === 409) { onConflict(); return; }
      if (response.status === 403) {
        notify.error({
          title: "Bạn không còn quyền đề xuất thay đổi.",
          dedupeKey: "worker-propose-err",
        });
        return;
      }
      if (response.status !== 200 && response.status !== 201) {
        notify.error({
          title: "Không gửi được yêu cầu thay đổi. Vui lòng thử lại.",
          dedupeKey: "worker-propose-err",
        });
        return;
      }
      onDone("Đã gửi yêu cầu thay đổi.");
    } catch {
      setBusy(false);
      notify.error({
        title: "Không gửi được yêu cầu thay đổi. Vui lòng thử lại.",
        dedupeKey: "worker-propose-err",
      });
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
                    ? "Dữ liệu hiện tại được nạp sẵn — chỉnh phần cần sửa. Lý do thao tác không bắt buộc."
                    : "Dữ liệu hiện tại được nạp sẵn — chỉnh phần cần đổi rồi gửi duyệt. Lý do thao tác không bắt buộc."}
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
                      ["Loại hình lao động", row.labor_type_display],
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

              {workerFieldMode ? (
                entryForm !== null && nameAvailability.available ? (
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
                    <select id="worker-labor-type" className={inputClass}
                      value={(entryCatalog?.labor_types ?? []).some((option) =>
                        option.labor_type_key === entryForm.labor_type) ? entryForm.labor_type : ""}
                      disabled={loading || entryCatalog === undefined ||
                        (entryCatalog.labor_types ?? []).length === 0}
                      onChange={(event) => setEntryForm({ ...entryForm,
                        labor_type: event.target.value })}>
                      <option value="">Chọn loại hình</option>
                      {sortedActiveLaborTypes(entryCatalog?.labor_types).map((option) => (
                        <option key={option.labor_type_key} value={option.labor_type_key}>
                          {option.display_name}
                        </option>
                      ))}
                    </select>
                    {baseline !== null &&
                      !(entryCatalog?.labor_types ?? []).some((option) =>
                        option.labor_type_key === baseline.laborType) && (
                      <small>Hiện tại: {baseline.laborTypeDisplay} · không còn hoạt động</small>
                    )}
                  </div>
                  {!loading && entryCatalog === undefined && catalogDenied ? (
                    <p role="status" className={infoClass}>
                      Vai trò hiện tại không có quyền đọc danh mục; không thể chọn giá trị danh mục mới.
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
                ) : (
                  <p role="status" className={infoClass} data-testid="propose-worker-unavailable">
                    {nameAvailability.message}
                  </p>
                )
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

              {(mode === "correction" || target === "WORK_STATUS") ? (
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
                      <option value="">
                        {mode === "correction" ? "Giữ nguyên trạng thái" : "Chọn trạng thái"}
                      </option>
                      {allowedWorkStatusTargets(baseline?.status ?? null).map((status) => (
                        <option key={status} value={status}>{workerStatusLabel(status)}</option>
                      ))}
                    </select>
                  </div>
                  {targetStatus !== "" ? <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-effective-date" className="text-sm font-medium">Ngày hiệu lực</label>
                    <input id="worker-effective-date" type="date" className={inputClass}
                      min={baseline?.effectiveDate ?? row?.first_work_date ?? undefined}
                      max={today} value={effectiveDate}
                      disabled={loading || baseline === null}
                      onChange={(event) => setEffectiveDate(event.target.value)} />
                  </div> : null}
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
                  {mode === "correction" ? "Lý do chỉnh sửa (không bắt buộc)" : "Lý do đề xuất (không bắt buộc)"}
                </label>
                <textarea id={reasonId}
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
                disabled={busy || loading || baseline === null ||
                  (workerFieldMode && !nameAvailability.available)} aria-busy={busy}>
                {mode === "correction" ? "Lưu chỉnh sửa trực tiếp" : "Gửi đề xuất"}
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Tai Blob tu response thanh file; khong dung XLSX phia client va khong doc PII tu bang. */
function downloadFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * PRE-W2-P1 (T1A): hop thoai "Xuat Excel".
 *
 * Chi gui `scope` + bo loc hien tai + optional `reason` toi POST /api/direct-entry/workers/export;
 * khong gui authority va khong gui PII tu bang. Thanh cong => tai .xlsx tu response Blob. 422
 * row-limit => bao ro gioi han, khong tai file thieu dong. Khong log reason/body/PII.
 */
function WorkerExportDialog({
  open, scope, filters, onOpenChange, onDone,
}: {
  open: boolean;
  scope: WorkerExportScope | null;
  filters: WorkerDirectoryFilters;
  onOpenChange: (open: boolean) => void;
  onDone: (message: string) => void;
}) {
  const reasonId = useId();
  const notify = useNotify();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (scope === null || busy) return;
    const request = buildWorkerExportRequest({
      scope, filters, reason: reason.trim() === "" ? null : reason.trim(),
    });
    if (!request.ok) { setMessage(workerExportRequestMessage(request.code)); return; }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(API + "/workers/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(request.body),
      });
      if (response.status === 200) {
        const blob = await response.blob();
        if (!(await isUsableWorkerExportBlob(blob, response.headers.get("content-type")))) {
          setBusy(false);
          notify.error({
            title: WORKER_EXPORT_EMPTY_FILE_MESSAGE,
            dedupeKey: "worker-export-err",
          });
          return;
        }
        downloadFile(blob, workerExportFilename(
          response.headers.get("content-disposition"), hcmTodayDate()));
        setBusy(false);
        onDone("Đã tải danh sách người lao động (.xlsx).");
        return;
      }
      const payload = await readJson(response);
      setBusy(false);
      notify.error({
        title: workerExportErrorMessage(response.status, payload),
        dedupeKey: "worker-export-err",
      });
    } catch {
      setBusy(false);
      notify.error({
        title: workerExportErrorMessage(0, null),
        dedupeKey: "worker-export-err",
      });
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onOpenChange(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)]
            w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2
            overflow-hidden rounded-2xl border border-border bg-surface text-foreground shadow-2xl
            outline-none"
        >
          <form className="flex min-h-0 w-full flex-col"
            onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border
              bg-surface px-4 py-4 sm:px-5">
              <div>
                <Dialog.Title className="text-xl font-semibold">Xuất Excel</Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted">
                  Xuất danh sách người lao động theo đúng quan hệ và bộ lọc đang chọn. Lý do không
                  bắt buộc; thao tác vẫn được ghi nhận vào nhật ký.
                </Dialog.Description>
              </div>
              <button type="button" aria-label="Đóng xuất Excel" disabled={busy}
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-full
                  border border-border bg-surface text-xl text-muted hover:bg-muted/10
                  hover:text-foreground focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-ring/40 disabled:opacity-50"
                onClick={() => onOpenChange(false)}>×</button>
            </header>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
              <p className={infoClass}>
                File có thể chứa đầy đủ CCCD, ngày sinh, số điện thoại, địa chỉ và thông tin tài
                khoản ngân hàng. Chỉ lưu hoặc chia sẻ với người có thẩm quyền.
              </p>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={reasonId} className="text-sm font-medium">
                  Lý do xuất (không bắt buộc)
                </label>
                <textarea id={reasonId}
                  maxLength={WORKER_EXPORT_REASON_MAX}
                  disabled={busy}
                  className="min-h-24 w-full rounded-md border border-border bg-surface p-3 text-sm
                    text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
                  value={reason} onChange={(event) => setReason(event.target.value)} />
              </div>
              {busy ? (
                <div role="status" aria-live="polite" data-testid="worker-export-pending" className={infoClass}>
                  <p>Đang tổng hợp dữ liệu và tạo tệp Excel trên máy chủ…</p>
                  <progress aria-label="Đang xuất danh sách người lao động" className="mt-2 h-2 w-full" />
                </div>
              ) : null}
              {message ? <p role="alert" className={errorClass}>{message}</p> : null}
            </div>

            <footer className="flex shrink-0 justify-end gap-2 border-t border-border bg-surface px-4 py-3 sm:px-5">
              <button type="button" className={buttonClass} disabled={busy}
                onClick={() => onOpenChange(false)}>Huỷ</button>
              <button type="submit" className={primaryClass}
                disabled={busy || scope === null} aria-busy={busy}>
                {busy ? "Đang xuất…" : "Tải xuống"}
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
