/**
 * P2.5-W06 - Worker Operations UI model (thuan, khong React, khong I/O).
 *
 * Ba quan he KHONG tron quyen:
 *   uploader  = lich su nguoi nhap (submission API; created_by chi de liet ke/audit)
 *   recruited = worker directory scope=recruited (recruiter co canonical recruiter_id)
 *   managed   = worker directory scope=managed (PM co assignment hieu luc)
 *
 * Quyen KHONG bao gio suy dien o client: moi CTA doc tu allowed_actions do server tra.
 */

import {
  projectWorkerDirectoryPage,
  type WorkerDirectoryPage,
  type WorkerDirectoryRow,
  type WorkerDirectoryScope,
} from "./worker-directory-contract.ts";
import {
  projectSubmissionListPage,
  type SubmissionReadItem,
  type SubmissionReadListPage,
} from "./submission-read-contract.ts";

export const WORKER_OPERATIONS_TABS = ["uploader", "recruited", "managed", "all"] as const;
export type WorkerOperationsTab = (typeof WORKER_OPERATIONS_TABS)[number];

export const WORKER_OPERATIONS_TAB_LABELS: Readonly<Record<WorkerOperationsTab, string>> =
  Object.freeze({
    uploader: "Tôi đã nhập",
    recruited: "Người tôi tuyển",
    managed: "Dự án tôi quản lý",
    all: "Toàn bộ NLĐ",
  });

export const WORKER_OPERATIONS_TAB_HINTS: Readonly<Record<WorkerOperationsTab, string>> =
  Object.freeze({
    uploader: "Hồ sơ bạn đã nhập. Chỉ để tra cứu — không tạo quyền đề xuất thay đổi.",
    recruited: "Người lao động có người tuyển là bạn (theo mã người tuyển trên hồ sơ).",
    managed: "Người lao động thuộc dự án bạn đang quản lý (theo phân công còn hiệu lực).",
    all: "Toàn bộ người lao động đã gửi (chỉ admin và BoD/Kế toán có quyền phạm vi toàn bộ).",
  });

/** Chi recruited/managed dung worker directory; uploader dung submission API. */
export function tabScope(tab: WorkerOperationsTab): WorkerDirectoryScope | null {
  if (tab === "recruited") return "recruited";
  if (tab === "managed") return "managed";
  if (tab === "all") return "all";
  return null;
}

/**
 * Tab "Toan bo NLD" chi duoc OFFER khi server-side actor projection xac nhan
 * (entry_admin | change_review) + effective all scope. RPC W03 van enforce lai.
 */
export function visibleWorkerTabs(canSeeAllWorkers: boolean): readonly WorkerOperationsTab[] {
  return WORKER_OPERATIONS_TABS.filter((tab) => tab !== "all" || canSeeAllWorkers);
}

/** Reviewer queue chi hien khi change_review + effective all scope (khop W05 #55). */
export function canReviewChangeRequests(input: {
  capabilities: readonly string[];
  scopes: readonly { kind: string }[];
} | null): boolean {
  if (input === null) return false;
  return input.scopes.some((scope) => scope.kind === "all") &&
    input.capabilities.includes("change_review");
}

/** Propose targets duoc policy cho phep (khong co DOCUMENT/CCCD). */
export const WORKER_PROPOSE_TARGETS = ["WORKER", "PAYMENT", "WORK_STATUS"] as const;
export type WorkerProposeTarget = (typeof WORKER_PROPOSE_TARGETS)[number];

export const WORKER_PROPOSE_TARGET_LABELS: Readonly<Record<WorkerProposeTarget, string>> =
  Object.freeze({
    WORKER: "Thông tin người lao động",
    PAYMENT: "Thông tin tài khoản ngân hàng",
    WORK_STATUS: "Trạng thái làm việc",
  });

/** Chi Admin/reviewer co all scope duoc thay review queue. */
export function reviewQueueVisible(canReview: boolean): boolean {
  return canReview === true;
}

export function isWorkerOperationsTab(value: unknown): value is WorkerOperationsTab {
  return typeof value === "string" && (WORKER_OPERATIONS_TABS as readonly string[]).includes(value);
}

/* ---------- CTA: server allowed_actions la authority duy nhat ---------- */

export const WORKER_DENIAL_NOT_PROJECT_MANAGER = "NOT_PROJECT_MANAGER";

export type ProposeCta = {
  /** true chi khi server tra allowed_actions.propose_change === true. */
  show: boolean;
  /** Ma tu choi on dinh do server tra (khong bao gio chua UUID/raw DB message). */
  code: string | null;
  /** Copy sanitized khi khong co quyen (CTA phai VANG MAT, khong chi disable). */
  message: string | null;
};

export function workerDenialMessage(code: string | null): string {
  if (code === WORKER_DENIAL_NOT_PROJECT_MANAGER) {
    return "Bạn chỉ có thể xem: chỉ quản lý dự án đang hiệu lực mới được đề xuất thay đổi.";
  }
  if (code === "NOT_SUBMITTED") {
    return "Hồ sơ chưa ở trạng thái đã gửi nên chưa thể đề xuất thay đổi.";
  }
  return "Bạn không có quyền đề xuất thay đổi cho người lao động này.";
}

export function proposeCta(row: Pick<WorkerDirectoryRow, "allowed_actions">): ProposeCta {
  const actions = row.allowed_actions;
  if (actions.propose_change === true) {
    return { show: true, code: null, message: null };
  }
  const code = actions.propose_change_code;
  return { show: false, code, message: workerDenialMessage(code) };
}

/* ---------- nhan nghiep vu (khong goi "PAYMENT"/thanh toan) ---------- */

export const BANK_ACCOUNT_SECTION_LABEL = "Thông tin tài khoản ngân hàng";
export const BANK_ACCOUNT_SECTION_HINT =
  "Chỉ gồm số tài khoản, ngân hàng và tên chủ tài khoản để lưu và tra cứu.";

export const WORKER_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  UNCONFIRMED: "Chưa xác nhận",
  ON: "Đang làm",
  OFF: "Đã nghỉ",
});

export function workerStatusLabel(status: string | null): string {
  if (status === null) return "Chưa có trạng thái";
  return WORKER_STATUS_LABELS[status] ?? "Chưa có trạng thái";
}

export type BankAccountSummary = {
  state: string;
  accountNumber: string | null;
  bankId: string | null;
  accountHolder: string | null;
};

/** Tra cuu STK/ngan hang/chu tai khoan; khong mo ta nhu chuc nang thanh toan. */
export function bankAccountSummary(payment: WorkerDirectoryRow["payment"]): BankAccountSummary | null {
  if (payment === null) return null;
  return {
    state: payment.state,
    accountNumber: payment.account_number,
    bankId: payment.bank_id,
    accountHolder: payment.account_holder_name,
  };
}

/* ---------- pending / last decision ---------- */

export function pendingRequestLabel(
  row: Pick<WorkerDirectoryRow, "pending_request">,
): string | null {
  return row.pending_request === null
    ? null
    : "Đang chờ duyệt yêu cầu thay đổi (phiên bản " + String(row.pending_request.version) + ")";
}

export function lastDecisionLabel(
  row: Pick<WorkerDirectoryRow, "last_decision">,
): string | null {
  const decision = row.last_decision;
  if (decision === null) return null;
  const day = decision.decided_at.slice(0, 10);
  return (decision.state === "APPROVED" ? "Đã duyệt" : "Đã từ chối") + " ngày " + day;
}

/* ---------- parse response (fail-closed) ---------- */

export function parseWorkerPageResponse(
  payload: unknown,
  expected: { scope: string; page_size: number },
): WorkerDirectoryPage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  if (body.ok !== true) return null;
  const slice: Record<string, unknown> = {};
  for (const key of ["items", "scope", "page_size", "has_more", "next_cursor", "authorization_date"]) {
    if (!(key in body)) return null;
    slice[key] = body[key];
  }
  return projectWorkerDirectoryPage(slice, expected);
}

export function parseSubmissionPageResponse(
  payload: unknown,
  expected: { page_size: number },
): SubmissionReadListPage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  if (body.ok !== true) return null;
  const slice: Record<string, unknown> = {};
  for (const key of ["items", "page_size", "has_more", "next_cursor"]) {
    if (!(key in body)) return null;
    slice[key] = body[key];
  }
  return projectSubmissionListPage(slice, expected);
}

/* ---------- conflict / reload ---------- */

export const WORKER_CONFLICT_MESSAGE =
  "Dữ liệu đã thay đổi ở nơi khác. Vui lòng tải lại trước khi tiếp tục.";

export function workerListErrorMessage(status: number): string {
  if (status === 401) return "Phiên làm việc đã hết hiệu lực. Vui lòng đăng nhập lại.";
  if (status === 403) return "Bạn không có quyền xem danh sách này.";
  if (status === 400) return "Bộ lọc không hợp lệ. Vui lòng kiểm tra lại.";
  return "Không tải được danh sách. Vui lòng thử lại.";
}

/** Chi hien CTA khi row do server tra propose_change; khong bao gio tu suy quyen. */
export function rowsWithProposeCta(
  rows: readonly WorkerDirectoryRow[],
): readonly WorkerDirectoryRow[] {
  return rows.filter((row) => proposeCta(row).show);
}

export type { SubmissionReadItem, WorkerDirectoryPage, WorkerDirectoryRow };
