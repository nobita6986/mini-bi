/**
 * P1.6-I04C3-R3B - Client boundary cho atomic full-profile batch.
 *
 * Khong I/O ngoai mot ham `postFullProfileBatch` duy nhat (fetch duoc tiem vao). Khong dinh nghia
 * lai contract: hang so/limit duoc IMPORT tu `full-profile-contract.ts` cua server de tranh drift.
 *
 * Endpoint: POST /api/direct-entry/batches/full-profile
 * Request : { contract_version: "worker-profile/1.0", rows: FullProfileRpcRow[] }
 * Header  : Content-Type: application/json, Idempotency-Key: <UUID>
 * Success : 201 (hoac 200 khi replay) { ok, submission_id, state: "DRAFT", version, entry_ids[] }
 * Error   : { ok: false, code } voi status 400/401/403/404/409/413/500
 *
 * Khong gui actor/role/capability/scope/auth subject/app user: server tu resolve tu session.
 * Khong gui display label thay cho stable ID; khong gui team/provider (server tu resolve - D6).
 * Khong dua bytes/base64 cua CCCD vao JSON batch.
 */
import {
  FULL_PROFILE_MAX_BODY_BYTES,
  FULL_PROFILE_MAX_ROWS,
  WORKER_PROFILE_CONTRACT_VERSION,
} from "./full-profile-contract.ts";
import type { WorkerProfileOptional } from "./worker-profile-paste.ts";
import type {
  WorkerProfilePreview,
  WorkerProfilePreviewRow,
} from "./worker-profile-preview.ts";

export const FULL_PROFILE_BATCH_ENDPOINT = "/api/direct-entry/batches/full-profile";

export type FullProfileOptionalText =
  | { state: "omitted" }
  | { state: "provided"; value: string };

export type FullProfilePayment = {
  state: "provided";
  account_number: string;
  bank_id: string;
  account_holder_name: string;
};

export type FullProfileEmployment =
  | { initial_status: "UNCONFIRMED" | "ON" }
  | { initial_status: "OFF"; leave_date: string; leave_reason_text: string };

export type FullProfileRequestRow = {
  project_id: string;
  first_work_date: string;
  employee_code: string;
  recruiter_id: string;
  labor_type: "TEMPORARY" | "PERMANENT";
  display_name: string;
  worker: {
    gender: FullProfileOptionalText;
    date_of_birth: FullProfileOptionalText;
    national_id: FullProfileOptionalText;
    national_id_issued_at: FullProfileOptionalText;
    national_id_issued_place: FullProfileOptionalText;
    address: FullProfileOptionalText;
    phone: FullProfileOptionalText;
  };
  general_note: FullProfileOptionalText;
  payment: FullProfilePayment | null;
  employment: FullProfileEmployment | null;
};

export type FullProfileRequestBody = {
  contract_version: typeof WORKER_PROFILE_CONTRACT_VERSION;
  rows: readonly FullProfileRequestRow[];
};

function optionalText<T extends string>(value: WorkerProfileOptional<T>):
  FullProfileOptionalText {
  return value.state === "provided"
    ? { state: "provided", value: value.value }
    : { state: "omitted" };
}

/**
 * Chieu mot dong preview da resolve sang request row.
 * Tra null khi catalog bat buoc chua resolve (fail closed, khong doan).
 */
export function buildFullProfileRow(row: WorkerProfilePreviewRow): FullProfileRequestRow | null {
  const { row: profile } = row;
  if (row.resolved.project_id === null || row.resolved.recruiter_id === null) return null;

  let payment: FullProfilePayment | null = null;
  const account = profile.payment.account_number;
  const bank = profile.payment.bank_label;
  const holder = profile.payment.account_holder_name;
  if (account.state === "provided" || bank.state === "provided" || holder.state === "provided") {
    // R3A da bao dam all-three-or-none; o day chi nhan khi bank da resolve sang stable ID.
    if (account.state !== "provided" || holder.state !== "provided" ||
        row.resolved.bank_id === null) {
      return null;
    }
    payment = {
      state: "provided",
      account_number: account.value,
      bank_id: row.resolved.bank_id,
      account_holder_name: holder.value,
    };
  }

  let employment: FullProfileEmployment | null = null;
  const status = profile.employment.initial_status;
  if (status.state === "provided") {
    if (status.value === "OFF") {
      const leaveDate = profile.employment.leave_date;
      const leaveReason = profile.employment.leave_reason_text;
      if (leaveDate.state !== "provided" || leaveReason.state !== "provided") return null;
      employment = {
        initial_status: "OFF",
        leave_date: leaveDate.value,
        leave_reason_text: leaveReason.value,
      };
    } else {
      employment = { initial_status: status.value };
    }
  }

  return {
    project_id: row.resolved.project_id,
    first_work_date: profile.first_work_date,
    employee_code: profile.employee_code,
    recruiter_id: row.resolved.recruiter_id,
    labor_type: profile.labor_type,
    display_name: profile.display_name,
    worker: {
      gender: optionalText(profile.worker.gender),
      date_of_birth: optionalText(profile.worker.date_of_birth),
      national_id: optionalText(profile.worker.national_id),
      national_id_issued_at: optionalText(profile.worker.national_id_issued_at),
      national_id_issued_place: optionalText(profile.worker.national_id_issued_place),
      address: optionalText(profile.worker.address),
      phone: optionalText(profile.worker.phone),
    },
    general_note: optionalText(profile.general_note),
    payment,
    employment,
  };
}

export function buildFullProfileRequestBody(
  rows: readonly WorkerProfilePreviewRow[],
): FullProfileRequestBody | null {
  const projected: FullProfileRequestRow[] = [];
  for (const row of rows) {
    const built = buildFullProfileRow(row);
    if (built === null) return null;
    projected.push(built);
  }
  if (projected.length < 1 || projected.length > FULL_PROFILE_MAX_ROWS) return null;
  return { contract_version: WORKER_PROFILE_CONTRACT_VERSION, rows: projected };
}

/* ------------------------------------------------------------------ blockers */

export type FullProfileBlockerCode =
  | "PROFILE_PREVIEW_EMPTY"
  | "PROFILE_PREVIEW_INVALID"
  | "PROFILE_CATALOG_UNRESOLVED"
  | "PROFILE_PAYMENT_BANK_REQUIRED"
  | "PROFILE_ROW_LIMIT"
  | "PROFILE_BODY_LIMIT"
  | "PROFILE_CAPABILITY_MISSING"
  | "PROFILE_SUBMITTING"
  | "PROFILE_DIGEST_UNAVAILABLE";

/**
 * Capability that server RPC yeu cau (migration #36 dong 364-374):
 * entry_create + submission_create luon; payment_view + payment_edit khi co payment != omitted;
 * employment_status.apply khi co initial_status.
 */
export function fullProfileRequiredCapabilities(
  rows: readonly FullProfileRequestRow[],
): string[] {
  const required = ["entry_create", "submission_create"];
  if (rows.some((row) => row.payment !== null)) required.push("payment_view", "payment_edit");
  if (rows.some((row) => row.employment !== null)) required.push("employment_status.apply");
  return required;
}

export type FullProfileSubmitState = {
  preview: WorkerProfilePreview | null;
  capabilities: readonly string[];
  submitting: boolean;
};

/** Ly do CTA khong duoc bat. Rong => duoc phep gui. */
export function fullProfileSubmitBlockers(
  state: FullProfileSubmitState,
): FullProfileBlockerCode[] {
  const blockers: FullProfileBlockerCode[] = [];
  const preview = state.preview;
  if (state.submitting) blockers.push("PROFILE_SUBMITTING");
  if (preview === null || preview.rows.length === 0) {
    blockers.push("PROFILE_PREVIEW_EMPTY");
    if (preview !== null && preview.errorCount > 0) blockers.push("PROFILE_PREVIEW_INVALID");
    return blockers;
  }
  if (preview.errorCount > 0 || !preview.canProceed) blockers.push("PROFILE_PREVIEW_INVALID");
  if (preview.totalRows > FULL_PROFILE_MAX_ROWS) blockers.push("PROFILE_ROW_LIMIT");
  if (preview.catalogBlocker) blockers.push("PROFILE_PAYMENT_BANK_REQUIRED");

  const rows: FullProfileRequestRow[] = [];
  for (const row of preview.rows) {
    const paymentBearing = row.row.payment.account_number.state === "provided" ||
      row.row.payment.bank_label.state === "provided" ||
      row.row.payment.account_holder_name.state === "provided";
    if (paymentBearing && row.resolved.bank_id === null) {
      blockers.push("PROFILE_PAYMENT_BANK_REQUIRED");
    }
    const built = buildFullProfileRow(row);
    if (built === null) blockers.push("PROFILE_CATALOG_UNRESOLVED");
    else rows.push(built);
  }

  if (rows.length === preview.rows.length && rows.length > 0) {
    if (JSON.stringify({ contract_version: WORKER_PROFILE_CONTRACT_VERSION, rows }).length >
        FULL_PROFILE_MAX_BODY_BYTES) {
      blockers.push("PROFILE_BODY_LIMIT");
    }
    const required = fullProfileRequiredCapabilities(rows);
    if (!required.every((capability) => state.capabilities.includes(capability))) {
      blockers.push("PROFILE_CAPABILITY_MISSING");
    }
  }
  return [...new Set(blockers)];
}

/* ---------------------------------------------------------------- transport */

export type FullProfileSaved = {
  kind: "saved";
  submissionId: string;
  version: number;
  /** entry_ids theo DUNG thu tu rows gui len (server cam ket thu tu). */
  entryIds: readonly string[];
};

export type FullProfileResult =
  /** Loi tam thoi hoac ket qua khong xac dinh: giu nguyen payload + key de thu lai. */
  | { kind: "retry"; code: string }
  /** 409: khong auto-retry, phai reconcile. */
  | { kind: "conflict"; code: string }
  /** 4xx nghiep vu: key da dung xong. */
  | { kind: "rejected"; code: string }
  | FullProfileSaved;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUCCESS_KEYS = ["entry_ids", "ok", "state", "submission_id", "version"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codeOf(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.code === "string" && body.code.length > 0
    ? body.code
    : fallback;
}

/** Success projection: strict, fail closed khi thieu/thua truong hoac entry_ids lech so dong. */
export function projectFullProfileSuccess(
  body: unknown,
  expectedRows: number,
): FullProfileSaved | null {
  if (!isRecord(body) || body.ok !== true) return null;
  if (Object.keys(body).sort().join(",") !== SUCCESS_KEYS.join(",")) return null;
  if (typeof body.submission_id !== "string" || !UUID.test(body.submission_id)) return null;
  if (body.state !== "DRAFT") return null;
  if (typeof body.version !== "number" || !Number.isSafeInteger(body.version) ||
      body.version < 1) return null;
  if (!Array.isArray(body.entry_ids) || body.entry_ids.length !== expectedRows) return null;
  if (!body.entry_ids.every((id) => typeof id === "string" && UUID.test(id))) return null;
  if (new Set(body.entry_ids).size !== body.entry_ids.length) return null;
  return {
    kind: "saved",
    submissionId: body.submission_id,
    version: body.version,
    entryIds: body.entry_ids as string[],
  };
}

export function classifyFullProfileResponse(
  status: number,
  body: unknown,
  expectedRows: number,
): FullProfileResult {
  if (status === 409) return { kind: "conflict", code: codeOf(body, "IDEMPOTENCY_CONFLICT") };
  if (status >= 500) return { kind: "retry", code: codeOf(body, "BATCH_UNAVAILABLE") };
  if (status >= 200 && status < 300) {
    // 2xx nhung projection khong doc duoc: ket qua khong xac dinh => thu lai cung key.
    return projectFullProfileSuccess(body, expectedRows) ??
      { kind: "retry", code: "FULL_PROFILE_PROJECTION_INVALID" };
  }
  return { kind: "rejected", code: codeOf(body, "BATCH_INVALID") };
}

export type FullProfileFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Dung DUNG MOT request cho ca batch. */
export async function postFullProfileBatch(input: {
  rows: readonly FullProfileRequestRow[];
  idempotencyKey: string;
  fetchImpl: FullProfileFetch;
}): Promise<FullProfileResult> {
  if (input.rows.length < 1 || input.rows.length > FULL_PROFILE_MAX_ROWS) {
    return { kind: "rejected", code: "BATCH_SIZE_INVALID" };
  }
  if (!UUID.test(input.idempotencyKey)) {
    return { kind: "rejected", code: "IDEMPOTENCY_KEY_INVALID" };
  }
  const body = JSON.stringify({
    contract_version: WORKER_PROFILE_CONTRACT_VERSION,
    rows: input.rows,
  } satisfies FullProfileRequestBody);
  if (body.length > FULL_PROFILE_MAX_BODY_BYTES) {
    return { kind: "rejected", code: "BODY_TOO_LARGE" };
  }
  let response: Response;
  try {
    response = await input.fetchImpl(FULL_PROFILE_BATCH_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body,
    });
  } catch {
    return { kind: "retry", code: "FULL_PROFILE_NETWORK" };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return classifyFullProfileResponse(response.status, payload, input.rows.length);
}

/* ------------------------------------------------------------------ intent */

/**
 * Fingerprint cua normalized request de quyet dinh "cung intent".
 * CHI la SHA-256 hex cua payload: khong chua ho ten/CCCD/dia chi/dien thoai/tai khoan/note
 * o dang doc duoc, va khong bao gio duoc persist.
 */
export async function fullProfileIntentDigest(
  rows: readonly FullProfileRequestRow[],
): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({
      contract_version: WORKER_PROFILE_CONTRACT_VERSION,
      rows,
    }));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- messages */

const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  FULL_PROFILE_NETWORK: "Không gửi được yêu cầu. Chưa dòng nào được lưu; hãy bấm Thử lại.",
  FULL_PROFILE_PROJECTION_INVALID:
    "Máy chủ trả về kết quả không đọc được. Chưa xác định được kết quả; hãy bấm Thử lại với cùng yêu cầu.",
  BATCH_UNAVAILABLE: "Máy chủ chưa xử lý được. Chưa dòng nào được lưu; hãy bấm Thử lại.",
  IDEMPOTENCY_CONFLICT:
    "Dữ liệu đã thay đổi ở nơi khác. Hãy tải lại danh sách rồi dán lại trước khi lưu.",
  BATCH_INVALID: "Máy chủ từ chối nhóm dòng. Kiểm tra lại dữ liệu và danh mục.",
  BATCH_SIZE_INVALID: "Mỗi lần lưu phải có từ 1 đến 100 dòng.",
  BODY_INVALID: "Nội dung gửi lên không hợp lệ. Hãy kiểm tra lại dữ liệu đã dán.",
  BODY_TOO_LARGE: "Nhóm dòng vượt quá giới hạn dung lượng cho phép.",
  CONTENT_TYPE_INVALID: "Định dạng yêu cầu không hợp lệ. Hãy tải lại trang và thử lại.",
  IDEMPOTENCY_KEY_INVALID: "Thiếu khóa chống gửi trùng; hãy đóng hộp thoại và thử lại.",
  CONTRACT_VERSION_UNSUPPORTED:
    "Máy chủ chưa hỗ trợ phiên bản hồ sơ đầy đủ này. Chưa dòng nào được lưu.",
  CLIENT_AUTHORITY_FIELD_FORBIDDEN: "Yêu cầu chứa trường không được phép gửi từ trình duyệt.",
  CSRF_REJECTED: "Yêu cầu không cùng nguồn. Hãy tải lại trang rồi thử lại.",
  UNAUTHENTICATED: "Phiên làm việc đã hết hiệu lực. Vui lòng đăng nhập lại.",
  ACTOR_NOT_AVAILABLE: "Không xác định được người dùng hiện tại. Vui lòng đăng nhập lại.",
  ACTOR_DENIED: "Bạn không có quyền lưu hồ sơ đầy đủ cho nhóm dòng này.",
  NOT_FOUND: "Tính năng lưu hồ sơ đầy đủ chưa được bật trên môi trường này.",
  GENERAL_NOTE_TOO_LONG: "Ghi chú vượt quá 4000 ký tự.",
  GENERAL_NOTE_INVALID: "Ghi chú không hợp lệ.",
  GENDER_VOCABULARY_INVALID: "Giới tính không thuộc danh mục cho phép.",
  NATIONAL_ID_INVALID: "CMT/CCCD phải gồm đúng 9 hoặc 12 chữ số.",
  NATIONAL_ID_DUPLICATE: "CMT/CCCD bị trùng trong cùng nhóm dòng.",
  NATIONAL_ID_ISSUED_PLACE_INVALID: "Nơi cấp không hợp lệ.",
  EMPLOYEE_CODE_DUPLICATE: "Mã NLĐ bị trùng trong cùng nhóm dòng.",
  EMPLOYEE_CODE_FORMAT: "Mã NLĐ sai định dạng.",
  EMPLOYEE_CODE_LEGACY_QUARANTINE: "Mã NLĐ theo định dạng cũ không còn được chấp nhận.",
  EMPLOYEE_CODE_YEAR: "Năm trong mã NLĐ không khớp ngày bắt đầu làm việc.",
  PROFILE_DATE_INVALID: "Ngày trong hồ sơ không hợp lệ.",
  PAYMENT_DETAILS_INVALID: "Thông tin thanh toán không hợp lệ.",
  BANK_NOT_ACTIVE: "Ngân hàng chưa có trong danh mục đang hoạt động.",
  PROJECT_NOT_ACTIVE: "Dự án không còn hoạt động trong danh mục.",
  RECRUITER_NOT_ACTIVE: "Người tuyển không còn hoạt động trong danh mục.",
  RECRUITER_MEMBERSHIP_INVALID: "Người tuyển chưa có team/provider hợp lệ cho ngày bắt đầu làm việc.",
  OFF_REQUIRES_DATE_AND_REASON: "Tình trạng đã nghỉ phải có ngày nghỉ và ghi chú hợp lệ.",
  PASTE_VALUE_FORMAT: "Định dạng giá trị không hợp lệ.",
});

export function fullProfileErrorMessage(code: string): string {
  return MESSAGES[code] ?? "Không lưu được nhóm dòng. Chưa dòng nào được lưu.";
}

/** Thong bao chan CTA (hien cho nguoi dung). */
export const FULL_PROFILE_BLOCKER_MESSAGES: Readonly<Record<FullProfileBlockerCode, string>> =
  Object.freeze({
    PROFILE_PREVIEW_EMPTY: "Chưa có dòng dữ liệu hợp lệ để lưu.",
    PROFILE_PREVIEW_INVALID: "Còn lỗi trong bảng xem trước; sửa hết lỗi trước khi lưu.",
    PROFILE_CATALOG_UNRESOLVED:
      "Có dòng chưa đối chiếu được dự án hoặc người tuyển với danh mục.",
    PROFILE_PAYMENT_BANK_REQUIRED:
      "Có dòng khai báo thanh toán nhưng chưa có ngân hàng đang hoạt động trong danh mục.",
    PROFILE_ROW_LIMIT: "Mỗi lần lưu tối đa 100 dòng.",
    PROFILE_BODY_LIMIT: "Nhóm dòng vượt quá giới hạn dung lượng cho phép.",
    PROFILE_CAPABILITY_MISSING: "Bạn không có đủ quyền để lưu nhóm dòng này.",
    PROFILE_SUBMITTING: "Đang lưu; vui lòng chờ máy chủ trả kết quả.",
    PROFILE_DIGEST_UNAVAILABLE:
      "Không tạo được khóa chống gửi trùng trên trình duyệt này; chưa thể lưu.",
  });

export function fullProfileBlockerMessage(code: FullProfileBlockerCode): string {
  return FULL_PROFILE_BLOCKER_MESSAGES[code];
}
