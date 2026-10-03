/**
 * P1.6-W04-S04C-S03B4A - Pure builders cho proposal nhay cam.
 *
 * Pham vi: ENTRY_FIELD.worker_details, PAYMENT, WORK_STATUS. Moi builder tra proposal da qua
 * validator cua contract hien co (khong tu viet lai nghiep vu) va chi tra proposal khi co thay doi
 * thuc su. Khong I/O, khong luu tru, khong authority.
 */
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import {
  validateWorkerDetails,
  type OptionalState,
  type OptionalValue,
  type WorkerDetails,
  type WorkerStatus,
} from "../contracts/direct-entry-v1.ts";
import {
  REASON_MAX_LENGTH,
  WORK_STATUS_VALUES,
  projectChangeRequestItem,
  type ChangeRequestItem,
  type ChangeRequestTargetKind,
} from "./change-request-contract.ts";
import { projectPaymentInput, type PaymentInput } from "./payment-contract.ts";
import { workerDetailsChanged } from "./change-request-read-projection.ts";

export type ProposalBuildError =
  | "WORKER_UNAVAILABLE"
  | "WORKER_INVALID"
  | "WORKER_UNCHANGED"
  | "PAYMENT_INVALID"
  | "PAYMENT_UNCHANGED"
  | "STATUS_INVALID"
  | "STATUS_UNCHANGED"
  | "STATUS_REASON_REQUIRED"
  | "STATUS_DATE_INVALID"
  | "STATUS_TRANSITION_INVALID";

export type ProposalBuildResult =
  | { ok: true; proposal: Record<string, unknown> }
  | { ok: false; code: ProposalBuildError };

export function proposalErrorMessage(code: ProposalBuildError): string {
  if (code === "WORKER_UNAVAILABLE") {
    return "Cần quyền xem thông tin cá nhân để đề xuất thay đổi này.";
  }
  if (code === "WORKER_INVALID") return "Thông tin cá nhân chưa hợp lệ.";
  if (code === "WORKER_UNCHANGED") return "Thông tin cá nhân chưa có thay đổi.";
  if (code === "PAYMENT_INVALID") {
    return "Thông tin thanh toán chưa hợp lệ (số tài khoản, ngân hàng đang hoạt động, tên chủ tài khoản).";
  }
  if (code === "PAYMENT_UNCHANGED") return "Thông tin thanh toán chưa có thay đổi.";
  if (code === "STATUS_REASON_REQUIRED") return "Trạng thái đã nghỉ cần lý do (tối đa 4000 ký tự).";
  if (code === "STATUS_DATE_INVALID") {
    return "Ngày hiệu lực phải trong khoảng từ ngày hiệu lực gần nhất đến hôm nay.";
  }
  if (code === "STATUS_TRANSITION_INVALID") return "Chuyển trạng thái làm việc không hợp lệ.";
  if (code === "STATUS_UNCHANGED") return "Trạng thái làm việc chưa có thay đổi.";
  return "Đề xuất thay đổi không hợp lệ.";
}

/** Ngay hom nay theo gio HCM (khong phu thuoc mui gio may chay). */
export function hcmTodayDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return String(values.year) + "-" + String(values.month) + "-" + String(values.day);
}

export type WorkerFieldForm = { state: OptionalState | "provided"; text: string };

export type WorkerForm = {
  display_name: string;
  date_of_birth: WorkerFieldForm;
  national_id: WorkerFieldForm;
  address: WorkerFieldForm;
  phone: WorkerFieldForm;
};

export const WORKER_FORM_FIELDS: readonly (keyof Omit<WorkerForm, "display_name">)[] =
  ["date_of_birth", "national_id", "address", "phone"];

function formFromOptional(value: OptionalValue<string>): WorkerFieldForm {
  return value.state === "provided" ? { state: "provided", text: value.value } : {
    state: value.state, text: "",
  };
}

export function workerFormFromDetails(details: WorkerDetails): WorkerForm {
  return {
    display_name: details.display_name,
    date_of_birth: formFromOptional(details.date_of_birth),
    national_id: formFromOptional(details.national_id),
    address: formFromOptional(details.address),
    phone: formFromOptional(details.phone),
  };
}

function optionalFromForm(value: WorkerFieldForm): OptionalValue<string> | null {
  if (value.state === "provided") {
    return value.text.length >= 1 ? { state: "provided", value: value.text } : null;
  }
  return { state: value.state };
}

/** Doi form sang WorkerDetails; tra null khi mot field optional o trang thai provided nhung rong. */
export function workerDetailsFromForm(form: WorkerForm): WorkerDetails | null {
  const dateOfBirth = optionalFromForm(form.date_of_birth);
  const nationalId = optionalFromForm(form.national_id);
  const address = optionalFromForm(form.address);
  const phone = optionalFromForm(form.phone);
  if (!dateOfBirth || !nationalId || !address || !phone) return null;
  return {
    display_name: form.display_name.trim(),
    date_of_birth: dateOfBirth,
    national_id: nationalId,
    address,
    phone,
  };
}

/** Proposal worker_details: thay the TOAN BO 5 field (contract yeu cau du shape), chi khi co doi. */
export function buildWorkerDetailsProposal(
  baseline: WorkerDetails,
  form: WorkerForm,
): ProposalBuildResult {
  const details = workerDetailsFromForm(form);
  if (!details) return { ok: false, code: "WORKER_INVALID" };
  if (validateWorkerDetails(details).length > 0) return { ok: false, code: "WORKER_INVALID" };
  if (!workerDetailsChanged(baseline, details)) return { ok: false, code: "WORKER_UNCHANGED" };
  return { ok: true, proposal: { worker_details: details } };
}

/** Proposal PAYMENT: dung dung 4 field contract, bank phai nam trong catalog dang hoat dong. */
export function buildPaymentProposal(input: {
  baseline: PaymentInput | null;
  draft: PaymentInput;
  activeBankIds: ReadonlySet<string>;
}): ProposalBuildResult {
  const validated = projectPaymentInput(input.draft, input.activeBankIds);
  if (!validated) return { ok: false, code: "PAYMENT_INVALID" };
  const baseline = input.baseline;
  if (baseline &&
      baseline.state === validated.state &&
      baseline.account_number === validated.account_number &&
      baseline.bank_id === validated.bank_id &&
      baseline.account_holder_name === validated.account_holder_name) {
    return { ok: false, code: "PAYMENT_UNCHANGED" };
  }
  return {
    ok: true,
    proposal: {
      state: validated.state,
      account_number: validated.account_number,
      bank_id: validated.bank_id,
      account_holder_name: validated.account_holder_name,
    },
  };
}

/** Chuyen trang thai hop le theo trigger cua DB: UNCONFIRMED -> ON/OFF, ON -> OFF, OFF -> ON. */
export function allowedWorkStatusTargets(current: WorkerStatus | null): WorkerStatus[] {
  if (current === null) return [];
  if (current === "UNCONFIRMED") return ["ON", "OFF"];
  if (current === "ON") return ["OFF"];
  return ["ON"];
}

/** Proposal WORK_STATUS: OFF bat buoc co ly do; trang thai khac khong gui leave_reason. */
export function buildWorkStatusProposal(input: {
  baseline: { status: WorkerStatus; effective_date: string } | null;
  status: WorkerStatus;
  effectiveDate: string;
  leaveReason: string;
  today: string;
}): ProposalBuildResult {
  const baseline = input.baseline;
  if (!baseline) return { ok: false, code: "STATUS_INVALID" };
  if (!WORK_STATUS_VALUES.some((status) => status === input.status)) {
    return { ok: false, code: "STATUS_INVALID" };
  }
  if (input.status === baseline.status && input.effectiveDate === baseline.effective_date) {
    return { ok: false, code: "STATUS_UNCHANGED" };
  }
  if (!allowedWorkStatusTargets(baseline.status).some((status) => status === input.status)) {
    return { ok: false, code: "STATUS_TRANSITION_INVALID" };
  }
  if (!isRealCalendarDate(input.effectiveDate)) return { ok: false, code: "STATUS_DATE_INVALID" };
  if (input.effectiveDate < baseline.effective_date || input.effectiveDate > input.today) {
    return { ok: false, code: "STATUS_DATE_INVALID" };
  }
  if (input.status === "OFF") {
    const reason = input.leaveReason.trim();
    if (reason.length < 1 || reason.length > REASON_MAX_LENGTH) {
      return { ok: false, code: "STATUS_REASON_REQUIRED" };
    }
    return {
      ok: true,
      proposal: { status: "OFF", effective_date: input.effectiveDate, leave_reason: reason },
    };
  }
  return { ok: true, proposal: { status: input.status, effective_date: input.effectiveDate } };
}

/** Item di qua DUNG validator cua create contract; tra null neu khong hop le. */
export function buildChangeRequestItem(input: {
  entryId: string;
  expectedVersion: number;
  targetKind: ChangeRequestTargetKind;
  proposal: Record<string, unknown>;
}): ChangeRequestItem | null {
  return projectChangeRequestItem({
    entry_id: input.entryId,
    target_kind: input.targetKind,
    expected_version: input.expectedVersion,
    proposal: input.proposal,
  });
}
