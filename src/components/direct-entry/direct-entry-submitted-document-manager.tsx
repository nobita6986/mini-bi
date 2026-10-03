"use client";

/**
 * P1.6-W04-S04B-R2C - Quan ly tai lieu cho dot SUBMITTED.
 *
 * Khong dua vao draft grid/selectedRow: tu card submission goi submission detail de lay
 * entry_ids do server tra ve, sau do tai strict entry projection cho tung entry roi dung lai
 * DirectEntryDocumentEditor voi projection that. REVIEW/DRAFT khong dung dialog nay.
 */
import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";

import {
  projectionSlice,
  projectProposerEntry,
} from "@/lib/direct-entry/change-request-proposer";
import {
  DETAIL_KEYS,
  projectSubmissionDetail,
  type SubmissionReadItem,
} from "@/lib/direct-entry/submission-read-contract";
import { DirectEntryDocumentEditor } from "./direct-entry-document-editor";

import styles from "./direct-entry-shell.module.css";

type ManagerEntry = { entryId: string; version: number };

export type SubmittedDocumentManagerProps = {
  submission: SubmissionReadItem | null;
  onOpenChange: (open: boolean) => void;
  canUpload: boolean;
  canView: boolean;
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function DirectEntrySubmittedDocumentManager({
  submission,
  onOpenChange,
  canUpload,
  canView,
}: SubmittedDocumentManagerProps) {
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [entries, setEntries] = useState<ManagerEntry[]>([]);
  const [versions, setVersions] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!submission) return undefined;
    let cancelled = false;
    async function load() {
      setLoadState("loading");
      try {
        const detailResponse = await fetch(
          "/api/direct-entry/submissions/" + encodeURIComponent(submission!.submission_id),
          { cache: "no-store", credentials: "same-origin" },
        );
        const detailBody = await readJson(detailResponse);
        const detail = projectSubmissionDetail(
          projectionSlice(detailBody, DETAIL_KEYS),
          { submission_id: submission!.submission_id },
        );
        if (!detailResponse.ok || !detail) throw new Error("SUBMISSION_UNAVAILABLE");
        const loaded: ManagerEntry[] = [];
        for (const entryId of detail.entry_ids) {
          const entryResponse = await fetch(
            "/api/direct-entry/entries/" + encodeURIComponent(entryId),
            { cache: "no-store", credentials: "same-origin" },
          );
          const entryBody = await readJson(entryResponse);
          const slice = projectionSlice(entryBody, ["entry"]);
          const entry = slice ? projectProposerEntry(slice.entry) : null;
          if (!entryResponse.ok || !entry || entry.entry_id !== entryId) {
            throw new Error("ENTRY_UNAVAILABLE");
          }
          loaded.push({ entryId: entry.entry_id, version: entry.expected_version });
        }
        if (cancelled) return;
        setEntries(loaded);
        setLoadState("ready");
      } catch {
        if (!cancelled) setLoadState("error");
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [submission]);

  return (
    <Dialog.Root open={submission !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.drawerOverlay} />
        {submission && (
          <Dialog.Content className={styles.drawer} data-testid="submitted-document-manager">
            <Dialog.Title className={styles.drawerTitle}>Quản lý tài liệu</Dialog.Title>
            <Dialog.Description className={styles.drawerDescription}>
              Tải lên thay thế tài liệu cho đợt đã gửi chính thức. Mỗi lần thay thế cần lý do và
              được ghi nhận đầy đủ phiên bản.
            </Dialog.Description>
            <div className={styles.drawerFields}>
              <div className={styles.notice} aria-live="polite">
                {loadState === "loading" && "Đang tải các dòng của đợt…"}
                {loadState === "error" && "Không tải được các dòng của đợt."}
                {loadState === "ready" && entries.length === 0 &&
                  "Đợt này không có dòng nào để quản lý tài liệu."}
              </div>
              {loadState === "ready" && entries.map((entry) => (
                <DirectEntryDocumentEditor
                  key={entry.entryId}
                  entryId={entry.entryId}
                  entryVersion={versions[entry.entryId] ?? entry.version}
                  rowId={entry.entryId}
                  canEdit={canUpload}
                  canView={canView}
                  requireReason
                  onEntryVersionChange={(rowId, version) => {
                    setVersions((current) => ({ ...current, [rowId]: version }));
                  }}
                />
              ))}
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
