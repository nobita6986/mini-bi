import assert from "node:assert/strict";
import test from "node:test";

import {
  duplicateCccdModalMessage,
  duplicateCccdModalQuestion,
  duplicateCccdModalTitle,
  duplicateCccdStatusLine,
  EMPLOYMENT_STATUS_LABELS,
  projectDuplicateCccdPreflight,
} from "./submission-duplicate-cccd-contract.ts";

const submissionId = "b1000000-0000-4000-8000-000000000001";
const fingerprint = "a".repeat(64);

function conflict(overrides = {}) {
  return {
    conflict_ref: "0123456789ab",
    draft_display_name: "Nguyen Van Draft",
    project_display: "Project A",
    employment_status: "ON",
    cccd_last4: "8901",
    ...overrides,
  };
}

function preflight(overrides = {}) {
  return {
    submission_id: submissionId,
    version: 1,
    fingerprint,
    conflict_count: 1,
    conflicts: [conflict()],
    ...overrides,
  };
}

test("D31-D32: a valid preflight projects with the Vietnamese label mapping", () => {
  const projected = projectDuplicateCccdPreflight(preflight(), { submission_id: submissionId });
  assert.deepEqual(projected, {
    submission_id: submissionId,
    version: 1,
    fingerprint,
    conflict_count: 1,
    conflicts: [{
      conflict_ref: "0123456789ab",
      draft_display_name: "Nguyen Van Draft",
      project_display: "Project A",
      employment_status: "ON",
      employment_status_label: "Đang làm việc",
      cccd_last4: "8901",
    }],
  });
  const unconfirmed = projectDuplicateCccdPreflight(preflight({
    conflicts: [conflict({ employment_status: "UNCONFIRMED", project_display: null })],
  }), { submission_id: submissionId });
  assert.equal(unconfirmed.conflicts[0].employment_status_label, "Không xác định");
  assert.equal(unconfirmed.conflicts[0].project_display, null);
  assert.equal(Object.isFrozen(EMPLOYMENT_STATUS_LABELS), true);
  assert.deepEqual(Object.keys(EMPLOYMENT_STATUS_LABELS), ["ON", "UNCONFIRMED"]);
});

test("D33: an OFF status is never a valid conflict item", () => {
  assert.equal(projectDuplicateCccdPreflight(preflight({
    conflicts: [conflict({ employment_status: "OFF" })],
  }), { submission_id: submissionId }), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({
    conflicts: [conflict({ employment_status: "off" })],
  }), { submission_id: submissionId }), null);
});

test("D36: exact keys, bounds and determinism fail closed", () => {
  const expected = { submission_id: submissionId };
  assert.equal(projectDuplicateCccdPreflight(null, expected), null);
  assert.equal(projectDuplicateCccdPreflight([], expected), null);
  assert.equal(projectDuplicateCccdPreflight("REVIEW", expected), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({ extra: 1 }), expected), null);
  const missing = preflight();
  delete missing.fingerprint;
  assert.equal(projectDuplicateCccdPreflight(missing, expected), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({ fingerprint: "A".repeat(64) }), expected), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({ fingerprint: "a".repeat(63) }), expected), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({ version: 0 }), expected), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({ version: "1" }), expected), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({ conflict_count: -1 }), expected), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({ conflict_count: 1001 }), expected), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({ conflict_count: 0 }), expected), null);
  // Danh sach bi cat bot la hop le: count la tong, conflicts toi da 20 item.
  assert.equal(projectDuplicateCccdPreflight(preflight({ conflict_count: 2 }), expected)
    .conflict_count, 2);
  assert.equal(projectDuplicateCccdPreflight(preflight({
    conflicts: Array.from({ length: 21 }, (unused, index) =>
      conflict({ conflict_ref: String(index).padStart(12, "0") })),
    conflict_count: 21,
  }), expected), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({
    conflicts: [conflict(), conflict()],
    conflict_count: 2,
  }), expected), null);
  assert.equal(projectDuplicateCccdPreflight(
    preflight({ submission_id: "b1000000-0000-4000-8000-000000000002" }), expected), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({ conflicts: [conflict({ extra: 1 })] }), expected), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({ conflicts: [conflict({ cccd_last4: "890" })] }), expected), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({ conflicts: [conflict({ cccd_last4: "89012" })] }), expected), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({
    conflicts: [conflict({ conflict_ref: "0123456789AB" })],
  }), expected), null);
  assert.equal(projectDuplicateCccdPreflight(preflight({
    conflicts: [conflict({ draft_display_name: "x".repeat(201) })],
  }), expected), null);
  assert.deepEqual(
    projectDuplicateCccdPreflight(preflight(), expected),
    projectDuplicateCccdPreflight(preflight(), expected),
  );
});

test("D34-D35: the projection carries no raw CCCD and no UUID inside a conflict item", () => {
  const projected = projectDuplicateCccdPreflight(preflight(), { submission_id: submissionId });
  const text = JSON.stringify(projected.conflicts);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), false);
  assert.equal(text.includes("012345678901"), false);
  assert.match(projected.conflicts[0].cccd_last4, /^[0-9]{4}$/);
  assert.deepEqual(Object.keys(projected.conflicts[0]).sort(), [
    "cccd_last4", "conflict_ref", "draft_display_name", "employment_status",
    "employment_status_label", "project_display",
  ]);
});

test("the modal text follows the agreed wording for ON, UNCONFIRMED and no project", () => {
  assert.equal(duplicateCccdModalTitle(), "Phát hiện CCCD đã tồn tại");
  assert.equal(duplicateCccdModalQuestion(), "Bạn chắc chắn vẫn muốn trình duyệt hồ sơ này?");
  const projectedOn = projectDuplicateCccdPreflight(preflight(),
    { submission_id: submissionId }).conflicts[0];
  assert.equal(duplicateCccdModalMessage(projectedOn),
    "NLĐ Nguyen Van Draft có số CCCD trùng với một NLĐ đang làm việc tại dự án Project A.");
  assert.equal(duplicateCccdStatusLine(projectedOn), "Trạng thái hiện tại: Đang làm việc.");
  const projectedUnconfirmed = projectDuplicateCccdPreflight(preflight({
    conflicts: [conflict({ employment_status: "UNCONFIRMED", project_display: "Project B" })],
  }), { submission_id: submissionId }).conflicts[0];
  assert.equal(duplicateCccdModalMessage(projectedUnconfirmed),
    "NLĐ Nguyen Van Draft có số CCCD trùng với một hồ sơ tại dự án Project B.");
  assert.equal(duplicateCccdStatusLine(projectedUnconfirmed),
    "Trạng thái hiện tại: Không xác định.");
  assert.equal(duplicateCccdModalMessage(conflict({ project_display: null })),
    "NLĐ Nguyen Van Draft có số CCCD trùng với một NLĐ đang làm việc trong hệ thống.");
  assert.equal(duplicateCccdModalMessage(conflict({ draft_display_name: "  " })),
    "NLĐ trong bản nháp có số CCCD trùng với một NLĐ đang làm việc tại dự án Project A.");
});

