import assert from "node:assert/strict";
import test from "node:test";

import {
  LIST_DEFAULT_PAGE_SIZE,
  LIST_MAX_PAGE_SIZE,
  projectChangeRequestDetail,
  projectChangeRequestListPage,
  projectChangeRequestListQuery,
} from "./change-request-read-contract.ts";

const entryA = "c1000000-0000-4000-8000-000000000001";
const entryB = "c1000000-0000-4000-8000-000000000002";
const requestId = "d1000000-0000-4000-8000-000000000001";
const otherRequestId = "d1000000-0000-4000-8000-000000000002";
const createdAt = "2026-10-03T10:00:00.000000Z";
const cursor = "20261003100400000000:" + otherRequestId;

function listItem(overrides = {}) {
  return {
    request_id: requestId,
    state: "PENDING",
    version: 1,
    created_at: createdAt,
    item_count: 1,
    entry_ids: [entryA],
    can_withdraw: true,
    can_decide: false,
    ...overrides,
  };
}

function listPage(overrides = {}) {
  return {
    requests: [listItem()],
    page_size: LIST_DEFAULT_PAGE_SIZE,
    has_more: false,
    next_cursor: null,
    ...overrides,
  };
}

function detailBody(overrides = {}) {
  return {
    request_id: requestId,
    state: "PENDING",
    version: 1,
    created_at: createdAt,
    items: [{
      entry_id: entryA,
      target_kind: "ENTRY_FIELD",
      expected_version: 1,
      proposal: { labor_type: "PERMANENT" },
    }],
    can_withdraw: false,
    can_decide: true,
    ...overrides,
  };
}

function query(text) {
  return projectChangeRequestListQuery(new URLSearchParams(text));
}

test("list query accepts only page_size, cursor and the locked state vocabulary", () => {
  assert.deepEqual(query("").value, { page_size: LIST_DEFAULT_PAGE_SIZE, cursor: null, state: null });
  assert.equal(query("page_size=1").value.page_size, 1);
  assert.equal(query("page_size=" + LIST_MAX_PAGE_SIZE).value.page_size, LIST_MAX_PAGE_SIZE);
  assert.equal(query("cursor=" + cursor).value.cursor, cursor);
  for (const state of ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"]) {
    assert.equal(query("state=" + state).value.state, state);
  }
  assert.deepEqual(query("page_size=2&state=PENDING&cursor=" + cursor).value, {
    page_size: 2, cursor, state: "PENDING",
  });
});

test("invalid or unknown list query parameters fail closed", () => {
  for (const text of [
    "page_size=0", "page_size=51", "page_size=abc", "page_size=1.5", "page_size=", "page_size=-1",
    "page_size=020",
    "cursor=not-a-cursor", "cursor=20261003100400000000", "cursor=",
    "state=pending", "state=UNKNOWN", "state=",
    "order=created_at", "offset=10", "limit=5", "column=state", "sql=1",
    "page_size=2&page_size=3",
  ]) {
    assert.deepEqual(query(text), { ok: false, code: "CHANGE_REQUEST_QUERY_INVALID" }, text);
  }
});
test("list page projection is exact and rejects coerced values", () => {
  assert.deepEqual(projectChangeRequestListPage(listPage(), { page_size: LIST_DEFAULT_PAGE_SIZE }), {
    requests: [listItem()],
    page_size: LIST_DEFAULT_PAGE_SIZE,
    has_more: false,
    next_cursor: null,
  });
  const twoItems = listItem({ item_count: 2, entry_ids: [entryA, entryB] });
  const secondPage = listPage({ requests: [twoItems], has_more: true, next_cursor: cursor });
  assert.deepEqual(projectChangeRequestListPage(secondPage, { page_size: LIST_DEFAULT_PAGE_SIZE }), {
    requests: [twoItems],
    page_size: LIST_DEFAULT_PAGE_SIZE,
    has_more: true,
    next_cursor: cursor,
  });

  const rejected = [
    listPage({ extra: 1 }),
    { requests: [listItem()], page_size: LIST_DEFAULT_PAGE_SIZE, has_more: false },
    listPage({ page_size: 5 }),
    listPage({ has_more: false, next_cursor: cursor }),
    listPage({ has_more: true, next_cursor: null }),
    listPage({ has_more: true, next_cursor: "nope" }),
    listPage({ has_more: 0 }),
    listPage({ requests: "[]", has_more: false, next_cursor: null }),
    listPage({ requests: [listItem({ state: "pending" })] }),
    listPage({ requests: [listItem({ version: 0 })] }),
    listPage({ requests: [listItem({ item_count: 2 })] }),
    listPage({ requests: [listItem({ entry_ids: [entryA, entryA], item_count: 2 })] }),
    listPage({ requests: [listItem({ entry_ids: [] })] }),
    listPage({ requests: [listItem({ can_withdraw: 1 })] }),
    listPage({ requests: [listItem({ can_decide: "false" })] }),
    listPage({ requests: [listItem({ can_withdraw: true, can_decide: true })] }),
    listPage({ requests: [listItem({ created_at: "2026-10-03T10:00:00Z" })] }),
    listPage({ requests: [listItem({ request_id: "not-a-uuid" })] }),
    listPage({ requests: [listItem({ created_by_user_id: entryA })] }),
  ];
  for (const [index, payload] of rejected.entries()) {
    assert.equal(
      projectChangeRequestListPage(payload, { page_size: LIST_DEFAULT_PAGE_SIZE }),
      null,
      String(index),
    );
  }
  assert.equal(
    projectChangeRequestListPage(
      listPage({ requests: [listItem(), listItem(), listItem()] }),
      { page_size: 2 },
    ),
    null,
  );
});

test("detail projection is exact, vocabulary-bound and never partial", () => {
  assert.deepEqual(projectChangeRequestDetail(detailBody(), { request_id: requestId }), detailBody());

  const payment = detailBody({
    items: [{
      entry_id: entryA,
      target_kind: "PAYMENT",
      expected_version: 2,
      proposal: { state: "unknown", account_number: null, bank_id: null, account_holder_name: null },
    }],
  });
  assert.deepEqual(projectChangeRequestDetail(payment, { request_id: requestId }), payment);

  // Presence-only marker cua worker_details (server redact khi thieu pii_view) van la record hop le.
  const presenceOnly = detailBody({
    items: [{
      entry_id: entryA,
      target_kind: "ENTRY_FIELD",
      expected_version: 2,
      proposal: { worker_details: { present: true } },
    }],
  });
  assert.deepEqual(projectChangeRequestDetail(presenceOnly, { request_id: requestId }), presenceOnly);

  const badProposal = {
    entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1,
    proposal: { labor_type: "PERMANENT", unknown_field: 1 },
  };
  const rejected = [
    detailBody({ extra: 1 }),
    detailBody({ request_id: otherRequestId }),
    detailBody({ state: "pending" }),
    detailBody({ version: 0 }),
    detailBody({ created_at: "03/10/2026 10:00:00" }),
    detailBody({ items: [] }),
    detailBody({ items: "[]" }),
    detailBody({ items: [{ entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1, proposal: {} }] }),
    detailBody({ items: [badProposal] }),
    detailBody({ items: [{
      entry_id: entryA, target_kind: "UNKNOWN", expected_version: 1,
      proposal: { labor_type: "PERMANENT" },
    }] }),
    detailBody({ items: [
      { entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1,
        proposal: { labor_type: "PERMANENT" } },
      { entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1,
        proposal: { labor_type: "TEMPORARY" } },
    ] }),
    detailBody({ items: [{
      entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1,
      proposal: { labor_type: "PERMANENT" }, reason: "x",
    }] }),
    detailBody({ can_withdraw: true, can_decide: true }),
    detailBody({ can_withdraw: null }),
    detailBody({ reason: "S02B reason" }),
    detailBody({ proposer_user_id: entryA }),
    detailBody({ reviewer_user_id: entryA }),
    // S03B3-R1: raw sensitive key trong proposal phai bi reject (fail-closed o boundary).
    detailBody({ items: [{
      entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1,
      proposal: { labor_type: "PERMANENT", idempotency_key: "s03b3r1" },
    }] }),
    detailBody({ items: [{
      entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1,
      proposal: { worker_details: { present: true, storage_key: "p1.6/synthetic" } },
    }] }),
    detailBody({ items: [{
      entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1,
      proposal: { worker_details: { checksum_sha256: "a".repeat(64) } },
    }] }),
    // PAYMENT da bi mask o server: gia tri khong con la account number hop le => fail-closed.
    detailBody({ items: [{
      entry_id: entryA, target_kind: "PAYMENT", expected_version: 1,
      proposal: { state: "provided", account_number: "••••6789" },
    }] }),
  ];
  for (const [index, payload] of rejected.entries()) {
    assert.equal(projectChangeRequestDetail(payload, { request_id: requestId }), null, String(index));
  }
});
