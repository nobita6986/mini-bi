"use client";

/**
 * P1.7-H06: hop thoai "Hồ sơ NLĐ" mo theo dong dang chon.
 *
 * - CCCD (mat truoc/sau) -> tai su dung `DirectEntryCccdManager` nguyen trang.
 * - Hop dong lao dong (EMPLOYMENT_CONTRACT) -> tai su dung `DirectEntryDocumentEditor`
 *   voi `documentType` mac dinh la EMPLOYMENT_CONTRACT (nguoi dung co the doi loai
 *   neu muon nhung mac dinh la hop dong).
 * - Khong tu tao API upload moi; khong them migration; khong doi R2/bucket/profile.
 * - Khong goi entry detail cho tung row khi load (chi mot GET khi mo dialog).
 * - Khong luu file vao localStorage/sessionStorage; khong log PII hoac signed URL.
 * - Mo khoa theo `entry_id` server-issued, khong phu thuoc row index/ho ten/CCCD.
 */
import { useCallback, useState } from "react";
import { Dialog } from "radix-ui";

import { DirectEntryCccdManager } from "@/components/direct-entry/direct-entry-cccd-manager";
import { DirectEntryDocumentEditor } from "@/components/direct-entry/direct-entry-document-editor";
import type { LiveDraftRow } from "@/lib/direct-entry/live-controller";
import styles from "./direct-entry-shell.module.css";

type Props = {
  row: LiveDraftRow | null;
  onOpenChange(open: boolean): void;
  /** CCCD upload/edit (entry_own + document_upload + dong editable). */
  canEditDocuments: boolean;
  /** CCCD/document_view (xem duoc kho luu tru va entry detail). */
  canViewDocuments: boolean;
  /** entry version bump sau moi upload; dung de dong bo CCCD cache. */
  onEntryVersionChange(rowId: string, entryVersion: number): void;
  /** CCCD summary callback deo dung tren gieng ngoai (mobile card). */
  onCccdStatus(
    entryId: string,
    entryVersion: number,
    documents: readonly import("@/lib/direct-entry/cccd-document-pair").CccdDocumentSummary[],
  ): void;
};

export function DirectEntryWorkerDocuments({
  row,
  onOpenChange,
  canEditDocuments,
  canViewDocuments,
  onEntryVersionChange,
  onCccdStatus,
}: Props) {
  const open = row !== null && row.entryId !== null;
  // EMPLOYMENT_CONTRACT mac dinh; nguoi dung co the chuyen qua CCCD neu muon
  // trong cung widget DirectEntryDocumentEditor (no da ho tro 3 loai).
  const handleCccdStatus = useCallback(
    (entryId: string, entryVersion: number,
      documents: readonly import("@/lib/direct-entry/cccd-document-pair").CccdDocumentSummary[]) =>
      onCccdStatus(entryId, entryVersion, documents),
    [onCccdStatus],
  );
  const [employmentOpen] = useState(true);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.drawerOverlay} />
        {open && row && (
          <Dialog.Content className={styles.documentsDialog}
            data-testid="worker-documents-dialog"
            aria-describedby="worker-documents-description">
            <div className={styles.documentsDialogHeader}>
              <Dialog.Title className={styles.drawerTitle}>Hồ sơ NLĐ</Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className={styles.secondaryButton}>Đóng</button>
              </Dialog.Close>
            </div>
            <Dialog.Description id="worker-documents-description"
              className={styles.drawerDescription}>
              {row.workerName
                ? <>Đang mở hồ sơ của <strong>{row.workerName}</strong>.</>
                : "Đang mở hồ sơ NLĐ."}
              {" "}Mã do máy chủ cấp: <strong>{row.employeeCode || "chưa cấp"}</strong>.
              {" "}Danh sách CCCD chỉ hiển thị trạng thái; tên tệp, khóa lưu trữ và chữ ký số
              {" "}không bao giờ hiển thị trên UI hay log.
            </Dialog.Description>
            <div className={styles.drawerFields}>
              <DirectEntryCccdManager
                key={`cccd-${row.entryId ?? "none"}`}
                row={row}
                onOpenChange={() => undefined}
                canEdit={canEditDocuments}
                canView={canViewDocuments}
                onStatus={handleCccdStatus}
                onEntryVersionChange={onEntryVersionChange}
              />
              {employmentOpen && (
                <DirectEntryDocumentEditor
                  key={`contract-${row.entryId ?? "none"}`}
                  entryId={row.entryId}
                  entryVersion={row.entryVersion}
                  rowId={row.rowId}
                  canEdit={canEditDocuments}
                  canView={canViewDocuments}
                  onEntryVersionChange={onEntryVersionChange}
                />
              )}
            </div>
            <div className={styles.drawerActions}>
              <Dialog.Close asChild>
                <button type="button" className={styles.secondaryButton}>Đóng</button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        )}
      </Dialog.Portal>
    </Dialog.Root>
  );
}