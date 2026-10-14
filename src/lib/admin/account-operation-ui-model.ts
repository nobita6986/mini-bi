/**
 * PRE-W2-HF-D3-B - Pure UI model for account operations (create / edit display
 * name / reset password / reconcile). No I/O, no React. Builds the exact request
 * bodies for the D3-B routes and classifies the sanitized responses, including the
 * intent states that require operator handling (INDETERMINATE/BLOCKED/CONFLICT).
 * Password is never retained beyond the in-memory request and never echoed.
 */
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_BYTES,
} from "./account-operation-contract.ts";
import {
  newIdempotencyKey,
  validateReason,
  validateUuid,
  validateVersion,
  type RequestResult,
} from "../direct-entry/project-operations-model.ts";

const LOGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NAME_MAX = 256;
const CODE_MAX = 64;
const CODE = /^[^\s\u0000-\u001f\u007f]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function passwordOk(password: string): string | null {
  if (password.length < MIN_PASSWORD_BYTES) return "Mật khẩu phải có ít nhất 8 ký tự.";
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return "Mật khẩu quá dài.";
  }
  return null;
}

export function buildCreateAccountRequest(input: {
  loginId: string;
  displayName: string;
  password: string;
  passwordConfirm: string;
  reason: string;
  idempotencyKey: string;
}): RequestResult {
  const loginId = input.loginId.trim();
  const displayName = input.displayName.trim();
  const failure = !LOGIN_ID.test(loginId)
    ? "Mã đăng nhập không hợp lệ (chữ thường/số/._-, 1..64 ký tự)."
    : (displayName === "" ? "Tên hiển thị là bắt buộc." : displayName.length > NAME_MAX
      ? "Tên hiển thị tối đa 256 ký tự." : null)
    ?? (input.password !== input.passwordConfirm ? "Mật khẩu nhập lại không khớp." : passwordOk(input.password))
    ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      login_id: loginId,
      display_name: displayName,
      password: input.password,
      password_confirm: input.passwordConfirm,
      reason: input.reason,
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildEditDisplayNameRequest(input: {
  displayName: string;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}): RequestResult {
  const displayName = input.displayName.trim();
  const failure = (displayName === "" ? "Tên hiển thị là bắt buộc." : displayName.length > NAME_MAX
    ? "Tên hiển thị tối đa 256 ký tự." : null)
    ?? validateVersion(input.expectedVersion) ?? (input.expectedVersion < 1
      ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại." : null)
    ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      display_name: displayName,
      expected_version: input.expectedVersion,
      reason: input.reason,
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildResetPasswordRequest(input: {
  password: string;
  passwordConfirm: string;
  reason: string;
  idempotencyKey: string;
}): RequestResult {
  const failure = (input.password !== input.passwordConfirm ? "Mật khẩu nhập lại không khớp." : passwordOk(input.password))
    ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      password: input.password,
      password_confirm: input.passwordConfirm,
      reason: input.reason,
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildReconcileRequest(idempotencyKey: string): RequestResult {
  const failure = validateUuid(idempotencyKey);
  return failure ? { ok: false, message: failure } : { ok: true, body: { idempotency_key: idempotencyKey } };
}

export function buildPersonnelFromAccountRequest(input: {
  accountRef: string;
  expectedAccountVersion: number;
  personnelCode: string;
  personnelPosition: string;
  validFrom: string;
  reason: string;
  idempotencyKey: string;
}): RequestResult {
  const code = input.personnelCode.trim();
  const failure = validateUuid(input.accountRef)
    ?? validateVersion(input.expectedAccountVersion) ?? (input.expectedAccountVersion < 1
      ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại." : null)
    ?? (code === "" || code.length > CODE_MAX || !CODE.test(code)
      ? "Mã nhân sự bắt buộc, không chứa khoảng trắng hoặc ký tự điều khiển, tối đa 64 ký tự." : null)
    ?? (input.personnelPosition !== "STAFF" && input.personnelPosition !== "TEAM_LEADER"
      ? "Vị trí nhân sự không hợp lệ." : null)
    ?? (DATE.test(input.validFrom) ? null : "Ngày hiệu lực HRP không hợp lệ.")
    ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      account_ref: input.accountRef,
      expected_account_version: input.expectedAccountVersion,
      personnel_code: code,
      personnel_position: input.personnelPosition,
      valid_from: input.validFrom,
      reason: input.reason,
      idempotency_key: input.idempotencyKey,
    },
  };
}

export type AccountOperationUiOutcome =
  | { kind: "applied"; message: string }
  | { kind: "needs-reconcile"; intentId: string; state: string; message: string }
  | { kind: "denied"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

export function accountOperationStateMessage(state: string): string {
  if (state === "BLOCKED") return "Auth user tồn tại nhưng không khớp provenance — cần T0/Admin xử lý thủ công.";
  if (state === "INDETERMINATE") return "Không xác định được kết quả Auth. Không tự thử lại; dùng Đối soát hoặc phát hành thao tác mới.";
  if (state === "CONFLICT") return "Trùng mã đăng nhập hoặc xung đột. Hãy kiểm tra lại.";
  if (state === "FAILED") return "Thao tác Auth đã thất bại.";
  return "Trạng thái: " + state + ".";
}

export function classifyAccountOperationResponse(
  status: number,
  payload: unknown,
): AccountOperationUiOutcome {
  const record = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : null;
  if (status === 200 && record && record.ok === true) {
    const intent = record.intent as Record<string, unknown> | undefined;
    if (intent && typeof intent.state === "string" && intent.state !== "APPLIED") {
      const state = intent.state as "BLOCKED" | "INDETERMINATE" | "CONFLICT" | "FAILED";
      return {
        kind: "needs-reconcile",
        intentId: typeof intent.intent_id === "string" ? intent.intent_id : "",
        state,
        message: accountOperationStateMessage(state),
      };
    }
    return { kind: "applied", message: "Đã lưu thao tác." };
  }
  if (status === 401) return { kind: "denied", message: "Phiên đăng nhập không còn hiệu lực." };
  if (status === 403) return { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  if (status === 409) return { kind: "conflict", message: "Có xung đột hoặc thao tác đang được xử lý." };
  if (status === 400 || status === 422) return { kind: "invalid", message: "Thông tin gửi lên không hợp lệ." };
  return { kind: "unavailable", message: "Dịch vụ hiện không khả dụng." };
}

export function newAccountOperationKey(): string {
  return newIdempotencyKey();
}
