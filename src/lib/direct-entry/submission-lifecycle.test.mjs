import assert from "node:assert/strict";
import test from "node:test";

import {
  actionsForSubmission,
  clearIntentKey,
  confirmBlockReason,
  dropSubmissionRows,
  EMPTY_INTENT_KEY,
  formatHcmDateTime,
  isRowEditable,
  isSubmissionEditable,
  mergeReloadedDrafts,
  resolveIntentKey,
  shortRef,
  SUBMISSION_STATE_LABELS,
  transitionErrorMessage,
  unsavedRowCount,
} from "./submission-lifecycle.ts";
import { newDraftRow } from "./live-controller.ts";

const submissionId = "b1000000-0000-4000-8000-000000000001";
const otherSubmissionId = "b1000000-0000-4000-8000-000000000002";
const entryA = "c1000000-0000-4000-8000-000000000001";
const entryB = "c1000000-0000-4000-8000-000000000002";
const createdAt = "2026-10-04T09:00:00.000000Z";

function submission(overrides = {}) {
  return {
    submission_id: submissionId,
    state: "DRAFT",
    version: 1,
    entry_count: 1,
    created_at: createdAt,
    updated_at: createdAt,
    submitted_at: null,
    allowed_transitions: ["REVIEW"],
    ...overrides,
  };
}

function row(overrides = {}) {
  const base = newDraftRow("row-1", "2026-10-15");
  return {
    ...base,
    rowId: entryA,
    entryId: entryA,
    submissionId,
    entryVersion: 1,
    submissionVersion: 1,
    state: "clean",
    ...overrides,
  };
}

test("state labels cover the three lifecycle states", () => {
  assert.deepEqual(SUBMISSION_STATE_LABELS, {
    DRAFT: "Bản nháp",
    REVIEW: "Chờ duyệt",
    SUBMITTED: "Đã gửi chính thức",
  });
});

test("action matrix comes from the server transitions and never from client state", () => {
  const draftActions = actionsForSubmission(submission());
  assert.deepEqual(draftActions.map((action) => action.target_state), ["REVIEW"]);
  assert.equal(draftActions[0].label, "Gửi duyệt");
  assert.match(draftActions[0].confirm_description, /tạm khóa chỉnh sửa/);

  const reviewActions = actionsForSubmission(submission({
    state: "REVIEW",
    allowed_transitions: ["DRAFT", "SUBMITTED"],
  }));
  assert.deepEqual(reviewActions.map((action) => action.target_state), ["DRAFT", "SUBMITTED"]);
  assert.match(reviewActions[1].confirm_description, /trạng thái cuối/);
  assert.match(reviewActions[1].confirm_description, /yêu cầu thay đổi/);

  const submitted = actionsForSubmission(submission({
    state: "SUBMITTED",
    submitted_at: createdAt,
    allowed_transitions: [],
  }));
  assert.deepEqual(submitted, []);

  // Mang sai tu server khong tao hanh dong nao (khong tu suy dien tu state).
  assert.deepEqual(actionsForSubmission(submission({ allowed_transitions: ["SUBMITTED"] })), []);
  assert.deepEqual(actionsForSubmission(submission({ allowed_transitions: [] })), []);
  assert.deepEqual(actionsForSubmission(submission({
    state: "SUBMITTED",
    allowed_transitions: ["DRAFT", "REVIEW"],
  })), []);
  assert.deepEqual(actionsForSubmission(submission({
    state: "REVIEW",
    allowed_transitions: ["REVIEW"],
  })), []);
});

test("edit lock follows submission state and fails closed when unknown", () => {
  assert.equal(isSubmissionEditable("DRAFT"), true);
  assert.equal(isSubmissionEditable("REVIEW"), false);
  assert.equal(isSubmissionEditable("SUBMITTED"), false);
  assert.equal(isSubmissionEditable(null), false);
  assert.equal(isSubmissionEditable(undefined), false);

  const submissions = [submission(), submission({
    submission_id: otherSubmissionId,
    state: "REVIEW",
    allowed_transitions: ["DRAFT", "SUBMITTED"],
  })];
  assert.equal(isRowEditable({ submissionId: null }, submissions), true);
  assert.equal(isRowEditable({ submissionId }, submissions), true);
  assert.equal(isRowEditable({ submissionId: otherSubmissionId }, submissions), false);
  assert.equal(isRowEditable({ submissionId: "b1000000-0000-4000-8000-0000000000ff" }, submissions),
    false);
  assert.equal(isRowEditable({ submissionId }, []), false);
});

test("dirty protection blocks only the affected submission", () => {
  const rows = [
    row({ rowId: entryA, entryId: entryA, state: "clean" }),
    row({ rowId: entryB, entryId: entryB, state: "dirty" }),
    row({ rowId: "row-new", entryId: null, submissionId: null, state: "dirty" }),
    row({ rowId: "row-other", entryId: "c1000000-0000-4000-8000-000000000003",
      submissionId: otherSubmissionId, state: "conflict" }),
  ];
  assert.equal(unsavedRowCount(rows, submissionId), 1);
  assert.equal(confirmBlockReason(rows, submissionId), "UNSAVED_ROWS");
  assert.equal(confirmBlockReason(rows, otherSubmissionId), "UNSAVED_ROWS");
  assert.equal(unsavedRowCount(rows, "b1000000-0000-4000-8000-0000000000ff"), 0);
  assert.equal(confirmBlockReason(rows, "b1000000-0000-4000-8000-0000000000ff"), null);

  for (const state of ["dirty", "saving", "error", "conflict"]) {
    assert.equal(unsavedRowCount([row({ state })], submissionId), 1, state);
  }
  for (const state of ["clean", "saved"]) {
    assert.equal(unsavedRowCount([row({ state })], submissionId), 0, state);
    assert.equal(confirmBlockReason([row({ state })], submissionId), null, state);
  }
});

test("transition success removes the submission rows and keeps other submissions", () => {
  const rows = [
    row({ rowId: entryA, entryId: entryA }),
    row({ rowId: entryB, entryId: entryB, submissionId: otherSubmissionId }),
    row({ rowId: "row-new", entryId: null, submissionId: null }),
  ];
  const next = dropSubmissionRows(rows, submissionId);
  assert.deepEqual(next.map((item) => item.rowId), [entryB, "row-new"]);
  assert.equal(dropSubmissionRows(rows, "b1000000-0000-4000-8000-0000000000ff").length, 3);
});

test("draft reload keeps unsaved local rows and takes server rows otherwise", () => {
  const localRows = [
    row({ rowId: entryA, entryId: entryA, state: "clean", employeeCode: "hrp-2026-000001" }),
    row({ rowId: entryB, entryId: entryB, state: "dirty", employeeCode: "hrp-2026-000002" }),
    row({ rowId: "row-new", entryId: null, submissionId: null, state: "dirty" }),
  ];
  const serverRows = [
    row({ rowId: entryA, entryId: entryA, employeeCode: "hrp-2026-999999", state: "clean" }),
    row({ rowId: entryB, entryId: entryB, employeeCode: "hrp-2026-999998", state: "clean" }),
    row({ rowId: "row-server", entryId: "c1000000-0000-4000-8000-000000000004", state: "clean" }),
  ];
  const merged = mergeReloadedDrafts(localRows, serverRows);
  assert.deepEqual(merged.map((item) => item.rowId), [
    entryA, entryB, "row-server", "row-new",
  ]);
  const byId = new Map(merged.map((item) => [item.rowId, item]));
  assert.equal(byId.get(entryA).employeeCode, "hrp-2026-999999");
  assert.equal(byId.get(entryB).employeeCode, "hrp-2026-000002");
  assert.equal(byId.get(entryB).state, "dirty");
  assert.deepEqual(mergeReloadedDrafts([], serverRows).length, 3);
});

test("idempotency key is reused per intent and rotated after a terminal response", () => {
  const intent = submissionId + ":REVIEW";
  let generated = 0;
  const generate = () => "key-" + String(++generated);
  const first = resolveIntentKey(EMPTY_INTENT_KEY, intent, generate);
  assert.equal(first.reused, false);
  assert.equal(first.key, "key-1");
  const retry = resolveIntentKey(first.state, intent, generate);
  assert.equal(retry.reused, true);
  assert.equal(retry.key, "key-1");
  assert.equal(generated, 1);
  const otherIntent = resolveIntentKey(retry.state, submissionId + ":SUBMITTED", generate);
  assert.equal(otherIntent.reused, false);
  assert.equal(otherIntent.key, "key-2");
  const cleared = clearIntentKey(otherIntent.state, submissionId + ":SUBMITTED");
  assert.deepEqual(cleared, EMPTY_INTENT_KEY);
  const afterTerminal = resolveIntentKey(cleared, submissionId + ":SUBMITTED", generate);
  assert.equal(afterTerminal.key, "key-3");
  assert.deepEqual(clearIntentKey(retry.state, "another-intent"), retry.state);
});

test("messages and formatting stay sanitized and deterministic", () => {
  for (const status of [400, 401, 403, 404, 409, 500, 0]) {
    const message = transitionErrorMessage(status);
    assert.equal(typeof message, "string");
    assert.equal(message.length > 0, true);
    assert.doesNotMatch(message, /SQLSTATE|pg_|traceback|Error:/i);
  }
  assert.match(transitionErrorMessage(409), /tải lại/);
  assert.match(transitionErrorMessage(403), /quyền/);
  assert.equal(formatHcmDateTime("2026-10-04T09:00:00.000000Z"), "04/10/2026 16:00");
  assert.equal(formatHcmDateTime("2026-10-04T17:30:00.000000Z"), "05/10/2026 00:30");
  assert.equal(formatHcmDateTime("not-a-date"), "—");
  assert.equal(shortRef(submissionId), "b1000000");
});