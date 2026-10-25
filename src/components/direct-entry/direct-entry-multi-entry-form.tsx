"use client";

import type { ChangeEvent } from "react";

import { DdmmDateInput } from "@/components/direct-entry/direct-entry-ddmm-date-input";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";
import type { SpreadsheetValidation } from "@/lib/direct-entry/direct-entry-grid-validation";
import type { SpreadsheetRowModel } from "@/lib/direct-entry/spreadsheet-row-model";
import { formatFreeDateText } from "@/lib/direct-entry/direct-entry-date-format";
import type { WorkerPortraitStagesController } from "./use-worker-portrait-stages";
import { WorkerDocumentStageSlot, WorkerPortraitStageSlot } from "./worker-portrait-stage-slot";
import styles from "./direct-entry-shell.module.css";

const FORM_EMPLOYMENT_STATUS_CHOICES = ["Đang làm", "Đang chờ việc"] as const;

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return <label className={styles.field}><span>{label}</span>{children}</label>;
}

function statusLabel(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("vi-VN");
  if (["on", "đang làm", "đang làm việc"].includes(normalized)) return "Đang làm";
  if (["unconfirmed", "đang chờ việc"].includes(normalized)) return "Đang chờ việc";
  if (["off", "đã nghỉ", "đang nghỉ"].includes(normalized)) return "Đã nghỉ";
  return value;
}

type Props = {
  model: SpreadsheetRowModel;
  visibleRowIds: readonly string[];
  validation: SpreadsheetValidation;
  catalog: DraftCatalog | null;
  busy: boolean;
  canSave: boolean;
  message: string;
  messageTone: "error" | "success" | "info" | "";
  portraitStages: WorkerPortraitStagesController;
  cccdFrontStages: WorkerPortraitStagesController;
  cccdBackStages: WorkerPortraitStagesController;
  contractStages: WorkerPortraitStagesController;
  onActivateRow(rowId: string): void;
  onChange(rowId: string, field: string, value: string): void;
  onProviderTypeChange(rowId: string, providerType: "hrp" | "vendor" | ""): void;
  onAddRow(): void;
  onDeleteRow(rowId: string): void;
  onSave(): void;
};

export function DirectEntryMultiEntryForm({
  model,
  visibleRowIds,
  validation,
  catalog,
  busy,
  canSave,
  message,
  messageTone,
  portraitStages,
  cccdFrontStages,
  cccdBackStages,
  contractStages,
  onActivateRow,
  onChange,
  onProviderTypeChange,
  onAddRow,
  onDeleteRow,
  onSave,
}: Props) {
  const handleChange = (rowId: string, field: string) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      onChange(rowId, field, event.currentTarget.value);
  const formRowIds = Array.from(new Set([
    ...visibleRowIds,
    ...validation.rows.map((row) => row.clientRowId),
  ]));
  const hasUnsupportedEmploymentStatus = formRowIds.some((rowId) => {
    const row = model.rows.find((candidate) => candidate.clientRowId === rowId);
    if (!row) return false;
    const status = statusLabel(row.cells.initial_status ?? "");
    return status !== "" &&
      !(FORM_EMPLOYMENT_STATUS_CHOICES as readonly string[]).includes(status);
  });

  return (
    <section className={styles.multiEntryForm} aria-labelledby="multi-entry-form-title"
      data-testid="multi-entry-form">
      <header className={styles.multiEntryFormHeader}>
        <div>
          <h2 id="multi-entry-form-title">Nhập nhiều NLĐ</h2>
          <p>Hồ sơ hợp lệ được lưu trước; dòng còn lỗi và tệp đã chọn vẫn được giữ lại để xử lý tiếp.</p>
        </div>
        <button type="button" className={styles.secondaryButton} disabled={busy}
          data-testid="multi-entry-add-row" onClick={onAddRow}>
          + Thêm NLĐ
        </button>
      </header>

      {formRowIds.length === 0 && <p>Chưa có dòng mới. Chọn “Thêm NLĐ” để bắt đầu.</p>}
      <ol className={styles.mobileStagedList} data-testid="multi-entry-form-rows">
        {formRowIds.map((rowId, index) => {
          const row = model.rows.find((candidate) => candidate.clientRowId === rowId);
          if (!row) return null;
          const cells = row.cells;
          const validationRow = validation.rows.find((candidate) => candidate.clientRowId === rowId);
          const errors = validation.cellIssues.filter((issue) =>
            issue.clientRowId === rowId && issue.severity === "error");
          const rawStatus = statusLabel(cells.initial_status ?? "");
          const unsupportedStatus = rawStatus !== "" &&
            !(FORM_EMPLOYMENT_STATUS_CHOICES as readonly string[]).includes(rawStatus);
          const currentStatus = unsupportedStatus ? "" : rawStatus || "Đang làm";
          const hasDocumentBinding = validation.rows.some((candidate) => candidate.clientRowId === rowId);
          const fieldLabel = (label: string) => (
            <><span>{label}</span><span className={styles.requiredStar} aria-hidden="true"> *</span>
              <span className="sr-only"> (bắt buộc)</span></>
          );

          return (
            <li key={rowId} data-testid={`multi-entry-row-${index + 1}`}>
              <details className={styles.mobileStagedCard} open
                onToggle={(event) => {
                  if ((event.currentTarget as HTMLDetailsElement).open) onActivateRow(rowId);
                }}>
                <summary>
                  NLĐ {index + 1}: {cells.display_name || (cells.national_id ? `CCCD ${cells.national_id}` : "Chưa nhập họ tên")}
                  {" · "}{validationRow ? (validationRow.errorCount > 0
                    ? `${validationRow.errorCount} lỗi` : "Hợp lệ") : "Chưa nhập"}
                </summary>
                <fieldset className={styles.formFieldset} disabled={busy}>
                  {errors.length > 0 && (
                    <ul className={styles.quickErrorList} role="alert"
                      aria-label={`Lỗi cần sửa của NLĐ ${index + 1}`}>
                      {errors.map((issue, issueIndex) => (
                        <li key={`${issue.columnKey ?? "field"}-${issue.code}-${issueIndex}`}>
                          {issue.columnKey ?? "Thông tin"}: {issue.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  <Field label={fieldLabel("Dự án")}>
                    <select required value={cells.project_id ?? ""}
                      onChange={handleChange(rowId, "project_id")}>
                      <option value="">Chọn dự án</option>
                      {(catalog?.projects ?? []).map((project) =>
                        <option key={project.project_id} value={project.project_id}>{project.display_name}</option>)}
                    </select>
                  </Field>
                  <Field label={fieldLabel("HRP/Vendor")}>
                    <select required value={row.providerType}
                      onChange={(event) => onProviderTypeChange(rowId,
                        event.currentTarget.value === "hrp" || event.currentTarget.value === "vendor"
                          ? event.currentTarget.value : "")}>
                      <option value="">Chọn HRP hoặc Vendor</option>
                      <option value="hrp">HRP</option>
                      <option value="vendor">Vendor</option>
                    </select>
                  </Field>
                  <Field label={fieldLabel("Người tuyển / Vendor")}>
                    <select required value={cells.recruiter_id ?? ""} disabled={row.providerType === ""}
                      onChange={handleChange(rowId, "recruiter_id")}>
                      <option value="">Chọn người tuyển / Vendor</option>
                      {(catalog?.recruiters ?? []).filter((recruiter) =>
                        row.providerType === "" || recruiter.provider_type === row.providerType)
                        .map((recruiter) => <option key={recruiter.recruiter_id}
                          value={recruiter.recruiter_id}>{recruiter.display_name}</option>)}
                    </select>
                  </Field>
                  <Field label={fieldLabel("Loại hình LĐ")}>
                    <select required value={cells.labor_type ?? ""} onChange={handleChange(rowId, "labor_type")}>
                      <option value="">Chọn loại hình lao động</option>
                      {(catalog?.labor_types ?? []).map((option) =>
                        <option key={option.labor_type_key} value={option.labor_type_key}>{option.display_name}</option>)}
                    </select>
                  </Field>
                  <Field label={fieldLabel("Ngày bắt đầu làm việc")}>
                    <DdmmDateInput ariaLabel="Ngày bắt đầu làm việc" value={cells.first_work_date ?? ""}
                      required
                      onCommit={(iso) => onChange(rowId, "first_work_date", iso)} />
                  </Field>
                  <Field label="Trạng thái làm việc">
                    <select required value={currentStatus}
                      onChange={handleChange(rowId, "initial_status")}>
                      {unsupportedStatus && <option value="" disabled>Chọn lại trạng thái</option>}
                      <option value="Đang làm">Đang làm</option>
                      <option value="Đang chờ việc">Đang chờ việc</option>
                    </select>
                    {unsupportedStatus && <span role="alert">
                      Hãy chọn “Đang làm” hoặc “Đang chờ việc” để tiếp tục.
                    </span>}
                  </Field>
                  <Field label={fieldLabel("Số CCCD")}>
                    <input required maxLength={12} inputMode="numeric" autoComplete="off" value={cells.national_id ?? ""}
                      onChange={handleChange(rowId, "national_id")} />
                  </Field>
                  <Field label="Họ và tên">
                    <input autoComplete="name" value={cells.display_name ?? ""}
                      onChange={handleChange(rowId, "display_name")} />
                  </Field>
                  <Field label="Số điện thoại">
                    <input autoComplete="tel" inputMode="tel" value={cells.phone ?? ""}
                      onChange={handleChange(rowId, "phone")} />
                  </Field>

                  <div className={styles.formUploadSection}>
                    <h3>Tải hồ sơ lên</h3>
                    <div className={styles.formUploadGrid}>
                      <div className={styles.formUploadCard}>
                        {hasDocumentBinding ? (
                          <WorkerPortraitStageSlot rowKey={rowId} testIdSuffix={rowId}
                            slot={portraitStages.slots.get(rowId)} busy={busy}
                            retryable={portraitStages.retryableRows.has(rowId)}
                            onStage={portraitStages.stage} onRetry={portraitStages.retryStage}
                            onCancel={portraitStages.cancel} />
                        ) : (
                          <p className={styles.documentStatus}>Nhập thông tin NLĐ trước khi chọn tệp.</p>
                        )}
                      </div>
                      {hasDocumentBinding ? <WorkerDocumentStageSlot rowKey={rowId}
                        testIdSuffix={rowId + "-cccd-front"} documentType="CCCD_FRONT"
                        slot={cccdFrontStages.slots.get(rowId)} busy={busy}
                        retryable={cccdFrontStages.retryableRows.has(rowId)}
                        onStage={cccdFrontStages.stage} onRetry={cccdFrontStages.retryStage}
                        onCancel={cccdFrontStages.cancel} /> : null}
                      {hasDocumentBinding ? <WorkerDocumentStageSlot rowKey={rowId}
                        testIdSuffix={rowId + "-cccd-back"} documentType="CCCD_BACK"
                        slot={cccdBackStages.slots.get(rowId)} busy={busy}
                        retryable={cccdBackStages.retryableRows.has(rowId)}
                        onStage={cccdBackStages.stage} onRetry={cccdBackStages.retryStage}
                        onCancel={cccdBackStages.cancel} /> : null}
                      {hasDocumentBinding ? <WorkerDocumentStageSlot rowKey={rowId}
                        testIdSuffix={rowId + "-contract"} documentType="EMPLOYMENT_CONTRACT"
                        slot={contractStages.slots.get(rowId)} busy={busy}
                        retryable={contractStages.retryableRows.has(rowId)}
                        onStage={contractStages.stage} onRetry={contractStages.retryStage}
                        onCancel={contractStages.cancel} /> : null}
                    </div>
                  </div>

                  <details className={styles.formOptionalDetails}>
                    <summary>Thông tin thêm: tài khoản ngân hàng, ghi chú và thông tin cá nhân</summary>
                    <div className={`${styles.drawerFields} ${styles.formOptionalGrid}`}>
                      <Field label="STK">
                        <input inputMode="numeric" autoComplete="off" value={cells.account_number ?? ""}
                          onChange={handleChange(rowId, "account_number")} />
                      </Field>
                      <Field label="Tên chủ tài khoản">
                        <input autoComplete="name" value={cells.account_holder_name ?? ""}
                          onChange={handleChange(rowId, "account_holder_name")} />
                      </Field>
                      <Field label="Ngân hàng">
                        <input value={cells.bank_name ?? ""} onChange={handleChange(rowId, "bank_name")} />
                      </Field>
                      <Field label="Ghi chú">
                        <textarea value={cells.general_note ?? ""} onChange={handleChange(rowId, "general_note")} />
                      </Field>
                      <Field label="Ngày sinh">
                        <input inputMode="numeric" placeholder="DD/MM/YYYY"
                          value={formatFreeDateText(cells.date_of_birth ?? "")}
                          onChange={handleChange(rowId, "date_of_birth")} />
                      </Field>
                      <Field label="Ngày cấp CCCD">
                        <input inputMode="numeric" placeholder="DD/MM/YYYY"
                          value={formatFreeDateText(cells.national_id_issued_at ?? "")}
                          onChange={handleChange(rowId, "national_id_issued_at")} />
                      </Field>
                      <Field label="Địa chỉ">
                        <input autoComplete="street-address" value={cells.address ?? ""}
                          onChange={handleChange(rowId, "address")} />
                      </Field>
                      <Field label="Giới tính">
                        <select value={cells.gender ?? ""} onChange={handleChange(rowId, "gender")}>
                          <option value="">—</option><option value="Nam">Nam</option><option value="Nữ">Nữ</option><option value="Khác">Khác</option>
                          {(cells.gender ?? "") !== "" && !["Nam", "Nữ", "Khác"].includes(cells.gender ?? "") &&
                            <option value={cells.gender} disabled>{cells.gender}</option>}
                        </select>
                      </Field>
                    </div>
                  </details>
                </fieldset>
                <div className={styles.formRowActions}>
                  <button type="button" className={styles.secondaryButton} disabled={busy}
                    onClick={() => onDeleteRow(rowId)}>Xóa dòng này</button>
                </div>
              </details>
            </li>
          );
        })}
      </ol>

      {portraitStages.staleCount > 0 && (
        <button type="button" className={styles.secondaryButton} data-testid="form-portrait-cleanup-retry"
          onClick={portraitStages.retryCleanup}>Thử dọn ảnh NLĐ cũ chưa hủy được</button>
      )}
      {portraitStages.message !== "" && <p className={styles.documentStatus} role="status">{portraitStages.message}</p>}
      {hasUnsupportedEmploymentStatus && <p role="alert" className={styles.documentError}>
        Trạng thái chỉ nhận “Đang làm” hoặc “Đang chờ việc”. Hãy chọn lại ở các dòng được báo lỗi.
      </p>}
      <footer className={styles.multiEntryFormActions}>
        <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onAddRow}>
          + Thêm NLĐ nữa
        </button>
        <button type="button" className={styles.primaryButton} data-testid="form-save-valid-rows"
          disabled={busy || !canSave || hasUnsupportedEmploymentStatus}
          aria-busy={busy} onClick={onSave}>
          {busy ? "Đang lưu…" : "Lưu các NLĐ hợp lệ"}
        </button>
      </footer>
      {message !== "" && <p className={messageTone === "error" ? styles.documentError : styles.documentStatus}
        role={messageTone === "error" ? "alert" : "status"}>{message}</p>}
    </section>
  );
}
