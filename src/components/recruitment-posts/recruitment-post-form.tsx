"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { Button } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  EDUCATION_REQUIREMENT_LABELS,
  ENVIRONMENT_TYPE_LABELS,
  GENDER_REQUIREMENT_LABELS,
  RECRUITMENT_POST_EDUCATION_REQUIREMENTS,
  RECRUITMENT_POST_ENVIRONMENT_TYPES,
  RECRUITMENT_POST_GENDER_REQUIREMENTS,
  RECRUITMENT_POST_SHIFT_PATTERNS,
  RECRUITMENT_POST_WORK_POSTURES,
  SHIFT_PATTERN_LABELS,
  WORK_POSTURE_LABELS,
  applyCreateFormContextDefaults,
  applyCreateFormProjectSelection,
  buildRecruitmentPostPreSubmitSummary,
  classifyRecruitmentPostAccessLoss,
  createEditRecruitmentPostFormDraftFromItem,
  createEmptyRecruitmentPostFormDraft,
  createLatestRequestTracker,
  deriveProvinceDisplayNameForDraft,
  extractRecruitmentPostErrorCode,
  formatRecruitmentPostText,
  formatRecruitmentPostTimestampVi,
  newIdempotencyKey,
  normalizeRecruitmentPostVndInput,
  parseRecruitmentPostDetailEnvelope,
  recruitmentPostErrorMessage,
  resolveRecruitmentPostContextOutcome,
  resolveRecruitmentPostMutationOutcome,
  selectableIndustrialParksForCreate,
  selectableLaborTypesForDraft,
  setRecruitmentPostExperienceRequired,
  setRecruitmentPostPpeProvided,
  setRecruitmentPostRequireOtherDocuments,
  setRecruitmentPostSalaryAdvanceAvailable,
  setRecruitmentPostWeeklySalaryAvailable,
  toggleRecruitmentPostEnvironmentType,
  toggleRecruitmentPostLaborTypeKey,
  toggleRecruitmentPostWorkPosture,
  validateAndBuildRecruitmentPostWritePayload,
  type CreateRecruitmentPostRequestBody,
  type LatestRequestTracker,
  type RecruitmentPostAccessLossKind,
  type RecruitmentPostContext,
  type RecruitmentPostEducationRequirement,
  type RecruitmentPostFormDraftState,
  type RecruitmentPostFormMode,
  type RecruitmentPostGenderRequirement,
  type RecruitmentPostItem,
  type RecruitmentPostShiftPattern,
  type UpdateRecruitmentPostRequestBody,
} from "@/lib/recruitment-posts/recruitment-post-ui-model";

import {
  RecruitmentPostWithdrawDialog,
  type RecruitmentPostWithdrawTarget,
} from "./recruitment-post-withdraw-dialog";

const INPUT_CLASS =
  "h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:bg-surface-muted/60 disabled:opacity-75 read-only:bg-surface-muted/50";

const NUMBER_INPUT_CLASS =
  "h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm font-mono tabular-nums text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:bg-surface-muted/60 disabled:opacity-75 read-only:bg-surface-muted/50";

const TEXTAREA_CLASS =
  "w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:bg-surface-muted/60 disabled:opacity-75 read-only:bg-surface-muted/50";

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error !== null &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

function getRequestTracker(
  ref: { current: LatestRequestTracker | null },
): LatestRequestTracker {
  if (!ref.current) {
    ref.current = createLatestRequestTracker();
  }
  return ref.current;
}

export type PendingFormMutationIntent =
  | {
      readonly mode: "create";
      readonly idempotencyKey: string;
      readonly requestBody: CreateRecruitmentPostRequestBody;
    }
  | {
      readonly mode: "edit";
      readonly briefId: string;
      readonly idempotencyKey: string;
      readonly requestBody: UpdateRecruitmentPostRequestBody;
    };

export type RecruitmentPostFormInitialTestState = {
  readonly context?: RecruitmentPostContext | null;
  readonly loadedPost?: RecruitmentPostItem | null;
  readonly draft?: RecruitmentPostFormDraftState;
  readonly initialLoading?: boolean;
  readonly loadError?: string | null;
  readonly notFoundError?: boolean;
  readonly accessLoss?: RecruitmentPostAccessLossKind | null;
  readonly submitting?: boolean;
  readonly submitError?: string | null;
  readonly validationMessage?: string | null;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly staleConflictMessage?: string | null;
  readonly comparedServerPost?: RecruitmentPostItem | null;
  readonly ambiguousLockMessage?: string | null;
  readonly pendingIntent?: PendingFormMutationIntent | null;
  readonly writePermissionRevokedMessage?: string | null;
  readonly savedPost?: RecruitmentPostItem | null;
  readonly withdrawTarget?: RecruitmentPostWithdrawTarget | null;
};

function VndFieldPreview({ rawValue, label }: { rawValue: string; label: string }) {
  if (!rawValue.trim()) return null;
  const preview = normalizeRecruitmentPostVndInput(rawValue, label);
  if (preview.ok) {
    return (
      <p className="text-xs font-mono tabular-nums text-muted">
        Định dạng hiển thị: <strong>{preview.formatted}</strong>
      </p>
    );
  }
  return <p className="text-xs text-danger">{preview.message}</p>;
}

export function RecruitmentPostForm({
  mode,
  briefId,
  actorDisplayName,
  initialStateForTest,
}: {
  mode: RecruitmentPostFormMode;
  briefId?: string;
  actorDisplayName?: string;
  initialStateForTest?: RecruitmentPostFormInitialTestState;
}) {
  const [context, setContext] = useState<RecruitmentPostContext | null>(
    () => initialStateForTest?.context ?? null,
  );
  const [loadedPost, setLoadedPost] = useState<RecruitmentPostItem | null>(
    () => initialStateForTest?.loadedPost ?? null,
  );
  const [draft, setDraft] = useState<RecruitmentPostFormDraftState>(() => {
    if (initialStateForTest?.draft) {
      if (
        mode === "create" &&
        typeof actorDisplayName === "string" &&
        actorDisplayName.trim().length > 0
      ) {
        return {
          ...initialStateForTest.draft,
          managerName: actorDisplayName.trim(),
          lockedManagerName: actorDisplayName.trim(),
        };
      }
      if (mode === "edit" && initialStateForTest.loadedPost) {
        return {
          ...initialStateForTest.draft,
          managerName: initialStateForTest.loadedPost.general.manager_name,
          lockedManagerName:
            initialStateForTest.loadedPost.general.manager_name,
        };
      }
      return initialStateForTest.draft;
    }
    if (mode === "edit" && initialStateForTest?.loadedPost) {
      return createEditRecruitmentPostFormDraftFromItem(
        initialStateForTest.loadedPost,
      );
    }
    const emptyDraft = createEmptyRecruitmentPostFormDraft(mode, {
      actorDisplayName,
    });
    if (mode === "create" && initialStateForTest?.context) {
      return applyCreateFormContextDefaults(
        emptyDraft,
        initialStateForTest.context,
        actorDisplayName,
      );
    }
    return emptyDraft;
  });
  const [initialLoading, setInitialLoading] = useState<boolean>(
    () => initialStateForTest?.initialLoading ?? true,
  );
  const [loadError, setLoadError] = useState<string | null>(
    () => initialStateForTest?.loadError ?? null,
  );
  const [notFoundError, setNotFoundError] = useState<boolean>(
    () => initialStateForTest?.notFoundError ?? false,
  );
  const [accessLoss, setAccessLoss] =
    useState<RecruitmentPostAccessLossKind | null>(
      () => initialStateForTest?.accessLoss ?? null,
    );

  const [submitting, setSubmitting] = useState<boolean>(
    () => initialStateForTest?.submitting ?? false,
  );
  const [reloadingLatest, setReloadingLatest] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(
    () => initialStateForTest?.submitError ?? null,
  );
  const [validationMessage, setValidationMessage] = useState<string | null>(
    () => initialStateForTest?.validationMessage ?? null,
  );
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Record<string, string>>
  >(() => initialStateForTest?.fieldErrors ?? {});
  const [staleConflictMessage, setStaleConflictMessage] = useState<
    string | null
  >(() => initialStateForTest?.staleConflictMessage ?? null);
  const [comparedServerPost, setComparedServerPost] =
    useState<RecruitmentPostItem | null>(
      () => initialStateForTest?.comparedServerPost ?? null,
    );
  const [ambiguousLockMessage, setAmbiguousLockMessage] = useState<
    string | null
  >(() => initialStateForTest?.ambiguousLockMessage ?? null);
  const [pendingIntent, setPendingIntent] =
    useState<PendingFormMutationIntent | null>(
      () => initialStateForTest?.pendingIntent ?? null,
    );
  const [writePermissionRevokedMessage, setWritePermissionRevokedMessage] =
    useState<string | null>(
      () => initialStateForTest?.writePermissionRevokedMessage ?? null,
    );
  const [savedPost, setSavedPost] = useState<RecruitmentPostItem | null>(
    () => initialStateForTest?.savedPost ?? null,
  );
  const [withdrawTarget, setWithdrawTarget] =
    useState<RecruitmentPostWithdrawTarget | null>(
      () => initialStateForTest?.withdrawTarget ?? null,
    );

  const loadTrackerRef = useRef<LatestRequestTracker | null>(null);

  const ambiguousRetryLocked =
    pendingIntent !== null && ambiguousLockMessage !== null;
  const permissionRevokedReadOnly = writePermissionRevokedMessage !== null;
  const formLocked =
    submitting ||
    reloadingLatest ||
    ambiguousRetryLocked ||
    permissionRevokedReadOnly ||
    savedPost?.status === "WITHDRAWN" ||
    loadedPost?.status === "WITHDRAWN";

  const handleAccessRevoked = useCallback(
    (lossKind: RecruitmentPostAccessLossKind) => {
      getRequestTracker(loadTrackerRef).cancelAll();
      setContext(null);
      setLoadedPost(null);
      setDraft(createEmptyRecruitmentPostFormDraft(mode, { actorDisplayName }));
      setInitialLoading(false);
      setLoadError(null);
      setNotFoundError(false);
      setSubmitting(false);
      setReloadingLatest(false);
      setSubmitError(null);
      setValidationMessage(null);
      setFieldErrors({});
      setStaleConflictMessage(null);
      setComparedServerPost(null);
      setAmbiguousLockMessage(null);
      setPendingIntent(null);
      setWritePermissionRevokedMessage(null);
      setSavedPost(null);
      setWithdrawTarget(null);
      setAccessLoss(lossKind);
    },
    [actorDisplayName, mode],
  );

  const loadFormWorkspace = useCallback(async () => {
    const ticket = getRequestTracker(loadTrackerRef).begin();
    setInitialLoading(true);
    setLoadError(null);
    setNotFoundError(false);

    try {
      const contextPromise = fetch("/api/recruitment-posts/context", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        signal: ticket.signal,
      });

      const detailPromise =
        mode === "edit" && briefId
          ? fetch(`/api/recruitment-posts/${encodeURIComponent(briefId)}`, {
              method: "GET",
              cache: "no-store",
              credentials: "same-origin",
              signal: ticket.signal,
            })
          : null;

      const [contextResponse, detailResponse] = await Promise.all([
        contextPromise,
        detailPromise,
      ]);
      if (!ticket.isCurrent()) return;

      const rawContextPayload = await contextResponse.json().catch(() => null);
      if (!ticket.isCurrent()) return;

      const contextOutcome = resolveRecruitmentPostContextOutcome({
        status: contextResponse.status,
        payload: rawContextPayload,
      });

      if (contextOutcome.kind === "access_loss") {
        handleAccessRevoked(contextOutcome.accessLoss);
        return;
      }

      if (contextOutcome.kind === "error") {
        setInitialLoading(false);
        setLoadError(contextOutcome.message);
        return;
      }

      if (mode === "edit") {
        if (!detailResponse || !briefId) {
          setInitialLoading(false);
          setNotFoundError(true);
          return;
        }

        const rawDetailPayload = await detailResponse.json().catch(() => null);
        if (!ticket.isCurrent()) return;

        const detailErrorCode = extractRecruitmentPostErrorCode(rawDetailPayload);
        const detailRevoked = classifyRecruitmentPostAccessLoss(
          detailResponse.status,
          detailErrorCode,
        );
        if (detailRevoked) {
          handleAccessRevoked(detailRevoked);
          return;
        }

        if (detailResponse.status === 404) {
          setContext(contextOutcome.context);
          setInitialLoading(false);
          setNotFoundError(true);
          return;
        }

        if (!detailResponse.ok) {
          setContext(contextOutcome.context);
          setInitialLoading(false);
          setLoadError(recruitmentPostErrorMessage(detailErrorCode));
          return;
        }

        const parsedDetail = parseRecruitmentPostDetailEnvelope(rawDetailPayload);
        if (!parsedDetail) {
          setContext(contextOutcome.context);
          setInitialLoading(false);
          setLoadError(
            recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
          );
          return;
        }

        setContext(contextOutcome.context);
        setLoadedPost(parsedDetail.post);
        setDraft(createEditRecruitmentPostFormDraftFromItem(parsedDetail.post));
        setInitialLoading(false);
        setLoadError(null);
        return;
      }

      setContext(contextOutcome.context);
      setDraft((prev) =>
        applyCreateFormContextDefaults(
          prev,
          contextOutcome.context,
          actorDisplayName,
        ),
      );
      setInitialLoading(false);
      setLoadError(null);
    } catch (error) {
      if (isAbortError(error) || !ticket.isCurrent()) return;
      setInitialLoading(false);
      setLoadError(
        recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
      );
    }
  }, [actorDisplayName, briefId, handleAccessRevoked, mode]);

  useEffect(() => {
    if (initialStateForTest) {
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadFormWorkspace();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialStateForTest, loadFormWorkspace]);

  useEffect(() => {
    return () => {
      getRequestTracker(loadTrackerRef).cancelAll();
    };
  }, []);

  const executeMutationIntent = useCallback(
    async (intent: PendingFormMutationIntent) => {
      setSubmitting(true);
      setSubmitError(null);
      setValidationMessage(null);
      setStaleConflictMessage(null);

      const endpoint =
        intent.mode === "create"
          ? "/api/recruitment-posts"
          : `/api/recruitment-posts/${encodeURIComponent(intent.briefId)}`;
      const method = intent.mode === "create" ? "POST" : "PATCH";

      try {
        const response = await fetch(endpoint, {
          method,
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": intent.idempotencyKey,
          },
          body: JSON.stringify(intent.requestBody),
        });

        const rawPayload = await response.json().catch(() => null);
        const errorCode = extractRecruitmentPostErrorCode(rawPayload);

        if (
          response.status === 403 &&
          errorCode === "RECRUITMENT_POST_ACCESS_DENIED"
        ) {
          setSubmitting(false);
          setPendingIntent(null);
          setAmbiguousLockMessage(null);
          setWritePermissionRevokedMessage(
            "Quyền tạo/chỉnh sửa phiếu tuyển dụng trên dự án này vừa bị thu hồi. Nội dung bạn đã nhập vẫn được giữ ở chế độ chỉ đọc để bạn sao chép lưu lại.",
          );
          return;
        }

        const outcome = resolveRecruitmentPostMutationOutcome({
          status: response.status,
          payload: rawPayload,
        });

        if (outcome.kind === "access_loss") {
          handleAccessRevoked(outcome.accessLoss);
          return;
        }

        if (outcome.kind === "ok") {
          setSubmitting(false);
          setPendingIntent(null);
          setAmbiguousLockMessage(null);
          setStaleConflictMessage(null);
          setComparedServerPost(null);
          setSavedPost(outcome.result.post);
          setLoadedPost(outcome.result.post);
          setDraft(createEditRecruitmentPostFormDraftFromItem(outcome.result.post));
          return;
        }

        if (outcome.kind === "conflict_stale") {
          setSubmitting(false);
          setPendingIntent(null);
          setAmbiguousLockMessage(null);
          setStaleConflictMessage(outcome.message);
          return;
        }

        if (outcome.kind === "already_withdrawn") {
          setSubmitting(false);
          setPendingIntent(null);
          setAmbiguousLockMessage(null);
          setSubmitError(outcome.message);
          return;
        }

        if (outcome.kind === "ambiguous_retry_lock") {
          setSubmitting(false);
          setPendingIntent(intent);
          setAmbiguousLockMessage(outcome.message);
          return;
        }

        setSubmitting(false);
        setPendingIntent(null);
        setAmbiguousLockMessage(null);
        setSubmitError(outcome.message);
      } catch {
        const networkOutcome = resolveRecruitmentPostMutationOutcome({
          status: 0,
          payload: null,
        });
        setSubmitting(false);
        setPendingIntent(intent);
        setAmbiguousLockMessage(
          networkOutcome.kind === "ambiguous_retry_lock"
            ? networkOutcome.message
            : "Mất kết nối mạng trong lúc gửi dữ liệu. Vui lòng dùng nút gửi lại cùng khóa định danh.",
        );
      }
    },
    [handleAccessRevoked],
  );

  const handleSubmitForm = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (formLocked) return;

      const built = validateAndBuildRecruitmentPostWritePayload(draft, {
        actorDisplayName,
      });
      if (!built.ok) {
        setFieldErrors(built.fieldErrors);
        setValidationMessage(built.message);
        setSubmitError(null);
        return;
      }

      setFieldErrors({});
      setValidationMessage(null);
      setSubmitError(null);

      if (built.mode === "create") {
        const intent: PendingFormMutationIntent = {
          mode: "create",
          idempotencyKey: newIdempotencyKey(),
          requestBody: built.requestBody,
        };
        setPendingIntent(intent);
        void executeMutationIntent(intent);
        return;
      }

      const targetBriefId = briefId ?? loadedPost?.brief_id ?? "";
      if (!targetBriefId) {
        setSubmitError("Không xác định được mã phiếu tuyển dụng cần cập nhật.");
        return;
      }

      const intent: PendingFormMutationIntent = {
        mode: "edit",
        briefId: targetBriefId,
        idempotencyKey: newIdempotencyKey(),
        requestBody: built.requestBody,
      };
      setPendingIntent(intent);
      void executeMutationIntent(intent);
    },
    [
      actorDisplayName,
      briefId,
      draft,
      executeMutationIntent,
      formLocked,
      loadedPost,
    ],
  );

  const handleRetrySameIntent = useCallback(() => {
    if (!pendingIntent || submitting || reloadingLatest) return;
    void executeMutationIntent(pendingIntent);
  }, [executeMutationIntent, pendingIntent, reloadingLatest, submitting]);

  const handleReloadToCompare = useCallback(async () => {
    const targetBriefId = briefId ?? loadedPost?.brief_id ?? "";
    if (!targetBriefId || submitting || reloadingLatest) return;

    setReloadingLatest(true);
    setSubmitError(null);

    try {
      const response = await fetch(
        `/api/recruitment-posts/${encodeURIComponent(targetBriefId)}`,
        {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
        },
      );
      const rawPayload = await response.json().catch(() => null);
      const errorCode = extractRecruitmentPostErrorCode(rawPayload);
      const revoked = classifyRecruitmentPostAccessLoss(
        response.status,
        errorCode,
      );
      if (revoked) {
        handleAccessRevoked(revoked);
        return;
      }

      if (!response.ok) {
        setReloadingLatest(false);
        setSubmitError(recruitmentPostErrorMessage(errorCode));
        return;
      }

      const parsedDetail = parseRecruitmentPostDetailEnvelope(rawPayload);
      if (!parsedDetail) {
        setReloadingLatest(false);
        setSubmitError(
          recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
        );
        return;
      }

      setReloadingLatest(false);
      setPendingIntent(null);
      setAmbiguousLockMessage(null);
      setStaleConflictMessage(null);
      setLoadedPost(parsedDetail.post);
      setComparedServerPost(parsedDetail.post);
      setDraft((prev) => ({
        ...prev,
        expectedVersion: parsedDetail.post.version,
      }));
    } catch {
      setReloadingLatest(false);
      setSubmitError(
        recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
      );
    }
  }, [briefId, handleAccessRevoked, loadedPost, reloadingLatest, submitting]);

  const handleApplyComparedServerPostToDraft = useCallback(() => {
    if (!comparedServerPost) return;
    setDraft(createEditRecruitmentPostFormDraftFromItem(comparedServerPost));
    setComparedServerPost(null);
    setStaleConflictMessage(null);
    setFieldErrors({});
    setValidationMessage(null);
  }, [comparedServerPost]);

  const managedProjects = useMemo(
    () => context?.managed_projects ?? [],
    [context],
  );

  const selectableIndustrialParks = useMemo(
    () =>
      selectableIndustrialParksForCreate(
        context?.industrial_parks ?? [],
        context?.provinces ?? [],
      ),
    [context],
  );

  const derivedProvinceDisplayName = useMemo(
    () =>
      deriveProvinceDisplayNameForDraft(
        draft,
        context?.industrial_parks ?? [],
        context?.provinces ?? [],
      ),
    [context, draft],
  );

  const selectableLaborTypes = useMemo(
    () => selectableLaborTypesForDraft(context?.labor_types ?? [], draft),
    [context, draft],
  );

  const preSubmitSummary = useMemo(
    () =>
      buildRecruitmentPostPreSubmitSummary({
        draft,
        managedProjects,
        industrialParks: context?.industrial_parks ?? [],
        provinces: context?.provinces ?? [],
      }),
    [context, draft, managedProjects],
  );

  if (accessLoss === "ACCESS_DENIED") {
    return <AccessDenied />;
  }

  if (accessLoss === "ACCOUNT_UNAVAILABLE") {
    return <AccountUnavailable />;
  }

  if (accessLoss === "UNAUTHENTICATED") {
    const nextPath =
      mode === "edit" && briefId
        ? `/recruitment-posts/${encodeURIComponent(briefId)}/edit`
        : "/recruitment-posts/new";
    return (
      <main
        data-testid="recruitment-post-form-unauthenticated"
        className="flex min-h-full flex-1 items-center justify-center p-4"
      >
        <div
          role="alert"
          className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 text-center shadow-xs"
        >
          <h1 className="mb-2 text-lg font-semibold text-foreground">
            Phiên đăng nhập đã hết hạn
          </h1>
          <p className="mb-5 text-sm text-muted">
            Dữ liệu trên màn hình đã được xóa để bảo mật. Vui lòng đăng nhập lại
            để tiếp tục.
          </p>
          <Link
            href={`/login?next=${encodeURIComponent(nextPath)}`}
            className="inline-flex min-h-11 h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            Đăng nhập lại
          </Link>
        </div>
      </main>
    );
  }

  if (initialLoading) {
    return (
      <PageShell dataTestId="recruitment-post-form-loading">
        <PageHeader
          title={
            mode === "create"
              ? "Tạo phiếu tuyển dụng"
              : "Chỉnh sửa phiếu tuyển dụng"
          }
          description="Đang tải dữ liệu và ngữ cảnh phân quyền…"
        />
        <div
          role="status"
          aria-live="polite"
          className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-muted"
        >
          Đang tải biểu mẫu phiếu tuyển dụng…
        </div>
      </PageShell>
    );
  }

  if (loadError) {
    return (
      <PageShell dataTestId="recruitment-post-form-load-error">
        <PageHeader
          title={
            mode === "create"
              ? "Tạo phiếu tuyển dụng"
              : "Chỉnh sửa phiếu tuyển dụng"
          }
          actions={
            <Link
              href="/recruitment-posts"
              className="inline-flex min-h-11 h-10 items-center justify-center rounded-md border border-border bg-surface px-3.5 text-sm font-medium text-foreground hover:bg-surface-muted/70"
            >
              Quay lại danh sách
            </Link>
          }
        />
        <StatusBanner
          tone="error"
          title="Không thể tải biểu mẫu phiếu tuyển dụng"
          dataTestId="recruitment-post-form-load-error-banner"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{loadError}</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                void loadFormWorkspace();
              }}
            >
              Thử lại
            </Button>
          </div>
        </StatusBanner>
      </PageShell>
    );
  }

  if (notFoundError) {
    return (
      <PageShell dataTestId="recruitment-post-form-not-found">
        <PageHeader
          title="Không tìm thấy phiếu tuyển dụng"
          description="Phiếu tuyển dụng không tồn tại hoặc đã bị xóa."
          actions={
            <Link
              href="/recruitment-posts"
              className="inline-flex min-h-11 h-10 items-center justify-center rounded-md bg-primary px-3.5 text-sm font-medium text-on-primary hover:bg-primary/90"
            >
              Quay lại danh sách tin tuyển dụng
            </Link>
          }
        />
      </PageShell>
    );
  }

  if (
    mode === "create" &&
    (!context?.can_create || context.managed_projects.length === 0)
  ) {
    return (
      <PageShell dataTestId="recruitment-post-create-forbidden">
        <PageHeader
          title="Tạo phiếu tuyển dụng"
          actions={
            <Link
              href="/recruitment-posts"
              className="inline-flex min-h-11 h-10 items-center justify-center rounded-md border border-border bg-surface px-3.5 text-sm font-medium text-foreground hover:bg-surface-muted/70"
            >
              Quay lại danh sách tin tuyển dụng
            </Link>
          }
        />
        <StatusBanner
          tone="warning"
          title="Bạn không có quyền tạo phiếu tuyển dụng"
          dataTestId="recruitment-post-create-forbidden-banner"
        >
          Chỉ Quản lý dự án (PM) hiện hành của dự án đang hoạt động mới được tạo
          phiếu tuyển dụng cho dự án mình quản lý. Tài khoản hiện tại không có dự
          án nào thuộc quyền tạo tin.
        </StatusBanner>
      </PageShell>
    );
  }

  if (mode === "edit" && loadedPost && !loadedPost.allowed_actions.can_edit) {
    return (
      <PageShell dataTestId="recruitment-post-edit-forbidden">
        <PageHeader
          title="Chỉnh sửa phiếu tuyển dụng"
          actions={
            <Link
              href="/recruitment-posts"
              className="inline-flex min-h-11 h-10 items-center justify-center rounded-md border border-border bg-surface px-3.5 text-sm font-medium text-foreground hover:bg-surface-muted/70"
            >
              Quay lại danh sách tin tuyển dụng
            </Link>
          }
        />
        <StatusBanner
          tone="warning"
          title="Không thể chỉnh sửa phiếu tuyển dụng này"
          dataTestId="recruitment-post-edit-forbidden-banner"
        >
          {loadedPost.status === "WITHDRAWN"
            ? "Phiếu tuyển dụng này đã được rút và chuyển sang trạng thái chỉ đọc."
            : "Chỉ người tạo phiếu (đang là PM hiện hành của dự án) hoặc Full Admin / BOD mới có quyền chỉnh sửa phiếu tuyển dụng này."}
        </StatusBanner>
      </PageShell>
    );
  }

  const canWithdrawLoadedPost =
    mode === "edit" &&
    loadedPost !== null &&
    loadedPost.status === "PUBLISHED" &&
    loadedPost.allowed_actions.can_withdraw;

  return (
    <PageShell dataTestId="recruitment-post-form-workspace">
      <PageHeader
        title={
          mode === "create"
            ? "Tạo phiếu thông tin tuyển dụng"
            : `Chỉnh sửa phiếu tuyển dụng · ${draft.lockedProjectDisplayName}`
        }
        description={
          mode === "create"
            ? "Điền đầy đủ 4 phần theo mẫu chuẩn BOD và kiểm tra khối xác nhận trước khi đăng tin."
            : `Khu công nghiệp: ${draft.lockedIndustrialParkDisplayName} (${derivedProvinceDisplayName || "—"}) · Phiên bản hiện tại: v${draft.expectedVersion}`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canWithdrawLoadedPost && loadedPost ? (
              <Button
                type="button"
                variant="danger"
                size="md"
                data-testid="recruitment-post-form-withdraw-trigger"
                disabled={submitting || reloadingLatest || ambiguousRetryLocked}
                onClick={() =>
                  setWithdrawTarget({
                    briefId: loadedPost.brief_id,
                    expectedVersion: draft.expectedVersion,
                    projectName: loadedPost.project.display_name,
                    industrialParkName: loadedPost.industrial_park.display_name,
                    provinceName: loadedPost.province.display_name,
                    jobDescriptionDisplay: loadedPost.general.job_description,
                  })
                }
              >
                Rút tin
              </Button>
            ) : null}
            <Link
              href="/recruitment-posts"
              data-testid="recruitment-post-form-back-link"
              className="inline-flex min-h-11 h-10 items-center justify-center rounded-md border border-border bg-surface px-3.5 text-sm font-medium text-foreground hover:bg-surface-muted/70"
            >
              Quay lại danh sách
            </Link>
          </div>
        }
      />

      {savedPost ? (
        <StatusBanner
          tone="success"
          title={
            savedPost.status === "WITHDRAWN"
              ? "Đã rút phiếu tuyển dụng thành công"
              : mode === "create"
                ? "Đã tạo phiếu tuyển dụng thành công"
                : "Đã lưu cập nhật phiếu tuyển dụng"
          }
          dataTestId="recruitment-post-form-saved-banner"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              Dự án <strong>{savedPost.project.display_name}</strong> tại{" "}
              <strong>{savedPost.industrial_park.display_name}</strong> · Phiên
              bản <strong>v{savedPost.version}</strong>.
            </span>
            <Link
              href="/recruitment-posts"
              data-testid="recruitment-post-form-return-feed"
              className="inline-flex min-h-9 items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:bg-primary/90"
            >
              Về danh sách tin tuyển dụng
            </Link>
          </div>
        </StatusBanner>
      ) : null}

      {permissionRevokedReadOnly && writePermissionRevokedMessage ? (
        <StatusBanner
          tone="warning"
          title="Quyền chỉnh sửa đã thay đổi — Biểu mẫu chuyển sang chỉ đọc"
          dataTestId="recruitment-post-permission-revoked-readonly"
        >
          {writePermissionRevokedMessage}
        </StatusBanner>
      ) : null}

      {validationMessage ? (
        <StatusBanner
          tone="error"
          title="Vui lòng kiểm tra lại thông tin bắt buộc"
          dataTestId="recruitment-post-validation-error"
        >
          {validationMessage}
        </StatusBanner>
      ) : null}

      {submitError ? (
        <StatusBanner
          tone="error"
          title="Không thể lưu phiếu tuyển dụng"
          dataTestId="recruitment-post-submit-error"
        >
          {submitError}
        </StatusBanner>
      ) : null}

      {staleConflictMessage ? (
        <StatusBanner
          tone="error"
          title="Xung đột phiên bản (409 RECRUITMENT_POST_STALE)"
          dataTestId="recruitment-post-stale-conflict"
        >
          <div className="space-y-3">
            <p>{staleConflictMessage}</p>
            <p className="text-xs">
              Dữ liệu bạn đang nhập trên màn hình vẫn được giữ nguyên. Bấm nút
              bên dưới để tải bản mới nhất trên máy chủ về đối chiếu trước khi
              quyết định gửi lại.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="recruitment-post-reload-compare"
              disabled={reloadingLatest || submitting}
              onClick={() => {
                void handleReloadToCompare();
              }}
            >
              {reloadingLatest
                ? "Đang tải bản mới nhất…"
                : "Tải bản mới nhất để đối chiếu"}
            </Button>
          </div>
        </StatusBanner>
      ) : null}

      {comparedServerPost ? (
        <div
          data-testid="recruitment-post-compared-server-card"
          className="rounded-xl border border-primary/40 bg-primary/5 p-4 space-y-3 text-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-foreground">
              Bản mới nhất trên máy chủ (v{comparedServerPost.version})
            </h2>
            <span className="text-xs text-muted">
              Cập nhật lúc{" "}
              {formatRecruitmentPostTimestampVi(comparedServerPost.updated_at)}{" "}
              bởi {comparedServerPost.updated_by_display_name}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs text-foreground">
            <p>
              <span className="text-muted">Công việc trên máy chủ:</span>{" "}
              <strong>{comparedServerPost.general.job_description}</strong>
            </p>
            <p>
              <span className="text-muted">Số lượng dự kiến:</span>{" "}
              <strong className="font-mono tabular-nums">
                {comparedServerPost.general.expected_headcount ?? "Chưa cung cấp"}
              </strong>
            </p>
            <p>
              <span className="text-muted">Người phụ trách:</span>{" "}
              <strong>
                {formatRecruitmentPostText(
                  comparedServerPost.created_by_display_name,
                )}{" "}
                ·{" "}
                {formatRecruitmentPostText(
                  comparedServerPost.general.manager_phone,
                )}
              </strong>
            </p>
            <p>
              <span className="text-muted">Trạng thái:</span>{" "}
              <strong>
                {comparedServerPost.status === "WITHDRAWN"
                  ? "Đã rút"
                  : "Đang hiệu lực"}
              </strong>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="recruitment-post-apply-server-draft"
              onClick={handleApplyComparedServerPostToDraft}
            >
              Áp dụng nội dung mới nhất từ máy chủ vào biểu mẫu
            </Button>
            <span className="text-xs text-muted">
              Hoặc giữ nguyên bản nháp hiện tại của bạn và bấm{" "}
              <strong>Lưu cập nhật</strong> để lưu đè trên phiên bản v
              {comparedServerPost.version}.
            </span>
          </div>
        </div>
      ) : null}

      {ambiguousRetryLocked && ambiguousLockMessage ? (
        <StatusBanner
          tone="warning"
          title="Chưa xác nhận được kết quả xử lý trên máy chủ"
          dataTestId="recruitment-post-ambiguous-lock"
        >
          <div className="space-y-3">
            <p>{ambiguousLockMessage}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="primary"
                size="sm"
                data-testid="recruitment-post-retry-same"
                disabled={submitting || reloadingLatest}
                onClick={handleRetrySameIntent}
              >
                {submitting ? "Đang gửi lại…" : "Gửi lại đúng yêu cầu"}
              </Button>
              {mode === "edit" ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid="recruitment-post-reload-after-ambiguous"
                  disabled={submitting || reloadingLatest}
                  onClick={() => {
                    void handleReloadToCompare();
                  }}
                >
                  {reloadingLatest
                    ? "Đang tải…"
                    : "Tải bản mới nhất để đối chiếu"}
                </Button>
              ) : (
                <Link
                  href="/recruitment-posts"
                  className="inline-flex min-h-9 items-center justify-center rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-muted/70"
                >
                  Kiểm tra danh sách tin tuyển dụng
                </Link>
              )}
            </div>
          </div>
        </StatusBanner>
      ) : null}

      <form
        data-testid="recruitment-post-form"
        onSubmit={handleSubmitForm}
        noValidate
        className="space-y-6"
      >
        {/* PHẦN 1: THÔNG TIN CHUNG DỰ ÁN */}
        <section
          aria-labelledby="recruitment-post-form-sec-1"
          data-testid="recruitment-post-form-section-1"
          className="rounded-xl border border-border bg-surface p-5 space-y-5 shadow-xs"
        >
          <div className="border-b border-border pb-3">
            <h2
              id="recruitment-post-form-sec-1"
              className="text-base font-semibold text-foreground"
            >
              1. Thông tin chung dự án
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Chọn dự án bạn quản lý, khu công nghiệp và điền đầy đủ thông tin
              công việc, người phụ trách.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Dự án & Khu công nghiệp trên cùng 1 hàng desktop */}
            <div
              data-testid="recruitment-post-project-park-row"
              className="grid grid-cols-1 gap-4 sm:col-span-2 sm:grid-cols-2"
            >
              {/* Dự án */}
              <div className="space-y-1.5">
                <label
                  htmlFor="recruitment-post-field-project"
                  className="block text-sm font-medium text-foreground"
                >
                  Dự án <span className="text-danger">*</span>
                </label>
                {mode === "edit" ? (
                  <input
                    id="recruitment-post-field-project"
                    type="text"
                    readOnly
                    disabled
                    data-testid="recruitment-post-locked-project"
                    value={draft.lockedProjectDisplayName}
                    className={INPUT_CLASS}
                  />
                ) : (
                  <select
                    id="recruitment-post-field-project"
                    data-testid="recruitment-post-select-project"
                    disabled={formLocked}
                    value={draft.projectId}
                    onChange={(event) =>
                      setDraft((prev) =>
                        applyCreateFormProjectSelection(
                          prev,
                          event.target.value,
                          managedProjects,
                        ),
                      )
                    }
                    aria-invalid={Boolean(fieldErrors.projectId)}
                    className={INPUT_CLASS}
                  >
                    <option value="">-- Chọn dự án đang quản lý --</option>
                    {managedProjects.map((project) => (
                      <option
                        key={project.project_id}
                        value={project.project_id}
                      >
                        {project.display_name}
                      </option>
                    ))}
                  </select>
                )}
                {fieldErrors.projectId ? (
                  <p className="text-xs text-danger">{fieldErrors.projectId}</p>
                ) : null}
              </div>

              {/* Khu công nghiệp */}
              <div className="space-y-1.5">
                <label
                  htmlFor="recruitment-post-field-park"
                  className="block text-sm font-medium text-foreground"
                >
                  Khu công nghiệp <span className="text-danger">*</span>
                </label>
                {mode === "edit" ? (
                  <input
                    id="recruitment-post-field-park"
                    type="text"
                    readOnly
                    disabled
                    data-testid="recruitment-post-locked-park"
                    value={draft.lockedIndustrialParkDisplayName}
                    className={INPUT_CLASS}
                  />
                ) : (
                  <select
                    id="recruitment-post-field-park"
                    data-testid="recruitment-post-select-park"
                    disabled={formLocked}
                    value={draft.industrialParkId}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        industrialParkId: event.target.value,
                      }))
                    }
                    aria-invalid={Boolean(fieldErrors.industrialParkId)}
                    className={INPUT_CLASS}
                  >
                    <option value="">-- Chọn Khu công nghiệp --</option>
                    {selectableIndustrialParks.map((park) => (
                      <option
                        key={park.industrial_park_id}
                        value={park.industrial_park_id}
                      >
                        {park.display_name} ({park.industrial_park_code})
                      </option>
                    ))}
                  </select>
                )}
                {fieldErrors.industrialParkId ? (
                  <p className="text-xs text-danger">
                    {fieldErrors.industrialParkId}
                  </p>
                ) : null}
              </div>
            </div>

            {/* Tỉnh/Thành tự động suy ra (chỉ hiển thị trên giao diện chỉnh sửa tin đã đăng) */}
            {mode === "edit" ? (
              <div className="space-y-1.5 sm:col-span-2">
                <label
                  htmlFor="recruitment-post-field-province"
                  className="block text-sm font-medium text-foreground"
                >
                  Tỉnh/Thành (Tự động suy ra từ KCN)
                </label>
                <input
                  id="recruitment-post-field-province"
                  type="text"
                  readOnly
                  data-testid="recruitment-post-derived-province"
                  value={
                    derivedProvinceDisplayName ||
                    "Tự động điền khi chọn Khu công nghiệp"
                  }
                  className={INPUT_CLASS}
                />
              </div>
            ) : null}

            {/* Tên khách hàng */}
            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-customer"
                className="block text-sm font-medium text-foreground"
              >
                Tên khách hàng <span className="text-danger">*</span>
              </label>
              <input
                id="recruitment-post-field-customer"
                type="text"
                data-testid="recruitment-post-input-customer-name"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.customerName}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    customerName: event.target.value,
                  }))
                }
                aria-invalid={Boolean(fieldErrors.customerName)}
                placeholder="Ví dụ: Công ty TNHH Điện tử Luxshare"
                className={INPUT_CLASS}
              />
              {fieldErrors.customerName ? (
                <p className="text-xs text-danger">{fieldErrors.customerName}</p>
              ) : null}
            </div>

            {/* Vốn đầu tư */}
            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-investment-origin"
                className="block text-sm font-medium text-foreground"
              >
                Vốn đầu tư
              </label>
              <input
                id="recruitment-post-field-investment-origin"
                type="text"
                data-testid="recruitment-post-input-investment-origin"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.investmentOrigin}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    investmentOrigin: event.target.value,
                  }))
                }
                placeholder="Ví dụ: Hàn Quốc, Nhật Bản, Trung Quốc…"
                className={INPUT_CLASS}
              />
            </div>

            {/* Ngành sản xuất */}
            <div className="space-y-1.5 sm:col-span-2">
              <label
                htmlFor="recruitment-post-field-industry"
                className="block text-sm font-medium text-foreground"
              >
                Ngành sản xuất
              </label>
              <input
                id="recruitment-post-field-industry"
                type="text"
                data-testid="recruitment-post-input-manufacturing-industry"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.manufacturingIndustry}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    manufacturingIndustry: event.target.value,
                  }))
                }
                placeholder="Ví dụ: Linh kiện điện tử, tai nghe, cáp sạc…"
                className={INPUT_CLASS}
              />
            </div>

            {/* Mô tả công việc */}
            <div className="space-y-1.5 sm:col-span-2">
              <label
                htmlFor="recruitment-post-field-job-desc"
                className="block text-sm font-medium text-foreground"
              >
                Mô tả công việc <span className="text-danger">*</span>
              </label>
              <textarea
                id="recruitment-post-field-job-desc"
                rows={3}
                data-testid="recruitment-post-input-job-description"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.jobDescription}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    jobDescription: event.target.value,
                  }))
                }
                aria-invalid={Boolean(fieldErrors.jobDescription)}
                placeholder="Lắp ráp linh kiện điện tử, kiểm tra ngoại quan sản phẩm…"
                className={TEXTAREA_CLASS}
              />
              {fieldErrors.jobDescription ? (
                <p className="text-xs text-danger">
                  {fieldErrors.jobDescription}
                </p>
              ) : null}
            </div>

            {/* Môi trường làm việc */}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">
                Môi trường làm việc
              </legend>
              <div className="flex flex-wrap gap-3">
                {RECRUITMENT_POST_ENVIRONMENT_TYPES.map((envType) => {
                  const checked = draft.environmentTypes.includes(envType);
                  return (
                    <label
                      key={envType}
                      className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-surface-muted/30 px-3 py-2 text-sm text-foreground cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        data-testid={`recruitment-post-env-${envType}`}
                        disabled={formLocked}
                        checked={checked}
                        onChange={() =>
                          setDraft((prev) =>
                            toggleRecruitmentPostEnvironmentType(prev, envType),
                          )
                        }
                        className="h-4 w-4 rounded border-border"
                      />
                      <span>{ENVIRONMENT_TYPE_LABELS[envType]}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {/* Tư thế làm việc */}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">
                Tư thế làm việc
              </legend>
              <div className="flex flex-wrap gap-3">
                {RECRUITMENT_POST_WORK_POSTURES.map((posture) => {
                  const checked = draft.workPostures.includes(posture);
                  return (
                    <label
                      key={posture}
                      className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-surface-muted/30 px-3 py-2 text-sm text-foreground cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        data-testid={`recruitment-post-posture-${posture}`}
                        disabled={formLocked}
                        checked={checked}
                        onChange={() =>
                          setDraft((prev) =>
                            toggleRecruitmentPostWorkPosture(prev, posture),
                          )
                        }
                        className="h-4 w-4 rounded border-border"
                      />
                      <span>{WORK_POSTURE_LABELS[posture]}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {/* Ca làm việc */}
            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-shift-pattern"
                className="block text-sm font-medium text-foreground"
              >
                Ca làm việc <span className="text-danger">*</span>
              </label>
              <select
                id="recruitment-post-field-shift-pattern"
                data-testid="recruitment-post-select-shift-pattern"
                disabled={formLocked}
                value={draft.shiftPattern}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    shiftPattern:
                      event.target.value as RecruitmentPostShiftPattern,
                  }))
                }
                className={INPUT_CLASS}
              >
                {RECRUITMENT_POST_SHIFT_PATTERNS.map((pattern) => (
                  <option key={pattern} value={pattern}>
                    {SHIFT_PATTERN_LABELS[pattern]}
                  </option>
                ))}
              </select>
            </div>

            {/* Chi tiết ca / giờ làm việc */}
            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-shift-details"
                className="block text-sm font-medium text-foreground"
              >
                Chi tiết ca / giờ làm việc{" "}
                {draft.shiftPattern === "OTHER" ? (
                  <span className="text-danger">*</span>
                ) : null}
              </label>
              <input
                id="recruitment-post-field-shift-details"
                type="text"
                data-testid="recruitment-post-input-shift-details"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.shiftDetails}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    shiftDetails: event.target.value,
                  }))
                }
                aria-invalid={Boolean(fieldErrors.shiftDetails)}
                placeholder="Ví dụ: Ca ngày 08:00 - 20:00, Ca đêm 20:00 - 08:00"
                className={INPUT_CLASS}
              />
              {fieldErrors.shiftDetails ? (
                <p className="text-xs text-danger">{fieldErrors.shiftDetails}</p>
              ) : null}
            </div>

            {/* Số điện thoại người phụ trách */}
            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-manager-phone"
                className="block text-sm font-medium text-foreground"
              >
                Số điện thoại người phụ trách{" "}
                <span className="text-danger">*</span>
              </label>
              <input
                id="recruitment-post-field-manager-phone"
                type="tel"
                data-testid="recruitment-post-input-manager-phone"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.managerPhone}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    managerPhone: event.target.value,
                  }))
                }
                aria-invalid={Boolean(fieldErrors.managerPhone)}
                placeholder="Ví dụ: 0912345678"
                className={NUMBER_INPUT_CLASS}
              />
              {fieldErrors.managerPhone ? (
                <p className="text-xs text-danger">{fieldErrors.managerPhone}</p>
              ) : null}
            </div>

            {/* Hình thức tuyển dụng */}
            <fieldset className="space-y-2 sm:col-span-2">
              <legend className="text-sm font-medium text-foreground">
                Hình thức tuyển dụng <span className="text-danger">*</span>
              </legend>
              <div className="flex flex-wrap gap-3">
                {selectableLaborTypes.map((lt) => {
                  const checked = draft.laborTypeKeys.includes(
                    lt.labor_type_key,
                  );
                  return (
                    <label
                      key={lt.labor_type_key}
                      className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-surface-muted/30 px-3 py-2 text-sm text-foreground cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        data-testid={`recruitment-post-labor-type-${lt.labor_type_key}`}
                        disabled={formLocked}
                        checked={checked}
                        onChange={() =>
                          setDraft((prev) =>
                            toggleRecruitmentPostLaborTypeKey(
                              prev,
                              lt.labor_type_key,
                            ),
                          )
                        }
                        className="h-4 w-4 rounded border-border"
                      />
                      <span>
                        {lt.display_name}
                        {!lt.active ? " (Lịch sử)" : ""}
                      </span>
                    </label>
                  );
                })}
              </div>
              {fieldErrors.laborTypeKeys ? (
                <p className="text-xs text-danger">
                  {fieldErrors.laborTypeKeys}
                </p>
              ) : null}
            </fieldset>

            {/* Số lượng dự kiến */}
            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-headcount"
                className="block text-sm font-medium text-foreground"
              >
                Số lượng dự kiến (người)
              </label>
              <input
                id="recruitment-post-field-headcount"
                type="number"
                min={0}
                step={1}
                data-testid="recruitment-post-input-headcount"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.expectedHeadcount}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    expectedHeadcount: event.target.value,
                  }))
                }
                aria-invalid={Boolean(fieldErrors.expectedHeadcount)}
                placeholder="Ví dụ: 150"
                className={NUMBER_INPUT_CLASS}
              />
              {fieldErrors.expectedHeadcount ? (
                <p className="text-xs text-danger">
                  {fieldErrors.expectedHeadcount}
                </p>
              ) : null}
            </div>

            {/* Thời gian cung ứng */}
            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-supply-schedule"
                className="block text-sm font-medium text-foreground"
              >
                Thời gian cung ứng
              </label>
              <input
                id="recruitment-post-field-supply-schedule"
                type="text"
                data-testid="recruitment-post-input-supply-schedule"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.supplyScheduleText}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    supplyScheduleText: event.target.value,
                  }))
                }
                placeholder="Ví dụ: Nhận việc hằng ngày từ Thứ 2 - Thứ 7"
                className={INPUT_CLASS}
              />
            </div>
          </div>
        </section>

        {/* PHẦN 2: YÊU CẦU ỨNG VIÊN */}
        <section
          aria-labelledby="recruitment-post-form-sec-2"
          data-testid="recruitment-post-form-section-2"
          className="rounded-xl border border-border bg-surface p-5 space-y-5 shadow-xs"
        >
          <div className="border-b border-border pb-3">
            <h2
              id="recruitment-post-form-sec-2"
              className="text-base font-semibold text-foreground"
            >
              2. Yêu cầu ứng viên
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Tiêu chí độ tuổi, giới tính, trình độ học vấn, kinh nghiệm và hình
              thức kiểm tra đầu vào.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* 4 trường cốt lõi trên cùng 1 hàng desktop: Độ tuổi từ, Độ tuổi đến, Giới tính, Trình độ tối thiểu */}
            <div
              data-testid="recruitment-post-candidate-core-row"
              className="grid grid-cols-1 gap-4 sm:col-span-2 sm:grid-cols-2 lg:grid-cols-4"
            >
              {/* Độ tuổi tối thiểu */}
              <div className="space-y-1.5">
                <label
                  htmlFor="recruitment-post-field-age-min"
                  className="block text-sm font-medium text-foreground"
                >
                  Độ tuổi từ
                </label>
                <input
                  id="recruitment-post-field-age-min"
                  type="number"
                  min={15}
                  max={70}
                  step={1}
                  data-testid="recruitment-post-input-age-min"
                  readOnly={permissionRevokedReadOnly}
                  disabled={formLocked && !permissionRevokedReadOnly}
                  value={draft.ageMin}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      ageMin: event.target.value,
                    }))
                  }
                  aria-invalid={Boolean(fieldErrors.ageMin)}
                  className={NUMBER_INPUT_CLASS}
                />
                {fieldErrors.ageMin ? (
                  <p className="text-xs text-danger">{fieldErrors.ageMin}</p>
                ) : null}
              </div>

              {/* Độ tuổi tối đa */}
              <div className="space-y-1.5">
                <label
                  htmlFor="recruitment-post-field-age-max"
                  className="block text-sm font-medium text-foreground"
                >
                  Độ tuổi đến
                </label>
                <input
                  id="recruitment-post-field-age-max"
                  type="number"
                  min={15}
                  max={70}
                  step={1}
                  data-testid="recruitment-post-input-age-max"
                  readOnly={permissionRevokedReadOnly}
                  disabled={formLocked && !permissionRevokedReadOnly}
                  value={draft.ageMax}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      ageMax: event.target.value,
                    }))
                  }
                  aria-invalid={Boolean(fieldErrors.ageMax)}
                  className={NUMBER_INPUT_CLASS}
                />
                {fieldErrors.ageMax ? (
                  <p className="text-xs text-danger">{fieldErrors.ageMax}</p>
                ) : null}
              </div>

              {/* Giới tính */}
              <div className="space-y-1.5">
                <label
                  htmlFor="recruitment-post-field-gender"
                  className="block text-sm font-medium text-foreground"
                >
                  Giới tính <span className="text-danger">*</span>
                </label>
                <select
                  id="recruitment-post-field-gender"
                  data-testid="recruitment-post-select-gender"
                  disabled={formLocked}
                  value={draft.genderRequirement}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      genderRequirement:
                        event.target.value as RecruitmentPostGenderRequirement,
                    }))
                  }
                  className={INPUT_CLASS}
                >
                  {RECRUITMENT_POST_GENDER_REQUIREMENTS.map((gender) => (
                    <option key={gender} value={gender}>
                      {GENDER_REQUIREMENT_LABELS[gender]}
                    </option>
                  ))}
                </select>
              </div>

              {/* Trình độ tối thiểu */}
              <div className="space-y-1.5">
                <label
                  htmlFor="recruitment-post-field-education"
                  className="block text-sm font-medium text-foreground"
                >
                  Trình độ tối thiểu <span className="text-danger">*</span>
                </label>
                <select
                  id="recruitment-post-field-education"
                  data-testid="recruitment-post-select-education"
                  disabled={formLocked}
                  value={draft.educationRequirement}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      educationRequirement:
                        event.target
                          .value as RecruitmentPostEducationRequirement,
                    }))
                  }
                  className={INPUT_CLASS}
                >
                  {RECRUITMENT_POST_EDUCATION_REQUIREMENTS.map((level) => (
                    <option key={level} value={level}>
                      {EDUCATION_REQUIREMENT_LABELS[level]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Yêu cầu kinh nghiệm */}
            <div className="space-y-2 sm:col-span-2">
              <label className="inline-flex min-h-11 items-center gap-2.5 text-sm font-medium text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="recruitment-post-checkbox-experience-required"
                  disabled={formLocked}
                  checked={draft.experienceRequired}
                  onChange={(event) =>
                    setDraft((prev) =>
                      setRecruitmentPostExperienceRequired(
                        prev,
                        event.target.checked,
                      ),
                    )
                  }
                  className="h-4 w-4 rounded border-border"
                />
                <span>Có yêu cầu kinh nghiệm làm việc</span>
              </label>

              {draft.experienceRequired ? (
                <div className="space-y-1.5 pl-6">
                  <label
                    htmlFor="recruitment-post-field-experience-details"
                    className="block text-sm font-medium text-foreground"
                  >
                    Chi tiết kinh nghiệm <span className="text-danger">*</span>
                  </label>
                  <input
                    id="recruitment-post-field-experience-details"
                    type="text"
                    data-testid="recruitment-post-input-experience-details"
                    readOnly={permissionRevokedReadOnly}
                    disabled={formLocked && !permissionRevokedReadOnly}
                    value={draft.experienceDetails}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        experienceDetails: event.target.value,
                      }))
                    }
                    aria-invalid={Boolean(fieldErrors.experienceDetails)}
                    placeholder="Ví dụ: Tối thiểu 6 tháng đứng máy SMT hoặc hàn linh kiện…"
                    className={INPUT_CLASS}
                  />
                  {fieldErrors.experienceDetails ? (
                    <p className="text-xs text-danger">
                      {fieldErrors.experienceDetails}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* Nhận lao động từng làm tại khách hàng */}
            <div className="space-y-1.5 sm:col-span-2">
              <label className="inline-flex min-h-11 items-center gap-2.5 text-sm font-medium text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="recruitment-post-checkbox-accept-former-workers"
                  disabled={formLocked}
                  checked={draft.acceptFormerCustomerWorkers}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      acceptFormerCustomerWorkers: event.target.checked,
                    }))
                  }
                  className="h-4 w-4 rounded border-border"
                />
                <span>Nhận lao động từng làm tại khách hàng</span>
              </label>
            </div>

            {/* Hình thức kiểm tra đầu vào */}
            <div className="space-y-1.5 sm:col-span-2">
              <label
                htmlFor="recruitment-post-field-entry-assessment"
                className="block text-sm font-medium text-foreground"
              >
                Hình thức kiểm tra đầu vào
              </label>
              <input
                id="recruitment-post-field-entry-assessment"
                type="text"
                data-testid="recruitment-post-input-entry-assessment"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.entryAssessmentText}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    entryAssessmentText: event.target.value,
                  }))
                }
                placeholder="Ví dụ: Phỏng vấn trực tiếp, kiểm tra thị lực và bảng chữ cái…"
                className={INPUT_CLASS}
              />
            </div>

            {/* Yêu cầu khác */}
            <div className="space-y-1.5 sm:col-span-2">
              <label
                htmlFor="recruitment-post-field-other-requirements"
                className="block text-sm font-medium text-foreground"
              >
                Yêu cầu khác
              </label>
              <textarea
                id="recruitment-post-field-other-requirements"
                rows={2}
                data-testid="recruitment-post-input-other-requirements"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.otherRequirementsText}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    otherRequirementsText: event.target.value,
                  }))
                }
                placeholder="Ví dụ: Không mồ hôi tay, chấp nhận làm ca đêm luân phiên…"
                className={TEXTAREA_CLASS}
              />
            </div>
          </div>
        </section>

        {/* PHẦN 3: LƯƠNG, THƯỞNG VÀ PHÚC LỢI */}
        <section
          aria-labelledby="recruitment-post-form-sec-3"
          data-testid="recruitment-post-form-section-3"
          className="rounded-xl border border-border bg-surface p-5 space-y-5 shadow-xs"
        >
          <div className="border-b border-border pb-3">
            <h2
              id="recruitment-post-form-sec-3"
              className="text-base font-semibold text-foreground"
            >
              3. Lương, thưởng và phúc lợi
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Nhập số tiền nguyên dương (VND). Hệ thống tự động định dạng theo
              chuẩn hiển thị VND để đối chiếu.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Lương cơ bản & điều kiện */}
            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-base-salary"
                className="block text-sm font-medium text-foreground"
              >
                Lương cơ bản (VND)
              </label>
              <input
                id="recruitment-post-field-base-salary"
                type="text"
                inputMode="numeric"
                data-testid="recruitment-post-input-base-salary"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.baseSalaryVnd}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    baseSalaryVnd: event.target.value,
                  }))
                }
                aria-invalid={Boolean(fieldErrors.baseSalaryVnd)}
                placeholder="Ví dụ: 5500000"
                className={NUMBER_INPUT_CLASS}
              />
              <VndFieldPreview
                rawValue={draft.baseSalaryVnd}
                label="Lương cơ bản"
              />
              {fieldErrors.baseSalaryVnd ? (
                <p className="text-xs text-danger">
                  {fieldErrors.baseSalaryVnd}
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-base-salary-conditions"
                className="block text-sm font-medium text-foreground"
              >
                Điều kiện lương cơ bản
              </label>
              <input
                id="recruitment-post-field-base-salary-conditions"
                type="text"
                data-testid="recruitment-post-input-base-salary-conditions"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.baseSalaryConditions}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    baseSalaryConditions: event.target.value,
                  }))
                }
                placeholder="Ví dụ: Đủ 26 công/tháng"
                className={INPUT_CLASS}
              />
            </div>

            {/* Thưởng chuyên cần & điều kiện */}
            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-attendance-bonus"
                className="block text-sm font-medium text-foreground"
              >
                Thưởng chuyên cần (VND)
              </label>
              <input
                id="recruitment-post-field-attendance-bonus"
                type="text"
                inputMode="numeric"
                data-testid="recruitment-post-input-attendance-bonus"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.attendanceBonusVnd}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    attendanceBonusVnd: event.target.value,
                  }))
                }
                aria-invalid={Boolean(fieldErrors.attendanceBonusVnd)}
                placeholder="Ví dụ: 500000"
                className={NUMBER_INPUT_CLASS}
              />
              <VndFieldPreview
                rawValue={draft.attendanceBonusVnd}
                label="Thưởng chuyên cần"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-attendance-bonus-conditions"
                className="block text-sm font-medium text-foreground"
              >
                Điều kiện thưởng chuyên cần
              </label>
              <input
                id="recruitment-post-field-attendance-bonus-conditions"
                type="text"
                data-testid="recruitment-post-input-attendance-bonus-conditions"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.attendanceBonusConditions}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    attendanceBonusConditions: event.target.value,
                  }))
                }
                placeholder="Ví dụ: Không nghỉ không phép"
                className={INPUT_CLASS}
              />
            </div>

            {/* Phụ cấp đời sống & điều kiện */}
            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-living-allowance"
                className="block text-sm font-medium text-foreground"
              >
                Phụ cấp đời sống (VND)
              </label>
              <input
                id="recruitment-post-field-living-allowance"
                type="text"
                inputMode="numeric"
                data-testid="recruitment-post-input-living-allowance"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.livingAllowanceVnd}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    livingAllowanceVnd: event.target.value,
                  }))
                }
                placeholder="Ví dụ: 800000"
                className={NUMBER_INPUT_CLASS}
              />
              <VndFieldPreview
                rawValue={draft.livingAllowanceVnd}
                label="Phụ cấp đời sống"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-living-allowance-conditions"
                className="block text-sm font-medium text-foreground"
              >
                Điều kiện phụ cấp đời sống
              </label>
              <input
                id="recruitment-post-field-living-allowance-conditions"
                type="text"
                data-testid="recruitment-post-input-living-allowance-conditions"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.livingAllowanceConditions}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    livingAllowanceConditions: event.target.value,
                  }))
                }
                placeholder="Ví dụ: Tính theo ngày công thực tế"
                className={INPUT_CLASS}
              />
            </div>

            {/* Phụ cấp thâm niên & điều kiện */}
            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-seniority-allowance"
                className="block text-sm font-medium text-foreground"
              >
                Phụ cấp thâm niên (VND)
              </label>
              <input
                id="recruitment-post-field-seniority-allowance"
                type="text"
                inputMode="numeric"
                data-testid="recruitment-post-input-seniority-allowance"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.seniorityAllowanceVnd}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    seniorityAllowanceVnd: event.target.value,
                  }))
                }
                placeholder="Ví dụ: 300000"
                className={NUMBER_INPUT_CLASS}
              />
              <VndFieldPreview
                rawValue={draft.seniorityAllowanceVnd}
                label="Phụ cấp thâm niên"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-seniority-allowance-conditions"
                className="block text-sm font-medium text-foreground"
              >
                Điều kiện phụ cấp thâm niên
              </label>
              <input
                id="recruitment-post-field-seniority-allowance-conditions"
                type="text"
                data-testid="recruitment-post-input-seniority-allowance-conditions"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.seniorityAllowanceConditions}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    seniorityAllowanceConditions: event.target.value,
                  }))
                }
                placeholder="Ví dụ: Từ tháng thứ 2 trở đi"
                className={INPUT_CLASS}
              />
            </div>

            {/* Phụ cấp soi kính & điều kiện */}
            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-eyesight-allowance"
                className="block text-sm font-medium text-foreground"
              >
                Phụ cấp soi kính (VND)
              </label>
              <input
                id="recruitment-post-field-eyesight-allowance"
                type="text"
                inputMode="numeric"
                data-testid="recruitment-post-input-eyesight-allowance"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.eyesightAllowanceVnd}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    eyesightAllowanceVnd: event.target.value,
                  }))
                }
                placeholder="Ví dụ: 300000"
                className={NUMBER_INPUT_CLASS}
              />
              <VndFieldPreview
                rawValue={draft.eyesightAllowanceVnd}
                label="Phụ cấp soi kính"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-eyesight-allowance-conditions"
                className="block text-sm font-medium text-foreground"
              >
                Điều kiện phụ cấp soi kính
              </label>
              <input
                id="recruitment-post-field-eyesight-allowance-conditions"
                type="text"
                data-testid="recruitment-post-input-eyesight-allowance-conditions"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.eyesightAllowanceConditions}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    eyesightAllowanceConditions: event.target.value,
                  }))
                }
                placeholder="Ví dụ: Áp dụng cho công đoạn dùng kính hiển vi"
                className={INPUT_CLASS}
              />
            </div>

            {/* Phụ cấp khác */}
            <div className="space-y-1.5 sm:col-span-2">
              <label
                htmlFor="recruitment-post-field-other-allowance"
                className="block text-sm font-medium text-foreground"
              >
                Phụ cấp khác
              </label>
              <input
                id="recruitment-post-field-other-allowance"
                type="text"
                data-testid="recruitment-post-input-other-allowance"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.otherAllowanceText}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    otherAllowanceText: event.target.value,
                  }))
                }
                placeholder="Ví dụ: Phụ cấp phòng sạch 200.000 ₫/tháng"
                className={INPUT_CLASS}
              />
            </div>

            {/* Thu nhập bình quân tối thiểu & tối đa */}
            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-income-min"
                className="block text-sm font-medium text-foreground"
              >
                Thu nhập bình quân tối thiểu (VND)
              </label>
              <input
                id="recruitment-post-field-income-min"
                type="text"
                inputMode="numeric"
                data-testid="recruitment-post-input-income-min"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.averageIncomeMinVnd}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    averageIncomeMinVnd: event.target.value,
                  }))
                }
                aria-invalid={Boolean(fieldErrors.averageIncomeMinVnd)}
                placeholder="Ví dụ: 9000000"
                className={NUMBER_INPUT_CLASS}
              />
              <VndFieldPreview
                rawValue={draft.averageIncomeMinVnd}
                label="Thu nhập bình quân tối thiểu"
              />
              {fieldErrors.averageIncomeMinVnd ? (
                <p className="text-xs text-danger">
                  {fieldErrors.averageIncomeMinVnd}
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-post-field-income-max"
                className="block text-sm font-medium text-foreground"
              >
                Thu nhập bình quân tối đa (VND)
              </label>
              <input
                id="recruitment-post-field-income-max"
                type="text"
                inputMode="numeric"
                data-testid="recruitment-post-input-income-max"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.averageIncomeMaxVnd}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    averageIncomeMaxVnd: event.target.value,
                  }))
                }
                aria-invalid={Boolean(fieldErrors.averageIncomeMaxVnd)}
                placeholder="Ví dụ: 12000000"
                className={NUMBER_INPUT_CLASS}
              />
              <VndFieldPreview
                rawValue={draft.averageIncomeMaxVnd}
                label="Thu nhập bình quân tối đa"
              />
              {fieldErrors.averageIncomeMaxVnd ? (
                <p className="text-xs text-danger">
                  {fieldErrors.averageIncomeMaxVnd}
                </p>
              ) : null}
            </div>

            {/* Ngày thanh toán lương */}
            <div className="space-y-1.5 sm:col-span-2">
              <label
                htmlFor="recruitment-post-field-payment-schedule"
                className="block text-sm font-medium text-foreground"
              >
                Ngày thanh toán lương
              </label>
              <input
                id="recruitment-post-field-payment-schedule"
                type="text"
                data-testid="recruitment-post-input-salary-payment-schedule"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.salaryPaymentSchedule}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    salaryPaymentSchedule: event.target.value,
                  }))
                }
                placeholder="Ví dụ: Ngày 15 hằng tháng qua tài khoản ngân hàng"
                className={INPUT_CLASS}
              />
            </div>

            {/* Ứng lương */}
            <div className="space-y-2 sm:col-span-2">
              <label className="inline-flex min-h-11 items-center gap-2.5 text-sm font-medium text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="recruitment-post-checkbox-salary-advance"
                  disabled={formLocked}
                  checked={draft.salaryAdvanceAvailable}
                  onChange={(event) =>
                    setDraft((prev) =>
                      setRecruitmentPostSalaryAdvanceAvailable(
                        prev,
                        event.target.checked,
                      ),
                    )
                  }
                  className="h-4 w-4 rounded border-border"
                />
                <span>Có hỗ trợ ứng lương</span>
              </label>
              {draft.salaryAdvanceAvailable ? (
                <div className="grid grid-cols-1 gap-3 pl-6 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label
                      htmlFor="recruitment-post-field-advance-amount"
                      className="block text-sm font-medium text-foreground"
                    >
                      Mức ứng lương (VND)
                    </label>
                    <input
                      id="recruitment-post-field-advance-amount"
                      type="text"
                      inputMode="numeric"
                      data-testid="recruitment-post-input-salary-advance-amount"
                      readOnly={permissionRevokedReadOnly}
                      disabled={formLocked && !permissionRevokedReadOnly}
                      value={draft.salaryAdvanceAmountVnd}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          salaryAdvanceAmountVnd: event.target.value,
                        }))
                      }
                      placeholder="Ví dụ: 500000"
                      className={NUMBER_INPUT_CLASS}
                    />
                    <VndFieldPreview
                      rawValue={draft.salaryAdvanceAmountVnd}
                      label="Mức ứng lương"
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor="recruitment-post-field-advance-schedule"
                      className="block text-sm font-medium text-foreground"
                    >
                      Lịch/ngày ứng lương
                    </label>
                    <input
                      id="recruitment-post-field-advance-schedule"
                      type="text"
                      data-testid="recruitment-post-input-salary-advance-schedule"
                      readOnly={permissionRevokedReadOnly}
                      disabled={formLocked && !permissionRevokedReadOnly}
                      value={draft.salaryAdvanceSchedule}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          salaryAdvanceSchedule: event.target.value,
                        }))
                      }
                      placeholder="Ví dụ: Sau 7 công làm việc"
                      className={INPUT_CLASS}
                    />
                  </div>
                </div>
              ) : null}
            </div>

            {/* Lương tuần */}
            <div className="space-y-2 sm:col-span-2">
              <label className="inline-flex min-h-11 items-center gap-2.5 text-sm font-medium text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="recruitment-post-checkbox-weekly-salary"
                  disabled={formLocked}
                  checked={draft.weeklySalaryAvailable}
                  onChange={(event) =>
                    setDraft((prev) =>
                      setRecruitmentPostWeeklySalaryAvailable(
                        prev,
                        event.target.checked,
                      ),
                    )
                  }
                  className="h-4 w-4 rounded border-border"
                />
                <span>Có trả lương tuần</span>
              </label>
              {draft.weeklySalaryAvailable ? (
                <div className="space-y-1 pl-6">
                  <label
                    htmlFor="recruitment-post-field-weekly-schedule"
                    className="block text-sm font-medium text-foreground"
                  >
                    Ngày thanh toán lương tuần
                  </label>
                  <input
                    id="recruitment-post-field-weekly-schedule"
                    type="text"
                    data-testid="recruitment-post-input-weekly-salary-schedule"
                    readOnly={permissionRevokedReadOnly}
                    disabled={formLocked && !permissionRevokedReadOnly}
                    value={draft.weeklySalaryPaymentSchedule}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        weeklySalaryPaymentSchedule: event.target.value,
                      }))
                    }
                    placeholder="Ví dụ: Thứ Sáu hằng tuần"
                    className={INPUT_CLASS}
                  />
                </div>
              ) : null}
            </div>

            {/* Đơn giá theo ca */}
            <div className="sm:col-span-2 rounded-lg border border-border bg-surface-muted/20 p-4 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Đơn giá theo ca (VND)
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1">
                  <label
                    htmlFor="recruitment-post-field-day8h"
                    className="block text-xs font-medium text-foreground"
                  >
                    Ca ngày 8 giờ
                  </label>
                  <input
                    id="recruitment-post-field-day8h"
                    type="text"
                    inputMode="numeric"
                    data-testid="recruitment-post-input-day-shift-8h"
                    readOnly={permissionRevokedReadOnly}
                    disabled={formLocked && !permissionRevokedReadOnly}
                    value={draft.dayShift8hVnd}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        dayShift8hVnd: event.target.value,
                      }))
                    }
                    className={NUMBER_INPUT_CLASS}
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="recruitment-post-field-day11h"
                    className="block text-xs font-medium text-foreground"
                  >
                    Ca ngày 11 giờ
                  </label>
                  <input
                    id="recruitment-post-field-day11h"
                    type="text"
                    inputMode="numeric"
                    data-testid="recruitment-post-input-day-shift-11h"
                    readOnly={permissionRevokedReadOnly}
                    disabled={formLocked && !permissionRevokedReadOnly}
                    value={draft.dayShift11hVnd}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        dayShift11hVnd: event.target.value,
                      }))
                    }
                    className={NUMBER_INPUT_CLASS}
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="recruitment-post-field-night8h"
                    className="block text-xs font-medium text-foreground"
                  >
                    Ca đêm 8 giờ
                  </label>
                  <input
                    id="recruitment-post-field-night8h"
                    type="text"
                    inputMode="numeric"
                    data-testid="recruitment-post-input-night-shift-8h"
                    readOnly={permissionRevokedReadOnly}
                    disabled={formLocked && !permissionRevokedReadOnly}
                    value={draft.nightShift8hVnd}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        nightShift8hVnd: event.target.value,
                      }))
                    }
                    className={NUMBER_INPUT_CLASS}
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="recruitment-post-field-night11h"
                    className="block text-xs font-medium text-foreground"
                  >
                    Ca đêm 11 giờ
                  </label>
                  <input
                    id="recruitment-post-field-night11h"
                    type="text"
                    inputMode="numeric"
                    data-testid="recruitment-post-input-night-shift-11h"
                    readOnly={permissionRevokedReadOnly}
                    disabled={formLocked && !permissionRevokedReadOnly}
                    value={draft.nightShift11hVnd}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        nightShift11hVnd: event.target.value,
                      }))
                    }
                    className={NUMBER_INPUT_CLASS}
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="recruitment-post-field-sunday-day11h"
                    className="block text-xs font-medium text-foreground"
                  >
                    Chủ nhật ngày 11 giờ
                  </label>
                  <input
                    id="recruitment-post-field-sunday-day11h"
                    type="text"
                    inputMode="numeric"
                    data-testid="recruitment-post-input-sunday-day-11h"
                    readOnly={permissionRevokedReadOnly}
                    disabled={formLocked && !permissionRevokedReadOnly}
                    value={draft.sundayDay11hVnd}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        sundayDay11hVnd: event.target.value,
                      }))
                    }
                    className={NUMBER_INPUT_CLASS}
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="recruitment-post-field-sunday-night11h"
                    className="block text-xs font-medium text-foreground"
                  >
                    Chủ nhật đêm 11 giờ
                  </label>
                  <input
                    id="recruitment-post-field-sunday-night11h"
                    type="text"
                    inputMode="numeric"
                    data-testid="recruitment-post-input-sunday-night-11h"
                    readOnly={permissionRevokedReadOnly}
                    disabled={formLocked && !permissionRevokedReadOnly}
                    value={draft.sundayNight11hVnd}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        sundayNight11hVnd: event.target.value,
                      }))
                    }
                    className={NUMBER_INPUT_CLASS}
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="recruitment-post-field-holiday-day11h"
                    className="block text-xs font-medium text-foreground"
                  >
                    Lễ ngày 11 giờ
                  </label>
                  <input
                    id="recruitment-post-field-holiday-day11h"
                    type="text"
                    inputMode="numeric"
                    data-testid="recruitment-post-input-holiday-day-11h"
                    readOnly={permissionRevokedReadOnly}
                    disabled={formLocked && !permissionRevokedReadOnly}
                    value={draft.holidayDay11hVnd}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        holidayDay11hVnd: event.target.value,
                      }))
                    }
                    className={NUMBER_INPUT_CLASS}
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="recruitment-post-field-holiday-night11h"
                    className="block text-xs font-medium text-foreground"
                  >
                    Lễ đêm 11 giờ
                  </label>
                  <input
                    id="recruitment-post-field-holiday-night11h"
                    type="text"
                    inputMode="numeric"
                    data-testid="recruitment-post-input-holiday-night-11h"
                    readOnly={permissionRevokedReadOnly}
                    disabled={formLocked && !permissionRevokedReadOnly}
                    value={draft.holidayNight11hVnd}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        holidayNight11hVnd: event.target.value,
                      }))
                    }
                    className={NUMBER_INPUT_CLASS}
                  />
                </div>
              </div>
            </div>

            {/* Đồng phục / bảo hộ */}
            <div className="space-y-2 sm:col-span-2">
              <label className="inline-flex min-h-11 items-center gap-2.5 text-sm font-medium text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="recruitment-post-checkbox-ppe-provided"
                  disabled={formLocked}
                  checked={draft.ppeProvided}
                  onChange={(event) =>
                    setDraft((prev) =>
                      setRecruitmentPostPpeProvided(prev, event.target.checked),
                    )
                  }
                  className="h-4 w-4 rounded border-border"
                />
                <span>Có cấp phát đồng phục / đồ bảo hộ</span>
              </label>
              {draft.ppeProvided ? (
                <div className="space-y-1 pl-6">
                  <label
                    htmlFor="recruitment-post-field-ppe-details"
                    className="block text-sm font-medium text-foreground"
                  >
                    Chi tiết đồng phục / bảo hộ
                  </label>
                  <input
                    id="recruitment-post-field-ppe-details"
                    type="text"
                    data-testid="recruitment-post-input-ppe-details"
                    readOnly={permissionRevokedReadOnly}
                    disabled={formLocked && !permissionRevokedReadOnly}
                    value={draft.ppeDetails}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        ppeDetails: event.target.value,
                      }))
                    }
                    placeholder="Ví dụ: Phát 2 bộ áo tĩnh điện và giày phòng sạch"
                    className={INPUT_CLASS}
                  />
                </div>
              ) : null}
            </div>

            {/* Phúc lợi khác */}
            <div className="space-y-1.5 sm:col-span-2">
              <label
                htmlFor="recruitment-post-field-other-benefits"
                className="block text-sm font-medium text-foreground"
              >
                Phúc lợi khác
              </label>
              <textarea
                id="recruitment-post-field-other-benefits"
                rows={2}
                data-testid="recruitment-post-input-other-benefits"
                readOnly={permissionRevokedReadOnly}
                disabled={formLocked && !permissionRevokedReadOnly}
                value={draft.otherBenefits}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    otherBenefits: event.target.value,
                  }))
                }
                placeholder="Ví dụ: Miễn phí suất ăn ca, có xe đưa đón các tuyến cố định…"
                className={TEXTAREA_CLASS}
              />
            </div>
          </div>
        </section>

        {/* PHẦN 4: HỒ SƠ ỨNG VIÊN CẦN CHUẨN BỊ */}
        <section
          aria-labelledby="recruitment-post-form-sec-4"
          data-testid="recruitment-post-form-section-4"
          className="rounded-xl border border-border bg-surface p-5 space-y-5 shadow-xs"
        >
          <div className="border-b border-border pb-3">
            <h2
              id="recruitment-post-form-sec-4"
              className="text-base font-semibold text-foreground"
            >
              4. Hồ sơ ứng viên cần chuẩn bị
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Tích chọn các giấy tờ ứng viên cần mang theo khi đi phỏng vấn / nhận
              việc.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="inline-flex min-h-11 items-center gap-2.5 rounded-lg border border-border bg-surface-muted/30 px-3 py-2 text-sm text-foreground cursor-pointer">
              <input
                type="checkbox"
                data-testid="recruitment-post-doc-cccd"
                disabled={formLocked}
                checked={draft.requireOriginalCccdAndCopy}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    requireOriginalCccdAndCopy: event.target.checked,
                  }))
                }
                className="h-4 w-4 rounded border-border"
              />
              <span>CCCD gốc và bản sao</span>
            </label>

            <label className="inline-flex min-h-11 items-center gap-2.5 rounded-lg border border-border bg-surface-muted/30 px-3 py-2 text-sm text-foreground cursor-pointer">
              <input
                type="checkbox"
                data-testid="recruitment-post-doc-resume"
                disabled={formLocked}
                checked={draft.requireCertifiedResume}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    requireCertifiedResume: event.target.checked,
                  }))
                }
                className="h-4 w-4 rounded border-border"
              />
              <span>Sơ yếu lý lịch có xác nhận</span>
            </label>

            <label className="inline-flex min-h-11 items-center gap-2.5 rounded-lg border border-border bg-surface-muted/30 px-3 py-2 text-sm text-foreground cursor-pointer">
              <input
                type="checkbox"
                data-testid="recruitment-post-doc-health"
                disabled={formLocked}
                checked={draft.requireHealthCertificateWithin6Months}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    requireHealthCertificateWithin6Months: event.target.checked,
                  }))
                }
                className="h-4 w-4 rounded border-border"
              />
              <span>Giấy khám sức khỏe trong vòng 6 tháng</span>
            </label>

            <label className="inline-flex min-h-11 items-center gap-2.5 rounded-lg border border-border bg-surface-muted/30 px-3 py-2 text-sm text-foreground cursor-pointer">
              <input
                type="checkbox"
                data-testid="recruitment-post-doc-photo"
                disabled={formLocked}
                checked={draft.requirePhoto3x4}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    requirePhoto3x4: event.target.checked,
                  }))
                }
                className="h-4 w-4 rounded border-border"
              />
              <span>Ảnh 3x4</span>
            </label>

            <label className="inline-flex min-h-11 items-center gap-2.5 rounded-lg border border-border bg-surface-muted/30 px-3 py-2 text-sm text-foreground cursor-pointer">
              <input
                type="checkbox"
                data-testid="recruitment-post-doc-degree"
                disabled={formLocked}
                checked={draft.requireDegreeOrCertificate}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    requireDegreeOrCertificate: event.target.checked,
                  }))
                }
                className="h-4 w-4 rounded border-border"
              />
              <span>Bằng cấp hoặc chứng chỉ</span>
            </label>

            <label className="inline-flex min-h-11 items-center gap-2.5 rounded-lg border border-border bg-surface-muted/30 px-3 py-2 text-sm text-foreground cursor-pointer">
              <input
                type="checkbox"
                data-testid="recruitment-post-doc-bhxh"
                disabled={formLocked}
                checked={draft.requireSocialInsuranceBook}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    requireSocialInsuranceBook: event.target.checked,
                  }))
                }
                className="h-4 w-4 rounded border-border"
              />
              <span>Sổ BHXH</span>
            </label>

            <div className="space-y-2 sm:col-span-2">
              <label className="inline-flex min-h-11 items-center gap-2.5 rounded-lg border border-border bg-surface-muted/30 px-3 py-2 text-sm text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="recruitment-post-doc-other"
                  disabled={formLocked}
                  checked={draft.requireOtherDocuments}
                  onChange={(event) =>
                    setDraft((prev) =>
                      setRecruitmentPostRequireOtherDocuments(
                        prev,
                        event.target.checked,
                      ),
                    )
                  }
                  className="h-4 w-4 rounded border-border"
                />
                <span>Giấy tờ khác</span>
              </label>

              {draft.requireOtherDocuments ? (
                <div className="space-y-1.5 pl-6">
                  <label
                    htmlFor="recruitment-post-field-other-documents-text"
                    className="block text-sm font-medium text-foreground"
                  >
                    Nội dung giấy tờ khác <span className="text-danger">*</span>
                  </label>
                  <input
                    id="recruitment-post-field-other-documents-text"
                    type="text"
                    data-testid="recruitment-post-input-other-documents-text"
                    readOnly={permissionRevokedReadOnly}
                    disabled={formLocked && !permissionRevokedReadOnly}
                    value={draft.otherDocumentsText}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        otherDocumentsText: event.target.value,
                      }))
                    }
                    aria-invalid={Boolean(fieldErrors.otherDocumentsText)}
                    placeholder="Ví dụ: Xác nhận thông tin cư trú CT07…"
                    className={INPUT_CLASS}
                  />
                  {fieldErrors.otherDocumentsText ? (
                    <p className="text-xs text-danger">
                      {fieldErrors.otherDocumentsText}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </section>

        {/* KHỐI XÁC NHẬN TRƯỚC KHI GỬI (6 MỤC ĐÃ KHÓA) */}
        <section
          aria-labelledby="recruitment-post-pre-submit-heading"
          data-testid="recruitment-post-pre-submit-summary"
          className="rounded-xl border border-primary/35 bg-primary/5 p-5 space-y-4 shadow-xs"
        >
          <div className="border-b border-border pb-2.5">
            <h2
              id="recruitment-post-pre-submit-heading"
              className="text-base font-semibold text-foreground"
            >
              Khối xác nhận trước khi gửi
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Vui lòng kiểm tra kỹ 6 thông tin cốt lõi bên dưới trước khi xác
              nhận lưu phiếu tuyển dụng.
            </p>
          </div>

          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div
              data-testid="recruitment-post-confirm-item-project"
              className="rounded-lg border border-border bg-surface p-3 space-y-1"
            >
              <dt className="text-xs font-medium text-muted">1. Dự án</dt>
              <dd className="font-semibold text-foreground break-words">
                {preSubmitSummary.projectDisplay}
              </dd>
            </div>

            <div
              data-testid="recruitment-post-confirm-item-location"
              className="rounded-lg border border-border bg-surface p-3 space-y-1"
            >
              <dt className="text-xs font-medium text-muted">
                2. Khu công nghiệp &amp; Tỉnh/Thành
              </dt>
              <dd className="font-semibold text-foreground break-words">
                {preSubmitSummary.industrialParkAndProvinceDisplay}
              </dd>
            </div>

            <div
              data-testid="recruitment-post-confirm-item-job"
              className="rounded-lg border border-border bg-surface p-3 space-y-1"
            >
              <dt className="text-xs font-medium text-muted">3. Công việc</dt>
              <dd className="font-semibold text-foreground break-words line-clamp-2">
                {preSubmitSummary.jobDescriptionDisplay}
              </dd>
            </div>

            <div
              data-testid="recruitment-post-confirm-item-headcount"
              className="rounded-lg border border-border bg-surface p-3 space-y-1"
            >
              <dt className="text-xs font-medium text-muted">
                4. Số lượng dự kiến
              </dt>
              <dd className="font-mono tabular-nums font-semibold text-foreground">
                {preSubmitSummary.expectedHeadcountDisplay}
              </dd>
            </div>

            <div
              data-testid="recruitment-post-confirm-item-income"
              className="rounded-lg border border-border bg-surface p-3 space-y-1"
            >
              <dt className="text-xs font-medium text-muted">
                5. Thu nhập bình quân dự kiến
              </dt>
              <dd className="font-mono tabular-nums font-semibold text-foreground">
                {preSubmitSummary.expectedIncomeDisplay}
              </dd>
            </div>

            <div
              data-testid="recruitment-post-confirm-item-contact"
              className="rounded-lg border border-border bg-surface p-3 space-y-1"
            >
              <dt className="text-xs font-medium text-muted">
                6. Liên hệ người phụ trách
              </dt>
              <dd className="font-semibold text-foreground break-words">
                {preSubmitSummary.managerContactDisplay}
              </dd>
            </div>
          </dl>

          <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
            <Link
              href="/recruitment-posts"
              className="inline-flex min-h-11 h-10 items-center justify-center rounded-md border border-border bg-surface px-4 text-sm font-medium text-foreground hover:bg-surface-muted/70"
            >
              Hủy
            </Link>
            <Button
              type="submit"
              variant="primary"
              size="md"
              data-testid="recruitment-post-submit-button"
              disabled={formLocked}
            >
              {submitting
                ? "Đang gửi dữ liệu…"
                : mode === "create"
                  ? "Xác nhận đăng phiếu tuyển dụng"
                  : "Xác nhận lưu cập nhật"}
            </Button>
          </div>
        </section>
      </form>

      <RecruitmentPostWithdrawDialog
        open={withdrawTarget !== null}
        target={withdrawTarget}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setWithdrawTarget(null);
          }
        }}
        onWithdrawn={(withdrawnPost) => {
          setWithdrawTarget(null);
          setSavedPost(withdrawnPost);
          setLoadedPost(withdrawnPost);
          setDraft(createEditRecruitmentPostFormDraftFromItem(withdrawnPost));
        }}
        onAccessRevoked={handleAccessRevoked}
        onLatestServerPostLoaded={(latestPost) => {
          setLoadedPost(latestPost);
          setDraft((prev) => ({
            ...prev,
            expectedVersion: latestPost.version,
          }));
        }}
      />
    </PageShell>
  );
}
