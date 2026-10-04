import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptDraftCreate,
  acceptDraftUpdate,
  applyServerDraft,
  changedDraftFields,
  draftRowFromProjection,
  editableFields,
  failDraftWrite,
  fieldsDiffer,
  keepLocalDraft,
  markDraftConflict,
  newDraftRow,
  stableLiveDraftKey,
  updateLiveDraftRow,
} from "./live-controller.ts";

const projection = {
  submission_id: "a1000000-0000-4000-8000-000000000001",
  submission_version: 2,
  entry_id: "a2000000-0000-4000-8000-000000000001",
  entry_version: 3,
  employee_code: "hrp-2026-900001",
  first_work_date: "2026-10-15",
  worker_display_name: "Synthetic Worker",
  project_id: "project_synthetic_01",
  project_display_name: "Synthetic project",
  recruiter_id: "93000000-0000-4000-8000-000000000001",
  recruiter_display_name: "Synthetic recruiter",
  provider_type: "hrp",
  team_id: "94000000-0000-4000-8000-000000000001",
  team_display_name: "Synthetic team",
  labor_type: "TEMPORARY",
  employment_status: "UNCONFIRMED",
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
  profile: {
    contract_version: "worker-profile/1.0",
    worker_details: {
      display_name: { state: "provided", value: "Synthetic Worker" },
      gender: { state: "omitted" },
      date_of_birth: { state: "omitted" },
      national_id: { state: "omitted" },
      national_id_issued_at: { state: "omitted" },
      national_id_issued_place: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
    general_note: { state: "omitted" },
    employment: null,
    payment: null,
  },
};

test("persisted IDs, versions and fields hydrate from server; unsaved rows use temporary identity", () => {
  const persisted = draftRowFromProjection(projection);
  assert.equal(persisted.rowId, projection.entry_id);
  assert.equal(persisted.entryVersion, 3);
  assert.equal(persisted.submissionVersion, 2);
  assert.equal(persisted.state, "clean");
  assert.deepEqual(persisted.profile, projection.profile);
  const unsaved = newDraftRow("local-temp-1", "2026-10-15");
  assert.equal(unsaved.entryId, null);
  assert.equal(stableLiveDraftKey(unsaved), "local-temp-1");
  assert.equal(stableLiveDraftKey(persisted), projection.entry_id);
});

test("local edits become dirty, unchanged edits return clean, and saving rows reject mutation", () => {
  const row = draftRowFromProjection(projection);
  const changed = updateLiveDraftRow([row], row.rowId, { workerName: "Synthetic changed" })[0];
  assert.equal(changed.state, "dirty");
  assert.equal(fieldsDiffer(editableFields(changed), editableFields(row)), true);
  assert.deepEqual(changedDraftFields(editableFields(changed), editableFields(row)), ["Họ tên"]);
  const unchanged = updateLiveDraftRow([changed], row.rowId, { workerName: row.workerName })[0];
  assert.equal(unchanged.state, "clean");
  const saving = { ...row, state: "saving" };
  assert.equal(updateLiveDraftRow([saving], row.rowId, { workerName: "ignored" })[0].workerName, row.workerName);
});

test("date or recruiter edits remain explicit and never derive identity from labels", () => {
  const row = newDraftRow("local-temp-2", "2026-10-15");
  const edited = updateLiveDraftRow([row], row.rowId, {
    recruiterId: "93000000-0000-4000-8000-000000000001",
    firstWorkDate: "2026-10-20",
  })[0];
  assert.equal(edited.recruiterId, "93000000-0000-4000-8000-000000000001");
  assert.equal(edited.recruiterDisplayName, "");
  assert.equal(edited.providerType, null);
  assert.equal(edited.teamId, null);
  assert.equal(edited.state, "dirty");
});

test("a failed operation reuses its key only while its payload is unchanged", () => {
  const row = draftRowFromProjection(projection);
  const pending = {
    key: "same-operation-key",
    fields: editableFields(row),
    expectedVersion: row.entryVersion,
  };
  const failed = { ...row, state: "error", pendingWrite: pending };
  const retry = updateLiveDraftRow([failed], row.rowId, { workerName: row.workerName })[0];
  assert.equal(retry.pendingWrite?.key, pending.key);

  const changed = updateLiveDraftRow([failed], row.rowId, { workerName: "Different synthetic name" })[0];
  assert.equal(changed.pendingWrite, null);
  assert.equal(changed.state, "dirty");
});

test("conflict fields can be compared without changing the local draft", () => {
  const row = draftRowFromProjection(projection);
  const local = updateLiveDraftRow([row], row.rowId, { workerName: "Local synthetic edit" })[0];
  const server = { ...editableFields(row), projectId: "project_synthetic_02" };
  assert.equal(local.workerName, "Local synthetic edit");
  assert.deepEqual(changedDraftFields(editableFields(local), server), ["Họ tên", "Dự án"]);
});

test("create, update, retry failure and explicit conflict choices preserve row state", () => {
  const unsaved = newDraftRow("local-temp-3", "2026-10-15");
  const fields = {
    ...editableFields(unsaved),
    employeeCode: "hrp-2026-900002",
    workerName: "Synthetic New Worker",
    projectId: "project_synthetic_01",
    recruiterId: projection.recruiter_id,
  };
  const pending = { key: "create-key", fields, expectedVersion: null };
  const created = acceptDraftCreate({ ...unsaved, ...fields }, pending, {
    entryId: projection.entry_id,
    submissionId: projection.submission_id,
    entryVersion: 1,
    submissionVersion: 1,
  });
  assert.equal(created.rowId, projection.entry_id);
  assert.equal(created.state, "saved");
  assert.equal(stableLiveDraftKey(created), projection.entry_id);

  const pendingUpdate = {
    key: "update-key",
    fields: { ...fields, workerName: "Synthetic Update" },
    expectedVersion: 1,
  };
  const error = failDraftWrite(created, pendingUpdate, "SAVE_FAILED");
  assert.equal(error.state, "error");
  assert.equal(error.workerName, "Synthetic New Worker");
  assert.equal(error.pendingWrite?.key, "update-key");
  const updated = acceptDraftUpdate({ ...error, ...pendingUpdate.fields }, pendingUpdate, {
    entryVersion: 2,
    submissionVersion: 2,
  });
  assert.equal(updated.state, "saved");
  assert.equal(updated.entryVersion, 2);

  const conflictCopy = {
    version: 3,
    submissionVersion: 3,
    fields: { ...editableFields(updated), workerName: "Synthetic Server Worker" },
  };
  const conflict = markDraftConflict(updated, {
    ...pendingUpdate,
    expectedVersion: 2,
  }, conflictCopy);
  assert.equal(conflict.state, "conflict");
  assert.equal(conflict.workerName, "Synthetic Update");
  const server = applyServerDraft(conflict);
  assert.equal(server.workerName, "Synthetic Server Worker");
  assert.equal(server.entryVersion, 3);
  assert.equal(server.state, "clean");
  const kept = keepLocalDraft(conflict);
  assert.equal(kept.workerName, "Synthetic Update");
  assert.equal(kept.entryVersion, 3);
  assert.equal(kept.state, "dirty");
  assert.equal(kept.pendingWrite, null);
});
