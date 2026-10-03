/**
 * P1.6-W04-S04C-S03B4A - Read projection (sanitized) cho change request.
 *
 * Server (migration #33) tra proposal da lam sach theo capability: FULL / MASKED / PRESENCE_ONLY /
 * OMIT. Module nay la lop pure phia client: strict-project dung tung hinh dang da lam sach,
 * KHONG fallback tu malformed sang {}, KHONG reconstruct du lieu server da bo, KHONG doc field
 * ngoai allowlist (checksum, idempotency, storage metadata, URL ky).
 *
 * Khong I/O, khong authority: capability that do DB/RPC quyet dinh.
 */
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import {
  validateWorkerDetails,
  DOCUMENT_MAX_BYTES_HARD_LIMIT,
  DOCUMENT_MIME_TYPES,
  type DocumentType,
  type OptionalState,
  type OptionalValue,
  type WorkerDetails,
  type WorkerStatus,
} from "../contracts/direct-entry-v1.ts";
import { isDocumentType } from "./document-upload-contract.ts";
import {
  PAYMENT_STATES,
  projectPaymentProjection,
  type PaymentProjection,
  type PaymentState,
} from "./payment-contract.ts";

export const PAYMENT_STATE_LABELS: Readonly<Record<PaymentState, string>> = Object.freeze({
  omitted: "Chưa bổ sung",
  unknown: "Chưa xác định",
  intentionally_blank: "Chủ động để trống",
  provided: "Đã cung cấp",
});

export const WORK_STATUS_LABELS: Readonly<Record<WorkerStatus, string>> = Object.freeze({
  UNCONFIRMED: "Chưa xác nhận",
  ON: "Đang làm",
  OFF: "Đã nghỉ",
});

export const DOCUMENT_TYPE_LABELS: Readonly<Record<DocumentType, string>> = Object.freeze({
  CCCD_FRONT: "CCCD mặt trước",
  CCCD_BACK: "CCCD mặt sau",
  EMPLOYMENT_CONTRACT: "Hợp đồng lao động",
});

export const OPTIONAL_STATE_LABELS: Readonly<Record<OptionalState, string>> = Object.freeze({
  omitted: "Chưa bổ sung",
  unknown: "Chưa xác định",
  intentionally_blank: "Chủ động để trống",
});

export const WORKER_FIELD_LABELS = Object.freeze({
  display_name: "Họ tên",
  date_of_birth: "Ngày sinh",
  national_id: "Số định danh",
  address: "Địa chỉ",
  phone: "Điện thoại",
});

export type WorkerFieldName = keyof typeof WORKER_FIELD_LABELS;

/** Nhan chung khi server chi tra presence-only (thieu pii_view). */
export const PRESENCE_ONLY_MESSAGE =
  "Có thay đổi thông tin cá nhân — cần quyền xem phù hợp.";

/** Ly do nghi viec da bi server OMIT theo policy T0. */
export const LEAVE_REASON_HIDDEN_MESSAGE = "Lý do chi tiết được ẩn theo chính sách.";

/** Phase 0 S03B4A: chua co trusted staging boundary cho DOCUMENT change request. */
export const DOCUMENT_STAGING_MESSAGE =
  "Thay đổi tài liệu qua yêu cầu duyệt chưa sẵn sàng.";

const MASKED_ACCOUNT = new RegExp("^[\u2022]+[0-9]{0,4}$");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isOptionalState(value: unknown): value is OptionalState {
  return value === "omitted" || value === "unknown" || value === "intentionally_blank";
}

/**
 * Strict-project mot OptionalValue: dung mot trong hai hinh dang { state } hoac { state, value }.
 * Truong value chi nhan string de khong tu suy dien trang thai.
 */
export function projectOptionalValue(
  value: unknown,
  validate: (input: string) => boolean,
): OptionalValue<string> | null {
  if (!isRecord(value) || typeof value.state !== "string") return null;
  if (value.state === "provided") {
    if (Object.keys(value).length !== 2 || typeof value.value !== "string") return null;
    return validate(value.value) ? { state: "provided", value: value.value } : null;
  }
  if (!isOptionalState(value.state) || Object.keys(value).length !== 1) return null;
  return { state: value.state };
}

export function optionalValueText(value: OptionalValue<string>): string {
  return value.state === "provided" ? value.value : OPTIONAL_STATE_LABELS[value.state];
}

/** Presence-only marker: server da bo gia tri that, chi con su hien dien. */
export function isPresenceOnlyWorkerDetails(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && value.present === true;
}

/** Strict-project worker_details FULL (chi khi du 5 field hop le theo contract W01). */
export function projectWorkerDetails(value: unknown): WorkerDetails | null {
  if (!isRecord(value) || Object.keys(value).length !== 5) return null;
  if (!hasOnlyKeys(value, Object.keys(WORKER_FIELD_LABELS))) return null;
  if (typeof value.display_name !== "string") return null;
  const dateOfBirth = projectOptionalValue(value.date_of_birth, isRealCalendarDate);
  const nationalId = projectOptionalValue(value.national_id,
    (input) => input.length >= 1 && input.length <= 64);
  const address = projectOptionalValue(value.address,
    (input) => input.length >= 1 && input.length <= 1024);
  const phone = projectOptionalValue(value.phone,
    (input) => input.length >= 1 && input.length <= 64);
  if (!dateOfBirth || !nationalId || !address || !phone) return null;
  const details: WorkerDetails = {
    display_name: value.display_name,
    date_of_birth: dateOfBirth,
    national_id: nationalId,
    address,
    phone,
  };
  return validateWorkerDetails(details).length === 0 ? details : null;
}
export type PaymentReadAccount =
  | { mode: "FULL"; value: string }
  | { mode: "MASKED"; value: string }
  | { mode: "ABSENT" };

export type PaymentReadView = {
  state: PaymentState;
  account: PaymentReadAccount;
  bankId: string | null;
  holderName: string | null;
  /** Chi true khi server tra day du field can thiet cho quyet dinh theo policy hien hanh. */
  complete: boolean;
};

function isPaymentState(value: unknown): value is PaymentState {
  return typeof value === "string" && PAYMENT_STATES.some((state) => state === value);
}

/**
 * Strict-project proposal PAYMENT da lam sach: state luon co; account_number co the FULL hoac
 * MASKED last-4; bank_id/account_holder_name co the OMIT. Masked KHONG bao gio duoc coi la full.
 */
export function projectPaymentReadProposal(value: unknown): PaymentReadView | null {
  if (!isRecord(value)) return null;
  if (!hasOnlyKeys(value, ["state", "account_number", "bank_id", "account_holder_name"])) {
    return null;
  }
  if (!isPaymentState(value.state)) return null;
  let account: PaymentReadAccount = { mode: "ABSENT" };
  if (typeof value.account_number === "string") {
    if (value.account_number.length < 1) return null;
    account = MASKED_ACCOUNT.test(value.account_number)
      ? { mode: "MASKED", value: value.account_number }
      : { mode: "FULL", value: value.account_number };
  } else if (value.account_number !== null && value.account_number !== undefined) {
    return null;
  }
  let bankId: string | null = null;
  if (value.bank_id !== undefined && value.bank_id !== null) {
    if (typeof value.bank_id !== "string" || value.bank_id.length < 1) return null;
    bankId = value.bank_id;
  }
  let holderName: string | null = null;
  if (value.account_holder_name !== undefined && value.account_holder_name !== null) {
    if (typeof value.account_holder_name !== "string" ||
        value.account_holder_name.trim().length < 1) return null;
    holderName = value.account_holder_name;
  }
  const complete = value.state === "provided" && account.mode === "FULL" &&
    bankId !== null && holderName !== null;
  return { state: value.state, account, bankId, holderName, complete };
}

export type WorkStatusReadView = {
  status: WorkerStatus;
  effectiveDate: string;
  reasonOmitted: true;
};

/** Strict-project proposal WORK_STATUS da lam sach: chi status + effective_date (leave_reason OMIT). */
export function projectWorkStatusReadProposal(value: unknown): WorkStatusReadView | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["status", "effective_date"])) return null;
  if (value.status !== "UNCONFIRMED" && value.status !== "ON" && value.status !== "OFF") return null;
  if (typeof value.effective_date !== "string" || !isRealCalendarDate(value.effective_date)) {
    return null;
  }
  return { status: value.status, effectiveDate: value.effective_date, reasonOmitted: true };
}

export type DocumentReadView = {
  documentType: DocumentType;
  sizeBytes: number | null;
  mimeType: string | null;
};

/** Strict-project proposal DOCUMENT da lam sach: khong bao gio co key/checksum/storage metadata. */
export function projectDocumentReadProposal(value: unknown): DocumentReadView | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["document_type", "size_bytes", "mime_type"])) {
    return null;
  }
  if (!isDocumentType(value.document_type)) return null;
  let sizeBytes: number | null = null;
  if (value.size_bytes !== undefined && value.size_bytes !== null) {
    if (typeof value.size_bytes !== "number" || !Number.isSafeInteger(value.size_bytes) ||
        value.size_bytes < 1 || value.size_bytes > DOCUMENT_MAX_BYTES_HARD_LIMIT) return null;
    sizeBytes = value.size_bytes;
  }
  let mimeType: string | null = null;
  if (value.mime_type !== undefined && value.mime_type !== null) {
    if (typeof value.mime_type !== "string" ||
        !DOCUMENT_MIME_TYPES.some((mime) => mime === value.mime_type)) return null;
    mimeType = value.mime_type;
  }
  return { documentType: value.document_type, sizeBytes, mimeType };
}

export type ReadRow = { field: string; label: string; before: string; after: string };

const HIDDEN = "—";

/** Bang before -> after cho worker_details (chi field THUC SU thay doi). */
export function workerDetailsRows(before: WorkerDetails, after: WorkerDetails): ReadRow[] {
  const rows: ReadRow[] = [];
  for (const field of Object.keys(WORKER_FIELD_LABELS) as (keyof typeof WORKER_FIELD_LABELS)[]) {
    if (field === "display_name") {
      if (before.display_name !== after.display_name) {
        rows.push({
          field, label: WORKER_FIELD_LABELS[field],
          before: before.display_name, after: after.display_name,
        });
      }
      continue;
    }
    const beforeText = optionalValueText(before[field]);
    const afterText = optionalValueText(after[field]);
    if (beforeText !== afterText) {
      rows.push({ field, label: WORKER_FIELD_LABELS[field], before: beforeText, after: afterText });
    }
  }
  return rows;
}

/** worker_details co thay doi thuc su khong (dung cho change detection phia proposer). */
export function workerDetailsChanged(before: WorkerDetails, after: WorkerDetails): boolean {
  return workerDetailsRows(before, after).length > 0;
}

function paymentStateText(state: PaymentState): string {
  return PAYMENT_STATE_LABELS[state];
}

function paymentAccountText(account: PaymentReadAccount): string {
  return account.mode === "ABSENT" ? HIDDEN : account.value;
}

/**
 * Bang before -> after cho PAYMENT. Tra null khi can nhan bank ma khong giai duoc tu catalog
 * (fail-closed: khong hien UUID).
 */
export function paymentReadRows(input: {
  before: { state: PaymentState; account_number: string | null; bank_id: string | null;
    account_holder_name: string | null; masked?: boolean } | null;
  after: PaymentReadView;
  bankLabel: (bankId: string) => string | null;
}): ReadRow[] | null {
  const { before, after, bankLabel } = input;
  const rows: ReadRow[] = [];
  const beforeState = before ? paymentStateText(before.state) : HIDDEN;
  if (beforeState !== paymentStateText(after.state)) {
    rows.push({ field: "state", label: "Trạng thái", before: beforeState,
      after: paymentStateText(after.state) });
  }
  const afterAccount = paymentAccountText(after.account);
  const beforeAccount = before && before.account_number !== null ? before.account_number : HIDDEN;
  if (beforeAccount !== afterAccount) {
    rows.push({ field: "account_number", label: "Số tài khoản", before: beforeAccount,
      after: afterAccount });
  }
  let afterBank = HIDDEN;
  if (after.bankId !== null) {
    const label = bankLabel(after.bankId);
    if (label === null) return null;
    afterBank = label;
  }
  let beforeBank = HIDDEN;
  if (before && before.bank_id !== null) {
    const label = bankLabel(before.bank_id);
    if (label === null) return null;
    beforeBank = label;
  }
  if (beforeBank !== afterBank) {
    rows.push({ field: "bank_id", label: "Ngân hàng", before: beforeBank, after: afterBank });
  }
  const beforeHolder = before && before.account_holder_name !== null
    ? before.account_holder_name : HIDDEN;
  const afterHolder = after.holderName ?? HIDDEN;
  if (beforeHolder !== afterHolder) {
    rows.push({ field: "account_holder_name", label: "Tên chủ tài khoản", before: beforeHolder,
      after: afterHolder });
  }
  return rows;
}

/** Bang before -> after cho WORK_STATUS; luon neu ro ly do chi tiet bi an theo policy. */
export function workStatusReadRows(input: {
  before: { status: WorkerStatus; effective_date: string } | null;
  after: WorkStatusReadView;
}): ReadRow[] {
  const { before, after } = input;
  const rows: ReadRow[] = [];
  const beforeStatus = before ? WORK_STATUS_LABELS[before.status] : HIDDEN;
  if (beforeStatus !== WORK_STATUS_LABELS[after.status]) {
    rows.push({ field: "status", label: "Trạng thái làm việc", before: beforeStatus,
      after: WORK_STATUS_LABELS[after.status] });
  }
  const beforeDate = before ? before.effective_date : HIDDEN;
  if (beforeDate !== after.effectiveDate) {
    rows.push({ field: "effective_date", label: "Ngày hiệu lực", before: beforeDate,
      after: after.effectiveDate });
  }
  rows.push({ field: "leave_reason", label: "Lý do chi tiết", before: HIDDEN,
    after: LEAVE_REASON_HIDDEN_MESSAGE });
  return rows;
}

/** Metadata DOCUMENT an toan (khong co checksum/key/URL). */
export function documentReadRows(view: DocumentReadView): ReadRow[] {
  const rows: ReadRow[] = [
    { field: "document_type", label: "Loại tài liệu",
      before: HIDDEN, after: DOCUMENT_TYPE_LABELS[view.documentType] },
  ];
  if (view.sizeBytes !== null) {
    rows.push({ field: "size_bytes", label: "Dung lượng", before: HIDDEN,
      after: String(view.sizeBytes) + " byte" });
  }
  if (view.mimeType !== null) {
    rows.push({ field: "mime_type", label: "Định dạng", before: HIDDEN, after: view.mimeType });
  }
  return rows;
}

export const DOCUMENT_TYPE_ORDER: readonly DocumentType[] =
  Object.keys(DOCUMENT_TYPE_LABELS) as DocumentType[];
/**
 * Ngu canh entry (do GET /api/direct-entry/entries/{id} tra ve) duoc strict-project cho UI nhay cam:
 * chi worker_details / payment / employment_status. Server da redact theo capability; field nao
 * khong duoc phep thi coi nhu KHONG CO (khong reconstruct).
 */
export type EntrySensitiveContext = {
  workerDetails: WorkerDetails | null;
  workerPresenceOnly: boolean;
  payment: PaymentProjection | null;
  employmentStatus: { status: WorkerStatus; effective_date: string } | null;
};

export function projectEntrySensitiveContext(value: unknown): EntrySensitiveContext | null {
  if (!isRecord(value)) return null;
  if (typeof value.entry_id !== "string") return null;
  const workerDetails = projectWorkerDetails(value.worker_details);
  const workerEmpty = isRecord(value.worker_details) &&
    Object.keys(value.worker_details).length === 0;
  let payment: PaymentProjection | null = null;
  if (value.payment !== undefined && value.payment !== null) {
    payment = projectPaymentProjection(value.payment);
    if (!payment) return null;
  }
  let employmentStatus: EntrySensitiveContext["employmentStatus"] = null;
  if (value.employment_status !== undefined && value.employment_status !== null) {
    if (!isRecord(value.employment_status)) return null;
    const status = value.employment_status.status;
    const effectiveDate = value.employment_status.effective_date;
    if ((status !== "UNCONFIRMED" && status !== "ON" && status !== "OFF") ||
        typeof effectiveDate !== "string" || !isRealCalendarDate(effectiveDate)) return null;
    employmentStatus = { status, effective_date: effectiveDate };
  }
  return {
    workerDetails,
    workerPresenceOnly: workerEmpty,
    payment,
    employmentStatus,
  };
}
