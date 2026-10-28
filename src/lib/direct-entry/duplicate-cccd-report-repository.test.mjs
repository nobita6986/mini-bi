import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDuplicateCccdReportError,
  createDuplicateCccdReportRepository,
  DUPLICATE_CCCD_REPORT_RPC_NAMES,
} from "./duplicate-cccd-report-repository.ts";
import {
  classifyDuplicateCccdSelfWithdrawError,
  createDuplicateCccdSelfWithdrawRepository,
  DUPLICATE_CCCD_SELF_WITHDRAW_RPC_NAMES,
} from "./duplicate-cccd-self-withdraw-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const ENTRY_A = "c1000000-0000-4000-8000-000000000001";
const ENTRY_B = "c1000000-0000-4000-8000-000000000002";

function validData(overrides = {}) {
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
      project_count: 1,
      active_profile_count: 2,
      first_work_date: "2026-01-05",
      latest_first_work_date: "2026-02-10",
      episodes: [
        {
          entry_id: ENTRY_A,
          entry_version: 1,
          employee_code: "hrp-2026-800001",
          display_name: "A",
          project_id: "proj_a",
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
          project_id: "proj_a",
          project_display: "Project A",
          first_work_date: "2026-02-10",
          latest_status: "ON",
          active: true,
          can_mark_off: true,
          can_self_withdraw: false,
        },
      ],
    }],
    ...overrides,
  };
}

test("the repository calls only the report RPC with the server actor, paging and managed_only", async () => {
  const calls = [];
  const repository = createDuplicateCccdReportRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: validData(), error: null };
  });
  const result = await repository.report({ ...actor, page: 1, page_size: 25 });
  assert.equal(result.ok, true);
  assert.equal(result.data.total_groups, 1);

  const managedResult = await repository.report({ ...actor, page: 1, page_size: 25, managed_only: true });
  assert.equal(managedResult.ok, true);

  assert.deepEqual(calls, [
    {
      name: "direct_entry_duplicate_cccd_report",
      args: {
        p_auth_subject: actor.auth_subject,
        p_app_user_id: actor.app_user_id,
        p_page: 1,
        p_page_size: 25,
        p_managed_only: false,
      },
    },
    {
      name: "direct_entry_duplicate_cccd_report",
      args: {
        p_auth_subject: actor.auth_subject,
        p_app_user_id: actor.app_user_id,
        p_page: 1,
        p_page_size: 25,
        p_managed_only: true,
      },
    },
  ]);
  assert.deepEqual(DUPLICATE_CCCD_REPORT_RPC_NAMES, ["direct_entry_duplicate_cccd_report"]);
});

test("denial and invalid database codes map to sanitized kinds", async () => {
  assert.equal(classifyDuplicateCccdReportError({ code: "42501" }), "denied");
  assert.equal(classifyDuplicateCccdReportError({ code: "22023" }), "invalid");
  assert.equal(classifyDuplicateCccdReportError({ code: "XX000" }), "unavailable");
  assert.equal(classifyDuplicateCccdReportError({}), "unavailable");
  for (const [error, kind] of [
    [{ code: "42501" }, "denied"],
    [{ code: "22023" }, "invalid"],
    [{ code: "ZZZZZ" }, "unavailable"],
  ]) {
    const repository = createDuplicateCccdReportRepository(async () => ({ data: null, error }));
    const result = await repository.report({ ...actor, page: 1, page_size: 25 });
    assert.deepEqual(result, { ok: false, kind }, JSON.stringify(error));
    assert.equal("data" in result, false);
  }
});

test("malformed payloads fail closed and transport failures never leak the raw error", async () => {
  const payloads = [
    null,
    [],
    "OK",
    validData({ authority: "entry_admin_only" }),
    validData({ page: 2 }),
    validData({ has_more: true }),
    validData({ groups: [{ ...validData().groups[0], cccd_last4: "89" }] }),
    validData({ groups: [{ ...validData().groups[0], episodes: [validData().groups[0].episodes[0]] }] }),
  ];
  for (const payload of payloads) {
    const repository = createDuplicateCccdReportRepository(async () => ({ data: payload, error: null }));
    assert.deepEqual(
      await repository.report({ ...actor, page: 1, page_size: 25 }),
      { ok: false, kind: "unavailable" },
      JSON.stringify(payload),
    );
  }

  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const repository = createDuplicateCccdReportRepository(async () => {
      throw new Error("private app_user 92000000 secret");
    });
    const result = await repository.report({ ...actor, page: 1, page_size: 25 });
    assert.deepEqual(result, { ok: false, kind: "unavailable" });
    assert.doesNotMatch(JSON.stringify(result), /92000000|private/);
    assert.doesNotMatch(logged.join(" "), /92000000|private/);
  } finally {
    console.error = originalError;
  }
});

test("self-withdraw repository calls only direct_entry_self_withdraw_duplicate_cccd and maps SQLSTATE codes cleanly", async () => {
  assert.deepEqual(
    DUPLICATE_CCCD_SELF_WITHDRAW_RPC_NAMES,
    ["direct_entry_self_withdraw_duplicate_cccd"],
  );

  const calls = [];
  const repository = createDuplicateCccdSelfWithdrawRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: { entry_id: ENTRY_A, version: 2 }, error: null };
  });

  const ok = await repository.selfWithdraw({
    ...actor,
    entry_id: ENTRY_A,
    expected_version: 1,
    reason: "Nhập trùng",
    idempotency_key: "idem-self-1",
  });
  assert.deepEqual(ok, { ok: true, data: { entry_id: ENTRY_A, version: 2 } });
  assert.deepEqual(calls, [{
    name: "direct_entry_self_withdraw_duplicate_cccd",
    args: {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_entry_id: ENTRY_A,
      p_expected_version: 1,
      p_reason: "Nhập trùng",
      p_idempotency_key: "idem-self-1",
    },
  }]);

  assert.deepEqual(
    classifyDuplicateCccdSelfWithdrawError({ code: "42501", message: "self withdraw requires entry creator" }),
    { ok: false, kind: "denied", code: "SELF_WITHDRAW_DENIED" },
  );
  assert.deepEqual(
    classifyDuplicateCccdSelfWithdrawError({ code: "P0002", message: "entry not found" }),
    { ok: false, kind: "not-found", code: "ENTRY_NOT_FOUND" },
  );
  assert.deepEqual(
    classifyDuplicateCccdSelfWithdrawError({ code: "40001", message: "entry already voided" }),
    { ok: false, kind: "conflict", code: "ENTRY_ALREADY_VOIDED" },
  );
  assert.deepEqual(
    classifyDuplicateCccdSelfWithdrawError({ code: "40001", message: "self withdraw target is not an active duplicate" }),
    { ok: false, kind: "conflict", code: "DUPLICATE_NO_LONGER_ACTIVE" },
  );
  assert.deepEqual(
    classifyDuplicateCccdSelfWithdrawError({ code: "40001", message: "entry version conflict" }),
    { ok: false, kind: "conflict", code: "VERSION_CONFLICT" },
  );
  assert.deepEqual(
    classifyDuplicateCccdSelfWithdrawError({ code: "PT409", message: "entry version conflict" }),
    { ok: false, kind: "conflict", code: "VERSION_CONFLICT" },
  );
  assert.deepEqual(
    classifyDuplicateCccdSelfWithdrawError({ code: "22023", message: "reason exceeds maximum length" }),
    { ok: false, kind: "invalid", code: "SELF_WITHDRAW_INVALID" },
  );
  assert.deepEqual(
    classifyDuplicateCccdSelfWithdrawError({ code: "XX000", message: "internal secret" }),
    { ok: false, kind: "unavailable", code: "SELF_WITHDRAW_UNAVAILABLE" },
  );
});
