"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
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
  buildMissingDocumentWorkersQuery,
  CCCD_REVIEW_DEFAULT_PAGE_SIZE,
  CCCD_REVIEW_FILTER_LABELS,
  CCCD_REVIEW_FILTER_STATUSES,
  CCCD_REVIEW_PAGE_SIZE_OPTIONS,
  CCCD_REVIEW_STANDARDIZE_FIELD_LABELS,
  CCCD_REVIEW_STANDARDIZE_FIELDS,
  cccdReviewErrorMessage,
  hasMissingDocumentWorkersFilter,
  MISSING_DOCUMENT_EMPLOYMENT_STATUS_LABELS,
  MISSING_DOCUMENT_EMPLOYMENT_STATUSES,
  MISSING_DOCUMENT_FILTER_LABELS,
  MISSING_DOCUMENT_FILTER_TYPES,
  MISSING_DOCUMENT_TYPE_LABELS,
  MISSING_DOCUMENT_TYPES,
  projectCccdReviewQueueResponse,
  projectMissingDocumentWorkersResponse,
  type CccdReviewFilterStatus,
  type CccdReviewQueueItem,
  type CccdReviewQueuePage,
  type CccdReviewStandardizeField,
  type MissingDocumentEmploymentStatus,
  type MissingDocumentFilterType,
  type MissingDocumentType,
  type MissingDocumentWorkerItem,
  type MissingDocumentWorkersResponse,
  type ReviewPanelMode,
} from "@/lib/direct-entry/cccd-review-contract";

type PanelState =
  | { kind: "loading" }
  | { kind: "loaded"; page: CccdReviewQueuePage }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "error" };

type MissingPanelState =
  | { kind: "idle" }
  | { kind: "filter_required" }
  | { kind: "loading" }
  | { kind: "loaded"; data: MissingDocumentWorkersResponse }
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

function ReconciliationBadge({
  status,
  resolvedAction,
}: {
  status: CccdReconciliationStatus;
  resolvedAction: string | null;
}) {
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
      {resolvedAction === "MANUAL_UPDATE_DETAILS"
        ? "Đã nhập thông tin thủ công"
        : CCCD_RECONCILIATION_STATUS_LABELS[status]}
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
  const [panelMode, setPanelMode] = useState<ReviewPanelMode>("CCCD_RECONCILIATION");
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [statusFilter, setStatusFilter] = useState<CccdReviewFilterStatus>("NEEDS_REVIEW");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(CCCD_REVIEW_DEFAULT_PAGE_SIZE);
  const [reloadToken, setReloadToken] = useState(0);
  const userActionRef = useRef(false);
  const notify = useNotify();

  const [selectedItem, setSelectedItem] = useState<CccdReviewQueueItem | null>(null);
  const [actionMode, setActionMode] = useState<
    "UPDATE_ENTERED_CCCD" | "STANDARDIZE_FROM_QR" | "MANUAL_UPDATE_DETAILS"
  >(
    "UPDATE_ENTERED_CCCD",
  );
  const [editedCccd, setEditedCccd] = useState("");
  const [manualDetails, setManualDetails] = useState({
    national_id: "",
    display_name: "",
    date_of_birth: "",
    gender: "" as "" | "MALE" | "FEMALE" | "OTHER",
    address: "",
    national_id_issued_at: "",
  });
  const [applyBlankFromQr, setApplyBlankFromQr] = useState(true);
  const [selectedQrFields, setSelectedQrFields] = useState<CccdReviewStandardizeField[]>([]);
  const [actionReason, setActionReason] = useState("");
  const [confirmStep, setConfirmStep] = useState<
    null | "UPDATE_ENTERED_CCCD" | "STANDARDIZE_FROM_QR" | "MANUAL_UPDATE_DETAILS"
  >(null);
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const resolveIdempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [uploadingSide, setUploadingSide] = useState<"CCCD_FRONT" | "CCCD_BACK" | null>(null);
  const [retryingQr, setRetryingQr] = useState(false);

  // "Hồ sơ thiếu" conditional load state (does NOT auto-query on open)
  const [missingState, setMissingState] = useState<MissingPanelState>({ kind: "idle" });
  const [missingTypeFilter, setMissingTypeFilter] = useState<MissingDocumentFilterType>("ALL");
  const [missingStatusFilter, setMissingStatusFilter] =
    useState<MissingDocumentEmploymentStatus>("ALL");
  const [missingProjectFilter, setMissingProjectFilter] = useState<string>("");
  const [missingSearchInput, setMissingSearchInput] = useState<string>("");
  const [missingPageSize, setMissingPageSize] = useState<number>(25);
  const [selectedMissingItem, setSelectedMissingItem] = useState<MissingDocumentWorkerItem | null>(
    null,
  );
  const [uploadingMissingType, setUploadingMissingType] = useState<MissingDocumentType | null>(
    null,
  );
  const [missingActionError, setMissingActionError] = useState<string | null>(null);
  const missingAbortRef = useRef<AbortController | null>(null);

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
    setEditedCccd(item.entered.national_id ?? "");
    setManualDetails({
      national_id: item.entered.national_id ?? "",
      display_name: item.entered.display_name,
      date_of_birth: item.entered.date_of_birth ?? "",
      gender: item.entered.gender ?? "",
      address: item.entered.address ?? "",
      national_id_issued_at: item.entered.national_id_issued_at ?? "",
    });
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
            mime_type: file.type,
            size_bytes: file.size,
            reason: "Tải lại ảnh CCCD từ màn Review thông tin NLĐ",
          }),
        },
      );
      if (!reserveRes.ok) {
        const code = await readErrorCode(reserveRes);
        setActionError(cccdReviewErrorMessage(code));
        return;
      }
      const reserved = (await reserveRes.json()) as {
        document_id?: string;
        entry_version?: number;
        upload?: { url?: string; headers?: Record<string, string> } | null;
        document?: { document_id?: string; entry_version?: number };
        direct_upload?: { upload_url?: string; headers?: Record<string, string> };
      };
      const documentId = reserved.document_id ?? reserved.document?.document_id;
      const nextEntryVersion =
        reserved.entry_version ?? reserved.document?.entry_version ?? item.entry_version + 1;
      const uploadUrl = reserved.upload?.url ?? reserved.direct_upload?.upload_url;
      const uploadHeaders =
        reserved.upload?.headers ??
        reserved.direct_upload?.headers ?? { "Content-Type": file.type };
      if (!documentId || !uploadUrl) {
        setActionError("Không khởi tạo được phiên tải ảnh CCCD.");
        return;
      }

      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: uploadHeaders,
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
    if (actionMode === "MANUAL_UPDATE_DETAILS") {
      if (!isCanonicalNationalId(manualDetails.national_id.trim())) {
        setActionError("Số CCCD phải gồm đúng 12 chữ số hợp lệ (không chấp nhận 000000000000).");
        return;
      }
      if (manualDetails.display_name.trim().length > 256) {
        setActionError("Họ và tên không được vượt quá 256 ký tự.");
        return;
      }
      setConfirmStep("MANUAL_UPDATE_DETAILS");
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
        : confirmStep === "MANUAL_UPDATE_DETAILS"
          ? {
              action: "MANUAL_UPDATE_DETAILS" as const,
              expected_entry_version: selectedItem.entry_version,
              national_id: manualDetails.national_id.trim(),
              display_name: manualDetails.display_name.trim(),
              date_of_birth: manualDetails.date_of_birth.trim() || null,
              gender: manualDetails.gender || null,
              address: manualDetails.address.trim() || null,
              national_id_issued_at: manualDetails.national_id_issued_at.trim() || null,
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
            : confirmStep === "MANUAL_UPDATE_DETAILS"
              ? "Đã lưu thông tin NLĐ nhập thủ công."
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

  async function loadMissingDocumentWorkers(overrides?: {
    missing_type?: MissingDocumentFilterType;
    employment_status?: MissingDocumentEmploymentStatus;
    project_id?: string | null;
    q?: string | null;
    page?: number;
    page_size?: number;
  }): Promise<void> {
    const filters = {
      missing_type: overrides?.missing_type ?? missingTypeFilter,
      employment_status: overrides?.employment_status ?? missingStatusFilter,
      project_id:
        overrides?.project_id !== undefined
          ? overrides.project_id
          : missingProjectFilter || null,
      q: overrides?.q !== undefined ? overrides.q : missingSearchInput || null,
    };
    if (!hasMissingDocumentWorkersFilter(filters)) {
      missingAbortRef.current?.abort();
      setMissingState({ kind: "filter_required" });
      return;
    }

    missingAbortRef.current?.abort();
    const controller = new AbortController();
    missingAbortRef.current = controller;

    const query = buildMissingDocumentWorkersQuery({
      ...filters,
      page: overrides?.page ?? 1,
      page_size: overrides?.page_size ?? missingPageSize,
    });
    if (!query) {
      setMissingState({ kind: "error" });
      return;
    }

    setMissingState({ kind: "loading" });
    let response: Response;
    try {
      response = await fetch(
        `/api/direct-entry/cccd-review/missing-documents?${query.toString()}`,
        {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMissingState({ kind: "unavailable" });
      return;
    }

    if (response.status === 401 || response.status === 403) {
      setMissingState({ kind: "denied" });
      return;
    }
    if (response.status !== 200) {
      setMissingState(
        response.status === 404 || response.status >= 500
          ? { kind: "unavailable" }
          : { kind: "error" },
      );
      return;
    }

    try {
      const body = await response.json();
      const projected = projectMissingDocumentWorkersResponse(body);
      if (!projected) {
        setMissingState({ kind: "error" });
        return;
      }
      setMissingState({ kind: "loaded", data: projected });
      setSelectedMissingItem((current) => {
        if (!current) return null;
        return projected.items.find((item) => item.entry_id === current.entry_id) ?? current;
      });
    } catch {
      setMissingState({ kind: "error" });
    }
  }

  function openMissingDocumentItem(item: MissingDocumentWorkerItem): void {
    for (const url of Object.values(previewUrls)) {
      URL.revokeObjectURL(url);
    }
    setPreviewUrls({});
    setMissingActionError(null);
    setSelectedMissingItem(item);
  }

  function closeMissingDocumentDialog(): void {
    if (uploadingMissingType !== null) return;
    for (const url of Object.values(previewUrls)) {
      URL.revokeObjectURL(url);
    }
    setPreviewUrls({});
    setMissingActionError(null);
    setSelectedMissingItem(null);
  }

  async function loadMissingPreview(
    entryId: string,
    documentId: string,
    documentType: MissingDocumentType,
  ): Promise<void> {
    if (previewUrls[documentId] || previewLoadingId !== null) return;
    setPreviewLoadingId(documentId);
    setMissingActionError(null);
    try {
      const endpoint =
        documentType === "WORKER_PORTRAIT"
          ? `/api/direct-entry/entries/${encodeURIComponent(entryId)}/documents/${encodeURIComponent(documentId)}/preview`
          : `/api/direct-entry/entries/${encodeURIComponent(entryId)}/documents/${encodeURIComponent(documentId)}/cccd-preview`;
      const response = await fetch(endpoint, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) {
        const code = await readErrorCode(response);
        setMissingActionError(cccdReviewErrorMessage(code));
        return;
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      setPreviewUrls((current) => ({ ...current, [documentId]: objectUrl }));
    } catch {
      setMissingActionError("Không tải được ảnh xem trước. Hãy thử lại.");
    } finally {
      setPreviewLoadingId(null);
    }
  }

  async function handleUploadMissingDocumentFile(
    item: MissingDocumentWorkerItem,
    documentType: MissingDocumentType,
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file || uploadingMissingType !== null) return;

    const allowedMimes =
      documentType === "WORKER_PORTRAIT"
        ? ["image/jpeg", "image/png"]
        : ["image/jpeg", "image/png", "application/pdf"];
    if (!allowedMimes.includes(file.type)) {
      setMissingActionError(
        documentType === "WORKER_PORTRAIT"
          ? "Ảnh NLĐ chỉ chấp nhận định dạng JPEG hoặc PNG."
          : "Hồ sơ chỉ chấp nhận định dạng JPEG, PNG hoặc PDF.",
      );
      return;
    }
    if (file.size < 1 || file.size > 10 * 1024 * 1024) {
      setMissingActionError("Dung lượng tệp phải lớn hơn 0 và không vượt quá 10 MiB.");
      return;
    }

    setUploadingMissingType(documentType);
    setMissingActionError(null);
    try {
      const reserveRes = await fetch(
        `/api/direct-entry/entries/${encodeURIComponent(item.entry_id)}/documents`,
        {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": makeIdempotencyKey(),
          },
          body: JSON.stringify({
            document_type: documentType,
            expected_entry_version: item.entry_version,
            mime_type: file.type,
            size_bytes: file.size,
            reason: `Bổ sung hồ sơ thiếu (${MISSING_DOCUMENT_TYPE_LABELS[documentType]})`,
          }),
        },
      );
      if (!reserveRes.ok) {
        const code = await readErrorCode(reserveRes);
        setMissingActionError(cccdReviewErrorMessage(code));
        return;
      }

      const reserved = (await reserveRes.json()) as {
        document_id?: string;
        version?: number;
        entry_version?: number;
        upload?: { url?: string; headers?: Record<string, string> } | null;
      };
      const documentId = reserved.document_id;
      const nextEntryVersion = reserved.entry_version ?? item.entry_version + 1;
      const uploadUrl = reserved.upload?.url;
      if (!documentId || !uploadUrl) {
        setMissingActionError("Không khởi tạo được phiên tải hồ sơ lên kho lưu trữ.");
        return;
      }

      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: reserved.upload?.headers ?? { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) {
        setMissingActionError("Không tải được tệp hồ sơ lên kho lưu trữ.");
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
        setMissingActionError(cccdReviewErrorMessage(code));
        return;
      }

      const finalized = (await finalizeRes.json()) as {
        document_id?: string;
        version?: number;
        entry_version?: number;
      };
      const updatedVersion = finalized.entry_version ?? nextEntryVersion + 1;
      const updatedDocVersion = finalized.version ?? reserved.version ?? 1;
      const nowIso = new Date().toISOString();

      setSelectedMissingItem((current) => {
        if (!current || current.entry_id !== item.entry_id) return current;
        const nextMissing = current.missing_documents.filter((t) => t !== documentType);
        const filteredDocs = current.documents.filter((d) => d.document_type !== documentType);
        filteredDocs.push({
          document_id: documentId,
          document_type: documentType,
          document_version: updatedDocVersion,
          mime_type: file.type,
          size_bytes: file.size,
          updated_at: nowIso,
        });
        return {
          ...current,
          entry_version: updatedVersion,
          missing_documents: nextMissing,
          documents: filteredDocs,
        };
      });

      notify.success({
        title: `Đã bổ sung ${MISSING_DOCUMENT_TYPE_LABELS[documentType]} cho ${item.display_name}.`,
      });
      if (missingState.kind === "loaded") {
        await loadMissingDocumentWorkers({ page: missingState.data.page });
      }
    } catch {
      setMissingActionError("Không hoàn tất được việc tải hồ sơ bổ sung. Hãy thử lại.");
    } finally {
      setUploadingMissingType(null);
    }
  }

  const counts = state.kind === "loaded" ? state.page.summary : null;
  const missingProjectOptions =
    missingState.kind === "loaded" ? missingState.data.project_options : [];

  return (
    <div className="space-y-4" data-testid="cccd-review-panel">
      <Card>
        <CardHeader
          title="Review thông tin NLĐ"
          description="Đối chiếu số CCCD đã nhập với dữ liệu giải mã từ QR trên ảnh CCCD, hoặc rà soát và bổ sung 4 loại hồ sơ bắt buộc còn thiếu trong phạm vi được phân quyền."
        />

        <div
          className="mb-4 flex flex-wrap gap-2 border-b border-border pb-3"
          role="tablist"
          aria-label="Chế độ Review thông tin NLĐ"
        >
          <button
            type="button"
            role="tab"
            data-testid="review-mode-tab-CCCD_RECONCILIATION"
            aria-selected={panelMode === "CCCD_RECONCILIATION"}
            onClick={() => setPanelMode("CCCD_RECONCILIATION")}
            className={panelMode === "CCCD_RECONCILIATION" ? primaryButtonClass : buttonClass}
          >
            <span>Đối chiếu CCCD</span>
            {counts !== null ? (
              <span className="ml-1.5 rounded-full bg-black/10 px-1.5 py-0.5 text-xs tabular-nums">
                {counts.needs_review_count}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            role="tab"
            data-testid="review-mode-tab-MISSING_DOCUMENTS"
            aria-selected={panelMode === "MISSING_DOCUMENTS"}
            onClick={() => setPanelMode("MISSING_DOCUMENTS")}
            className={panelMode === "MISSING_DOCUMENTS" ? primaryButtonClass : buttonClass}
          >
            <span>Hồ sơ thiếu</span>
            {missingState.kind === "loaded" ? (
              <span className="ml-1.5 rounded-full bg-black/10 px-1.5 py-0.5 text-xs tabular-nums">
                {missingState.data.summary.total_workers}
              </span>
            ) : null}
          </button>
        </div>

        {panelMode === "CCCD_RECONCILIATION" ? (
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
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void loadMissingDocumentWorkers({ page: 1 });
            }}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block space-y-1 text-xs font-medium text-muted">
                <span>Loại hồ sơ còn thiếu</span>
                <select
                  data-testid="missing-documents-filter-type"
                  value={missingTypeFilter}
                  onChange={(event) =>
                    setMissingTypeFilter(event.currentTarget.value as MissingDocumentFilterType)
                  }
                  className="min-h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground"
                >
                  {MISSING_DOCUMENT_FILTER_TYPES.map((typeKey) => (
                    <option key={typeKey} value={typeKey}>
                      {MISSING_DOCUMENT_FILTER_LABELS[typeKey]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1 text-xs font-medium text-muted">
                <span>Dự án</span>
                <select
                  data-testid="missing-documents-filter-project"
                  value={missingProjectFilter}
                  onChange={(event) => setMissingProjectFilter(event.currentTarget.value)}
                  className="min-h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground"
                >
                  <option value="">Tất cả dự án trong phạm vi</option>
                  {missingProjectOptions.map((proj) => (
                    <option key={proj.project_id} value={proj.project_id}>
                      {proj.project_display} ({proj.project_id})
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1 text-xs font-medium text-muted">
                <span>Trạng thái làm việc</span>
                <select
                  data-testid="missing-documents-filter-status"
                  value={missingStatusFilter}
                  onChange={(event) =>
                    setMissingStatusFilter(
                      event.currentTarget.value as MissingDocumentEmploymentStatus,
                    )
                  }
                  className="min-h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground"
                >
                  {MISSING_DOCUMENT_EMPLOYMENT_STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {MISSING_DOCUMENT_EMPLOYMENT_STATUS_LABELS[st]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1 text-xs font-medium text-muted">
                <span>Tìm theo Tên / CCCD / Mã NLĐ</span>
                <input
                  type="text"
                  data-testid="missing-documents-filter-search"
                  maxLength={100}
                  value={missingSearchInput}
                  onChange={(event) => setMissingSearchInput(event.currentTarget.value)}
                  placeholder="Nhập họ tên, 12 số CCCD hoặc mã NV…"
                  className="min-h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground"
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted">
                Chỉ thống kê NLĐ có trạng thái hiện tại là <strong>Đang làm việc (ON)</strong> hoặc{" "}
                <strong>Chưa xác nhận (UNCONFIRMED)</strong> còn thiếu ít nhất 1 trong 4 hồ sơ (Ảnh NLĐ, CCCD mặt trước, CCCD mặt sau, Hợp đồng lao động).
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-sm text-muted">
                  <span>Hiển thị</span>
                  <select
                    value={missingPageSize}
                    onChange={(event) => setMissingPageSize(Number(event.currentTarget.value))}
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
                  data-testid="missing-documents-reset-filters"
                  onClick={() => {
                    setMissingTypeFilter("ALL");
                    setMissingStatusFilter("ALL");
                    setMissingProjectFilter("");
                    setMissingSearchInput("");
                  }}
                  className={buttonClass}
                >
                  Xóa bộ lọc
                </button>
                <button
                  type="submit"
                  data-testid="missing-documents-load-submit"
                  disabled={
                    missingState.kind === "loading" ||
                    !hasMissingDocumentWorkersFilter({
                      missing_type: missingTypeFilter,
                      employment_status: missingStatusFilter,
                      project_id: missingProjectFilter,
                      q: missingSearchInput,
                    })
                  }
                  className={primaryButtonClass}
                >
                  {missingState.kind === "loading" ? "Đang tải…" : "Tải danh sách"}
                </button>
              </div>
            </div>
          </form>
        )}
      </Card>

      {panelMode === "MISSING_DOCUMENTS" ? (
        missingState.kind === "idle" || missingState.kind === "filter_required" ? (
          <EmptyState
            title="Chọn ít nhất một điều kiện lọc"
            description="Chọn loại hồ sơ, trạng thái làm việc, dự án hoặc nhập từ khóa rồi bấm “Tải danh sách”."
          />
        ) : missingState.kind === "loading" ? (
          <Card>
            <p className="py-6 text-center text-sm text-muted" role="status">
              Đang tải danh sách NLĐ thiếu hồ sơ…
            </p>
          </Card>
        ) : missingState.kind === "denied" ? (
          <ErrorState
            title="Không có quyền truy cập"
            detail="Tài khoản hiện tại không thuộc nhóm được phép xem danh sách Hồ sơ thiếu (Người tuyển, QLDA dự án, hoặc Admin được cấp quyền)."
          />
        ) : missingState.kind === "unavailable" ? (
          <ErrorState
            title="Danh sách Hồ sơ thiếu hiện không khả dụng"
            detail="Hệ thống chưa thể tải danh sách NLĐ thiếu hồ sơ lúc này. Vui lòng thử bấm Tải danh sách lại."
          />
        ) : missingState.kind === "error" ? (
          <ErrorState
            title="Không tải được danh sách Hồ sơ thiếu"
            detail="Phản hồi từ máy chủ không hợp lệ. Vui lòng kiểm tra bộ lọc và thử lại."
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <button
                type="button"
                onClick={() => {
                  setMissingTypeFilter("ALL");
                  void loadMissingDocumentWorkers({ missing_type: "ALL", page: 1 });
                }}
                className={`rounded-xl border p-3 text-left transition ${
                  missingState.data.filter_missing_type === "ALL"
                    ? "border-primary bg-primary/5"
                    : "border-border bg-surface hover:bg-surface-hover"
                }`}
              >
                <div className="text-xs text-muted">Tổng NLĐ thiếu hồ sơ</div>
                <div className="mt-1 text-xl font-bold tabular-nums text-foreground">
                  {missingState.data.summary.total_workers}
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMissingTypeFilter("WORKER_PORTRAIT");
                  void loadMissingDocumentWorkers({ missing_type: "WORKER_PORTRAIT", page: 1 });
                }}
                className={`rounded-xl border p-3 text-left transition ${
                  missingState.data.filter_missing_type === "WORKER_PORTRAIT"
                    ? "border-primary bg-primary/5"
                    : "border-border bg-surface hover:bg-surface-hover"
                }`}
              >
                <div className="text-xs text-muted">Thiếu Ảnh NLĐ</div>
                <div className="mt-1 text-xl font-bold tabular-nums text-foreground">
                  {missingState.data.summary.missing_worker_portrait}
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMissingTypeFilter("CCCD_FRONT");
                  void loadMissingDocumentWorkers({ missing_type: "CCCD_FRONT", page: 1 });
                }}
                className={`rounded-xl border p-3 text-left transition ${
                  missingState.data.filter_missing_type === "CCCD_FRONT"
                    ? "border-primary bg-primary/5"
                    : "border-border bg-surface hover:bg-surface-hover"
                }`}
              >
                <div className="text-xs text-muted">Thiếu CCCD mặt trước</div>
                <div className="mt-1 text-xl font-bold tabular-nums text-foreground">
                  {missingState.data.summary.missing_cccd_front}
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMissingTypeFilter("CCCD_BACK");
                  void loadMissingDocumentWorkers({ missing_type: "CCCD_BACK", page: 1 });
                }}
                className={`rounded-xl border p-3 text-left transition ${
                  missingState.data.filter_missing_type === "CCCD_BACK"
                    ? "border-primary bg-primary/5"
                    : "border-border bg-surface hover:bg-surface-hover"
                }`}
              >
                <div className="text-xs text-muted">Thiếu CCCD mặt sau</div>
                <div className="mt-1 text-xl font-bold tabular-nums text-foreground">
                  {missingState.data.summary.missing_cccd_back}
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMissingTypeFilter("EMPLOYMENT_CONTRACT");
                  void loadMissingDocumentWorkers({
                    missing_type: "EMPLOYMENT_CONTRACT",
                    page: 1,
                  });
                }}
                className={`rounded-xl border p-3 text-left transition ${
                  missingState.data.filter_missing_type === "EMPLOYMENT_CONTRACT"
                    ? "border-primary bg-primary/5"
                    : "border-border bg-surface hover:bg-surface-hover"
                }`}
              >
                <div className="text-xs text-muted">Thiếu Hợp đồng lao động</div>
                <div className="mt-1 text-xl font-bold tabular-nums text-foreground">
                  {missingState.data.summary.missing_employment_contract}
                </div>
              </button>
            </div>

            {missingState.data.items.length === 0 ? (
              <EmptyState
                title="Không có NLĐ nào thiếu hồ sơ theo điều kiện lọc"
                description="Tất cả NLĐ thuộc bộ lọc hiện tại đã đủ 4 loại hồ sơ hoặc không có hồ sơ nào khớp điều kiện."
              />
            ) : (
              <Card>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span>
                    Phạm vi hiển thị:{" "}
                    <strong className="text-foreground">
                      {missingState.data.scope_kind === "all"
                        ? "Toàn hệ thống (Admin)"
                        : missingState.data.scope_kind === "project"
                          ? "Dự án đang quản lý (QLDA)"
                          : "NLĐ do bạn tuyển (Người tuyển — chỉ xem)"}
                    </strong>
                  </span>
                  <span>
                    Quyền thao tác:{" "}
                    <strong className="text-foreground">
                      {missingState.data.can_upload
                        ? "Được phép upload bổ sung hồ sơ"
                        : "Chỉ xem (không được phép upload)"}
                    </strong>
                  </span>
                </div>

                <div className="overflow-x-auto rounded-xl border border-border bg-surface">
                  <table
                    className="r22-report-table w-full min-w-[780px] text-left text-sm"
                    data-testid="missing-documents-table"
                  >
                    <caption className="sr-only">
                      Danh sách người lao động còn thiếu hồ sơ bắt buộc
                    </caption>
                    <thead className="bg-surface-muted text-xs uppercase tracking-wide text-muted">
                      <tr>
                        <th scope="col" className="px-3 py-3">Tên NLĐ</th>
                        <th scope="col" className="px-3 py-3">CCCD</th>
                        <th scope="col" className="px-3 py-3">Hồ sơ còn thiếu</th>
                        <th scope="col" className="px-3 py-3">Dự án / Trạng thái</th>
                        <th scope="col" className="px-3 py-3">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {missingState.data.items.map((item) => (
                        <tr
                          key={item.entry_id}
                          className="transition-colors duration-[var(--ui-motion-hover,160ms)] motion-reduce:transition-none hover:bg-surface-hover"
                        >
                          <td className="px-3 py-3">
                            <div className="font-medium text-foreground">{item.display_name}</div>
                            <div className="font-mono text-xs tabular-nums text-muted">
                              {item.employee_code}
                            </div>
                          </td>
                          <td className="px-3 py-3 font-mono text-xs tabular-nums">
                            {item.national_id ?? "—"}
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex flex-wrap gap-1.5">
                              {item.missing_documents.map((docType) => (
                                <span
                                  key={docType}
                                  className="inline-flex rounded-full border border-status-warning-border bg-status-warning-bg px-2.5 py-0.5 text-xs font-medium text-status-warning-text"
                                >
                                  {MISSING_DOCUMENT_TYPE_LABELS[docType]}
                                </span>
                              ))}
                            </div>
                            <div className="mt-1 text-xs text-muted">
                              Đã có {4 - item.missing_documents.length}/4 hồ sơ
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <div>{item.project_display}</div>
                            <div className="text-xs text-muted">
                              Vào làm:{" "}
                              <span className="font-mono tabular-nums">{item.first_work_date}</span>
                              {item.recruiter_display ? ` · Tuyển: ${item.recruiter_display}` : ""}
                              {" · "}
                              <span className="font-medium text-foreground">
                                {item.employment_status === "ON"
                                  ? "Đang làm việc"
                                  : "Chưa xác nhận"}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            {item.can_upload ? (
                              <button
                                type="button"
                                data-testid={`missing-documents-open-upload-${item.entry_id}`}
                                onClick={() => openMissingDocumentItem(item)}
                                className={buttonClasses({ variant: "secondary", size: "sm" })}
                              >
                                Bổ sung
                              </button>
                            ) : (
                              <span
                                data-testid={`missing-documents-readonly-${item.entry_id}`}
                                className="inline-flex rounded-full border border-border bg-surface-muted px-2.5 py-1 text-xs text-muted"
                              >
                                Chỉ xem (Người tuyển)
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
                  <span>
                    Tổng số:{" "}
                    <strong className="font-semibold tabular-nums text-foreground">
                      {missingState.data.total_count}
                    </strong>{" "}
                    NLĐ · Trang{" "}
                    <strong className="font-semibold tabular-nums text-foreground">
                      {missingState.data.page}
                    </strong>
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={missingState.data.page <= 1}
                      onClick={() =>
                        void loadMissingDocumentWorkers({
                          page: Math.max(1, missingState.data.page - 1),
                        })
                      }
                      className={buttonClass}
                    >
                      Trang trước
                    </button>
                    <button
                      type="button"
                      disabled={!missingState.data.has_more}
                      onClick={() =>
                        void loadMissingDocumentWorkers({
                          page: missingState.data.page + 1,
                        })
                      }
                      className={buttonClass}
                    >
                      Trang sau
                    </button>
                  </div>
                </div>
              </Card>
            )}
          </>
        )
      ) : state.kind === "loading" ? (
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
                        {item.entered.national_id ?? "—"}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs tabular-nums">
                        {item.qr.candidate_data?.national_id ?? item.qr.national_id ?? "—"}
                      </td>
                      <td className="px-3 py-3">
                        <ReconciliationBadge status={item.reconciliation_status} resolvedAction={item.resolved_action} />
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
                          className={buttonClasses({ variant: "secondary", size: "sm" })}
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
              <Alert tone="error" title="Không thể thực hiện">
                {actionError}
              </Alert>
            ) : null}

            {/* 1. Bảng so sánh Đã nhập vs QR */}
            <div className="rounded-xl border border-border bg-surface p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-semibold text-foreground">
                  1. Đối chiếu thông tin đã nhập và dữ liệu từ QR CCCD
                </h4>
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
                      const displayEntered = rawEntered ?? "(Đang trống)";
                      const displayQr = rawQr ?? "—";
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
                Mọi thao tác đều được xác nhận, lưu lịch sử kiểm toán và áp dụng ngay trong phạm vi hồ sơ bạn được phép xử lý. Nếu QR không đọc được hoặc thông tin sai, người nhập có thể nhập thông tin đúng tại đây.
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
                <button
                  type="button"
                  data-testid="cccd-review-mode-manual-details"
                  aria-pressed={actionMode === "MANUAL_UPDATE_DETAILS"}
                  onClick={() => {
                    setActionMode("MANUAL_UPDATE_DETAILS");
                    setConfirmStep(null);
                    setActionError(null);
                  }}
                  className={
                    actionMode === "MANUAL_UPDATE_DETAILS" ? primaryButtonClass : buttonClass
                  }
                >
                  Nhập/sửa thông tin thủ công
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
                ) : actionMode === "STANDARDIZE_FROM_QR" ? (
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
                ) : (
                  <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
                    <label className="block space-y-1">
                      <span className="font-medium text-foreground">Số CCCD (12 chữ số) *</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={12}
                        value={manualDetails.national_id}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setConfirmStep(null);
                          setManualDetails((current) => ({ ...current, national_id: value }));
                        }}
                        className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-foreground"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="font-medium text-foreground">Họ và tên</span>
                      <input
                        type="text"
                        maxLength={256}
                        value={manualDetails.display_name}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setConfirmStep(null);
                          setManualDetails((current) => ({ ...current, display_name: value }));
                        }}
                        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="font-medium text-foreground">Ngày sinh</span>
                      <input
                        type="text"
                        maxLength={10}
                        placeholder="dd/mm/yyyy"
                        value={manualDetails.date_of_birth}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setConfirmStep(null);
                          setManualDetails((current) => ({ ...current, date_of_birth: value }));
                        }}
                        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="font-medium text-foreground">Giới tính</span>
                      <select
                        value={manualDetails.gender}
                        onChange={(event) => {
                          const value = event.currentTarget.value as typeof manualDetails.gender;
                          setConfirmStep(null);
                          setManualDetails((current) => ({ ...current, gender: value }));
                        }}
                        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
                      >
                        <option value="">Chưa chọn</option>
                        <option value="MALE">Nam</option>
                        <option value="FEMALE">Nữ</option>
                        <option value="OTHER">Khác</option>
                      </select>
                    </label>
                    <label className="block space-y-1 sm:col-span-2">
                      <span className="font-medium text-foreground">Địa chỉ thường trú</span>
                      <textarea
                        maxLength={1024}
                        rows={3}
                        value={manualDetails.address}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setConfirmStep(null);
                          setManualDetails((current) => ({ ...current, address: value }));
                        }}
                        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="font-medium text-foreground">Ngày cấp CCCD</span>
                      <input
                        type="text"
                        maxLength={10}
                        placeholder="dd/mm/yyyy"
                        value={manualDetails.national_id_issued_at}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setConfirmStep(null);
                          setManualDetails((current) => ({ ...current, national_id_issued_at: value }));
                        }}
                        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
                      />
                    </label>
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
                        : actionMode === "MANUAL_UPDATE_DETAILS"
                          ? "Tiếp tục xác nhận lưu thông tin"
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
                        : confirmStep === "MANUAL_UPDATE_DETAILS"
                          ? "Xác nhận lưu trực tiếp thông tin NLĐ vừa nhập? Thao tác sẽ cập nhật hồ sơ và ghi lịch sử kiểm toán."
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

      {selectedMissingItem ? (
        <FormDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) closeMissingDocumentDialog();
          }}
          title={`Bổ sung hồ sơ thiếu · ${selectedMissingItem.display_name}`}
          description={`Mã NV: ${selectedMissingItem.employee_code} · CCCD: ${selectedMissingItem.national_id ?? "—"} · Dự án: ${selectedMissingItem.project_display}`}
        >
          <div className="space-y-4 text-sm" data-testid="missing-documents-upload-dialog">
            {missingActionError ? (
              <Alert tone="error" title="Không thể thực hiện">
                {missingActionError}
              </Alert>
            ) : null}

            <div className="rounded-xl border border-border bg-surface p-3 text-xs text-muted">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div>
                  Người tuyển:{" "}
                  <strong className="text-foreground">
                    {selectedMissingItem.recruiter_display || "—"}
                  </strong>
                </div>
                <div>
                  Ngày vào làm:{" "}
                  <strong className="font-mono text-foreground">
                    {selectedMissingItem.first_work_date}
                  </strong>
                </div>
                <div>
                  Trạng thái:{" "}
                  <strong className="text-foreground">
                    {selectedMissingItem.employment_status === "ON"
                      ? "Đang làm việc (ON)"
                      : "Chưa xác nhận (UNCONFIRMED)"}
                  </strong>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {MISSING_DOCUMENT_TYPES.map((docType) => {
                const isMissing = selectedMissingItem.missing_documents.includes(docType);
                const existingDoc =
                  selectedMissingItem.documents.find((d) => d.document_type === docType) ?? null;
                const label = MISSING_DOCUMENT_TYPE_LABELS[docType];
                const previewUrl = existingDoc ? previewUrls[existingDoc.document_id] : undefined;
                const acceptTypes =
                  docType === "WORKER_PORTRAIT"
                    ? "image/jpeg,image/png"
                    : "image/jpeg,image/png,application/pdf";
                const canInlinePreview =
                  existingDoc !== null &&
                  docType !== "EMPLOYMENT_CONTRACT" &&
                  (existingDoc.mime_type === "image/jpeg" || existingDoc.mime_type === "image/png");

                return (
                  <div
                    key={docType}
                    data-testid={`missing-documents-slot-${docType}`}
                    className="rounded-lg border border-border bg-surface-muted/40 p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">{label}</span>
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${
                          isMissing
                            ? "border-status-warning-border bg-status-warning-bg text-status-warning-text"
                            : "border-status-success-border bg-status-success-bg text-status-success-text"
                        }`}
                      >
                        {isMissing
                          ? "Còn thiếu"
                          : `Đã có (v${existingDoc?.document_version ?? 1})`}
                      </span>
                    </div>

                    {existingDoc ? (
                      <div className="text-xs text-muted">
                        Định dạng: <span className="font-mono">{existingDoc.mime_type}</span> ·{" "}
                        {Math.max(1, Math.round(existingDoc.size_bytes / 1024))} KB
                      </div>
                    ) : (
                      <div className="text-xs text-muted">
                        Chưa có tệp hợp lệ cho {label.toLowerCase()}.
                      </div>
                    )}

                    {previewUrl ? (
                      <img
                        src={previewUrl}
                        alt={`Ảnh ${label}`}
                        className="max-h-48 w-full rounded border border-border bg-black/5 object-contain"
                      />
                    ) : null}

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {existingDoc ? (
                        canInlinePreview ? (
                          <button
                            type="button"
                            disabled={previewLoadingId === existingDoc.document_id}
                            onClick={() =>
                              void loadMissingPreview(
                                selectedMissingItem.entry_id,
                                existingDoc.document_id,
                                docType,
                              )
                            }
                            className={buttonClass}
                          >
                            {previewLoadingId === existingDoc.document_id
                              ? "Đang tải ảnh…"
                              : previewUrl
                                ? "Đã hiển thị ảnh"
                                : "Xem ảnh"}
                          </button>
                        ) : (
                          <a
                            href={`/api/direct-entry/entries/${encodeURIComponent(selectedMissingItem.entry_id)}/documents/${encodeURIComponent(existingDoc.document_id)}/download`}
                            target="_blank"
                            rel="noreferrer"
                            className={buttonClass}
                          >
                            Tải / Xem tệp
                          </a>
                        )
                      ) : null}

                      {selectedMissingItem.can_upload ? (
                        <label
                          className={`${
                            isMissing ? primaryButtonClass : buttonClass
                          } cursor-pointer`}
                        >
                          <span>
                            {uploadingMissingType === docType
                              ? "Đang tải lên…"
                              : isMissing
                                ? "Bổ sung ngay"
                                : "Tải bản thay thế"}
                          </span>
                          <input
                            type="file"
                            data-testid={`missing-documents-input-${docType}`}
                            accept={acceptTypes}
                            hidden
                            disabled={uploadingMissingType !== null}
                            onChange={(event) =>
                              void handleUploadMissingDocumentFile(
                                selectedMissingItem,
                                docType,
                                event,
                              )
                            }
                          />
                        </label>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                disabled={uploadingMissingType !== null}
                onClick={closeMissingDocumentDialog}
                className={buttonClass}
              >
                Đóng
              </button>
            </div>
          </div>
        </FormDialog>
      ) : null}
    </div>
  );
}
