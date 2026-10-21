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

import { DirectEntryCompactPanel } from "@/components/direct-entry/direct-entry-compact-panel";
import { DirectEntryQueueTabs } from "@/components/direct-entry/direct-entry-queue-tabs";
import {
  canWithdrawChangeRequest,
  CHANGE_REQUEST_STATE_LABELS,
} from "@/lib/direct-entry/change-request-proposer";
import type { ChangeRequestListItem } from "@/lib/direct-entry/change-request-read-contract";
import type { ChangeRequestQueueFilter } from "@/lib/direct-entry/change-request-read-contract";
import { formatHcmDateTime, shortRef } from "@/lib/direct-entry/submission-lifecycle";

import styles from "./direct-entry-shell.module.css";

const QUEUE_TABS = [
  { value: "PENDING", label: "Chờ duyệt" },
  { value: "RESOLVED", label: "Đã xử lý" },
  { value: "GLOBAL_AUDIT", label: "Lịch sử duyệt" },
] as const;

export const PROPOSER_QUEUE_TABS = [
  { value: "PROPOSER_PENDING", label: "Tôi đã gửi" },
  { value: "PROPOSER_RESOLVED", label: "Lịch sử gửi" },
] as const;

export const REVIEWER_QUEUE_TABS = [
  { value: "REVIEWER_PENDING", label: "Chờ tôi duyệt" },
  { value: "REVIEWER_RESOLVED", label: "Lịch sử duyệt" },
] as const;

export const GLOBAL_AUDIT_QUEUE_TAB = {
  value: "GLOBAL_AUDIT",
  label: "Lịch sử toàn hệ thống",
} as const;

export type ChangeRequestQueueTabItem = {
  value: ChangeRequestQueueFilter;
  label: string;
};

export type ChangeRequestListProps = {
  state: "loading" | "ready" | "error";
  message: string;
  requests: readonly ChangeRequestListItem[];
  hasMore: boolean;
  busyRequestId: string | null;
  compact?: boolean;
  queueFilter: ChangeRequestQueueFilter;
  tabs?: readonly ChangeRequestQueueTabItem[];
  canViewGlobalHistory?: boolean;
  onQueueFilterChange: (filter: ChangeRequestQueueFilter) => void;
  onGlobalHistoryAgeFilterChange?: (filter: ResolvedAgeFilter) => void;
  onLoadMore: () => void;
  onWithdraw: (request: ChangeRequestListItem) => void;
  onReview: (request: ChangeRequestListItem) => void;
};

export type ResolvedAgeFilter = "3" | "7" | "30" | "all";

function isWithinResolvedAge(
  request: ChangeRequestListItem,
  filter: ResolvedAgeFilter,
  audit: boolean,
): boolean {
  const timestamp = audit ? request.decided_at : request.created_at;
  if (typeof timestamp !== "string") return false;
  return filter === "all" ||
    Date.parse(timestamp) >= Date.now() - Number(filter) * 24 * 60 * 60 * 1000;
}

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
  queueFilter,
  tabs,
  canViewGlobalHistory,
  resolvedAgeFilter,
  onResolvedAgeFilterChange,
  loadedRequestCount,
  onQueueFilterChange,
  onGlobalHistoryAgeFilterChange,
  onLoadMore,
  onWithdraw,
  onReview,
}: ChangeRequestListProps & {
  resolvedAgeFilter: ResolvedAgeFilter;
  onResolvedAgeFilterChange: (filter: ResolvedAgeFilter) => void;
  loadedRequestCount: number;
}) {
  const [pendingWithdraw, setPendingWithdraw] = useState<ChangeRequestListItem | null>(null);

  return (
    <section
      className={compact ? styles.compactListSection : styles.submissionSection}
      aria-labelledby={compact ? undefined : "direct-entry-change-requests-heading"}
      aria-label={compact ? "Danh sách yêu cầu thay đổi" : undefined}
    >
      <div className={styles.submissionHead}>
        <div>
          {!compact && (
            <h2 id="direct-entry-change-requests-heading" className={styles.submissionTitle}>
              Yêu cầu thay đổi
            </h2>
          )}
          {!compact && (
            <p className={styles.submissionHint}>
              Yêu cầu thay đổi áp dụng cho đợt đã gửi chính thức. Người đề xuất rút được yêu cầu khi
              còn chờ duyệt; người có quyền duyệt mở “Xem xét” để đối chiếu và quyết định.
            </p>
          )}
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

      <DirectEntryQueueTabs
        ariaLabel="Trạng thái yêu cầu thay đổi"
        panelId="change-request-queue-panel"
        value={queueFilter}
        tabs={tabs ?? (canViewGlobalHistory ? QUEUE_TABS : QUEUE_TABS.slice(0, 2))}
        onChange={onQueueFilterChange}
      >
      {(queueFilter === "RESOLVED" || queueFilter === "GLOBAL_AUDIT") && (
        <label className={styles.field}>
          {queueFilter === "GLOBAL_AUDIT" ? "Lịch sử toàn hệ thống" : "Lịch sử đã xử lý"}
          <select aria-label="Khoảng thời gian đề xuất đã xử lý" value={resolvedAgeFilter}
            onChange={(event) => {
              const filter = event.target.value as ResolvedAgeFilter;
              onResolvedAgeFilterChange(filter);
              onGlobalHistoryAgeFilterChange?.(filter);
            }}>
            <option value="3">3 ngày gần nhất</option>
            <option value="7">7 ngày gần nhất</option>
            <option value="30">30 ngày gần nhất</option>
            <option value="all">Toàn bộ lịch sử</option>
          </select>
        </label>
      )}
      <div className={styles.notice} aria-live="polite">
        {state === "loading" && "Đang tải danh sách yêu cầu thay đổi…"}
        {state === "error" && `Không tải được danh sách yêu cầu thay đổi (${message}).`}
        {state === "ready" && requests.length === 0 && loadedRequestCount === 0 &&
          (queueFilter === "GLOBAL_AUDIT"
            ? "Chưa có lịch sử duyệt trong khoảng thời gian đang chọn."
            : queueFilter === "REVIEWER_PENDING"
              ? "Chưa có yêu cầu thay đổi nào đang chờ bạn duyệt."
              : queueFilter === "REVIEWER_RESOLVED"
                ? "Bạn chưa duyệt hoặc từ chối yêu cầu thay đổi nào."
                : queueFilter === "PROPOSER_RESOLVED"
                  ? "Chưa có lịch sử yêu cầu thay đổi đã gửi."
                  : "Chưa có yêu cầu thay đổi nào. Mở một đợt ở trạng thái đã gửi chính thức để đề xuất thay đổi.")}
        {state === "ready" && requests.length === 0 && loadedRequestCount > 0 &&
          (queueFilter === "GLOBAL_AUDIT"
            ? "Chưa có lịch sử duyệt trong khoảng thời gian đang chọn."
            : "Không có đề xuất đã xử lý trong khoảng thời gian đang chọn.")}
      </div>

      <div className={compact ? styles.compactListViewport : undefined}>
      <ul className={compact ? styles.compactList : styles.submissionList}>
        {requests.map((request) => {
          const busy = busyRequestId === request.request_id;
          return (
            <li
              key={request.request_id}
              className={compact ? styles.compactCard : styles.submissionCard}
            >
              <div className={styles.submissionCardTop}>
                <strong>{CHANGE_REQUEST_STATE_LABELS[request.state]}</strong>
                <span className={styles.submissionRef} title="Mã kỹ thuật rút gọn">
                  Mã {shortRef(request.request_id)}
                </span>
              </div>
              <p className={styles.changeRequestSummary} data-testid="change-request-summary">
                {request.summary}
              </p>
              <p className={styles.submissionHint} data-testid="change-request-proposer">
                Người đề xuất: {request.proposer_display_name}
              </p>
              {queueFilter === "GLOBAL_AUDIT" && typeof request.decided_by_display_name === "string" &&
                typeof request.decided_at === "string" && (
                <p className={styles.submissionHint} data-testid="change-request-decision-audit">
                  Người xử lý: {request.decided_by_display_name} · {formatHcmDateTime(request.decided_at)}
                </p>
              )}
              <dl className={compact ? styles.compactMeta : styles.submissionMeta}>
                <div><dt>Số dòng</dt><dd>{request.item_count}</dd></div>
                <div><dt>Tạo lúc</dt><dd>{formatHcmDateTime(request.created_at)}</dd></div>
              </dl>
              <div className={compact ? styles.compactActions : styles.submissionActions}>
                {canReviewChangeRequest(request) && (
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={() => onReview(request)}
                  >
                    Xem xét
                  </button>
                )}
                {!canReviewChangeRequest(request) && (
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => onReview(request)}
                  >
                    Xem chi tiết
                  </button>
                )}
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
      </div>
      </DirectEntryQueueTabs>

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
  const [resolvedAgeFilter, setResolvedAgeFilter] = useState<ResolvedAgeFilter>("3");
  const visibleRequests = props.queueFilter === "RESOLVED" || props.queueFilter === "GLOBAL_AUDIT"
    ? props.requests.filter((request) =>
      isWithinResolvedAge(request, resolvedAgeFilter, props.queueFilter === "GLOBAL_AUDIT"))
    : props.requests;
  const contentProps = {
    ...props,
    requests: visibleRequests,
    resolvedAgeFilter,
    onResolvedAgeFilterChange: setResolvedAgeFilter,
    loadedRequestCount: props.requests.length,
  };
  if (!props.compact) return <ChangeRequestListContent {...contentProps} />;

  const displayedCount = visibleRequests.length;
  return (
    <DirectEntryCompactPanel
      title="Yêu cầu thay đổi"
      loadedCount={visibleRequests.length}
      badges={[{ count: displayedCount,
        label: props.queueFilter === "PENDING" || props.queueFilter === "PROPOSER_PENDING" ||
          props.queueFilter === "REVIEWER_PENDING"
          ? "đang chờ xử lý"
          : props.queueFilter === "GLOBAL_AUDIT" ? "lịch sử duyệt" : "đã xử lý" }]}
      state={props.state}
    >
      <ChangeRequestListContent {...contentProps} compact />
    </DirectEntryCompactPanel>
  );
}
