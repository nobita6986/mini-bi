/**
 * P3.1-HF-R3 + HF Duplicate CCCD Self-Service Actions - hop dong bao cao CCCD trung (pure projection).
 *
 * Khoa: query chi nhan page/page_size/managed_only trong bien RPC; projection xac nhan key RPC
 * roi BO authority (capability) va project_id (dinh danh noi bo), chi giu entry_id/entry_version/
 * can_mark_off/can_self_withdraw cho thao tac co kiem soat; khong CCCD day du, created_by_user_id
 * hay raw error nao duoc tra ra.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDuplicateCccdReportQuery,
  clampDuplicateCccdReportPage,
  duplicateCccdSelfWithdrawErrorMessage,
  employmentStatusLabel,
  maskedCccd,
  nextDuplicateCccdReportPage,
  projectDuplicateCccdReportRpcPage,
  projectDuplicateCccdReportQuery,
  projectDuplicateCccdReportResponse,
  projectDuplicateCccdReportViewPage,
  projectDuplicateCccdSelfWithdrawRequest,
  projectDuplicateCccdSelfWithdrawRpcResult,
  DUPLICATE_CCCD_REPORT_DEFAULT_PAGE_SIZE,
  DUPLICATE_CCCD_REPORT_EPISODE_KEYS,
  DUPLICATE_CCCD_REPORT_GROUP_KEYS,
  DUPLICATE_CCCD_REPORT_MAX_PAGE,
  DUPLICATE_CCCD_REPORT_MAX_PAGE_SIZE,
  DUPLICATE_CCCD_REPORT_PAGE_KEYS,
  DUPLICATE_CCCD_REPORT_PAGE_SIZE_OPTIONS,
} from "./duplicate-cccd-report-contract.ts";

const ENTRY_A = "c1000000-0000-4000-8000-000000000001";
const ENTRY_B = "c1000000-0000-4000-8000-000000000002";

function episode(overrides = {}) {
  return {
    entry_id: ENTRY_A,
    entry_version: 1,
    employee_code: "hrp-2026-800001",
    display_name: "Nguyen Van A",
    project_id: "proj_a",
    project_display: "Project A",
    first_work_date: "2026-01-05",
    latest_status: "ON",
    active: true,
    can_mark_off: true,
    can_self_withdraw: false,
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
        episode({
          entry_id: ENTRY_A,
          entry_version: 2,
          first_work_date: "2026-02-10",
          latest_status: "ON",
          active: true,
          can_mark_off: true,
          can_self_withdraw: true,
        }),
        episode({
          entry_id: ENTRY_B,
          entry_version: 1,
          employee_code: "hrp-2026-800002",
          project_id: "proj_b",
          project_display: "Project B",
          first_work_date: "2026-01-05",
          latest_status: "ON",
          active: true,
          can_mark_off: false,
          can_self_withdraw: false,
        }),
      ],
    }],
    ...overrides,
  };
}

test("the query accepts only page/page_size/managed_only inside the RPC bounds", () => {
  assert.deepEqual(
    projectDuplicateCccdReportQuery(new URLSearchParams("")),
    { ok: true, value: { page: 1, page_size: DUPLICATE_CCCD_REPORT_DEFAULT_PAGE_SIZE, managed_only: false } },
  );
  assert.deepEqual(
    projectDuplicateCccdReportQuery(new URLSearchParams("page=3&page_size=100")),
    { ok: true, value: { page: 3, page_size: 100, managed_only: false } },
  );
  assert.deepEqual(
    projectDuplicateCccdReportQuery(new URLSearchParams("page=1000&page_size=1&managed_only=true")),
    { ok: true, value: { page: 1000, page_size: 1, managed_only: true } },
  );
  assert.deepEqual(
    projectDuplicateCccdReportQuery(new URLSearchParams("managed_only=false")),
    { ok: true, value: { page: 1, page_size: DUPLICATE_CCCD_REPORT_DEFAULT_PAGE_SIZE, managed_only: false } },
  );
});

test("the query rejects out-of-range, non-boolean managed_only, and unknown/duplicated parameters", () => {
  for (const raw of [
    "page=0", "page=1001", "page=abc", "page=-1", "page=1.5",
    "page_size=0", "page_size=101", "page_size=-5", "page_size=abc",
    "managed_only=1", "managed_only=0", "managed_only=TRUE", "managed_only=",
    "managed_only=true&managed_only=false",
    "page=1&page=2", "page=1&order=first_work_date", "page=1&offset=10",
    "scope=all", "auth_subject=x", "app_user_id=y", "allowed_actions=view",
    "authority=entry_admin", "project_id=proj_a", "project_ids=proj_a,proj_b",
  ]) {
    assert.deepEqual(
      projectDuplicateCccdReportQuery(new URLSearchParams(raw)),
      { ok: false, code: "DUPLICATE_CCCD_REPORT_QUERY_INVALID" },
      raw,
    );
  }
});

test("the client query builder mirrors the wire bounds and optional boolean managed_only", () => {
  assert.equal(
    buildDuplicateCccdReportQuery({ page: 1, page_size: 25 }).toString(),
    "page=1&page_size=25",
  );
  assert.equal(
    buildDuplicateCccdReportQuery({ page: 2, page_size: 50, managed_only: true }).toString(),
    "page=2&page_size=50&managed_only=true",
  );
  assert.equal(
    buildDuplicateCccdReportQuery({ page: 1, page_size: 25, managed_only: false }).toString(),
    "page=1&page_size=25&managed_only=false",
  );
  for (const input of [
    { page: 0, page_size: 25 }, { page: 1001, page_size: 25 },
    { page: 1, page_size: 0 }, { page: 1, page_size: 101 },
    { page: 1.5, page_size: 25 },
    { page: 1, page_size: 25, managed_only: "true" },
  ]) {
    assert.equal(buildDuplicateCccdReportQuery(input), null, JSON.stringify(input));
  }
  for (const size of DUPLICATE_CCCD_REPORT_PAGE_SIZE_OPTIONS) {
    assert.ok(size >= 1 && size <= DUPLICATE_CCCD_REPORT_MAX_PAGE_SIZE);
  }
});

test("the next page stops at the RPC page ceiling and clampDuplicateCccdReportPage steps back empty pages", () => {
  assert.equal(DUPLICATE_CCCD_REPORT_MAX_PAGE, 1000);
  assert.equal(nextDuplicateCccdReportPage(1, true), 2);
  assert.equal(nextDuplicateCccdReportPage(999, true), 1000);
  assert.equal(nextDuplicateCccdReportPage(1000, true), null);
  assert.equal(nextDuplicateCccdReportPage(1000, false), null);
  assert.equal(nextDuplicateCccdReportPage(5, false), null);
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.equal(nextDuplicateCccdReportPage(bad, true), null, String(bad));
  }

  assert.equal(clampDuplicateCccdReportPage(3, 50, 25), 2);
  assert.equal(clampDuplicateCccdReportPage(2, 0, 25), 1);
  assert.equal(clampDuplicateCccdReportPage(1, 0, 25), 1);
  assert.equal(clampDuplicateCccdReportPage(2, 26, 25), 2);
});

test("the projection keeps display + controlled action fields and drops authority + project_id", () => {
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
  assert.equal(group.episodes[0].entry_id, ENTRY_A);
  assert.equal(group.episodes[0].entry_version, 2);
  assert.equal(group.episodes[0].can_mark_off, true);
  assert.equal(group.episodes[0].can_self_withdraw, true);
  assert.equal(group.episodes[1].entry_id, ENTRY_B);
  assert.equal(group.episodes[1].can_mark_off, false);
  assert.equal(group.episodes[1].can_self_withdraw, false);

  const serialized = JSON.stringify(page);
  assert.doesNotMatch(serialized, /authority|entry_admin|catalog_master_manage|created_by_user_id/);
  assert.doesNotMatch(serialized, /project_id|proj_a|proj_b/);
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
      groups: [{ ...rpcPayload().groups[0], extra: 1 }],
    }),
    "bad last4": rpcPayload({
      groups: [{ ...rpcPayload().groups[0], cccd_last4: "89010" }],
    }),
    "bad cccd_length": rpcPayload({
      groups: [{ ...rpcPayload().groups[0], cccd_length: 10 }],
    }),
    "single profile group": rpcPayload({
      groups: [{ ...rpcPayload().groups[0], profile_count: 1, episodes: [episode()] }],
    }),
    "episode count mismatch": rpcPayload({
      groups: [{ ...rpcPayload().groups[0], episodes: [episode()] }],
    }),
    "episode missing project_id": rpcPayload({
      groups: [{
        ...rpcPayload().groups[0],
        episodes: [
          (() => { const e = episode(); delete e.project_id; return e; })(),
          episode({ entry_id: ENTRY_B }),
        ],
      }],
    }),
    "episode bad entry_id": rpcPayload({
      groups: [{
        ...rpcPayload().groups[0],
        episodes: [episode({ entry_id: "not-a-uuid" }), episode({ entry_id: ENTRY_B })],
      }],
    }),
    "episode bad entry_version": rpcPayload({
      groups: [{
        ...rpcPayload().groups[0],
        episodes: [episode({ entry_version: 0 }), episode({ entry_id: ENTRY_B })],
      }],
    }),
    "episode non-boolean can_mark_off": rpcPayload({
      groups: [{
        ...rpcPayload().groups[0],
        episodes: [episode({ can_mark_off: "yes" }), episode({ entry_id: ENTRY_B })],
      }],
    }),
    "episode non-boolean can_self_withdraw": rpcPayload({
      groups: [{
        ...rpcPayload().groups[0],
        episodes: [episode({ can_self_withdraw: 1 }), episode({ entry_id: ENTRY_B })],
      }],
    }),
    "episode unknown status": rpcPayload({
      groups: [{
        ...rpcPayload().groups[0],
        episodes: [episode({ latest_status: "MAYBE" }), episode({ entry_id: ENTRY_B })],
      }],
    }),
    "episode active disagrees with status (ON with active=false)": rpcPayload({
      groups: [{
        ...rpcPayload().groups[0],
        episodes: [
          episode({ latest_status: "ON", active: false }),
          episode({ entry_id: ENTRY_B, latest_status: "ON", active: true }),
        ],
      }],
    }),
    "episode active disagrees with status (UNCONFIRMED with active=true)": rpcPayload({
      groups: [{
        ...rpcPayload().groups[0],
        episodes: [
          episode({ latest_status: "ON", active: true }),
          episode({ entry_id: ENTRY_B, latest_status: "UNCONFIRMED", active: true, can_mark_off: false, can_self_withdraw: false }),
        ],
      }],
    }),
    "episode active disagrees with status (OFF with active=true)": rpcPayload({
      groups: [{
        ...rpcPayload().groups[0],
        episodes: [
          episode({ latest_status: "ON", active: true }),
          episode({ entry_id: ENTRY_B, latest_status: "OFF", active: true, can_mark_off: false, can_self_withdraw: false }),
        ],
      }],
    }),
    "non-ON episode with can_mark_off=true": rpcPayload({
      groups: [{
        ...rpcPayload().groups[0],
        active_profile_count: 1,
        episodes: [
          episode({ latest_status: "ON", active: true, can_self_withdraw: false }),
          episode({ entry_id: ENTRY_B, latest_status: "OFF", active: false, can_mark_off: true, can_self_withdraw: false }),
        ],
      }],
    }),
    "non-ON episode with can_self_withdraw=true": rpcPayload({
      groups: [{
        ...rpcPayload().groups[0],
        active_profile_count: 1,
        episodes: [
          episode({ latest_status: "ON", active: true, can_self_withdraw: false }),
          episode({ entry_id: ENTRY_B, latest_status: "UNCONFIRMED", active: false, can_mark_off: false, can_self_withdraw: true }),
        ],
      }],
    }),
    "can_self_withdraw=true when active_profile_count < 2": rpcPayload({
      groups: [{
        ...rpcPayload().groups[0],
        active_profile_count: 1,
        episodes: [
          episode({ latest_status: "ON", active: true, can_self_withdraw: true }),
          episode({ entry_id: ENTRY_B, latest_status: "OFF", active: false, can_mark_off: false, can_self_withdraw: false }),
        ],
      }],
    }),
    "active_profile_count disagrees with ON episode count": rpcPayload({
      groups: [{
        ...rpcPayload().groups[0],
        active_profile_count: 2,
        episodes: [
          episode({ latest_status: "ON", active: true, can_self_withdraw: false }),
          episode({ entry_id: ENTRY_B, latest_status: "OFF", active: false, can_mark_off: false, can_self_withdraw: false }),
        ],
      }],
    }),
    "more groups than page_size": rpcPayload({
      page_size: 1,
      has_more: false,
      groups: [rpcPayload().groups[0], rpcPayload().groups[0]],
    }),
  };
  for (const [label, payload] of Object.entries(cases)) {
    assert.equal(projectDuplicateCccdReportRpcPage(payload, { page: 1, page_size: 25 }), null, label);
  }
});

test("projection accepts valid ON+OFF, OFF+OFF, ON+UNCONFIRMED, and UNCONFIRMED+UNCONFIRMED groups", () => {
  const combinations = [
    {
      label: "ON + OFF",
      active_profile_count: 1,
      episodes: [
        episode({ entry_id: ENTRY_A, latest_status: "ON", active: true, can_mark_off: true, can_self_withdraw: false }),
        episode({ entry_id: ENTRY_B, latest_status: "OFF", active: false, can_mark_off: false, can_self_withdraw: false }),
      ],
    },
    {
      label: "OFF + OFF",
      active_profile_count: 0,
      episodes: [
        episode({ entry_id: ENTRY_A, latest_status: "OFF", active: false, can_mark_off: false, can_self_withdraw: false }),
        episode({ entry_id: ENTRY_B, latest_status: "OFF", active: false, can_mark_off: false, can_self_withdraw: false }),
      ],
    },
    {
      label: "ON + UNCONFIRMED",
      active_profile_count: 1,
      episodes: [
        episode({ entry_id: ENTRY_A, latest_status: "ON", active: true, can_mark_off: true, can_self_withdraw: false }),
        episode({ entry_id: ENTRY_B, latest_status: "UNCONFIRMED", active: false, can_mark_off: false, can_self_withdraw: false }),
      ],
    },
    {
      label: "UNCONFIRMED + UNCONFIRMED",
      active_profile_count: 0,
      episodes: [
        episode({ entry_id: ENTRY_A, latest_status: "UNCONFIRMED", active: false, can_mark_off: false, can_self_withdraw: false }),
        episode({ entry_id: ENTRY_B, latest_status: "UNCONFIRMED", active: false, can_mark_off: false, can_self_withdraw: false }),
      ],
    },
  ];

  for (const combo of combinations) {
    const raw = rpcPayload({
      groups: [{
        ...rpcPayload().groups[0],
        project_count: 1,
        active_profile_count: combo.active_profile_count,
        episodes: combo.episodes,
      }],
    });
    const page = projectDuplicateCccdReportRpcPage(raw, { page: 1, page_size: 25 });
    assert.ok(page, combo.label);
    assert.equal(page.groups[0].active_profile_count, combo.active_profile_count, combo.label);
    assert.deepEqual(
      page.groups[0].episodes.map((e) => ({ status: e.latest_status, active: e.active })),
      combo.episodes.map((e) => ({ status: e.latest_status, active: e.active })),
      combo.label,
    );
    const wrapped = projectDuplicateCccdReportResponse({ ok: true, ...page }, { page: 1, page_size: 25 });
    assert.ok(wrapped, `${combo.label} response wrapper`);
  }
});

test("the response wrapper requires ok:true and the exact view projection", () => {
  const view = projectDuplicateCccdReportRpcPage(rpcPayload(), { page: 1, page_size: 25 });
  assert.ok(view);
  assert.ok(projectDuplicateCccdReportResponse({ ok: true, ...view }, { page: 1, page_size: 25 }));
  assert.ok(projectDuplicateCccdReportViewPage(view, { page: 1, page_size: 25 }));
  assert.equal(projectDuplicateCccdReportResponse({ ok: false, ...view }, { page: 1, page_size: 25 }), null);
  assert.equal(projectDuplicateCccdReportResponse({ ok: true, ...view, extra: 1 }, { page: 1, page_size: 25 }), null);
  assert.equal(projectDuplicateCccdReportResponse({ ok: true, ...rpcPayload() }, { page: 1, page_size: 25 }), null);
  assert.equal(projectDuplicateCccdReportViewPage({ ...view, authority: "entry_admin" }, { page: 1, page_size: 25 }), null);
});

test("self-withdraw request and RPC result projections fail closed on malformed or extra keys", () => {
  assert.deepEqual(
    projectDuplicateCccdSelfWithdrawRequest({
      entry_id: ENTRY_A,
      expected_entry_version: 2,
      idempotency_key: "  idem-001  ",
      reason: "  Nhập trùng hồ sơ  ",
    }),
    {
      entry_id: ENTRY_A,
      expected_entry_version: 2,
      idempotency_key: "idem-001",
      reason: "Nhập trùng hồ sơ",
    },
  );
  assert.deepEqual(
    projectDuplicateCccdSelfWithdrawRequest({
      entry_id: ENTRY_A,
      expected_entry_version: 1,
      idempotency_key: "idem-002",
      reason: "   ",
    }),
    {
      entry_id: ENTRY_A,
      expected_entry_version: 1,
      idempotency_key: "idem-002",
      reason: null,
    },
  );

  for (const bad of [
    null,
    [],
    { entry_id: "bad", expected_entry_version: 1, idempotency_key: "k" },
    { entry_id: ENTRY_A, expected_entry_version: 0, idempotency_key: "k" },
    { entry_id: ENTRY_A, expected_entry_version: 1, idempotency_key: "   " },
    { entry_id: ENTRY_A, expected_entry_version: 1, idempotency_key: "x".repeat(129) },
    { entry_id: ENTRY_A, expected_entry_version: 1, idempotency_key: "k", reason: "x".repeat(1001) },
    { entry_id: ENTRY_A, expected_entry_version: 1, idempotency_key: "k", extra: 1 },
  ]) {
    assert.equal(projectDuplicateCccdSelfWithdrawRequest(bad), null, JSON.stringify(bad));
  }

  assert.deepEqual(
    projectDuplicateCccdSelfWithdrawRpcResult({ entry_id: ENTRY_A, version: 3 }, ENTRY_A),
    { entry_id: ENTRY_A, version: 3 },
  );
  assert.equal(projectDuplicateCccdSelfWithdrawRpcResult({ entry_id: ENTRY_B, version: 3 }, ENTRY_A), null);
  assert.equal(projectDuplicateCccdSelfWithdrawRpcResult({ entry_id: ENTRY_A, version: 0 }, ENTRY_A), null);
  assert.equal(projectDuplicateCccdSelfWithdrawRpcResult({ entry_id: ENTRY_A, version: 3, extra: true }, ENTRY_A), null);

  assert.match(duplicateCccdSelfWithdrawErrorMessage(403, "SELF_WITHDRAW_DENIED"), /người đã tạo hồ sơ/);
  assert.match(duplicateCccdSelfWithdrawErrorMessage(409, "DUPLICATE_NO_LONGER_ACTIVE"), /nhóm CCCD trùng/);
  assert.match(duplicateCccdSelfWithdrawErrorMessage(409, "VERSION_CONFLICT"), /tải lại/);
  assert.match(duplicateCccdSelfWithdrawErrorMessage(422, "SELF_WITHDRAW_INVALID"), /không hợp lệ/);
  assert.match(duplicateCccdSelfWithdrawErrorMessage(500, "SELF_WITHDRAW_UNAVAILABLE"), /thử lại/);
});

test("masked CCCD and status labels never expose the full identifier", () => {
  assert.equal(maskedCccd("8901", 12), "••••••••8901");
  assert.equal(maskedCccd("4321", 9), "•••••4321");
  assert.equal(maskedCccd("8901", 12).includes("8901"), true);
  assert.equal(employmentStatusLabel("ON"), "Đang làm");
  assert.equal(employmentStatusLabel("UNCONFIRMED"), "Đang chờ việc");
  assert.equal(employmentStatusLabel("OFF"), "Đã nghỉ");
});

test("output projections never list authority, project_id, or created_by_user_id as client fields", () => {
  assert.equal(DUPLICATE_CCCD_REPORT_PAGE_KEYS.includes("authority"), false);
  assert.equal(DUPLICATE_CCCD_REPORT_GROUP_KEYS.includes("authority"), false);
  assert.equal(DUPLICATE_CCCD_REPORT_EPISODE_KEYS.includes("project_id"), false);
  assert.equal(DUPLICATE_CCCD_REPORT_EPISODE_KEYS.includes("authority"), false);
  assert.equal(DUPLICATE_CCCD_REPORT_EPISODE_KEYS.includes("created_by_user_id"), false);
  assert.equal(DUPLICATE_CCCD_REPORT_EPISODE_KEYS.includes("project_display"), true);
  assert.equal(DUPLICATE_CCCD_REPORT_EPISODE_KEYS.includes("entry_id"), true);
  assert.equal(DUPLICATE_CCCD_REPORT_EPISODE_KEYS.includes("entry_version"), true);
  assert.equal(DUPLICATE_CCCD_REPORT_EPISODE_KEYS.includes("can_mark_off"), true);
  assert.equal(DUPLICATE_CCCD_REPORT_EPISODE_KEYS.includes("can_self_withdraw"), true);
});
