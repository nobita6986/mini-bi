/**
 * P1.6-W04-S04C-S03B2 - Helper thuan cho reviewer quyet dinh change request ENTRY_FIELD.
 *
 * Pham vi S03B2: CHI quyet dinh duoc khi state=PENDING, can_decide=true, can_withdraw=false va
 * MOI item deu la ENTRY_FIELD voi de xuat chi gom 5 field khong PII:
 *   project_id, first_work_date, employee_code, recruiter_id, labor_type.
 * Moi truong hop khac (loai khac, field la, thieu entry projection, catalog khong giai duoc,
 * phien ban entry lech) deu fail-closed: mot nhan chung, khong render noi dung de xuat,
 * khong co hanh dong quyet dinh, khong xu ly mot phan cua request nhieu entry.
 *
 * Khong I/O, khong framework, khong sao chep validator: body quyet dinh di qua
 * projectChangeRequestDecision cua S02A. Server/RPC van la authority cuoi.
 */
import {
  CHANGE_REQUEST_DECISION_STATES,
  projectChangeRequestDecision,
  type ChangeRequestDecision,
  type ChangeRequestDecisionInput,
  type ChangeRequestState,
} from "./change-request-contract.ts";
import {
  changeRequestErrorMessage,
  PROPOSER_FIELD_LABELS,
  PROPOSER_FIELD_ORDER,
  type ProposerEntryProjection,
  type ProposerField,
} from "./change-request-proposer.ts";
import type {
  ChangeRequestDetail,
  ChangeRequestDetailItem,
} from "./change-request-read-contract.ts";
import {
  DOCUMENT_STAGING_MESSAGE,
  PRESENCE_ONLY_MESSAGE,
  documentReadRows,
  isPresenceOnlyWorkerDetails,
  paymentReadRows,
  projectDocumentReadProposal,
  projectPaymentReadProposal,
  projectWorkStatusReadProposal,
  projectWorkerDetails,
  workStatusReadRows,
  workerDetailsRows,
  type EntrySensitiveContext,
} from "./change-request-read-projection.ts";
import type { DraftCatalog } from "./write-repository.ts";

/** Nhan chung cho moi truong hop khong du dieu kien quyet dinh (khong lo chi tiet de xuat). */
export const UNSUPPORTED_REVIEW_MESSAGE =
  "Yêu cầu này cần phiên bản giao diện hoặc quyền xem khác.";

export const STALE_REVIEW_MESSAGE =
  "Dữ liệu đã thay đổi. Hãy tải lại và kiểm tra lại trước khi quyết định.";

export const REVIEW_DECISIONS = ["approve", "reject"] as const;

export const REVIEW_DECISION_LABELS: Readonly<Record<ChangeRequestDecision, string>> = Object.freeze({
  approve: "Duyệt",
  reject: "Từ chối",
});

export const LABOR_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  TEMPORARY: "Thời vụ",
  PERMANENT: "Toàn thời gian",
});

export const REVIEWER_REASON_MAX_LENGTH = 4000;

export type ReviewerFieldRow = {
  field: string;
  label: string;
  before: string;
  after: string;
};

/** Mot item da duoc render an toan trong dialog reviewer. */
export type ReviewerItemView = {
  entry_id: string;
  entry_code: string;
  targetKind: string;
  rows: ReviewerFieldRow[];
  /** Chi true khi item nay du du lieu + capability hint de quyet dinh. */
  decidable: boolean;
  /** Thong bao rieng cua item (vi du presence-only, ly do bi an, tai lieu chua san sang). */
  message: string | null;
};

/** Ly do cu the chi dung cho test/telemetry noi bo; UI chi hien UNSUPPORTED_REVIEW_MESSAGE. */
export type ReviewerUnsupportedReason =
  | "STATE"
  | "NOT_DECIDABLE"
  | "TARGET_KIND"
  | "PROPOSAL"
  | "ENTRY"
  | "CATALOG"
  | "WORKER"
  | "PAYMENT"
  | "STATUS";

export type ReviewerViewModel =
  | { kind: "reviewable"; request_id: string; version: number; items: ReviewerItemView[] }
  | { kind: "stale"; request_id: string; version: number; items: ReviewerItemView[] }
  | { kind: "readonly"; request_id: string; version: number; items: ReviewerItemView[];
      message: string }
  | { kind: "terminal"; request_id: string; state: ChangeRequestState }
  | { kind: "unsupported"; request_id: string; reason: ReviewerUnsupportedReason };

/** Nhan hien thi cho tung target kind trong dialog reviewer. */
export const REVIEW_TARGET_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ENTRY_FIELD: "Thông tin dòng nhập liệu",
  PAYMENT: "Thông tin thanh toán",
  WORK_STATUS: "Trạng thái làm việc",
  DOCUMENT: "Tài liệu",
});

/** Nhan chung khi server chi tra account number da mask (thieu payment_view). */
export const PAYMENT_MASKED_MESSAGE =
  "Số tài khoản chỉ hiển thị một phần — cần quyền xem thông tin thanh toán để quyết định.";

/** Doi gia tri thanh nhan hien thi; tra null khi catalog khong giai duoc (fail-closed). */
export type ReviewerFieldFormatter = (
  entry: ProposerEntryProjection,
  field: ProposerField,
  value: string,
) => string | null;

export function catalogProjectLabel(catalog: DraftCatalog | undefined, projectId: string): string | null {
  const found = catalog?.projects.find((item) => item.project_id === projectId);
  return found ? found.display_name : null;
}

export function catalogRecruiterLabel(
  catalog: DraftCatalog | undefined,
  recruiterId: string,
): string | null {
  const found = catalog?.recruiters.find((item) => item.recruiter_id === recruiterId);
  return found ? found.display_name : null;
}

/**
 * De xuat chi duoc ho tro khi moi key deu nam trong 5 field non-PII va co it nhat mot key.
 * Danh sach duoc kiem theo allowlist tu PROPOSER_FIELD_ORDER, khong liet ke field bi cam.
 */
export function isSupportedEntryFieldProposal(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length < 1) return false;
  return keys.every((key) => (PROPOSER_FIELD_ORDER as readonly string[]).includes(key));
}

/**
 * Mot item chi hien cac field THUC SU thay doi (gia tri de xuat khac gia tri hien tai),
 * theo thu tu co dinh. Tra null khi co field khong giai duoc nhan hien thi.
 */
export function buildReviewerEntryRows(input: {
  item: { entry_id: string; expected_version: number; target_kind: string; proposal: Record<string, unknown> };
  entry: ProposerEntryProjection;
  format: ReviewerFieldFormatter;
}): ReviewerFieldRow[] | null {
  const { item, entry, format } = input;
  const rows: ReviewerFieldRow[] = [];
  for (const field of PROPOSER_FIELD_ORDER) {
    if (!(field in item.proposal)) continue;
    const proposed = item.proposal[field];
    if (typeof proposed !== "string") return null;
    const current = entry[field];
    if (proposed === current) continue;
    const before = format(entry, field, current);
    const after = format(entry, field, proposed);
    if (before === null || after === null) return null;
    rows.push({ field, label: PROPOSER_FIELD_LABELS[field], before, after });
  }
  return rows;
}

/** Ket qua render mot item: view an toan hoac ly do fail-closed. */
type ItemBuildResult = ReviewerItemView | ReviewerUnsupportedReason;

function isUnsupportedReason(value: ItemBuildResult): value is ReviewerUnsupportedReason {
  return typeof value === "string";
}

/**
 * Render mot item theo target kind. Moi nhanh deu strict-project hinh dang da lam sach cua server;
 * khong doc raw JSON, khong reconstruct gia tri server da bo.
 */
function buildReviewerItemView(input: {
  item: ChangeRequestDetailItem;
  entry: ProposerEntryProjection;
  context: EntrySensitiveContext | null;
  format: ReviewerFieldFormatter;
  bankLabel: (bankId: string) => string | null;
  stale: boolean;
}): ItemBuildResult {
  const { item, entry, context, format, bankLabel } = input;
  const base = {
    entry_id: entry.entry_id,
    entry_code: entry.employee_code,
    targetKind: item.target_kind,
  };
  if (item.target_kind === "ENTRY_FIELD") {
    const allowedKeys = [...PROPOSER_FIELD_ORDER, "worker_details"] as readonly string[];
    const keys = Object.keys(item.proposal);
    if (keys.length < 1 || !keys.every((key) => allowedKeys.includes(key))) return "PROPOSAL";
    const nonPii: Record<string, unknown> = {};
    for (const field of PROPOSER_FIELD_ORDER) {
      if (field in item.proposal) nonPii[field] = item.proposal[field];
    }
    let rows: ReviewerFieldRow[] = [];
    if (Object.keys(nonPii).length > 0) {
      const nonPiiRows = buildReviewerEntryRows({ item: { ...item, proposal: nonPii }, entry, format });
      if (nonPiiRows === null) return "CATALOG";
      rows = nonPiiRows;
    }
    if ("worker_details" in item.proposal) {
      const workerValue = item.proposal.worker_details;
      if (isPresenceOnlyWorkerDetails(workerValue)) {
        return { ...base, rows, decidable: false, message: PRESENCE_ONLY_MESSAGE };
      }
      const after = projectWorkerDetails(workerValue);
      if (!after) return "PROPOSAL";
      const before = context?.workerDetails ?? null;
      if (!before) return "WORKER";
      rows = rows.concat(workerDetailsRows(before, after));
    }
    return { ...base, rows, decidable: true, message: null };
  }
  if (item.target_kind === "PAYMENT") {
    const view = projectPaymentReadProposal(item.proposal);
    if (!view) return "PAYMENT";
    const rows = paymentReadRows({ before: context?.payment ?? null, after: view, bankLabel });
    if (rows === null) return "CATALOG";
    const masked = view.account.mode === "MASKED";
    const decidable = view.state !== "provided" || view.complete;
    return {
      ...base, rows, decidable,
      message: decidable ? null : (masked ? PAYMENT_MASKED_MESSAGE : UNSUPPORTED_REVIEW_MESSAGE),
    };
  }
  if (item.target_kind === "WORK_STATUS") {
    const view = projectWorkStatusReadProposal(item.proposal);
    if (!view) return "STATUS";
    const before = context?.employmentStatus ?? null;
    if (!before) return "STATUS";
    const rows = workStatusReadRows({ before, after: view });
    return { ...base, rows, decidable: true, message: null };
  }
  if (item.target_kind === "DOCUMENT") {
    const view = projectDocumentReadProposal(item.proposal);
    if (!view) return "PROPOSAL";
    return { ...base, rows: documentReadRows(view), decidable: false,
      message: DOCUMENT_STAGING_MESSAGE };
  }
  return "TARGET_KIND";
}

/**
 * Map detail + entry projection + catalog sang view model an toan cho reviewer.
 * All-or-nothing: chi can mot item khong dat thi toan bo request fail-closed, khong co
 * quyet dinh nao duoc phep (khong xu ly mot phan). Item khong du dieu kien quyet dinh
 * (presence-only, masked, DOCUMENT) chi hien thi read-only.
 */
export function buildReviewerViewModel(input: {
  detail: ChangeRequestDetail;
  entries: ReadonlyMap<string, ProposerEntryProjection>;
  format: ReviewerFieldFormatter;
  contexts?: ReadonlyMap<string, EntrySensitiveContext>;
  bankLabel?: (bankId: string) => string | null;
}): ReviewerViewModel {
  const { detail, entries, format } = input;
  const contexts = input.contexts ?? new Map<string, EntrySensitiveContext>();
  const bankLabel = input.bankLabel ?? (() => null);
  const unsupported = (reason: ReviewerUnsupportedReason): ReviewerViewModel =>
    ({ kind: "unsupported", request_id: detail.request_id, reason });

  if (detail.state !== "PENDING") {
    return { kind: "terminal", request_id: detail.request_id, state: detail.state };
  }
  if (detail.can_decide !== true || detail.can_withdraw !== false) {
    return unsupported("NOT_DECIDABLE");
  }

  const items: ReviewerItemView[] = [];
  let stale = false;
  for (const item of detail.items) {
    const entry = entries.get(item.entry_id);
    if (!entry || entry.entry_id !== item.entry_id) return unsupported("ENTRY");
    const built = buildReviewerItemView({
      item, entry, context: contexts.get(item.entry_id) ?? null, format, bankLabel, stale: false,
    });
    if (isUnsupportedReason(built)) return unsupported(built);
    if (entry.expected_version !== item.expected_version) stale = true;
    const changed = built.decidable ? built.rows.length > 0 : true;
    if (built.targetKind === "WORK_STATUS") {
      if (built.rows.length <= 1) stale = true;
    } else if (built.decidable && !changed) {
      stale = true;
    }
    items.push(built);
  }
  if (items.length === 0) return unsupported("ENTRY");
  if (stale) {
    return { kind: "stale", request_id: detail.request_id, version: detail.version, items };
  }
  const blocked = items.find((item) => !item.decidable);
  if (blocked) {
    return {
      kind: "readonly", request_id: detail.request_id, version: detail.version, items,
      message: blocked.message ?? UNSUPPORTED_REVIEW_MESSAGE,
    };
  }
  return { kind: "reviewable", request_id: detail.request_id, version: detail.version, items };
}

/** View model generic khi khong the/khong duoc phep quyet dinh (khong co noi dung de xuat). */
export function unsupportedReviewerViewModel(
  requestId: string,
  reason: ReviewerUnsupportedReason,
): ReviewerViewModel {
  return { kind: "unsupported", request_id: requestId, reason };
}

export function reviewDecisionState(decision: ChangeRequestDecision): ChangeRequestState {
  return CHANGE_REQUEST_DECISION_STATES[decision];
}

/** Body quyet dinh dung dung 4 truong contract; khong gui actor/role/capability/scope/state. */
export function buildDecisionRequest(input: {
  decision: ChangeRequestDecision;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}): ChangeRequestDecisionInput | null {
  const parsed = projectChangeRequestDecision({
    decision: input.decision,
    expected_version: input.expectedVersion,
    reason: input.reason,
    idempotency_key: input.idempotencyKey,
  });
  return parsed.ok ? parsed.value : null;
}

/** Cung request + cung quyet dinh + cung ly do => cung intent => dung lai idempotency key cu. */
export function decisionIntentSignature(
  requestId: string,
  decision: ChangeRequestDecision,
  reason: string,
): string {
  return "change_request_decision:" + requestId + ":" + decision + ":" + reason;
}

export function reviewDecisionMessage(decision: ChangeRequestDecision, reference: string): string {
  const verb = decision === "approve" ? "Đã duyệt" : "Đã từ chối";
  return verb + " yêu cầu thay đổi " + reference + ".";
}

/** Thong bao loi da lam sach; 403 co thong diep rieng, con lai dung chung voi S03B1. */
export function reviewerErrorMessage(status: number): string {
  if (status === 403) return "Bạn không còn quyền quyết định yêu cầu thay đổi này.";
  if (status === 404) return "Không tìm thấy yêu cầu thay đổi.";
  return changeRequestErrorMessage(status);
}
