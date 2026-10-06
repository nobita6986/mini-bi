import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const route = source("./change-password-route-composition.ts");
const routeFile = source("../../app/api/auth/change-password/route.ts");
const core = source("./change-password-core.ts");
const form = source("../../components/auth/change-password-form.tsx");
const page = source("../../app/dashboard/account/password/page.tsx");
const sessionControl = source("../../components/app-shell/user-session-control.tsx");
const authUi = source("./auth-ui.ts");
const sessionPageAccess = source("./session-page-access.ts");

test("change-password route is dynamic Node, uses the same factory pattern, no service-role or fetch", () => {
  assert.match(routeFile, /export const runtime = "nodejs"/);
  assert.match(routeFile, /export const dynamic = "force-dynamic"/);
  assert.match(routeFile, /createChangePasswordResponse/);
  assert.match(routeFile, /createChangePasswordDependencies/);
  assert.doesNotMatch(routeFile, /\bfetch\s*\(/);
  assert.doesNotMatch(routeFile, /createServiceSupabaseClient/);
  assert.doesNotMatch(routeFile, /auth_subject|app_user_id|capabilit/);
  assert.match(route, /createSupabaseAuthClient/);
});

test("change-password core derives the email from getUser() and rejects client-supplied identifiers", () => {
  assert.match(core, /sessionUser\.email/);
  assert.match(core, /resolveIdentifierToEmail/);
  assert.match(core, /reauth\.data\.user\.id !== sessionUser\.id/);
  assert.match(core, /AUTH_INVALID_CURRENT_PASSWORD/);
  assert.match(core, /AUTH_PASSWORD_TOO_WEAK/);
  assert.match(core, /AUTH_UNAUTHENTICATED/);
  assert.match(core, /AUTH_UNAVAILABLE/);
  assert.match(core, /checkSameOriginRequest/);
  assert.match(core, /projectChangePasswordInput/);
  assert.doesNotMatch(core, /console\.log|console\.warn|console\.error/);
  assert.doesNotMatch(core, /localStorage|sessionStorage/);
  assert.doesNotMatch(core, /\bfetch\s*\(/);
});

test("change-password form: native form, single POST, three inputs, sanitized errors, never persists passwords", () => {
  assert.match(form, /<form onSubmit=/);
  assert.equal((form.match(/fetch\(/g) ?? []).length, 1);
  assert.match(form, /\/api\/auth\/change-password/);
  assert.match(form, /method: "POST"/);
  assert.match(form, /credentials: "same-origin"/);
  assert.match(form, /autoComplete="current-password"/);
  assert.match(form, /autoComplete="new-password"/);
  assert.match(form, /spellCheck=\{false\}/);
  assert.match(form, /Mật khẩu hiện tại/);
  assert.match(form, /Mật khẩu mới/);
  assert.match(form, /Xác nhận mật khẩu mới/);
  assert.match(form, /Tối thiểu 8 ký tự/);
  assert.match(form, /if \(busy\) return;/);
  assert.match(form, /setBusy\(true\)/);
  assert.match(form, /setCurrentPassword\(""\)/);
  assert.match(form, /setNewPassword\(""\)/);
  assert.match(form, /setConfirmPassword\(""\)/);
  assert.match(form, /authUiErrorMessage/);
  assert.match(form, /role="alert"/);
  assert.match(form, /role="status"/);
  assert.doesNotMatch(form, /localStorage|sessionStorage/);
  assert.doesNotMatch(form, /console\.log|console\.error|console\.warn/);
  assert.doesNotMatch(form, /app_user_id|auth_subject|capabilit|scope_kind/);
});

test("change-password form: only sanitized code keys are forwarded to the user-facing message", () => {
  for (const code of ["AUTH_UNAUTHENTICATED", "AUTH_INVALID_CURRENT_PASSWORD", "AUTH_PASSWORD_TOO_WEAK", "AUTH_UNAVAILABLE", "AUTH_REQUEST_INVALID"]) {
    assert.match(authUi, new RegExp(code));
  }
  assert.match(authUi, /Mật khẩu hiện tại không đúng/);
  assert.match(authUi, /tối thiểu 8 ký tự/);
});

test("change-password page is a server page that runs through decideSessionPageAccess", () => {
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /getDirectEntryActor/);
  assert.match(page, /decideSessionPageAccess/);
  assert.match(page, /redirect\("\/login\?next=\/dashboard\/account\/password"\)/);
  assert.match(page, /<ChangePasswordForm /);
  assert.match(sessionPageAccess, /decideSessionPageAccess/);
});

test("user session control exposes a change-password link alongside logout", () => {
  assert.match(sessionControl, /\/dashboard\/account\/password/);
  assert.match(sessionControl, /Đổi mật khẩu/);
  assert.match(sessionControl, /Đăng xuất/);
  assert.doesNotMatch(sessionControl, /password.*\/p|secret|plaintext/i);
});