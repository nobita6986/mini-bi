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
    proposer_display_name: "Người đề xuất thử nghiệm",
    summary: "Trạng thái làm việc",
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
    request_reason: "Cập nhật hồ sơ theo xác nhận của PM.",
    items: [{
      entry_id: entryA,
      target_kind: "ENTRY_FIELD",
      expected_version: 1,
      proposal: { labor_type: "PERMANENT" },
      labor_type_display: "Chính thức",
    }],
    can_withdraw: false,
    can_decide: true,
    ...overrides,
  };
}

function query(text) {
  return projectChangeRequestListQuery(new URLSearchParams(text));
}

test("list query accepts the exact state and history-window vocabulary", () => {
  assert.deepEqual(query("").value, { page_size: LIST_DEFAULT_PAGE_SIZE, cursor: null, state: null, days: null });
  assert.equal(query("page_size=1").value.page_size, 1);
  assert.equal(query("page_size=" + LIST_MAX_PAGE_SIZE).value.page_size, LIST_MAX_PAGE_SIZE);
  assert.equal(query("cursor=" + cursor).value.cursor, cursor);
  for (const state of [
    "PENDING",
    "APPROVED",
    "REJECTED",
    "WITHDRAWN",
    "RESOLVED",
    "PROPOSER_PENDING",
    "PROPOSER_RESOLVED",
    "REVIEWER_PENDING",
    "REVIEWER_RESOLVED",
  ]) {
    assert.equal(query("state=" + state).value.state, state);
  }
  assert.deepEqual(query("page_size=2&state=PENDING&cursor=" + cursor).value, {
    page_size: 2, cursor, state: "PENDING", days: null,
  });
  assert.deepEqual(query("page_size=15&state=REVIEWER_RESOLVED&cursor=" + cursor).value, {
    page_size: 15, cursor, state: "REVIEWER_RESOLVED", days: null,
  });
  assert.deepEqual(query("state=GLOBAL_AUDIT&days=3").value,
    { page_size: LIST_DEFAULT_PAGE_SIZE, cursor: null, state: "GLOBAL_AUDIT", days: 3 });
  assert.deepEqual(query("state=GLOBAL_AUDIT&days=all").value,
    { page_size: LIST_DEFAULT_PAGE_SIZE, cursor: null, state: "GLOBAL_AUDIT", days: null });
});

test("invalid or unknown list query parameters fail closed", () => {
  for (const text of [
    "page_size=0", "page_size=51", "page_size=abc", "page_size=1.5", "page_size=", "page_size=-1",
    "page_size=020",
    "cursor=not-a-cursor", "cursor=20261003100400000000", "cursor=",
    "state=pending", "state=proposer_pending", "state=UNKNOWN", "state=",
    "state=GLOBAL_AUDIT", "state=GLOBAL_AUDIT&days=2", "state=PENDING&days=3",
    "state=PROPOSER_PENDING&days=3", "state=REVIEWER_RESOLVED&days=7", "days=all",
    "order=created_at", "offset=10", "limit=5", "column=state", "sql=1",
    "page_size=2&page_size=3",
  ]) {
    assert.deepEqual(query(text), { ok: false, code: "CHANGE_REQUEST_QUERY_INVALID" }, text);
  }
});

test("global audit projection requires decision actor and timestamp and accepts no extra fields", () => {
  const auditItem = {
    ...listItem({ state: "APPROVED", can_withdraw: false, can_decide: false }),
    decided_by_display_name: "Approver",
    decided_at: "2026-10-16T10:00:00.000000Z",
  };
  const page = listPage({ requests: [auditItem] });
  assert.deepEqual(projectChangeRequestListPage(page, { page_size: LIST_DEFAULT_PAGE_SIZE, audit: true }), page);
  assert.equal(projectChangeRequestListPage(page, { page_size: LIST_DEFAULT_PAGE_SIZE }), null);
  for (const invalid of [
    { ...auditItem, decided_by_display_name: " " },
    { ...auditItem, decided_at: "2026-10-16T10:00:00Z" },
    Object.fromEntries(Object.entries(auditItem).filter(([key]) => key !== "decided_at")),
    { ...auditItem, extra: true },
  ]) {
    assert.equal(projectChangeRequestListPage(listPage({ requests: [invalid] }),
      { page_size: LIST_DEFAULT_PAGE_SIZE, audit: true }), null);
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
    listPage({ requests: [listItem({ proposer_display_name: " " })] }),
    listPage({ requests: [listItem({ summary: "" })] }),
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
  assert.equal(projectChangeRequestDetail(detailBody({ request_reason: null }),
    { request_id: requestId })?.request_reason, null);

  const payment = detailBody({
    items: [{
      entry_id: entryA,
      target_kind: "PAYMENT",
      expected_version: 2,
      proposal: { state: "unknown", account_number: null, bank_id: null, account_holder_name: null },
      labor_type_display: null,
    }],
  });
  assert.deepEqual(projectChangeRequestDetail(payment, { request_id: requestId }), payment);

  const partialPayment = detailBody({
    items: [{
      entry_id: entryA, target_kind: "PAYMENT", expected_version: 1,
      proposal: { state: "provided", account_number: "ACCT-AB123", bank_id: null,
        account_holder_name: null },
      labor_type_display: null,
    }],
  });
  assert.deepEqual(projectChangeRequestDetail(partialPayment, { request_id: requestId }), partialPayment,
    "the persisted review read contract retains valid partial R4 account text");

  const onStatusWithCanonicalNull = detailBody({
    items: [{
      entry_id: entryA, target_kind: "WORK_STATUS", expected_version: 1,
      proposal: { status: "ON", effective_date: "2026-10-01", leave_reason: null },
      labor_type_display: null,
    }],
  });
  assert.deepEqual(projectChangeRequestDetail(onStatusWithCanonicalNull, { request_id: requestId }),
    onStatusWithCanonicalNull);

  // Legacy masked response shape must be rejected at the strict projection boundary.
  const masked = detailBody({
    items: [{
      entry_id: entryA, target_kind: "PAYMENT", expected_version: 1,
      proposal: { state: "provided", account_number: "••••6789" },
      labor_type_display: null,
    }],
  });
  assert.equal(projectChangeRequestDetail(masked, { request_id: requestId }), null);
  const workStatus = detailBody({
    items: [{
      entry_id: entryA, target_kind: "WORK_STATUS", expected_version: 1,
      proposal: { status: "ON", effective_date: "2026-10-01" },
      labor_type_display: null,
    }],
  });
  assert.deepEqual(projectChangeRequestDetail(workStatus, { request_id: requestId }), workStatus);
  const document = detailBody({
    items: [{
      entry_id: entryA, target_kind: "DOCUMENT", expected_version: 1,
      proposal: { document_type: "EMPLOYMENT_CONTRACT", size_bytes: 2048,
        mime_type: "application/pdf" },
      labor_type_display: null,
    }],
  });
  assert.deepEqual(projectChangeRequestDetail(document, { request_id: requestId }), document);
  const entryVoid = detailBody({
    items: [{
      entry_id: entryA, target_kind: "ENTRY_VOID", expected_version: 1,
      proposal: {}, labor_type_display: null,
    }],
  });
  assert.deepEqual(projectChangeRequestDetail(entryVoid, { request_id: requestId }), entryVoid);
  assert.equal(projectChangeRequestDetail(detailBody({
    items: [{
      entry_id: entryA, target_kind: "ENTRY_VOID", expected_version: 1,
      proposal: { voided_at: "client-forged" }, labor_type_display: null,
    }],
  }), { request_id: requestId }), null);

  // Legacy presence-only marker is not a canonical worker profile and must fail closed.
  const presenceOnly = detailBody({
    items: [{
      entry_id: entryA,
      target_kind: "ENTRY_FIELD",
      expected_version: 2,
      proposal: { worker_details: { present: true } },
      labor_type_display: null,
    }],
  });
  assert.equal(projectChangeRequestDetail(presenceOnly, { request_id: requestId }), null);

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
    detailBody({ request_reason: 123 }),
    detailBody({ request_reason: " " }),
    detailBody({ request_reason: "x".repeat(4001) }),
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
    detailBody({ items: [{
      entry_id: entryA, target_kind: "DOCUMENT", expected_version: 1,
      proposal: { document_type: "EMPLOYMENT_CONTRACT", size_bytes: 0 },
    }] }),
    detailBody({ items: [{
      entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1,
      proposal: { worker_details: { present: true, extra: 1 } },
    }] }),
  ];
  for (const [index, payload] of rejected.entries()) {
    assert.equal(projectChangeRequestDetail(payload, { request_id: requestId }), null, String(index));
  }
});
