import assert from "node:assert/strict";
import test from "node:test";

import {
  LIST_DEFAULT_PAGE_SIZE,
  LIST_MAX_PAGE_SIZE,
  projectSubmissionDetail,
  projectSubmissionListPage,
  projectSubmissionListQuery,
} from "./submission-read-contract.ts";

const submissionId = "b1000000-0000-4000-8000-000000000001";
const otherSubmissionId = "b1000000-0000-4000-8000-000000000002";
const entryA = "c1000000-0000-4000-8000-000000000001";
const entryB = "c1000000-0000-4000-8000-000000000002";
const createdAt = "2026-10-04T09:00:00.000000Z";
const updatedAt = "2026-10-04T09:05:00.000000Z";
const submittedAt = "2026-10-04T09:06:00.000000Z";
const cursor = "20261004090100000000:" + otherSubmissionId;

function item(overrides = {}) {
  return {
    submission_id: submissionId,
    state: "DRAFT",
    version: 1,
    entry_count: 1,
    created_at: createdAt,
    updated_at: updatedAt,
    submitted_at: null,
    allowed_transitions: ["REVIEW"],
    ...overrides,
  };
}

function page(overrides = {}) {
  return {
    items: [item()],
    page_size: LIST_DEFAULT_PAGE_SIZE,
    has_more: false,
    next_cursor: null,
    ...overrides,
  };
}

function detailBody(overrides = {}) {
  return { ...item(), entry_ids: [entryA], ...overrides };
}

function query(text) {
  return projectSubmissionListQuery(new URLSearchParams(text));
}

test("list query accepts only page_size, cursor and the three lifecycle states", () => {
  assert.deepEqual(query("").value, { page_size: LIST_DEFAULT_PAGE_SIZE, cursor: null, state: null });
  assert.equal(query("page_size=1").value.page_size, 1);
  assert.equal(query("page_size=" + LIST_MAX_PAGE_SIZE).value.page_size, LIST_MAX_PAGE_SIZE);
  assert.equal(query("cursor=" + cursor).value.cursor, cursor);
  for (const state of ["DRAFT", "REVIEW", "SUBMITTED"]) {
    assert.equal(query("state=" + state).value.state, state);
  }
  assert.deepEqual(query("page_size=2&state=REVIEW&cursor=" + cursor).value, {
    page_size: 2, cursor, state: "REVIEW",
  });
  for (const text of [
    "page_size=0", "page_size=51", "page_size=abc", "page_size=1.5", "page_size=",
    "page_size=020", "page_size=-1",
    "cursor=not-a-cursor", "cursor=", "cursor=20261004090100000000",
    "state=draft", "state=UNKNOWN", "state=",
    "order=created_at", "offset=5", "limit=5", "column=state", "sql=1",
    "page_size=2&page_size=3",
  ]) {
    assert.deepEqual(query(text), { ok: false, code: "SUBMISSION_QUERY_INVALID" }, text);
  }
});

test("state to allowed_transitions matrix is exact for all three states", () => {
  for (const [state, transitions, submitted] of [
    ["DRAFT", ["REVIEW"], null],
    ["REVIEW", ["DRAFT", "SUBMITTED"], null],
    ["SUBMITTED", [], submittedAt],
  ]) {
    const listed = projectSubmissionListPage(page({
      items: [item({ state, allowed_transitions: transitions, submitted_at: submitted })],
    }), { page_size: LIST_DEFAULT_PAGE_SIZE });
    assert.equal(listed !== null, true, state);
    assert.deepEqual(listed.items[0].allowed_transitions, transitions, state);
  }
  const wrong = [
    item({ state: "DRAFT", allowed_transitions: ["REVIEW", "SUBMITTED"] }),
    item({ state: "DRAFT", allowed_transitions: [] }),
    item({ state: "REVIEW", allowed_transitions: ["SUBMITTED", "DRAFT"] }),
    item({ state: "REVIEW", allowed_transitions: ["DRAFT"] }),
    item({ state: "SUBMITTED", allowed_transitions: ["REVIEW"], submitted_at: submittedAt }),
    item({ state: "SUBMITTED", allowed_transitions: "[]", submitted_at: submittedAt }),
  ];
  for (const [index, broken] of wrong.entries()) {
    assert.equal(projectSubmissionListPage(page({ items: [broken] }),
      { page_size: LIST_DEFAULT_PAGE_SIZE }), null, String(index));
  }
});

test("submitted timestamp invariant and strict field types", () => {
  assert.equal(projectSubmissionListPage(page({
    items: [item({ state: "DRAFT", submitted_at: submittedAt })],
  }), { page_size: LIST_DEFAULT_PAGE_SIZE }), null);
  assert.equal(projectSubmissionListPage(page({
    items: [item({ state: "REVIEW", submitted_at: submittedAt })],
  }), { page_size: LIST_DEFAULT_PAGE_SIZE }), null);
  assert.equal(projectSubmissionListPage(page({
    items: [item({ state: "SUBMITTED", allowed_transitions: [], submitted_at: null })],
  }), { page_size: LIST_DEFAULT_PAGE_SIZE }), null);
  assert.equal(projectSubmissionListPage(page({
    items: [item({ state: "SUBMITTED", allowed_transitions: [], submitted_at: "2026-10-04T09:06:00Z" })],
  }), { page_size: LIST_DEFAULT_PAGE_SIZE }), null);

  const invalid = [
    item({ version: 0 }),
    item({ version: 1.5 }),
    item({ version: "1" }),
    item({ entry_count: -1 }),
    item({ entry_count: 1.5 }),
    item({ entry_count: "1" }),
    item({ entry_count: true }),
    item({ created_at: "2026-10-04T09:00:00Z" }),
    item({ updated_at: "not-a-date" }),
    item({ submission_id: "not-a-uuid" }),
    item({ state: "draft" }),
  ];
  for (const [index, broken] of invalid.entries()) {
    assert.equal(projectSubmissionListPage(page({ items: [broken] }),
      { page_size: LIST_DEFAULT_PAGE_SIZE }), null, String(index));
  }
});
test("page envelope and detail projection are exact with no fallback", () => {
  assert.deepEqual(projectSubmissionListPage(page(), { page_size: LIST_DEFAULT_PAGE_SIZE }), page());
  const secondPage = page({ has_more: true, next_cursor: cursor });
  assert.deepEqual(projectSubmissionListPage(secondPage, { page_size: LIST_DEFAULT_PAGE_SIZE }), secondPage);

  const rejectedPages = [
    page({ extra: 1 }),
    { items: [], page_size: LIST_DEFAULT_PAGE_SIZE, has_more: false },
    page({ page_size: 5 }),
    page({ has_more: false, next_cursor: cursor }),
    page({ has_more: true, next_cursor: null }),
    page({ has_more: true, next_cursor: "nope" }),
    page({ has_more: 0 }),
    page({ items: "[]", has_more: false, next_cursor: null }),
    page({ items: null, has_more: false, next_cursor: null }),
    page({ items: [{ ...item(), allowed_transitions: ["REVIEW", "REVIEW"] }] }),
    page({ items: [{ ...item(), created_by_user_id: entryA }] }),
    page({ items: [{ ...item(), auth_subject: entryA }] }),
    page({ items: [{ ...item(), worker_details: { display_name: "x" } }] }),
  ];
  for (const [index, payload] of rejectedPages.entries()) {
    assert.equal(projectSubmissionListPage(payload, { page_size: LIST_DEFAULT_PAGE_SIZE }), null, String(index));
  }
  assert.equal(projectSubmissionListPage(page({
    items: [item(), item()],
  }), { page_size: 1 }), null);

  assert.deepEqual(projectSubmissionDetail(detailBody(), { submission_id: submissionId }), detailBody());
  const multi = detailBody({ entry_count: 2, entry_ids: [entryB, entryA] });
  assert.deepEqual(projectSubmissionDetail(multi, { submission_id: submissionId }), multi);
  const empty = detailBody({ entry_count: 0, entry_ids: [] });
  assert.deepEqual(projectSubmissionDetail(empty, { submission_id: submissionId }), empty);

  const rejectedDetails = [
    detailBody({ submission_id: otherSubmissionId }),
    detailBody({ extra: 1 }),
    detailBody({ entry_ids: [entryA, entryA], entry_count: 2 }),
    detailBody({ entry_ids: [entryA], entry_count: 2 }),
    detailBody({ entry_ids: ["not-a-uuid"] }),
    detailBody({ entry_ids: "[]" }),
    detailBody({ entry_ids: null }),
    detailBody({ entry_ids: [entryA], created_by_user_id: entryA }),
    detailBody({ entry_ids: [entryA], reason: "S02C reason" }),
    detailBody({ entry_ids: [entryA], payment: { state: "unknown" } }),
    detailBody({ entry_ids: [entryA], idempotency_key: "S02C" }),
  ];
  for (const [index, payload] of rejectedDetails.entries()) {
    assert.equal(projectSubmissionDetail(payload, { submission_id: submissionId }), null, String(index));
  }
});
