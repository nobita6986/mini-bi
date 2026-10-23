import { isActiveJobStatus, isFailedJobStatus } from "@/lib/ai-report/report-contract";
import type { NotifyActionProps, NotifyApi } from "@/components/ui/notify-store";

export type BlobValidationOutcome =
  | { ok: true }
  | { ok: false; reason: "EMPTY_BLOB" | "UNEXPECTED_CONTENT_TYPE" | "CORRUPT_ARCHIVE" };

export type AiJobPollState = "idle" | "polling" | "error";

const ERROR_PAYLOAD_MIME_TYPES = new Set([
  "application/json",
  "application/problem+json",
  "text/plain",
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
]);

function normalizeMimeType(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw.toLowerCase().split(";")[0]?.trim() ?? "";
}

/**
 * Xác minh Blob tải về thực sự có dữ liệu sử dụng được trước khi kích hoạt tải file
 * và báo Toast thành công (UIUX-S2-06):
 * - Từ chối Blob rỗng (`size <= 0`) hoặc không hợp lệ.
 * - Từ chối payload JSON/HTML/text lỗi bị trả kèm HTTP 200 ngoài ý muốn (trừ khi MIME đó nằm trong `allowedMimeTypes`).
 */
export function validateDownloadableExportBlob(input: {
  blob: { size: number; type?: string } | null | undefined;
  contentTypeHeader?: string | null;
  allowedMimeTypes?: readonly string[];
}): BlobValidationOutcome {
  const { blob, contentTypeHeader, allowedMimeTypes } = input;
  if (!blob || typeof blob.size !== "number" || !Number.isFinite(blob.size) || blob.size <= 0) {
    return { ok: false, reason: "EMPTY_BLOB" };
  }

  const allowedSet = new Set(
    (allowedMimeTypes ?? []).map((mime) => normalizeMimeType(mime)).filter(Boolean),
  );
  const headerMime = normalizeMimeType(contentTypeHeader);
  const blobMime = normalizeMimeType(blob.type);
  const effectiveMime = headerMime || blobMime;

  if (effectiveMime && !allowedSet.has(effectiveMime)) {
    if (ERROR_PAYLOAD_MIME_TYPES.has(effectiveMime)) {
      return { ok: false, reason: "UNEXPECTED_CONTENT_TYPE" };
    }
    if (allowedSet.size > 0 && effectiveMime !== "application/octet-stream") {
      return { ok: false, reason: "UNEXPECTED_CONTENT_TYPE" };
    }
  }

  return { ok: true };
}

/**
 * Kiểm tra nội dung HTML báo cáo xuất ngoại tuyến thực sự hoàn chỉnh trước khi tạo Blob tải về.
 */
export function validateHtmlExportDocument(html: string | null | undefined): boolean {
  if (typeof html !== "string") return false;
  const trimmed = html.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  return lower.includes("<!doctype html>") && lower.includes("</html>");
}

/**
 * Xác định job báo cáo AI đang ở pha xử lý bất định (indeterminate) theo đúng `ACTIVE_JOB_STATUSES`
 * (`requested | queued | computing | ai_generating | validating`) để hiển thị tiến trình không phần trăm giả.
 */
export function isIndeterminateAiJobRunning(status: string | null | undefined): boolean {
  return isActiveJobStatus(status);
}

/**
 * Thanh `<progress>` bất định chỉ được phép chạy khi job đang ở pha active VÀ vòng lặp polling
 * thực sự còn đang hoạt động (`pollState === "polling"`). Nếu một lượt poll gặp lỗi mạng/projection
 * khiến controller dừng lập lịch, progress phải dừng ngay để không báo "đang chạy" giả.
 */
export function shouldShowAiJobProgress(
  status: string | null | undefined,
  pollState: AiJobPollState,
): boolean {
  return pollState === "polling" && isActiveJobStatus(status);
}

export type TrackedJobToast = {
  jobId: string;
  toastId: string;
};

/**
 * Khởi tạo hoặc tái kích hoạt (re-track) Toast `pending` cho một job báo cáo AI theo `dedupeKey` ổn định:
 * - Nếu đang theo dõi một job khác thì đóng Toast cũ trước.
 * - Gọi `notify.pending` với cùng `dedupeKey` (`countBurst: false`) để tái sử dụng nguyên `toastId`
 *   tại chỗ (kể cả khi khôi phục từ Toast lỗi mạng), xóa action cũ mà không tự đóng Toast.
 */
export function startOrRetrackAiJobToast(params: {
  currentTracker: TrackedJobToast | null;
  jobId: string;
  title: string;
  notify: Pick<NotifyApi, "pending" | "dismiss">;
}): TrackedJobToast {
  const { currentTracker, jobId, title, notify } = params;
  if (currentTracker && currentTracker.jobId !== jobId) {
    notify.dismiss(currentTracker.toastId);
  }
  const toastId = notify.pending({
    title,
    dedupeKey: "ai-report-job:" + jobId,
    countBurst: false,
  });
  return { jobId, toastId };
}

/**
 * Tạo action "Kiểm tra lại" an toàn (chỉ-đọc, gọi lại polling, không tạo job mới) cho Toast lỗi polling AI.
 * Tuyệt đối KHÔNG bật `dismissOnAction: true` vì `onRecheck` gọi `notify.pending` cùng `dedupeKey`
 * để chuyển chính Toast hiện tại về `pending`; nếu `dismissOnAction: true`, `executeToastActionClick`
 * sẽ gọi `onDismiss()` ngay sau `onClick()` và đóng mất chính Toast `pending` vừa khôi phục.
 */
export function buildAiJobRecheckRetryAction(params: {
  jobId: string;
  isMounted: () => boolean;
  onRecheck: (jobId: string) => void;
}): NotifyActionProps {
  const { jobId, isMounted, onRecheck } = params;
  return {
    kind: "retry",
    safeToRetry: true,
    isValid: isMounted,
    label: "Kiểm tra lại",
    onClick: () => {
      onRecheck(jobId);
    },
  };
}

/**
 * Cập nhật tại chỗ (in-place) cùng một Toast từ trạng thái `pending` sang `success` hoặc `error`
 * khi job bất đồng bộ hoàn tất hoặc thất bại (không phát thông báo thứ hai gây trùng lặp).
 */
export function settleTrackedJobToast(params: {
  tracker: TrackedJobToast | null;
  incomingJobId: string;
  status: string | null;
  errorCode: string | null;
  transportError?: string | null;
  retryAction?: NotifyActionProps;
  codeToText: (code: string) => string;
  notify: Pick<NotifyApi, "update">;
}): {
  settled: boolean;
  nextTracker: TrackedJobToast | null;
} {
  const {
    tracker,
    incomingJobId,
    status,
    errorCode,
    transportError,
    retryAction,
    codeToText,
    notify,
  } = params;

  if (!tracker || tracker.jobId !== incomingJobId) {
    return { settled: false, nextTracker: tracker };
  }

  if (typeof transportError === "string" && transportError.trim().length > 0) {
    notify.update(tracker.toastId, {
      tone: "error",
      title: transportError,
      pending: false,
      action: retryAction ?? null,
    });
    return { settled: true, nextTracker: null };
  }

  if (status === "draft" || status === "completed") {
    notify.update(tracker.toastId, {
      tone: "success",
      title: "Báo cáo AI đã sẵn sàng.",
      pending: false,
      action: null,
    });
    return { settled: true, nextTracker: null };
  }

  if (status && isFailedJobStatus(status)) {
    notify.update(tracker.toastId, {
      tone: "error",
      title: codeToText(errorCode ?? "AI_INTERNAL"),
      pending: false,
      action: null,
    });
    return { settled: true, nextTracker: null };
  }

  return { settled: false, nextTracker: tracker };
}
