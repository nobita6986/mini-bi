"use client";

/**
 * P1.6-W04-S04C-S03B1 - Khu "Yêu cầu thay đổi": danh sach change request cua actor.
 *
 * Chi dung projection tu projectChangeRequestListPage (entry_ids, item_count, state, version,
 * created_at, co rut duoc hay khong). KHONG goi change-request detail endpoint, KHONG render
 * raw proposal/JSON. Co duoc duyet hay khong KHONG tao nut approve/reject trong S03B1 (reviewer UI defer).
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
  onLoadMore: () => void;
  onWithdraw: (request: ChangeRequestListItem) => void;
};

export function DirectEntryChangeRequestList({
  state,
  message,
  requests,
  hasMore,
  busyRequestId,
  onLoadMore,
  onWithdraw,
}: ChangeRequestListProps) {
  const [pendingWithdraw, setPendingWithdraw] = useState<ChangeRequestListItem | null>(null);

  return (
    <section className={styles.submissionSection} aria-labelledby="direct-entry-change-requests-heading">
      <div className={styles.submissionHead}>
        <div>
          <h2 id="direct-entry-change-requests-heading" className={styles.submissionTitle}>
            Yêu cầu thay đổi
          </h2>
          <p className={styles.submissionHint}>
            Yêu cầu thay đổi áp dụng cho đợt đã gửi chính thức. Chỉ người đề xuất rút được khi yêu cầu
            còn chờ duyệt; duyệt hoặc từ chối sẽ do bước sau triển khai.
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

      <ul className={styles.submissionList}>
        {requests.map((request) => {
          const busy = busyRequestId === request.request_id;
          return (
            <li key={request.request_id} className={styles.submissionCard}>
              <div className={styles.submissionCardTop}>
                <strong>{CHANGE_REQUEST_STATE_LABELS[request.state]}</strong>
                <span className={styles.submissionRef} title="Mã kỹ thuật rút gọn">
                  Mã {shortRef(request.request_id)}
                </span>
              </div>
              <dl className={styles.submissionMeta}>
                <div><dt>Số dòng</dt><dd>{request.item_count}</dd></div>
                <div><dt>Tạo lúc</dt><dd>{formatHcmDateTime(request.created_at)}</dd></div>
                <div><dt>Phiên bản</dt><dd>{request.version}</dd></div>
              </dl>
              <div className={styles.submissionActions}>
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
                {!canWithdrawChangeRequest(request) && request.state === "PENDING" && (
                  <span className={styles.submissionHint}>
                    Chỉ người đề xuất rút được yêu cầu này.
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
