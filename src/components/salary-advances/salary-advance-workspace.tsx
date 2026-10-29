"use client";
/* eslint-disable @next/next/no-img-element */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CursorLoadMore } from "@/components/ui/cursor-load-more";
import { DataTableContainer } from "@/components/ui/data-table";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { StatusBanner } from "@/components/ui/status-banner";
import type {
  SalaryAdvanceActorContext,
  SalaryAdvanceEvidenceReviewDecision,
  SalaryAdvanceEvidenceReviewState,
  SalaryAdvanceMutationDetailResponse,
  SalaryAdvanceRequestDetail,
  SalaryAdvanceRequestListResponse,
  SalaryAdvanceRequestState,
  SalaryAdvanceRequestSummary,
  SalaryAdvanceTransitionAction,
  SalaryAdvanceWorkerListResponse,
  SalaryAdvanceWorkerOption,
} from "@/lib/salary-advance/salary-advance-contract";
import {
  SALARY_ADVANCE_NON_ACCOUNTING_NOTICE,
  canAccessSalaryAdvanceContext,
  countActionableRequestsForTab,
  createLatestRequestTracker,
  evaluateEvidenceComparisonPanel,
  evaluateRequestAttentionForTab,
  formatDateTimeVi,
  formatFileSizeBytes,
  formatVndAmount,
  getEvidenceReviewStateMeta,
  getRequestStateMeta,
  getSalaryAdvanceActorRoleLabel,
  getSalaryAdvanceEventTone,
  getSalaryAdvanceEventTypeLabel,
  isSalaryAdvanceConflictError,
  newSalaryAdvanceIdempotencyKey,
  normalizePositiveVndInput,
  reconcileSelectedRequestIdFromList,
  reconcileSelectedWorkerEntryId,
  resolveActiveRequestDetail,
  resolveAvailableRequestActions,
  resolveScopedMutationFailureOutcome,
  resolveVisibleSalaryAdvanceTabs,
  salaryAdvanceErrorMessage,
  sortEventsChronologically,
  uploadSalaryAdvanceEvidence,
  validateCreateSalaryAdvanceDraft,
  validateEvidenceFilePreflight,
  validateEvidenceReviewInput,
  validateMessageInput,
  validateTransitionActionInput,
  type LatestRequestTracker,
  type SalaryAdvanceWorkspaceTabId,
} from "@/lib/salary-advance/salary-advance-ui-model";

export const REQUEST_STATE_FILTER_OPTIONS: ReadonlyArray<{
  value: "ALL" | SalaryAdvanceRequestState;
  label: string;
}> = [
  { value: "ALL", label: "Tất cả trạng thái" },
  { value: "OPEN", label: "Chờ Kế toán xử lý" },
  { value: "NEEDS_INFO", label: "Cần bổ sung" },
  { value: "APPROVED", label: "Đã chấp thuận" },
  { value: "REJECTED", label: "Đã từ chối" },
  { value: "WITHDRAWN", label: "Đã rút" },
  { value: "HANDLED_EXTERNALLY", label: "Xử lý ngoài BI" },
];

export const EVIDENCE_STATE_FILTER_OPTIONS: ReadonlyArray<{
  value: "ALL" | SalaryAdvanceEvidenceReviewState;
  label: string;
}> = [
  { value: "ALL", label: "Tất cả ảnh" },
  { value: "NOT_UPLOADED", label: "Chưa tải ảnh" },
  { value: "PENDING_REVIEW", label: "Chờ đối chiếu" },
  { value: "REVIEWED", label: "Đã đối chiếu" },
  { value: "RETAKE_REQUIRED", label: "Cần gửi lại ảnh" },
];

type TransitionDialogState = {
  open: boolean;
  action: SalaryAdvanceTransitionAction;
  title: string;
  description: string;
  submitLabel: string;
  submitVariant: "primary" | "danger" | "secondary";
  requireMessage: boolean;
  messageLabel: string;
  messagePlaceholder: string;
};

function getRequestTracker(
  ref: React.MutableRefObject<LatestRequestTracker | null>
): LatestRequestTracker {
  if (!ref.current) {
    ref.current = createLatestRequestTracker();
  }
  return ref.current;
}

export function SalaryAdvanceWorkspace() {
  const notify = useNotify();

  const [contextLoading, setContextLoading] = useState(true);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextErrorCode, setContextErrorCode] = useState<string | null>(null);
  const [context, setContext] = useState<SalaryAdvanceActorContext | null>(null);

  const [activeTab, setActiveTab] = useState<SalaryAdvanceWorkspaceTabId>("pm");
  const [tabBadgeCounts, setTabBadgeCounts] = useState<
    Partial<Record<SalaryAdvanceWorkspaceTabId, number>>
  >({});

  // Queue filter state
  const [projectFilter, setProjectFilter] = useState<string>("ALL");
  const [requestStateFilter, setRequestStateFilter] = useState<
    "ALL" | SalaryAdvanceRequestState
  >("ALL");
  const [evidenceStateFilter, setEvidenceStateFilter] = useState<
    "ALL" | SalaryAdvanceEvidenceReviewState
  >("ALL");
  const [searchInput, setSearchInput] = useState<string>("");
  const [appliedSearch, setAppliedSearch] = useState<string>("");

  // Request list state
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestsLoadingMore, setRequestsLoadingMore] = useState(false);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [requests, setRequests] = useState<SalaryAdvanceRequestSummary[]>([]);
  const [requestsHasMore, setRequestsHasMore] = useState(false);
  const [requestsNextCursor, setRequestsNextCursor] = useState<string | null>(
    null
  );

  // Selected request detail state
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(
    null
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SalaryAdvanceRequestDetail | null>(null);
  const [selectedEvidenceVersion, setSelectedEvidenceVersion] = useState<
    number | null
  >(null);
  const [conflictBannerMessage, setConflictBannerMessage] = useState<
    string | null
  >(null);

  // Image preview retry flags
  const [portraitImgError, setPortraitImgError] = useState(false);
  const [evidenceImgError, setEvidenceImgError] = useState(false);

  // Create request form state (PM)
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState<string>("");
  const [workerSearchInput, setWorkerSearchInput] = useState<string>("");
  const [workersLoading, setWorkersLoading] = useState(false);
  const [workersLoadingMore, setWorkersLoadingMore] = useState(false);
  const [workersError, setWorkersError] = useState<string | null>(null);
  const [workers, setWorkers] = useState<SalaryAdvanceWorkerOption[]>([]);
  const [workersHasMore, setWorkersHasMore] = useState(false);
  const [workersNextCursor, setWorkersNextCursor] = useState<string | null>(
    null
  );
  const [createWorkerEntryId, setCreateWorkerEntryId] = useState<string>("");
  const [createAmountRaw, setCreateAmountRaw] = useState<string>("");
  const [createInitialContent, setCreateInitialContent] = useState<string>("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSubmitting, setCreateSubmitting] = useState(false);

  // Message form state
  const [messageText, setMessageText] = useState<string>("");
  const [messageError, setMessageError] = useState<string | null>(null);
  const [messageSubmitting, setMessageSubmitting] = useState(false);

  // Transition dialog state
  const [transitionDialog, setTransitionDialog] =
    useState<TransitionDialogState | null>(null);
  const [transitionMessageText, setTransitionMessageText] =
    useState<string>("");
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [transitionSubmitting, setTransitionSubmitting] = useState(false);

  // Evidence upload state (PM)
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidenceCaptionNote, setEvidenceCaptionNote] = useState<string>("");
  const [evidenceUploadError, setEvidenceUploadError] = useState<string | null>(
    null
  );
  const [evidenceUploading, setEvidenceUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Evidence review state (Accountant)
  const [evidenceReviewNote, setEvidenceReviewNote] = useState<string>("");
  const [evidenceReviewError, setEvidenceReviewError] = useState<string | null>(
    null
  );
  const [evidenceReviewSubmitting, setEvidenceReviewSubmitting] =
    useState(false);

  // Idempotency key refs per user intent
  const createIdempotencyKeyRef = useRef<string>(
    newSalaryAdvanceIdempotencyKey("sa-create")
  );
  const messageIdempotencyKeyRef = useRef<string>(
    newSalaryAdvanceIdempotencyKey("sa-msg")
  );
  const transitionIdempotencyKeyRef = useRef<string>(
    newSalaryAdvanceIdempotencyKey("sa-act")
  );
  const evidenceReserveKeyRef = useRef<string>(
    newSalaryAdvanceIdempotencyKey("sa-ev-res")
  );
  const evidenceFinalizeKeyRef = useRef<string>(
    newSalaryAdvanceIdempotencyKey("sa-ev-fin")
  );
  const evidenceReviewKeyRef = useRef<string>(
    newSalaryAdvanceIdempotencyKey("sa-ev-rev")
  );
  const requestsTrackerRef = useRef<LatestRequestTracker | null>(null);
  const detailTrackerRef = useRef<LatestRequestTracker | null>(null);
  const workersTrackerRef = useRef<LatestRequestTracker | null>(null);
  const selectedRequestIdRef = useRef<string | null>(null);

  const activeDetail = resolveActiveRequestDetail(detail, selectedRequestId);

  const selectRequest = useCallback((nextRequestId: string | null) => {
    const previousRequestId = selectedRequestIdRef.current;
    selectedRequestIdRef.current = nextRequestId;
    setSelectedRequestId(nextRequestId);

    if (previousRequestId !== nextRequestId) {
      getRequestTracker(detailTrackerRef).cancelAll();
      setDetail((prev) =>
        prev && nextRequestId && prev.request.request_id === nextRequestId
          ? prev
          : null
      );
      setDetailLoading(Boolean(nextRequestId));
      setDetailError(null);
      setConflictBannerMessage(null);
      setTransitionDialog(null);
      setTransitionError(null);
      setMessageError(null);
      setEvidenceUploadError(null);
      setEvidenceReviewError(null);
    }
  }, []);

  useEffect(() => {
    const requestsTracker = getRequestTracker(requestsTrackerRef);
    const detailTracker = getRequestTracker(detailTrackerRef);
    const workersTracker = getRequestTracker(workersTrackerRef);
    return () => {
      requestsTracker.cancelAll();
      detailTracker.cancelAll();
      workersTracker.cancelAll();
    };
  }, []);

  const visibleTabs = useMemo(() => {
    if (!context) return [];
    return resolveVisibleSalaryAdvanceTabs(context, tabBadgeCounts);
  }, [context, tabBadgeCounts]);

  const currentTabConfig = useMemo(() => {
    return (
      visibleTabs.find((tab) => tab.id === activeTab) ?? visibleTabs[0] ?? null
    );
  }, [visibleTabs, activeTab]);

  const availableProjectsForCurrentTab = useMemo(() => {
    if (!context || !currentTabConfig) return [];
    if (currentTabConfig.id === "pm") {
      return context.managed_projects;
    }
    if (currentTabConfig.id === "accountant") {
      return context.accountant_projects;
    }
    return context.supervisory_projects;
  }, [context, currentTabConfig]);

  const activeManagedProjects = useMemo(() => {
    if (!context) return [];
    return context.managed_projects.filter((project) => project.active);
  }, [context]);

  const selectedCreateProject = useMemo(() => {
    return (
      activeManagedProjects.find(
        (project) => project.project_id === createProjectId
      ) ?? null
    );
  }, [activeManagedProjects, createProjectId]);

  const loadContext = useCallback(async () => {
    setContextLoading(true);
    setContextError(null);
    setContextErrorCode(null);

    try {
      const response = await fetch("/api/salary-advance/context", {
        method: "GET",
        cache: "no-store",
      });
      const json = (await response.json().catch(() => null)) as
        | { ok?: boolean; data?: SalaryAdvanceActorContext; code?: string }
        | null;

      if (!response.ok || !json?.ok || !json.data) {
        const code = json?.code ?? "SALARY_ADVANCE_UNAVAILABLE";
        setContextErrorCode(code);
        setContextError(salaryAdvanceErrorMessage(code));
        setContext(null);
        return;
      }

      const loadedContext = json.data;
      setContext(loadedContext);

      const initialTabs = resolveVisibleSalaryAdvanceTabs(loadedContext);
      if (initialTabs.length > 0) {
        setActiveTab((prev) =>
          initialTabs.some((t) => t.id === prev) ? prev : initialTabs[0].id
        );
      }

      const firstManaged = loadedContext.managed_projects.find((p) => p.active);
      if (firstManaged) {
        setCreateProjectId((prev) => prev || firstManaged.project_id);
      }
    } catch {
      setContextErrorCode("SALARY_ADVANCE_UNAVAILABLE");
      setContextError(salaryAdvanceErrorMessage("SALARY_ADVANCE_UNAVAILABLE"));
      setContext(null);
    } finally {
      setContextLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadContext();
    });
  }, [loadContext]);

  const loadRequests = useCallback(
    async (options?: { cursor?: string | null; append?: boolean }) => {
      if (!currentTabConfig) return;

      const req = getRequestTracker(requestsTrackerRef).begin();
      const isAppend = Boolean(options?.append && options?.cursor);
      if (isAppend) {
        setRequestsLoadingMore(true);
      } else {
        setRequestsLoading(true);
        setRequestsError(null);
      }

      try {
        const params = new URLSearchParams();
        params.set("queue", currentTabConfig.queue);
        params.set("page_size", "25");

        if (projectFilter !== "ALL") {
          params.set("project_id", projectFilter);
        }
        if (requestStateFilter !== "ALL") {
          params.set("request_state", requestStateFilter);
        }
        if (evidenceStateFilter !== "ALL") {
          params.set("evidence_review_state", evidenceStateFilter);
        }
        if (appliedSearch.trim().length > 0) {
          params.set("search", appliedSearch.trim());
        }
        if (isAppend && options?.cursor) {
          params.set("cursor", options.cursor);
        }

        const response = await fetch(
          `/api/salary-advance/requests?${params.toString()}`,
          {
            method: "GET",
            cache: "no-store",
            signal: req.signal,
          }
        );

        const json = (await response.json().catch(() => null)) as
          | {
              ok?: boolean;
              data?: SalaryAdvanceRequestListResponse;
              code?: string;
            }
          | null;

        if (!req.isCurrent()) {
          return;
        }

        if (!response.ok || !json?.ok || !json.data) {
          const code = json?.code ?? "SALARY_ADVANCE_UNAVAILABLE";
          setRequestsError(salaryAdvanceErrorMessage(code));
          return;
        }

        const nextRows = json.data.requests ?? [];
        setRequests((prev) => {
          const combined = isAppend ? [...prev, ...nextRows] : nextRows;
          const actionableCount = countActionableRequestsForTab(
            combined,
            currentTabConfig.id
          );
          setTabBadgeCounts((counts) => ({
            ...counts,
            [currentTabConfig.id]: actionableCount,
          }));
          return combined;
        });
        setRequestsHasMore(Boolean(json.data.has_more));
        setRequestsNextCursor(json.data.next_cursor ?? null);

        if (!isAppend) {
          const nextSelectedId = reconcileSelectedRequestIdFromList(
            selectedRequestIdRef.current,
            nextRows
          );
          if (nextSelectedId !== selectedRequestIdRef.current) {
            selectRequest(nextSelectedId);
          } else if (nextSelectedId === null) {
            setDetail(null);
            setDetailLoading(false);
          }
        }
      } catch {
        if (!req.isCurrent()) {
          return;
        }
        setRequestsError(
          salaryAdvanceErrorMessage("SALARY_ADVANCE_UNAVAILABLE")
        );
      } finally {
        if (req.isCurrent()) {
          setRequestsLoading(false);
          setRequestsLoadingMore(false);
        }
      }
    },
    [
      currentTabConfig,
      projectFilter,
      requestStateFilter,
      evidenceStateFilter,
      appliedSearch,
      selectRequest,
    ]
  );

  useEffect(() => {
    if (!currentTabConfig) return;
    queueMicrotask(() => {
      void loadRequests();
    });
    return () => {
      getRequestTracker(requestsTrackerRef).cancelAll();
    };
  }, [currentTabConfig, loadRequests]);

  const loadRequestDetail = useCallback(
    async (
      requestId: string,
      options?: { preserveConflictBanner?: boolean }
    ) => {
      const req = getRequestTracker(detailTrackerRef).begin();
      setDetail((prev) =>
        prev && prev.request.request_id === requestId ? prev : null
      );
      setDetailLoading(true);
      setDetailError(null);
      if (!options?.preserveConflictBanner) {
        setConflictBannerMessage(null);
      }

      try {
        const response = await fetch(
          `/api/salary-advance/requests/${encodeURIComponent(requestId)}`,
          {
            method: "GET",
            cache: "no-store",
            signal: req.signal,
          }
        );

        const json = (await response.json().catch(() => null)) as
          | { ok?: boolean; data?: SalaryAdvanceRequestDetail; code?: string }
          | null;

        if (!req.isCurrent() || selectedRequestIdRef.current !== requestId) {
          return;
        }

        if (!response.ok || !json?.ok || !json.data) {
          const code = json?.code ?? "SALARY_ADVANCE_UNAVAILABLE";
          setDetailError(salaryAdvanceErrorMessage(code));
          return;
        }

        const loadedDetail = json.data;
        if (loadedDetail.request.request_id !== requestId) {
          return;
        }

        setDetail(loadedDetail);
        setSelectedEvidenceVersion(
          loadedDetail.request.current_evidence?.evidence_version ??
            loadedDetail.evidence_versions[0]?.evidence_version ??
            null
        );
        setPortraitImgError(false);
        setEvidenceImgError(false);

        setRequests((prev) =>
          prev.map((row) =>
            row.request_id === loadedDetail.request.request_id
              ? loadedDetail.request
              : row
          )
        );
      } catch {
        if (!req.isCurrent() || selectedRequestIdRef.current !== requestId) {
          return;
        }
        setDetailError(salaryAdvanceErrorMessage("SALARY_ADVANCE_UNAVAILABLE"));
      } finally {
        if (req.isCurrent() && selectedRequestIdRef.current === requestId) {
          setDetailLoading(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    selectedRequestIdRef.current = selectedRequestId;
    queueMicrotask(() => {
      if (!selectedRequestId) {
        getRequestTracker(detailTrackerRef).cancelAll();
        setDetail(null);
        setDetailLoading(false);
        setDetailError(null);
        return;
      }
      void loadRequestDetail(selectedRequestId);
    });
    return () => {
      getRequestTracker(detailTrackerRef).cancelAll();
    };
  }, [selectedRequestId, loadRequestDetail]);

  const loadProjectWorkers = useCallback(
    async (
      projectId: string,
      search: string,
      options?: { cursor?: string | null; append?: boolean }
    ) => {
      if (!projectId) {
        getRequestTracker(workersTrackerRef).cancelAll();
        setWorkers([]);
        setWorkersHasMore(false);
        setWorkersNextCursor(null);
        setWorkersLoading(false);
        setWorkersLoadingMore(false);
        setWorkersError(null);
        setCreateWorkerEntryId("");
        return;
      }

      const req = getRequestTracker(workersTrackerRef).begin();
      const isAppend = Boolean(options?.append && options?.cursor);
      if (isAppend) {
        setWorkersLoadingMore(true);
      } else {
        setWorkersLoading(true);
        setWorkersError(null);
      }

      try {
        const params = new URLSearchParams();
        params.set("page_size", "30");
        if (search.trim().length > 0) {
          params.set("search", search.trim());
        }
        if (isAppend && options?.cursor) {
          params.set("cursor", options.cursor);
        }

        const response = await fetch(
          `/api/salary-advance/projects/${encodeURIComponent(
            projectId
          )}/workers?${params.toString()}`,
          {
            method: "GET",
            cache: "no-store",
            signal: req.signal,
          }
        );

        const json = (await response.json().catch(() => null)) as
          | {
              ok?: boolean;
              data?: SalaryAdvanceWorkerListResponse;
              code?: string;
            }
          | null;

        if (!req.isCurrent()) {
          return;
        }

        if (!response.ok || !json?.ok || !json.data) {
          const code = json?.code ?? "SALARY_ADVANCE_UNAVAILABLE";
          setWorkersError(salaryAdvanceErrorMessage(code));
          return;
        }

        const nextWorkers = json.data.workers ?? [];
        setWorkers((prev) =>
          isAppend ? [...prev, ...nextWorkers] : nextWorkers
        );
        setWorkersHasMore(Boolean(json.data.has_more));
        setWorkersNextCursor(json.data.next_cursor ?? null);

        if (!isAppend) {
          setCreateWorkerEntryId((prev) =>
            reconcileSelectedWorkerEntryId(prev, nextWorkers)
          );
        }
      } catch {
        if (!req.isCurrent()) {
          return;
        }
        setWorkersError(
          salaryAdvanceErrorMessage("SALARY_ADVANCE_UNAVAILABLE")
        );
      } finally {
        if (req.isCurrent()) {
          setWorkersLoading(false);
          setWorkersLoadingMore(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    if (!createDialogOpen || !createProjectId) {
      getRequestTracker(workersTrackerRef).cancelAll();
      return;
    }
    queueMicrotask(() => {
      void loadProjectWorkers(createProjectId, workerSearchInput);
    });
    return () => {
      getRequestTracker(workersTrackerRef).cancelAll();
    };
  }, [
    createDialogOpen,
    createProjectId,
    workerSearchInput,
    loadProjectWorkers,
  ]);

  const handleTabChange = (nextTabId: SalaryAdvanceWorkspaceTabId) => {
    if (nextTabId === activeTab) return;
    getRequestTracker(requestsTrackerRef).cancelAll();
    getRequestTracker(detailTrackerRef).cancelAll();
    setActiveTab(nextTabId);
    setProjectFilter("ALL");
    setRequestStateFilter("ALL");
    setEvidenceStateFilter("ALL");
    setSearchInput("");
    setAppliedSearch("");
    setConflictBannerMessage(null);
  };

  const handleConflictReload = useCallback(
    async (requestId: string, code: string) => {
      if (selectedRequestIdRef.current !== requestId) {
        await loadRequests();
        return;
      }
      const msg = salaryAdvanceErrorMessage(code);
      setConflictBannerMessage(msg);
      notify.warning({
        title: "Dữ liệu vừa thay đổi (409 Conflict)",
        description: msg,
      });
      await Promise.all([
        loadRequestDetail(requestId, { preserveConflictBanner: true }),
        loadRequests(),
      ]);
    },
    [loadRequestDetail, loadRequests, notify]
  );

  const applyMutationDetailResponse = useCallback(
    (
      mutationData: SalaryAdvanceMutationDetailResponse,
      options?: { forceSelect?: boolean }
    ) => {
      const updatedDetail: SalaryAdvanceRequestDetail = {
        request: mutationData.request,
        events: mutationData.events,
        evidence_versions: mutationData.evidence_versions,
      };
      if (options?.forceSelect) {
        getRequestTracker(detailTrackerRef).cancelAll();
        selectedRequestIdRef.current = updatedDetail.request.request_id;
        setSelectedRequestId(updatedDetail.request.request_id);
        setDetailLoading(false);
        setDetailError(null);
      }
      if (
        options?.forceSelect ||
        selectedRequestIdRef.current === updatedDetail.request.request_id
      ) {
        setDetail(updatedDetail);
        setSelectedEvidenceVersion(
          updatedDetail.request.current_evidence?.evidence_version ??
            updatedDetail.evidence_versions[0]?.evidence_version ??
            null
        );
        setConflictBannerMessage(null);
      }
      setRequests((prev) =>
        prev.map((row) =>
          row.request_id === updatedDetail.request.request_id
            ? updatedDetail.request
            : row
        )
      );
    },
    []
  );

  const handleOpenCreateDialog = () => {
    const defaultProject =
      activeManagedProjects.find((p) => p.has_active_accountant) ??
      activeManagedProjects[0] ??
      null;
    setCreateProjectId(defaultProject?.project_id ?? "");
    setWorkerSearchInput("");
    setCreateWorkerEntryId("");
    setCreateAmountRaw("");
    setCreateInitialContent("");
    setCreateError(null);
    createIdempotencyKeyRef.current =
      newSalaryAdvanceIdempotencyKey("sa-create");
    setCreateDialogOpen(true);
  };

  const handleSubmitCreateRequest = async () => {
    setCreateError(null);
    const validation = validateCreateSalaryAdvanceDraft({
      projectId: createProjectId,
      hasActiveAccountant: selectedCreateProject?.has_active_accountant,
      workerEntryId: createWorkerEntryId,
      requestedAmountRaw: createAmountRaw,
      initialContent: createInitialContent,
    });

    if (!validation.ok) {
      setCreateError(validation.message);
      return;
    }

    setCreateSubmitting(true);
    try {
      const idempotencyKey = createIdempotencyKeyRef.current;
      const response = await fetch("/api/salary-advance/requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          ...validation.payload,
          idempotency_key: idempotencyKey,
        }),
      });

      const json = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            data?: SalaryAdvanceMutationDetailResponse;
            code?: string;
          }
        | null;

      if (!response.ok || !json?.ok || !json.data) {
        const code = json?.code ?? "SALARY_ADVANCE_UNAVAILABLE";
        if (isSalaryAdvanceConflictError(response.status, code)) {
          createIdempotencyKeyRef.current =
            newSalaryAdvanceIdempotencyKey("sa-create");
        }
        setCreateError(salaryAdvanceErrorMessage(code));
        return;
      }

      createIdempotencyKeyRef.current =
        newSalaryAdvanceIdempotencyKey("sa-create");
      setCreateDialogOpen(false);
      notify.success({
        title: "Đã tạo yêu cầu ứng lương",
        description: `Yêu cầu ứng lương cho ${json.data.request.worker_display_name} đã được chuyển tới Kế toán dự án.`,
      });

      applyMutationDetailResponse(json.data, { forceSelect: true });
      await loadRequests();
    } catch {
      setCreateError(salaryAdvanceErrorMessage("SALARY_ADVANCE_UNAVAILABLE"));
    } finally {
      setCreateSubmitting(false);
    }
  };

  const handleSendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeDetail) return;
    const targetRequest = activeDetail.request;
    setMessageError(null);

    const validation = validateMessageInput(messageText);
    if (!validation.ok) {
      setMessageError(validation.message);
      return;
    }

    setMessageSubmitting(true);
    try {
      const idempotencyKey = messageIdempotencyKeyRef.current;
      const response = await fetch(
        `/api/salary-advance/requests/${encodeURIComponent(
          targetRequest.request_id
        )}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            expected_version: targetRequest.version,
            message_text: validation.normalizedMessage,
            idempotency_key: idempotencyKey,
          }),
        }
      );

      const json = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            data?: SalaryAdvanceMutationDetailResponse;
            code?: string;
          }
        | null;

      if (!response.ok || !json?.ok || !json.data) {
        const code = json?.code ?? "SALARY_ADVANCE_UNAVAILABLE";
        if (isSalaryAdvanceConflictError(response.status, code)) {
          messageIdempotencyKeyRef.current =
            newSalaryAdvanceIdempotencyKey("sa-msg");
        }
        const failureOutcome = resolveScopedMutationFailureOutcome({
          targetRequestId: targetRequest.request_id,
          currentSelectedRequestId: selectedRequestIdRef.current,
          status: response.status,
          code,
        });
        if (
          !failureOutcome.shouldUpdateSelectedRequestUi ||
          selectedRequestIdRef.current !== targetRequest.request_id
        ) {
          if (failureOutcome.shouldReloadRequestList) {
            await loadRequests();
          }
          return;
        }
        if (failureOutcome.shouldReloadSelectedDetail) {
          await handleConflictReload(targetRequest.request_id, code);
          return;
        }
        setMessageError(failureOutcome.errorMessage);
        return;
      }

      messageIdempotencyKeyRef.current =
        newSalaryAdvanceIdempotencyKey("sa-msg");
      if (selectedRequestIdRef.current === targetRequest.request_id) {
        setMessageText("");
      }
      applyMutationDetailResponse(json.data);
      notify.success({
        title: "Đã gửi tin nhắn",
        description: "Tin nhắn đã được ghi vào lịch sử trao đổi của yêu cầu.",
      });
    } catch {
      if (selectedRequestIdRef.current === targetRequest.request_id) {
        setMessageError(
          salaryAdvanceErrorMessage("SALARY_ADVANCE_UNAVAILABLE")
        );
      }
    } finally {
      setMessageSubmitting(false);
    }
  };

  const openTransitionActionDialog = (action: SalaryAdvanceTransitionAction) => {
    setTransitionMessageText("");
    setTransitionError(null);
    transitionIdempotencyKeyRef.current =
      newSalaryAdvanceIdempotencyKey("sa-act");

    switch (action) {
      case "APPROVE":
        setTransitionDialog({
          open: true,
          action: "APPROVE",
          title: "Chấp thuận yêu cầu ứng lương",
          description:
            "Xác nhận chấp thuận đề nghị ứng lương này. Sau khi chấp thuận, QLDA có thể tải lên ảnh NLĐ nhận tiền mặt để đối chiếu.",
          submitLabel: "Xác nhận chấp thuận",
          submitVariant: "primary",
          requireMessage: false,
          messageLabel: "Ghi chú phê duyệt (không bắt buộc)",
          messagePlaceholder:
            "Nhập hướng dẫn chi trả tiền mặt hoặc ghi chú cho QLDA...",
        });
        break;
      case "REJECT":
        setTransitionDialog({
          open: true,
          action: "REJECT",
          title: "Từ chối yêu cầu ứng lương",
          description:
            "Vui lòng nêu rõ lý do từ chối để Quản lý dự án nắm được thông tin.",
          submitLabel: "Xác nhận từ chối",
          submitVariant: "danger",
          requireMessage: true,
          messageLabel: "Lý do từ chối (*)",
          messagePlaceholder: "Nhập lý do từ chối yêu cầu ứng lương...",
        });
        break;
      case "REQUEST_INFO":
        setTransitionDialog({
          open: true,
          action: "REQUEST_INFO",
          title: "Yêu cầu QLDA bổ sung thông tin",
          description:
            "Chuyển trạng thái sang «Cần bổ sung thông tin» và gửi câu hỏi cho Quản lý dự án.",
          submitLabel: "Gửi yêu cầu bổ sung",
          submitVariant: "secondary",
          requireMessage: true,
          messageLabel: "Nội dung cần QLDA làm rõ (*)",
          messagePlaceholder:
            "Nhập câu hỏi hoặc thông tin cần QLDA cung cấp thêm...",
        });
        break;
      case "PROVIDE_INFO":
        setTransitionDialog({
          open: true,
          action: "PROVIDE_INFO",
          title: "Phản hồi bổ sung thông tin cho Kế toán",
          description:
            "Gửi thông tin giải trình và chuyển yêu cầu trở lại hàng đợi «Đang chờ xử lý» của Kế toán dự án.",
          submitLabel: "Gửi thông tin bổ sung",
          submitVariant: "primary",
          requireMessage: true,
          messageLabel: "Nội dung bổ sung thông tin (*)",
          messagePlaceholder:
            "Nhập thông tin giải trình theo yêu cầu của Kế toán dự án...",
        });
        break;
      case "WITHDRAW":
        setTransitionDialog({
          open: true,
          action: "WITHDRAW",
          title: "Rút yêu cầu ứng lương",
          description:
            "Yêu cầu sẽ chuyển sang trạng thái «Đã rút» và kết thúc luồng xử lý. Bạn chỉ có thể rút trước khi Kế toán ra quyết định.",
          submitLabel: "Xác nhận rút yêu cầu",
          submitVariant: "danger",
          requireMessage: false,
          messageLabel: "Lý do rút yêu cầu (không bắt buộc)",
          messagePlaceholder: "Nhập lý do rút yêu cầu nếu cần...",
        });
        break;
      case "MARK_HANDLED_EXTERNALLY":
        setTransitionDialog({
          open: true,
          action: "MARK_HANDLED_EXTERNALLY",
          title: "Đánh dấu đã xử lý ngoài BI",
          description:
            "Sử dụng khi yêu cầu ứng lương này đã được xử lý thông qua quy trình ngoài hệ thống BI.",
          submitLabel: "Xác nhận đã xử lý ngoài BI",
          submitVariant: "secondary",
          requireMessage: false,
          messageLabel: "Ghi chú xử lý ngoài BI (không bắt buộc)",
          messagePlaceholder:
            "Nhập mã chứng từ hoặc ghi chú quy trình ngoài BI...",
        });
        break;
    }
  };

  const handleSubmitTransitionAction = async () => {
    if (!activeDetail || !transitionDialog) return;
    const targetRequest = activeDetail.request;
    setTransitionError(null);

    const validation = validateTransitionActionInput({
      action: transitionDialog.action,
      messageText: transitionMessageText,
    });

    if (!validation.ok) {
      setTransitionError(validation.message);
      return;
    }

    setTransitionSubmitting(true);
    try {
      const idempotencyKey = transitionIdempotencyKeyRef.current;
      const response = await fetch(
        `/api/salary-advance/requests/${encodeURIComponent(
          targetRequest.request_id
        )}/actions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            action: transitionDialog.action,
            expected_version: targetRequest.version,
            message_text: validation.normalizedMessage,
            idempotency_key: idempotencyKey,
          }),
        }
      );

      const json = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            data?: SalaryAdvanceMutationDetailResponse;
            code?: string;
          }
        | null;

      if (!response.ok || !json?.ok || !json.data) {
        const code = json?.code ?? "SALARY_ADVANCE_UNAVAILABLE";
        if (isSalaryAdvanceConflictError(response.status, code)) {
          transitionIdempotencyKeyRef.current =
            newSalaryAdvanceIdempotencyKey("sa-act");
        }
        const failureOutcome = resolveScopedMutationFailureOutcome({
          targetRequestId: targetRequest.request_id,
          currentSelectedRequestId: selectedRequestIdRef.current,
          status: response.status,
          code,
        });
        if (
          !failureOutcome.shouldUpdateSelectedRequestUi ||
          selectedRequestIdRef.current !== targetRequest.request_id
        ) {
          if (failureOutcome.shouldReloadRequestList) {
            await loadRequests();
          }
          return;
        }
        if (failureOutcome.shouldReloadSelectedDetail) {
          setTransitionDialog(null);
          await handleConflictReload(targetRequest.request_id, code);
          return;
        }
        setTransitionError(failureOutcome.errorMessage);
        return;
      }

      transitionIdempotencyKeyRef.current =
        newSalaryAdvanceIdempotencyKey("sa-act");
      if (selectedRequestIdRef.current === targetRequest.request_id) {
        setTransitionDialog(null);
        setTransitionMessageText("");
      }
      applyMutationDetailResponse(json.data);
      notify.success({
        title: "Đã cập nhật trạng thái yêu cầu",
        description: getRequestStateMeta(json.data.request.request_state).label,
      });
      await loadRequests();
    } catch {
      if (selectedRequestIdRef.current === targetRequest.request_id) {
        setTransitionError(
          salaryAdvanceErrorMessage("SALARY_ADVANCE_UNAVAILABLE")
        );
      }
    } finally {
      setTransitionSubmitting(false);
    }
  };

  const handleEvidenceFileSelection = (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    setEvidenceUploadError(null);
    const chosen = event.target.files?.[0] ?? null;
    if (!chosen) {
      setEvidenceFile(null);
      return;
    }

    const preflight = validateEvidenceFilePreflight(chosen);
    if (!preflight.ok) {
      setEvidenceUploadError(preflight.message);
      setEvidenceFile(null);
      return;
    }

    setEvidenceFile(chosen);
    evidenceReserveKeyRef.current =
      newSalaryAdvanceIdempotencyKey("sa-ev-res");
    evidenceFinalizeKeyRef.current =
      newSalaryAdvanceIdempotencyKey("sa-ev-fin");
  };

  const handleUploadEvidenceSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeDetail || !evidenceFile) {
      setEvidenceUploadError(
        "Vui lòng chọn tệp ảnh NLĐ nhận tiền mặt (JPEG hoặc PNG)."
      );
      return;
    }
    const targetRequest = activeDetail.request;

    setEvidenceUploadError(null);
    setEvidenceUploading(true);

    try {
      const result = await uploadSalaryAdvanceEvidence({
        requestId: targetRequest.request_id,
        expectedVersion: targetRequest.version,
        file: evidenceFile,
        captionNote: evidenceCaptionNote,
        reserveIdempotencyKey: evidenceReserveKeyRef.current,
        finalizeIdempotencyKey: evidenceFinalizeKeyRef.current,
      });

      if (!result.ok) {
        if (isSalaryAdvanceConflictError(result.status, result.code)) {
          evidenceReserveKeyRef.current =
            newSalaryAdvanceIdempotencyKey("sa-ev-res");
          evidenceFinalizeKeyRef.current =
            newSalaryAdvanceIdempotencyKey("sa-ev-fin");
        }
        const failureOutcome = resolveScopedMutationFailureOutcome({
          targetRequestId: targetRequest.request_id,
          currentSelectedRequestId: selectedRequestIdRef.current,
          status: result.status,
          code: result.code,
          fallbackMessage: result.message,
        });
        if (
          !failureOutcome.shouldUpdateSelectedRequestUi ||
          selectedRequestIdRef.current !== targetRequest.request_id
        ) {
          if (failureOutcome.shouldReloadRequestList) {
            await loadRequests();
          }
          return;
        }
        if (failureOutcome.shouldReloadSelectedDetail) {
          await handleConflictReload(targetRequest.request_id, result.code);
          return;
        }
        setEvidenceUploadError(failureOutcome.errorMessage);
        return;
      }

      evidenceReserveKeyRef.current =
        newSalaryAdvanceIdempotencyKey("sa-ev-res");
      evidenceFinalizeKeyRef.current =
        newSalaryAdvanceIdempotencyKey("sa-ev-fin");
      if (selectedRequestIdRef.current === targetRequest.request_id) {
        setEvidenceFile(null);
        setEvidenceCaptionNote("");
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }

      applyMutationDetailResponse(result.data);
      notify.success({
        title: "Đã tải lên ảnh nhận tiền mặt",
        description:
          "Ảnh NLĐ nhận tiền mặt đã được lưu và chuyển sang trạng thái chờ Kế toán đối chiếu.",
      });
      await loadRequests();
    } catch {
      if (selectedRequestIdRef.current === targetRequest.request_id) {
        setEvidenceUploadError(
          salaryAdvanceErrorMessage("SALARY_ADVANCE_UNAVAILABLE")
        );
      }
    } finally {
      setEvidenceUploading(false);
    }
  };

  const comparisonModel = activeDetail
    ? evaluateEvidenceComparisonPanel(activeDetail, selectedEvidenceVersion)
    : null;

  const availableActions = resolveAvailableRequestActions(
    activeDetail?.request.allowed_actions
  );

  const chronologicalEvents = activeDetail
    ? sortEventsChronologically(activeDetail.events)
    : [];

  const handleSubmitEvidenceReview = async (
    decision: SalaryAdvanceEvidenceReviewDecision
  ) => {
    if (!activeDetail || !comparisonModel?.selectedEvidence) return;
    const targetRequest = activeDetail.request;
    const targetEvidenceVersion =
      comparisonModel.selectedEvidence.evidenceVersion;
    setEvidenceReviewError(null);

    const validation = validateEvidenceReviewInput({
      decision,
      note: evidenceReviewNote,
      workerPortrait: comparisonModel.workerPortrait
        ? {
            documentId: comparisonModel.workerPortrait.documentId,
            version: comparisonModel.workerPortrait.version,
          }
        : null,
    });

    if (!validation.ok) {
      setEvidenceReviewError(validation.message);
      return;
    }

    setEvidenceReviewSubmitting(true);
    try {
      const idempotencyKey = evidenceReviewKeyRef.current;
      const response = await fetch(
        `/api/salary-advance/requests/${encodeURIComponent(
          targetRequest.request_id
        )}/evidence/review`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            expected_version: targetRequest.version,
            evidence_version: targetEvidenceVersion,
            decision,
            expected_worker_portrait_document_id:
              validation.expectedWorkerPortraitDocumentId,
            expected_worker_portrait_version:
              validation.expectedWorkerPortraitVersion,
            note: validation.normalizedNote,
            idempotency_key: idempotencyKey,
          }),
        }
      );

      const json = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            data?: SalaryAdvanceMutationDetailResponse;
            code?: string;
          }
        | null;

      if (!response.ok || !json?.ok || !json.data) {
        const code = json?.code ?? "SALARY_ADVANCE_UNAVAILABLE";
        if (isSalaryAdvanceConflictError(response.status, code)) {
          evidenceReviewKeyRef.current =
            newSalaryAdvanceIdempotencyKey("sa-ev-rev");
        }
        const failureOutcome = resolveScopedMutationFailureOutcome({
          targetRequestId: targetRequest.request_id,
          currentSelectedRequestId: selectedRequestIdRef.current,
          status: response.status,
          code,
        });
        if (
          !failureOutcome.shouldUpdateSelectedRequestUi ||
          selectedRequestIdRef.current !== targetRequest.request_id
        ) {
          if (failureOutcome.shouldReloadRequestList) {
            await loadRequests();
          }
          return;
        }
        if (failureOutcome.shouldReloadSelectedDetail) {
          await handleConflictReload(targetRequest.request_id, code);
          return;
        }
        setEvidenceReviewError(failureOutcome.errorMessage);
        return;
      }

      evidenceReviewKeyRef.current =
        newSalaryAdvanceIdempotencyKey("sa-ev-rev");
      if (selectedRequestIdRef.current === targetRequest.request_id) {
        setEvidenceReviewNote("");
      }
      applyMutationDetailResponse(json.data);
      notify.success({
        title:
          decision === "REVIEWED"
            ? "Đã xác nhận đối chiếu ảnh nhận tiền"
            : "Đã yêu cầu QLDA chụp/gửi lại ảnh",
        description: getEvidenceReviewStateMeta(
          json.data.request.evidence_review_state
        ).label,
      });
      await loadRequests();
    } catch {
      if (selectedRequestIdRef.current === targetRequest.request_id) {
        setEvidenceReviewError(
          salaryAdvanceErrorMessage("SALARY_ADVANCE_UNAVAILABLE")
        );
      }
    } finally {
      setEvidenceReviewSubmitting(false);
    }
  };

  const previewFormattedCreateAmount = useMemo(() => {
    const normalized = normalizePositiveVndInput(createAmountRaw);
    return normalized ? formatVndAmount(normalized) : null;
  }, [createAmountRaw]);

  if (contextLoading) {
    return (
      <PageShell>
        <PageHeader
          title="Ứng lương"
          description="Đang tải thông tin phân quyền và dự án..."
        />
        <Card>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Đang đồng bộ phạm vi dự án QLDA / Kế toán dự án từ máy chủ...
          </p>
        </Card>
      </PageShell>
    );
  }

  if (contextError && contextErrorCode !== "SALARY_ADVANCE_ACCESS_DENIED") {
    return (
      <PageShell>
        <PageHeader
          title="Ứng lương"
          description="Trao đổi, phê duyệt nội bộ và đối chiếu ảnh NLĐ nhận tiền mặt"
        />
        <ErrorState
          title="Không thể tải ngữ cảnh phân hệ Ứng lương"
          detail={contextError}
        />
        <div>
          <Button variant="primary" onClick={() => void loadContext()}>
            Thử lại
          </Button>
        </div>
      </PageShell>
    );
  }

  if (
    contextErrorCode === "SALARY_ADVANCE_ACCESS_DENIED" ||
    !canAccessSalaryAdvanceContext(context)
  ) {
    return (
      <PageShell>
        <PageHeader
          title="Ứng lương"
          description="Trao đổi, phê duyệt nội bộ và đối chiếu ảnh NLĐ nhận tiền mặt"
        />
        <div data-testid="salary-advance-access-denied">
          <Card>
            <EmptyState
              title="Chưa được phân công dự án trong phân hệ Ứng lương"
              description="Tài khoản của bạn hiện chưa được gán vai trò Quản lý dự án (QLDA), Kế toán dự án hoặc quyền Giám sát toàn miền. Nếu bạn cần sử dụng phân hệ Ứng lương, vui lòng liên hệ Admin để được phân công dự án."
            />
          </Card>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="Ứng lương"
        description="Luồng trao đổi, phê duyệt đề nghị ứng lương và đối chiếu ảnh NLĐ nhận tiền mặt giữa QLDA và Kế toán dự án"
        actions={
          context?.is_project_manager ? (
            <Button
              variant="primary"
              onClick={handleOpenCreateDialog}
              data-testid="salary-advance-open-create-btn"
            >
              + Tạo yêu cầu ứng lương
            </Button>
          ) : null
        }
      />

      <StatusBanner tone="info" title="Lưu ý nghiệp vụ">
        {SALARY_ADVANCE_NON_ACCOUNTING_NOTICE}
      </StatusBanner>

      {/* Capability Tabs: "Yêu cầu tôi tạo" (PM) / "Cần xử lý" (Accountant) / "Giám sát toàn miền" */}
      <div
        className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-3"
        role="tablist"
        aria-label="Khu vực làm việc Ứng lương"
      >
        {visibleTabs.map((tab) => {
          const isSelected = currentTabConfig?.id === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              data-testid={`salary-advance-tab-${tab.id}`}
              onClick={() => handleTabChange(tab.id)}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium border ${
                isSelected
                  ? "border-[var(--color-primary-border)] bg-[var(--color-primary-bg)] text-[var(--color-primary)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]"
              }`}
            >
              <span>{tab.label}</span>
              {tab.badgeCount > 0 ? (
                <StatusBadge tone={tab.id === "accountant" ? "warning" : "info"}>
                  {tab.badgeCount}
                </StatusBadge>
              ) : null}
            </button>
          );
        })}
      </div>

      {currentTabConfig ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-secondary)]">
          <span>{currentTabConfig.description}</span>
          <span>
            Người dùng: <strong>{context?.display_name}</strong> · Ngày hiệu
            lực: <strong>{context?.authorization_date}</strong>
          </span>
        </div>
      ) : null}

      {/* Filter Toolbar */}
      <FilterToolbar
        dataTestId="salary-advance-filter-toolbar"
        actions={
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="secondary"
              size="sm"
              className="md:h-9 md:min-h-9 px-3 text-sm whitespace-nowrap shrink-0"
              onClick={() => {
                setAppliedSearch(searchInput);
              }}
              data-testid="salary-advance-apply-search-btn"
            >
              Tìm kiếm
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="md:h-9 md:min-h-9 px-3 text-sm whitespace-nowrap shrink-0"
              onClick={() => {
                void loadRequests();
                if (selectedRequestId) {
                  void loadRequestDetail(selectedRequestId);
                }
              }}
              data-testid="salary-advance-refresh-btn"
            >
              Làm mới
            </Button>
          </div>
        }
      >
        <div
          data-testid="salary-advance-filter-grid"
          className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)_minmax(0,0.95fr)_minmax(0,1.65fr)] lg:items-end"
        >
          <div className="flex flex-col gap-1 min-w-0">
            <label
              htmlFor="salary-advance-project-filter"
              className="truncate text-xs font-medium text-[var(--color-text-secondary)]"
            >
              Dự án
            </label>
            <select
              id="salary-advance-project-filter"
              data-testid="salary-advance-project-filter"
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
              className="h-9 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-text-primary)]"
            >
              <option value="ALL">Tất cả dự án</option>
              {availableProjectsForCurrentTab.map((project) => (
                <option key={project.project_id} value={project.project_id}>
                  {project.display_name}
                  {!project.active ? " (Ngưng HĐ)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1 min-w-0">
            <label
              htmlFor="salary-advance-state-filter"
              className="truncate text-xs font-medium text-[var(--color-text-secondary)]"
            >
              Trạng thái yêu cầu
            </label>
            <select
              id="salary-advance-state-filter"
              data-testid="salary-advance-state-filter"
              value={requestStateFilter}
              onChange={(event) =>
                setRequestStateFilter(
                  event.target.value as "ALL" | SalaryAdvanceRequestState
                )
              }
              className="h-9 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-text-primary)]"
            >
              {REQUEST_STATE_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1 min-w-0">
            <label
              htmlFor="salary-advance-evidence-filter"
              className="truncate text-xs font-medium text-[var(--color-text-secondary)]"
            >
              Trạng thái đối chiếu ảnh
            </label>
            <select
              id="salary-advance-evidence-filter"
              data-testid="salary-advance-evidence-filter"
              value={evidenceStateFilter}
              onChange={(event) =>
                setEvidenceStateFilter(
                  event.target.value as "ALL" | SalaryAdvanceEvidenceReviewState
                )
              }
              className="h-9 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-text-primary)]"
            >
              {EVIDENCE_STATE_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1 min-w-0">
            <label
              htmlFor="salary-advance-search-input"
              className="truncate text-xs font-medium text-[var(--color-text-secondary)]"
            >
              Tìm NLĐ
            </label>
            <input
              id="salary-advance-search-input"
              data-testid="salary-advance-search-input"
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  setAppliedSearch(searchInput);
                }
              }}
              placeholder="Mã NV hoặc tên NLĐ"
              className="h-9 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)]"
            />
          </div>
        </div>
      </FilterToolbar>

      {/* Main Split Workspace: Request Queue Table + Detail & Photo Comparison Panel */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left / Top: Queue List */}
        <div className="xl:col-span-5 flex flex-col gap-4">
          <Card className="p-0 overflow-hidden">
            <div className="p-4 border-b border-[var(--color-border)]">
              <CardHeader
                title={
                  currentTabConfig?.id === "pm"
                    ? "Danh sách Yêu cầu tôi tạo"
                    : currentTabConfig?.id === "accountant"
                      ? "Hàng đợi Cần xử lý (Kế toán dự án)"
                      : "Danh sách Giám sát toàn miền"
                }
                description={`Hiển thị ${requests.length} yêu cầu`}
              />
            </div>

            {requestsLoading ? (
              <div className="p-6 text-sm text-[var(--color-text-secondary)]">
                Đang tải danh sách yêu cầu ứng lương...
              </div>
            ) : requestsError ? (
              <div className="p-4 space-y-3">
                <ErrorState
                  title="Không thể tải danh sách yêu cầu"
                  detail={requestsError}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void loadRequests()}
                >
                  Thử lại
                </Button>
              </div>
            ) : requests.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title="Chưa có yêu cầu ứng lương phù hợp"
                  description={
                    currentTabConfig?.id === "pm"
                      ? "Bạn có thể nhấn «+ Tạo yêu cầu ứng lương» để gửi đề nghị ứng lương mới cho người lao động trong dự án."
                      : "Hiện không có yêu cầu ứng lương nào khớp với bộ lọc đang chọn."
                  }
                />
              </div>
            ) : (
              <>
                <DataTableContainer>
                  <table
                    className="w-full text-left border-collapse r22-card-table"
                    data-testid="salary-advance-requests-table"
                  >
                    <thead>
                      <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-subtle)] text-xs font-semibold text-[var(--color-text-secondary)]">
                        <th className="py-2.5 px-3">Người lao động / Dự án</th>
                        <th className="py-2.5 px-3">Số tiền ứng</th>
                        <th className="py-2.5 px-3">Trạng thái</th>
                        <th className="py-2.5 px-3">Cập nhật</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--color-border)] text-sm">
                      {requests.map((item) => {
                        const isSelected =
                          item.request_id === selectedRequestId;
                        const reqMeta = getRequestStateMeta(item.request_state);
                        const evMeta = getEvidenceReviewStateMeta(
                          item.evidence_review_state
                        );
                        const attention = evaluateRequestAttentionForTab(
                          item,
                          currentTabConfig?.id ?? "pm"
                        );

                        return (
                          <tr
                            key={item.request_id}
                            data-testid={`salary-advance-row-${item.request_id}`}
                            onClick={() => selectRequest(item.request_id)}
                            className={`cursor-pointer ${
                              isSelected
                                ? "bg-[var(--color-primary-bg)]"
                                : "hover:bg-[var(--color-surface-subtle)]"
                            }`}
                          >
                            <td
                              data-label="NLĐ / Dự án"
                              className="py-3 px-3 align-top"
                            >
                              <div className="font-semibold text-[var(--color-text-primary)]">
                                {item.worker_display_name}
                              </div>
                              <div className="text-xs text-[var(--color-text-secondary)]">
                                Mã NV: {item.worker_employee_code} ·{" "}
                                {item.project_display_name}
                              </div>
                              {attention.needsAttention && attention.label ? (
                                <div className="mt-1">
                                  <StatusBadge tone={attention.tone} dot>
                                    {attention.label}
                                  </StatusBadge>
                                </div>
                              ) : null}
                            </td>

                            <td
                              data-label="Số tiền ứng"
                              className="py-3 px-3 align-top font-semibold text-[var(--color-text-primary)] whitespace-nowrap"
                            >
                              {formatVndAmount(item.requested_amount_vnd)}
                            </td>

                            <td
                              data-label="Trạng thái"
                              className="py-3 px-3 align-top"
                            >
                              <div className="flex flex-col items-start gap-1">
                                <StatusBadge tone={reqMeta.tone}>
                                  {reqMeta.shortLabel}
                                </StatusBadge>
                                <StatusBadge tone={evMeta.tone}>
                                  {evMeta.shortLabel}
                                </StatusBadge>
                              </div>
                            </td>

                            <td
                              data-label="Cập nhật"
                              className="py-3 px-3 align-top text-xs text-[var(--color-text-secondary)]"
                            >
                              <div>
                                {formatDateTimeVi(item.last_activity_at)}
                              </div>
                              <div className="mt-1">
                                <Button
                                  variant={isSelected ? "primary" : "ghost"}
                                  size="sm"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    selectRequest(item.request_id);
                                  }}
                                >
                                  Chi tiết
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </DataTableContainer>

                <div className="p-3 border-t border-[var(--color-border)]">
                  <CursorLoadMore
                    hasMore={requestsHasMore}
                    loading={requestsLoadingMore}
                    onLoadMore={() =>
                      void loadRequests({
                        cursor: requestsNextCursor,
                        append: true,
                      })
                    }
                    label="Tải thêm yêu cầu ứng lương"
                  />
                </div>
              </>
            )}
          </Card>
        </div>

        {/* Right / Bottom: Detail, Action Bar, Side-by-Side Photo Comparison, & Timeline */}
        <div className="xl:col-span-7 flex flex-col gap-5">
          {!selectedRequestId ? (
            <Card>
              <EmptyState
                title="Chọn một yêu cầu ứng lương để xem chi tiết"
                description="Nhấn vào một dòng yêu cầu bên trái để xem toàn bộ lịch sử trao đổi, thực hiện phê duyệt hoặc đối chiếu ảnh nhận tiền mặt."
              />
            </Card>
          ) : detailLoading && !activeDetail ? (
            <Card>
              <p className="text-sm text-[var(--color-text-secondary)]">
                Đang tải chi tiết yêu cầu ứng lương và lịch sử đối chiếu...
              </p>
            </Card>
          ) : detailError && !activeDetail ? (
            <div className="space-y-3">
              <ErrorState
                title="Không thể tải chi tiết yêu cầu ứng lương"
                detail={detailError}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void loadRequestDetail(selectedRequestId)}
              >
                Thử lại
              </Button>
            </div>
          ) : activeDetail ? (
            <>
              {conflictBannerMessage ? (
                <div data-testid="salary-advance-conflict-banner">
                  <StatusBanner
                    tone="warning"
                    title="Dữ liệu vừa được làm mới tự động do xung đột phiên bản (409)"
                  >
                    {conflictBannerMessage}
                  </StatusBanner>
                </div>
              ) : null}

              {/* Request Summary & Allowed Actions Card */}
              <div data-testid="salary-advance-detail-card">
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <CardHeader
                      title={`${activeDetail.request.worker_display_name} (${activeDetail.request.worker_employee_code})`}
                      description={`Dự án: ${activeDetail.request.project_display_name} · Phiên bản dữ liệu v${activeDetail.request.version}`}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge
                        tone={
                          getRequestStateMeta(
                            activeDetail.request.request_state
                          ).tone
                        }
                      >
                        {
                          getRequestStateMeta(
                            activeDetail.request.request_state
                          ).label
                        }
                      </StatusBadge>
                      <StatusBadge
                        tone={
                          getEvidenceReviewStateMeta(
                            activeDetail.request.evidence_review_state
                          ).tone
                        }
                      >
                        {
                          getEvidenceReviewStateMeta(
                            activeDetail.request.evidence_review_state
                          ).label
                        }
                      </StatusBadge>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 rounded-lg bg-[var(--color-surface-subtle)] p-3.5 text-sm">
                    <div>
                      <div className="text-xs text-[var(--color-text-secondary)]">
                        Số tiền đề nghị ứng
                      </div>
                      <div
                        className="text-base font-bold text-[var(--color-primary)]"
                        data-testid="salary-advance-detail-amount"
                      >
                        {formatVndAmount(
                          activeDetail.request.requested_amount_vnd
                        )}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-[var(--color-text-secondary)]">
                        QLDA tạo yêu cầu
                      </div>
                      <div className="font-medium text-[var(--color-text-primary)]">
                        {activeDetail.request.created_by_display_name ||
                          activeDetail.request.created_by_user_id}
                      </div>
                      <div className="text-xs text-[var(--color-text-secondary)]">
                        {formatDateTimeVi(activeDetail.request.created_at)}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-[var(--color-text-secondary)]">
                        Kế toán dự án phụ trách
                      </div>
                      <div className="font-medium text-[var(--color-text-primary)]">
                        {activeDetail.request.current_project_accountant
                          ?.display_name ?? "Chưa phân công"}
                      </div>
                      <div className="text-xs text-[var(--color-text-secondary)]">
                        Cập nhật:{" "}
                        {formatDateTimeVi(
                          activeDetail.request.last_activity_at
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 rounded-lg border border-[var(--color-border)] p-3.5">
                    <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
                      Nội dung đề nghị ban đầu của QLDA
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-text-primary)]">
                      {activeDetail.request.initial_content}
                    </p>
                  </div>

                  {/* Decision / Rejection / Withdrawal / External Handling Summary */}
                  {activeDetail.request.decision_note ? (
                    <div className="mt-3">
                      <StatusBanner
                        tone={
                          activeDetail.request.request_state === "REJECTED"
                            ? "error"
                            : "info"
                        }
                        title={
                          activeDetail.request.request_state === "REJECTED"
                            ? "Lý do từ chối của Kế toán dự án"
                            : "Ghi chú quyết định của Kế toán dự án"
                        }
                      >
                        {activeDetail.request.decision_note}
                      </StatusBanner>
                    </div>
                  ) : null}

                  {activeDetail.request.handled_externally_note ? (
                    <div className="mt-3">
                      <StatusBanner
                        tone="info"
                        title="Ghi chú xử lý ngoài hệ thống BI"
                      >
                        {activeDetail.request.handled_externally_note}
                      </StatusBanner>
                    </div>
                  ) : null}

                  {/* Action Bar driven strictly by server-returned allowed_actions */}
                  <div
                    className="mt-4 pt-4 border-t border-[var(--color-border)] flex flex-wrap items-center gap-2"
                    data-testid="salary-advance-action-bar"
                  >
                    {availableActions.canApprove ? (
                      <Button
                        variant="primary"
                        size="sm"
                        data-testid="salary-advance-action-approve"
                        onClick={() => openTransitionActionDialog("APPROVE")}
                      >
                        Chấp thuận ứng lương
                      </Button>
                    ) : null}

                    {availableActions.canRequestInfo ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        data-testid="salary-advance-action-request-info"
                        onClick={() =>
                          openTransitionActionDialog("REQUEST_INFO")
                        }
                      >
                        Yêu cầu bổ sung thông tin
                      </Button>
                    ) : null}

                    {availableActions.canReject ? (
                      <Button
                        variant="danger"
                        size="sm"
                        data-testid="salary-advance-action-reject"
                        onClick={() => openTransitionActionDialog("REJECT")}
                      >
                        Từ chối
                      </Button>
                    ) : null}

                    {availableActions.canMarkHandledExternally ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        data-testid="salary-advance-action-handled-externally"
                        onClick={() =>
                          openTransitionActionDialog("MARK_HANDLED_EXTERNALLY")
                        }
                      >
                        Đánh dấu đã xử lý ngoài BI
                      </Button>
                    ) : null}

                    {availableActions.canProvideInfo ? (
                      <Button
                        variant="primary"
                        size="sm"
                        data-testid="salary-advance-action-provide-info"
                        onClick={() =>
                          openTransitionActionDialog("PROVIDE_INFO")
                        }
                      >
                        Bổ sung thông tin cho Kế toán
                      </Button>
                    ) : null}

                    {availableActions.canWithdraw ? (
                      <Button
                        variant="danger"
                        size="sm"
                        data-testid="salary-advance-action-withdraw"
                        onClick={() => openTransitionActionDialog("WITHDRAW")}
                      >
                        Rút yêu cầu
                      </Button>
                    ) : null}

                    {!availableActions.hasAnyMutation ? (
                      <span className="text-xs text-[var(--color-text-secondary)]">
                        Chế độ chỉ xem — không có thao tác cập nhật khả dụng ở
                        trạng thái hiện tại.
                      </span>
                    ) : null}
                  </div>
                </Card>
              </div>

              {/* Side-by-Side Photo Comparison Panel: "Đối chiếu ảnh nhận tiền" */}
              {comparisonModel ? (
                <div data-testid="salary-advance-photo-comparison-panel">
                  <Card>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <CardHeader
                        title="Đối chiếu ảnh nhận tiền"
                        description="Đặt cạnh nhau ảnh chân dung hồ sơ NLĐ trong hệ thống và ảnh NLĐ nhận tiền mặt do QLDA tải lên"
                      />
                      {comparisonModel.evidenceVersions.length > 0 ? (
                        <div className="flex items-center gap-2">
                          <label
                            htmlFor="salary-advance-evidence-version-select"
                            className="text-xs text-[var(--color-text-secondary)]"
                          >
                            Phiên bản ảnh nhận tiền:
                          </label>
                          <select
                            id="salary-advance-evidence-version-select"
                            data-testid="salary-advance-evidence-version-select"
                            value={
                              comparisonModel.selectedEvidence
                                ?.evidenceVersion ?? ""
                            }
                            onChange={(event) => {
                              setSelectedEvidenceVersion(
                                Number(event.target.value)
                              );
                              setEvidenceImgError(false);
                            }}
                            className="h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs text-[var(--color-text-primary)]"
                          >
                            {comparisonModel.evidenceVersions.map((ver) => (
                              <option
                                key={ver.evidenceVersion}
                                value={ver.evidenceVersion}
                              >
                                Phiên bản #{ver.evidenceVersion}
                                {ver.isCurrent ? " (Hiện hành)" : " (Lịch sử)"}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : null}
                    </div>

                    {/* Warning if worker portrait is missing */}
                    {comparisonModel.missingPortraitWarning ? (
                      <div
                        className="mt-3"
                        data-testid="salary-advance-missing-portrait-warning"
                      >
                        <StatusBanner
                          tone="warning"
                          title="Thiếu ảnh hồ sơ chuẩn của người lao động — Khóa xác nhận «Đã đối chiếu»"
                        >
                          {comparisonModel.missingPortraitWarning}
                        </StatusBanner>
                      </div>
                    ) : null}

                    {/* Side-by-Side Grid on wide screens, stacked vertically on narrow screens */}
                    <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {/* Column 1: System Worker Portrait */}
                      <div
                        className="flex flex-col justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-3.5"
                        data-testid="salary-advance-worker-portrait-card"
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
                              1. Ảnh chân dung hồ sơ NLĐ
                            </span>
                            {comparisonModel.workerPortrait ? (
                              <StatusBadge tone="info">
                                Hồ sơ v{comparisonModel.workerPortrait.version}
                              </StatusBadge>
                            ) : (
                              <StatusBadge tone="warning">
                                Chưa có ảnh hồ sơ
                              </StatusBadge>
                            )}
                          </div>

                          {comparisonModel.workerPortrait ? (
                            <>
                              <div className="mt-1 text-xs text-[var(--color-text-secondary)]">
                                Nguồn:{" "}
                                <strong>
                                  {comparisonModel.workerPortrait.sourceLabel}
                                </strong>
                              </div>
                              <div className="text-xs text-[var(--color-text-secondary)]">
                                Định dạng:{" "}
                                {comparisonModel.workerPortrait.mimeType} ·{" "}
                                {formatFileSizeBytes(
                                  comparisonModel.workerPortrait.sizeBytes
                                )}
                              </div>

                              <div className="mt-3 flex min-h-[240px] items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
                                {!portraitImgError ? (
                                  <img
                                    src={
                                      comparisonModel.workerPortrait.previewUrl
                                    }
                                    alt={`Ảnh hồ sơ NLĐ ${comparisonModel.workerDisplayName}`}
                                    data-testid="salary-advance-worker-portrait-img"
                                    className="max-h-[320px] w-auto object-contain rounded"
                                    onError={() => setPortraitImgError(true)}
                                  />
                                ) : (
                                  <div className="p-4 text-center text-xs text-[var(--color-text-secondary)]">
                                    <p>Không tải được ảnh hồ sơ NLĐ.</p>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="mt-2"
                                      onClick={() => setPortraitImgError(false)}
                                    >
                                      Tải lại ảnh hồ sơ
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </>
                          ) : (
                            <div className="mt-3 flex min-h-[240px] flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-center">
                              <p className="text-sm font-medium text-[var(--color-text-primary)]">
                                Chưa có ảnh chân dung chuẩn trong hồ sơ NLĐ
                              </p>
                              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                                Vui lòng cập nhật ảnh chân dung của NLĐ{" "}
                                <strong>
                                  {comparisonModel.workerDisplayName} (
                                  {comparisonModel.workerEmployeeCode})
                                </strong>{" "}
                                trước khi Kế toán xác nhận «Đã đối chiếu».
                              </p>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Column 2: Cash-Handover Evidence Photo */}
                      <div
                        className="flex flex-col justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-3.5"
                        data-testid="salary-advance-evidence-photo-card"
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
                              2. Ảnh NLĐ nhận tiền mặt
                            </span>
                            {comparisonModel.selectedEvidence ? (
                              <div className="flex items-center gap-1.5">
                                <StatusBadge tone="primary">
                                  Phiên bản #
                                  {
                                    comparisonModel.selectedEvidence
                                      .evidenceVersion
                                  }
                                </StatusBadge>
                                <StatusBadge
                                  tone={
                                    getEvidenceReviewStateMeta(
                                      comparisonModel.selectedEvidence
                                        .reviewState
                                    ).tone
                                  }
                                >
                                  {
                                    getEvidenceReviewStateMeta(
                                      comparisonModel.selectedEvidence
                                        .reviewState
                                    ).shortLabel
                                  }
                                </StatusBadge>
                              </div>
                            ) : (
                              <StatusBadge tone="neutral">
                                Chưa tải ảnh
                              </StatusBadge>
                            )}
                          </div>

                          {comparisonModel.selectedEvidence ? (
                            <>
                              <div className="mt-1 text-xs text-[var(--color-text-secondary)]">
                                Nguồn:{" "}
                                <strong>
                                  {comparisonModel.selectedEvidence.sourceLabel}
                                </strong>
                              </div>
                              <div className="text-xs text-[var(--color-text-secondary)]">
                                Người tải lên:{" "}
                                <strong>
                                  {comparisonModel.selectedEvidence
                                    .uploadedByDisplayName ??
                                    comparisonModel.selectedEvidence
                                      .uploadedByUserId}
                                </strong>{" "}
                                · Lúc:{" "}
                                {formatDateTimeVi(
                                  comparisonModel.selectedEvidence.uploadedAt
                                )}
                              </div>
                              {comparisonModel.selectedEvidence.captionNote ? (
                                <div className="mt-1 rounded bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-text-primary)]">
                                  Ghi chú QLDA:{" "}
                                  {comparisonModel.selectedEvidence.captionNote}
                                </div>
                              ) : null}

                              {comparisonModel.selectedEvidence.reviewedAt ? (
                                <div className="mt-1 rounded bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]">
                                  Đối chiếu bởi:{" "}
                                  <strong>
                                    {comparisonModel.selectedEvidence
                                      .reviewedByDisplayName ??
                                      comparisonModel.selectedEvidence
                                        .reviewedByUserId}
                                  </strong>{" "}
                                  ({formatDateTimeVi(
                                    comparisonModel.selectedEvidence.reviewedAt
                                  )})
                                  {comparisonModel.selectedEvidence.reviewNote
                                    ? ` — Ghi chú: ${comparisonModel.selectedEvidence.reviewNote}`
                                    : ""}
                                </div>
                              ) : null}

                              <div className="mt-3 flex min-h-[240px] items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
                                {!evidenceImgError ? (
                                  <img
                                    src={
                                      comparisonModel.selectedEvidence
                                        .previewUrl
                                    }
                                    alt={`Ảnh nhận tiền mặt phiên bản #${comparisonModel.selectedEvidence.evidenceVersion}`}
                                    data-testid="salary-advance-evidence-photo-img"
                                    className="max-h-[320px] w-auto object-contain rounded"
                                    onError={() => setEvidenceImgError(true)}
                                  />
                                ) : (
                                  <div className="p-4 text-center text-xs text-[var(--color-text-secondary)]">
                                    <p>Không tải được ảnh nhận tiền mặt.</p>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="mt-2"
                                      onClick={() => setEvidenceImgError(false)}
                                    >
                                      Tải lại ảnh nhận tiền
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </>
                          ) : (
                            <div className="mt-3 flex min-h-[240px] flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-center">
                              <p className="text-sm font-medium text-[var(--color-text-primary)]">
                                Chưa có ảnh NLĐ nhận tiền mặt
                              </p>
                              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                                Sau khi yêu cầu được chấp thuận và chi tiền mặt,
                                QLDA tải ảnh NLĐ nhận tiền tại đây để Kế toán
                                đối chiếu.
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* QLDA Upload Evidence Section (strictly gated by allowed_actions.can_upload_evidence) */}
                    {comparisonModel.canUploadEvidence ? (
                      <form
                        onSubmit={(event) =>
                          void handleUploadEvidenceSubmit(event)
                        }
                        className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
                        data-testid="salary-advance-evidence-upload-form"
                      >
                        <div className="text-sm font-semibold text-[var(--color-text-primary)]">
                          Tải lên ảnh NLĐ nhận tiền mặt (QLDA)
                        </div>
                        <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                          Chỉ chấp nhận tệp JPEG hoặc PNG, tối đa 10 MB. Ảnh sẽ
                          được lưu thành phiên bản mới để Kế toán đối chiếu.
                        </p>

                        {evidenceUploadError ? (
                          <div className="mt-2">
                            <StatusBanner tone="error">
                              {evidenceUploadError}
                            </StatusBanner>
                          </div>
                        ) : null}

                        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="flex flex-col gap-1">
                            <label
                              htmlFor="salary-advance-evidence-file-input"
                              className="text-xs font-medium text-[var(--color-text-secondary)]"
                            >
                              Chọn tệp ảnh (JPEG / PNG) (*)
                            </label>
                            <input
                              ref={fileInputRef}
                              id="salary-advance-evidence-file-input"
                              data-testid="salary-advance-evidence-file-input"
                              type="file"
                              accept="image/jpeg,image/png"
                              onChange={handleEvidenceFileSelection}
                              disabled={evidenceUploading}
                              className="text-xs text-[var(--color-text-primary)]"
                            />
                          </div>

                          <div className="flex flex-col gap-1">
                            <label
                              htmlFor="salary-advance-evidence-caption-input"
                              className="text-xs font-medium text-[var(--color-text-secondary)]"
                            >
                              Ghi chú ảnh nhận tiền (không bắt buộc)
                            </label>
                            <input
                              id="salary-advance-evidence-caption-input"
                              data-testid="salary-advance-evidence-caption-input"
                              type="text"
                              value={evidenceCaptionNote}
                              onChange={(event) =>
                                setEvidenceCaptionNote(event.target.value)
                              }
                              placeholder="VD: Đã trao tiền mặt tại công trường..."
                              disabled={evidenceUploading}
                              className="h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)]"
                            />
                          </div>
                        </div>

                        <div className="mt-3 flex justify-end">
                          <Button
                            type="submit"
                            variant="primary"
                            size="sm"
                            loading={evidenceUploading}
                            disabled={!evidenceFile || evidenceUploading}
                            data-testid="salary-advance-upload-evidence-btn"
                          >
                            Tải ảnh nhận tiền lên
                          </Button>
                        </div>
                      </form>
                    ) : null}

                    {/* Accountant Review Evidence Section (strictly gated by allowed_actions.can_review_evidence) */}
                    {comparisonModel.canReviewEvidence ? (
                      <div
                        className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
                        data-testid="salary-advance-evidence-review-panel"
                      >
                        <div className="text-sm font-semibold text-[var(--color-text-primary)]">
                          Kết luận đối chiếu ảnh của Kế toán dự án
                        </div>

                        {comparisonModel.confirmReviewedLockReason ? (
                          <div className="mt-2">
                            <StatusBanner tone="warning">
                              {comparisonModel.confirmReviewedLockReason}
                            </StatusBanner>
                          </div>
                        ) : null}

                        {evidenceReviewError ? (
                          <div className="mt-2">
                            <StatusBanner tone="error">
                              {evidenceReviewError}
                            </StatusBanner>
                          </div>
                        ) : null}

                        <div className="mt-3 flex flex-col gap-1">
                          <label
                            htmlFor="salary-advance-evidence-review-note"
                            className="text-xs font-medium text-[var(--color-text-secondary)]"
                          >
                            Ghi chú đối chiếu hoặc lý do yêu cầu chụp lại ảnh
                          </label>
                          <textarea
                            id="salary-advance-evidence-review-note"
                            data-testid="salary-advance-evidence-review-note"
                            rows={2}
                            value={evidenceReviewNote}
                            onChange={(event) =>
                              setEvidenceReviewNote(event.target.value)
                            }
                            disabled={evidenceReviewSubmitting}
                            placeholder="Nhập nhận xét đối chiếu ảnh hoặc hướng dẫn QLDA chụp lại..."
                            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-sm text-[var(--color-text-primary)]"
                          />
                        </div>

                        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                          <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            loading={evidenceReviewSubmitting}
                            disabled={
                              !comparisonModel.canRequestRetake ||
                              evidenceReviewSubmitting
                            }
                            data-testid="salary-advance-request-retake-btn"
                            onClick={() =>
                              void handleSubmitEvidenceReview("RETAKE_REQUIRED")
                            }
                          >
                            Yêu cầu chụp/gửi lại ảnh
                          </Button>
                          <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            loading={evidenceReviewSubmitting}
                            disabled={
                              !comparisonModel.canConfirmReviewed ||
                              evidenceReviewSubmitting
                            }
                            data-testid="salary-advance-confirm-reviewed-btn"
                            onClick={() =>
                              void handleSubmitEvidenceReview("REVIEWED")
                            }
                          >
                            Đã đối chiếu ảnh hợp lệ
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </Card>
                </div>
              ) : null}

              {/* Message Exchange & Chronological Event Timeline */}
              <div data-testid="salary-advance-timeline-card">
                <Card>
                  <CardHeader
                    title="Lịch sử trao đổi & Dòng thời gian sự kiện"
                    description="Ghi nhận đầy đủ theo thứ tự thời gian từ lúc tạo yêu cầu đến khi hoàn tất đối chiếu"
                  />

                  {availableActions.canPostMessage ? (
                    <form
                      onSubmit={(event) => void handleSendMessage(event)}
                      className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-3.5"
                      data-testid="salary-advance-message-form"
                    >
                      <label
                        htmlFor="salary-advance-message-input"
                        className="text-xs font-medium text-[var(--color-text-secondary)]"
                      >
                        Gửi tin nhắn trao đổi trực tiếp trên yêu cầu này
                      </label>
                      {messageError ? (
                        <div className="mt-2">
                          <StatusBanner tone="error">
                            {messageError}
                          </StatusBanner>
                        </div>
                      ) : null}
                      <div className="mt-1.5 flex flex-col sm:flex-row gap-2">
                        <textarea
                          id="salary-advance-message-input"
                          data-testid="salary-advance-message-input"
                          rows={2}
                          value={messageText}
                          onChange={(event) =>
                            setMessageText(event.target.value)
                          }
                          disabled={messageSubmitting}
                          placeholder="Nhập nội dung trao đổi giữa QLDA và Kế toán dự án..."
                          className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-sm text-[var(--color-text-primary)]"
                        />
                        <div className="flex items-end">
                          <Button
                            type="submit"
                            variant="secondary"
                            size="sm"
                            loading={messageSubmitting}
                            disabled={messageSubmitting}
                            data-testid="salary-advance-send-message-btn"
                          >
                            Gửi tin nhắn
                          </Button>
                        </div>
                      </div>
                    </form>
                  ) : null}

                  <ol
                    className="mt-4 divide-y divide-[var(--color-border)]"
                    data-testid="salary-advance-timeline"
                  >
                    {chronologicalEvents.map((ev) => (
                      <li
                        key={ev.event_id}
                        data-testid={`salary-advance-event-${ev.event_seq}`}
                        className="py-3 first:pt-0 last:pb-0 text-sm"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-mono text-[var(--color-text-secondary)]">
                              #{ev.event_seq}
                            </span>
                            <StatusBadge
                              tone={getSalaryAdvanceEventTone(ev.event_type)}
                            >
                              {getSalaryAdvanceEventTypeLabel(ev.event_type)}
                            </StatusBadge>
                            <span className="font-semibold text-[var(--color-text-primary)]">
                              {ev.actor_display_name || ev.actor_user_id}
                            </span>
                            <StatusBadge tone="neutral">
                              {getSalaryAdvanceActorRoleLabel(ev.actor_role)}
                            </StatusBadge>
                            {ev.evidence_version ? (
                              <StatusBadge tone="primary">
                                Ảnh #{ev.evidence_version}
                              </StatusBadge>
                            ) : null}
                          </div>
                          <span className="text-xs text-[var(--color-text-secondary)]">
                            {formatDateTimeVi(ev.created_at)}
                          </span>
                        </div>

                        {ev.message_text ? (
                          <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-[var(--color-surface-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)]">
                            {ev.message_text}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </Card>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* Create Salary Advance Request Dialog (PM) */}
      <FormDialog
        open={createDialogOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !createSubmitting) {
            setCreateDialogOpen(false);
          }
        }}
        closeDisabled={createSubmitting}
        title="Tạo yêu cầu ứng lương mới"
        description="Chọn dự án đang quản lý, chọn người lao động thuộc dự án và nhập số tiền VNĐ cùng nội dung đề nghị."
      >
        <div className="flex flex-col gap-4">
          {createError ? (
            <StatusBanner tone="error">{createError}</StatusBanner>
          ) : null}

          <div className="flex flex-col gap-1">
            <label
              htmlFor="salary-advance-create-project"
              className="text-xs font-medium text-[var(--color-text-secondary)]"
            >
              Dự án quản lý (*)
            </label>
            <select
              id="salary-advance-create-project"
              data-testid="salary-advance-create-project"
              value={createProjectId}
              onChange={(event) => {
                const nextProjectId = event.target.value;
                getRequestTracker(workersTrackerRef).cancelAll();
                setCreateProjectId(nextProjectId);
                setCreateWorkerEntryId("");
                setWorkers([]);
                setWorkersHasMore(false);
                setWorkersNextCursor(null);
                setWorkersError(null);
              }}
              disabled={createSubmitting}
              className="h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)]"
            >
              <option value="">-- Chọn dự án --</option>
              {activeManagedProjects.map((project) => (
                <option key={project.project_id} value={project.project_id}>
                  {project.display_name}
                  {project.accountant_display_name
                    ? ` (Kế toán: ${project.accountant_display_name})`
                    : " (Chưa gán Kế toán dự án)"}
                </option>
              ))}
            </select>
          </div>

          {selectedCreateProject &&
          !selectedCreateProject.has_active_accountant ? (
            <div data-testid="salary-advance-unassigned-accountant-warning">
              <StatusBanner
                tone="warning"
                title="Dự án chưa được gán Kế toán dự án đang hoạt động"
              >
                Dự án <strong>{selectedCreateProject.display_name}</strong> hiện
                chưa có Kế toán dự án phụ trách. Vui lòng liên hệ Admin cấu hình
                Kế toán dự án trước khi tạo yêu cầu ứng lương.
              </StatusBanner>
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            <label
              htmlFor="salary-advance-worker-search"
              className="text-xs font-medium text-[var(--color-text-secondary)]"
            >
              Tìm người lao động trong dự án
            </label>
            <input
              id="salary-advance-worker-search"
              data-testid="salary-advance-worker-search"
              type="search"
              value={workerSearchInput}
              onChange={(event) => setWorkerSearchInput(event.target.value)}
              disabled={!createProjectId || createSubmitting}
              placeholder="Tìm theo mã nhân viên hoặc họ tên NLĐ..."
              className="h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)]"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="salary-advance-create-worker"
              className="text-xs font-medium text-[var(--color-text-secondary)]"
            >
              Chọn người lao động (*)
            </label>
            {workersError ? (
              <StatusBanner tone="error">{workersError}</StatusBanner>
            ) : null}
            <select
              id="salary-advance-create-worker"
              data-testid="salary-advance-create-worker"
              value={createWorkerEntryId}
              onChange={(event) => setCreateWorkerEntryId(event.target.value)}
              disabled={
                !createProjectId || workersLoading || createSubmitting
              }
              className="h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)]"
            >
              <option value="">
                {workersLoading
                  ? "Đang tải danh sách NLĐ..."
                  : workers.length === 0
                    ? "-- Không tìm thấy NLĐ phù hợp --"
                    : "-- Chọn người lao động --"}
              </option>
              {workers.map((worker) => (
                <option
                  key={worker.worker_entry_id}
                  value={worker.worker_entry_id}
                >
                  {worker.display_name} ({worker.employee_code}) · Ngày công đầu:{" "}
                  {worker.first_work_date} ·{" "}
                  {worker.has_portrait
                    ? "Đã có ảnh hồ sơ"
                    : "Chưa có ảnh hồ sơ"}
                </option>
              ))}
            </select>
            {workersHasMore ? (
              <div className="mt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={workersLoadingMore}
                  onClick={() =>
                    void loadProjectWorkers(createProjectId, workerSearchInput, {
                      cursor: workersNextCursor,
                      append: true,
                    })
                  }
                >
                  Tải thêm người lao động
                </Button>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="salary-advance-create-amount"
              className="text-xs font-medium text-[var(--color-text-secondary)]"
            >
              Số tiền đề nghị ứng (VNĐ, số nguyên dương) (*)
            </label>
            <input
              id="salary-advance-create-amount"
              data-testid="salary-advance-create-amount"
              type="text"
              inputMode="numeric"
              value={createAmountRaw}
              onChange={(event) => setCreateAmountRaw(event.target.value)}
              disabled={createSubmitting}
              placeholder="VD: 2000000"
              className="h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)]"
            />
            {previewFormattedCreateAmount ? (
              <span className="text-xs text-[var(--color-text-secondary)]">
                Số tiền hiển thị:{" "}
                <strong>{previewFormattedCreateAmount}</strong>
              </span>
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="salary-advance-create-content"
              className="text-xs font-medium text-[var(--color-text-secondary)]"
            >
              Nội dung đề nghị ứng lương (*)
            </label>
            <textarea
              id="salary-advance-create-content"
              data-testid="salary-advance-create-content"
              rows={3}
              value={createInitialContent}
              onChange={(event) => setCreateInitialContent(event.target.value)}
              disabled={createSubmitting}
              placeholder="Nêu rõ lý do ứng lương, số ngày công đã làm hoặc đề xuất chi trả..."
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-sm text-[var(--color-text-primary)]"
            />
          </div>

          <div className="mt-2 flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-3">
            <Button
              variant="ghost"
              onClick={() => setCreateDialogOpen(false)}
              disabled={createSubmitting}
            >
              Hủy
            </Button>
            <Button
              variant="primary"
              loading={createSubmitting}
              disabled={
                createSubmitting ||
                selectedCreateProject?.has_active_accountant === false
              }
              onClick={() => void handleSubmitCreateRequest()}
              data-testid="salary-advance-submit-create-btn"
            >
              Gửi yêu cầu ứng lương
            </Button>
          </div>
        </div>
      </FormDialog>

      {/* Transition Action Dialog */}
      <FormDialog
        open={Boolean(transitionDialog?.open)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !transitionSubmitting) {
            setTransitionDialog(null);
          }
        }}
        closeDisabled={transitionSubmitting}
        title={transitionDialog?.title ?? "Thực hiện thao tác"}
        description={transitionDialog?.description}
      >
        <div className="flex flex-col gap-3">
          {transitionError ? (
            <StatusBanner tone="error">{transitionError}</StatusBanner>
          ) : null}

          <div className="flex flex-col gap-1">
            <label
              htmlFor="salary-advance-transition-message"
              className="text-xs font-medium text-[var(--color-text-secondary)]"
            >
              {transitionDialog?.messageLabel}
            </label>
            <textarea
              id="salary-advance-transition-message"
              data-testid="salary-advance-transition-message"
              rows={3}
              value={transitionMessageText}
              onChange={(event) => setTransitionMessageText(event.target.value)}
              disabled={transitionSubmitting}
              placeholder={transitionDialog?.messagePlaceholder}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-sm text-[var(--color-text-primary)]"
            />
          </div>

          <div className="mt-2 flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-3">
            <Button
              variant="ghost"
              onClick={() => setTransitionDialog(null)}
              disabled={transitionSubmitting}
            >
              Hủy
            </Button>
            <Button
              variant={transitionDialog?.submitVariant ?? "primary"}
              loading={transitionSubmitting}
              disabled={transitionSubmitting}
              onClick={() => void handleSubmitTransitionAction()}
              data-testid="salary-advance-confirm-transition-btn"
            >
              {transitionDialog?.submitLabel ?? "Xác nhận"}
            </Button>
          </div>
        </div>
      </FormDialog>
    </PageShell>
  );
}
