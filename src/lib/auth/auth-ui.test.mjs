import assert from "node:assert/strict";
import test from "node:test";

import {
  authUiErrorMessage,
  resolveSafeAuthDestination,
} from "./auth-ui.ts";

test("safe destination allowlist: chi /dashboard va /direct-entry", () => {
  assert.equal(resolveSafeAuthDestination(null), "/dashboard");
  assert.equal(resolveSafeAuthDestination(undefined), "/dashboard");
  assert.equal(resolveSafeAuthDestination(""), "/dashboard");
  assert.equal(resolveSafeAuthDestination("/dashboard"), "/dashboard");
  assert.equal(resolveSafeAuthDestination("/direct-entry"), "/direct-entry");
  assert.equal(resolveSafeAuthDestination("/dashboard?tab=1"), "/dashboard");
  assert.equal(resolveSafeAuthDestination("/direct-entry#top"), "/direct-entry");
});

test("reject absolute, protocol-relative, encoded and out-of-allowlist destinations", () => {
  for (const next of [
    "https://evil.example/", "http://evil.example", "//evil.example",
    "%2F%2Fevil.example", "%2Fdashboard", "/admin", "/direct-entry-extra",
    "/dashboard/../direct-entry", "javascript:alert(1)", "/dashboard%00",
  ]) {
    assert.equal(resolveSafeAuthDestination(next), "/dashboard", next);
  }
});

test("error-code mapping is sanitized and never echoes raw codes", () => {
  assert.equal(authUiErrorMessage("AUTH_REQUEST_INVALID"), "Thông tin đăng nhập chưa hợp lệ.");
  assert.equal(authUiErrorMessage("AUTH_INVALID_CREDENTIALS"), "Email hoặc mật khẩu không đúng.");
  assert.equal(authUiErrorMessage("ACCOUNT_NOT_AVAILABLE"), "Tài khoản chưa được cấp quyền sử dụng hệ thống.");
  assert.equal(authUiErrorMessage("AUTH_UNAVAILABLE"), "Hệ thống xác thực tạm thời không khả dụng.");
  assert.equal(authUiErrorMessage("UNKNOWN_CODE"), authUiErrorMessage("AUTH_UNAVAILABLE"));
  assert.equal(authUiErrorMessage("CSRF_REJECTED"), "Phiên hoặc yêu cầu không hợp lệ. Vui lòng tải lại trang.");
  assert.equal(authUiErrorMessage("CSRF_REJECTED").includes("CSRF_REJECTED"), false);
});
