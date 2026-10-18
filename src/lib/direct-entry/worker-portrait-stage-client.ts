/**
 * W2S1 - Client boundary cho portrait STAGING khi nhap ho so moi.
 *
 * Dung dung contract da review (migration #113/#114):
 *   POST   /api/direct-entry/worker-portrait-stages            multipart, dung MOT field `file`
 *   DELETE /api/direct-entry/worker-portrait-stages            JSON { stage_id }
 *   POST   /api/direct-entry/worker-portrait-stages/recover     JSON { stage_id }
 *
 * Nguyen tac:
 * - Client KHONG gui actor/auth subject/app user/capability/scope/team; server resolve tu session.
 * - Client KHONG bao gio gui bytes portrait trong payload batch: batch chi mang `portrait_stage_id`.
 * - `stage_id` phai duoc giu toi khi luu xong; retry dung DUNG `Idempotency-Key` cua lan luu truoc.
 * - Chi ket thuc/bo stage bang DELETE khi nguoi dung huy nhap lieu; stage CLAIMED/ATTACHED khong huy duoc.
 *
 * Module thuan: ngoai hai ham `stageWorkerPortrait`/`cancelWorkerPortraitStage`/
 * `recoverWorkerPortraitStage` (fetch tiem vao) khong co I/O.
 */

import { checkWorkerPortraitFile } from "./worker-detail-projection.ts";

export const PORTRAIT_STAGE_ENDPOINT = "/api/direct-entry/worker-portrait-stages";
export const PORTRAIT_STAGE_RECOVER_ENDPOINT =
  "/api/direct-entry/worker-portrait-stages/recover";

export const PORTRAIT_STAGE_STATUSES = ["STAGED", "CLAIMED", "ATTACHED", "CANCELLED"] as const;
export type PortraitStageStatus = (typeof PORTRAIT_STAGE_STATUSES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codeOf(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.code === "string" && body.code.length > 0
    ? body.code
    : fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ stage */

export type PortraitStageStaged = {
  kind: "staged";
  stageId: string;
  mimeType: "image/jpeg" | "image/png";
  sizeBytes: number;
};
/** Loi tam thoi / ket qua khong xac dinh: giu tep de thu lai (stage cu van con neu da tao). */
export type PortraitStageRetry = { kind: "retry"; code: string };
/** 4xx nghiep vu: khong tu dong gui lai. */
export type PortraitStageRejected = { kind: "rejected"; code: string };
export type PortraitStageResult = PortraitStageStaged | PortraitStageRetry | PortraitStageRejected;

/** Projection 201: strict, fail closed khi thua/thieu truong hoac khong phai STAGED. */
export function projectPortraitStage(value: unknown): PortraitStageStaged | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (typeof value.stage_id !== "string" || !UUID.test(value.stage_id)) return null;
  if (value.mime_type !== "image/jpeg" && value.mime_type !== "image/png") return null;
  if (typeof value.size_bytes !== "number" || !Number.isSafeInteger(value.size_bytes) ||
      value.size_bytes < 1) return null;
  if (value.status !== "STAGED") return null;
  return {
    kind: "staged",
    stageId: value.stage_id,
    mimeType: value.mime_type,
    sizeBytes: value.size_bytes,
  };
}

export function classifyPortraitStageResponse(status: number, body: unknown): PortraitStageResult {
  if (status >= 500) return { kind: "retry", code: codeOf(body, "PORTRAIT_STAGE_UNAVAILABLE") };
  if (status >= 200 && status < 300) {
    // 2xx nhung projection khong doc duoc: ket qua khong xac dinh => thu lai.
    return projectPortraitStage(body) ?? { kind: "retry", code: "PORTRAIT_STAGE_RESPONSE_INVALID" };
  }
  return { kind: "rejected", code: codeOf(body, "PORTRAIT_STAGE_REJECTED") };
}

export type PortraitStageFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Tao stage cho MOT tep anh. Kiem tra tep tai client truoc (rong/sai MIME/vuot dung luong);
 * server van la authority cuoi cung. Body multipart chi co dung mot field `file`.
 */
export async function stageWorkerPortrait(input: {
  file: File;
  fetchImpl: PortraitStageFetch;
}): Promise<PortraitStageResult> {
  const check = checkWorkerPortraitFile(input.file);
  if (!check.ok) return { kind: "rejected", code: check.code };
  const form = new FormData();
  form.append("file", input.file, "portrait");
  const callFetch = input.fetchImpl;
  let response: Response;
  try {
    response = await callFetch(PORTRAIT_STAGE_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
  } catch {
    return { kind: "retry", code: "PORTRAIT_STAGE_NETWORK" };
  }
  return classifyPortraitStageResponse(response.status, await readJson(response));
}

/* ----------------------------------------------------------------- cancel */

export type PortraitStageCancelResult =
  | { kind: "cancelled" }
  | { kind: "not-cancellable"; code: string }
  | { kind: "retry"; code: string }
  | { kind: "rejected"; code: string };

export function classifyPortraitStageCancelResponse(
  status: number,
  body: unknown,
): PortraitStageCancelResult {
  if (status === 204) return { kind: "cancelled" };
  // 404 (khong phai chu stage) va 409 (dang CLAIMED/ATTACHED) => khong huy duoc, khong retry.
  if (status === 404 || status === 409) {
    return { kind: "not-cancellable", code: codeOf(body, status === 404 ? "ENTRY_NOT_FOUND" : "DOCUMENT_VERSION_CONFLICT") };
  }
  if (status >= 500) return { kind: "retry", code: codeOf(body, "PORTRAIT_STAGE_UNAVAILABLE") };
  if (status >= 200 && status < 300) return { kind: "cancelled" };
  return { kind: "rejected", code: codeOf(body, "PORTRAIT_STAGE_REJECTED") };
}

/** Huy stage dang STAGED cua chinh actor. Body JSON chi co `stage_id`. */
export async function cancelWorkerPortraitStage(input: {
  stageId: string;
  fetchImpl: PortraitStageFetch;
}): Promise<PortraitStageCancelResult> {
  if (!UUID.test(input.stageId)) return { kind: "rejected", code: "PORTRAIT_STAGE_ID_INVALID" };
  const callFetch = input.fetchImpl;
  let response: Response;
  try {
    response = await callFetch(PORTRAIT_STAGE_ENDPOINT, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage_id: input.stageId }),
    });
  } catch {
    return { kind: "retry", code: "PORTRAIT_STAGE_NETWORK" };
  }
  return classifyPortraitStageCancelResponse(response.status, await readJson(response));
}

/* ---------------------------------------------------------------- recover */

export type PortraitStageRecovery = {
  stageId: string;
  status: PortraitStageStatus;
  /** Chi khac null khi status CLAIMED: key cua lan luu da commit, retry dung key nay. */
  idempotencyKey: string | null;
};

export type PortraitStageRecoverResult =
  | { kind: "recovered"; recovery: PortraitStageRecovery }
  | { kind: "retry"; code: string };

export function projectPortraitStageRecovery(value: unknown): PortraitStageRecovery | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (typeof value.stage_id !== "string" || !UUID.test(value.stage_id)) return null;
  if (typeof value.status !== "string" ||
      !(PORTRAIT_STAGE_STATUSES as readonly string[]).includes(value.status)) return null;
  if (value.idempotency_key !== null &&
      (typeof value.idempotency_key !== "string" || !UUID.test(value.idempotency_key))) return null;
  if (value.status !== "CLAIMED" && value.idempotency_key !== null) return null;
  if (value.status === "CLAIMED" && value.idempotency_key === null) return null;
  return {
    stageId: value.stage_id,
    status: value.status as PortraitStageStatus,
    idempotencyKey: value.idempotency_key as string | null,
  };
}

/** Hoi DB trang thai that cua stage khi ket qua lan luu truoc khong xac dinh. */
export async function recoverWorkerPortraitStage(input: {
  stageId: string;
  fetchImpl: PortraitStageFetch;
}): Promise<PortraitStageRecoverResult> {
  if (!UUID.test(input.stageId)) return { kind: "retry", code: "PORTRAIT_STAGE_ID_INVALID" };
  const callFetch = input.fetchImpl;
  let response: Response;
  try {
    response = await callFetch(PORTRAIT_STAGE_RECOVER_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage_id: input.stageId }),
    });
  } catch {
    return { kind: "retry", code: "PORTRAIT_STAGE_NETWORK" };
  }
  const body = await readJson(response);
  if (response.status === 404 || response.status === 409 || response.status >= 500) {
    return { kind: "retry", code: codeOf(body, "PORTRAIT_STAGE_UNAVAILABLE") };
  }
  const recovery = response.ok ? projectPortraitStageRecovery(body) : null;
  if (recovery === null) return { kind: "retry", code: "PORTRAIT_STAGE_RESPONSE_INVALID" };
  return { kind: "recovered", recovery };
}

/* ------------------------------------------------------- trang thai UI */

/**
 * Trang thai PROMOTE cua anh sau mot lan gui batch, suy ra tu recovery (khong doan):
 * - ATTACHED  => anh da gan vao entry, hoan tat;
 * - CLAIMED   => DB da commit ket qua batch va dang giu claim: HO SO DA LUU nhung promote
 *                chua xong; retry dung dung idempotency key da tra ve;
 * - STAGED    => lan luu truoc khong commit; stage co the claim lai;
 * - CANCELLED => stage da bi huy, khong con anh.
 */
export type PortraitPromotionState = "attached" | "pending" | "unsaved" | "cancelled";

export function portraitPromotionState(recovery: PortraitStageRecovery): PortraitPromotionState {
  if (recovery.status === "ATTACHED") return "attached";
  if (recovery.status === "CLAIMED") return "pending";
  if (recovery.status === "CANCELLED") return "cancelled";
  return "unsaved";
}

export const PORTRAIT_PROMOTION_PENDING_MESSAGE =
  "Hồ sơ đã được lưu nhưng ảnh hồ sơ chưa hoàn tất trên máy chủ. Bấm Thử lại với cùng yêu cầu " +
  "để máy chủ hoàn tất ảnh; không chọn lại ảnh khác cho dòng này.";
export const PORTRAIT_PROMOTION_UNSAVED_MESSAGE =
  "Chưa xác định được kết quả lưu. Ảnh vẫn đang ở bản nháp trên máy chủ; hãy thử lại.";
export const PORTRAIT_STAGE_ORPHAN_MESSAGE =
  "Ảnh chưa được gắn vào hồ sơ và đã được dọn khỏi bản nháp trên máy chủ.";

const STAGE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  PORTRAIT_STAGE_NETWORK: "Không gửi được ảnh. Ảnh chưa được lưu; hãy thử lại.",
  PORTRAIT_STAGE_UNAVAILABLE: "Máy chủ chưa nhận được ảnh. Hãy thử lại.",
  PORTRAIT_STAGE_RESPONSE_INVALID: "Máy chủ trả về kết quả không đọc được. Hãy thử lại.",
  PORTRAIT_STAGE_REJECTED: "Máy chủ từ chối ảnh này.",
  PORTRAIT_STAGE_ID_INVALID: "Mã ảnh tạm không hợp lệ.",
  DOCUMENT_FILE_REQUIRED: "Hãy chọn một tệp ảnh trước khi tải lên.",
  DOCUMENT_SIZE_INVALID: "Ảnh phải lớn hơn 0 và không vượt quá 10 MiB.",
  DOCUMENT_MIME_INVALID: "Chỉ chấp nhận ảnh JPEG hoặc PNG.",
  DOCUMENT_CONTENT_INVALID: "Nội dung tệp không khớp định dạng ảnh đã chọn.",
  DOCUMENT_DENIED: "Bạn không có quyền tải ảnh hồ sơ.",
  DOCUMENT_REQUEST_INVALID: "Yêu cầu tải ảnh không hợp lệ.",
  ENTRY_NOT_FOUND: "Không tìm thấy ảnh tạm này trong phạm vi của bạn.",
  DOCUMENT_VERSION_CONFLICT: "Ảnh đang được xử lý hoặc đã gắn vào hồ sơ nên không hủy được.",
  NOT_FOUND: "Tính năng ảnh hồ sơ chưa được bật trên môi trường này.",
  CSRF_REJECTED: "Yêu cầu không cùng nguồn. Hãy tải lại trang rồi thử lại.",
  UNAUTHENTICATED: "Phiên làm việc đã hết hiệu lực. Vui lòng đăng nhập lại.",
  ACTOR_NOT_AVAILABLE: "Không xác định được người dùng hiện tại. Vui lòng đăng nhập lại.",
});

export function portraitStageErrorMessage(code: string): string {
  return STAGE_MESSAGES[code] ?? "Không xử lý được ảnh hồ sơ. Hãy thử lại.";
}

/* ------------------------------------------------- ràng buộc stage ↔ dòng */

/**
 * `sourceRow` la VI TRI trong bang dan, khong phai danh tinh: khi nguoi dung sua noi dung,
 * thay dong hoac sap xep lai, vi tri co the tro sang NLD khac. Vi vay stage phai duoc rang
 * buoc bang (sourceRow + chu ky noi dung dong) chu khong chi bang sourceRow.
 *
 * Chu ky chi giu dang bam dong bo (khong giu ban sao PII cua dong cu trong memory) va KHONG
 * bao gio duoc gui len server.
 */
export type PortraitRowIdentity = {
  sourceRow: number;
  employeeCode: string;
  displayName: string;
  firstWorkDate: string;
  projectId: string | null;
  recruiterId: string | null;
  laborType: string;
  nationalId: string;
  dateOfBirth: string;
  phone: string;
};

/** Bam dong bo hai chieu (32+32 bit) chi de so sanh trong memory, khong dung cho bao mat. */
function syncBindingHash(payload: string): string {
  let left = 0x811c9dc5;
  let right = 0x1000193;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return left.toString(16).padStart(8, "0") + right.toString(16).padStart(8, "0");
}

export function portraitRowBinding(identity: PortraitRowIdentity): string {
  const payload = [
    String(identity.sourceRow),
    identity.employeeCode,
    identity.displayName,
    identity.firstWorkDate,
    identity.projectId ?? "-",
    identity.recruiterId ?? "-",
    identity.laborType,
    identity.nationalId,
    identity.dateOfBirth,
    identity.phone,
  ].join("\u001f");
  return identity.sourceRow + "#" + syncBindingHash(payload);
}

export type PortraitStageBindingSlot = {
  binding: string;
  status: "staging" | "staged" | "error" | "stale";
  stageId: string | null;
};

/**
 * Chi nhung dong CO binding khop CHINH XAC voi noi dung hien tai moi duoc mang `portrait_stage_id`.
 * Dong bi sua/thay/sap xep lai => binding lech => stage cu khong bao gio duoc gui cho ho so khac.
 */
export function selectBindablePortraitStages(input: {
  rowBindings: ReadonlyMap<number, string>;
  slots: ReadonlyMap<number, PortraitStageBindingSlot>;
}): Map<number, string> {
  const bindable = new Map<number, string>();
  for (const [sourceRow, slot] of input.slots) {
    if (slot.status !== "staged" || slot.stageId === null) continue;
    if (input.rowBindings.get(sourceRow) !== slot.binding) continue;
    bindable.set(sourceRow, slot.stageId);
  }
  return bindable;
}

/**
 * Stage DA TAO (co `stageId`) nhung binding khong con khop dong nao => phai huy/don.
 * Bao gom ca slot da bi vo hieu hoa (`stale`) de con thu don lai; KHONG bao gom slot dang chay
 * (chua co id) va KHONG bao gom stage dang con khop (dang dung de gui).
 */
export function selectStalePortraitStages(input: {
  rowBindings: ReadonlyMap<number, string>;
  slots: ReadonlyMap<number, PortraitStageBindingSlot>;
}): { sourceRow: number; stageId: string }[] {
  const stale: { sourceRow: number; stageId: string }[] = [];
  for (const [sourceRow, slot] of input.slots) {
    if (slot.stageId === null) continue;
    if (input.rowBindings.get(sourceRow) === slot.binding) continue;
    stale.push({ sourceRow, stageId: slot.stageId });
  }
  return stale;
}

/* ---------------------------------------------- vòng đời stage (reducer thuần) */

/**
 * Binding "da vo hieu hoa": gan vao moi slot bi vo hieu hoa (doi du lieu / dong hop thoai) nen
 * stage do KHONG BAO GIO khop lai voi bat ky dong nao (ke ca khi nguoi dung dan lai dung du lieu cu).
 */
export const INVALIDATED_PORTRAIT_BINDING = "__invalidated__";

export type PortraitStageSlot =
  | { status: "staging"; binding: string; requestId: string; stageId: null }
  | { status: "staged"; binding: string; requestId: string; stageId: string; sizeBytes: number }
  | { status: "error"; binding: string; requestId: string; stageId: null; code: string }
  | {
      status: "stale";
      binding: typeof INVALIDATED_PORTRAIT_BINDING;
      requestId: string;
      stageId: string;
      sizeBytes: number;
    };

/**
 * Stage ma SERVER DA TAO nhung ket qua tra ve khong con thuoc slot nao dang hoat dong (response cu
 * den muon). Giu rieng de huy; KHONG BAO GIO ghi vao slot hien tai (neu khong se de mat stage moi).
 */
export type PortraitStageOrphan = { stageId: string; sizeBytes: number };

export type PortraitStageLifecycle = {
  epoch: number;
  slots: ReadonlyMap<number, PortraitStageSlot>;
  orphans: readonly PortraitStageOrphan[];
};

export const EMPTY_PORTRAIT_STAGE_LIFECYCLE: PortraitStageLifecycle = Object.freeze({
  epoch: 0,
  slots: new Map<number, PortraitStageSlot>(),
  orphans: [],
});

export type PortraitStageAction =
  /** `requestId` duy nhat cho MOI lan stage => response cu khong the ghi de upload moi. */
  | { kind: "stage-start"; sourceRow: number; binding: string; requestId: string }
  | {
      kind: "stage-result";
      sourceRow: number;
      requestId: string;
      result: { kind: "staged"; stageId: string; sizeBytes: number } | { kind: "error"; code: string };
    }
  | { kind: "invalidate" }
  | { kind: "cancel-result"; sourceRow: number; stageId: string; confirmed: boolean }
  | { kind: "orphan-cancel-result"; stageId: string; confirmed: boolean };

/** Stage mo coi dang cho don. */
export function selectOrphanPortraitStages(
  state: PortraitStageLifecycle,
): readonly PortraitStageOrphan[] {
  return state.orphans;
}

function addOrphan(
  orphans: readonly PortraitStageOrphan[],
  orphan: PortraitStageOrphan,
): PortraitStageOrphan[] {
  if (orphans.some((current) => current.stageId === orphan.stageId)) return orphans as PortraitStageOrphan[];
  return [...orphans, orphan];
}

export function reducePortraitStageLifecycle(
  state: PortraitStageLifecycle,
  action: PortraitStageAction,
): PortraitStageLifecycle {
  const slots = new Map(state.slots);
  if (action.kind === "stage-start") {
    slots.set(action.sourceRow, {
      status: "staging",
      binding: action.binding,
      requestId: action.requestId,
      stageId: null,
    });
    return { epoch: state.epoch, slots, orphans: state.orphans };
  }
  if (action.kind === "invalidate") {
    // Doi du lieu / dong hop thoai: vo hieu hoa binding NGAY. Slot da co stageId chuyen sang
    // "stale" va VAN GIU ID de don; slot dang chay bi bo khoi state => response cua no ve sau
    // se khong khop requestId nao nua (xem nhanh stage-result) va duoc dua vao danh sach don.
    for (const [sourceRow, slot] of state.slots) {
      if (slot.stageId === null) {
        slots.delete(sourceRow);
        continue;
      }
      slots.set(sourceRow, {
        status: "stale",
        binding: INVALIDATED_PORTRAIT_BINDING,
        requestId: slot.requestId,
        stageId: slot.stageId,
        sizeBytes: slot.status === "staged" ? slot.sizeBytes : 0,
      });
    }
    return { epoch: state.epoch + 1, slots, orphans: state.orphans };
  }
  if (action.kind === "cancel-result") {
    const current = slots.get(action.sourceRow);
    if (current === undefined || current.stageId !== action.stageId) return state;
    if (action.confirmed) {
      // Chi xoa ID khoi state khi DA xac nhan huy hoac da xac dinh trang thai cuoi (khong huy duoc).
      slots.delete(action.sourceRow);
      return { epoch: state.epoch, slots, orphans: state.orphans };
    }
    // Loi retry/khong xac dinh: GIU ID, giu trang thai de thu don lai, khong bao gio bindable.
    slots.set(action.sourceRow, {
      status: "stale",
      binding: INVALIDATED_PORTRAIT_BINDING,
      requestId: current.requestId,
      stageId: action.stageId,
      sizeBytes: current.status === "staged" || current.status === "stale" ? current.sizeBytes : 0,
    });
    return { epoch: state.epoch, slots, orphans: state.orphans };
  }
  if (action.kind === "orphan-cancel-result") {
    if (!action.confirmed) return state; // giu lai de thu don lai
    return {
      epoch: state.epoch,
      slots,
      orphans: state.orphans.filter((orphan) => orphan.stageId !== action.stageId),
    };
  }
  // stage-result: CHI cap nhat slot dang hoat dong DUNG requestId (khong chi sourceRow/binding).
  const current = slots.get(action.sourceRow);
  const active = current !== undefined && current.status === "staging" &&
    current.requestId === action.requestId;
  if (!active) {
    if (action.result.kind !== "staged") return state;
    // Response cu nhung server DA tao stage: dua vao danh sach don, KHONG dung vao slot hien tai.
    return {
      epoch: state.epoch,
      slots,
      orphans: addOrphan(state.orphans, {
        stageId: action.result.stageId,
        sizeBytes: action.result.sizeBytes,
      }),
    };
  }
  if (action.result.kind === "error") {
    slots.set(action.sourceRow, {
      status: "error",
      binding: current.binding,
      requestId: current.requestId,
      stageId: null,
      code: action.result.code,
    });
    return { epoch: state.epoch, slots, orphans: state.orphans };
  }
  slots.set(action.sourceRow, {
    status: "staged",
    binding: current.binding,
    requestId: current.requestId,
    stageId: action.result.stageId,
    sizeBytes: action.result.sizeBytes,
  });
  return { epoch: state.epoch, slots, orphans: state.orphans };
}
