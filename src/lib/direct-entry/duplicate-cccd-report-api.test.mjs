/**
 * P3.1-HF-R3 + HF Duplicate CCCD Self-Service Actions - API boundary bao cao CCCD trung & self-withdraw.
 *
 * Khoa: gate chay truoc query/session/repo; query validation truoc session; denial khong
 * bao gio tro thanh mot trang rong "khong co trung"; response dung projection hien thi
 * (khong authority/project_id/created_by_user_id/CCCD day du) va `private, no-store`;
 * POST self-withdraw enforces gate, CSRF, JSON content-type, authority field rejection,
 * strict body validation (422), server actor, and sanitized error codes.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { duplicateCccdReport } from "./duplicate-cccd-report-api.ts";
import { duplicateCccdSelfWithdraw } from "./duplicate-cccd-self-withdraw-api.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const ENTRY_A = "c1000000-0000-4000-8000-000000000001";
const ENTRY_B = "c1000000-0000-4000-8000-000000000002";

const group = {
  cccd_last4: "8901",
  cccd_length: 12,
  profile_count: 2,
  project_count: 2,
  active_profile_count: 2,
  first_work_date: "2026-01-05",
  latest_first_work_date: "2026-02-10",
  episodes: [
    {
      entry_id: ENTRY_A,
      entry_version: 1,
      employee_code: "hrp-2026-800001",
      display_name: "A",
      project_display: "Project A",
      first_work_date: "2026-01-05",
      latest_status: "ON",
      active: true,
      can_mark_off: true,
      can_self_withdraw: true,
    },
    {
      entry_id: ENTRY_B,
      entry_version: 1,
      employee_code: "hrp-2026-800002",
      display_name: "B",
      project_display: "Project B",
      first_work_date: "2026-02-10",
      latest_status: "ON",
      active: true,
      can_mark_off: false,
      can_self_withdraw: false,
    },
  ],
};

function pageData(overrides = {}) {
  return {
    page: 1, page_size: 25, total_groups: 1, total_entries: 2, has_more: false,
    authorization_date: "2026-10-09", groups: [group], ...overrides,
  };
}

function request(path, headers = {}) {
  return new Request("https://example.test" + path, { method: "GET", headers });
}

function withdrawRequest(body, headers = {}) {
  return new Request("https://example.test/api/direct-entry/duplicate-cccd-report/self-withdraw", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function dependencies(overrides = {}) {
  const calls = [];
  let sessions = 0;
  return {
    calls,
    sessionCount: () => sessions,
    resolveSession: async () => {
      sessions += 1;
      return { actor: { ok: true, actor }, response_headers: {} };
    },
    repository: {
      async report(input) {
        calls.push({ name: "report", input });
        return { ok: true, data: pageData() };
      },
      ...overrides,
    },
  };
}

function withdrawDependencies(overrides = {}) {
  const calls = [];
  let sessions = 0;
  return {
    calls,
    sessionCount: () => sessions,
    resolveSession: async () => {
      sessions += 1;
      return { actor: { ok: true, actor }, response_headers: {} };
    },
    repository: {
      async selfWithdraw(input) {
        calls.push({ name: "selfWithdraw", input });
        return { ok: true, data: { entry_id: ENTRY_A, version: 2 } };
      },
      ...overrides,
    },
  };
}

test("the gate runs before query, session and repository", async () => {
  const deps = dependencies();
  const response = await duplicateCccdReport(
    request("/api/direct-entry/duplicate-cccd-report?page=1"), undefined, deps);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "NOT_FOUND");
  assert.equal(deps.sessionCount(), 0);
  assert.equal(deps.calls.length, 0);
});

test("invalid paging or non-boolean managed_only fails before session and never accepts client identity or project_id", async () => {
  const deps = dependencies();
  for (const path of [
    "/api/direct-entry/duplicate-cccd-report?page=0",
    "/api/direct-entry/duplicate-cccd-report?page=1001",
    "/api/direct-entry/duplicate-cccd-report?page_size=101",
    "/api/direct-entry/duplicate-cccd-report?page_size=0",
    "/api/direct-entry/duplicate-cccd-report?managed_only=1",
    "/api/direct-entry/duplicate-cccd-report?managed_only=yes",
    "/api/direct-entry/duplicate-cccd-report?project_id=proj_a",
    "/api/direct-entry/duplicate-cccd-report?order=first_work_date",
    "/api/direct-entry/duplicate-cccd-report?auth_subject=" + actor.auth_subject,
    "/api/direct-entry/duplicate-cccd-report?app_user_id=" + actor.app_user_id,
    "/api/direct-entry/duplicate-cccd-report?authority=entry_admin",
    "/api/direct-entry/duplicate-cccd-report?scope=all",
    "/api/direct-entry/duplicate-cccd-report?page=1&page=2",
  ]) {
    const response = await duplicateCccdReport(request(path), "true", deps);
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).code, "DUPLICATE_CCCD_REPORT_QUERY_INVALID", path);
  }
  assert.equal(deps.sessionCount(), 0);
  assert.equal(deps.calls.length, 0);
});

test("session and actor mapping fail closed before the repository", async () => {
  for (const [session, status, code] of [
    [{ actor: { ok: false, reason: "UNAUTHENTICATED" } }, 401, "UNAUTHENTICATED"],
    [{ actor: { ok: false, reason: "ACTOR_DISABLED" } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: { auth_subject: actor.auth_subject } } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: null } }, 403, "ACTOR_NOT_AVAILABLE"],
  ]) {
    const deps = dependencies();
    deps.resolveSession = async () => ({ ...session, response_headers: {} });
    const response = await duplicateCccdReport(
      request("/api/direct-entry/duplicate-cccd-report?page=1"), "true", deps);
    assert.equal(response.status, status, code);
    assert.equal((await response.json()).code, code);
    assert.equal(deps.calls.length, 0);
  }
});

test("denied is a 403, never an empty report", async () => {
  for (const [kind, status, code] of [
    ["denied", 403, "DUPLICATE_CCCD_REPORT_DENIED"],
    ["invalid", 400, "DUPLICATE_CCCD_REPORT_QUERY_INVALID"],
    ["unavailable", 500, "DUPLICATE_CCCD_REPORT_UNAVAILABLE"],
  ]) {
    const deps = dependencies({ async report() { return { ok: false, kind }; } });
    const response = await duplicateCccdReport(
      request("/api/direct-entry/duplicate-cccd-report?page=1"), "true", deps);
    assert.equal(response.status, status, kind);
    const body = await response.json();
    assert.equal(body.code, code, kind);
    assert.equal(body.ok, false);
    assert.equal("groups" in body, false, "a denial must not carry an empty groups array");
  }
});

test("success returns the display projection with no-store, forwards managed_only, and strips internal authority/project_id", async () => {
  const deps = dependencies();
  const response = await duplicateCccdReport(
    request("/api/direct-entry/duplicate-cccd-report?page=2&page_size=50&managed_only=true"),
    "true",
    deps,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true, page: 1, page_size: 25, total_groups: 1, total_entries: 2, has_more: false,
    authorization_date: "2026-10-09", groups: [group],
  });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(deps.calls, [{
    name: "report",
    input: {
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      page: 2,
      page_size: 50,
      managed_only: true,
    },
  }]);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /authority|project_id|entry_admin|created_by_user_id/);
  assert.doesNotMatch(serialized, new RegExp(actor.auth_subject, "i"));
  assert.doesNotMatch(serialized, new RegExp(actor.app_user_id, "i"));
});

test("defaults are page 1, page_size 25, and managed_only false", async () => {
  const deps = dependencies();
  await duplicateCccdReport(
    request("/api/direct-entry/duplicate-cccd-report"), "true", deps);
  assert.deepEqual(deps.calls[0].input, {
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    page: 1,
    page_size: 25,
    managed_only: false,
  });
});

test("POST self-withdraw enforces gate, CSRF, content-type, authority field rejection, 422 validation, and sanitized outcomes", async () => {
  const validPayload = {
    entry_id: ENTRY_A,
    expected_entry_version: 1,
    idempotency_key: "idem-withdraw-1",
    reason: "  Nhập trùng dự án  ",
  };

  const gated = withdrawDependencies();
  const gatedRes = await duplicateCccdSelfWithdraw(withdrawRequest(validPayload), undefined, gated);
  assert.equal(gatedRes.status, 404);
  assert.equal(gated.sessionCount(), 0);

  for (const [label, req, status, code] of [
    ["cross origin", withdrawRequest(validPayload, { origin: "https://evil.test" }), 403, "CSRF_REJECTED"],
    ["bad content-type", withdrawRequest(validPayload, { "content-type": "text/plain" }), 400, "CONTENT_TYPE_INVALID"],
    ["invalid JSON", withdrawRequest("{not-json"), 400, "BODY_INVALID"],
    [
      "client app_user_id forbidden",
      withdrawRequest({ ...validPayload, app_user_id: actor.app_user_id }),
      400,
      "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
    ],
    [
      "client can_self_withdraw forbidden",
      withdrawRequest({ ...validPayload, can_self_withdraw: true }),
      400,
      "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
    ],
    [
      "client project_id forbidden",
      withdrawRequest({ ...validPayload, project_id: "proj_a" }),
      400,
      "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
    ],
    [
      "missing idempotency_key -> 422",
      withdrawRequest({ entry_id: ENTRY_A, expected_entry_version: 1 }),
      422,
      "SELF_WITHDRAW_INVALID",
    ],
    [
      "version 0 -> 422",
      withdrawRequest({ ...validPayload, expected_entry_version: 0 }),
      422,
      "SELF_WITHDRAW_INVALID",
    ],
  ]) {
    const deps = withdrawDependencies();
    const res = await duplicateCccdSelfWithdraw(req, "true", deps);
    assert.equal(res.status, status, label);
    assert.equal((await res.json()).code, code, label);
    assert.equal(deps.sessionCount(), 0, label);
    assert.equal(deps.calls.length, 0, label);
  }

  for (const [outcome, status, code] of [
    [{ ok: false, kind: "denied", code: "SELF_WITHDRAW_DENIED" }, 403, "SELF_WITHDRAW_DENIED"],
    [{ ok: false, kind: "not-found", code: "ENTRY_NOT_FOUND" }, 404, "ENTRY_NOT_FOUND"],
    [{ ok: false, kind: "conflict", code: "DUPLICATE_NO_LONGER_ACTIVE" }, 409, "DUPLICATE_NO_LONGER_ACTIVE"],
    [{ ok: false, kind: "conflict", code: "VERSION_CONFLICT" }, 409, "VERSION_CONFLICT"],
    [{ ok: false, kind: "invalid", code: "SELF_WITHDRAW_INVALID" }, 422, "SELF_WITHDRAW_INVALID"],
    [{ ok: false, kind: "unavailable", code: "SELF_WITHDRAW_UNAVAILABLE" }, 500, "SELF_WITHDRAW_UNAVAILABLE"],
  ]) {
    const deps = withdrawDependencies({ async selfWithdraw() { return outcome; } });
    const res = await duplicateCccdSelfWithdraw(withdrawRequest(validPayload), "true", deps);
    assert.equal(res.status, status, code);
    assert.equal((await res.json()).code, code);
  }

  const okDeps = withdrawDependencies();
  const okRes = await duplicateCccdSelfWithdraw(withdrawRequest(validPayload), "true", okDeps);
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await okRes.json(), { ok: true, entry_id: ENTRY_A, version: 2 });
  assert.deepEqual(okDeps.calls, [{
    name: "selfWithdraw",
    input: {
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      entry_id: ENTRY_A,
      expected_version: 1,
      reason: "Nhập trùng dự án",
      idempotency_key: "idem-withdraw-1",
    },
  }]);
});
