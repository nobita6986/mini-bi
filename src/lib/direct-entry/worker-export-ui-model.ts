/**
 * PRE-W2-P1 (T1A) + HF-E - Pure UI model cho "Xuất Excel" (recruited / managed / all).
 *
 * Khong React, khong I/O. Client KHONG gui authority: body chi gom `scope` + bo loc + `reason`,
 * dung allowlist cua POST /api/direct-entry/workers/export. Quyen cuoi cung do server session +
 * DB row-audience guard quyet dinh; all-scope export keeps its existing explicit action gate.
 */

import {
  WORKER_EMPLOYMENT_STATUSES,
  type WorkerDirectoryScope,
} from "./worker-directory-contract.ts";
import type {
  WorkerDirectoryFilters,
  WorkerOperationsActor,
} from "./worker-operations-model.ts";

/** Scope xuat duoc server cho phep; `all` chi mo cho Admin/BoD/Kế toán (#90). */
export const WORKER_EXPORT_SCOPES = ["recruited", "managed", "all"] as const;
export type WorkerExportScope = (typeof WORKER_EXPORT_SCOPES)[number];

export const WORKER_EXPORT_REASON_MAX = 4000;

/** Fallback khi 422 khong tra `limit` hop le; khop WORKER_EXPORT_ROW_LIMIT (#86). */
export const WORKER_EXPORT_FALLBACK_LIMIT = 10000;

export const WORKER_EXPORT_LIMIT_MESSAGE_PREFIX = "Danh sách vượt giới hạn";

export type WorkerExportEmploymentStatus = (typeof WORKER_EMPLOYMENT_STATUSES)[number];

export type WorkerExportRequestBody = {
  scope: WorkerExportScope;
  project_id: string | null;
  recruiter_id: string | null;
  employment_status: WorkerExportEmploymentStatus | null;
  reason: string;
};

export function isWorkerExportScope(value: unknown): value is WorkerExportScope {
  return typeof value === "string" &&
    (WORKER_EXPORT_SCOPES as readonly string[]).includes(value);
}

/** Scope tab cua danh sach nao duoc phep xuat; `uploader` => null. */
export function exportScopeForTab(tab: string): WorkerExportScope | null {
  return isWorkerExportScope(tab) ? tab : null;
}

export function isExportableScope(
  scope: WorkerDirectoryScope | null,
): scope is WorkerExportScope {
  return isWorkerExportScope(scope);
}

/**
 * Offer export beside directory scopes to any resolved business actor. The RPC still verifies
 * the recruiter link / PM assignment; this UI signal does not grant row access.
 */
export function canExportWorkers(actor: WorkerOperationsActor | null): boolean {
  return actor !== null;
}

/**
 * Company-wide export needs current all scope plus an existing admin/reviewer action.
 * The RPC remains authoritative for the scope and row audience.
 */
export function canExportAllWorkers(actor: WorkerOperationsActor | null): boolean {
  if (actor === null) return false;
  return actor.scopes.some((scope) => scope.kind === "all") &&
    actor.capabilities.some((capability) =>
      capability === "entry_admin" || capability === "change_review");
}

export type WorkerExportRequestCode =
  | "SCOPE_INVALID"
  | "REASON_REQUIRED"
  | "REASON_TOO_LONG"
  | "FILTER_INVALID";

export type WorkerExportRequestOutcome =
  | { ok: true; body: WorkerExportRequestBody }
  | { ok: false; code: WorkerExportRequestCode };

function normalizeFilter(value: string): string | null {
  return value === "" ? null : value;
}

/**
 * Body theo dung allowlist cua contract: `scope | project_id | recruiter_id | employment_status |
 * reason`. `scope` phai la recruited|managed; `reason` bat buoc (trim, 1..4000); filter rong => null.
 * Mot filter trang thai la (khong the xay ra tu select) bi tu choi fail-closed, KHONG bao gio bi
 * am tham bo di (se xuat thua du lieu).
 */
export function buildWorkerExportRequest(input: {
  scope: string;
  filters: WorkerDirectoryFilters;
  reason: string;
}): WorkerExportRequestOutcome {
  if (!isWorkerExportScope(input.scope)) return { ok: false, code: "SCOPE_INVALID" };

  const reason = input.reason.trim();
  if (reason === "") return { ok: false, code: "REASON_REQUIRED" };
  if (reason.length > WORKER_EXPORT_REASON_MAX) return { ok: false, code: "REASON_TOO_LONG" };

  const status = input.filters.status;
  if (status !== "" &&
      !(WORKER_EMPLOYMENT_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, code: "FILTER_INVALID" };
  }

  return {
    ok: true,
    body: {
      scope: input.scope,
      project_id: normalizeFilter(input.filters.projectId),
      recruiter_id: normalizeFilter(input.filters.recruiterId),
      employment_status: status === "" ? null : (status as WorkerExportEmploymentStatus),
      reason,
    },
  };
}

/** Copy loi request (khong lo UUID/raw DB/PII). */
export function workerExportRequestMessage(code: WorkerExportRequestCode): string {
  if (code === "SCOPE_INVALID") {
    return "Chỉ xuất được ở \"Người tôi tuyển\", \"Dự án tôi quản lý\" và \"Toàn bộ NLĐ\".";
  }
  if (code === "REASON_TOO_LONG") {
    return "Lý do xuất tối đa " + String(WORKER_EXPORT_REASON_MAX) + " ký tự.";
  }
  if (code === "FILTER_INVALID") {
    return "Bộ lọc không hợp lệ. Vui lòng chọn lại rồi thử lại.";
  }
  return "Lý do xuất là bắt buộc.";
}

/** Doc `limit` tu envelope 422 cua server; fallback hang so khi thieu/khong hop le. */
export function workerExportRowLimit(payload: unknown): number {
  if (typeof payload === "object" && payload !== null) {
    const value = (payload as Record<string, unknown>).limit;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  }
  return WORKER_EXPORT_FALLBACK_LIMIT;
}

/**
 * Copy loi phan hoi (khong lo response body/UUID/raw DB). 422 row-limit phai noi ro gioi han va
 * huong dan thu hep bo loc — khong bao gio tai file thieu dong.
 */
export function workerExportErrorMessage(status: number, payload: unknown): string {
  if (status === 401) return "Phiên làm việc đã hết hiệu lực. Vui lòng đăng nhập lại.";
  if (status === 403) return "Bạn không có quyền xuất danh sách người lao động.";
  if (status === 404) return "Chức năng xuất Excel chưa được bật.";
  if (status === 422) {
    return WORKER_EXPORT_LIMIT_MESSAGE_PREFIX + " " + String(workerExportRowLimit(payload)) +
      " dòng. Vui lòng thu hẹp bộ lọc (dự án, người tuyển, trạng thái làm việc) rồi thử lại.";
  }
  if (status === 400) return "Yêu cầu xuất không hợp lệ. Vui lòng kiểm tra lại bộ lọc và lý do.";
  return "Không xuất được danh sách. Vui lòng thử lại.";
}

const XLSX_FILENAME = /^[A-Za-z0-9._-]+\.xlsx$/;

/**
 * Filename an toan: uu tien ten server tra qua `content-disposition`, chi nhan basename .xlsx
 * (khong path separator); neu thieu/khong hop le dung fallback co dinh theo ngay.
 */
export function workerExportFilename(
  contentDisposition: string | null,
  fallbackDate: string,
): string {
  const match = contentDisposition?.match(/filename="([^"]+)"/);
  const candidate = match?.[1] ?? "";
  if (XLSX_FILENAME.test(candidate) && !candidate.includes("..")) return candidate;
  const safeDate = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(fallbackDate)
    ? fallbackDate
    : new Date().toISOString().slice(0, 10);
  return "danh-sach-nguoi-lao-dong-" + safeDate + ".xlsx";
}
