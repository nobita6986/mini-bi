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
import {
  buildFullProfileRequestBody,
  fullProfileBlockerMessage,
  fullProfileErrorMessage,
  fullProfileIntentDigest,
  fullProfileSubmitBlockers,
  postFullProfileBatch,
  type FullProfileBlockerCode,
  type FullProfileSaved,
} from "@/lib/direct-entry/full-profile-batch";
import {
  PORTRAIT_PROMOTION_PENDING_MESSAGE,
  PORTRAIT_PROMOTION_UNSAVED_MESSAGE,
  PORTRAIT_STAGE_ORPHAN_MESSAGE,
  type PortraitPromotionState,
  cancelWorkerPortraitStage,
  portraitPromotionState,
  portraitStageErrorMessage,
  recoverWorkerPortraitStage,
  stageWorkerPortrait,
} from "@/lib/direct-entry/worker-portrait-stage-client";
import {
  clearIntentKey,
  EMPTY_INTENT_KEY,
  resolveIntentKey,
  type TransitionIntentKeyState,
} from "@/lib/direct-entry/submission-lifecycle";
import { genderUiLabel, workStatusUiLabel } from "@/lib/direct-entry/display-labels";
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
  /** CTA chi bat khi khong con blocker nao (xem fullProfileSubmitBlockers). */
  submitBlockers: readonly FullProfileBlockerCode[];
  submitting: boolean;
  submitMessage: string;
  submitMessageKind: "idle" | "error" | "conflict" | "saved";
  savedEntryCount: number;
  /** W2S1: anh ho so tam theo `sourceRow`. */
  portraits: ReadonlyMap<number, PortraitRowSlot>;
  /** Thong bao rieng cho viec stage/huy anh (khong lan voi thong bao batch). */
  portraitMessage: string;
  closeSlot?: React.ReactNode;
  onTextChange(value: string): void;
  onToggleColumnsHelp(): void;
  onToggleRow(sourceRow: number): void;
  onStagePortrait(sourceRow: number, file: File): void;
  onCancelPortrait(sourceRow: number, stageId: string): void;
  onSubmit(): void;
};

/**
 * W2S1: trang thai anh ho so tam cua MOT dong. Chi nam trong memory trang:
 * khong persist, khong chua bytes/PII, chi giu ma stage do server cap.
 */
export type PortraitRowSlot =
  | { status: "staging" }
  | { status: "staged"; stageId: string; sizeBytes: number }
  | { status: "error"; code: string };

export const PORTRAIT_SLOT_LABEL = "Ảnh hồ sơ (JPEG/PNG, tối đa 10 MiB)";

function PortraitSlot({
  sourceRow,
  slot,
  busy,
  onStage,
  onCancel,
}: {
  sourceRow: number;
  slot: PortraitRowSlot | undefined;
  busy: boolean;
  onStage(sourceRow: number, file: File): void;
  onCancel(sourceRow: number, stageId: string): void;
}) {
  const inputId = "portrait-stage-" + sourceRow;
  const staging = slot?.status === "staging";
  return (
    <div className={styles.profileSection} data-testid={"profile-portrait-" + sourceRow}>
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
              if (file !== null) onStage(sourceRow, file);
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
        data-testid={"profile-portrait-status-" + sourceRow}
      >
        {slot === undefined ? "Chưa chọn ảnh cho dòng này." : null}
        {staging ? "Đang gửi ảnh lên bản nháp của máy chủ…" : null}
        {slot?.status === "staged"
          ? "Ảnh đang ở bản nháp; máy chủ sẽ gắn vào hồ sơ khi lưu thành công." : null}
        {slot?.status === "error" ? portraitStageErrorMessage(slot.code) : null}
      </p>
      {slot?.status === "staged" ? (
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={busy}
          data-testid={"profile-portrait-cancel-" + sourceRow}
          onClick={() => onCancel(sourceRow, slot.stageId)}
        >
          Hủy ảnh
        </button>
      ) : null}
    </div>
  );
}

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
          ["Loại hình LĐ", row.labels.laborType || "—"],
          ["Ghi chú", optionalText(row.row.general_note)],
        ]} />
      </section>
      <section className={styles.profileSection}>
        <h4>Hồ sơ cá nhân</h4>
        <DefinitionList entries={[
          ["Họ và tên", row.row.display_name],
          ["Giới tính", worker.gender.state === "provided"
            ? genderUiLabel(worker.gender.value) : "—"],
          ["DOB", optionalText(worker.date_of_birth)],
          ["CMT/CCCD", worker.national_id.state === "provided"
            ? maskNationalId(worker.national_id.value) : "—"],
          ["Ngày cấp", optionalText(worker.national_id_issued_at)],
          ["Địa chỉ hiện tại", optionalText(worker.address)],
          ["Số điện thoại", optionalText(worker.phone)],
        ]} />
        <p className={styles.profileNote}>{WORKER_PROFILE_CCCD_NOTE}</p>
      </section>
      <section className={styles.profileSection}>
        <h4>Tình trạng làm việc</h4>
        <DefinitionList entries={[
          ["Tình trạng làm việc hiện tại", employment.initial_status.state === "provided"
            ? workStatusUiLabel(employment.initial_status.value) : "—"],
          ["Ngày nghỉ thực tế", optionalText(employment.leave_date)],
          ["Ghi chú về nghỉ việc", optionalText(employment.leave_reason_text)],
        ]} />
      </section>
      <section className={styles.profileSection}>
        <h4>Thông tin tài khoản để đối chiếu</h4>
        <DefinitionList entries={[
          ["STK", payment.account_number.state === "provided"
            ? maskAccountNumber(payment.account_number.value) : "—"],
          ["Tên ngân hàng", optionalText(payment.bank_name)],
          ["Tên chủ tài khoản", optionalText(payment.account_holder_name)],
        ]} />
        <p className={styles.profileNote} data-testid="profile-account-note">
          {workerProfileIssueMessage("PASTE_ACCOUNT_METADATA_INFO")}
        </p>
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
  submitBlockers,
  submitting,
  submitMessage,
  submitMessageKind,
  savedEntryCount,
  portraits,
  portraitMessage,
  closeSlot,
  onTextChange,
  onToggleColumnsHelp,
  onToggleRow,
  onStagePortrait,
  onCancelPortrait,
  onSubmit,
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
                  <PortraitSlot
                    sourceRow={row.sourceRow}
                    slot={portraits.get(row.sourceRow)}
                    busy={submitting}
                    onStage={onStagePortrait}
                    onCancel={onCancelPortrait}
                  />
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

      {portraitMessage !== "" && (
        <p className={styles.documentStatus} role="status" data-testid="profile-portrait-message">
          {portraitMessage}
        </p>
      )}

      {submitMessage !== "" && (
        <p
          className={submitMessageKind === "error" || submitMessageKind === "conflict"
            ? styles.documentError : styles.documentStatus}
          role={submitMessageKind === "error" || submitMessageKind === "conflict"
            ? "alert" : "status"}
          data-testid="profile-submit-message"
        >
          {submitMessage}
        </p>
      )}

      {savedEntryCount > 0 && (
        <p className={styles.documentStatus} role="status" data-testid="profile-saved">
          Đã lưu {savedEntryCount} dòng bằng một yêu cầu duy nhất. Hồ sơ CCCD được tải riêng
          sau khi hồ sơ đã được lưu.
        </p>
      )}

      {submitBlockers.length > 0 && (
        <ul className={styles.profileNote} data-testid="profile-blockers">
          {submitBlockers.map((code) => (
            <li key={code}>{fullProfileBlockerMessage(code)}</li>
          ))}
        </ul>
      )}

      <p className={styles.profileNote} data-testid="profile-atomicity">
        Cả nhóm được lưu trong một giao dịch: nếu một dòng không hợp lệ thì không dòng nào
        được lưu.
      </p>

      <div className={styles.drawerActions} aria-busy={submitting}>
        {closeSlot}
        <button
          type="button"
          className={styles.primaryButton}
          data-testid="profile-submit"
          disabled={submitBlockers.length > 0}
          aria-disabled={submitBlockers.length > 0}
          onClick={onSubmit}
        >
          {submitting
            ? "Đang lưu…"
            : savedEntryCount > 0
              ? "Đã lưu"
              : submitMessageKind === "error" || submitMessageKind === "conflict"
                ? "Thử lại"
                : "Lưu " + (preview?.validRows ?? 0) + " dòng"}
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
  /** Capability cua session hien tai; server van la authority cuoi cung. */
  capabilities: readonly string[];
  /** Goi SAU khi server tra projection hop le; parent reload du lieu tu server. */
  onSaved?(saved: FullProfileSaved, rows: readonly WorkerProfilePreviewRow[]): void;
  /** Goi khi 409 de parent reload/reconcile. */
  onConflict?(): void;
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
    labor_types: (catalog.labor_types ?? []).map((option) => ({
      id: option.labor_type_key, label: option.display_name,
    })),
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
  capabilities,
  onSaved,
  onConflict,
}: WorkerProfilePasteDialogProps) {
  const [text, setText] = useState("");
  const [columnsHelpOpen, setColumnsHelpOpen] = useState(false);
  const [expandedRows, setExpandedRows] = useState<readonly number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState("");
  const [submitMessageKind, setSubmitMessageKind] =
    useState<"idle" | "error" | "conflict" | "saved">("idle");
  const [savedEntryCount, setSavedEntryCount] = useState(0);
  /** W2S1: anh ho so tam theo `sourceRow`; giu stage_id toi khi luu xong hoac bi huy. */
  const [portraits, setPortraits] = useState<ReadonlyMap<number, PortraitRowSlot>>(new Map());
  const [portraitMessage, setPortraitMessage] = useState("");
  // Key chong gui trung: chi nam trong memory cua trang, khong persist, khong chua PII.
  const intentKey = useRef<TransitionIntentKeyState>(EMPTY_INTENT_KEY);
  const inFlight = useRef(false);

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

  /** Stage_id theo `sourceRow` cua nhung dong da co anh o ban nhap. */
  const stagedStageIds = useMemo(() => {
    const map = new Map<number, string>();
    for (const [sourceRow, slot] of portraits) {
      if (slot.status === "staged") map.set(sourceRow, slot.stageId);
    }
    return map;
  }, [portraits]);

  const submitBlockers = useMemo(
    () => fullProfileSubmitBlockers({
      preview, capabilities, submitting, portraitStageIds: stagedStageIds,
    }),
    [capabilities, preview, stagedStageIds, submitting],
  );

  /** Gui MOT tep len ban nhap (stage). Server sanitize/checksum; client khong gui gi them. */
  const stagePortrait = useCallback((sourceRow: number, file: File) => {
    setPortraitMessage("");
    setPortraits((current) => new Map(current).set(sourceRow, { status: "staging" }));
    void stageWorkerPortrait({ file, fetchImpl: fetch }).then((result) => {
      if (result.kind === "staged") {
        setPortraits((current) => new Map(current).set(sourceRow, {
          status: "staged", stageId: result.stageId, sizeBytes: result.sizeBytes,
        }));
        return;
      }
      setPortraits((current) => new Map(current).set(sourceRow, {
        status: "error", code: result.code,
      }));
      setPortraitMessage(portraitStageErrorMessage(result.code));
    });
  }, []);

  /** Huy stage chua gan. Stage CLAIMED/ATTACHED khong huy duoc => tra ve trang thai that. */
  const cancelPortrait = useCallback((sourceRow: number, stageId: string) => {
    setPortraitMessage("");
    void cancelWorkerPortraitStage({ stageId, fetchImpl: fetch }).then((result) => {
      if (result.kind === "cancelled") {
        setPortraits((current) => {
          const next = new Map(current);
          next.delete(sourceRow);
          return next;
        });
        setPortraitMessage(PORTRAIT_STAGE_ORPHAN_MESSAGE);
        return;
      }
      setPortraits((current) => {
        const previous = current.get(sourceRow);
        const sizeBytes = previous?.status === "staged" ? previous.sizeBytes : 0;
        return new Map(current).set(sourceRow, { status: "staged", stageId, sizeBytes });
      });
      setPortraitMessage(portraitStageErrorMessage(result.code));
    });
  }, []);

  /**
   * Hoi DB trang thai THAT cua tung stage sau khi ket qua lan luu khong xac dinh, roi suy ra
   * trang thai UI. Khong doan: recovery loi thi giu nguyen slot va bao cho nguoi dung.
   */
  const reconcilePortraits = useCallback(async (): Promise<PortraitPromotionState | null> => {
    const rank: Readonly<Record<PortraitPromotionState, number>> = {
      cancelled: 0, unsaved: 1, pending: 2, attached: 3,
    };
    let worst: PortraitPromotionState | null = null;
    for (const [sourceRow, stageId] of stagedStageIds) {
      const recovered = await recoverWorkerPortraitStage({ stageId, fetchImpl: fetch });
      if (recovered.kind !== "recovered") {
        setPortraitMessage(portraitStageErrorMessage(recovered.code));
        continue;
      }
      const state = portraitPromotionState(recovered.recovery);
      if (state === "cancelled") {
        setPortraits((current) => {
          const next = new Map(current);
          next.delete(sourceRow);
          return next;
        });
      }
      if (worst === null || rank[state] > rank[worst]) worst = state;
    }
    if (worst === "pending" || worst === "attached") {
      setPortraitMessage(PORTRAIT_PROMOTION_PENDING_MESSAGE);
    } else if (worst === "unsaved") {
      setPortraitMessage(PORTRAIT_PROMOTION_UNSAVED_MESSAGE);
    }
    return worst;
  }, [stagedStageIds]);

  const submit = useCallback(async () => {
    // Chan double submit: busy flag + ref (khong tin vao re-render).
    if (inFlight.current || submitting) return;
    if (!preview || preview.rows.length === 0) return;
    if (fullProfileSubmitBlockers({
      preview, capabilities, submitting: false, portraitStageIds: stagedStageIds,
    }).length > 0) return;
    const body = buildFullProfileRequestBody(preview.rows, stagedStageIds);
    if (body === null) {
      setSubmitMessageKind("error");
      setSubmitMessage(fullProfileErrorMessage("BATCH_INVALID"));
      return;
    }
    const digest = await fullProfileIntentDigest(body.rows);
    if (digest === null) {
      setSubmitMessageKind("error");
      setSubmitMessage(fullProfileBlockerMessage("PROFILE_DIGEST_UNAVAILABLE"));
      return;
    }
    const intent = "full_profile_batch:" + digest;
    const resolved = resolveIntentKey(intentKey.current, intent, () => crypto.randomUUID());
    intentKey.current = resolved.state;
    inFlight.current = true;
    setSubmitting(true);
    setSubmitMessage("");
    setSubmitMessageKind("idle");
    try {
      const result = await postFullProfileBatch({
        rows: body.rows,
        idempotencyKey: resolved.key,
        fetchImpl: fetch,
      });
      if (result.kind === "saved") {
        // Chi ket thuc intent khi server da xac nhan bang projection hop le.
        intentKey.current = clearIntentKey(intentKey.current, intent);
        // Server da claim + gan anh (ATTACHED); khong con stage tam nao de don.
        setPortraits(new Map());
        setPortraitMessage("");
        setSavedEntryCount(result.entryIds.length);
        setText("");
        setExpandedRows([]);
        setSubmitMessageKind("saved");
        setSubmitMessage(
          "Đã lưu thành công " + result.entryIds.length + " hồ sơ người lao động.",
        );
        onSaved?.(result, preview.rows);
        return;
      }
      if (result.kind === "retry") {
        // Giu nguyen payload + key + stage; hoi DB trang thai THAT cua anh truoc khi bao nguoi dung
        // (co the ho so DA luu nhung promote chua xong).
        await reconcilePortraits();
        setSubmitMessageKind("error");
        setSubmitMessage(fullProfileErrorMessage(result.code));
        return;
      }
      // conflict/rejected: key da dung xong. Recovery de biet stage con STAGED (dung lai duoc)
      // hay da ATTACHED/CANCELLED; khong tu doan.
      await reconcilePortraits();
      intentKey.current = clearIntentKey(intentKey.current, intent);
      if (result.kind === "conflict") {
        setSubmitMessageKind("conflict");
        setSubmitMessage(fullProfileErrorMessage(result.code));
        onConflict?.();
        return;
      }
      setSubmitMessageKind("error");
      setSubmitMessage(fullProfileErrorMessage(result.code));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }, [capabilities, onConflict, onSaved, preview, reconcilePortraits, stagedStageIds, submitting]);

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      // W2S1: nguoi dung huy nhap lieu => goi DELETE cho moi stage chua gan (contract yeu cau).
      // Stage dang CLAIMED/ATTACHED se bi tu choi (409) va duoc server xu ly theo idempotency.
      for (const slot of portraits.values()) {
        if (slot.status === "staged") {
          void cancelWorkerPortraitStage({ stageId: slot.stageId, fetchImpl: fetch });
        }
      }
      setPortraits(new Map());
      setPortraitMessage("");
      setText("");
      setColumnsHelpOpen(false);
      setExpandedRows([]);
      setSubmitMessage("");
      setSubmitMessageKind("idle");
      setSavedEntryCount(0);
      intentKey.current = EMPTY_INTENT_KEY;
      inFlight.current = false;
    }
    onOpenChange(next);
  }, [onOpenChange, portraits]);

  const handleTextChange = useCallback((value: string) => {
    setText(value);
    // Doi du lieu => ket thuc intent cu; key cu khong bao gio duoc dung lai cho payload khac.
    intentKey.current = EMPTY_INTENT_KEY;
    setSubmitMessage("");
    setSubmitMessageKind("idle");
    setSavedEntryCount(0);
  }, []);

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
          data-testid="profile-paste-dialog"
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
            submitBlockers={submitBlockers}
            submitting={submitting}
            submitMessage={submitMessage}
            submitMessageKind={submitMessageKind}
            savedEntryCount={savedEntryCount}
            portraits={portraits}
            portraitMessage={portraitMessage}
            closeSlot={
              <Dialog.Close asChild>
                <button type="button" className={styles.secondaryButton}>Đóng</button>
              </Dialog.Close>
            }
            onTextChange={handleTextChange}
            onToggleColumnsHelp={() => setColumnsHelpOpen((current) => !current)}
            onToggleRow={handleToggleRow}
            onStagePortrait={stagePortrait}
            onCancelPortrait={cancelPortrait}
            onSubmit={() => void submit()}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
