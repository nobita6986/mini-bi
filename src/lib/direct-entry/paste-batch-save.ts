/**
 * P1.6-I04C3-R2 - Luu nguyen tu mot nhom dong dan tu Excel.
 *
 * Dung dung endpoint hien huu POST /api/direct-entry/batches: mot nhom 1..100 dong di bang
 * DUNG MOT request, `Idempotency-Key` header khop voi body. Khong gui actor/auth subject/
 * role/capability/scope: server resolve actor tu session.
 *
 * Khong optimistic-save: chi khi server xac nhan (2xx + projection doc duoc) thi nhom moi
 * duoc coi la da luu. Loi atomic => toan bo nhom van o trang thai chua luu.
 */
import {
  clearIntentKey,
  EMPTY_INTENT_KEY,
  resolveIntentKey,
  type TransitionIntentKeyState,
} from "./submission-lifecycle.ts";
import type { PasteBatchRowPayload } from "./excel-paste-import.ts";

export const PASTE_BATCH_ENDPOINT = "/api/direct-entry/batches";
export const PASTE_BATCH_MAX_ROWS = 100;
export const PASTE_BATCH_MIN_ROWS = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PasteBatchKeyState = TransitionIntentKeyState;

export type PasteBatchSaved = {
  kind: "saved";
  submissionId: string;
  submissionVersion: number;
  /** entry_ids theo DUNG thu tu dong input. */
  entryIds: readonly string[];
};

export type PasteBatchResult =
  /** Loi tam thoi (network/5xx/2xx malformed): giu payload + key de retry. */
  | { kind: "retry"; code: string }
  /** 409: khong tu retry, phai reload/reconcile. */
  | { kind: "conflict"; code: string }
  /** 4xx nghiep vu: key da dung xong, payload khong tu dong gui lai. */
  | { kind: "rejected"; code: string }
  | PasteBatchSaved;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codeOf(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.code === "string" && body.code.length > 0
    ? body.code
    : fallback;
}

/** Chu ky intent: bat ky thay doi du lieu nao trong nhom deu sinh key moi. */
export function pasteBatchSignature(rows: readonly PasteBatchRowPayload[]): string {
  return JSON.stringify(rows);
}

/** Key theo dung fingerprint (entryIds khong co o day: nhom la mot lan tao moi). */
export function resolvePasteBatchKey(
  state: PasteBatchKeyState,
  signature: string,
  generate: () => string,
): { key: string; reused: boolean; state: PasteBatchKeyState } {
  return resolveIntentKey(state, "paste_batch:" + signature, generate);
}

/** Projection 2xx: entry_ids phai du va dung so dong input, theo dung thu tu. */
export function projectPasteBatchSaved(
  body: unknown,
  expectedRows: number,
): PasteBatchSaved | null {
  if (!isRecord(body) || body.ok !== true) return null;
  if (typeof body.submission_id !== "string" || !UUID.test(body.submission_id)) return null;
  if (typeof body.submission_version !== "number" ||
      !Number.isSafeInteger(body.submission_version) || body.submission_version < 1) return null;
  if (!Array.isArray(body.entry_ids) || body.entry_ids.length !== expectedRows) return null;
  if (!body.entry_ids.every((id) => typeof id === "string" && UUID.test(id))) return null;
  if (new Set(body.entry_ids).size !== body.entry_ids.length) return null;
  return {
    kind: "saved",
    submissionId: body.submission_id,
    submissionVersion: body.submission_version,
    entryIds: body.entry_ids as string[],
  };
}

export function classifyPasteBatchResponse(
  status: number,
  body: unknown,
  expectedRows: number,
): PasteBatchResult {
  if (status === 409) return { kind: "conflict", code: codeOf(body, "PASTE_BATCH_CONFLICT") };
  if (status >= 500) return { kind: "retry", code: codeOf(body, "PASTE_BATCH_UNAVAILABLE") };
  if (status >= 200 && status < 300) {
    // 2xx nhung projection khong doc duoc: ket qua khong xac dinh => retry cung key.
    return projectPasteBatchSaved(body, expectedRows) ??
      { kind: "retry", code: "PASTE_BATCH_RESPONSE_INVALID" };
  }
  return { kind: "rejected", code: codeOf(body, "PASTE_BATCH_REJECTED") };
}

export type PasteBatchFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Dung MOT request cho ca nhom. Thanh cong thi tra ve entry_ids theo thu tu input. */
export async function postPasteBatch(input: {
  rows: readonly PasteBatchRowPayload[];
  idempotencyKey: string;
  fetchImpl: PasteBatchFetch;
}): Promise<PasteBatchResult> {
  if (input.rows.length < PASTE_BATCH_MIN_ROWS || input.rows.length > PASTE_BATCH_MAX_ROWS) {
    return { kind: "rejected", code: "PASTE_BATCH_SIZE_INVALID" };
  }
  if (input.idempotencyKey.trim() === "") {
    return { kind: "rejected", code: "PASTE_BATCH_KEY_INVALID" };
  }
  let response: Response;
  try {
    response = await input.fetchImpl(PASTE_BATCH_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({ rows: input.rows }),
    });
  } catch {
    return { kind: "retry", code: "PASTE_BATCH_NETWORK" };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return classifyPasteBatchResponse(response.status, body, input.rows.length);
}

export type PastePendingGroup = {
  key: string;
  signature: string;
  rows: readonly PasteBatchRowPayload[];
};

/** Mo mot nhom cho: cung du lieu => dung lai key cu; doi du lieu => key moi. */
export function beginPasteGroup(input: {
  keyState: PasteBatchKeyState;
  rows: readonly PasteBatchRowPayload[];
  generate: () => string;
}): { pending: PastePendingGroup; keyState: PasteBatchKeyState; reused: boolean } {
  const signature = pasteBatchSignature(input.rows);
  const resolved = resolvePasteBatchKey(input.keyState, signature, input.generate);
  return {
    pending: { key: resolved.key, signature, rows: input.rows },
    keyState: resolved.state,
    reused: resolved.reused,
  };
}

export type PasteGroupOutcome =
  | {
      status: "saved";
      entryIds: readonly string[];
      submissionId: string;
      submissionVersion: number;
    }
  | { status: "unsaved"; code: string; reloadRequired: boolean; retryable: boolean };

/** Phan bo entry_ids tra ve ve dung thu tu dong input; null khi so luong lech. */
export type PasteEntryAssignment = {
  index: number;
  entryId: string;
  submissionId: string;
  submissionVersion: number;
};

export function assignPasteEntryIds(
  saved: PasteBatchSaved,
  rowCount: number,
): PasteEntryAssignment[] | null {
  if (saved.entryIds.length !== rowCount) return null;
  return saved.entryIds.map((entryId, index) => ({
    index,
    entryId,
    submissionId: saved.submissionId,
    submissionVersion: saved.submissionVersion,
  }));
}

/**
 * Ket qua cua mot lan gui nhom:
 * - saved: chi khi server xac nhan day du => nhom duoc danh dau da luu;
 * - conflict (409): giu nguyen nhom chua luu, khong tu retry, yeu cau reload/reconcile;
 * - retryable: giu nguyen payload + key de thu lai cung intent;
 * - rejected: giu nguyen nhom chua luu, key da dung xong.
 */
export function settlePasteGroup(input: {
  pending: PastePendingGroup;
  result: PasteBatchResult;
  keyState: PasteBatchKeyState;
}): { outcome: PasteGroupOutcome; keyState: PasteBatchKeyState } {
  const intent = "paste_batch:" + input.pending.signature;
  if (input.result.kind === "saved") {
    return {
      outcome: {
        status: "saved",
        entryIds: input.result.entryIds,
        submissionId: input.result.submissionId,
        submissionVersion: input.result.submissionVersion,
      },
      keyState: clearIntentKey(input.keyState, intent),
    };
  }
  const retryable = input.result.kind === "retry";
  return {
    outcome: {
      status: "unsaved",
      code: input.result.code,
      reloadRequired: input.result.kind === "conflict",
      retryable,
    },
    keyState: retryable ? input.keyState : clearIntentKey(input.keyState, intent),
  };
}

export function emptyPasteBatchKeyState(): PasteBatchKeyState {
  return EMPTY_INTENT_KEY;
}

export function pasteBatchErrorMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = Object.freeze({
    PASTE_BATCH_NETWORK: "Không gửi được yêu cầu. Nhóm dòng vẫn chưa được lưu; hãy thử lại.",
    PASTE_BATCH_UNAVAILABLE: "Máy chủ chưa xử lý được. Nhóm dòng vẫn chưa được lưu; hãy thử lại.",
    PASTE_BATCH_RESPONSE_INVALID:
      "Máy chủ trả về kết quả không đọc được. Nhóm dòng vẫn chưa được lưu; hãy thử lại.",
    PASTE_BATCH_CONFLICT: "Dữ liệu đã thay đổi ở nơi khác. Hãy tải lại danh sách rồi dán lại.",
    PASTE_BATCH_REJECTED: "Máy chủ từ chối nhóm dòng. Kiểm tra lại dữ liệu và danh mục.",
    PASTE_BATCH_SIZE_INVALID: "Mỗi lần thêm phải có từ 1 đến 100 dòng.",
    PASTE_BATCH_KEY_INVALID: "Thiếu khóa chống gửi trùng; hãy đóng hộp thoại và thử lại.",
  });
  return messages[code] ?? "Không lưu được nhóm dòng. Nhóm vẫn chưa được lưu.";
}
