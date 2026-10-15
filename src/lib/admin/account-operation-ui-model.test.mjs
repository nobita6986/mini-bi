import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCreateAccountRequest,
  buildEditDisplayNameRequest,
  buildEligibleAccountsQuery,
  buildPersonnelFromAccountRequest,
  buildReconcileRequest,
  buildResetPasswordRequest,
  classifyAccountOperationResponse,
  projectEligibleAccounts,
} from "./account-operation-ui-model.ts";

const KEY = "91000000-0000-4000-8000-000000000001";
const ACCOUNT = "92000000-0000-4000-8000-000000000001";

test("D3-B UI: create requires canonical login, matching password and reason", () => {
  const ok = buildCreateAccountRequest({
    loginId: "nv-a", displayName: "Nguyen Van A", password: "strong-pass-123",
    passwordConfirm: "strong-pass-123", reason: "create", idempotencyKey: KEY,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.login_id, "nv-a");
  assert.equal("password" in ok.body && "password_confirm" in ok.body, true);

  assert.equal(buildCreateAccountRequest({ loginId: "Bad Login", displayName: "A", password: "x1234567", passwordConfirm: "x1234567", reason: "r", idempotencyKey: KEY }).ok, false);
  assert.equal(buildCreateAccountRequest({ loginId: "nv-a", displayName: "A", password: "x1234567", passwordConfirm: "different", reason: "r", idempotencyKey: KEY }).ok, false);
  assert.equal(buildCreateAccountRequest({ loginId: "nv-a", displayName: "A", password: "short", passwordConfirm: "short", reason: "r", idempotencyKey: KEY }).ok, false);
});

test("D3-B UI: edit display name and reset password build exact bodies", () => {
  const edit = buildEditDisplayNameRequest({ displayName: "New Name", expectedVersion: 2, reason: "rename", idempotencyKey: KEY });
  assert.equal(edit.ok, true);
  assert.deepEqual(edit.body, { display_name: "New Name", expected_version: 2, reason: "rename", idempotency_key: KEY });

  const reset = buildResetPasswordRequest({ password: "new-pass-123", passwordConfirm: "new-pass-123", reason: "reset", idempotencyKey: KEY });
  assert.equal(reset.ok, true);
  assert.deepEqual(Object.keys(reset.body).sort(), ["idempotency_key", "password", "password_confirm", "reason"]);

  assert.equal(buildReconcileRequest(KEY).ok, true);
});

test("D3-B UI: personnel-from-account keeps display_name server-side (not a field)", () => {
  const built = buildPersonnelFromAccountRequest({
    accountRef: ACCOUNT, expectedAccountVersion: 1, personnelCode: "NV001",
    personnelPosition: "STAFF", validFrom: "2026-10-01", reason: "create", idempotencyKey: KEY,
  });
  assert.equal(built.ok, true);
  assert.equal("display_name" in built.body, false, "display_name must not be sent from the browser");
  assert.equal(built.body.personnel_code, "NV001");
});

test("D3-C UI: eligible accounts projection only exposes app_user_id + display_name", () => {
  const query = buildEligibleAccountsQuery(1);
  assert.ok(query);
  assert.equal(query.get("page"), "1");
  assert.equal(query.get("page_size"), "25");

  const list = projectEligibleAccounts({
    ok: true,
    list: { page: 1, page_size: 25, total: 1, has_more: false, accounts: [{ app_user_id: ACCOUNT, display_name: "Nguyen Van A" }] },
  });
  assert.equal(list.accounts.length, 1);
  assert.equal(list.accounts[0].display_name, "Nguyen Van A");
  // No email/login/auth_subject/internal link ids in the projection.
  assert.equal(projectEligibleAccounts({ ok: true, list: { page: 1, page_size: 25, total: 1, has_more: false, accounts: [{ app_user_id: ACCOUNT, display_name: "X", email: "x@hrpartner.vn" }] } }), null);
});

test("D3-B UI: response classifier surfaces needs-reconcile states without password/ref leak", () => {
  assert.equal(classifyAccountOperationResponse(200, { ok: true, account: { app_user_id: ACCOUNT } }).kind, "applied");
  const blocked = classifyAccountOperationResponse(200, { ok: true, intent: { intent_id: KEY, intent_token: KEY, kind: "CREATE_ACCOUNT", state: "BLOCKED" } });
  assert.equal(blocked.kind, "needs-reconcile");
  assert.equal(blocked.state, "BLOCKED");
  assert.match(blocked.message, /provenance/i);
  const indeterminate = classifyAccountOperationResponse(200, { ok: true, intent: { intent_id: KEY, state: "INDETERMINATE" } });
  assert.equal(indeterminate.kind, "needs-reconcile");
  assert.match(indeterminate.message, /Không tự thử lại/);
});

test("reset errors distinguish confirmed Auth success from unknown outcome without exposing raw codes", () => {
  const appliedUnrecorded = classifyAccountOperationResponse(500, {
    ok: false, code: "ACCOUNT_OPERATION_AUTH_APPLIED_UNRECORDED",
  });
  assert.equal(appliedUnrecorded.kind, "unavailable");
  assert.match(appliedUnrecorded.message, /Auth đã xác nhận đổi mật khẩu/);
  assert.match(appliedUnrecorded.message, /Không gửi lại/);
  assert.doesNotMatch(appliedUnrecorded.message, /ACCOUNT_OPERATION_/);

  for (const code of ["ACCOUNT_OPERATION_INDETERMINATE", "ACCOUNT_OPERATION_RESULT_UNRECORDED"]) {
    const unknown = classifyAccountOperationResponse(500, { ok: false, code });
    assert.equal(unknown.kind, "unavailable");
    assert.match(unknown.message, /Chưa xác định được kết quả/);
    assert.match(unknown.message, /Không gửi lại ngay/);
    assert.match(unknown.message, /Admin cần kiểm tra/);
    assert.doesNotMatch(unknown.message, /ACCOUNT_OPERATION_/);
  }
});
