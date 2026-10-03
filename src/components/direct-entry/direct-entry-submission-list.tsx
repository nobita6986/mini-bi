"use client";

/**
 * P1.6-W04-S04C-S03A - Khu "Đợt nhập liệu": danh sách submission + hanh dong vong doi.
 *
 * Component trinh bay + Radix AlertDialog cho confirm. Khong tu goi API, khong tu danh gia quyen:
 * moi hanh dong dua tren allowed_transitions do server tra ve (xem actionsForSubmission).
 * Khong viet focus trap/modal/keyboard handler thu cong - Radix lo phan do.
 */
import { useState } from "react";
import { AlertDialog } from "radix-ui";

import {
  actionsForSubmission,
  formatHcmDateTime,
  shortRef,
  SUBMISSION_STATE_LABELS,
  type SubmissionAction,
} from "@/lib/direct-entry/submission-lifecycle";
import type { SubmissionReadItem } from "@/lib/direct-entry/submission-read-contract";

import styles from "./direct-entry-shell.module.css";

export type SubmissionListProps = {
  state: "loading" | "ready" | "error";
  message: string;
  submissions: readonly SubmissionReadItem[];
  hasMore: boolean;
  busySubmissionId: string | null;
  blockedSubmissionIds: ReadonlySet<string>;
  onLoadMore: () => void;
  onTransition: (input: { submission: SubmissionReadItem; action: SubmissionAction }) => void;
  onRequestChange: (submission: SubmissionReadItem) => void;
  onManageDocuments: (submission: SubmissionReadItem) => void;
};

type PendingConfirm = { submission: SubmissionReadItem; action: SubmissionAction };

export function DirectEntrySubmissionList({
  state,
  message,
  submissions,
  hasMore,
  busySubmissionId,
  blockedSubmissionIds,
  onLoadMore,
  onTransition,
  onRequestChange,
  onManageDocuments,
}: SubmissionListProps) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [blockedNotice, setBlockedNotice] = useState<string | null>(null);

  function requestAction(submission: SubmissionReadItem, action: SubmissionAction) {
    if (action.target_state === "REVIEW" && blockedSubmissionIds.has(submission.submission_id)) {
      setBlockedNotice(
        "Còn dòng chưa được máy chủ xác nhận trong đợt này. Hãy lưu nháp trước khi gửi duyệt.",
      );
      return;
    }
    setBlockedNotice(null);
    setPending({ submission, action });
  }

  return (
    <section className={styles.submissionSection} aria-labelledby="direct-entry-submissions-heading">
      <div className={styles.submissionHead}>
        <div>
          <h2 id="direct-entry-submissions-heading" className={styles.submissionTitle}>Đợt nhập liệu</h2>
          <p className={styles.submissionHint}>
            Trạng thái được tải từ máy chủ; tải lại trang vẫn giữ đúng đợt đang ở bản nháp, chờ duyệt hoặc đã gửi.
          </p>
        </div>
        {hasMore && (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onLoadMore}
            disabled={state === "loading"}
          >
            Tải thêm đợt cũ hơn
          </button>
        )}
      </div>

      <div className={styles.notice} aria-live="polite">
        {state === "loading" && "Đang tải danh sách đợt nhập liệu…"}
        {state === "error" && `Không tải được danh sách đợt nhập liệu (${message}).`}
        {state === "ready" && submissions.length === 0 &&
          "Chưa có đợt nhập liệu nào. Dòng mới sẽ tạo đợt ở trạng thái bản nháp khi được lưu."}
      </div>

      {blockedNotice && <p className={styles.submissionBlocked} role="alert">{blockedNotice}</p>}

      <ul className={styles.submissionList}>
        {submissions.map((submission) => {
          const actions = actionsForSubmission(submission);
          const busy = busySubmissionId === submission.submission_id;
          const terminal = submission.state === "SUBMITTED";
          return (
            <li key={submission.submission_id} className={styles.submissionCard}>
              <div className={styles.submissionCardTop}>
                <strong>{SUBMISSION_STATE_LABELS[submission.state]}</strong>
                <span className={styles.submissionRef} title="Mã kỹ thuật rút gọn">
                  Mã {shortRef(submission.submission_id)}
                </span>
              </div>
              <dl className={styles.submissionMeta}>
                <div><dt>Số dòng</dt><dd>{submission.entry_count}</dd></div>
                <div><dt>Cập nhật</dt><dd>{formatHcmDateTime(submission.updated_at)}</dd></div>
                <div><dt>Phiên bản</dt><dd>{submission.version}</dd></div>
              </dl>
              {terminal && (
                <p className={styles.submissionTerminalNote}>
                  Đã gửi chính thức là trạng thái cuối. Thay đổi sau đó phải đi qua yêu cầu thay đổi.
                </p>
              )}
              <div className={styles.submissionActions}>
                {actions.map((action) => (
                  <button
                    key={action.target_state}
                    type="button"
                    className={action.target_state === "SUBMITTED" ? styles.primaryButton : styles.secondaryButton}
                    aria-busy={busy}
                    disabled={busy}
                    onClick={() => requestAction(submission, action)}
                  >
                    {busy ? "Đang gửi…" : action.label}
                  </button>
                ))}
                {actions.length === 0 && !terminal && (
                  <span className={styles.submissionHint}>Đợt này hiện không có thao tác nào.</span>
                )}
                {terminal && (
                  <>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={() => onRequestChange(submission)}
                    >
                      Yêu cầu thay đổi
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => onManageDocuments(submission)}
                    >
                      Quản lý tài liệu
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <AlertDialog.Root open={pending !== null} onOpenChange={(open) => {
        if (!open) setPending(null);
      }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={styles.drawerOverlay} />
          {pending && (
            <AlertDialog.Content className={styles.confirmDialog}>
              <AlertDialog.Title className={styles.drawerTitle}>
                {pending.action.confirm_title}
              </AlertDialog.Title>
              <AlertDialog.Description className={styles.drawerDescription}>
                {pending.action.confirm_description}
              </AlertDialog.Description>
              <p className={styles.submissionHint}>
                {SUBMISSION_STATE_LABELS[pending.submission.state]} · {pending.submission.entry_count} dòng · phiên bản {" "}
                {pending.submission.version}
              </p>
              <div className={styles.drawerActions}>
                <AlertDialog.Cancel asChild>
                  <button type="button" className={styles.secondaryButton}>Hủy</button>
                </AlertDialog.Cancel>
                <AlertDialog.Action asChild>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={() => {
                      const current = pending;
                      setPending(null);
                      onTransition({ submission: current.submission, action: current.action });
                    }}
                  >
                    {pending.action.confirm_label}
                  </button>
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          )}
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
