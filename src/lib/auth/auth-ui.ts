/**
 * P3-W03-S01B - Pure helpers cho login UI (khong I/O, khong framework).
 */
export const SAFE_AUTH_DESTINATIONS = ["/dashboard", "/direct-entry"] as const;

/** Chi cho phep destination noi bo exact trong allowlist; moi thu khac ve /dashboard. */
export function resolveSafeAuthDestination(next: string | null | undefined): string {
  if (typeof next !== "string" || next.length === 0) return "/dashboard";
  if (!next.startsWith("/") || next.startsWith("//")) return "/dashboard";
  const path = next.split(/[?#]/)[0];
  return (SAFE_AUTH_DESTINATIONS as readonly string[]).includes(path) ? path : "/dashboard";
}

export const AUTH_UI_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  AUTH_REQUEST_INVALID: "Thông tin đăng nhập chưa hợp lệ.",
  AUTH_INVALID_CREDENTIALS: "Email hoặc mật khẩu không đúng.",
  AUTH_INVALID_CURRENT_PASSWORD: "Mật khẩu hiện tại không đúng.",
  AUTH_PASSWORD_TOO_WEAK: "Mật khẩu mới cần tối thiểu 8 ký tự và khác mật khẩu hiện tại.",
  AUTH_UNAUTHENTICATED: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  ACCOUNT_NOT_AVAILABLE: "Tài khoản chưa được cấp quyền sử dụng hệ thống.",
  AUTH_UNAVAILABLE: "Hệ thống xác thực tạm thời không khả dụng.",
  CSRF_REJECTED: "Phiên hoặc yêu cầu không hợp lệ. Vui lòng tải lại trang.",
});

/** P3-W03-S02B: auth hop le nhung thieu capability cho resource. */
export const ACCESS_DENIED_MESSAGE = "Bạn không có quyền truy cập chức năng này.";

export function authUiErrorMessage(code: string): string {
  return AUTH_UI_ERROR_MESSAGES[code] ?? AUTH_UI_ERROR_MESSAGES.AUTH_UNAVAILABLE;
}
