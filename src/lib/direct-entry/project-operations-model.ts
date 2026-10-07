/**
 * P2.5-W06A - Model thuan cho Project Operations UI (khong phu thuoc React).
 *
 * Vai tro:
 * - Validate input client TRUOC khi goi API (reason bat buoc, OCC version, id shape).
 * - Build request body DUNG cac key ma API boundary chap nhan.
 *   Client TUYET DOI khong gui actor/auth_subject/app_user_id/capability/scope/role.
 * - Phan loai response thanh outcome sanitized.
 *
 * Quyen KHONG duoc suy dien o day: server response/RPC la nguon duy nhat.
 */

export const REASON_MAX = 4000;
export const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ProjectView = {
  project_id: string;
  display_name: string;
  active: boolean;
  version: number;
};

export type AssignmentView = {
  assignment_id: string;
  project_id: string;
  project_version: number;
  manager_recruiter_id: string;
  valid_from: string;
  valid_to: string | null;
  effective: boolean;
  version: number;
  revoked_at: string | null;
  created_at: string;
};

export type ProjectDetailView = {
  authorization_date: string;
  project_id: string;
  project_version: number;
  project_active: boolean;
  active_assignment_count: number;
  assignments: AssignmentView[];
};

export type RequestResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string };

export type Outcome =
  | { kind: "applied" }
  | { kind: "reload-required"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

const RELOAD_MESSAGE =
  "Dữ liệu đã thay đổi ở nơi khác. Vui lòng tải lại trước khi tiếp tục.";

/* ---------- parse response (server la nguon duy nhat) ---------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function asText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseProject(value: unknown): ProjectView | null {
  const row = asRecord(value);
  if (!row) return null;
  const project_id = asText(row.project_id);
  const display_name = asText(row.display_name);
  const active = asBool(row.active);
  const version = asCount(row.version);
  if (project_id === null || display_name === null || active === null || version === null) {
    return null;
  }
  return { project_id, display_name, active, version };
}

export function parseAssignment(value: unknown): AssignmentView | null {
  const row = asRecord(value);
  if (!row) return null;
  const assignment_id = asText(row.assignment_id);
  const project_id = asText(row.project_id);
  const project_version = asCount(row.project_version);
  const manager_recruiter_id = asText(row.manager_recruiter_id);
  const valid_from = asText(row.valid_from);
  const effective = asBool(row.effective);
  const version = asCount(row.version);
  const created_at = asText(row.created_at);
  if (assignment_id === null || project_id === null || project_version === null ||
      manager_recruiter_id === null || valid_from === null || effective === null ||
      version === null || created_at === null) {
    return null;
  }
  return {
    assignment_id, project_id, project_version, manager_recruiter_id, valid_from,
    valid_to: asText(row.valid_to), effective, version,
    revoked_at: asText(row.revoked_at), created_at,
  };
}

/** Doc danh sach tu response list; tra null khi shape khong dung (fail-closed). */
export function parseListResponse(payload: unknown): ProjectView[] | null {
  const root = asRecord(payload);
  if (!root || root.ok !== true) return null;
  const list = asRecord(root.list);
  if (!list || !Array.isArray(list.projects)) return null;
  const projects: ProjectView[] = [];
  for (const item of list.projects) {
    const project = parseProject(item);
    if (project === null) return null;
    projects.push(project);
  }
  return projects;
}

/** Doc detail tu response; tra null khi shape khong dung. */
export function parseDetailResponse(payload: unknown): ProjectDetailView | null {
  const root = asRecord(payload);
  if (!root || root.ok !== true) return null;
  const detail = asRecord(root.detail);
  if (!detail || !Array.isArray(detail.assignments)) return null;
  const project_id = asText(detail.project_id);
  const project_version = asCount(detail.project_version);
  const project_active = asBool(detail.project_active);
  const active_assignment_count = asCount(detail.active_assignment_count);
  const authorization_date = asText(detail.authorization_date);
  if (project_id === null || project_version === null || project_active === null ||
      active_assignment_count === null || authorization_date === null) {
    return null;
  }
  const assignments: AssignmentView[] = [];
  for (const item of detail.assignments) {
    const assignment = parseAssignment(item);
    if (assignment === null) return null;
    assignments.push(assignment);
  }
  return {
    authorization_date, project_id, project_version, project_active,
    active_assignment_count, assignments,
  };
}

/* ---------- validate input ---------- */

export function validateProjectId(value: string): string | null {
  return PROJECT_ID_PATTERN.test(value.trim())
    ? null
    : "Mã dự án chỉ gồm chữ, số và các ký tự . _ : - (tối đa 128 ký tự).";
}
export function validateDisplayName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Tên dự án là bắt buộc.";
  if (trimmed.length > 200) return "Tên dự án tối đa 200 ký tự.";
  return null;
}
/** Ly do la BAT BUOC cho moi thao tac thay doi (create/rename/active/assign/unassign). */
export function validateReason(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Lý do là bắt buộc.";
  if (value.length > REASON_MAX) return "Lý do tối đa " + String(REASON_MAX) + " ký tự.";
  return null;
}
export function validateUuid(value: string): string | null {
  return UUID_PATTERN.test(value.trim()) ? null : "Giá trị không phải định danh hợp lệ.";
}
export function validateDate(value: string): string | null {
  if (!DATE_PATTERN.test(value.trim())) return "Ngày phải theo định dạng YYYY-MM-DD.";
  const parsed = new Date(value.trim() + "T00:00:00Z");
  return Number.isNaN(parsed.getTime()) ? "Ngày không hợp lệ." : null;
}
export function validateVersion(value: number): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? null
    : "Phiên bản không hợp lệ.";
}

/* ---------- build request ---------- */

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function buildCreateRequest(input: {
  projectId: string; displayName: string; reason: string; idempotencyKey: string;
}): RequestResult {
  const failure = validateProjectId(input.projectId) ?? validateDisplayName(input.displayName)
    ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return { ok: true, body: {
    project_id: input.projectId.trim(), display_name: input.displayName.trim(),
    reason: input.reason, idempotency_key: input.idempotencyKey,
  } };
}

export function buildRenameRequest(input: {
  displayName: string; reason: string; expectedVersion: number; idempotencyKey: string;
}): RequestResult {
  const failure = validateDisplayName(input.displayName) ?? validateReason(input.reason)
    ?? validateVersion(input.expectedVersion) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return { ok: true, body: {
    display_name: input.displayName.trim(), reason: input.reason,
    expected_version: input.expectedVersion, idempotency_key: input.idempotencyKey,
  } };
}

/** Bat/tat du an: CHI doi co active. Tat du an = active false (khong co RPC rieng). */
export function buildSetActiveRequest(input: {
  active: boolean; reason: string; expectedVersion: number; idempotencyKey: string;
}): RequestResult {
  const failure = validateReason(input.reason) ?? validateVersion(input.expectedVersion)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return { ok: true, body: {
    active: input.active, reason: input.reason,
    expected_version: input.expectedVersion, idempotency_key: input.idempotencyKey,
  } };
}

export type PendingAssignment = { managerRecruiterId: string; validFrom: string };

export function validatePendingAssignments(rows: readonly PendingAssignment[]): string | null {
  if (rows.length === 0) return "Cần ít nhất một quản lý dự án.";
  const seen = new Set<string>();
  for (const row of rows) {
    const failure = validateUuid(row.managerRecruiterId) ?? validateDate(row.validFrom);
    if (failure) return failure;
    const key = row.managerRecruiterId.trim().toLowerCase();
    if (seen.has(key)) return "Một quản lý không được gán hai lần trong cùng một lần gửi.";
    seen.add(key);
  }
  return null;
}

export function buildAssignRequest(input: {
  managerRecruiterId: string; validFrom: string; reason: string;
  expectedProjectVersion: number; idempotencyKey: string;
}): RequestResult {
  const failure = validateUuid(input.managerRecruiterId) ?? validateDate(input.validFrom)
    ?? validateReason(input.reason) ?? validateVersion(input.expectedProjectVersion)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return { ok: true, body: {
    manager_recruiter_id: input.managerRecruiterId.trim(),
    valid_from: input.validFrom.trim(), reason: input.reason,
    expected_project_version: input.expectedProjectVersion,
    idempotency_key: input.idempotencyKey,
  } };
}

export function buildUnassignRequest(input: {
  reason: string; expectedVersion: number; expectedProjectVersion: number; idempotencyKey: string;
}): RequestResult {
  const failure = validateReason(input.reason) ?? validateVersion(input.expectedVersion)
    ?? validateVersion(input.expectedProjectVersion) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return { ok: true, body: {
    reason: input.reason, expected_version: input.expectedVersion,
    expected_project_version: input.expectedProjectVersion,
    idempotency_key: input.idempotencyKey,
  } };
}

/* ---------- outcome ---------- */

export function classifyResponse(status: number, payload: unknown): Outcome {
  if (status === 200) return { kind: "applied" };
  const root = asRecord(payload);
  const code = root ? asText(root.code) : null;
  if (status === 401) {
    return { kind: "unauthenticated", message: "Phiên đăng nhập không còn hiệu lực." };
  }
  if (status === 403) {
    return { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  }
  if (status === 404) {
    return { kind: "not-found", message: "Dự án hoặc phân công không còn tồn tại." };
  }
  if (status === 409 || code === "PROJECT_CONFLICT") {
    return { kind: "reload-required", message: RELOAD_MESSAGE };
  }
  if (status === 400) {
    return { kind: "invalid", message: "Dữ liệu gửi lên không hợp lệ." };
  }
  return { kind: "unavailable", message: "Hệ thống tạm thời không khả dụng. Vui lòng thử lại." };
}

/* ---------- view ---------- */

/** Quan ly hien tai (dang hieu luc) va lich su phan cong (da thu hoi / chua hieu luc). */
export function splitAssignments(assignments: readonly AssignmentView[]): {
  current: AssignmentView[];
  history: AssignmentView[];
} {
  const current: AssignmentView[] = [];
  const history: AssignmentView[] = [];
  for (const assignment of assignments) {
    if (assignment.effective && assignment.valid_to === null) current.push(assignment);
    else history.push(assignment);
  }
  const byStart = (a: AssignmentView, b: AssignmentView) => (a.valid_from < b.valid_from ? 1 : -1);
  current.sort(byStart);
  history.sort(byStart);
  return { current, history };
}

export function projectStatusLabel(active: boolean): string {
  return active ? "Đang hoạt động" : "Đã ngừng";
}
