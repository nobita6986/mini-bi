import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKER_DIRECTORY_DEFAULT_PAGE_SIZE,
  WORKER_DIRECTORY_MAX_PAGE_SIZE,
  projectWorkerDirectoryPage,
  projectWorkerDirectoryQuery,
  projectWorkerDirectoryRow,
} from "./worker-directory-contract.ts";

const entryId = "c1000000-0000-4000-8000-000000000001";
const recruiterId = "d1000000-0000-4000-8000-000000000001";
const requestId = "e1000000-0000-4000-8000-000000000001";
const cursor = "20261008:" + entryId;
const decidedAt = "2026-10-08T09:00:00.000000Z";

const row = {
  entry_id: entryId,
  entry_version: 3,
  submission_state: "SUBMITTED",
  employee_code: "hrp-2026-300001",
  display_name: "Worker One",
  project_id: "proj_a",
  project_display: "Project A",
  first_work_date: "2026-10-01",
  labor_type: "TEMPORARY",
  employment_status: "ON",
  recruiter_id: recruiterId,
  recruiter_display: "Recruiter A",
  payment: {
    state: "provided", account_number: "••••••••8901", bank_id: null,
    account_holder_name: "Synthetic Holder", version: 1,
  },
  pending_request: { request_id: requestId, state: "PENDING", version: 1 },
  last_decision: { state: "REJECTED", decided_at: decidedAt },
  is_project_manager: true,
  allowed_actions: {
    view: true, view_pii: false, view_payment: true,
    propose_change: false, propose_change_code: "PROPOSE_PENDING_W04_POLICY",
  },
};
const page = {
  items: [row], scope: "managed", page_size: 25, has_more: false, next_cursor: null,
  authorization_date: "2026-10-08",
};

function query(search) {
  return projectWorkerDirectoryQuery(new URLSearchParams(search));
}

test("query accepts only the documented scope/filter/paging keys", () => {
  const parsed = query("scope=managed&project_id=proj_a&recruiter_id=" + recruiterId +
    "&employment_status=ON&cursor=" + cursor + "&page_size=50");
  assert.deepEqual(parsed, {
    ok: true,
    value: {
      scope: "managed", project_id: "proj_a", recruiter_id: recruiterId,
      employment_status: "ON", cursor, page_size: 50,
    },
  });

  const defaults = query("scope=recruited");
  assert.equal(defaults.ok, true);
  assert.deepEqual(defaults.value, {
    scope: "recruited", project_id: null, recruiter_id: null,
    employment_status: null, cursor: null, page_size: WORKER_DIRECTORY_DEFAULT_PAGE_SIZE,
  });

  for (const invalid of [
    "",                                            // scope bat buoc
    "scope=",
    "scope=everything",
    "scope=managed&scope=all",                     // trung key
    "scope=managed&order=first_work_date",         // client khong dieu khien sort
    "scope=managed&offset=10",
    "scope=managed&page_size=0",
    "scope=managed&page_size=101",
    "scope=managed&page_size=" + (WORKER_DIRECTORY_MAX_PAGE_SIZE + 1),
    "scope=managed&page_size=abc",
    "scope=managed&cursor=nope",
    "scope=managed&cursor=20261008:not-a-uuid",
    "scope=managed&project_id=bad project",
    "scope=managed&recruiter_id=not-a-uuid",
    "scope=managed&employment_status=MAYBE",
  ]) {
    assert.deepEqual(query(invalid), { ok: false, code: "WORKER_QUERY_INVALID" }, invalid);
  }
});

test("row projection accepts the exact server shape and rejects drift", () => {
  const projected = projectWorkerDirectoryRow(row);
  assert.equal(projected.entry_id, entryId);
  assert.equal(projected.payment.account_number, "••••••••8901");
  assert.equal(projected.allowed_actions.propose_change, false);

  const variants = {
    "extra key": { ...row, national_id: "012345678901" },
    "missing key": { ...row, allowed_actions: undefined },
    "unknown key in payment": { ...row, payment: { ...row.payment, iban: "x" } },
    "non submitted state": { ...row, submission_state: "DRAFT" },
    "bad employee code": { ...row, employee_code: "nope" },
    "bad entry version": { ...row, entry_version: 0 },
    "bad employment status": { ...row, employment_status: "MAYBE" },
    "bad project id": { ...row, project_id: "" },
    "bad payment state": { ...row, payment: { ...row.payment, state: "nope" } },
    "pending not pending": {
      ...row, pending_request: { ...row.pending_request, state: "APPROVED" },
    },
    "decision without timestamp": {
      ...row, last_decision: { state: "REJECTED", decided_at: "2026-10-08" },
    },
    "actions view false": {
      ...row, allowed_actions: { ...row.allowed_actions, view: false },
    },
    "actions missing flag": {
      ...row, allowed_actions: { view: true, propose_change: false },
    },
    "payment string": { ...row, payment: "0912345678" },
  };
  for (const [label, value] of Object.entries(variants)) {
    assert.equal(projectWorkerDirectoryRow(value), null, label);
  }
});

test("page projection enforces scope, page size and cursor consistency", () => {
  const projected = projectWorkerDirectoryPage(page, { scope: "managed", page_size: 25 });
  assert.equal(projected.items.length, 1);
  assert.deepEqual(projected.items[0], projectWorkerDirectoryRow(row));

  const variants = {
    "scope mismatch": { ...page, scope: "recruited" },
    "page size mismatch": { ...page, page_size: 50 },
    "extra page key": { ...page, total: 1 },
    "has_more without cursor": { ...page, has_more: true },
    "cursor without has_more": { ...page, next_cursor: cursor },
    "bad authorization date": { ...page, authorization_date: "08/10/2026" },
    "bad item": { ...page, items: [{ ...row, labor_type: "CONTRACTOR" }] },
  };
  for (const [label, value] of Object.entries(variants)) {
    assert.equal(projectWorkerDirectoryPage(value, { scope: "managed", page_size: 25 }), null, label);
  }
  assert.equal(
    projectWorkerDirectoryPage({ ...page, page_size: 1, items: [row, row] },
      { scope: "managed", page_size: 1 }),
    null, "a page may never carry more rows than the requested page size");
});
