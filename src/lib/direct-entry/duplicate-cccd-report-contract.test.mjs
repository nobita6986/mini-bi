/**
 * P3.1-HF-R3 - hop dong bao cao CCCD trung (pure projection).
 *
 * Khoa: query chi nhan page/page_size trong bien RPC; projection xac nhan key RPC roi BO
 * authority (capability) va project_id (dinh danh noi bo); khong CCCD day du, UUID hay raw
 * error nao duoc tra ra.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDuplicateCccdReportQuery,
  employmentStatusLabel,
  maskedCccd,
  nextDuplicateCccdReportPage,
  projectDuplicateCccdReportRpcPage,
  projectDuplicateCccdReportQuery,
  projectDuplicateCccdReportResponse,
  projectDuplicateCccdReportViewPage,
  DUPLICATE_CCCD_REPORT_DEFAULT_PAGE_SIZE,
  DUPLICATE_CCCD_REPORT_EPISODE_KEYS,
  DUPLICATE_CCCD_REPORT_GROUP_KEYS,
  DUPLICATE_CCCD_REPORT_MAX_PAGE,
  DUPLICATE_CCCD_REPORT_MAX_PAGE_SIZE,
  DUPLICATE_CCCD_REPORT_PAGE_KEYS,
  DUPLICATE_CCCD_REPORT_PAGE_SIZE_OPTIONS,
} from "./duplicate-cccd-report-contract.ts";

function episode(overrides = {}) {
  return {
    employee_code: "hrp-2026-800001",
    display_name: "Nguyen Van A",
    project_id: "proj_a",
    project_display: "Project A",
    first_work_date: "2026-01-05",
    latest_status: "ON",
    active: true,
    ...overrides,
  };
}

function rpcPayload(overrides = {}) {
  return {
    authority: "business_actor",
    authorization_date: "2026-10-09",
    page: 1,
    page_size: 25,
    total_groups: 1,
    total_entries: 2,
    has_more: false,
    groups: [{
      cccd_last4: "8901",
      cccd_length: 12,
      profile_count: 2,
      project_count: 2,
      active_profile_count: 2,
      first_work_date: "2026-01-05",
      latest_first_work_date: "2026-02-10",
      episodes: [
        episode({ first_work_date: "2026-02-10", latest_status: "ON", active: true }),
        episode({ employee_code: "hrp-2026-800002", project_id: "proj_b",
          project_display: "Project B", first_work_date: "2026-01-05",
          latest_status: "ON", active: true }),
      ],
    }],
    ...overrides,
  };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test("the query accepts only page/page_size inside the RPC bounds", () => {
  assert.deepEqual(
    projectDuplicateCccdReportQuery(new URLSearchParams("")),
    { ok: true, value: { page: 1, page_size: DUPLICATE_CCCD_REPORT_DEFAULT_PAGE_SIZE } });
  assert.deepEqual(
    projectDuplicateCccdReportQuery(new URLSearchParams("page=3&page_size=100")),
    { ok: true, value: { page: 3, page_size: 100 } });
  assert.deepEqual(
    projectDuplicateCccdReportQuery(new URLSearchParams("page=1000&page_size=1")),
    { ok: true, value: { page: 1000, page_size: 1 } });
});

test("the query rejects out-of-range and unknown/duplicated parameters", () => {
  for (const raw of [
    "page=0", "page=1001", "page=abc", "page=-1", "page=1.5",
    "page_size=0", "page_size=101", "page_size=-5", "page_size=abc",
    "page=1&page=2", "page=1&order=first_work_date", "page=1&offset=10",
    "scope=all", "auth_subject=x", "app_user_id=y", "allowed_actions=view",
    "authority=entry_admin", "project_id=proj_a",
  ]) {
    assert.deepEqual(projectDuplicateCccdReportQuery(new URLSearchParams(raw)),
      { ok: false, code: "DUPLICATE_CCCD_REPORT_QUERY_INVALID" }, raw);
  }
});

test("the client query builder mirrors the wire bounds", () => {
  assert.equal(buildDuplicateCccdReportQuery({ page: 1, page_size: 25 }).toString(),
    "page=1&page_size=25");
  for (const input of [
    { page: 0, page_size: 25 }, { page: 1001, page_size: 25 },
    { page: 1, page_size: 0 }, { page: 1, page_size: 101 },
    { page: 1.5, page_size: 25 },
  ]) {
    assert.equal(buildDuplicateCccdReportQuery(input), null, JSON.stringify(input));
  }
  for (const size of DUPLICATE_CCCD_REPORT_PAGE_SIZE_OPTIONS) {
    assert.ok(size >= 1 && size <= DUPLICATE_CCCD_REPORT_MAX_PAGE_SIZE);
  }
});

test("the next page stops at the RPC page ceiling even when has_more is true", () => {
  assert.equal(DUPLICATE_CCCD_REPORT_MAX_PAGE, 1000);
  assert.equal(nextDuplicateCccdReportPage(1, true), 2);
  assert.equal(nextDuplicateCccdReportPage(999, true), 1000);
  assert.equal(nextDuplicateCccdReportPage(1000, true), null);
  assert.equal(nextDuplicateCccdReportPage(1000, false), null);
  assert.equal(nextDuplicateCccdReportPage(5, false), null);
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.equal(nextDuplicateCccdReportPage(bad, true), null, String(bad));
  }
});

test("the projection keeps the display fields and drops authority + project_id", () => {
  const page = projectDuplicateCccdReportRpcPage(rpcPayload(), { page: 1, page_size: 25 });
  assert.ok(page);
  assert.deepEqual(Object.keys(page).sort(), [...DUPLICATE_CCCD_REPORT_PAGE_KEYS].sort());
  const [group] = page.groups;
  assert.deepEqual(Object.keys(group).sort(), [...DUPLICATE_CCCD_REPORT_GROUP_KEYS].sort());
  assert.equal(group.cccd_last4, "8901");
  assert.equal(group.cccd_length, 12);
  assert.equal(group.profile_count, 2);
  for (const item of group.episodes) {
    assert.deepEqual(Object.keys(item).sort(), [...DUPLICATE_CCCD_REPORT_EPISODE_KEYS].sort());
  }
  assert.equal(group.episodes[0].latest_status, "ON");
  assert.equal(group.episodes[1].latest_status, "ON");
  assert.equal(group.episodes[1].active, true);

  const serialized = JSON.stringify(page);
  assert.doesNotMatch(serialized, /authority|entry_admin|catalog_master_manage/);
  assert.doesNotMatch(serialized, /project_id|proj_a|proj_b/);
  assert.doesNotMatch(serialized, UUID_RE);
  assert.doesNotMatch(serialized, /012345678901|8901\d/);
});

test("malformed RPC payloads fail closed", () => {
  const cases = {
    "null": null,
    "array": [],
    "extra top-level key": rpcPayload({ extra: 1 }),
    "missing authority": (() => { const p = rpcPayload(); delete p.authority; return p; })(),
    "unknown authority": rpcPayload({ authority: "entry_admin_only" }),
    "bad authorization_date": rpcPayload({ authorization_date: "2026/10/09" }),
    "wrong page": rpcPayload({ page: 2 }),
    "wrong page_size": rpcPayload({ page_size: 50 }),
    "has_more with short page": rpcPayload({ has_more: true }),
    "non-boolean has_more": rpcPayload({ has_more: "no" }),
    "group extra key": rpcPayload({
      groups: [{ ...rpcPayload().groups[0], extra: 1 }] }),
    "bad last4": rpcPayload({
      groups: [{ ...rpcPayload().groups[0], cccd_last4: "89010" }] }),
    "bad cccd_length": rpcPayload({
      groups: [{ ...rpcPayload().groups[0], cccd_length: 10 }] }),
    "single profile group": rpcPayload({
      groups: [{ ...rpcPayload().groups[0], profile_count: 1, episodes: [episode()] }] }),
    "episode count mismatch": rpcPayload({
      groups: [{ ...rpcPayload().groups[0], episodes: [episode()] }] }),
    "episode missing project_id": rpcPayload({
      groups: [{ ...rpcPayload().groups[0], episodes: [
        (() => { const e = episode(); delete e.project_id; return e; })(),
        episode(),
      ] }] }),
    "episode unknown status": rpcPayload({
      groups: [{ ...rpcPayload().groups[0], episodes: [
        episode({ latest_status: "MAYBE" }), episode(),
      ] }] }),
    "episode active disagrees with status": rpcPayload({
      groups: [{ ...rpcPayload().groups[0], episodes: [
        episode({ latest_status: "ON", active: false }), episode({ latest_status: "ON", active: true }),
      ] }] }),
    "group with a resigned episode (ON + OFF)": rpcPayload({
      groups: [{ ...rpcPayload().groups[0], active_profile_count: 1, episodes: [
        episode({ latest_status: "ON", active: true }),
        episode({ latest_status: "OFF", active: false }),
      ] }] }),
    "more groups than page_size": rpcPayload({
      page_size: 1, has_more: false,
      groups: [rpcPayload().groups[0], rpcPayload().groups[0]],
    }),
  };
  for (const [label, payload] of Object.entries(cases)) {
    assert.equal(projectDuplicateCccdReportRpcPage(payload, { page: 1, page_size: 25 }), null, label);
  }
});

test("the response wrapper requires ok:true and the exact view projection", () => {
  const view = projectDuplicateCccdReportRpcPage(rpcPayload(), { page: 1, page_size: 25 });
  assert.ok(view);
  assert.ok(projectDuplicateCccdReportResponse({ ok: true, ...view }, { page: 1, page_size: 25 }));
  assert.ok(projectDuplicateCccdReportViewPage(view, { page: 1, page_size: 25 }));
  assert.equal(projectDuplicateCccdReportResponse({ ok: false, ...view }, { page: 1, page_size: 25 }), null);
  assert.equal(projectDuplicateCccdReportResponse({ ok: true, ...view, extra: 1 }, { page: 1, page_size: 25 }), null);
  // authority/project_id khong thuoc projection tra ra client.
  assert.equal(projectDuplicateCccdReportResponse({ ok: true, ...rpcPayload() }, { page: 1, page_size: 25 }), null);
  assert.equal(projectDuplicateCccdReportViewPage({ ...view, authority: "entry_admin" }, { page: 1, page_size: 25 }), null);
});

test("masked CCCD and status labels never expose the full identifier", () => {
  assert.equal(maskedCccd("8901", 12), "••••••••8901");
  assert.equal(maskedCccd("4321", 9), "•••••4321");
  assert.equal(maskedCccd("8901", 12).includes("8901"), true);
  assert.equal(employmentStatusLabel("ON"), "Đang làm việc");
  assert.equal(employmentStatusLabel("UNCONFIRMED"), "Không xác định");
  assert.equal(employmentStatusLabel("OFF"), "Đã nghỉ");
});

test("output projections never list authority or project_id as client fields", () => {
  assert.equal(DUPLICATE_CCCD_REPORT_PAGE_KEYS.includes("authority"), false);
  assert.equal(DUPLICATE_CCCD_REPORT_GROUP_KEYS.includes("authority"), false);
  assert.equal(DUPLICATE_CCCD_REPORT_EPISODE_KEYS.includes("project_id"), false);
  assert.equal(DUPLICATE_CCCD_REPORT_EPISODE_KEYS.includes("authority"), false);
  // project_id chi duoc xac nhan trong contract RPC (input), khong bao gio tra ra client.
  assert.equal(DUPLICATE_CCCD_REPORT_EPISODE_KEYS.includes("project_display"), true);
});
