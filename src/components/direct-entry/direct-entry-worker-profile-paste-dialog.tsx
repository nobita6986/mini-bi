"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";

import {
  WORKER_PROFILE_FIELDS,
  WORKER_PROFILE_REQUIRED_HEADERS,
  WORKER_PROFILE_TEMPLATE_HEADERS,
  workerProfileField,
  workerProfileIssueMessage,
  type WorkerProfileIssue,
  type WorkerProfileRequirement,
} from "@/lib/direct-entry/worker-profile-import-contract";
import {
  createPasteCatalogResolver,
  buildWorkerProfilePreview,
  maskAccountNumber,
  maskNationalId,
  type ExistingProfileIdentity,
  type WorkerProfilePreview,
  type WorkerProfilePreviewRow,
} from "@/lib/direct-entry/worker-profile-preview";
import type { WorkerProfileOptional } from "@/lib/direct-entry/worker-profile-paste";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";
import styles from "./direct-entry-shell.module.css";

/**
 * CTA cuoi task: KHONG dung chu "Luu", KHONG POST request. Duong ho so day du chi duoc mo
 * khi T1B phat hanh contract server day du.
 */
export const WORKER_PROFILE_SERVER_PENDING_LABEL = "Chờ máy chủ hỗ trợ hồ sơ đầy đủ";

export const WORKER_PROFILE_CCCD_NOTE =
  "Ảnh CCCD mặt trước/sau được tải riêng sau khi hồ sơ được lưu.";

/** Tieu de/mo ta dung chung cho dialog Radix va cho harness render tinh (mot nguon duy nhat). */
export const WORKER_PROFILE_DIALOG_TITLE = "Dán hồ sơ từ Excel";
export const WORKER_PROFILE_DIALOG_DESCRIPTION =
  "Dán hồ sơ đầy đủ từ Excel. Hệ thống đọc tên cột nên thứ tự cột không quan trọng; cột tùy chọn " +
  "có thể vắng mặt. Ảnh CCCD tải riêng sau khi hồ sơ được lưu.";

const REQUIREMENT_LABELS: Readonly<Record<WorkerProfileRequirement, string>> = Object.freeze({
  required: "bắt buộc",
  optional: "tùy chọn",
  conditional: "có điều kiện",
  derived: "dẫn xuất — không lưu",
});

export type WorkerProfilePastePanelProps = {
  text: string;
  preview: WorkerProfilePreview | null;
  columnsHelpOpen: boolean;
  expandedRows: readonly number[];
  catalogPending: boolean;
  closeSlot?: React.ReactNode;
  onTextChange(value: string): void;
  onToggleColumnsHelp(): void;
  onToggleRow(sourceRow: number): void;
};

function optionalText(value: WorkerProfileOptional<string>): string {
  return value.state === "provided" ? value.value : "—";
}

function issueText(entry: WorkerProfileIssue): string {
  const field = entry.field === null
    ? null
    : workerProfileField(entry.field)?.canonicalHeader ?? entry.field;
  const where = entry.row === 0 ? "Bảng" : "Dòng " + entry.row;
  const prefix = field === null ? where : where + " · " + field;
  return prefix + ": " + workerProfileIssueMessage(entry.code);
}

function rowBadge(row: WorkerProfilePreviewRow): { label: string; className: string } {
  if (!row.canProceed) {
    return { label: "Có lỗi", className: styles.profileBadgeError };
  }
  if (row.warnings.length > 0) {
    return { label: "Hợp lệ, có cảnh báo", className: styles.profileBadgeWarn };
  }
  return { label: "Hợp lệ", className: styles.profileBadgeOk };
}

function DefinitionList({ entries }: { entries: readonly (readonly [string, string])[] }) {
  return (
    <dl className={styles.profileFieldList}>
      {entries.map(([label, value]) => (
        <div key={label} style={{ display: "contents" }}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RowDetail({ row }: { row: WorkerProfilePreviewRow }) {
  const { worker, payment, employment, derived } = row.row;
  const resolved = (value: string | null, label: string) =>
    value === null ? label + " · chưa đối chiếu được" : label;
  return (
    <div className={styles.profileDetail} data-testid={"profile-detail-" + row.sourceRow}>
      <section className={styles.profileSection}>
        <h4>Công việc</h4>
        <DefinitionList entries={[
          ["Mã NLĐ", row.row.employee_code],
          ["Dự án", row.row.project_label + " · " + resolved(row.resolved.project_id, "danh mục")],
          ["Ngày bắt đầu làm việc", row.row.first_work_date || "—"],
          ["Người tuyển", row.row.recruiter_label + " · " + resolved(row.resolved.recruiter_id, "danh mục")],
          ["Loại hình LĐ", row.row.labor_type === "TEMPORARY" ? "Thời vụ" : "Toàn thời gian"],
          ["Ghi chú", optionalText(row.row.general_note)],
        ]} />
      </section>
      <section className={styles.profileSection}>
        <h4>Hồ sơ cá nhân</h4>
        <DefinitionList entries={[
          ["Họ và tên", row.row.display_name],
          ["Giới tính", worker.gender.state === "provided" ? worker.gender.value : "—"],
          ["DOB", optionalText(worker.date_of_birth)],
          ["CMT/CCCD", worker.national_id.state === "provided"
            ? maskNationalId(worker.national_id.value) : "—"],
          ["Ngày cấp", optionalText(worker.national_id_issued_at)],
          ["Nơi cấp", optionalText(worker.national_id_issued_place)],
          ["Địa chỉ hiện tại", optionalText(worker.address)],
          ["Số điện thoại", optionalText(worker.phone)],
        ]} />
        <p className={styles.profileNote}>{WORKER_PROFILE_CCCD_NOTE}</p>
      </section>
      <section className={styles.profileSection}>
        <h4>Tình trạng làm việc</h4>
        <DefinitionList entries={[
          ["Tình trạng làm việc hiện tại", employment.initial_status.state === "provided"
            ? employment.initial_status.value : "—"],
          ["Ngày nghỉ thực tế", optionalText(employment.leave_date)],
          ["Ghi chú về nghỉ việc", optionalText(employment.leave_reason_text)],
        ]} />
      </section>
      <section className={styles.profileSection}>
        <h4>Thanh toán</h4>
        <DefinitionList entries={[
          ["STK", payment.account_number.state === "provided"
            ? maskAccountNumber(payment.account_number.value) : "—"],
          ["Tên ngân hàng", payment.bank_label.state === "provided"
            ? payment.bank_label.value + " · " + resolved(row.resolved.bank_id, "danh mục")
            : "—"],
          ["Tên chủ tài khoản", optionalText(payment.account_holder_name)],
        ]} />
      </section>
      <section className={styles.profileSection}>
        <h4>Validation-only</h4>
        <DefinitionList entries={[
          ["STT", derived.row_index === null ? "—" : String(derived.row_index)],
          ["Tháng", derived.effective_month || "—"],
          ["Tuổi", derived.age_years === null ? "—" : String(derived.age_years)],
          ["Chi nhánh/Team", derived.team_hint ?? "—"],
          ["HRP/Vendor", derived.provider_hint ?? "—"],
        ]} />
        <p className={styles.profileNote}>
          Hệ thống sẽ xác nhận chi nhánh/team và HRP/Vendor từ danh mục; các cột này không được lưu.
        </p>
      </section>
    </div>
  );
}

export function WorkerProfilePastePanel({
  text,
  preview,
  columnsHelpOpen,
  expandedRows,
  catalogPending,
  closeSlot,
  onTextChange,
  onToggleColumnsHelp,
  onToggleRow,
}: WorkerProfilePastePanelProps) {
  const errorCount = preview?.errorCount ?? 0;
  const warningCount = preview?.warningCount ?? 0;
  const headerIssues = preview?.headerIssues ?? [];
  return (
    <div className={styles.drawerFields} data-testid="profile-paste-panel">
      <ul className={styles.pasteColumns}>
        <li>Bắt buộc có dòng header; hệ thống đọc tên cột, không phụ thuộc thứ tự cột.</li>
        <li>
          Cột bắt buộc: {WORKER_PROFILE_REQUIRED_HEADERS.join(", ")}.
        </li>
        <li>Mỗi lần dán tối đa 100 dòng dữ liệu.</li>
        <li>{WORKER_PROFILE_CCCD_NOTE}</li>
      </ul>

      <button
        type="button"
        className={styles.secondaryButton}
        data-testid="profile-columns-toggle"
        aria-expanded={columnsHelpOpen}
        onClick={onToggleColumnsHelp}
      >
        Danh sách cột hỗ trợ
      </button>
      {columnsHelpOpen && (
        <section className={styles.profileColumnsHelp} data-testid="profile-columns-help"
          aria-label="Danh sách cột hỗ trợ">
          <ul>
            {WORKER_PROFILE_TEMPLATE_HEADERS.map((header) => {
              const spec = WORKER_PROFILE_FIELDS.find((field) => field.canonicalHeader === header);
              return (
                <li key={header}>
                  {header}
                  <span className={styles.profileRequirement}>
                    {spec ? REQUIREMENT_LABELS[spec.requirement] : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <label className={styles.field}>
        <span>Dữ liệu dán từ Excel</span>
        <textarea
          aria-label="Dữ liệu dán hồ sơ từ Excel"
          className={styles.pasteTextarea}
          data-testid="profile-paste-textarea"
          rows={6}
          spellCheck={false}
          value={text}
          onChange={(event) => onTextChange(event.currentTarget.value)}
        />
      </label>

      {preview !== null && (
        <p
          className={errorCount > 0 ? styles.profileSummaryError : styles.profileSummary}
          data-testid="profile-summary"
          role={errorCount > 0 ? "alert" : "status"}
        >
          <span>{preview.totalRows} dòng</span>
          <span>{preview.validRows} hợp lệ</span>
          <span>{errorCount} lỗi</span>
          <span>{warningCount} cảnh báo</span>
        </p>
      )}

      {catalogPending && (
        <p className={styles.documentStatus} role="status" data-testid="profile-catalog-pending">
          Đang tải danh mục cho ngày hiệu lực…
        </p>
      )}

      {preview?.catalogBlocker === true && (
        <p className={styles.documentError} role="alert" data-testid="profile-catalog-blocker">
          {workerProfileIssueMessage("PASTE_BANK_CATALOG_EMPTY")}
        </p>
      )}

      {headerIssues.length > 0 && (
        <ul className={styles.profileIssueList} data-testid="profile-table-issues">
          {headerIssues.map((entry) => (
            <li key={entry.code + ":" + String(entry.field) + ":" + entry.row}>{issueText(entry)}</li>
          ))}
        </ul>
      )}

      {preview !== null && preview.rows.length > 0 && (
        <ul className={styles.profileRowList} data-testid="profile-rows">
          {preview.rows.map((row) => {
            const badge = rowBadge(row);
            const expanded = expandedRows.includes(row.sourceRow);
            return (
              <li key={row.sourceRow}>
                <article className={styles.profileRowCard} data-testid={"profile-row-" + row.sourceRow}>
                  <div className={styles.profileRowHead}>
                    <span className={styles.profileRowCode}>{row.row.employee_code || "—"}</span>
                    <span className={styles.profileBadge + " " + badge.className}
                      data-testid={"profile-status-" + row.sourceRow}>
                      {badge.label}
                    </span>
                  </div>
                  <p className={styles.profileMeta}>
                    {row.row.display_name || "—"} · {row.row.project_label || "—"} ·{" "}
                    {row.row.first_work_date || "—"} · {row.row.recruiter_label || "—"}
                  </p>
                  {(row.issues.length > 0 || row.warnings.length > 0) && (
                    <ul className={styles.profileIssueList}>
                      {row.warnings.map((entry) => (
                        <li className={styles.profileWarningList}
                          key={"w" + entry.code + String(entry.field)}>
                          {issueText(entry)}
                        </li>
                      ))}
                      {row.issues.map((entry) => (
                        <li key={"e" + entry.code + String(entry.field)}>{issueText(entry)}</li>
                      ))}
                    </ul>
                  )}
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    data-testid={"profile-detail-toggle-" + row.sourceRow}
                    aria-expanded={expanded}
                    onClick={() => onToggleRow(row.sourceRow)}
                  >
                    {expanded ? "Ẩn chi tiết" : "Xem chi tiết"}
                  </button>
                  {expanded && <RowDetail row={row} />}
                </article>
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.drawerActions}>
        {closeSlot}
        <button
          type="button"
          className={styles.primaryButton}
          data-testid="profile-submit"
          disabled
          aria-disabled="true"
        >
          {WORKER_PROFILE_SERVER_PENDING_LABEL}
        </button>
      </div>
    </div>
  );
}

export type WorkerProfilePasteDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Nut mo hop thoai; Radix tu tra focus ve day khi dong. */
  trigger: React.ReactElement;
  referenceDate: string;
  ensureCatalog(date: string): Promise<DraftCatalog>;
  catalogFor(date: string): DraftCatalog | undefined;
  existing?: readonly ExistingProfileIdentity[];
  /** Seam noi bo; KHONG duoc wiring vao server trong task nay. */
  onValidatedRows?(rows: readonly WorkerProfilePreviewRow[]): void;
};

function toCatalogSource(catalog: DraftCatalog | undefined) {
  if (!catalog) return null;
  return {
    projects: catalog.projects.map((project) => ({
      id: project.project_id, label: project.display_name,
    })),
    recruiters: catalog.recruiters.map((recruiter) => ({
      id: recruiter.recruiter_id, label: recruiter.display_name,
    })),
    banks: catalog.banks.map((bank) => ({ id: bank.bank_id, label: bank.display_name })),
  };
}

export function DirectEntryWorkerProfilePasteDialog({
  open,
  onOpenChange,
  trigger,
  referenceDate,
  ensureCatalog,
  catalogFor,
  existing,
  onValidatedRows,
}: WorkerProfilePasteDialogProps) {
  const [text, setText] = useState("");
  const [columnsHelpOpen, setColumnsHelpOpen] = useState(false);
  const [expandedRows, setExpandedRows] = useState<readonly number[]>([]);
  const notified = useRef<string | null>(null);

  // Preview la ham thuan cua (text, catalog, existing): khong setState trong effect.
  const preview = useMemo(() => {
    if (text.trim() === "") return null;
    const resolver = createPasteCatalogResolver((date) => toCatalogSource(catalogFor(date)));
    return buildWorkerProfilePreview({ text, referenceDate, resolver, existing });
  }, [catalogFor, existing, referenceDate, text]);

  useEffect(() => {
    for (const date of preview?.catalogDates ?? []) {
      void ensureCatalog(date).catch(() => undefined);
    }
  }, [ensureCatalog, preview]);

  useEffect(() => {
    if (!preview || !preview.canProceed || !onValidatedRows) return;
    const signature = preview.rows.map((row) => row.row.employee_code).join("|");
    if (notified.current === signature) return;
    notified.current = signature;
    onValidatedRows(preview.rows);
  }, [onValidatedRows, preview]);

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      setText("");
      setColumnsHelpOpen(false);
      setExpandedRows([]);
      notified.current = null;
    }
    onOpenChange(next);
  }, [onOpenChange]);

  const handleToggleRow = useCallback((sourceRow: number) => {
    setExpandedRows((current) => current.includes(sourceRow)
      ? current.filter((value) => value !== sourceRow)
      : [...current, sourceRow]);
  }, []);

  // Suy ra tu preview da tinh: khong tinh lai lan hai.
  const catalogPending = preview !== null &&
    preview.catalogDates.some((date) => catalogFor(date) === undefined);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.drawerOverlay} />
        <Dialog.Content className={styles.profilePasteDialog}
          aria-describedby="worker-profile-paste-description">
          <Dialog.Title className={styles.drawerTitle}>
            {WORKER_PROFILE_DIALOG_TITLE}
          </Dialog.Title>
          <Dialog.Description id="worker-profile-paste-description"
            className={styles.drawerDescription}>
            {WORKER_PROFILE_DIALOG_DESCRIPTION}
          </Dialog.Description>
          <WorkerProfilePastePanel
            text={text}
            preview={preview}
            columnsHelpOpen={columnsHelpOpen}
            expandedRows={expandedRows}
            catalogPending={catalogPending}
            closeSlot={
              <Dialog.Close asChild>
                <button type="button" className={styles.secondaryButton}>Đóng</button>
              </Dialog.Close>
            }
            onTextChange={setText}
            onToggleColumnsHelp={() => setColumnsHelpOpen((current) => !current)}
            onToggleRow={handleToggleRow}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
