"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { isCanonicalNationalId } from "@/lib/contracts/national-id";
import {
  CCCD_QR_EXTRACTION_STATUS_LABELS,
  CCCD_QR_FAILURE_LABELS,
  CCCD_RECONCILIATION_STATUS_LABELS,
  type CccdReconciliationStatus,
} from "@/lib/direct-entry/cccd-qr-contract";
import {
  buildCccdReviewQueueQuery,
  CCCD_REVIEW_DEFAULT_PAGE_SIZE,
  CCCD_REVIEW_FILTER_LABELS,
  CCCD_REVIEW_FILTER_STATUSES,
  CCCD_REVIEW_PAGE_SIZE_OPTIONS,
  CCCD_REVIEW_STANDARDIZE_FIELD_LABELS,
  CCCD_REVIEW_STANDARDIZE_FIELDS,
  cccdReviewErrorMessage,
  maskCccdValue,
  projectCccdReviewQueueResponse,
  type CccdReviewFilterStatus,
  type CccdReviewQueueItem,
  type CccdReviewQueuePage,
  type CccdReviewStandardizeField,
} from "@/lib/direct-entry/cccd-review-contract";

type PanelState =
  | { kind: "loading" }
  | { kind: "loaded"; page: CccdReviewQueuePage }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "error" };

const buttonClass =
  "inline-flex min-h-10 items-center justify-center rounded-md border border-border " +
  "bg-surface px-3 text-sm font-medium text-foreground transition-[background-color,border-color,color,transform] " +
  "duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] " +
  "hover:enabled:bg-surface-hover active:enabled:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";

const primaryButtonClass =
  "inline-flex min-h-10 items-center justify-center rounded-md border border-transparent " +
  "bg-primary px-4 text-sm font-medium text-primary-foreground transition-[background-color,opacity,transform] " +
  "duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] " +
  "hover:enabled:opacity-90 active:enabled:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";

function makeIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "00000000-0000-4000-8000-" + String(Date.now()).padStart(12, "0").slice(-12);
}

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body?.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

function ReconciliationBadge({ status }: { status: CccdReconciliationStatus }) {
  const toneClass =
    status === "MISMATCH"
      ? "border-status-danger-border bg-status-danger-bg text-status-danger-text"
      : status === "QR_UNREADABLE"
        ? "border-status-warning-border bg-status-warning-bg text-status-warning-text"
        : status === "PENDING"
          ? "border-border bg-surface-muted text-muted"
          : "border-status-success-border bg-status-success-bg text-status-success-text";
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium ${toneClass}`}
    >
      {CCCD_RECONCILIATION_STATUS_LABELS[status]}
    </span>
  );
}

function genderDisplay(value: string | null): string {
  if (!value) return "—";
  const upper = value.trim().toUpperCase();
  if (upper === "MALE" || value === "Nam") return "Nam";
  if (upper === "FEMALE" || value === "Nữ") return "Nữ";
  if (upper === "OTHER" || value === "Khác") return "Khác";
  return value;
}

function qrValueForField(
  item: CccdReviewQueueItem,
  field: CccdReviewStandardizeField,
): string | null {
  const qr = item.qr.candidate_data;
  if (!qr) return null;
  switch (field) {
    case "national_id":
      return qr.national_id;
    case "display_name":
      return qr.display_name;
    case "date_of_birth":
      return qr.date_of_birth;
    case "gender":
      return qr.gender ? genderDisplay(qr.gender) : null;
    case "address":
      return qr.address;
    case "national_id_issued_at":
      return qr.national_id_issued_at;
  }
}

function enteredValueForField(
  item: CccdReviewQueueItem,
  field: CccdReviewStandardizeField,
): string | null {
  switch (field) {
    case "national_id":
      return item.entered.national_id;
    case "display_name":
      return item.entered.display_name.trim() === "" ? null : item.entered.display_name;
    case "date_of_birth":
      return item.entered.date_of_birth;
    case "gender":
      return item.entered.gender ? genderDisplay(item.entered.gender) : null;
    case "address":
      return item.entered.address;
    case "national_id_issued_at":
      return item.entered.national_id_issued_at;
  }
}

export function CccdReviewPanel() {
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [statusFilter, setStatusFilter] = useState<CccdReviewFilterStatus>("NEEDS_REVIEW");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(CCCD_REVIEW_DEFAULT_PAGE_SIZE);
  const [reloadToken, setReloadToken] = useState(0);
  const userActionRef = useRef(false);
  const notify = useNotify();

  const [selectedItem, setSelectedItem] = useState<CccdReviewQueueItem | null>(null);
  const [revealFullCccd, setRevealFullCccd] = useState(false);
  const [actionMode, setActionMode] = useState<"UPDATE_ENTERED_CCCD" | "STANDARDIZE_FROM_QR">(
    "UPDATE_ENTERED_CCCD",
  );
  const [editedCccd, setEditedCccd] = useState("");
  const [applyBlankFromQr, setApplyBlankFromQr] = useState(true);
  const [selectedQrFields, setSelectedQrFields] = useState<CccdReviewStandardizeField[]>([]);
  const [actionReason, setActionReason] = useState("");
  const [confirmStep, setConfirmStep] = useState<
    null | "UPDATE_ENTERED_CCCD" | "STANDARDIZE_FROM_QR"
  >(null);
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const resolveIdempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [uploadingSide, setUploadingSide] = useState<"CCCD_FRONT" | "CCCD_BACK" | null>(null);
  const [retryingQr, setRetryingQr] = useState(false);

  // Revoke object URLs when dialog closes or unmounts
  useEffect(() => {
    return () => {
      for (const url of Object.values(previewUrls)) {
        URL.revokeObjectURL(url);
      }
    };
  }, [previewUrls]);

  useEffect(() => {
    const controller = new AbortController();
    const isUserInitiated = userActionRef.current;
    void (async () => {
      const failWith = (nextState: Exclude<PanelState, { kind: "loading" | "loaded" }>) => {
        setState(nextState);
        if (isUserInitiated) {
          userActionRef.current = false;
          const title =
            nextState.kind === "denied"
              ? "Bạn không có quyền xem danh sách Review thông tin NLĐ."
              : nextState.kind === "unavailable"
                ? "Danh sách Review thông tin NLĐ hiện không khả dụng. Hãy thử tải lại."
                : "Không tải được danh sách Review thông tin NLĐ.";
          notify.error({ title });
        }
      };

      const query = buildCccdReviewQueueQuery({
        status: statusFilter,
        page,
        page_size: pageSize,
      });
      if (!query) {
        failWith({ kind: "error" });
        return;
      }

      let response: Response;
      try {
        response = await fetch(`/api/direct-entry/cccd-review?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        failWith({ kind: "unavailable" });
        return;
      }

      if (response.status === 401 || response.status === 403) {
        failWith({ kind: "denied" });
        return;
      }
      if (response.status !== 200) {
        failWith(
          response.status === 404 || response.status >= 500
            ? { kind: "unavailable" }
            : { kind: "error" },
        );
        return;
      }

      try {
        const body = await response.json();
        const projected = projectCccdReviewQueueResponse(body);
        if (!projected) {
          failWith({ kind: "error" });
          return;
        }
        userActionRef.current = false;
        setState({ kind: "loaded", page: projected });
        setSelectedItem((current) => {
          if (!current) return null;
          return projected.rows.find((item) => item.entry_id === current.entry_id) ?? current;
        });
      } catch {
        failWith({ kind: "error" });
      }
    })();

    return () => controller.abort();
  }, [notify, page, pageSize, reloadToken, statusFilter]);

  function openReviewItem(item: CccdReviewQueueItem): void {
    for (const url of Object.values(previewUrls)) {
      URL.revokeObjectURL(url);
    }
    setPreviewUrls({});
    setSelectedItem(item);
    setRevealFullCccd(false);
    setEditedCccd(item.entered.national_id ?? "");
    setApplyBlankFromQr(true);
    const defaultQrFields = CCCD_REVIEW_STANDARDIZE_FIELDS.filter((field) => {
      const qrVal = qrValueForField(item, field);
      if (qrVal === null) return false;
      const enteredVal = enteredValueForField(item, field);
      return enteredVal === null || field === "national_id";
    });
    setSelectedQrFields(
      defaultQrFields.length > 0
        ? defaultQrFields
        : CCCD_REVIEW_STANDARDIZE_FIELDS.filter((field) => qrValueForField(item, field) !== null),
    );
    setActionMode(item.qr.candidate_data ? "STANDARDIZE_FROM_QR" : "UPDATE_ENTERED_CCCD");
    setActionReason("");
    setConfirmStep(null);
    setActionError(null);
    resolveIdempotencyRef.current = null;
  }

  function closeReviewDialog(): void {
    if (actionSubmitting || uploadingSide !== null || retryingQr) return;
    for (const url of Object.values(previewUrls)) {
      URL.revokeObjectURL(url);
    }
    setPreviewUrls({});
    setSelectedItem(null);
    setConfirmStep(null);
    setActionError(null);
    resolveIdempotencyRef.current = null;
  }

  async function loadCccdPreview(entryId: string, documentId: string): Promise<void> {
    if (previewUrls[documentId] || previewLoadingId !== null) return;
    setPreviewLoadingId(documentId);
    setActionError(null);
    try {
      const response = await fetch(
        `/api/direct-entry/entries/${encodeURIComponent(entryId)}/documents/${encodeURIComponent(documentId)}/cccd-preview`,
        {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
        },
      );
      if (!response.ok) {
        const code = await readErrorCode(response);
        setActionError(cccdReviewErrorMessage(code));
        return;
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      setPreviewUrls((current) => ({ ...current, [documentId]: objectUrl }));
    } catch {
      setActionError("Không tải được ảnh xem trước CCCD. Hãy thử lại.");
    } finally {
      setPreviewLoadingId(null);
    }
  }

  async function triggerRetryQr(item: CccdReviewQueueItem): Promise<void> {
    if (retryingQr || uploadingSide !== null || actionSubmitting) return;
    setRetryingQr(true);
    setActionError(null);
    try {
      const response = await fetch(
        `/api/direct-entry/entries/${encodeURIComponent(item.entry_id)}/cccd-qr`,
        {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": makeIdempotencyKey(),
          },
          body: JSON.stringify({
            apply_blank_fields: true,
            expected_entry_version: item.entry_version,
          }),
        },
      );
      if (!response.ok) {
        const code = await readErrorCode(response);
        setActionError(cccdReviewErrorMessage(code));
        return;
      }
      notify.success({ title: "Đã đọc lại QR và cập nhật trạng thái đối chiếu." });
      userActionRef.current = true;
      setReloadToken((v) => v + 1);
    } catch {
      setActionError("Không gửi được yêu cầu đọc lại QR. Hãy thử lại.");
    } finally {
      setRetryingQr(false);
    }
  }

  async function handleReuploadCccdFile(
    item: CccdReviewQueueItem,
    documentType: "CCCD_FRONT" | "CCCD_BACK",
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file || uploadingSide !== null || actionSubmitting || retryingQr) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setActionError("Ảnh CCCD chỉ chấp nhận định dạng JPEG hoặc PNG.");
      return;
    }
    if (file.size < 1 || file.size > 10 * 1024 * 1024) {
      setActionError("Dung lượng ảnh CCCD phải lớn hơn 0 và không vượt quá 10 MiB.");
      return;
    }

    setUploadingSide(documentType);
    setActionError(null);
    try {
      const reserveKey = makeIdempotencyKey();
      const reserveRes = await fetch(
        `/api/direct-entry/entries/${encodeURIComponent(item.entry_id)}/documents`,
        {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": reserveKey,
          },
          body: JSON.stringify({
            document_type: documentType,
            expected_entry_version: item.entry_version,
            content_type: file.type,
            size_bytes: file.size,
          }),
        },
      );
      if (!reserveRes.ok) {
        const code = await readErrorCode(reserveRes);
        setActionError(cccdReviewErrorMessage(code));
        return;
      }
      const reserved = (await reserveRes.json()) as {
        document?: { document_id?: string; entry_version?: number };
        direct_upload?: { upload_url?: string; headers?: Record<string, string> };
      };
      const documentId = reserved.document?.document_id;
      const nextEntryVersion = reserved.document?.entry_version ?? item.entry_version + 1;
      const uploadUrl = reserved.direct_upload?.upload_url;
      if (!documentId || !uploadUrl) {
        setActionError("Không khởi tạo được phiên tải ảnh CCCD.");
        return;
      }

      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: reserved.direct_upload?.headers ?? { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) {
        setActionError("Không tải được tệp ảnh CCCD lên kho lưu trữ.");
        return;
      }

      const finalizeRes = await fetch(
        `/api/direct-entry/entries/${encodeURIComponent(item.entry_id)}/documents/${encodeURIComponent(documentId)}/finalize`,
        {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": makeIdempotencyKey(),
          },
          body: JSON.stringify({
            expected_entry_version: nextEntryVersion,
          }),
        },
      );
      if (!finalizeRes.ok) {
        const code = await readErrorCode(finalizeRes);
        setActionError(cccdReviewErrorMessage(code));
        return;
      }

      await fetch(`/api/direct-entry/entries/${encodeURIComponent(item.entry_id)}/cccd-qr`, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": makeIdempotencyKey(),
        },
        body: JSON.stringify({
          apply_blank_fields: true,
          expected_entry_version: nextEntryVersion,
        }),
      });

      notify.success({
        title:
          documentType === "CCCD_FRONT"
            ? "Đã tải lại CCCD mặt trước và kích hoạt đọc QR."
            : "Đã tải lại CCCD mặt sau và kích hoạt đọc QR.",
      });
      userActionRef.current = true;
      setReloadToken((v) => v + 1);
    } catch {
      setActionError("Không hoàn tất được việc tải lại ảnh CCCD. Hãy thử lại.");
    } finally {
      setUploadingSide(null);
    }
  }

  function requestResolutionConfirmation(): void {
    if (!selectedItem) return;
    setActionError(null);
    if (actionMode === "UPDATE_ENTERED_CCCD") {
      const normalized = editedCccd.trim();
      if (!isCanonicalNationalId(normalized)) {
        setActionError("Số CCCD phải gồm đúng 12 chữ số hợp lệ (không chấp nhận 000000000000).");
        return;
      }
      setConfirmStep("UPDATE_ENTERED_CCCD");
      return;
    }
    if (!selectedItem.qr.candidate_data) {
      setActionError("Hồ sơ chưa có dữ liệu QR hợp lệ để chuẩn hóa.");
      return;
    }
    if (selectedQrFields.length === 0) {
      setActionError("Hãy chọn ít nhất một trường từ QR để áp dụng.");
      return;
    }
    setConfirmStep("STANDARDIZE_FROM_QR");
  }

  async function submitConfirmedResolution(): Promise<void> {
    if (!selectedItem || !confirmStep || actionSubmitting) return;
    setActionSubmitting(true);
    setActionError(null);

    const payload =
      confirmStep === "UPDATE_ENTERED_CCCD"
        ? {
            action: "UPDATE_ENTERED_CCCD" as const,
            expected_entry_version: selectedItem.entry_version,
            national_id: editedCccd.trim(),
            apply_blank_fields_from_qr: applyBlankFromQr,
            reason: actionReason.trim() === "" ? null : actionReason.trim(),
          }
        : {
            action: "STANDARDIZE_FROM_QR" as const,
            expected_entry_version: selectedItem.entry_version,
            fields: selectedQrFields,
            reason: actionReason.trim() === "" ? null : actionReason.trim(),
          };

    const fingerprint = `${selectedItem.entry_id}:${selectedItem.entry_version}:${JSON.stringify(payload)}`;
    if (
      !resolveIdempotencyRef.current ||
      resolveIdempotencyRef.current.fingerprint !== fingerprint
    ) {
      resolveIdempotencyRef.current = { fingerprint, key: makeIdempotencyKey() };
    }

    try {
      const response = await fetch(
        `/api/direct-entry/entries/${encodeURIComponent(selectedItem.entry_id)}/cccd-review`,
        {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": resolveIdempotencyRef.current.key,
          },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) {
        const code = await readErrorCode(response);
        setActionError(cccdReviewErrorMessage(code));
        return;
      }
      notify.success({
        title:
          confirmStep === "UPDATE_ENTERED_CCCD"
            ? "Đã cập nhật số CCCD và đối chiếu lại hồ sơ."
            : "Đã chuẩn hóa thông tin hồ sơ NLĐ từ dữ liệu QR.",
      });
      setConfirmStep(null);
      setSelectedItem(null);
      resolveIdempotencyRef.current = null;
      userActionRef.current = true;
      setReloadToken((v) => v + 1);
    } catch {
      setActionError("Không gửi được yêu cầu xử lý Review CCCD. Hãy thử lại.");
    } finally {
      setActionSubmitting(false);
    }
  }

  function toggleQrField(field: CccdReviewStandardizeField): void {
    setConfirmStep(null);
    setSelectedQrFields((current) =>
      current.includes(field) ? current.filter((item) => item !== field) : [...current, field],
    );
  }

  const counts = state.kind === "loaded" ? state.page.summary : null;

  return (
    <div className="space-y-4" data-testid="cccd-review-panel">
      <Card>
        <CardHeader
          title="Review thông tin NLĐ"
          description="Đối chiếu số CCCD đã nhập với dữ liệu giải mã từ QR trên ảnh CCCD, bổ sung trường còn trống hoặc xử lý sai lệch trong phạm vi được phân quyền."
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Bộ lọc trạng thái đối chiếu CCCD">
            {CCCD_REVIEW_FILTER_STATUSES.map((status) => {
              const active = statusFilter === status;
              const badgeCount =
                counts === null
                  ? null
                  : status === "NEEDS_REVIEW"
                    ? counts.needs_review_count
                    : status === "MISMATCH"
                      ? counts.mismatch_count
                      : status === "QR_UNREADABLE"
                        ? counts.qr_unreadable_count
                        : status === "PENDING"
                          ? counts.pending_count
                          : status === "MATCHED_INITIAL"
                            ? counts.matched_initial_count
                            : status === "RESOLVED"
                              ? counts.resolved_count
                              : null;
              return (
                <button
                  key={status}
                  type="button"
                  data-testid={`cccd-review-filter-${status}`}
                  aria-pressed={active}
                  onClick={() => {
                    userActionRef.current = true;
                    setStatusFilter(status);
                    setPage(1);
                  }}
                  className={active ? primaryButtonClass : buttonClass}
                >
                  <span>{CCCD_REVIEW_FILTER_LABELS[status]}</span>
                  {badgeCount !== null ? (
                    <span className="ml-1.5 rounded-full bg-black/10 px-1.5 py-0.5 text-xs tabular-nums">
                      {badgeCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-muted">
              <span>Hiển thị</span>
              <select
                value={pageSize}
                onChange={(event) => {
                  userActionRef.current = true;
                  setPageSize(Number(event.currentTarget.value));
                  setPage(1);
                }}
                className="min-h-10 rounded-md border border-border bg-surface px-2 text-sm text-foreground"
              >
                {CCCD_REVIEW_PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size} dòng
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => {
                userActionRef.current = true;
                setReloadToken((v) => v + 1);
              }}
              className={buttonClass}
            >
              Thử tải lại
            </button>
          </div>
        </div>
      </Card>

      {state.kind === "loading" ? (
        <Card>
          <p className="py-6 text-center text-sm text-muted" role="status">
            Đang tải danh sách hồ sơ cần Review thông tin NLĐ…
          </p>
        </Card>
      ) : state.kind === "denied" ? (
        <ErrorState
          title="Không có quyền truy cập"
          detail="Tài khoản hiện tại không có quyền xem danh sách Review thông tin NLĐ."
        />
      ) : state.kind === "unavailable" ? (
        <ErrorState
          title="Danh sách Review hiện không khả dụng"
          detail="Hệ thống chưa thể tải danh sách đối chiếu CCCD lúc này. Vui lòng thử tải lại sau."
        />
      ) : state.kind === "error" ? (
        <ErrorState
          title="Không tải được danh sách Review thông tin NLĐ"
          detail="Phản hồi từ máy chủ không hợp lệ. Vui lòng thử tải lại."
        />
      ) : state.page.rows.length === 0 ? (
        <EmptyState
          title="Không có hồ sơ nào trong bộ lọc này"
          description="Hiện không có hồ sơ người lao động nào thuộc trạng thái đối chiếu đang chọn trong phạm vi của bạn."
        />
      ) : (
        <Card>
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <table className="r22-report-table w-full min-w-[760px] text-left text-sm">
              <caption className="sr-only">Danh sách hồ sơ người lao động cần Review thông tin CCCD</caption>
              <thead className="bg-surface-muted text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-3 py-3">NLĐ / Mã NV</th>
                  <th scope="col" className="px-3 py-3">Dự án / Ngày vào làm</th>
                  <th scope="col" className="px-3 py-3">CCCD đã nhập</th>
                  <th scope="col" className="px-3 py-3">CCCD từ QR</th>
                  <th scope="col" className="px-3 py-3">Trạng thái đối chiếu</th>
                  <th scope="col" className="px-3 py-3">Trạng thái ảnh QR</th>
                  <th scope="col" className="px-3 py-3">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {state.page.rows.map((item) => {
                  const frontStatus =
                    item.documents.cccd_front && item.documents.cccd_front.extraction_status
                      ? CCCD_QR_EXTRACTION_STATUS_LABELS[item.documents.cccd_front.extraction_status]
                      : "Chưa tải";
                  const backStatus =
                    item.documents.cccd_back && item.documents.cccd_back.extraction_status
                      ? CCCD_QR_EXTRACTION_STATUS_LABELS[item.documents.cccd_back.extraction_status]
                      : "Chưa tải";
                  return (
                    <tr
                      key={item.entry_id}
                      className="transition-colors duration-[var(--ui-motion-hover,160ms)] motion-reduce:transition-none hover:bg-surface-hover"
                    >
                      <td className="px-3 py-3">
                        <div className="font-medium text-foreground">
                          {item.entered.display_name || "Chưa nhập họ tên"}
                        </div>
                        <div className="font-mono text-xs tabular-nums text-muted">
                          {item.employee_code ?? "—"}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div>{item.project_name ?? "—"}</div>
                        <div className="text-xs text-muted">
                          Vào làm:{" "}
                          <span className="font-mono tabular-nums">{item.first_work_date ?? "—"}</span>
                          {item.recruiter_name ? ` · ${item.recruiter_name}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs tabular-nums">
                        {maskCccdValue(item.entered.national_id)}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs tabular-nums">
                        {maskCccdValue(item.qr.candidate_data?.national_id ?? item.qr.national_id ?? null)}
                      </td>
                      <td className="px-3 py-3">
                        <ReconciliationBadge status={item.reconciliation_status} />
                      </td>
                      <td className="px-3 py-3 text-xs text-muted">
                        <div>Mặt trước: {frontStatus}</div>
                        <div>Mặt sau: {backStatus}</div>
                      </td>
                      <td className="px-3 py-3">
                        <button
                          type="button"
                          data-testid={`cccd-review-open-${item.entry_id}`}
                          onClick={() => openReviewItem(item)}
                          className={buttonClass}
                        >
                          Xem &amp; xử lý
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
            <span>
              Tổng số:{" "}
              <strong className="font-semibold tabular-nums text-foreground">
                {state.page.total_count}
              </strong>{" "}
              hồ sơ · Trang{" "}
              <strong className="font-semibold tabular-nums text-foreground">
                {page}
              </strong>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => {
                  userActionRef.current = true;
                  setPage((current) => Math.max(1, current - 1));
                }}
                className={buttonClass}
              >
                Trang trước
              </button>
              <button
                type="button"
                disabled={state.page.offset + state.page.rows.length >= state.page.total_count}
                onClick={() => {
                  userActionRef.current = true;
                  setPage((current) => current + 1);
                }}
                className={buttonClass}
              >
                Trang sau
              </button>
            </div>
          </div>
        </Card>
      )}

      {selectedItem ? (
        <FormDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) closeReviewDialog();
          }}
          title={`Review thông tin NLĐ · ${selectedItem.entered.display_name || selectedItem.employee_code || "Hồ sơ mới"}`}
          description={`Mã NV: ${selectedItem.employee_code ?? "—"} · Dự án: ${selectedItem.project_name ?? "—"} · Trạng thái: ${CCCD_RECONCILIATION_STATUS_LABELS[selectedItem.reconciliation_status]}`}
        >
          <div className="space-y-4 text-sm">
            {actionError ? (
              <Alert tone="danger" title="Không thể thực hiện">
                {actionError}
              </Alert>
            ) : null}

            {/* 1. Bảng so sánh Đã nhập vs QR */}
            <div className="rounded-xl border border-border bg-surface p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-semibold text-foreground">
                  1. Đối chiếu thông tin đã nhập và dữ liệu từ QR CCCD
                </h4>
                <button
                  type="button"
                  data-testid="cccd-review-toggle-reveal"
                  onClick={() => setRevealFullCccd((v) => !v)}
                  className="text-xs font-medium text-primary underline underline-offset-2"
                >
                  {revealFullCccd ? "Ẩn bớt số CCCD" : "Hiện số CCCD đầy đủ để đối chiếu"}
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead className="border-b border-border text-xs uppercase text-muted">
                    <tr>
                      <th className="py-2 pr-2">Trường</th>
                      <th className="py-2 px-2">Đã nhập trên hồ sơ</th>
                      <th className="py-2 px-2">Giải mã từ QR CCCD</th>
                      <th className="py-2 pl-2">Đối chiếu</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {CCCD_REVIEW_STANDARDIZE_FIELDS.map((field) => {
                      const rawEntered = enteredValueForField(selectedItem, field);
                      const rawQr = qrValueForField(selectedItem, field);
                      const displayEntered =
                        field === "national_id" && !revealFullCccd
                          ? maskCccdValue(rawEntered)
                          : rawEntered ?? "(Đang trống)";
                      const displayQr =
                        field === "national_id" && !revealFullCccd
                          ? maskCccdValue(rawQr)
                          : rawQr ?? "—";
                      const isMatch =
                        rawEntered !== null &&
                        rawQr !== null &&
                        rawEntered.trim() === rawQr.trim();
                      const statusText =
                        rawQr === null
                          ? "Chưa có từ QR"
                          : rawEntered === null
                            ? "Trống trên hồ sơ"
                            : isMatch
                              ? "Khớp"
                              : "Khác nhau";
                      return (
                        <tr key={field}>
                          <td className="py-2 pr-2 font-medium">
                            {CCCD_REVIEW_STANDARDIZE_FIELD_LABELS[field]}
                          </td>
                          <td className="py-2 px-2 font-mono">{displayEntered}</td>
                          <td className="py-2 px-2 font-mono">{displayQr}</td>
                          <td className="py-2 pl-2">
                            <span
                              className={
                                statusText === "Khớp"
                                  ? "font-medium text-status-success-text"
                                  : statusText === "Khác nhau"
                                    ? "font-semibold text-status-danger-text"
                                    : "text-muted"
                              }
                            >
                              {statusText}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 2. Xem ảnh CCCD & Tải lại ảnh / Đọc lại QR */}
            <div className="rounded-xl border border-border bg-surface p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-semibold text-foreground">2. Ảnh CCCD &amp; Trạng thái đọc QR</h4>
                <button
                  type="button"
                  data-testid="cccd-review-retry-qr"
                  disabled={retryingQr || uploadingSide !== null || actionSubmitting}
                  onClick={() => void triggerRetryQr(selectedItem)}
                  className={buttonClass}
                >
                  {retryingQr ? "Đang đọc lại QR…" : "Đọc lại QR & đối chiếu lại"}
                </button>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(["CCCD_FRONT", "CCCD_BACK"] as const).map((docType) => {
                  const doc =
                    docType === "CCCD_FRONT"
                      ? selectedItem.documents.cccd_front
                      : selectedItem.documents.cccd_back;
                  const label = docType === "CCCD_FRONT" ? "CCCD mặt trước" : "CCCD mặt sau";
                  const previewUrl = doc ? previewUrls[doc.document_id] : undefined;
                  return (
                    <div
                      key={docType}
                      className="rounded-lg border border-border bg-surface-muted/40 p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-foreground">{label}</span>
                        <span className="text-xs text-muted">
                          {doc && doc.extraction_status
                            ? CCCD_QR_EXTRACTION_STATUS_LABELS[doc.extraction_status]
                            : "Chưa tải ảnh"}
                        </span>
                      </div>
                      {doc?.error_code ? (
                        <p className="text-xs text-status-warning-text">
                          {CCCD_QR_FAILURE_LABELS[doc.error_code]}
                        </p>
                      ) : null}
                      {previewUrl ? (
                        <img
                          src={previewUrl}
                          alt={`Ảnh ${label}`}
                          className="max-h-52 w-full rounded border border-border object-contain bg-black/5"
                        />
                      ) : null}
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {doc ? (
                          <button
                            type="button"
                            disabled={previewLoadingId === doc.document_id}
                            onClick={() => void loadCccdPreview(selectedItem.entry_id, doc.document_id)}
                            className={buttonClass}
                          >
                            {previewLoadingId === doc.document_id
                              ? "Đang tải ảnh…"
                              : previewUrl
                                ? "Đã hiển thị ảnh"
                                : "Xem ảnh CCCD"}
                          </button>
                        ) : null}
                        <label className={`${buttonClass} cursor-pointer`}>
                          <span>
                            {uploadingSide === docType
                              ? "Đang tải lên…"
                              : doc
                                ? "Tải lại ảnh"
                                : "Tải ảnh lên"}
                          </span>
                          <input
                            type="file"
                            accept="image/jpeg,image/png"
                            hidden
                            disabled={uploadingSide !== null || actionSubmitting || retryingQr}
                            onChange={(event) =>
                              void handleReuploadCccdFile(selectedItem, docType, event)
                            }
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 3. Hành động xử lý trực tiếp */}
            <div className="rounded-xl border border-border bg-surface p-3 space-y-3">
              <h4 className="font-semibold text-foreground">
                3. Xử lý trực tiếp thông tin hồ sơ NLĐ
              </h4>
              <p className="text-xs text-muted">
                Mọi thao tác sửa số CCCD hoặc chuẩn hóa dữ liệu từ QR đều yêu cầu xác nhận rõ ràng và ghi vết lịch sử kiểm toán. Hệ thống không cho phép bỏ qua lệch CCCD mà không xử lý nguyên nhân.
              </p>

              <div className="flex flex-wrap gap-2" role="group" aria-label="Chọn cách xử lý">
                <button
                  type="button"
                  data-testid="cccd-review-mode-update-cccd"
                  aria-pressed={actionMode === "UPDATE_ENTERED_CCCD"}
                  onClick={() => {
                    setActionMode("UPDATE_ENTERED_CCCD");
                    setConfirmStep(null);
                    setActionError(null);
                  }}
                  className={
                    actionMode === "UPDATE_ENTERED_CCCD" ? primaryButtonClass : buttonClass
                  }
                >
                  Sửa CCCD đã nhập rồi đối chiếu lại
                </button>
                <button
                  type="button"
                  data-testid="cccd-review-mode-standardize-qr"
                  disabled={!selectedItem.qr.candidate_data}
                  aria-pressed={actionMode === "STANDARDIZE_FROM_QR"}
                  onClick={() => {
                    setActionMode("STANDARDIZE_FROM_QR");
                    setConfirmStep(null);
                    setActionError(null);
                  }}
                  className={
                    actionMode === "STANDARDIZE_FROM_QR" ? primaryButtonClass : buttonClass
                  }
                >
                    Chuẩn hóa thông tin từ QR
                  </button>
                </div>

                {actionMode === "UPDATE_ENTERED_CCCD" ? (
                  <div className="space-y-3 pt-1">
                    <label className="block space-y-1">
                      <span className="font-medium text-foreground">
                        Số CCCD đúng (12 chữ số) <span className="text-status-danger-text">*</span>
                      </span>
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={12}
                        value={editedCccd}
                        onChange={(event) => {
                          setConfirmStep(null);
                          setEditedCccd(event.currentTarget.value);
                        }}
                        placeholder="Nhập đủ 12 chữ số CCCD"
                        className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-foreground"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-xs sm:text-sm">
                      <input
                        type="checkbox"
                        checked={applyBlankFromQr}
                        onChange={(event) => {
                          setConfirmStep(null);
                          setApplyBlankFromQr(event.currentTarget.checked);
                        }}
                      />
                      <span>
                        Tự động bổ sung các trường cá nhân đang trống từ QR nếu số CCCD mới khớp với QR
                      </span>
                    </label>
                  </div>
                ) : (
                  <div className="space-y-3 pt-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-foreground">
                        Chọn các trường từ QR cần áp dụng vào hồ sơ:
                      </span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmStep(null);
                            setSelectedQrFields(
                              CCCD_REVIEW_STANDARDIZE_FIELDS.filter(
                                (field) =>
                                  qrValueForField(selectedItem, field) !== null &&
                                  enteredValueForField(selectedItem, field) === null,
                              ),
                            );
                          }}
                          className="text-xs font-medium text-primary underline"
                        >
                          Chỉ chọn trường đang trống
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmStep(null);
                            setSelectedQrFields(
                              CCCD_REVIEW_STANDARDIZE_FIELDS.filter(
                                (field) => qrValueForField(selectedItem, field) !== null,
                              ),
                            );
                          }}
                          className="text-xs font-medium text-primary underline"
                        >
                          Chọn tất cả trường có trong QR
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {CCCD_REVIEW_STANDARDIZE_FIELDS.map((field) => {
                        const qrVal = qrValueForField(selectedItem, field);
                        const enteredVal = enteredValueForField(selectedItem, field);
                        const disabled = qrVal === null;
                        const checked = selectedQrFields.includes(field);
                        const willOverwrite =
                          enteredVal !== null && qrVal !== null && enteredVal.trim() !== qrVal.trim();
                        return (
                          <label
                            key={field}
                            className={`flex items-start gap-2 rounded-lg border p-2 text-xs ${
                              disabled
                                ? "border-border bg-surface-muted/40 opacity-50"
                                : checked
                                  ? "border-primary bg-primary/5"
                                  : "border-border bg-surface"
                            }`}
                          >
                            <input
                              type="checkbox"
                              disabled={disabled}
                              checked={checked}
                              onChange={() => toggleQrField(field)}
                              className="mt-0.5"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="font-medium text-foreground">
                                {CCCD_REVIEW_STANDARDIZE_FIELD_LABELS[field]}
                                {willOverwrite ? (
                                  <span className="ml-1 text-status-warning-text">
                                    (Ghi đè giá trị cũ)
                                  </span>
                                ) : null}
                              </div>
                              <div className="truncate font-mono text-muted">
                                QR: {qrVal ?? "Không có"}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                <label className="block space-y-1">
                  <span className="font-medium text-foreground">Ghi chú / Lý do xử lý (tùy chọn)</span>
                  <input
                    type="text"
                    maxLength={500}
                    value={actionReason}
                    onChange={(event) => setActionReason(event.currentTarget.value)}
                    placeholder="Nhập lý do điều chỉnh hoặc chuẩn hóa thông tin"
                    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
                  />
                </label>

                {confirmStep === null ? (
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={closeReviewDialog}
                      className={buttonClass}
                    >
                      Đóng
                    </button>
                    <button
                      type="button"
                      data-testid="cccd-review-prepare-confirm"
                      onClick={requestResolutionConfirmation}
                      className={primaryButtonClass}
                    >
                      {actionMode === "UPDATE_ENTERED_CCCD"
                        ? "Tiếp tục xác nhận sửa CCCD"
                        : "Tiếp tục xác nhận chuẩn hóa từ QR"}
                    </button>
                  </div>
                ) : (
                  <div
                    className="rounded-lg border border-status-warning-border bg-status-warning-bg p-3 space-y-2"
                    role="alert"
                    data-testid="cccd-review-confirmation-box"
                  >
                    <p className="font-semibold text-status-warning-text">
                      {confirmStep === "UPDATE_ENTERED_CCCD"
                        ? `Xác nhận cập nhật số CCCD từ "${selectedItem.entered.national_id ?? "—"}" sang "${editedCccd.trim()}" và đối chiếu lại với QR?`
                        : `Xác nhận áp dụng ${selectedQrFields.length} trường từ dữ liệu QR (${selectedQrFields
                            .map((f) => CCCD_REVIEW_STANDARDIZE_FIELD_LABELS[f])
                            .join(", ")}) vào hồ sơ NLĐ?`}
                    </p>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        disabled={actionSubmitting}
                        onClick={() => setConfirmStep(null)}
                        className={buttonClass}
                      >
                        Quay lại kiểm tra
                      </button>
                      <button
                        type="button"
                        data-testid="cccd-review-confirm-submit"
                        disabled={actionSubmitting}
                        onClick={() => void submitConfirmedResolution()}
                        className={primaryButtonClass}
                      >
                        {actionSubmitting ? "Đang lưu…" : "Xác nhận thực hiện"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
          </div>
        </FormDialog>
      ) : null}
    </div>
  );
}
