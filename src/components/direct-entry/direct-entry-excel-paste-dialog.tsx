"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog } from "radix-ui";

import { EXCEL_PASTE_MAX_ROWS } from "@/lib/direct-entry/excel-paste";
import {
  PASTE_COLUMN_HEADINGS,
  buildPastePreview,
  requiredCatalogDates,
  type PasteCatalog,
  type PastePreviewRow,
} from "@/lib/direct-entry/excel-paste-import";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";
import styles from "./direct-entry-shell.module.css";

export type PasteSubmitResult =
  | { ok: true }
  | { ok: false; message: string; reloadRequired: boolean };

type Props = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Nut mo hop thoai; Radix tu tra focus ve day khi dong (Escape hoac nut dong). */
  trigger: React.ReactElement;
  ensureCatalog(date: string): Promise<DraftCatalog>;
  catalogFor(date: string): DraftCatalog | undefined;
  /** Ma NLĐ cua cac dong CHUA LUU dang co tren trang. */
  existingEmployeeCodes: readonly string[];
  onSubmit(rows: readonly PastePreviewRow[]): Promise<PasteSubmitResult>;
};

const LABOR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  TEMPORARY: "Thời vụ",
  PERMANENT: "Toàn thời gian",
});

export function toPasteCatalog(catalog: DraftCatalog | undefined): PasteCatalog | undefined {
  if (!catalog) return undefined;
  return {
    projects: catalog.projects.map((project) => ({
      id: project.project_id,
      label: project.display_name,
    })),
    recruiters: catalog.recruiters.map((recruiter) => ({
      id: recruiter.recruiter_id,
      label: recruiter.display_name,
    })),
  };
}

function describeIssue(column: number | null, message: string): string {
  return column === null ? message : "Cột " + column + ": " + message;
}

export function DirectEntryExcelPasteDialog({
  open,
  onOpenChange,
  trigger,
  ensureCatalog,
  catalogFor,
  existingEmployeeCodes,
  onSubmit,
}: Props) {
  const [text, setText] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");

  const dates = useMemo(() => requiredCatalogDates(text), [text]);
  const dateKey = dates.join(",");
  useEffect(() => {
    if (!open) return;
    for (const date of dateKey === "" ? [] : dateKey.split(",")) {
      void ensureCatalog(date).catch(() => {});
    }
  }, [dateKey, ensureCatalog, open]);

  // Dong hop thoai: xoa trang thai nhap de lan mo sau bat dau sach (khong dung effect).
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      setText("");
      setSubmitState("idle");
      setMessage("");
    }
    onOpenChange(next);
  }, [onOpenChange]);

  const catalogMap = useMemo(() => {
    const map: Record<string, PasteCatalog> = {};
    for (const date of dates) {
      const catalog = toPasteCatalog(catalogFor(date));
      if (catalog) map[date] = catalog;
    }
    return map;
  }, [catalogFor, dates]);

  const preview = useMemo(() => buildPastePreview({
    text,
    catalogs: catalogMap,
    existingEmployeeCodes,
  }), [catalogMap, existingEmployeeCodes, text]);

  // Loi o muc dong (khong thuoc dong nao trong preview, vi du sai so cot).
  const standaloneIssues = useMemo(() => {
    const inRows = new Set(preview.rows.flatMap((row) => row.issues));
    return preview.issues.filter((issue) => !inRows.has(issue));
  }, [preview]);

  const submit = useCallback(async () => {
    if (!preview.canSubmit || submitState === "saving") return;
    setSubmitState("saving");
    setMessage("");
    const result = await onSubmit(preview.rows);
    if (result.ok) {
      handleOpenChange(false);
      return;
    }
    setSubmitState("error");
    setMessage(result.message);
  }, [handleOpenChange, onSubmit, preview, submitState]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.drawerOverlay} />
        <Dialog.Content className={styles.pasteDialog} aria-describedby="paste-excel-description">
          <Dialog.Title className={styles.drawerTitle}>Dán từ Excel</Dialog.Title>
          <Dialog.Description id="paste-excel-description" className={styles.drawerDescription}>
            Dán trực tiếp từ Excel. Mỗi dòng đúng {PASTE_COLUMN_HEADINGS.length} cột, phân tách bằng tab;
            tối đa {EXCEL_PASTE_MAX_ROWS} dòng mỗi lần. Dự án và người tuyển được đối chiếu với
            danh mục theo ngày bắt đầu làm việc.
          </Dialog.Description>
          <div className={styles.drawerFields}>
            <ol className={styles.pasteColumns}>
              {PASTE_COLUMN_HEADINGS.map((heading, index) => (
                <li key={heading}>{index + 1}. {heading}</li>
              ))}
            </ol>
            <label className={styles.field}>
              <span>Dữ liệu dán từ Excel</span>
              <textarea
                aria-label="Dữ liệu dán từ Excel"
                className={styles.pasteTextarea}
                rows={6}
                spellCheck={false}
                value={text}
                onChange={(event) => {
                  setText(event.currentTarget.value);
                  setSubmitState("idle");
                  setMessage("");
                }}
              />
            </label>
            <p className={styles.pasteTotals} data-testid="paste-totals" aria-live="polite">
              {preview.validCount} dòng hợp lệ · {preview.errorCount} lỗi
            </p>
            {text.trim() !== "" && (
              <div className={styles.pastePreviewWrap}>
                <table className={styles.pastePreview} data-testid="paste-preview">
                  <caption>
                    Xem trước {preview.rows.length} dòng đã đọc
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Dòng</th>
                      {PASTE_COLUMN_HEADINGS.map((heading) => (
                        <th scope="col" key={heading}>{heading}</th>
                      ))}
                      <th scope="col">Lỗi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.line} className={row.issues.length > 0 ? styles.pasteRowError : undefined}>
                        <td>{row.line}</td>
                        <td>{row.employeeCode}</td>
                        <td>{row.firstWorkDate}</td>
                        <td>{row.workerName}</td>
                        <td>{row.projectText}</td>
                        <td>{row.recruiterText}</td>
                        <td>{LABOR_LABELS[row.laborType]}</td>
                        <td>
                          {row.issues.map((issue) => (
                            <span key={describeIssue(issue.column, issue.message)}>
                              {describeIssue(issue.column, issue.message)}
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {standaloneIssues.length > 0 && (
              <ul className={styles.pasteIssueList} data-testid="paste-line-errors">
                {standaloneIssues.map((issue) => (
                  <li key={issue.line + ":" + issue.message}>
                    {issue.line === 0 ? "Lỗi" : "Dòng " + issue.line}: {issue.message}
                  </li>
                ))}
              </ul>
            )}
            {message !== "" && <p role="alert" className={styles.documentError}>{message}</p>}
          </div>
          <div className={styles.drawerActions}>
            <Dialog.Close asChild>
              <button type="button" className={styles.secondaryButton}>Đóng</button>
            </Dialog.Close>
            <button
              type="button"
              className={styles.primaryButton}
              data-testid="paste-submit"
              disabled={!preview.canSubmit || submitState === "saving"}
              onClick={() => void submit()}
            >
              {submitState === "saving" ? "Đang thêm…" : "Thêm " + preview.validCount + " dòng"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
