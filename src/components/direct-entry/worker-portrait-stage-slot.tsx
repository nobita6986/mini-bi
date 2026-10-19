"use client";

/**
 * W2S1 - Slot anh ho so dung chung cho MOI be mat tao NLD (dan Excel, bang nhap, quick-add).
 *
 * Chi hien thi + phat su kien; toan bo vong doi nam trong `useWorkerPortraitStages`.
 */

import {
  portraitStageErrorMessage,
  type PortraitStageSlot,
  type WorkerStageDocumentType,
} from "@/lib/direct-entry/worker-portrait-stage-client";
import styles from "./direct-entry-shell.module.css";

export const PORTRAIT_SLOT_LABEL = "Ảnh NLĐ (JPEG/PNG, tối đa 10 MiB)";

export type PortraitSlotProps = {
  /** Khoa dong on dinh trong be mat hien tai (sourceRow khi dan Excel, clientRowId khi nhap). */
  rowKey: string;
  /** `data-testid` rieng cua be mat (giu on dinh cho test). */
  testIdSuffix: string;
  slot: PortraitStageSlot | undefined;
  busy: boolean;
  retryable: boolean;
  onStage(rowKey: string, file: File): void;
  onRetry(rowKey: string): void;
  onCancel(rowKey: string, stageId: string): void;
};

const DOCUMENT_SLOT_LABELS: Readonly<Record<WorkerStageDocumentType, string>> = {
  WORKER_PORTRAIT: "Ảnh NLĐ (JPEG/PNG, tối đa 10 MiB)",
  CCCD_FRONT: "CCCD mặt trước (ảnh hoặc PDF, tối đa 10 MiB)",
  CCCD_BACK: "CCCD mặt sau (ảnh hoặc PDF, tối đa 10 MiB)",
  EMPLOYMENT_CONTRACT: "Hợp đồng (ảnh hoặc PDF, tối đa 10 MiB)",
};

function documentErrorMessage(code: string, documentType: WorkerStageDocumentType): string {
  if (documentType === "WORKER_PORTRAIT") return portraitStageErrorMessage(code);
  if (code === "DOCUMENT_SIZE_INVALID") return "Tệp phải lớn hơn 0 và không vượt quá 10 MiB.";
  if (code === "DOCUMENT_MIME_INVALID") return "Chỉ chấp nhận JPEG, PNG hoặc PDF.";
  if (code === "DOCUMENT_CONTENT_INVALID") return "Nội dung tệp không khớp định dạng đã chọn.";
  if (code === "DOCUMENT_DENIED") return "Bạn không có quyền tải hồ sơ NLĐ.";
  return "Không xử lý được tệp hồ sơ. Hãy thử lại.";
}

export function WorkerPortraitStageSlot(props: PortraitSlotProps) {
  return <WorkerDocumentStageSlot {...props} documentType="WORKER_PORTRAIT" />;
}

export type WorkerDocumentStageSlotProps = PortraitSlotProps & {
  documentType: WorkerStageDocumentType;
};

export function WorkerDocumentStageSlot({
  rowKey,
  testIdSuffix,
  slot,
  busy,
  retryable,
  onStage,
  onRetry,
  onCancel,
  documentType,
}: WorkerDocumentStageSlotProps) {
  const inputId = "document-stage-" + documentType.toLowerCase() + "-" + testIdSuffix;
  const staging = slot?.status === "staging";
  const isPortrait = documentType === "WORKER_PORTRAIT";
  const title = isPortrait ? "Ảnh NLĐ" : DOCUMENT_SLOT_LABELS[documentType].split(" (")[0];
  const statusPrefix = isPortrait ? "profile-portrait-" : "profile-document-" + documentType.toLowerCase() + "-";
  return (
    <div className={styles.profileSection} data-testid={statusPrefix + testIdSuffix}>
      <h4>{title}</h4>
      <label className={styles.field} htmlFor={inputId}>
        <span>{DOCUMENT_SLOT_LABELS[documentType]}</span>
        <span className={styles.filePickerControl}>
          <input
            id={inputId}
            className={styles.filePickerInput}
            type="file"
            accept={isPortrait ? "image/jpeg,image/png" : "image/jpeg,image/png,application/pdf"}
            disabled={busy || staging || retryable}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0] ?? null;
              event.currentTarget.value = "";
              if (file !== null) onStage(rowKey, file);
            }}
          />
          <span className={styles.filePickerButton} aria-hidden="true">
            {slot?.status === "staged" ? "Chọn tệp khác" : "Chọn tệp"}
          </span>
        </span>
      </label>
      <p
        className={slot?.status === "error" ? styles.documentError : styles.documentStatus}
        role={slot?.status === "error" ? "alert" : "status"}
        data-testid={statusPrefix + "status-" + testIdSuffix}
      >
        {slot === undefined ? (isPortrait ? "Chưa chọn ảnh cho dòng này." : "Chưa chọn tệp cho dòng này.") : null}
        {staging ? "Đang tải lên bản nháp của máy chủ…" : null}
        {slot?.status === "staged"
          ? "Tệp đang ở bản nháp; máy chủ sẽ gắn vào hồ sơ khi lưu thành công." : null}
        {slot?.status === "error" ? documentErrorMessage(slot.code, documentType) : null}
        {slot?.status === "stale"
          ? "Tệp cũ đã bị vô hiệu hóa vì dòng dữ liệu đã thay đổi và chưa hủy được trên máy chủ. " +
            "Tệp này sẽ không được gắn vào hồ sơ nào; hãy thử dọn lại." : null}
      </p>
      {slot?.status === "error" && retryable ? (
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={busy}
          data-testid={statusPrefix + "retry-" + testIdSuffix}
          onClick={() => onRetry(rowKey)}
        >
          Thử lại cùng tệp
        </button>
      ) : null}
      {slot?.status === "staged" ? (
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={busy}
          data-testid={statusPrefix + "cancel-" + testIdSuffix}
          onClick={() => onCancel(rowKey, slot.stageId)}
        >
          Hủy tệp
        </button>
      ) : null}
      {slot?.status === "stale" ? (
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={busy}
          data-testid={statusPrefix + "cleanup-" + testIdSuffix}
          onClick={() => onCancel(rowKey, slot.stageId)}
        >
          Dọn lại tệp cũ
        </button>
      ) : null}
    </div>
  );
}
