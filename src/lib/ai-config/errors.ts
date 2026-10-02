/**
 * P1.5-W04A — mã lỗi bảo mật ĐÓNG, thông điệp đã sanitize (không bao giờ chứa secret/URL thô).
 *
 * Port chọn lọc từ spike `spike/p1.5-w04a-security` (commit 0043920) và bổ sung mã cho vòng đời
 * cấu hình provider (version conflict, chưa verified, settings tắt, test thất bại, rate limit).
 */

export type SecurityErrorCode =
  | "INVALID_INPUT"
  | "CONFIGURATION"
  | "ENVELOPE_INVALID"
  | "DECRYPT_FAILED"
  | "URL_REJECTED"
  | "DNS_REJECTED"
  | "OUTBOUND_FAILED"
  | "TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "REQUEST_TOO_LARGE"
  | "REDIRECT_REJECTED"
  // W04A — vòng đời cấu hình provider
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "NOT_VERIFIED"
  | "SETTINGS_DISABLED"
  | "TEST_FAILED"
  | "RATE_LIMITED";

const messages: Record<SecurityErrorCode, string> = {
  INVALID_INPUT: "Input không hợp lệ.",
  CONFIGURATION: "Cấu hình bảo mật phía server không hợp lệ.",
  ENVELOPE_INVALID: "Secret envelope không hợp lệ.",
  DECRYPT_FAILED: "Không thể giải mã cấu hình.",
  URL_REJECTED: "API URL bị từ chối theo chính sách.",
  DNS_REJECTED: "Địa chỉ mạng đích bị từ chối theo chính sách.",
  OUTBOUND_FAILED: "Yêu cầu tới provider thất bại.",
  TIMEOUT: "Yêu cầu provider vượt quá thời gian cho phép.",
  RESPONSE_TOO_LARGE: "Provider response vượt quá giới hạn.",
  REQUEST_TOO_LARGE: "Provider request vượt quá giới hạn.",
  REDIRECT_REJECTED: "Provider redirect bị từ chối theo chính sách.",
  NOT_FOUND: "Không tìm thấy cấu hình provider.",
  VERSION_CONFLICT: "Cấu hình đã thay đổi bởi phiên khác.",
  NOT_VERIFIED: "Cấu hình chưa được kiểm tra kết nối thành công.",
  SETTINGS_DISABLED: "Bảng cấu hình AI đang tắt.",
  TEST_FAILED: "Kiểm tra kết nối provider thất bại.",
  RATE_LIMITED: "Quá nhiều yêu cầu, vui lòng thử lại sau.",
};

export class SecurityError extends Error {
  readonly code: SecurityErrorCode;

  constructor(code: SecurityErrorCode) {
    super(messages[code]);
    this.name = "SecurityError";
    this.code = code;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

export function securityError(code: SecurityErrorCode): SecurityError {
  return new SecurityError(code);
}

/** Thông điệp an toàn cho một mã (không nhận input bên ngoài). */
export function securityMessage(code: SecurityErrorCode): string {
  return messages[code];
}
