"use client";

import type { ChangeEvent } from "react";

import { DdmmDateInput } from "@/components/direct-entry/direct-entry-ddmm-date-input";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";
import type { SpreadsheetValidation } from "@/lib/direct-entry/direct-entry-grid-validation";
import type { SpreadsheetRowModel } from "@/lib/direct-entry/spreadsheet-row-model";
import type { InitialWorkerUploadFiles } from "@/lib/direct-entry/worker-initial-upload-queue";
import { formatFreeDateText } from "@/lib/direct-entry/direct-entry-date-format";
import type { WorkerPortraitStagesController } from "./use-worker-portrait-stages";
import { WorkerPortraitStageSlot } from "./worker-portrait-stage-slot";
import styles from "./direct-entry-shell.module.css";

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
  uploadsByRowId: Readonly<Record<string, InitialWorkerUploadFiles>>;
  uploadErrors: Readonly<Record<string, string>>;
  busy: boolean;
  canSave: boolean;
  message: string;
  messageTone: "error" | "success" | "info" | "";
  portraitStages: WorkerPortraitStagesController;
  onActivateRow(rowId: string): void;
  onChange(rowId: string, field: string, value: string): void;
  onProviderTypeChange(rowId: string, providerType: "hrp" | "vendor" | ""): void;
  onUploadFileChange(
    rowId: string,
    slot: keyof InitialWorkerUploadFiles,
    event: ChangeEvent<HTMLInputElement>,
  ): void;
  onAddRow(): void;
  onDeleteRow(rowId: string): void;
  onSave(): void;
};

export function DirectEntryMultiEntryForm({
  model,
  visibleRowIds,
  validation,
  catalog,
  uploadsByRowId,
  uploadErrors,
  busy,
  canSave,
  message,
  messageTone,
  portraitStages,
  onActivateRow,
  onChange,
  onProviderTypeChange,
  onUploadFileChange,
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
          const currentStatus = statusLabel(cells.initial_status ?? "");
          const rowUploads = uploadsByRowId[rowId];
          const hasPortraitBinding = validation.rows.some((candidate) => candidate.clientRowId === rowId);
          const statusChoices = ["", "Đang chờ việc", "Đang làm", "Đã nghỉ"];
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
                  NLĐ {index + 1}: {cells.display_name || "Chưa nhập họ tên"}
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
                    <select value={currentStatus} onChange={handleChange(rowId, "initial_status")}>
                      <option value="">Chọn trạng thái</option>
                      <option value="Đang chờ việc">Đang chờ việc</option>
                      <option value="Đang làm">Đang làm</option>
                      <option value="Đã nghỉ">Đã nghỉ</option>
                      {!statusChoices.includes(currentStatus) && currentStatus !== "" &&
                        <option value={currentStatus} disabled>{currentStatus} — cần kiểm tra</option>}
                    </select>
                  </Field>
                  {currentStatus === "Đã nghỉ" && (
                    <>
                      <Field label="Ngày nghỉ thực tế">
                        <DdmmDateInput ariaLabel="Ngày nghỉ thực tế" value={cells.leave_date ?? ""}
                          onCommit={(iso) => onChange(rowId, "leave_date", iso)} />
                      </Field>
                      <Field label="Lý do nghỉ">
                        <textarea value={cells.leave_reason_text ?? ""}
                          onChange={handleChange(rowId, "leave_reason_text")} />
                      </Field>
                    </>
                  )}
                  <Field label={fieldLabel("Họ và tên")}>
                    <input autoComplete="name" value={cells.display_name ?? ""}
                      onChange={handleChange(rowId, "display_name")} />
                  </Field>
                  <Field label="Số điện thoại">
                    <input autoComplete="tel" inputMode="tel" value={cells.phone ?? ""}
                      onChange={handleChange(rowId, "phone")} />
                  </Field>
                  <Field label="Số CCCD">
                    <input inputMode="numeric" autoComplete="off" value={cells.national_id ?? ""}
                      onChange={handleChange(rowId, "national_id")} />
                  </Field>

                  <details className={styles.formOptionalDetails}>
                    <summary>Thông tin thêm: tài khoản ngân hàng, ghi chú và thông tin cá nhân</summary>
                    <div className={styles.drawerFields}>
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
                      <Field label="Giới tính">
                        <select value={cells.gender ?? ""} onChange={handleChange(rowId, "gender")}>
                          <option value="">—</option><option value="Nam">Nam</option><option value="Nữ">Nữ</option>
                          {(cells.gender ?? "") !== "" && !["Nam", "Nữ"].includes(cells.gender ?? "") &&
                            <option value={cells.gender} disabled>{cells.gender}</option>}
                        </select>
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
                    </div>
                  </details>

                  <div className={styles.formUploadSection}>
                    <h3>Tải hồ sơ lên</h3>
                    {hasPortraitBinding ? (
                      <WorkerPortraitStageSlot rowKey={rowId} testIdSuffix={rowId}
                        slot={portraitStages.slots.get(rowId)} busy={busy}
                        onStage={portraitStages.stage} onCancel={portraitStages.cancel} />
                    ) : (
                      <p className={styles.documentStatus}>Nhập thông tin NLĐ trước khi chọn ảnh NLĐ.</p>
                    )}
                    <label className={styles.initialUploadLabel} htmlFor={`initial-cccd-front-${rowId}`}>
                      CCCD mặt trước (ảnh hoặc PDF)
                      <input id={`initial-cccd-front-${rowId}`} type="file"
                        accept="image/jpeg,image/png,application/pdf"
                        aria-label={`CCCD mặt trước — NLĐ ${index + 1}`}
                        onChange={(event) => onUploadFileChange(rowId, "cccdFront", event)} />
                      {rowUploads?.cccdFront && <span>Đã chọn tệp; sẽ tải sau khi hồ sơ NLĐ được tạo.</span>}
                    </label>
                    <label className={styles.initialUploadLabel} htmlFor={`initial-cccd-back-${rowId}`}>
                      CCCD mặt sau (ảnh hoặc PDF)
                      <input id={`initial-cccd-back-${rowId}`} type="file"
                        accept="image/jpeg,image/png,application/pdf"
                        aria-label={`CCCD mặt sau — NLĐ ${index + 1}`}
                        onChange={(event) => onUploadFileChange(rowId, "cccdBack", event)} />
                      {rowUploads?.cccdBack && <span>Đã chọn tệp; sẽ tải sau khi hồ sơ NLĐ được tạo.</span>}
                    </label>
                    <label className={styles.initialUploadLabel} htmlFor={`initial-contract-${rowId}`}>
                      Hợp đồng (ảnh hoặc PDF)
                      <input id={`initial-contract-${rowId}`} type="file"
                        accept="image/jpeg,image/png,application/pdf"
                        aria-label={`Hợp đồng — NLĐ ${index + 1}`}
                        onChange={(event) => onUploadFileChange(rowId, "contract", event)} />
                      {rowUploads?.contract && <span>Đã chọn tệp; sẽ tải sau khi hồ sơ NLĐ được tạo.</span>}
                    </label>
                    {uploadErrors[rowId] && <p role="alert" className={styles.documentError}>{uploadErrors[rowId]}</p>}
                  </div>
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
      <footer className={styles.multiEntryFormActions}>
        <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onAddRow}>
          + Thêm NLĐ nữa
        </button>
        <button type="button" className={styles.primaryButton} data-testid="form-save-valid-rows"
          disabled={busy || !canSave} aria-busy={busy} onClick={onSave}>
          {busy ? "Đang lưu…" : "Lưu các NLĐ hợp lệ"}
        </button>
      </footer>
      {message !== "" && <p className={messageTone === "error" ? styles.documentError : styles.documentStatus}
        role={messageTone === "error" ? "alert" : "status"}>{message}</p>}
    </section>
  );
}
