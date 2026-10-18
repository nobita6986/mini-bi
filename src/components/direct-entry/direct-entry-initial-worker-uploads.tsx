"use client";

import { DirectEntryCccdManager } from "@/components/direct-entry/direct-entry-cccd-manager";
import { DirectEntryDocumentEditor } from "@/components/direct-entry/direct-entry-document-editor";
import type { CccdDocumentSummary, CccdDocumentType } from "@/lib/direct-entry/cccd-document-pair";
import { hasInitialWorkerUploads, type InitialWorkerUploadFiles } from "@/lib/direct-entry/worker-initial-upload-queue";
import type { LiveDraftRow } from "@/lib/direct-entry/live-controller";
import { isRowEditable } from "@/lib/direct-entry/submission-lifecycle";
import type { SubmissionReadItem } from "@/lib/direct-entry/submission-read-contract";
import styles from "./direct-entry-shell.module.css";

type Props = {
  pendingByEntryId: Readonly<Record<string, InitialWorkerUploadFiles>>;
  rows: readonly LiveDraftRow[];
  submissions: readonly SubmissionReadItem[];
  capabilities: readonly string[];
  onCccdFilesAccepted(entryId: string, types: readonly CccdDocumentType[]): void;
  onContractFileAccepted(entryId: string): void;
  onSkipCccd(entryId: string): void;
  onStatus(entryId: string, entryVersion: number, documents: readonly CccdDocumentSummary[]): void;
  onEntryVersionChange(rowId: string, version: number): void;
  onOpenDocuments(rowId: string): void;
};

export function DirectEntryInitialWorkerUploads({
  pendingByEntryId,
  rows,
  submissions,
  capabilities,
  onCccdFilesAccepted,
  onContractFileAccepted,
  onSkipCccd,
  onStatus,
  onEntryVersionChange,
  onOpenDocuments,
}: Props) {
  const pendingEntries = Object.entries(pendingByEntryId).filter(([, files]) =>
    hasInitialWorkerUploads(files));
  if (pendingEntries.length === 0) return null;

  return (
    <section className={styles.formUploadSection} aria-labelledby="initial-upload-followup-title"
      data-testid="saved-worker-initial-uploads">
      <h2 id="initial-upload-followup-title">Hoàn tất tải hồ sơ cho NLĐ vừa tạo</h2>
      <p>Tệp được tải qua luồng hồ sơ hiện có sau khi hồ sơ NLĐ đã được máy chủ cấp mã.</p>
      <ul className={styles.mobileStagedList}>
        {pendingEntries.map(([entryId, files]) => {
          const row = rows.find((candidate) => candidate.entryId === entryId);
          if (!row || !hasInitialWorkerUploads(files)) return null;
          const draftEditable = isRowEditable(row, submissions);
          const canManageDraftDocuments = draftEditable && capabilities.includes("change_request_create");
          const canView = capabilities.includes("document_view") || canManageDraftDocuments;
          const canEdit = canView && draftEditable &&
            ((capabilities.includes("document_upload") &&
              (capabilities.includes("entry_own") || capabilities.includes("entry_admin"))) ||
              canManageDraftDocuments);
          const hasCccdFiles = files.cccdFront !== null || files.cccdBack !== null;

          return (
            <li key={entryId} className={styles.mobileStagedCard}>
              <h3>{row.workerName || "NLĐ vừa tạo"}</h3>
              {!canEdit && (
                <div role="status">
                  <p className={styles.documentStatus}>
                    Tệp đã chọn chỉ còn trong phiên này; quyền hoặc trạng thái bản nháp hiện chưa cho phép tải lên.
                  </p>
                  {canView && <button type="button" className={styles.secondaryButton}
                    onClick={() => onOpenDocuments(row.rowId)}>Mở Hồ sơ NLĐ</button>}
                </div>
              )}
              {canEdit && hasCccdFiles && (
                <DirectEntryCccdManager
                  key={`initial-cccd-${entryId}`}
                  row={row}
                  canEdit={canEdit}
                  canView={canView}
                  initialFiles={{
                    ...(files.cccdFront ? { CCCD_FRONT: files.cccdFront } : {}),
                    ...(files.cccdBack ? { CCCD_BACK: files.cccdBack } : {}),
                  }}
                  onInitialFilesAccepted={(types) => onCccdFilesAccepted(entryId, types)}
                  onStatus={onStatus}
                  onEntryVersionChange={onEntryVersionChange}
                />
              )}
              {canEdit && hasCccdFiles && files.contract && (
                <button type="button" className={styles.secondaryButton}
                  onClick={() => onSkipCccd(entryId)}>
                  Bỏ qua CCCD lúc này, chọn lại sau
                </button>
              )}
              {canEdit && files.contract && !hasCccdFiles && (
                <DirectEntryDocumentEditor
                  key={`initial-contract-${entryId}`}
                  entryId={row.entryId}
                  entryVersion={row.entryVersion}
                  rowId={row.rowId}
                  canEdit={canEdit}
                  canView={canView}
                  initialFile={files.contract}
                  onInitialFileAccepted={() => onContractFileAccepted(entryId)}
                  onEntryVersionChange={onEntryVersionChange}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
