"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CCCD_DOCUMENT_TYPES,
  CCCD_MAX_BYTES,
  CCCD_MIME_TYPES,
  CCCD_SLOT_LABELS,
  CCCD_STATUS_UNKNOWN_LABEL,
  cccdProgressLabel,
  cccdSlotComplete,
  type CccdDocumentSummary,
  type CccdDocumentType,
  type CccdUploadFile,
} from "@/lib/direct-entry/cccd-document-pair";
import {
  CCCD_VALIDATION_PENDING_CODE,
  EMPTY_CCCD_KEY_STATE,
  runCccdUpload,
  sha256HexFromBytes,
  type CccdKeyState,
  type CccdSlotResult,
} from "@/lib/direct-entry/cccd-upload-runner";
import { createCccdTransport } from "@/lib/direct-entry/cccd-transport";
import {
  fetchEntryDetail,
  type EntryDetailProjection,
} from "@/lib/direct-entry/document-detail-projection";
import type { LiveDraftRow } from "@/lib/direct-entry/live-controller";
import styles from "./direct-entry-shell.module.css";

const REASON_MAX_LENGTH = 4000;

type SlotInput = { blob: Blob | null; sizeBytes: number; mimeType: string; error: string | null };

const EMPTY_SLOT: SlotInput = { blob: null, sizeBytes: 0, mimeType: "", error: null };

type Props = {
  row: LiveDraftRow | null;
  /** entry_own + document_upload + dong dang o trang thai sua duoc (REVIEW/SUBMITTED => read-only). */
  canEdit: boolean;
  canView: boolean;
  /** Ly do thay the, chi dung khi boundary hien huu yeu cau (entry SUBMITTED). */
  requireReason?: boolean;
  onStatus(entryId: string, entryVersion: number, documents: readonly CccdDocumentSummary[]): void;
  onEntryVersionChange(rowId: string, entryVersion: number): void;
};

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  DOCUMENT_STORAGE_UNAVAILABLE: "Kho lưu trữ chưa sẵn sàng. Tệp vẫn ở trên thiết bị; bạn có thể thử lại.",
  DOCUMENT_VERSION_CONFLICT: "Dữ liệu đã thay đổi trên máy chủ. Hãy tải lại trạng thái rồi thử lại.",
  DOCUMENT_DENIED: "Bạn không có quyền tải tài liệu cho dòng này.",
  DOCUMENT_UPLOAD_MISSING: "Chưa nhận được tệp trên kho lưu trữ. Hãy thử lại.",
  DOCUMENT_FINALIZE_UNAVAILABLE: "Chưa hoàn tất ghi nhận tài liệu. Hãy thử lại.",
  DOCUMENT_RESPONSE_INVALID: "Máy chủ trả về kết quả không đọc được. Hãy thử lại.",
  DOCUMENT_SIZE_INVALID: "Tệp phải lớn hơn 0 và không vượt quá 10 MiB.",
  DOCUMENT_MIME_INVALID: "Chỉ chấp nhận JPEG, PNG hoặc PDF.",
  DOCUMENT_CONTENT_INVALID: "Nội dung tệp không khớp với định dạng đã chọn.",
  [CCCD_VALIDATION_PENDING_CODE]: "Đã ghi nhận tệp; tài liệu đang chờ kiểm tra nên chưa tính là hoàn tất.",
});

function friendlyError(code: string | null): string {
  if (code === null) return "Không tải được tài liệu. Hãy thử lại.";
  return ERROR_MESSAGES[code] ?? "Không thể tải tài liệu. Hãy thử lại.";
}

function formatSize(size: number): string {
  return (size / (1024 * 1024)).toFixed(2) + " MiB";
}

function isAllowedMime(value: string): boolean {
  return CCCD_MIME_TYPES.some((mime) => mime === value);
}

export function DirectEntryCccdManager({
  row,
  canEdit,
  canView,
  requireReason,
  onStatus,
  onEntryVersionChange,
}: Props) {
  const entryId = row?.entryId ?? null;
  const rowId = row?.rowId ?? "";
  const [detail, setDetail] = useState<EntryDetailProjection | null>(null);
  // Component duoc mount lai theo entry_id (xem key o direct-entry-live.tsx), nen trang thai
  // ban dau da dung va khong can reset bang effect.
  const [loadState, setLoadState] =
    useState<"idle" | "loading" | "ready" | "error">(entryId === null ? "idle" : "loading");
  const [slots, setSlots] = useState<Record<CccdDocumentType, SlotInput>>({
    CCCD_FRONT: EMPTY_SLOT,
    CCCD_BACK: EMPTY_SLOT,
  });
  const [results, setResults] = useState<Partial<Record<CccdDocumentType, CccdSlotResult>>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  // Callback/rowId qua ref de effect chi phu thuoc entryId: mo ho so chi phat DUNG MOT GET.
  const latest = useRef({ onStatus, onEntryVersionChange, rowId });
  const keyState = useRef<CccdKeyState>(EMPTY_CCCD_KEY_STATE);

  // Dong bo ref SAU moi lan render (khong ghi ref trong luc render).
  useEffect(() => {
    latest.current = { onStatus, onEntryVersionChange, rowId };
  });

  useEffect(() => {
    if (entryId === null || !canView) return;
    let cancelled = false;
    void fetchEntryDetail(entryId, fetch).then((projection) => {
      if (cancelled) return;
      if (!projection) {
        setLoadState("error");
        return;
      }
      setDetail(projection);
      setLoadState("ready");
      latest.current.onEntryVersionChange(latest.current.rowId, projection.entryVersion);
      latest.current.onStatus(entryId, projection.entryVersion, projection.documents);
    });
    return () => { cancelled = true; };
  }, [canView, entryId]);

  const reload = useCallback(async () => {
    if (entryId === null) return;
    setLoadState("loading");
    const projection = await fetchEntryDetail(entryId, fetch);
    if (!projection) {
      setLoadState("error");
      setMessage("Không tải được trạng thái hồ sơ. Hãy thử lại.");
      return;
    }
    setDetail(projection);
    setLoadState("ready");
    latest.current.onEntryVersionChange(latest.current.rowId, projection.entryVersion);
    latest.current.onStatus(entryId, projection.entryVersion, projection.documents);
  }, [entryId]);

  const selectFile = (documentType: CccdDocumentType, file: File | null) => {
    setResults((current) => {
      const next = { ...current };
      delete next[documentType];
      return next;
    });
    setMessage("");
    if (!file) {
      setSlots((current) => ({ ...current, [documentType]: EMPTY_SLOT }));
      return;
    }
    if (file.size < 1 || file.size > CCCD_MAX_BYTES) {
      setSlots((current) => ({ ...current, [documentType]: {
        blob: null, sizeBytes: file.size, mimeType: file.type, error: friendlyError("DOCUMENT_SIZE_INVALID") } }));
      return;
    }
    if (!isAllowedMime(file.type)) {
      setSlots((current) => ({ ...current, [documentType]: {
        blob: null, sizeBytes: file.size, mimeType: file.type, error: friendlyError("DOCUMENT_MIME_INVALID") } }));
      return;
    }
    setSlots((current) => ({ ...current, [documentType]: {
      blob: file, sizeBytes: file.size, mimeType: file.type, error: null } }));
  };

  const upload = useCallback(async (types: readonly CccdDocumentType[]) => {
    if (entryId === null || detail === null || busy || !canEdit) return;
    const trimmedReason = requireReason ? reason.trim() : null;
    if (requireReason && (trimmedReason === null || trimmedReason.length < 1 ||
        trimmedReason.length > REASON_MAX_LENGTH)) {
      setMessage("Lý do thay thế tài liệu là bắt buộc và tối đa 4000 ký tự.");
      return;
    }
    const files: CccdUploadFile[] = [];
    const blobs: Partial<Record<CccdDocumentType, Blob>> = {};
    for (const documentType of CCCD_DOCUMENT_TYPES) {
      if (!types.includes(documentType)) continue;
      const slot = slots[documentType];
      if (!slot.blob) continue;
      let sha256: string | null = null;
      try {
        sha256 = await sha256HexFromBytes(await slot.blob.arrayBuffer());
      } catch {
        sha256 = null;
      }
      if (sha256 === null) {
        setMessage("Không xác nhận được nội dung tệp đã chọn. Hãy chọn lại tệp.");
        return;
      }
      files.push({
        documentType,
        sizeBytes: slot.sizeBytes,
        mimeType: slot.mimeType,
        sha256,
      });
      blobs[documentType] = slot.blob;
    }
    if (files.length === 0) return;

    setBusy(true);
    setMessage("");
    try {
      // Giu projection day du cua lan reload DUY NHAT de cap nhat dialog ma khong GET them.
      const reloaded: { projection: EntryDetailProjection | null } = { projection: null };
      const transport = createCccdTransport({
        entryId,
        reason: trimmedReason,
        blobs,
        fetchImpl: fetch,
        reloadDetail: async () => {
          const projection = await fetchEntryDetail(entryId, fetch);
          if (!projection) return null;
          reloaded.projection = projection;
          latest.current.onEntryVersionChange(latest.current.rowId, projection.entryVersion);
          latest.current.onStatus(entryId, projection.entryVersion, projection.documents);
          return { entryVersion: projection.entryVersion, documents: projection.documents };
        },
      });
      const { result, keyState: nextKeyState } = await runCccdUpload({
        entryId,
        entryVersion: detail.entryVersion,
        files,
        keyState: keyState.current,
        transport,
        generateKey: () => crypto.randomUUID(),
      });
      keyState.current = nextKeyState;
      if (result.planErrors.length > 0) {
        setMessage(result.planErrors.map((error) => error.message).join(" "));
        return;
      }
      setResults((current) => {
        const next = { ...current };
        for (const slot of result.slots) next[slot.documentType] = slot;
        return next;
      });
      // Chi xoa tệp da duoc may chu ghi nhan; mat loi giu nguyen bytes de retry cung fingerprint.
      setSlots((current) => {
        const next = { ...current };
        for (const slot of result.slots) {
          if (slot.status === "failed") continue;
          next[slot.documentType] = { ...EMPTY_SLOT };
        }
        return next;
      });
      if (reloaded.projection !== null) {
        setDetail(reloaded.projection);
      } else {
        setDetail((current) => current === null ? current
          : { ...current, entryVersion: result.entryVersion });
      }
      const failed = result.slots.filter((slot) => slot.status === "failed");
      const conflict = failed.find((slot) => slot.conflict);
      if (conflict) {
        setMessage(friendlyError(conflict.code) + " Hãy bấm Tải lại trạng thái rồi thử lại.");
      } else if (result.detail === null && result.slots.some((slot) => slot.status !== "failed")) {
        setMessage("Đã ghi nhận tài liệu nhưng chưa tải lại được trạng thái. Hãy bấm Tải lại trạng thái.");
      } else if (failed.length > 0) {
        setMessage(friendlyError(failed[0].code));
      } else {
        setMessage("Đã gửi hồ sơ lên máy chủ.");
      }
    } finally {
      setBusy(false);
    }
  }, [busy, canEdit, detail, entryId, reason, requireReason, slots]);

  const completion = useMemo(
    () => cccdSlotComplete(detail?.documents ?? []),
    [detail],
  );
  const selectedTypes = CCCD_DOCUMENT_TYPES.filter((type) => slots[type].blob !== null);

  if (row === null || entryId === null) return null;

  return (
    <section className={styles.documentSection} data-testid="cccd-manager"
      aria-labelledby={`cccd-manager-${rowId}`}>
      <h3 className={styles.documentTitle} id={`cccd-manager-${rowId}`}>CCCD hai mặt</h3>
      <p className={styles.documentStatus}>
        Chọn ảnh hoặc PDF cho từng mặt CCCD. Tệp chỉ được gửi tới kho lưu trữ an toàn.
      </p>
      <div className={styles.drawerFields}>
        {!canView && <p className={styles.documentStatus}>Trạng thái hồ sơ được ẩn theo quyền truy cập.</p>}
        {canView && loadState === "loading" && (
          <p className={styles.documentStatus} aria-live="polite">
            Đang tải trạng thái hồ sơ… Bạn vẫn có thể chọn tệp trong lúc chờ.
          </p>
        )}
        {canView && loadState === "error" && (
          <div className={styles.documentError} role="alert">
            Không tải được trạng thái hồ sơ.
            <button type="button" className={styles.secondaryButton} onClick={() => void reload()}>
              Tải lại trạng thái
            </button>
          </div>
        )}
        {canView && detail !== null && (
          <p className={styles.documentStatus} data-testid="cccd-progress" aria-live="polite">
            Tiến độ: <strong>{cccdProgressLabel(detail.documents)}</strong>
          </p>
        )}
        {!canEdit && (
          <p className={styles.drawerLockNotice} role="status">
            Dòng này không ở bản nháp nên hồ sơ chỉ xem được; mọi thay đổi phải đi qua
            yêu cầu thay đổi hiện hữu.
          </p>
        )}
        {requireReason && (
          <label className={styles.field}>
            <span>Lý do thay thế tài liệu</span>
            <textarea aria-label="Lý do thay thế tài liệu" rows={3} maxLength={REASON_MAX_LENGTH}
              disabled={!canEdit || busy}
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)} />
          </label>
        )}
        {CCCD_DOCUMENT_TYPES.map((documentType) => {
          const slot = slots[documentType];
          const result = results[documentType];
          const complete = completion[documentType];
          return (
            <section className={styles.cccdSlot} key={documentType}
              aria-label={CCCD_SLOT_LABELS[documentType]}>
              <h3 className={styles.documentTitle}>{CCCD_SLOT_LABELS[documentType]}</h3>
              <p className={styles.documentStatus} data-testid={"cccd-slot-" + documentType}>
                {complete ? "Đã hoàn tất" : "Chưa hoàn tất"}
              </p>
              <label className={styles.field}>
                <span>Chọn tệp (JPEG, PNG, PDF · tối đa 10 MiB)</span>
                <span className={styles.filePickerControl}>
                  <input
                    id={"cccd-file-" + documentType + "-" + rowId}
                    className={styles.filePickerInput}
                    type="file"
                    aria-label={"Chọn tệp cho " + CCCD_SLOT_LABELS[documentType]}
                    accept="image/jpeg,image/png,application/pdf"
                    disabled={!canEdit || busy}
                    onChange={(event) => {
                      selectFile(documentType, event.currentTarget.files?.[0] ?? null);
                      event.currentTarget.value = "";
                    }}
                  />
                  <span className={styles.filePickerButton} aria-hidden="true">
                    {slot.blob ? "Chọn lại tệp" : "Chọn tệp"}
                  </span>
                </span>
              </label>
              {slot.blob && (
                <p className={styles.documentStatus}>
                  Đã chọn tệp · {formatSize(slot.sizeBytes)} · {slot.mimeType || "không rõ loại"}
                </p>
              )}
              {slot.error && <p className={styles.documentError} role="alert">{slot.error}</p>}
              {result && (
                <p className={result.status === "failed" ? styles.documentError : styles.documentStatus}
                  role={result.status === "failed" ? "alert" : "status"}>
                  {result.status === "complete"
                    ? "Máy chủ đã xác nhận tài liệu hoàn tất."
                    : result.status === "pending"
                      ? friendlyError(result.code)
                      : friendlyError(result.code)}
                </p>
              )}
              {result?.status === "failed" && result.retryable && slot.blob && (
                <button type="button" className={styles.secondaryButton} disabled={busy}
                  data-testid={"cccd-retry-" + documentType}
                  onClick={() => void upload([documentType])}>
                  Thử lại {CCCD_SLOT_LABELS[documentType]}
                </button>
              )}
            </section>
          );
        })}
        {message !== "" && (
          <p className={styles.documentStatus} role="status" data-testid="cccd-message">{message}</p>
        )}
      </div>
      <div className={styles.drawerActions}>
        <button type="button" className={styles.secondaryButton} disabled={busy}
          onClick={() => void reload()}>
          Tải lại trạng thái
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          data-testid="cccd-upload"
          disabled={!canEdit || busy || detail === null || selectedTypes.length === 0}
          onClick={() => void upload(selectedTypes)}
        >
          {busy ? "Đang gửi…" : "Tải lên " + selectedTypes.length + " mặt"}
        </button>
      </div>
    </section>
  );
}

export { CCCD_STATUS_UNKNOWN_LABEL };
