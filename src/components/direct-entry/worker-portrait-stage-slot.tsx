"use client";

/**
 * W2S1 - Slot anh ho so dung chung cho MOI be mat tao NLD (dan Excel, bang nhap, quick-add).
 *
 * Chi hien thi + phat su kien; toan bo vong doi nam trong `useWorkerPortraitStages`.
 */

import {
  portraitStageErrorMessage,
  type PortraitStageSlot,
} from "@/lib/direct-entry/worker-portrait-stage-client";
import styles from "./direct-entry-shell.module.css";

export const PORTRAIT_SLOT_LABEL = "Ảnh hồ sơ (JPEG/PNG, tối đa 10 MiB)";

export type PortraitSlotProps = {
  /** Khoa dong on dinh trong be mat hien tai (sourceRow khi dan Excel, clientRowId khi nhap). */
  rowKey: string;
  /** `data-testid` rieng cua be mat (giu on dinh cho test). */
  testIdSuffix: string;
  slot: PortraitStageSlot | undefined;
  busy: boolean;
  onStage(rowKey: string, file: File): void;
  onCancel(rowKey: string, stageId: string): void;
};

export function WorkerPortraitStageSlot({
  rowKey,
  testIdSuffix,
  slot,
  busy,
  onStage,
  onCancel,
}: PortraitSlotProps) {
  const inputId = "portrait-stage-" + testIdSuffix;
  const staging = slot?.status === "staging";
  return (
    <div className={styles.profileSection} data-testid={"profile-portrait-" + testIdSuffix}>
      <h4>Ảnh hồ sơ</h4>
      <label className={styles.field} htmlFor={inputId}>
        <span>{PORTRAIT_SLOT_LABEL}</span>
        <span className={styles.filePickerControl}>
          <input
            id={inputId}
            className={styles.filePickerInput}
            type="file"
            accept="image/jpeg,image/png"
            disabled={busy || staging}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0] ?? null;
              event.currentTarget.value = "";
              if (file !== null) onStage(rowKey, file);
            }}
          />
          <span className={styles.filePickerButton} aria-hidden="true">
            {slot?.status === "staged" ? "Chọn ảnh khác" : "Chọn ảnh"}
          </span>
        </span>
      </label>
      <p
        className={slot?.status === "error" ? styles.documentError : styles.documentStatus}
        role={slot?.status === "error" ? "alert" : "status"}
        data-testid={"profile-portrait-status-" + testIdSuffix}
      >
        {slot === undefined ? "Chưa chọn ảnh cho dòng này." : null}
        {staging ? "Đang gửi ảnh lên bản nháp của máy chủ…" : null}
        {slot?.status === "staged"
          ? "Ảnh đang ở bản nháp; máy chủ sẽ gắn vào hồ sơ khi lưu thành công." : null}
        {slot?.status === "error" ? portraitStageErrorMessage(slot.code) : null}
        {slot?.status === "stale"
          ? "Ảnh cũ đã bị vô hiệu hóa vì dòng dữ liệu đã thay đổi và chưa hủy được trên máy chủ. " +
            "Ảnh này sẽ không được gắn vào hồ sơ nào; hãy thử dọn lại." : null}
      </p>
      {slot?.status === "staged" ? (
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={busy}
          data-testid={"profile-portrait-cancel-" + testIdSuffix}
          onClick={() => onCancel(rowKey, slot.stageId)}
        >
          Hủy ảnh
        </button>
      ) : null}
      {slot?.status === "stale" ? (
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={busy}
          data-testid={"profile-portrait-cleanup-" + testIdSuffix}
          onClick={() => onCancel(rowKey, slot.stageId)}
        >
          Dọn lại ảnh cũ
        </button>
      ) : null}
    </div>
  );
}
