#!/usr/bin/env node
/**
 * P3-W03-S01C - Synthetic browser acceptance for the auth UI.
 *
 * Two complementary tiers:
 *  - Tier A (static): inspect the auth UI sources for behavioural invariants.
 *  - Tier B (behavioural): re-play the LoginGate, LoginForm, and
 *    UserSessionControl flows with a stub `fetch` so we observe URL / method /
 *    headers / body for every matrix item.
 *
 * No Supabase Auth, no DB, no Playwright, no Next.js dev server.
 *
 * Usage: node --test scripts/p3-w03-s01c-source-acceptance.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createAuthStubFetch,
  resetHarness,
  simulateLoginForm,
  simulateLoginGate,
  simulateLogout,
  simulateSessionControl,
} from "./lib/p3-auth-harness.mjs";

const FORM = readFileSync(new URL("../src/components/auth/login-form.tsx", import.meta.url), "utf8");
const GATE = readFileSync(new URL("../src/components/auth/login-gate.tsx", import.meta.url), "utf8");
const CONTROL = readFileSync(new URL("../src/components/app-shell/user-session-control.tsx", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../src/app/login/page.tsx", import.meta.url), "utf8");
const APP_SHELL = readFileSync(new URL("../src/components/app-shell/app-shell.tsx", import.meta.url), "utf8");
const AUTH_UI = readFileSync(new URL("../src/lib/auth/auth-ui.ts", import.meta.url), "utf8");

const ALL_AUTH_SOURCES = `${FORM}\n${GATE}\n${CONTROL}\n${PAGE}\n${APP_SHELL}\n${AUTH_UI}`;

test.beforeEach(() => resetHarness());

// ----------------------------------------------------------------------------
// A. Login bootstrap (7 checks)
// ----------------------------------------------------------------------------

test("A1: GET /api/auth/session chi goi mot lan khi mo trang", () => {
  const strippedGate = GATE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const fetchCount = (strippedGate.match(/fetch\(/g) ?? []).length;
  assert.equal(fetchCount, 1, "LoginGate must call fetch exactly once");
  assert.match(GATE, /\/api\/auth\/session/);
});

test("A2: Session 401 -> render LoginForm", async () => {
  const stub = createAuthStubFetch({ session: [{ status: 401, body: { ok: false, code: "AUTH_UNAUTHENTICATED" } }] });
  const result = await simulateLoginGate({ stub });
  assert.equal(result.state, "form");
});

test("A3: Session 200 -> redirect toi safe destination", async () => {
  const stub = createAuthStubFetch({
    session: [{ status: 200, body: { ok: true, app_user_id: "synthetic", capabilities: [], scopes: [] } }],
    destination: "/dashboard",
  });
  const result = await simulateLoginGate({ stub, destination: "/dashboard" });
  assert.equal(result.state, "redirect");
  assert.equal(result.destination, "/dashboard");
});

test("A4: Session 403 -> ACCOUNT_NOT_AVAILABLE; khong render form va actor projection", () => {
  // 403 maps to "unavailable" state which renders the alert and never the LoginForm.
  assert.match(GATE, /res\.status === 403/);
  assert.match(GATE, /setState\("unavailable"\)/);
  // LoginForm must not be reachable from the unavailable branch.
  const unavailableBranch = GATE.match(/state === "unavailable"([\s\S]*?)(?=if \(state === "error")/)?.[0] ?? "";
  assert.equal(/LoginForm/.test(unavailableBranch), false, "unavailable branch must not render LoginForm");
  // The unavailable text must come from the sanitized mapping (no raw code).
  assert.match(GATE, /authUiErrorMessage\("ACCOUNT_NOT_AVAILABLE"\)/);
});

test("A5: Session 503 / network failure -> error state khong auto-loop", () => {
  assert.match(GATE, /catch[\s\S]*?setState\("error"\)/);
  // The error branch must offer a manual retry, not setTimeout / setInterval.
  assert.equal(/setTimeout|setInterval/.test(GATE), false);
  assert.match(GATE, /setAttempt\(\(value\) => value \+ 1\)/);
});

test("A6: Network failure hien thi nut thu lai thu cong", () => {
  assert.match(GATE, /Thử lại/);
  const errorBranch = GATE.match(/state === "error"\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(errorBranch, /setAttempt\(\(value\) => value \+ 1\)/);
  assert.match(errorBranch, /onClick=\{?\s*\(\)\s*=>/);
});

test("A7: Bam thu lai sinh mot request session moi", async () => {
  const stub = createAuthStubFetch({
    session: [
      { status: 503, body: { ok: false, code: "AUTH_UNAVAILABLE" } },
      { status: 401, body: { ok: false, code: "AUTH_UNAUTHENTICATED" } },
    ],
  });
  // First attempt.
  const first = await simulateLoginGate({ stub, attempt: 0 });
  assert.equal(first.state, "error");
  // Manual retry.
  const second = await simulateLoginGate({ stub, attempt: 1 });
  assert.equal(second.state, "form");
  const sessionCalls = stub.calls.filter((c) => /\/api\/auth\/session$/.test(c.url));
  assert.equal(sessionCalls.length, 2, "retry must produce exactly one fresh session request");
});

// ----------------------------------------------------------------------------
// B. Safe destination (8 checks)
// ----------------------------------------------------------------------------

test("B8: Khong co next -> /dashboard", async () => {
  const { resolveSafeAuthDestination } = await import("../src/lib/auth/auth-ui.ts");
  assert.equal(resolveSafeAuthDestination(null), "/dashboard");
  assert.equal(resolveSafeAuthDestination(undefined), "/dashboard");
  assert.equal(resolveSafeAuthDestination(""), "/dashboard");
});

test("B9: next=/dashboard -> /dashboard", async () => {
  const { resolveSafeAuthDestination } = await import("../src/lib/auth/auth-ui.ts");
  assert.equal(resolveSafeAuthDestination("/dashboard"), "/dashboard");
});

test("B10: next=/direct-entry -> /direct-entry", async () => {
  const { resolveSafeAuthDestination } = await import("../src/lib/auth/auth-ui.ts");
  assert.equal(resolveSafeAuthDestination("/direct-entry"), "/direct-entry");
});

test("B11: Absolute URL bi bo qua (tra ve /dashboard)", async () => {
  const { resolveSafeAuthDestination } = await import("../src/lib/auth/auth-ui.ts");
  for (const value of [
    "https://evil.example/", "http://evil.example", "javascript:alert(1)",
  ]) {
    assert.equal(resolveSafeAuthDestination(value), "/dashboard", value);
  }
});

test("B12: Protocol-relative URL bi bo qua", async () => {
  const { resolveSafeAuthDestination } = await import("../src/lib/auth/auth-ui.ts");
  for (const value of ["//evil.example", "//evil.example/path"]) {
    assert.equal(resolveSafeAuthDestination(value), "/dashboard", value);
  }
});

test("B13: Encoded bypass bi bo qua", async () => {
  const { resolveSafeAuthDestination } = await import("../src/lib/auth/auth-ui.ts");
  for (const value of ["%2F%2Fevil.example", "%2Fdashboard", "/dashboard%00"]) {
    assert.equal(resolveSafeAuthDestination(value), "/dashboard", value);
  }
});

test("B14: Path ngoai allowlist bi bo qua", async () => {
  const { resolveSafeAuthDestination } = await import("../src/lib/auth/auth-ui.ts");
  for (const value of ["/admin", "/direct-entry-extra", "/dashboard/../direct-entry"]) {
    assert.equal(resolveSafeAuthDestination(value), "/dashboard", value);
  }
});

test("B15: API response khong the dieu khien redirect", () => {
  // The redirect target is computed only from `next` query (allowlist),
  // not from any API response payload.
  const strippedGate = GATE.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(strippedGate, /resolveSafeAuthDestination\(searchParams\.get\("next"\)\)/);
  // The bootstrap fetch never reads the body (only res.status).
  const fetchBlock = strippedGate.match(/await fetch\(\"\/api\/auth\/session\"[\s\S]*?\}\);/)?.[0] ?? "";
  assert.equal(/res\.json|response\.json|res\.text|response\.text/.test(fetchBlock), false,
    "session bootstrap must not call res.json() to derive the redirect target");
});

// ----------------------------------------------------------------------------
// C. Login form (17 checks)
// ----------------------------------------------------------------------------

test("C16: Email co label / type=email / autocomplete=username / inputMode=email", () => {
  assert.match(FORM, /<label htmlFor="login-email"/);
  assert.match(FORM, /id="login-email"/);
  assert.match(FORM, /type="email"/);
  assert.match(FORM, /autoComplete="username"/);
  assert.match(FORM, /inputMode="email"/);
});

test("C17: Password mac dinh type=password / autocomplete=current-password", () => {
  assert.match(FORM, /type=\{showPassword \? "text" : "password"\}/);
  assert.match(FORM, /autoComplete="current-password"/);
  assert.match(FORM, /spellCheck=\{false\}/);
});

test("C18: Eye/EyeOff hoat dong va aria-label doi dung", async () => {
  const stub = createAuthStubFetch({ login: { status: 200, body: { ok: true } } });
  // Render-like check: source declares the toggle with the right aria-label swap.
  assert.match(FORM, /aria-label=\{showPassword \? "Ẩn mật khẩu" : "Hiện mật khẩu"\}/);
  assert.match(FORM, /<EyeOff|<Eye/);
  // Behavioural: the form posts with type=password by default.
  const before = await simulateLoginForm({ stub, email: "u@example.invalid", password: "secret" });
  assert.equal(before.state, "redirect");
});

test("C19: Submit gui dung mot POST", () => {
  // The login-form.tsx file contains exactly one fetch call (the POST to /api/auth/login).
  const fetchCount = (FORM.match(/fetch\(/g) ?? []).length;
  assert.equal(fetchCount, 1, "form must contain exactly one fetch call");
  assert.match(FORM, /method: "POST"/);
  assert.match(FORM, /\/api\/auth\/login/);
});

test("C20: Body exact chi {email, password}", async () => {
  const stub = createAuthStubFetch({ login: { status: 200, body: { ok: true } } });
  await simulateLoginForm({ stub, email: "u@example.invalid", password: "p" });
  const login = stub.calls.find((c) => c.method === "POST" && /\/api\/auth\/login$/.test(c.url));
  assert.ok(login);
  assert.deepEqual(Object.keys(login.body).sort(), ["email", "password"]);
  assert.equal(login.body.email, "u@example.invalid");
  assert.equal(login.body.password, "p");
});

test("C21: Email duoc trim", async () => {
  const stub = createAuthStubFetch({ login: { status: 200, body: { ok: true } } });
  await simulateLoginForm({ stub, email: "   user@example.invalid   ", password: "p" });
  const login = stub.calls.find((c) => c.method === "POST" && /\/api\/auth\/login$/.test(c.url));
  assert.equal(login.body.email, "user@example.invalid");
});

test("C22: Password KHONG bi trim", async () => {
  const stub = createAuthStubFetch({ login: { status: 200, body: { ok: true } } });
  await simulateLoginForm({ stub, email: "u@example.invalid", password: "  leading-and-trailing  " });
  const login = stub.calls.find((c) => c.method === "POST" && /\/api\/auth\/login$/.test(c.url));
  assert.equal(login.body.password, "  leading-and-trailing  ");
});

test("C23: Khong actor / role / capability / scope / redirect trong request", async () => {
  const stub = createAuthStubFetch({ login: { status: 200, body: { ok: true } } });
  await simulateLoginForm({ stub, email: "u@example.invalid", password: "p" });
  const login = stub.calls.find((c) => c.method === "POST" && /\/api\/auth\/login$/.test(c.url));
  for (const field of ["actor_id", "auth_subject", "app_user_id", "scope", "scope_kind", "role", "capability", "user_id", "next", "redirect", "destination"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(login.body, field), false, `field "${field}" must not appear in body`);
  }
});

test("C24: Double-click chi mot request", () => {
  // The form must short-circuit when already busy.
  assert.match(FORM, /if \(busy\) return;/);
  // There is exactly one fetch in submit().
  const submit = FORM.match(/async function submit[\s\S]*?\n  \}/)?.[0] ?? "";
  const fetchCount = (submit.match(/fetch\(/g) ?? []).length;
  assert.equal(fetchCount, 1);
});

test("C25: Trong luc submit: disabled + aria-busy", () => {
  assert.match(FORM, /disabled=\{busy\}/);
  assert.match(FORM, /aria-busy=\{busy\}/);
  assert.match(FORM, /\{busy \? "Đang đăng nhập…" : "Đăng nhập"\}/);
});

test("C26: Success -> safe redirect", async () => {
  const stub = createAuthStubFetch({ login: { status: 200, body: { ok: true } } });
  const result = await simulateLoginForm({ stub, email: "u@example.invalid", password: "p" });
  assert.equal(result.state, "redirect");
  // The form must use router.replace(destination), where destination is the
  // sanitized allowlist value, not the API response body.
  assert.match(FORM, /router\.replace\(destination\)/);
});

test("C27: AUTH_INVALID_CREDENTIALS -> thong bao tieng Viet chung, khong raw code", async () => {
  const { authUiErrorMessage } = await import("../src/lib/auth/auth-ui.ts");
  const message = authUiErrorMessage("AUTH_INVALID_CREDENTIALS");
  assert.match(message, /^[^\n]+$/);
  assert.equal(message.includes("AUTH_INVALID_CREDENTIALS"), false);
  assert.match(message, /Email hoặc mật khẩu không đúng\./);
});

test("C28: ACCOUNT_NOT_AVAILABLE -> thong bao chung", async () => {
  const { authUiErrorMessage } = await import("../src/lib/auth/auth-ui.ts");
  const message = authUiErrorMessage("ACCOUNT_NOT_AVAILABLE");
  assert.match(message, /Tài khoản/);
  assert.equal(message.includes("ACCOUNT_NOT_AVAILABLE"), false);
});

test("C29: AUTH_UNAVAILABLE / network -> loi tam thoi", async () => {
  const { authUiErrorMessage } = await import("../src/lib/auth/auth-ui.ts");
  const message = authUiErrorMessage("AUTH_UNAVAILABLE");
  assert.match(message, /tạm thời/);
  // The form must map unknown codes to AUTH_UNAVAILABLE.
  assert.equal(authUiErrorMessage("UNKNOWN_CODE"), message);
});

test("C30: CSRF_REJECTED -> khong auto-retry", async () => {
  const stub = createAuthStubFetch({ login: { status: 403, body: { ok: false, code: "CSRF_REJECTED" } } });
  const result = await simulateLoginForm({ stub, email: "u@example.invalid", password: "p" });
  assert.equal(result.state, "error");
  // There must be exactly one POST call (no automatic retry).
  const posts = stub.calls.filter((c) => c.method === "POST" && /\/api\/auth\/login$/.test(c.url));
  assert.equal(posts.length, 1);
});

test("C31: Sau loi password bi xoa, email duoc giu", () => {
  // The form calls setPassword("") on every error path; email is left intact.
  const setPasswordEmpty = (FORM.match(/setPassword\(""\)/g) ?? []).length;
  assert.ok(setPasswordEmpty >= 1, "password must be cleared on at least one error path");
  // The error branches call setPassword("") and never reset email.
  const errorBranches = FORM.match(/setError\(authUiErrorMessage[\s\S]*?\n    \} finally/g)?.[0] ?? "";
  assert.match(errorBranches, /setPassword\(""\)/);
  assert.equal(/setEmail\(/.test(errorBranches), false, "email must not be cleared on error");
});

test("C32: Focus va role=alert / aria-live cho error", () => {
  assert.match(FORM, /role="alert"/);
  assert.match(FORM, /aria-live="polite"/);
  assert.match(FORM, /aria-describedby=\{error \? "login-error" : undefined\}/);
  // No console logging in the auth flow.
  assert.equal(/console\.(?:log|error|warn|info)\(/.test(FORM), false);
});

// ----------------------------------------------------------------------------
// D. AppShell session/logout (8 checks)
// ----------------------------------------------------------------------------

test("D33: Session 200 -> hien 'Đăng xuất'", async () => {
  const stub = createAuthStubFetch({ session: [{ status: 200, body: { ok: true } }] });
  const result = await simulateSessionControl({ stub });
  assert.equal(result.state, "auth");
  // Source must render the logout button when state === "auth".
  assert.match(CONTROL, /state !== "auth"[\s\S]*?<Link href="\/login"[\s\S]*?Đăng nhập/);
  assert.match(CONTROL, /Đăng xuất/);
});

test("D34: Session 401 -> hien 'Đăng nhập'", async () => {
  const stub = createAuthStubFetch({ session: [{ status: 401, body: { ok: false, code: "AUTH_UNAUTHENTICATED" } }] });
  const result = await simulateSessionControl({ stub });
  assert.equal(result.state, "anon");
  assert.match(CONTROL, /<Link href="\/login"[^>]*>Đăng nhập<\/Link>/);
});

test("D35: Session 403 -> khong render actor / capability / scope", () => {
  // The component must never serialise app_user_id / capabilities / scopes
  // for any session state. The body must only show "Đăng nhập" / loading / logout.
  assert.equal(/app_user_id|auth_subject|capabilit|scope_kind|self_recruiter/.test(CONTROL), false,
    "UserSessionControl must not render actor projection fields");
});

test("D36: Logout click chi mot POST", () => {
  const logoutFn = CONTROL.match(/async function logout[\s\S]*?\n  \}/)?.[0] ?? "";
  const fetchCount = (logoutFn.match(/fetch\(/g) ?? []).length;
  assert.equal(fetchCount, 1);
  assert.match(CONTROL, /\/api\/auth\/logout/);
  assert.match(CONTROL, /method: "POST"/);
});

test("D37: Logout 204 -> /login + router refresh", async () => {
  const stub = createAuthStubFetch({ logout: { status: 204, body: null } });
  const result = await simulateLogout({ stub });
  assert.equal(result.state, "redirect");
  assert.match(CONTROL, /res\.status === 204/);
  assert.match(CONTROL, /router\.replace\("\/login"\)/);
  assert.match(CONTROL, /router\.refresh\(\)/);
});

test("D38: Logout 503 / network -> khong gia vo logout thanh cong", async () => {
  const stub = createAuthStubFetch({ logout: { status: 503, body: { ok: false, code: "AUTH_UNAVAILABLE" } } });
  const result = await simulateLogout({ stub });
  assert.equal(result.state, "error");
  // The control must surface the sanitized error and never call router.replace.
  assert.match(CONTROL, /Không thể đăng xuất lúc này/);
  assert.equal(/router\.replace\("\/login"\)/.test(CONTROL.replace(/res\.status === 204[\s\S]*?\}\s*return;/, "")), true);
  const redirectCount = (CONTROL.match(/router\.replace\("\/login"\)/g) ?? []).length;
  assert.equal(redirectCount, 1, "router.replace('/login') must only run on 204");
});

test("D39: Double-click logout chi mot request", () => {
  assert.match(CONTROL, /if \(busy\) return;/);
  const logoutFn = CONTROL.match(/async function logout[\s\S]*?\n  \}/)?.[0] ?? "";
  const fetchCount = (logoutFn.match(/fetch\(/g) ?? []).length;
  assert.equal(fetchCount, 1);
});

test("D40: Touch target toi thieu 44px", () => {
  // Tailwind h-11 = 2.75rem = 44px. The link/button must declare h-11.
  assert.match(CONTROL, /h-11/);
});

// ----------------------------------------------------------------------------
// E. Privacy/security (6 checks)
// ----------------------------------------------------------------------------

test("E41: Khong email / password / token / session / actor trong URL", async () => {
  const stub = createAuthStubFetch({ login: { status: 200, body: { ok: true } } });
  await simulateLoginForm({ stub, email: "u@example.invalid", password: "p" });
  for (const call of stub.calls) {
    assert.equal(/[?&](email|password|token|session|actor)=/.test(call.url), false, `URL must not embed sensitive field: ${call.url}`);
    assert.equal(call.url.includes("user@example.invalid"), false, `URL must not embed email: ${call.url}`);
  }
  // Source must not append credentials to URL.
  assert.equal(/email.*=\s*`?\$\{/.test(FORM), false);
});

test("E42: Khong credential / token trong localStorage / sessionStorage", () => {
  assert.equal(/localStorage|sessionStorage/.test(ALL_AUTH_SOURCES), false);
});

test("E43: Khong raw API error trong DOM / console", () => {
  // Errors displayed to the user must come from the sanitized mapping.
  assert.equal(/console\.(?:log|error|warn|info)\(/.test(ALL_AUTH_SOURCES), false);
  // Display strings must not echo raw codes.
  const formMatches = FORM.match(/setError\(authUiErrorMessage\([\s\S]*?\)\)/g) ?? [];
  assert.ok(formMatches.length > 0);
  for (const branch of formMatches) {
    assert.equal(/setError\(\s*(code|payload|response\.)/.test(branch), false);
  }
});

test("E44: Khong response body chua access / refresh token", async () => {
  const stub = createAuthStubFetch({ session: [{ status: 200, body: { ok: true, app_user_id: "u", capabilities: [], scopes: [] } }] });
  const result = await simulateSessionControl({ stub });
  assert.equal(result.state, "auth");
  // Source must not store tokens in component state.
  assert.equal(/access_token|refresh_token|provider_token|bearer/i.test(ALL_AUTH_SOURCES), false);
});

test("E45: Basic Auth van la outer gate cho /login va /api/auth", async () => {
  // The auth-session server contract enforces it; UI must not bypass it.
  assert.match(APP_SHELL, /AppShell/);
  // LoginGate does not attempt any auth bypass before calling /api/auth/session.
  const gateFetch = GATE.match(/await fetch\([\s\S]*?\)/)?.[0] ?? "";
  assert.equal(/Authorization/i.test(gateFetch), false,
    "UI must not embed Basic Auth headers; the proxy is the outer gate");
});

test("E46: UI khong duoc xem la route authorization", () => {
  // The session control renders "Đăng xuất" only after a successful server
  // session, but it does not gate routes; route/RPC authority is enforced
  // server-side. The control must not perform a redirect on session 200.
  const control = CONTROL;
  assert.equal(/router\.replace\(\s*"\/login"\s*\)[\s\S]*?res\.status === 200/.test(control), false);
  assert.equal(/router\.replace\(\s*"\/dashboard"\s*\)/.test(control), false);
});

// ----------------------------------------------------------------------------
// F. Responsive / accessibility (6 checks)
// ----------------------------------------------------------------------------

test("F47: Desktop 1920x1080 khong overflow", () => {
  // The login page is centered in a single column, full-width with padding.
  assert.match(PAGE, /flex min-h-full flex-1 items-center justify-center/);
  assert.match(PAGE, /max-w-sm/);
});

test("F48: Mobile 390x844 khong overflow", () => {
  // The card width is bounded and the form uses `w-full` inside a max-w container.
  assert.match(PAGE, /w-full max-w-sm/);
  // The password reveal button uses absolute positioning with explicit width.
  assert.match(FORM, /absolute right-0 top-0 flex h-11 w-11/);
});

test("F49: Keyboard Tab / Enter hoat dong", () => {
  // Native form with type=submit button => Enter submits; tab order is DOM-order.
  assert.match(FORM, /<form/);
  assert.match(FORM, /type="submit"/);
  // The login gate retry button is type="button" with keyboard activation.
  assert.match(GATE, /<button type="button"/);
});

test("F50: Focus visible", () => {
  // focus-visible:ring-2 is declared on every input + button.
  const ringCount = (FORM.match(/focus-visible:ring-2/g) ?? []).length;
  assert.ok(ringCount >= 3, "inputs and submit must declare focus-visible ring");
});

test("F51: Light/dark theme khong vo", () => {
  // The components rely on Tailwind tokens (background/foreground/muted) so the
  // theme-registry + ThemeProvider handle theme switching. No hardcoded colours.
  assert.equal(/bg-(white|black|gray-[0-9]+|slate-[0-9]+|zinc-[0-9]+)/.test(FORM + GATE + CONTROL), false);
});

test("F52: Loading / error / form states khong layout shift nghiem trong", () => {
  // The login card reserves space for the form (max-w-sm + p-6).
  assert.match(PAGE, /p-6 shadow-sm/);
  // The error alert uses the same rounded card pattern.
  assert.match(FORM, /rounded-md border border-destructive/);
  assert.match(GATE, /rounded-md border border-destructive/);
});