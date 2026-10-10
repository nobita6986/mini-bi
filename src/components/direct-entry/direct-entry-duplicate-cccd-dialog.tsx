"use client";

/**
 * P3.1-HF-R1 - Modal canh bao CCCD trung khi trinh duyet (DRAFT -> REVIEW).
 *
 * Component trinh bay + Radix AlertDialog. Khong goi API, khong tu danh gia quyen, khong tu
 * submit khi dong: dong modal (Escape hoac "Quay lai kiem tra") tuong duong huy va khong de lai
 * residue nao o server. Focus trap, Escape va keyboard deu do Radix lo.
 */
import { AlertDialog } from "radix-ui";

import {
  duplicateCccdModalMessage,
  duplicateCccdModalQuestion,
  duplicateCccdModalTitle,
  duplicateCccdStatusLine,
} from "@/lib/direct-entry/submission-duplicate-cccd-contract";
import type { DuplicateCccdPreflight } from "@/lib/direct-entry/submission-duplicate-cccd-contract";

import styles from "./direct-entry-shell.module.css";

export type DuplicateCccdDialogProps = {
  preflight: DuplicateCccdPreflight | null;
  submitting: boolean;
  onBack: () => void;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
};

export function DirectEntryDuplicateCccdDialog({
  preflight,
  submitting,
  onBack,
  onConfirm,
  onOpenChange,
}: DuplicateCccdDialogProps) {
  const hiddenCount = preflight === null
    ? 0
    : Math.max(0, preflight.conflict_count - preflight.conflicts.length);
  return (
    <AlertDialog.Root open={preflight !== null} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={styles.drawerOverlay} />
        {preflight && (
          <AlertDialog.Content className={styles.confirmDialog}>
            <AlertDialog.Title className={styles.drawerTitle}>
              {duplicateCccdModalTitle()}
            </AlertDialog.Title>
            <AlertDialog.Description className={styles.drawerDescription}>
              {duplicateCccdModalQuestion()}
            </AlertDialog.Description>
            <ul className={styles.proposerConfirmList}>
              {preflight.conflicts.map((conflict) => (
                <li key={conflict.conflict_ref}>
                  <p>{duplicateCccdModalMessage(conflict)}</p>
                  <p className={styles.submissionHint}>{duplicateCccdStatusLine(conflict)}</p>
                </li>
              ))}
            </ul>
            {hiddenCount > 0 && (
              <p className={styles.submissionHint}>
                {"Còn " + hiddenCount + " trường hợp khác chưa hiển thị hết."}
              </p>
            )}
            <p className={styles.submissionHint}>
              Số CCCD chỉ hiển thị bốn chữ số cuối để đối chiếu.
            </p>
            <div className={styles.drawerActions}>
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={submitting}
                  onClick={onBack}
                >
                  Quay lại kiểm tra
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={submitting}
                  aria-busy={submitting}
                  onClick={onConfirm}
                >
                  {submitting ? "Đang trình duyệt…" : "Vẫn trình duyệt"}
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        )}
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
