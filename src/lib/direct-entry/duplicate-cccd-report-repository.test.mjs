import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDuplicateCccdReportError,
  createDuplicateCccdReportRepository,
  DUPLICATE_CCCD_REPORT_RPC_NAMES,
} from "./duplicate-cccd-report-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};

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
        { employee_code: "hrp-2026-800001", display_name: "A", project_id: "proj_a",
          project_display: "Project A", first_work_date: "2026-01-05",
          latest_status: "ON", active: true },
        { employee_code: "hrp-2026-800002", display_name: "B", project_id: "proj_a",
          project_display: "Project A", first_work_date: "2026-02-10",
          latest_status: "ON", active: true },
      ],
    }],
    ...overrides,
  };
}

test("the repository calls only the report RPC with the server actor and paging", async () => {
  const calls = [];
  const repository = createDuplicateCccdReportRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: validData(), error: null };
  });
  const result = await repository.report({ ...actor, page: 1, page_size: 25 });
  assert.equal(result.ok, true);
  assert.equal(result.data.total_groups, 1);
  assert.deepEqual(calls, [{
    name: "direct_entry_duplicate_cccd_report",
    args: {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_page: 1,
      p_page_size: 25,
    },
  }]);
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
