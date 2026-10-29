/**
 * P2.5-W06 - Worker Operations UI model (thuan, khong React, khong I/O).
 *
 * Ba quan he KHONG tron quyen:
 *   uploader  = lich su nguoi nhap (submission API; created_by chi de liet ke/audit)
 *   recruited = worker directory scope=recruited (recruiter co canonical recruiter_id)
 *   managed   = worker directory scope=managed (PM co assignment hieu luc)
 *   team      = worker directory scope=team (Team Leader current-team audience)
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
import {
  projectChangeRequestListPage,
  type ChangeRequestListItem,
  type ChangeRequestListPage,
  type ChangeRequestQueueFilter,
} from "./change-request-read-contract.ts";
import { WORK_STATUS_UI_LABELS, workStatusUiLabel } from "./display-labels.ts";

export const WORKER_OPERATIONS_TABS = ["uploader", "recruited", "managed", "team", "all"] as const;
export type WorkerOperationsTab = (typeof WORKER_OPERATIONS_TABS)[number];

export const WORKER_OPERATIONS_TAB_LABELS: Readonly<Record<WorkerOperationsTab, string>> =
  Object.freeze({
    uploader: "Tôi đã nhập",
    recruited: "Người tôi tuyển",
    managed: "Dự án tôi quản lý",
    team: "Team tôi quản lý",
    all: "Toàn bộ NLĐ",
  });

export const WORKER_OPERATIONS_TAB_HINTS: Readonly<Record<WorkerOperationsTab, string>> =
  Object.freeze({
    uploader: "Hồ sơ bạn đã nhập. Chỉ để tra cứu — không tạo quyền đề xuất thay đổi.",
    recruited: "Người lao động có người tuyển là bạn (theo mã người tuyển trên hồ sơ).",
    managed: "Người lao động thuộc dự án bạn đang quản lý (theo phân công còn hiệu lực).",
    team: "Người lao động thuộc team bạn đang quản lý theo phân công hiện tại.",
    all: "Toàn bộ người lao động đã gửi.",
  });

/** Chi recruited/managed dung worker directory; uploader dung submission API. */
export function tabScope(tab: WorkerOperationsTab): WorkerDirectoryScope | null {
  if (tab === "recruited") return "recruited";
  if (tab === "managed") return "managed";
  if (tab === "team") return "team";
  if (tab === "all") return "all";
  return null;
}

/**
 * Tab "Toan bo NLD" chi duoc OFFER khi server-side actor projection xac nhan
 * (entry_admin | change_review) + effective all scope. RPC W03 van enforce lai.
 */
export function visibleWorkerTabs(
  canSeeAllWorkers: boolean,
  canSeeTeamWorkers = false,
): readonly WorkerOperationsTab[] {
  return WORKER_OPERATIONS_TABS.filter((tab) =>
    (tab !== "all" || canSeeAllWorkers) && (tab !== "team" || canSeeTeamWorkers));
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

export function canViewGlobalChangeRequestHistory(
  capabilities: readonly string[] | null,
  scopes: readonly { kind: string }[] = [],
): boolean {
  if (capabilities === null || !scopes.some((scope) => scope.kind === "all")) return false;
  return capabilities.includes("change_review") || capabilities.includes("entry_admin");
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

/* ---------- PRE-W2-P2: sua ho ten NLĐ qua luong duyet (target WORKER) ---------- */

/** Du quyen nhung chua nap duoc baseline canonical day du (khong bia gia tri). */
export const WORKER_NAME_NO_BASELINE_MESSAGE =
  "Chưa đọc được thông tin người lao động để đề xuất sửa họ tên.";

export type WorkerNameAvailability = {
  available: boolean;
  /** Copy giai thich khi KHONG the sua ten; null khi available. */
  message: string | null;
};

/**
 * Quyet dinh affordance sua ho ten (target WORKER) o ca hai entry point.
 *
 * The row has already passed server-side worker view and scope; edits still require the existing action.
 */
export function workerNameAvailability(input: {
  proposeChange: boolean;
  hasBaseline: boolean;
}): WorkerNameAvailability {
  if (!input.proposeChange) {
    return { available: false, message: workerDenialMessage(null) };
  }
  if (!input.hasBaseline) return { available: false, message: WORKER_NAME_NO_BASELINE_MESSAGE };
  return { available: true, message: null };
}

/* ---------- nhan nghiep vu (khong goi "PAYMENT"/thanh toan) ---------- */

export const BANK_ACCOUNT_SECTION_LABEL = "Thông tin tài khoản ngân hàng";
export const BANK_ACCOUNT_SECTION_HINT =
  "Chỉ gồm số tài khoản, ngân hàng và tên chủ tài khoản để lưu và tra cứu.";

/** PRE-W2-HF-UI-LABELS: nhan trang thai lam viec lay tu mot nguon duy nhat (display-labels). */
export const WORKER_STATUS_LABELS: Readonly<Record<string, string>> = WORK_STATUS_UI_LABELS;

export function workerStatusLabel(status: string | null): string {
  return workStatusUiLabel(status);
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
    : "Đang chờ duyệt yêu cầu thay đổi";
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
  for (const key of ["items", "scope", "page_size", "has_more", "next_cursor", "authorization_date", "summary"]) {
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

/* ---------- W06-R2: initial tab tu actor projection (server) ---------- */

export type WorkerOperationsActor = {
  capabilities: readonly string[];
  scopes: readonly { kind: string }[];
};

/**
 * Chon tab BAN DAU tu actor projection server-side. Chi la lua chon UI ban dau;
 * API/RPC van la authority. Reviewer toi thieu mo thang "Toan bo NLD" thay vi
 * roi vao uploader (submissions 403 => ca trang AccessDenied o 0e2cbba).
 */
export function initialWorkerTab(
  actor: WorkerOperationsActor | null,
  canSeeAllWorkers: boolean,
  canSeeTeamWorkers = false,
): WorkerOperationsTab {
  if (actor === null) return "uploader";
  const onlyScopeAll = actor.scopes.some((scope) => scope.kind === "all");
  if (onlyScopeAll && (actor.capabilities.includes("entry_admin") ||
      actor.capabilities.includes("change_review")) && canSeeAllWorkers) {
    return "all";
  }
  if (canSeeTeamWorkers) return "team";
  const isEntryActor = actor.capabilities.some((capability) =>
    ["entry_own", "entry_team", "entry_admin"].includes(capability));
  if (!isEntryActor && actor.capabilities.includes("change_request_create")) return "managed";
  return "uploader";
}

/* ---------- W06-R2: pagination (page state thuan) ---------- */

export const WORKER_PAGE_SIZE = 25;
export const WORKER_REQUEST_PAGE_SIZE = 20;

export type PageState =
  | "idle" | "loading" | "ready" | "empty" | "denied" | "unavailable" | "error";

export type TabPage<T> = {
  items: readonly T[];
  cursor: string | null;
  hasMore: boolean;
  state: PageState;
  /** Thong bao cuc bo cua tab; 403 chi anh huong tab nay, khong thao ca trang. */
  message: string | null;
};

export function emptyTabPage<T>(): TabPage<T> {
  return { items: [], cursor: null, hasMore: false, state: "idle", message: null };
}

/** Doi tab/doi filter: reset items + cursor — khong mang cursor cua scope cu. */
export function resetTabPage<T>(): TabPage<T> {
  return { items: [], cursor: null, hasMore: false, state: "loading", message: null };
}

export type WorkerDirectoryFilters = {
  search: string;
  status: string;
  projectId: string;
  recruiterId: string;
};

export function updateWorkerDirectoryFilter<T>(input: {
  page: TabPage<T>;
  filters: WorkerDirectoryFilters;
  field: keyof WorkerDirectoryFilters;
  value: string;
}): { page: TabPage<T>; filters: WorkerDirectoryFilters } {
  return {
    page: resetTabPage<T>(),
    filters: { ...input.filters, [input.field]: input.value },
  };
}

/** Bat dau tai. append=true (tai them) GIU items da co. */
export function beginLoad<T>(page: TabPage<T>, append: boolean): TabPage<T> {
  return append
    ? { ...page, state: "loading", message: null }
    : { items: [], cursor: null, hasMore: false, state: "loading", message: null };
}

/** Append theo stable id, khong trung/khong sot. */
export function appendUnique<T>(
  current: readonly T[],
  incoming: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const seen = new Set(current.map(keyOf));
  const next = [...current];
  for (const item of incoming) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

export function applyPage<T>(
  page: TabPage<T>,
  incoming: { items: readonly T[]; next_cursor: string | null; has_more: boolean },
  keyOf: (item: T) => string,
  append: boolean,
): TabPage<T> {
  const items = append ? appendUnique(page.items, incoming.items, keyOf) : [...incoming.items];
  return {
    items,
    cursor: incoming.next_cursor,
    hasMore: incoming.has_more,
    state: items.length === 0 ? "empty" : "ready",
    message: null,
  };
}

/** Loi khi tai: neu da co items thi GIU page da tai thanh cong. */
export function failLoad<T>(
  page: TabPage<T>, state: PageState, message: string | null,
): TabPage<T> {
  if (page.items.length > 0) return { ...page, state: "ready", message };
  return { ...page, state, message };
}

export function workersQuery(input: {
  scope: WorkerDirectoryScope;
  search?: string;
  status: string;
  projectId?: string;
  recruiterId?: string;
  cursor: string | null;
}): string {
  let query = "?scope=" + input.scope + "&page_size=" + String(WORKER_PAGE_SIZE);
  if (input.status !== "") query += "&employment_status=" + encodeURIComponent(input.status);
  if (input.search?.trim()) query += "&search=" + encodeURIComponent(input.search.trim());
  if (input.projectId) query += "&project_id=" + encodeURIComponent(input.projectId);
  if (input.recruiterId) query += "&recruiter_id=" + encodeURIComponent(input.recruiterId);
  if (input.cursor !== null) query += "&cursor=" + encodeURIComponent(input.cursor);
  return query;
}

export function submissionsQuery(cursor: string | null): string {
  let query = "?page_size=" + String(WORKER_PAGE_SIZE);
  if (cursor !== null) query += "&cursor=" + encodeURIComponent(cursor);
  return query;
}

export type ChangeRequestWorkspaceMode = "proposer" | "reviewer";

export const CHANGE_REQUEST_PROPOSER_TABS = [
  { value: "PROPOSER_PENDING", label: "Tôi đã gửi" },
  { value: "PROPOSER_RESOLVED", label: "Lịch sử gửi" },
] as const;

export const CHANGE_REQUEST_REVIEWER_TABS = [
  { value: "REVIEWER_PENDING", label: "Chờ tôi duyệt" },
  { value: "REVIEWER_RESOLVED", label: "Lịch sử duyệt" },
] as const;

export const CHANGE_REQUEST_GLOBAL_AUDIT_TAB = {
  value: "GLOBAL_AUDIT",
  label: "Lịch sử toàn hệ thống",
} as const;

export type ChangeRequestWorkspaceInitialAccess = {
  canReview: boolean;
  canPropose?: boolean;
  hasProposerPending?: boolean;
  hasProposerResolved?: boolean;
  hasReviewerResolved?: boolean;
};

export function initialChangeRequestWorkspaceMode(
  input: boolean | ChangeRequestWorkspaceInitialAccess,
): ChangeRequestWorkspaceMode {
  if (typeof input === "boolean") {
    return input ? "reviewer" : "proposer";
  }
  if (input.canReview) return "reviewer";
  if (
    input.hasReviewerResolved === true &&
    !input.canPropose &&
    !input.hasProposerPending &&
    !input.hasProposerResolved
  ) {
    return "reviewer";
  }
  return "proposer";
}

export function initialChangeRequestQueue(
  input: boolean | ChangeRequestWorkspaceInitialAccess,
): ChangeRequestQueueFilter {
  if (typeof input === "boolean") {
    return input ? "REVIEWER_PENDING" : "PROPOSER_PENDING";
  }
  const mode = initialChangeRequestWorkspaceMode(input);
  if (mode === "reviewer") {
    return input.canReview ? "REVIEWER_PENDING" : "REVIEWER_RESOLVED";
  }
  if (
    !input.canPropose &&
    input.hasProposerPending === false &&
    input.hasProposerResolved === true
  ) {
    return "PROPOSER_RESOLVED";
  }
  return "PROPOSER_PENDING";
}

export function changeRequestWorkspaceTabs(input: {
  mode: ChangeRequestWorkspaceMode;
  canViewGlobalHistory: boolean;
}): readonly { value: ChangeRequestQueueFilter; label: string }[] {
  if (input.mode === "proposer") {
    return CHANGE_REQUEST_PROPOSER_TABS;
  }
  return input.canViewGlobalHistory
    ? [...CHANGE_REQUEST_REVIEWER_TABS, CHANGE_REQUEST_GLOBAL_AUDIT_TAB]
    : CHANGE_REQUEST_REVIEWER_TABS;
}

export function requestsQuery(
  cursor: string | null,
  state: ChangeRequestQueueFilter = "PENDING",
  days: "3" | "7" | "30" | "all" = "3",
): string {
  let query = "?page_size=" + String(WORKER_REQUEST_PAGE_SIZE) + "&state=" + encodeURIComponent(state);
  if (state === "GLOBAL_AUDIT") query += "&days=" + encodeURIComponent(days);
  if (cursor !== null) query += "&cursor=" + encodeURIComponent(cursor);
  return query;
}

export function workerRowKey(row: WorkerDirectoryRow): string {
  return row.entry_id;
}
export function submissionRowKey(item: SubmissionReadItem): string {
  return item.submission_id;
}
export function requestRowKey(item: ChangeRequestListItem): string {
  return item.request_id;
}

export function parseChangeRequestPageResponse(
  payload: unknown,
  expected: { page_size: number; audit?: boolean },
): ChangeRequestListPage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  if (body.ok !== true) return null;
  const slice: Record<string, unknown> = {};
  for (const key of ["requests", "page_size", "has_more", "next_cursor"]) {
    if (!(key in body)) return null;
    slice[key] = body[key];
  }
  return projectChangeRequestListPage(slice, expected);
}

/**
 * P2.5-HF-R5A: moi loi tai du lieu (5xx, mang, envelope sai) PHAI co copy sanitized.
 * Truoc day nhanh 5xx/network tra message null nen "Tai them" that bai khong hien gi.
 */
export const WORKER_LOAD_FAILED_MESSAGE = "Không tải được danh sách. Vui lòng thử lại.";

export function workerListErrorMessage(status: number): string {
  if (status === 401) return "Phiên làm việc đã hết hiệu lực. Vui lòng đăng nhập lại.";
  if (status === 403) return "Bạn không có quyền xem danh sách này.";
  if (status === 400) return "Bộ lọc không hợp lệ. Vui lòng kiểm tra lại.";
  return WORKER_LOAD_FAILED_MESSAGE;
}

/**
 * Ánh xạ mã lỗi sanitized từ POST /api/direct-entry/entries/[entryId]/privileged-edit
 * sang thông báo tiếng Việt rõ ràng mà không bao giờ lộ raw PostgreSQL message.
 */
export function privilegedEditErrorMessage(status: number, code?: string | null): string {
  if (code === "WORKER_ACTIVE_EPISODE_EXISTS") {
    return "Người lao động đang có một đợt làm việc hiệu lực khác (trùng CCCD đang làm).";
  }
  if (code === "WORKER_EPISODE_REOPEN_FORBIDDEN") {
    return "Hồ sơ đã nghỉ việc không thể mở lại; vui lòng tạo hồ sơ mới khi tái tuyển.";
  }
  if (code === "PRIVILEGED_EDIT_CONFLICT") {
    return "Dữ liệu bị trùng (ví dụ mã người lao động đã tồn tại). Vui lòng kiểm tra lại.";
  }
  if (code === "VERSION_CONFLICT") {
    return WORKER_CONFLICT_MESSAGE;
  }
  if (code === "PRIVILEGED_EDIT_STATE_LOCKED") {
    return "Trạng thái hồ sơ hiện tại không cho phép chỉnh sửa trực tiếp.";
  }
  if (code === "PRIVILEGED_EDIT_DENIED" || code === "ACTOR_NOT_AVAILABLE" || status === 403) {
    return "Bạn không còn quyền sửa trực tiếp hồ sơ này.";
  }
  if (code === "UNAUTHENTICATED" || status === 401) {
    return "Phiên làm việc đã hết hiệu lực. Vui lòng đăng nhập lại.";
  }
  if (code === "ENTRY_NOT_FOUND" || status === 404) {
    return "Không tìm thấy hồ sơ cần chỉnh sửa hoặc hồ sơ không còn thuộc phạm vi của bạn.";
  }
  if (
    code === "PRIVILEGED_EDIT_INVALID" ||
    code === "CLIENT_AUTHORITY_FIELD_FORBIDDEN" ||
    code === "BODY_INVALID" ||
    code === "ENTRY_ID_INVALID" ||
    status === 400
  ) {
    return "Dữ liệu chỉnh sửa không hợp lệ (kiểm tra định dạng mã NLĐ, ngày làm việc, CCCD, danh mục đang hoạt động hoặc trạng thái làm việc).";
  }
  return "Không lưu được chỉnh sửa trực tiếp. Vui lòng thử lại.";
}

/**
 * Hai audience ca nhan co the khong ton tai voi actor hien tai (khong co recruiter
 * link / khong duoc gan quan ly du an). Do la tap ket qua rong, khong phai loi quyen
 * can hien cho nguoi dung. Scope `all` van giu 403 fail-closed.
 */
export function relationDenialIsEmpty(
  scope: WorkerDirectoryScope,
  status: number,
): boolean {
  return status === 403 && (scope === "recruited" || scope === "managed");
}

/** Chi hien CTA khi row do server tra propose_change; khong bao gio tu suy quyen. */
export function rowsWithProposeCta(
  rows: readonly WorkerDirectoryRow[],
): readonly WorkerDirectoryRow[] {
  return rows.filter((row) => proposeCta(row).show);
}

/* ---------- HF-Worker-Profile: Direct Edit (Sửa trực tiếp) tài liệu hồ sơ ---------- */

export const DIRECT_EDIT_DOCUMENT_TYPES = [
  "WORKER_PORTRAIT",
  "CCCD_FRONT",
  "CCCD_BACK",
  "EMPLOYMENT_CONTRACT",
] as const;

export type DirectEditDocumentType = (typeof DIRECT_EDIT_DOCUMENT_TYPES)[number];

export const DIRECT_EDIT_DOCUMENT_LABELS: Readonly<Record<DirectEditDocumentType, string>> =
  Object.freeze({
    WORKER_PORTRAIT: "Ảnh NLĐ",
    CCCD_FRONT: "CCCD mặt trước",
    CCCD_BACK: "CCCD mặt sau",
    EMPLOYMENT_CONTRACT: "Hợp đồng lao động",
  });

export const DIRECT_EDIT_DOCUMENT_ACCEPT: Readonly<Record<DirectEditDocumentType, string>> =
  Object.freeze({
    WORKER_PORTRAIT: "image/jpeg,image/png",
    CCCD_FRONT: "image/jpeg,image/png,application/pdf",
    CCCD_BACK: "image/jpeg,image/png,application/pdf",
    EMPLOYMENT_CONTRACT: "image/jpeg,image/png,application/pdf",
  });

export const DIRECT_EDIT_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

export type DirectEditFileLike = {
  size: number;
  type: string;
};

export type DirectEditDocumentFileCheck =
  | {
      ok: true;
      mimeType: "image/jpeg" | "image/png" | "application/pdf";
      sizeBytes: number;
    }
  | {
      ok: false;
      code: "DOCUMENT_FILE_REQUIRED" | "DOCUMENT_SIZE_INVALID" | "DOCUMENT_MIME_INVALID";
    };

export function checkDirectEditDocumentFile(
  docType: DirectEditDocumentType,
  file: DirectEditFileLike | null | undefined,
): DirectEditDocumentFileCheck {
  if (!file) {
    return { ok: false, code: "DOCUMENT_FILE_REQUIRED" };
  }
  if (
    typeof file.size !== "number" ||
    !Number.isFinite(file.size) ||
    file.size < 1 ||
    file.size > DIRECT_EDIT_DOCUMENT_MAX_BYTES
  ) {
    return { ok: false, code: "DOCUMENT_SIZE_INVALID" };
  }
  const mime = typeof file.type === "string" ? file.type.trim().toLowerCase() : "";
  if (docType === "WORKER_PORTRAIT") {
    if (mime !== "image/jpeg" && mime !== "image/png") {
      return { ok: false, code: "DOCUMENT_MIME_INVALID" };
    }
    return { ok: true, mimeType: mime, sizeBytes: file.size };
  }
  if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "application/pdf") {
    return { ok: false, code: "DOCUMENT_MIME_INVALID" };
  }
  return { ok: true, mimeType: mime, sizeBytes: file.size };
}

export function directEditDocumentErrorMessage(
  docType: DirectEditDocumentType,
  code?: string | null,
): string {
  const label = DIRECT_EDIT_DOCUMENT_LABELS[docType];
  if (code === "DOCUMENT_FILE_REQUIRED") {
    return `${label}: Hãy chọn tệp trước khi tải lên.`;
  }
  if (code === "DOCUMENT_SIZE_INVALID") {
    return `${label}: Tệp phải lớn hơn 0 và không vượt quá 10 MiB.`;
  }
  if (code === "DOCUMENT_MIME_INVALID") {
    return docType === "WORKER_PORTRAIT"
      ? `${label}: Chỉ chấp nhận ảnh JPEG hoặc PNG.`
      : `${label}: Chỉ chấp nhận tệp JPEG, PNG hoặc PDF.`;
  }
  if (code === "DOCUMENT_CONTENT_INVALID") {
    return `${label}: Nội dung tệp không khớp định dạng đã chọn.`;
  }
  if (code === "DOCUMENT_VERSION_CONFLICT" || code === "VERSION_CONFLICT") {
    return `${label}: Dữ liệu hồ sơ đã thay đổi. Vui lòng bấm Thử lại cho tệp này.`;
  }
  if (code === "DOCUMENT_DENIED" || code === "ACTOR_NOT_AVAILABLE") {
    return `${label}: Bạn không có quyền tải tài liệu này.`;
  }
  if (code === "DOCUMENT_STORAGE_UNAVAILABLE" || code === "DOCUMENT_UPLOAD_MISSING") {
    return `${label}: Kho lưu trữ chưa sẵn sàng. Bạn có thể bấm Thử lại cho tệp này.`;
  }
  if (code === "DOCUMENT_FINALIZE_UNAVAILABLE") {
    return `${label}: Chưa hoàn tất ghi nhận tệp. Bạn có thể bấm Thử lại cho tệp này.`;
  }
  return `${label}: Không tải lên được. Bạn có thể bấm Thử lại cho tệp này.`;
}

export type DirectEditSingleDocumentUploadResult =
  | {
      ok: true;
      docType: DirectEditDocumentType;
      documentId: string;
      documentVersion: number;
      entryVersion: number;
      message: string;
    }
  | {
      ok: false;
      docType: DirectEditDocumentType;
      conflict: boolean;
      code: string;
      entryVersion: number;
      message: string;
    };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSafeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function uploadDirectEditDocument(input: {
  entryId: string;
  expectedEntryVersion: number;
  docType: DirectEditDocumentType;
  file: DirectEditFileLike & BodyInit;
  reason: string | null;
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<DirectEditSingleDocumentUploadResult> {
  const {
    entryId,
    expectedEntryVersion,
    docType,
    file,
    reason,
    idempotencyKey = crypto.randomUUID(),
    fetchImpl = fetch,
  } = input;

  const check = checkDirectEditDocumentFile(docType, file);
  if (!check.ok) {
    return {
      ok: false,
      docType,
      conflict: false,
      code: check.code,
      entryVersion: expectedEntryVersion,
      message: directEditDocumentErrorMessage(docType, check.code),
    };
  }

  const baseUrl = `/api/direct-entry/entries/${encodeURIComponent(entryId)}/documents`;
  let currentEntryVersion = expectedEntryVersion;

  try {
    const reserveRes = await fetchImpl(baseUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        document_type: docType,
        expected_entry_version: expectedEntryVersion,
        size_bytes: check.sizeBytes,
        mime_type: check.mimeType,
        reason: reason ?? `Cập nhật ${DIRECT_EDIT_DOCUMENT_LABELS[docType]}`,
      }),
    });
    const reservePayload = await readSafeJson(reserveRes);
    if (reserveRes.status === 409) {
      return {
        ok: false,
        docType,
        conflict: true,
        code: "DOCUMENT_VERSION_CONFLICT",
        entryVersion: currentEntryVersion,
        message: directEditDocumentErrorMessage(docType, "DOCUMENT_VERSION_CONFLICT"),
      };
    }
    if (
      !reserveRes.ok ||
      !isJsonObject(reservePayload) ||
      reservePayload.ok !== true ||
      typeof reservePayload.document_id !== "string" ||
      typeof reservePayload.entry_version !== "number"
    ) {
      const code =
        isJsonObject(reservePayload) && typeof reservePayload.code === "string"
          ? reservePayload.code
          : reserveRes.status === 403
            ? "DOCUMENT_DENIED"
            : "DOCUMENT_RESPONSE_INVALID";
      return {
        ok: false,
        docType,
        conflict: false,
        code,
        entryVersion: currentEntryVersion,
        message: directEditDocumentErrorMessage(docType, code),
      };
    }

    const documentId = reservePayload.document_id;
    const documentVersion =
      typeof reservePayload.version === "number" ? reservePayload.version : 1;
    currentEntryVersion = reservePayload.entry_version;

    const uploadInfo = reservePayload.upload;
    if (
      isJsonObject(uploadInfo) &&
      uploadInfo.method === "PUT" &&
      typeof uploadInfo.url === "string" &&
      isJsonObject(uploadInfo.headers)
    ) {
      const putHeaders: Record<string, string> = {};
      for (const [headerName, headerValue] of Object.entries(uploadInfo.headers)) {
        if (typeof headerValue === "string") {
          putHeaders[headerName] = headerValue;
        }
      }
      const putRes = await fetchImpl(uploadInfo.url, {
        method: "PUT",
        headers: putHeaders,
        body: file,
      });
      if (!putRes.ok) {
        return {
          ok: false,
          docType,
          conflict: false,
          code: "DOCUMENT_STORAGE_UNAVAILABLE",
          entryVersion: currentEntryVersion,
          message: directEditDocumentErrorMessage(docType, "DOCUMENT_STORAGE_UNAVAILABLE"),
        };
      }
    }

    const finalizeUrl = `${baseUrl}/${encodeURIComponent(documentId)}/finalize`;
    const finalizeRes = await fetchImpl(finalizeUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `${idempotencyKey}:finalize`,
      },
      body: JSON.stringify({
        expected_entry_version: currentEntryVersion,
      }),
    });
    const finalizePayload = await readSafeJson(finalizeRes);
    if (finalizeRes.status === 422) {
      currentEntryVersion += 1;
    }
    if (finalizeRes.status === 409) {
      const conflictCode =
        isJsonObject(finalizePayload) && typeof finalizePayload.code === "string"
          ? finalizePayload.code
          : "DOCUMENT_VERSION_CONFLICT";
      return {
        ok: false,
        docType,
        conflict: conflictCode === "DOCUMENT_VERSION_CONFLICT" || conflictCode === "VERSION_CONFLICT",
        code: conflictCode,
        entryVersion: currentEntryVersion,
        message: directEditDocumentErrorMessage(docType, conflictCode),
      };
    }
    if (
      !finalizeRes.ok ||
      !isJsonObject(finalizePayload) ||
      finalizePayload.ok !== true
    ) {
      const code =
        isJsonObject(finalizePayload) && typeof finalizePayload.code === "string"
          ? finalizePayload.code
          : finalizeRes.status === 403
            ? "DOCUMENT_DENIED"
            : "DOCUMENT_FINALIZE_UNAVAILABLE";
      return {
        ok: false,
        docType,
        conflict: false,
        code,
        entryVersion: currentEntryVersion,
        message: directEditDocumentErrorMessage(docType, code),
      };
    }

    if (typeof finalizePayload.entry_version === "number") {
      currentEntryVersion = finalizePayload.entry_version;
    }
    const finalDocVersion =
      typeof finalizePayload.version === "number" ? finalizePayload.version : documentVersion;

    return {
      ok: true,
      docType,
      documentId,
      documentVersion: finalDocVersion,
      entryVersion: currentEntryVersion,
      message: `${DIRECT_EDIT_DOCUMENT_LABELS[docType]}: Đã tải lên (v${finalDocVersion}).`,
    };
  } catch {
    return {
      ok: false,
      docType,
      conflict: false,
      code: "DOCUMENT_STORAGE_UNAVAILABLE",
      entryVersion: currentEntryVersion,
      message: directEditDocumentErrorMessage(docType, "DOCUMENT_STORAGE_UNAVAILABLE"),
    };
  }
}

export async function runDirectEditDocumentUploads(input: {
  entryId: string;
  initialEntryVersion: number;
  items: readonly {
    docType: DirectEditDocumentType;
    file: DirectEditFileLike & BodyInit;
    idempotencyKey?: string;
  }[];
  reason: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{
  entryVersion: number;
  results: readonly DirectEditSingleDocumentUploadResult[];
  allSucceeded: boolean;
}> {
  let currentVersion = input.initialEntryVersion;
  const results: DirectEditSingleDocumentUploadResult[] = [];
  for (const item of input.items) {
    const outcome = await uploadDirectEditDocument({
      entryId: input.entryId,
      expectedEntryVersion: currentVersion,
      docType: item.docType,
      file: item.file,
      reason: input.reason,
      idempotencyKey: item.idempotencyKey,
      fetchImpl: input.fetchImpl,
    });
    currentVersion = outcome.entryVersion;
    results.push(outcome);
  }
  return {
    entryVersion: currentVersion,
    results,
    allSucceeded: results.every((item) => item.ok),
  };
}

export type {
  ChangeRequestListItem,
  SubmissionReadItem,
  WorkerDirectoryPage,
  WorkerDirectoryRow,
};
