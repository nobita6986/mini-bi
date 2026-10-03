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
import type { ChangeRequestDetail } from "./change-request-read-contract.ts";
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
  field: ProposerField;
  label: string;
  before: string;
  after: string;
};

export type ReviewerEntryView = {
  entry_id: string;
  entry_code: string;
  rows: ReviewerFieldRow[];
};

/** Ly do cu the chi dung cho test/telemetry noi bo; UI chi hien UNSUPPORTED_REVIEW_MESSAGE. */
export type ReviewerUnsupportedReason =
  | "STATE"
  | "NOT_DECIDABLE"
  | "TARGET_KIND"
  | "PROPOSAL"
  | "ENTRY"
  | "CATALOG";

export type ReviewerViewModel =
  | { kind: "reviewable"; request_id: string; version: number; entries: ReviewerEntryView[] }
  | { kind: "stale"; request_id: string; version: number; entries: ReviewerEntryView[] }
  | { kind: "terminal"; request_id: string; state: ChangeRequestState }
  | { kind: "unsupported"; request_id: string; reason: ReviewerUnsupportedReason };

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

/**
 * Map detail + entry projection + catalog sang view model an toan cho reviewer.
 * All-or-nothing: chi can mot item khong dat thi toan bo request thanh generic, khong co
 * quyet dinh nao duoc phep (khong xu ly mot phan).
 */
export function buildReviewerViewModel(input: {
  detail: ChangeRequestDetail;
  entries: ReadonlyMap<string, ProposerEntryProjection>;
  format: ReviewerFieldFormatter;
}): ReviewerViewModel {
  const { detail, entries, format } = input;
  const unsupported = (reason: ReviewerUnsupportedReason): ReviewerViewModel =>
    ({ kind: "unsupported", request_id: detail.request_id, reason });

  if (detail.state !== "PENDING") {
    return { kind: "terminal", request_id: detail.request_id, state: detail.state };
  }
  if (detail.can_decide !== true || detail.can_withdraw !== false) return unsupported("NOT_DECIDABLE");

  const views: ReviewerEntryView[] = [];
  let stale = false;
  for (const item of detail.items) {
    if (item.target_kind !== "ENTRY_FIELD") return unsupported("TARGET_KIND");
    if (!isSupportedEntryFieldProposal(item.proposal)) return unsupported("PROPOSAL");
    const entry = entries.get(item.entry_id);
    if (!entry || entry.entry_id !== item.entry_id) return unsupported("ENTRY");
    const rows = buildReviewerEntryRows({ item, entry, format });
    if (rows === null) return unsupported("CATALOG");
    if (entry.expected_version !== item.expected_version || rows.length === 0) stale = true;
    views.push({ entry_id: entry.entry_id, entry_code: entry.employee_code, rows });
  }
  if (views.length === 0) return unsupported("ENTRY");
  if (stale) return { kind: "stale", request_id: detail.request_id, version: detail.version, entries: views };
  return { kind: "reviewable", request_id: detail.request_id, version: detail.version, entries: views };
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
