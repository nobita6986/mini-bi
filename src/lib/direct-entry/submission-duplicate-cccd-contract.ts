/**
 * P3.1-HF-R1 - Hop dong canh bao CCCD trung khi DRAFT -> REVIEW.
 *
 * Pure projection: khong I/O, khong doc session, khong goi DB. Server (RPC
 * public.direct_entry_submission_duplicate_cccd_preflight) la nguon su that; module nay:
 *   * project chinh xac tung key cua preflight va fail-closed (khong fallback [] hay 0);
 *   * map trang thai canonical ON / UNCONFIRMED sang nhan tieng Viet cho modal - SQL khong
 *     bao gio so sanh hay phat ra chuoi tieng Viet;
 *   * dung cau thong bao cua modal tu du lieu da duoc server loc.
 *
 * OFF khong bao gio xuat hien trong projection nay: server da loai no truoc khi tra ve.
 */
export const DUPLICATE_CCCD_PREFLIGHT_KEYS = [
  "submission_id", "version", "fingerprint", "conflict_count", "conflicts",
] as const;

export const DUPLICATE_CCCD_CONFLICT_KEYS = [
  "conflict_ref", "draft_display_name", "project_display", "employment_status", "cccd_last4",
] as const;

/** Hai key acknowledgement: chi hop le cho DRAFT -> REVIEW, va phai di cung nhau. */
export const DUPLICATE_CCCD_ACK_KEYS = [
  "duplicate_cccd_fingerprint", "duplicate_cccd_count",
] as const;

/** Tran cua server: 20 item moi trang va 1000 conflict cho mot lan xac nhan. */
export const DUPLICATE_CCCD_MAX_CONFLICTS = 20;
export const DUPLICATE_CCCD_MAX_COUNT = 1000;
export const DUPLICATE_CCCD_MAX_NAME_LENGTH = 200;
export const DUPLICATE_CCCD_MAX_PROJECT_LENGTH = 200;

export type DuplicateCccdStatus = "ON" | "UNCONFIRMED";

export const EMPLOYMENT_STATUS_LABELS: Readonly<Record<DuplicateCccdStatus, string>> =
  Object.freeze({
    ON: "Đang làm việc",
    UNCONFIRMED: "Không xác định",
  });

export type DuplicateCccdConflict = {
  conflict_ref: string;
  draft_display_name: string;
  project_display: string | null;
  employment_status: DuplicateCccdStatus;
  employment_status_label: string;
  cccd_last4: string;
};

export type DuplicateCccdPreflight = {
  submission_id: string;
  version: number;
  fingerprint: string;
  conflict_count: number;
  conflicts: DuplicateCccdConflict[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const CONFLICT_REF = /^[0-9a-f]{12}$/;
const LAST4 = /^[0-9]{4}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

function isPositiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isStatus(value: unknown): value is DuplicateCccdStatus {
  return value === "ON" || value === "UNCONFIRMED";
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function projectConflict(value: unknown): DuplicateCccdConflict | null {
  if (!isRecord(value) || !hasExactKeys(value, DUPLICATE_CCCD_CONFLICT_KEYS)) return null;
  if (typeof value.conflict_ref !== "string" || !CONFLICT_REF.test(value.conflict_ref)) return null;
  if (!isBoundedText(value.draft_display_name, DUPLICATE_CCCD_MAX_NAME_LENGTH)) return null;
  if (value.project_display !== null &&
      !isBoundedText(value.project_display, DUPLICATE_CCCD_MAX_PROJECT_LENGTH)) return null;
  if (!isStatus(value.employment_status)) return null;
  if (typeof value.cccd_last4 !== "string" || !LAST4.test(value.cccd_last4)) return null;
  return {
    conflict_ref: value.conflict_ref,
    draft_display_name: value.draft_display_name,
    project_display: value.project_display,
    employment_status: value.employment_status,
    employment_status_label: EMPLOYMENT_STATUS_LABELS[value.employment_status],
    cccd_last4: value.cccd_last4,
  };
}

/**
 * Projection cua preflight: dung nam key, fingerprint 64 hex, conflict_count trong bien,
 * conflicts toi da 20 item va khong trung conflict_ref. Bat ky sai khac nao => null de
 * caller fail-closed (khong hien modal voi du lieu khong ro nguon).
 */
export function projectDuplicateCccdPreflight(
  value: unknown,
  expected: { submission_id: string },
): DuplicateCccdPreflight | null {
  if (!isRecord(value) || !hasExactKeys(value, DUPLICATE_CCCD_PREFLIGHT_KEYS)) return null;
  if (typeof value.submission_id !== "string" || !UUID.test(value.submission_id)) return null;
  if (value.submission_id !== expected.submission_id) return null;
  if (!isPositiveVersion(value.version)) return null;
  if (typeof value.fingerprint !== "string" || !FINGERPRINT.test(value.fingerprint)) return null;
  if (typeof value.conflict_count !== "number" ||
      !Number.isSafeInteger(value.conflict_count)) {
    return null;
  }
  if (value.conflict_count < 0 || value.conflict_count > DUPLICATE_CCCD_MAX_COUNT) return null;
  if (!Array.isArray(value.conflicts)) return null;
  if (value.conflicts.length > DUPLICATE_CCCD_MAX_CONFLICTS) return null;
  if (value.conflicts.length > value.conflict_count) return null;
  const conflicts: DuplicateCccdConflict[] = [];
  const seen = new Set<string>();
  for (const raw of value.conflicts) {
    const conflict = projectConflict(raw);
    if (!conflict) return null;
    if (seen.has(conflict.conflict_ref)) return null;
    seen.add(conflict.conflict_ref);
    conflicts.push(conflict);
  }
  return {
    submission_id: value.submission_id,
    version: value.version,
    fingerprint: value.fingerprint,
    conflict_count: value.conflict_count,
    conflicts,
  };
}

export function duplicateCccdModalTitle(): string {
  return "Phát hiện CCCD đã tồn tại";
}

export function duplicateCccdModalQuestion(): string {
  return "Bạn chắc chắn vẫn muốn trình duyệt hồ sơ này?";
}

export function duplicateCccdStatusLine(conflict: DuplicateCccdConflict): string {
  return "Trạng thái hiện tại: " + conflict.employment_status_label + ".";
}

/** Mot cau cho moi conflict: ON la "đang làm việc", con lai la "một hồ sơ". */
export function duplicateCccdModalMessage(conflict: DuplicateCccdConflict): string {
  const trimmedName = conflict.draft_display_name.trim();
  const name = trimmedName === "" ? "trong bản nháp" : trimmedName;
  const project = conflict.project_display?.trim() ?? "";
  const subject = project === "" ? "trong hệ thống" : "tại dự án " + project;
  if (conflict.employment_status === "ON") {
    return "NLĐ " + name + " có số CCCD trùng với một NLĐ đang làm việc " + subject + ".";
  }
  return "NLĐ " + name + " có số CCCD trùng với một hồ sơ " + subject + ".";
}

