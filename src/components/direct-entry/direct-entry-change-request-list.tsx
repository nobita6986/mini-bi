"use client";

/**
 * P1.6-W04-S04C-S03B1 - Khu "Yêu cầu thay đổi": danh sach change request cua actor.
 *
 * Chi dung projection tu projectChangeRequestListPage (entry_ids, item_count, state, version,
 * created_at, co rut duoc hay khong, co duyet duoc hay khong). Danh sach KHONG goi change-request
 * detail endpoint va KHONG render raw proposal/JSON: chi mo dialog reviewer khi nguoi dung bam
 * "Xem xet" (S03B2). can_decide chi la display hint; quyen that do server quyet dinh.
 */
import { useState } from "react";
import { AlertDialog } from "radix-ui";

import {
  canWithdrawChangeRequest,
  CHANGE_REQUEST_STATE_LABELS,
} from "@/lib/direct-entry/change-request-proposer";
import type { ChangeRequestListItem } from "@/lib/direct-entry/change-request-read-contract";
import { formatHcmDateTime, shortRef } from "@/lib/direct-entry/submission-lifecycle";

import styles from "./direct-entry-shell.module.css";

export type ChangeRequestListProps = {
  state: "loading" | "ready" | "error";
  message: string;
  requests: readonly ChangeRequestListItem[];
  hasMore: boolean;
  busyRequestId: string | null;
  compact?: boolean;
  onLoadMore: () => void;
  onWithdraw: (request: ChangeRequestListItem) => void;
  onReview: (request: ChangeRequestListItem) => void;
};

/** Chi PENDING + can_decide (server-derived) moi hien nut "Xem xet". */
function canReviewChangeRequest(
  request: Pick<ChangeRequestListItem, "state" | "can_decide">,
): boolean {
  return request.state === "PENDING" && request.can_decide === true;
}

function ChangeRequestListContent({
  state,
  message,
  requests,
  hasMore,
  busyRequestId,
  compact = false,
  onLoadMore,
  onWithdraw,
  onReview,
}: ChangeRequestListProps) {
  const [pendingWithdraw, setPendingWithdraw] = useState<ChangeRequestListItem | null>(null);

  return (
    <section
      className={compact ? styles.changeRequestContent : styles.submissionSection}
      aria-labelledby="direct-entry-change-requests-heading"
    >
      <div className={styles.submissionHead}>
        <div>
          {!compact && (
            <h2 id="direct-entry-change-requests-heading" className={styles.submissionTitle}>
              Yêu cầu thay đổi
            </h2>
          )}
          <p className={styles.submissionHint}>
            Yêu cầu thay đổi áp dụng cho đợt đã gửi chính thức. Người đề xuất rút được yêu cầu khi
            còn chờ duyệt; người có quyền duyệt mở “Xem xét” để đối chiếu và quyết định.
          </p>
        </div>
        {hasMore && (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onLoadMore}
            disabled={state === "loading"}
          >
            Tải thêm yêu cầu cũ hơn
          </button>
        )}
      </div>

      <div className={styles.notice} aria-live="polite">
        {state === "loading" && "Đang tải danh sách yêu cầu thay đổi…"}
        {state === "error" && `Không tải được danh sách yêu cầu thay đổi (${message}).`}
        {state === "ready" && requests.length === 0 &&
          "Chưa có yêu cầu thay đổi nào. Mở một đợt ở trạng thái đã gửi chính thức để đề xuất thay đổi."}
      </div>

      <ul className={compact ? styles.changeRequestList : styles.submissionList}>
        {requests.map((request) => {
          const busy = busyRequestId === request.request_id;
          return (
            <li
              key={request.request_id}
              className={compact ? styles.changeRequestCard : styles.submissionCard}
            >
              <div className={styles.submissionCardTop}>
                <strong>{CHANGE_REQUEST_STATE_LABELS[request.state]}</strong>
                <span className={styles.submissionRef} title="Mã kỹ thuật rút gọn">
                  Mã {shortRef(request.request_id)}
                </span>
              </div>
              <dl className={compact ? styles.changeRequestMeta : styles.submissionMeta}>
                <div><dt>Số dòng</dt><dd>{request.item_count}</dd></div>
                <div><dt>Tạo lúc</dt><dd>{formatHcmDateTime(request.created_at)}</dd></div>
                <div><dt>Phiên bản</dt><dd>{request.version}</dd></div>
              </dl>
              <div className={compact ? styles.changeRequestActions : styles.submissionActions}>
                {canWithdrawChangeRequest(request) && (
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    aria-busy={busy}
                    disabled={busy}
                    onClick={() => setPendingWithdraw(request)}
                  >
                    {busy ? "Đang rút…" : "Rút yêu cầu"}
                  </button>
                )}
                {canReviewChangeRequest(request) && (
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => onReview(request)}
                  >
                    Xem xét
                  </button>
                )}
                {!canWithdrawChangeRequest(request) && !canReviewChangeRequest(request) &&
                  request.state === "PENDING" && (
                  <span className={styles.submissionHint}>
                    Chỉ người đề xuất rút được và người có quyền mới duyệt được yêu cầu này.
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <AlertDialog.Root open={pendingWithdraw !== null} onOpenChange={(open) => {
        if (!open) setPendingWithdraw(null);
      }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={styles.drawerOverlay} />
          {pendingWithdraw && (
            <AlertDialog.Content className={styles.confirmDialog}>
              <AlertDialog.Title className={styles.drawerTitle}>
                Rút yêu cầu thay đổi?
              </AlertDialog.Title>
              <AlertDialog.Description className={styles.drawerDescription}>
                Yêu cầu sẽ chuyển sang trạng thái đã rút và không còn chờ duyệt. Dữ liệu chính thức
                không thay đổi.
              </AlertDialog.Description>
              <div className={styles.drawerActions}>
                <AlertDialog.Cancel asChild>
                  <button type="button" className={styles.secondaryButton}>Hủy</button>
                </AlertDialog.Cancel>
                <AlertDialog.Action asChild>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={() => {
                      const current = pendingWithdraw;
                      setPendingWithdraw(null);
                      onWithdraw(current);
                    }}
                  >
                    Rút yêu cầu
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

export function DirectEntryChangeRequestList(props: ChangeRequestListProps) {
  if (!props.compact) return <ChangeRequestListContent {...props} />;

  const pendingCount = props.requests.filter((request) => request.state === "PENDING").length;
  const hasError = props.state === "error" || props.message !== "";

  return (
    <details className={styles.changeRequestPanel}>
      <summary className={styles.changeRequestSummary}>
        <h2 id="direct-entry-change-requests-heading" className={styles.changeRequestTitle}>
          Yêu cầu thay đổi
        </h2>
        <span>{props.requests.length} đã tải</span>
        {pendingCount > 0 && <span>{pendingCount} đang chờ xử lý</span>}
        {hasError && <span className={styles.changeRequestError}>Không tải được</span>}
        {props.state === "loading" && <span role="status">Đang tải…</span>}
        <span className={styles.changeRequestToggle}>Mở / thu gọn</span>
      </summary>
      <ChangeRequestListContent {...props} compact />
    </details>
  );
}
