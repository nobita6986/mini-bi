import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const denied = source("./access-denied.tsx");
const gate = source("./login-gate.tsx");
const page = source("../../app/direct-entry/page.tsx");
const helper = source("../../lib/auth/auth-ui.ts");

test("S02B: account unavailable co hanh dong dang xuat, khong lo uuid/capability", () => {
  assert.match(gate, /ACCOUNT_NOT_AVAILABLE/);
  assert.match(gate, /\/api\/auth\/logout/);
  assert.match(gate, /router\.replace\("\/login"\)/);
  assert.match(gate, /disabled=\{busy\}/);
  assert.doesNotMatch(gate, /app_user_id|auth_subject|capabilit|scope_kind/);
});

test("S02B: access denied UX chung, link an toan, khong raw reason", () => {
  assert.match(denied, /\{ACCESS_DENIED_MESSAGE\}/);
  assert.match(denied, /href="\/dashboard"/);
  assert.match(denied, /href="\/login"/);
  assert.match(denied, /role="alert"/);
  assert.doesNotMatch(denied, /app_user_id|capabilit|scope|reason|code/);
});

test("S02B: direct-entry flag off hien access denied, khong notFound", () => {
  assert.match(page, /<AccessDenied \/>/);
  assert.doesNotMatch(page, /notFound\(\)/);
});

test("S02B: thong bao tam thoi dung dung chu ky", () => {
  assert.match(helper, /Hệ thống xác thực tạm thời không khả dụng\./);
  assert.match(helper, /ACCESS_DENIED_MESSAGE = "Bạn không có quyền truy cập chức năng này\."/);
});
