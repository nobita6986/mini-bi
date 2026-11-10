"use client";

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/ui/form-dialog";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  buildWithdrawRecruitmentPostRequestBody,
  classifyRecruitmentPostAccessLoss,
  extractRecruitmentPostErrorCode,
  formatRecruitmentPostTimestampVi,
  newIdempotencyKey,
  parseRecruitmentPostDetailEnvelope,
  recruitmentPostErrorMessage,
  resolveRecruitmentPostMutationOutcome,
  type RecruitmentPostAccessLossKind,
  type RecruitmentPostItem,
} from "@/lib/recruitment-posts/recruitment-post-ui-model";

export type RecruitmentPostWithdrawTarget = {
  readonly briefId: string;
  readonly expectedVersion: number;
  readonly projectName: string;
  readonly industrialParkName: string;
  readonly provinceName: string;
  readonly jobDescriptionDisplay: string;
};

type WithdrawDialogPendingIntent = {
  readonly idempotencyKey: string;
  readonly requestBody: { readonly expected_version: number };
};

export function RecruitmentPostWithdrawDialog({
  open,
  target,
  onOpenChange,
  onWithdrawn,
  onAccessRevoked,
  onLatestServerPostLoaded,
}: {
  open: boolean;
  target: RecruitmentPostWithdrawTarget | null;
  onOpenChange: (open: boolean) => void;
  onWithdrawn: (withdrawnPost: RecruitmentPostItem) => void;
  onAccessRevoked: (lossKind: RecruitmentPostAccessLossKind) => void;
  onLatestServerPostLoaded?: (post: RecruitmentPostItem) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [reloadingLatest, setReloadingLatest] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [staleConflictMessage, setStaleConflictMessage] = useState<
    string | null
  >(null);
  const [ambiguousLockMessage, setAmbiguousLockMessage] = useState<
    string | null
  >(null);
  const [pendingIntent, setPendingIntent] =
    useState<WithdrawDialogPendingIntent | null>(null);
  const [comparedServerPost, setComparedServerPost] =
    useState<RecruitmentPostItem | null>(null);

  const ambiguousRetryLocked = pendingIntent !== null && ambiguousLockMessage !== null;
  const closeDisabled = submitting || reloadingLatest || ambiguousRetryLocked;

  const resetLocalState = useCallback(() => {
    setSubmitting(false);
    setReloadingLatest(false);
    setErrorMessage(null);
    setStaleConflictMessage(null);
    setAmbiguousLockMessage(null);
    setPendingIntent(null);
    setComparedServerPost(null);
  }, []);

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && closeDisabled) {
        return;
      }
      if (!nextOpen) {
        resetLocalState();
      }
      onOpenChange(nextOpen);
    },
    [closeDisabled, onOpenChange, resetLocalState],
  );

  const executeWithdrawIntent = useCallback(
    async (briefId: string, intent: WithdrawDialogPendingIntent) => {
      setSubmitting(true);
      setErrorMessage(null);
      setStaleConflictMessage(null);

      try {
        const response = await fetch(
          `/api/recruitment-posts/${encodeURIComponent(briefId)}/withdraw`,
          {
            method: "POST",
            cache: "no-store",
            credentials: "same-origin",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "Idempotency-Key": intent.idempotencyKey,
            },
            body: JSON.stringify(intent.requestBody),
          },
        );

        const rawPayload = await response.json().catch(() => null);
        const outcome = resolveRecruitmentPostMutationOutcome({
          status: response.status,
          payload: rawPayload,
        });

        if (outcome.kind === "access_loss") {
          resetLocalState();
          onAccessRevoked(outcome.accessLoss);
          return;
        }

        if (outcome.kind === "ok") {
          setSubmitting(false);
          resetLocalState();
          onWithdrawn(outcome.result.post);
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
          setErrorMessage(outcome.message);
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
        setErrorMessage(outcome.message);
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
            : "Mất kết nối mạng trong lúc rút tin. Vui lòng thử lại cùng khóa định danh.",
        );
      }
    },
    [onAccessRevoked, onWithdrawn, resetLocalState],
  );

  const handleConfirmWithdraw = useCallback(() => {
    if (!target || submitting || reloadingLatest) return;

    const effectiveVersion =
      comparedServerPost?.version ?? target.expectedVersion;
    const built = buildWithdrawRecruitmentPostRequestBody(effectiveVersion);
    if (!built.ok) {
      setErrorMessage(built.message);
      return;
    }

    const intent: WithdrawDialogPendingIntent = {
      idempotencyKey: newIdempotencyKey(),
      requestBody: built.requestBody,
    };
    setPendingIntent(intent);
    void executeWithdrawIntent(target.briefId, intent);
  }, [
    comparedServerPost,
    executeWithdrawIntent,
    reloadingLatest,
    submitting,
    target,
  ]);

  const handleRetrySameIntent = useCallback(() => {
    if (!target || !pendingIntent || submitting || reloadingLatest) return;
    void executeWithdrawIntent(target.briefId, pendingIntent);
  }, [executeWithdrawIntent, pendingIntent, reloadingLatest, submitting, target]);

  const handleReloadToCompare = useCallback(async () => {
    if (!target || submitting || reloadingLatest) return;
    setReloadingLatest(true);
    setErrorMessage(null);

    try {
      const response = await fetch(
        `/api/recruitment-posts/${encodeURIComponent(target.briefId)}`,
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
        resetLocalState();
        onAccessRevoked(revoked);
        return;
      }

      if (!response.ok) {
        setReloadingLatest(false);
        setErrorMessage(recruitmentPostErrorMessage(errorCode));
        return;
      }

      const parsedDetail = parseRecruitmentPostDetailEnvelope(rawPayload);
      if (!parsedDetail) {
        setReloadingLatest(false);
        setErrorMessage(
          recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
        );
        return;
      }

      setReloadingLatest(false);
      setPendingIntent(null);
      setAmbiguousLockMessage(null);
      setStaleConflictMessage(null);
      setComparedServerPost(parsedDetail.post);
      onLatestServerPostLoaded?.(parsedDetail.post);

      if (parsedDetail.post.status === "WITHDRAWN") {
        onWithdrawn(parsedDetail.post);
      }
    } catch {
      setReloadingLatest(false);
      setErrorMessage(
        recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
      );
    }
  }, [
    onAccessRevoked,
    onLatestServerPostLoaded,
    onWithdrawn,
    reloadingLatest,
    resetLocalState,
    submitting,
    target,
  ]);

  const effectiveVersion =
    comparedServerPost?.version ?? target?.expectedVersion ?? 1;

  return (
    <FormDialog
      open={open}
      onOpenChange={handleDialogOpenChange}
      title="Xác nhận rút phiếu tuyển dụng"
      description="Phiếu tuyển dụng sau khi rút sẽ ngừng hiển thị trên danh sách chung nhưng vẫn giữ toàn bộ lịch sử để đối chiếu."
      descriptionId="recruitment-post-withdraw-description"
      closeAriaLabel="Đóng hộp thoại xác nhận rút tin"
      closeDisabled={closeDisabled}
      dataTestId="recruitment-post-withdraw-dialog"
    >
      {target ? (
        <div className="space-y-4">
          {errorMessage ? (
            <StatusBanner
              tone="error"
              title="Không thể rút phiếu tuyển dụng"
              dataTestId="recruitment-post-withdraw-error"
            >
              {errorMessage}
            </StatusBanner>
          ) : null}

          {staleConflictMessage ? (
            <StatusBanner
              tone="error"
              title="Dữ liệu phiếu tuyển dụng đã thay đổi"
              dataTestId="recruitment-post-withdraw-stale"
            >
              <div className="space-y-3">
                <p>{staleConflictMessage}</p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid="recruitment-post-withdraw-reload-compare"
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

          {ambiguousRetryLocked && ambiguousLockMessage ? (
            <StatusBanner
              tone="warning"
              title="Chưa xác nhận được kết quả rút tin"
              dataTestId="recruitment-post-withdraw-ambiguous-lock"
            >
              <div className="space-y-3">
                <p>{ambiguousLockMessage}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    data-testid="recruitment-post-withdraw-retry-same"
                    disabled={submitting || reloadingLatest}
                    onClick={handleRetrySameIntent}
                  >
                    {submitting ? "Đang gửi lại…" : "Gửi lại đúng yêu cầu"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    data-testid="recruitment-post-withdraw-reload-after-ambiguous"
                    disabled={submitting || reloadingLatest}
                    onClick={() => {
                      void handleReloadToCompare();
                    }}
                  >
                    {reloadingLatest
                      ? "Đang tải…"
                      : "Tải bản mới nhất để đối chiếu"}
                  </Button>
                </div>
              </div>
            </StatusBanner>
          ) : null}

          {comparedServerPost ? (
            <StatusBanner
              tone="info"
              title="Đã tải phiên bản mới nhất trên máy chủ"
              dataTestId="recruitment-post-withdraw-compared-banner"
            >
              <p>
                Phiên bản hiện tại: <strong>v{comparedServerPost.version}</strong>{" "}
                · Trạng thái:{" "}
                <strong>
                  {comparedServerPost.status === "WITHDRAWN"
                    ? "Đã rút"
                    : "Đang hiệu lực"}
                </strong>{" "}
                · Cập nhật lúc{" "}
                {formatRecruitmentPostTimestampVi(
                  comparedServerPost.updated_at,
                )}{" "}
                bởi {comparedServerPost.updated_by_display_name}.
              </p>
            </StatusBanner>
          ) : null}

          <div className="rounded-xl border border-border bg-surface-muted/40 p-3.5 text-sm space-y-1.5">
            <p className="text-foreground">
              <span className="font-medium text-muted">Dự án:</span>{" "}
              <strong>{target.projectName}</strong>
            </p>
            <p className="text-foreground">
              <span className="font-medium text-muted">Khu công nghiệp:</span>{" "}
              {target.industrialParkName} ({target.provinceName})
            </p>
            <p className="text-foreground break-words">
              <span className="font-medium text-muted">Công việc:</span>{" "}
              {target.jobDescriptionDisplay}
            </p>
            <p className="text-xs text-muted font-mono tabular-nums">
              Phiên bản đối chiếu: v{effectiveVersion}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="secondary"
              size="md"
              disabled={closeDisabled}
              onClick={() => handleDialogOpenChange(false)}
            >
              Hủy
            </Button>
            <Button
              type="button"
              variant="danger"
              size="md"
              data-testid="recruitment-post-withdraw-confirm"
              disabled={
                submitting ||
                reloadingLatest ||
                ambiguousRetryLocked ||
                comparedServerPost?.status === "WITHDRAWN"
              }
              onClick={handleConfirmWithdraw}
            >
              {submitting ? "Đang rút tin…" : "Xác nhận rút tin"}
            </Button>
          </div>
        </div>
      ) : null}
    </FormDialog>
  );
}
