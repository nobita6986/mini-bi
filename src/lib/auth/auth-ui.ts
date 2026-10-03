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
  ACCOUNT_NOT_AVAILABLE: "Tài khoản chưa được cấp quyền sử dụng hệ thống.",
  AUTH_UNAVAILABLE: "Dịch vụ đăng nhập tạm thời không khả dụng, vui lòng thử lại.",
  CSRF_REJECTED: "Phiên hoặc yêu cầu không hợp lệ. Vui lòng tải lại trang.",
});

export function authUiErrorMessage(code: string): string {
  return AUTH_UI_ERROR_MESSAGES[code] ?? AUTH_UI_ERROR_MESSAGES.AUTH_UNAVAILABLE;
}
