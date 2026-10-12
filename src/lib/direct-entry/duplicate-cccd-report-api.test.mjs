/**
 * P3.1-HF-R3 - API boundary bao cao CCCD trung.
 *
 * Khoa: gate chay truoc query/session/repo; query validation truoc session; denial khong
 * bao gio tro thanh mot trang rong "khong co trung"; response dung projection hien thi
 * (khong authority/project_id/UUID/CCCD day du) va `private, no-store`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { duplicateCccdReport } from "./duplicate-cccd-report-api.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};

const group = {
  cccd_last4: "8901",
  cccd_length: 12,
  profile_count: 2,
  project_count: 2,
  active_profile_count: 1,
  first_work_date: "2026-01-05",
  latest_first_work_date: "2026-02-10",
  episodes: [
    { employee_code: "hrp-2026-800001", display_name: "A", project_display: "Project A",
      first_work_date: "2026-01-05", latest_status: "ON", active: true },
    { employee_code: "hrp-2026-800002", display_name: "B", project_display: "Project B",
      first_work_date: "2026-02-10", latest_status: "OFF", active: false },
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

test("the gate runs before query, session and repository", async () => {
  const deps = dependencies();
  const response = await duplicateCccdReport(
    request("/api/direct-entry/duplicate-cccd-report?page=1"), undefined, deps);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "NOT_FOUND");
  assert.equal(deps.sessionCount(), 0);
  assert.equal(deps.calls.length, 0);
});

test("invalid paging fails before session and never accepts client identity", async () => {
  const deps = dependencies();
  for (const path of [
    "/api/direct-entry/duplicate-cccd-report?page=0",
    "/api/direct-entry/duplicate-cccd-report?page=1001",
    "/api/direct-entry/duplicate-cccd-report?page_size=101",
    "/api/direct-entry/duplicate-cccd-report?page_size=0",
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

test("success returns the display projection with no-store and no internal identifiers", async () => {
  const deps = dependencies();
  const response = await duplicateCccdReport(
    request("/api/direct-entry/duplicate-cccd-report?page=2&page_size=50"), "true", deps);
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
    },
  }]);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /authority|project_id|entry_admin/);
  assert.doesNotMatch(serialized, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test("defaults are page 1 and page_size 25", async () => {
  const deps = dependencies();
  await duplicateCccdReport(
    request("/api/direct-entry/duplicate-cccd-report"), "true", deps);
  assert.deepEqual(deps.calls[0].input, {
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    page: 1,
    page_size: 25,
  });
});
