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
  | "REDIRECT_REJECTED";

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
