/**
 * P1.6-W04-S04C-S03A - Helper thuan cho vong doi submission tren UI.
 *
 * Khong I/O, khong framework, khong state machine tong quat. Moi quyet dinh ve quyen/trang thai
 * van do server (RPC + API) quyet dinh; module nay chi:
 *   * doi chieu trang thai server voi kha nang chinh sua cua UI (edit lock);
 *   * dung allowed_transitions do server tra ve de tao hanh dong (khong tu suy dien);
 *   * bao ve UX khi con dong chua luu;
 *   * giu idempotency key theo intent;
 *   * tong hop thong bao loi sanitized.
 */
import { isAllowedTransition, type SubmissionState } from "./submission-transition-contract.ts";
import type { SubmissionReadItem } from "./submission-read-contract.ts";
import type { DraftSaveState, LiveDraftRow } from "./live-controller.ts";

export const SUBMISSION_STATE_LABELS: Readonly<Record<SubmissionState, string>> = Object.freeze({
  DRAFT: "Bản nháp",
  REVIEW: "Chờ duyệt",
  SUBMITTED: "Đã gửi chính thức",
});

export type SubmissionAction = {
  target_state: SubmissionState;
  label: string;
  confirm_title: string;
  confirm_description: string;
  confirm_label: string;
};

export const TRANSITION_ACTIONS: Readonly<Record<SubmissionState, SubmissionAction>> = Object.freeze({
  DRAFT: {
    target_state: "DRAFT",
    label: "Trả về bản nháp",
    confirm_title: "Trả về bản nháp?",
    confirm_description:
      "Đợt nhập liệu sẽ mở lại để chỉnh sửa. Dữ liệu đang có trên máy chủ được giữ nguyên.",
    confirm_label: "Trả về bản nháp",
  },
  REVIEW: {
    target_state: "REVIEW",
    label: "Gửi duyệt",
    confirm_title: "Gửi duyệt đợt nhập liệu?",
    confirm_description:
      "Sau khi gửi duyệt, đợt nhập liệu tạm khóa chỉnh sửa cho tới khi được trả về bản nháp.",
    confirm_label: "Gửi duyệt",
  },
  SUBMITTED: {
    target_state: "SUBMITTED",
    label: "Gửi chính thức",
    confirm_title: "Gửi chính thức đợt nhập liệu?",
    confirm_description:
      "Đã gửi chính thức là trạng thái cuối: không thể sửa trực tiếp. Mọi thay đổi sau đó phải đi qua yêu cầu thay đổi.",
    confirm_label: "Gửi chính thức",
  },
});

/**
 * Hanh dong chi duoc tao tu allowed_transitions do server tra ve VA phai khop ma tran trang thai.
 * Mang sai tu server (hoac du lieu khong qua projection) khong tao ra hanh dong nao.
 */
export function actionsForSubmission(submission: {
  state: SubmissionState;
  allowed_transitions: readonly SubmissionState[];
}): SubmissionAction[] {
  const actions: SubmissionAction[] = [];
  for (const target of submission.allowed_transitions) {
    if (!isAllowedTransition(submission.state, target)) continue;
    const action = TRANSITION_ACTIONS[target];
    if (action) actions.push(action);
  }
  return actions;
}

/** Chi DRAFT moi sua duoc; null/khong xac dinh => read-only (fail-closed). */
export function isSubmissionEditable(state: SubmissionState | null | undefined): boolean {
  return state === "DRAFT";
}

/**
 * Trang thai submission cua mot dong: dong moi (chua co submission) coi nhu dang soan (DRAFT);
 * dong thuoc submission khong co trong danh sach da tai => null (fail-closed read-only).
 */
export function submissionStateForRow(
  row: Pick<LiveDraftRow, "submissionId">,
  submissions: readonly SubmissionReadItem[],
): SubmissionState | null {
  if (row.submissionId === null) return "DRAFT";
  const found = submissions.find((item) => item.submission_id === row.submissionId);
  return found ? found.state : null;
}

export function isRowEditable(
  row: Pick<LiveDraftRow, "submissionId">,
  submissions: readonly SubmissionReadItem[],
): boolean {
  if (row.submissionId === null) return true;
  return isSubmissionEditable(submissionStateForRow(row, submissions));
}

export const UNSAVED_ROW_STATES: readonly DraftSaveState[] = Object.freeze([
  "dirty", "saving", "error", "conflict",
]);

export function isUnsavedRowState(state: DraftSaveState): boolean {
  return UNSAVED_ROW_STATES.includes(state);
}

/** So dong con thay doi chua duoc may chu xac nhan trong mot submission. */
export function unsavedRowCount(
  rows: readonly LiveDraftRow[],
  submissionId: string,
): number {
  return rows.filter((row) =>
    row.submissionId === submissionId && isUnsavedRowState(row.state)).length;
}

/**
 * UX protection truoc khi gui duyet: chi la lop bao ve giao dien, KHONG phai authorization.
 * Tra ly do chan hoac null khi duoc phep mo confirm.
 */
export function confirmBlockReason(
  rows: readonly LiveDraftRow[],
  submissionId: string,
): "UNSAVED_ROWS" | null {
  return unsavedRowCount(rows, submissionId) > 0 ? "UNSAVED_ROWS" : null;
}

export function dropSubmissionRows(
  rows: readonly LiveDraftRow[],
  submissionId: string,
): LiveDraftRow[] {
  return rows.filter((row) => row.submissionId !== submissionId);
}

/**
 * Sau khi tai lai /api/direct-entry/drafts: dong tu may chu la nguon su that, nhung dong chua luu
 * (moi hoac dang dirty/saving/error/conflict) cua nguoi dung phai duoc giu lai.
 */
export function mergeReloadedDrafts(
  localRows: readonly LiveDraftRow[],
  serverRows: readonly LiveDraftRow[],
): LiveDraftRow[] {
  const localByEntry = new Map<string, LiveDraftRow>();
  for (const row of localRows) {
    if (row.entryId) localByEntry.set(row.entryId, row);
  }
  const merged = serverRows.map((serverRow) => {
    const local = serverRow.entryId ? localByEntry.get(serverRow.entryId) : undefined;
    return local && isUnsavedRowState(local.state) ? local : serverRow;
  });
  const serverEntries = new Set(serverRows.map((row) => row.entryId).filter(Boolean));
  for (const row of localRows) {
    if (row.entryId && serverEntries.has(row.entryId)) continue;
    if (row.entryId === null || isUnsavedRowState(row.state)) merged.push(row);
  }
  return merged;
}

export function shortRef(value: string): string {
  return value.slice(0, 8);
}

/**
 * Dinh dang thoi gian theo gio Viet Nam nhung KHONG phu thuoc ICU/locale cua may chay test:
 * chuyen ISO UTC sang UTC+7 roi in DD/MM/YYYY HH:mm.
 */
export function formatHcmDateTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "—";
  const shifted = new Date(parsed + 7 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return pad(shifted.getUTCDate()) + "/" + pad(shifted.getUTCMonth() + 1) + "/" +
    shifted.getUTCFullYear() + " " + pad(shifted.getUTCHours()) + ":" + pad(shifted.getUTCMinutes());
}

export type TransitionIntentKeyState = { intent: string | null; key: string | null };

export const EMPTY_INTENT_KEY: TransitionIntentKeyState = Object.freeze({ intent: null, key: null });

/**
 * Cung mot intent (cung submission + cung target) thi dung lai key cu de retry an toan;
 * doi target hoac sau khi da co response terminal thi tao key moi.
 */
export function resolveIntentKey(
  state: TransitionIntentKeyState,
  intent: string,
  generate: () => string,
): { key: string; reused: boolean; state: TransitionIntentKeyState } {
  if (state.intent === intent && state.key) {
    return { key: state.key, reused: true, state };
  }
  const key = generate();
  return { key, reused: false, state: { intent, key } };
}

/** Sau response terminal (thanh cong hoac loi nghiep vu) thi bo key cua intent do. */
export function clearIntentKey(
  state: TransitionIntentKeyState,
  intent: string,
): TransitionIntentKeyState {
  return state.intent === intent ? EMPTY_INTENT_KEY : state;
}

export function transitionErrorMessage(status: number): string {
  if (status === 400) return "Yêu cầu không hợp lệ. Vui lòng tải lại trang và thử lại.";
  if (status === 401) return "Phiên làm việc đã hết hiệu lực. Vui lòng đăng nhập lại.";
  if (status === 403) return "Bạn không còn quyền thực hiện thao tác này.";
  if (status === 404) return "Không tìm thấy đợt nhập liệu hoặc bạn không có quyền xem.";
  if (status === 409) return "Dữ liệu đã thay đổi ở nơi khác. Danh sách vừa được tải lại.";
  return "Không gửi được yêu cầu. Vui lòng thử lại.";
}
