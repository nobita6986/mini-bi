/**
 * W2S1 - Client boundary cho portrait STAGING khi nhap ho so moi.
 *
 * Dung dung contract da review (migration #113–#115):
 *   POST   /api/direct-entry/worker-portrait-stages            multipart `file` + Idempotency-Key
 *   DELETE /api/direct-entry/worker-portrait-stages            JSON { stage_id }
 *   POST   /api/direct-entry/worker-portrait-stages/recover     JSON { stage_id }
 *
 * Nguyen tac:
 * - Client KHONG gui actor/auth subject/app user/capability/scope/team; server resolve tu session.
 * - Client KHONG bao gio gui bytes portrait trong payload batch: batch chi mang `portrait_stage_id`.
 * - Retry POST stage cho cùng một lần chọn ảnh dùng lại đúng `Idempotency-Key` đó.
 * - `stage_id` phai duoc giu toi khi luu xong; retry batch dùng key riêng của lần lưu trước.
 * - Chi ket thuc/bo stage bang DELETE khi nguoi dung huy nhap lieu; stage CLAIMED/ATTACHED khong huy duoc.
 *
 * Module thuan: ngoai hai ham `stageWorkerPortrait`/`cancelWorkerPortraitStage`/
 * `recoverWorkerPortraitStage` (fetch tiem vao) khong co I/O.
 */

import { checkWorkerPortraitFile } from "./worker-detail-projection.ts";
import { DOCUMENT_MAX_BYTES_HARD_LIMIT } from "../contracts/direct-entry-v1.ts";

export const PORTRAIT_STAGE_ENDPOINT = "/api/direct-entry/worker-portrait-stages";
export const PORTRAIT_STAGE_RECOVER_ENDPOINT =
  "/api/direct-entry/worker-portrait-stages/recover";

export const WORKER_STAGE_DOCUMENT_TYPES = [
  "WORKER_PORTRAIT", "CCCD_FRONT", "CCCD_BACK", "EMPLOYMENT_CONTRACT",
] as const;
export type WorkerStageDocumentType = (typeof WORKER_STAGE_DOCUMENT_TYPES)[number];

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
  documentType: WorkerStageDocumentType;
  mimeType: "image/jpeg" | "image/png" | "application/pdf";
  sizeBytes: number;
};
/** Loi tam thoi / ket qua khong xac dinh: giu tep de thu lai (stage cu van con neu da tao). */
export type PortraitStageRetry = { kind: "retry"; code: string };
/** 4xx nghiep vu: khong tu dong gui lai. */
export type PortraitStageRejected = { kind: "rejected"; code: string };
export type PortraitStageResult = PortraitStageStaged | PortraitStageRetry | PortraitStageRejected;

/** Projection 201: strict, fail closed khi thua/thieu truong hoac khong phai STAGED. */
export function projectPortraitStage(
  value: unknown,
  expectedDocumentType: WorkerStageDocumentType = "WORKER_PORTRAIT",
): PortraitStageStaged | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (typeof value.stage_id !== "string" || !UUID.test(value.stage_id)) return null;
  if (value.document_type !== expectedDocumentType) return null;
  if (value.mime_type !== "image/jpeg" && value.mime_type !== "image/png" &&
      value.mime_type !== "application/pdf") return null;
  if (expectedDocumentType === "WORKER_PORTRAIT" && value.mime_type === "application/pdf") return null;
  if (typeof value.size_bytes !== "number" || !Number.isSafeInteger(value.size_bytes) ||
      value.size_bytes < 1) return null;
  if (value.status !== "STAGED") return null;
  return {
    kind: "staged",
    stageId: value.stage_id,
    documentType: expectedDocumentType,
    mimeType: value.mime_type,
    sizeBytes: value.size_bytes,
  };
}

export function classifyPortraitStageResponse(
  status: number,
  body: unknown,
  expectedDocumentType: WorkerStageDocumentType = "WORKER_PORTRAIT",
): PortraitStageResult {
  if (status >= 500) return { kind: "retry", code: codeOf(body, "PORTRAIT_STAGE_UNAVAILABLE") };
  if (status >= 200 && status < 300) {
    // 2xx nhung projection khong doc duoc: ket qua khong xac dinh => thu lai.
    return projectPortraitStage(body, expectedDocumentType) ??
      { kind: "retry", code: "PORTRAIT_STAGE_RESPONSE_INVALID" };
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
  idempotencyKey: string;
  fetchImpl: PortraitStageFetch;
}): Promise<PortraitStageResult> {
  return stageWorkerDocument({ ...input, documentType: "WORKER_PORTRAIT" });
}

export async function stageWorkerDocument(input: {
  file: File;
  documentType: WorkerStageDocumentType;
  idempotencyKey: string;
  fetchImpl: PortraitStageFetch;
}): Promise<PortraitStageResult> {
  if (!UUID.test(input.idempotencyKey)) {
    return { kind: "rejected", code: "IDEMPOTENCY_KEY_INVALID" };
  }
  if (input.documentType === "WORKER_PORTRAIT") {
    const check = checkWorkerPortraitFile(input.file);
    if (!check.ok) return { kind: "rejected", code: check.code };
  } else if (input.file.size < 1 || input.file.size > DOCUMENT_MAX_BYTES_HARD_LIMIT) {
    return { kind: "rejected", code: "DOCUMENT_SIZE_INVALID" };
  } else if (!(["image/jpeg", "image/png", "application/pdf"] as string[]).includes(input.file.type)) {
    return { kind: "rejected", code: "DOCUMENT_MIME_INVALID" };
  }
  const form = new FormData();
  form.append("file", input.file, "worker-document");
  form.append("document_type", input.documentType);
  const callFetch = input.fetchImpl;
  let response: Response;
  try {
    response = await callFetch(PORTRAIT_STAGE_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: form,
    });
  } catch {
    return { kind: "retry", code: "PORTRAIT_STAGE_NETWORK" };
  }
  return classifyPortraitStageResponse(response.status, await readJson(response), input.documentType);
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
  "Hồ sơ đã được lưu nhưng ảnh NLĐ chưa hoàn tất trên máy chủ. Bấm Thử lại với cùng yêu cầu " +
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
  DOCUMENT_DENIED: "Bạn không có quyền tải ảnh NLĐ.",
  DOCUMENT_REQUEST_INVALID: "Yêu cầu tải ảnh không hợp lệ.",
  ENTRY_NOT_FOUND: "Không tìm thấy ảnh tạm này trong phạm vi của bạn.",
  DOCUMENT_VERSION_CONFLICT: "Ảnh đang được xử lý hoặc đã gắn vào hồ sơ nên không hủy được.",
  NOT_FOUND: "Tính năng ảnh NLĐ chưa được bật trên môi trường này.",
  CSRF_REJECTED: "Yêu cầu không cùng nguồn. Hãy tải lại trang rồi thử lại.",
  UNAUTHENTICATED: "Phiên làm việc đã hết hiệu lực. Vui lòng đăng nhập lại.",
  ACTOR_NOT_AVAILABLE: "Không xác định được người dùng hiện tại. Vui lòng đăng nhập lại.",
});

export function portraitStageErrorMessage(code: string): string {
  return STAGE_MESSAGES[code] ?? "Không xử lý được ảnh NLĐ. Hãy thử lại.";
}

/* ------------------------------------------------- ràng buộc stage ↔ dòng */

/**
 * `rowKey` la khoa dong do UI cap (vi tri dong khi dan Excel, hoac `clientRowId` o bang nhap
 * truc tiep) — khong phai danh tinh on dinh. Vi vay stage phai rang buoc bang
 * (rowKey + chu ky noi dung dong) chu khong chi bang rowKey.
 *
 * Chu ky chi giu dang bam dong bo (khong giu ban sao PII cua dong cu trong memory) va KHONG
 * bao gio duoc gui len server.
 */
export type PortraitRowIdentity = {
  rowKey: string;
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
    identity.rowKey,
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
  return identity.rowKey + "#" + syncBindingHash(payload);
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
  rowBindings: ReadonlyMap<string, string>;
  slots: ReadonlyMap<string, PortraitStageBindingSlot>;
}): Map<string, string> {
  const bindable = new Map<string, string>();
  for (const [rowKey, slot] of input.slots) {
    if (slot.status !== "staged" || slot.stageId === null) continue;
    if (input.rowBindings.get(rowKey) !== slot.binding) continue;
    bindable.set(rowKey, slot.stageId);
  }
  return bindable;
}

/**
 * Stage DA TAO (co `stageId`) nhung binding khong con khop dong nao => phai huy/don.
 * Bao gom ca slot da bi vo hieu hoa (`stale`) de con thu don lai; KHONG bao gom slot dang chay
 * (chua co id) va KHONG bao gom stage dang con khop (dang dung de gui).
 */
export function selectStalePortraitStages(input: {
  rowBindings: ReadonlyMap<string, string>;
  slots: ReadonlyMap<string, PortraitStageBindingSlot>;
}): { rowKey: string; stageId: string }[] {
  const stale: { rowKey: string; stageId: string }[] = [];
  for (const [rowKey, slot] of input.slots) {
    if (slot.stageId === null) continue;
    if (input.rowBindings.get(rowKey) === slot.binding) continue;
    stale.push({ rowKey, stageId: slot.stageId });
  }
  return stale;
}

/* ------------------------------------- glue cho luong nhap truc tiep (live) */

/** Du lieu toi thieu cua mot dong preview (bang nhap / quick-add) de tinh binding. */
export type PortraitLiveRowSource = {
  sourceRow: number;
  row: {
    employee_code: string;
    display_name: string;
    first_work_date: string;
    labor_type: string;
    worker: {
      national_id: { state: string; value?: string };
      date_of_birth: { state: string; value?: string };
      phone: { state: string; value?: string };
    };
  };
  resolved: { project_id: string | null; recruiter_id: string | null };
};

function rawOptional(value: { state: string; value?: string }): string {
  return value.state === "provided" && typeof value.value === "string"
    ? value.value
    : value.state;
}

/**
 * Binding cho tung dong cua bang nhap truc tiep. Khoa on dinh la `clientRowId` (khong phai vi
 * tri dong), nen sua/xoa/di chuyen dong deu lam binding lech va stage cu khong bi gan nham.
 */
export function buildPortraitRowBindings(input: {
  rows: readonly { clientRowId: string }[];
  previewRows: readonly PortraitLiveRowSource[];
}): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const [index, row] of input.rows.entries()) {
    const preview = input.previewRows[index];
    if (preview === undefined) continue;
    bindings.set(row.clientRowId, portraitRowBinding({
      rowKey: row.clientRowId,
      employeeCode: preview.row.employee_code,
      displayName: preview.row.display_name,
      firstWorkDate: preview.row.first_work_date,
      projectId: preview.resolved.project_id,
      recruiterId: preview.resolved.recruiter_id,
      laborType: preview.row.labor_type,
      nationalId: rawOptional(preview.row.worker.national_id),
      dateOfBirth: rawOptional(preview.row.worker.date_of_birth),
      phone: rawOptional(preview.row.worker.phone),
    }));
  }
  return bindings;
}

/** Doi `bindableStageIds` (theo clientRowId) sang `Map<sourceRow, stage_id>` cho payload batch. */
export function buildPortraitStageIdsBySourceRow(input: {
  bindableStageIds: ReadonlyMap<string, string>;
  rows: readonly { clientRowId: string }[];
  previewRows: readonly { sourceRow: number }[];
}): Map<number, string> {
  const stageIds = new Map<number, string>();
  for (const [index, row] of input.rows.entries()) {
    const stageId = input.bindableStageIds.get(row.clientRowId);
    const preview = input.previewRows[index];
    if (stageId === undefined || preview === undefined) continue;
    stageIds.set(preview.sourceRow, stageId);
  }
  return stageIds;
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
  slots: ReadonlyMap<string, PortraitStageSlot>;
  orphans: readonly PortraitStageOrphan[];
};

export const EMPTY_PORTRAIT_STAGE_LIFECYCLE: PortraitStageLifecycle = Object.freeze({
  epoch: 0,
  slots: new Map<string, PortraitStageSlot>(),
  orphans: [],
});

export type PortraitStageAction =
  /** `requestId` duy nhat cho MOI lan stage => response cu khong the ghi de upload moi. */
  | { kind: "stage-start"; rowKey: string; binding: string; requestId: string }
  | {
      kind: "stage-result";
      rowKey: string;
      requestId: string;
      result: { kind: "staged"; stageId: string; sizeBytes: number } | { kind: "error"; code: string };
    }
  | { kind: "invalidate" }
  | { kind: "cancel-result"; rowKey: string; stageId: string; confirmed: boolean }
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
    const previous = slots.get(action.rowKey);
    slots.set(action.rowKey, {
      status: "staging",
      binding: action.binding,
      requestId: action.requestId,
      stageId: null,
    });
    const orphans = previous?.stageId
      ? addOrphan(state.orphans, {
        stageId: previous.stageId,
        sizeBytes: previous.status === "staged" || previous.status === "stale" ? previous.sizeBytes : 0,
      })
      : state.orphans;
    return { epoch: state.epoch, slots, orphans };
  }
  if (action.kind === "invalidate") {
    // Doi du lieu / dong hop thoai: vo hieu hoa binding NGAY. Slot da co stageId chuyen sang
    // "stale" va VAN GIU ID de don; slot dang chay bi bo khoi state => response cua no ve sau
    // se khong khop requestId nao nua (xem nhanh stage-result) va duoc dua vao danh sach don.
    for (const [rowKey, slot] of state.slots) {
      if (slot.stageId === null) {
        slots.delete(rowKey);
        continue;
      }
      slots.set(rowKey, {
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
    const current = slots.get(action.rowKey);
    if (current === undefined || current.stageId !== action.stageId) return state;
    if (action.confirmed) {
      // Chi xoa ID khoi state khi DA xac nhan huy hoac da xac dinh trang thai cuoi (khong huy duoc).
      slots.delete(action.rowKey);
      return { epoch: state.epoch, slots, orphans: state.orphans };
    }
    // Loi retry/khong xac dinh: GIU ID, giu trang thai de thu don lai, khong bao gio bindable.
    slots.set(action.rowKey, {
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
  // stage-result: CHI cap nhat slot dang hoat dong DUNG requestId (khong chi rowKey/binding).
  const current = slots.get(action.rowKey);
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
    slots.set(action.rowKey, {
      status: "error",
      binding: current.binding,
      requestId: current.requestId,
      stageId: null,
      code: action.result.code,
    });
    return { epoch: state.epoch, slots, orphans: state.orphans };
  }
  slots.set(action.rowKey, {
    status: "staged",
    binding: current.binding,
    requestId: current.requestId,
    stageId: action.result.stageId,
    sizeBytes: action.result.sizeBytes,
  });
  return { epoch: state.epoch, slots, orphans: state.orphans };
}
