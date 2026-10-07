/**
 * P2.5-W06A-R1 F4 - Regression payload THUC theo migration #51.
 * Fixtures sinh truc tiep tu cac jsonb_build_object cua RPC canonical:
 * - direct_entry_list_projects_admin (8 key master)
 * - direct_entry_get_project_admin (8 key master, khong wrapper)
 * - direct_entry_list_project_manager_assignments (11 key assignment)
 * - create/update/set_active (5/6 key)
 * - assign (8 key) / unassign (6 key)
 * Chung minh projector di qua thanh cong va malformed/extra key fail-closed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  projectAdminAssignMutation,
  projectAdminAssignment,
  projectAdminAssignments,
  projectAdminCreateMutation,
  projectAdminList,
  projectAdminMutation,
  projectAdminProject,
  projectAdminUnassignMutation,
} from "./project-admin-contract.ts";

const AID = "77777777-7777-4777-8777-777777777777";
const RID = "66666666-6666-4666-8666-666666666666";
const REV = "99999999-9999-4999-8999-999999999999";
const TS = "2026-10-01T00:00:00+00:00";

const PROJECT = {
  project_id: "du-an-01", display_name: "Công ty ABC", active: true, version: 3,
  created_at: TS, updated_at: TS, revision_count: 2, active_assignment_count: 1,
};
const ASSIGNMENT = {
  assignment_id: AID, project_id: "du-an-01", project_version: 3,
  manager_recruiter_id: RID, valid_from: "2026-10-01", valid_to: null,
  effective: true, version: 1, revoked_at: null, created_at: TS, updated_at: TS,
};

test("projectAdminProject di qua payload list_projects_admin / get_project_admin", () => {
  const projected = projectAdminProject(PROJECT);
  assert.equal(projected?.project_id, "du-an-01");
  assert.equal(projected?.active_assignment_count, 1);
  assert.equal(projected?.revision_count, 2);
  // nullable timestamp: created_at co the null (project chua co revision).
  assert.deepEqual(projectAdminProject({ ...PROJECT, created_at: null, updated_at: null }),
    { ...PROJECT, created_at: null, updated_at: null });
});

test("projectAdminProject fail-closed: thieu/thua key, sai kieu, timestamp sai", () => {
  assert.equal(projectAdminProject({ ...PROJECT, extra: 1 }), null, "thua key => null");
  const missing = { ...PROJECT };
  delete missing.active_assignment_count;
  assert.equal(projectAdminProject(missing), null, "thieu key => null");
  assert.equal(projectAdminProject({ ...PROJECT, version: 3.5 }), null);
  assert.equal(projectAdminProject({ ...PROJECT, revision_count: -1 }), null, "count am => null");
  assert.equal(projectAdminProject({ ...PROJECT, created_at: 42 }), null, "timestamp khong phai string/null => null");
  assert.equal(projectAdminProject({ ...PROJECT, updated_at: "" }), null, "timestamp rong => null");
});

test("projectAdminList di qua payload that va fail-closed", () => {
  const list = projectAdminList({ authorization_date: "2026-10-07",
    include_inactive: true, projects: [PROJECT] });
  assert.equal(list?.projects.length, 1);
  assert.equal(list?.projects[0].project_id, "du-an-01");
  assert.equal(projectAdminList({ authorization_date: "2026-10-07",
    include_inactive: true, projects: [{ project_id: "x" }] }), null, "project thieu key => null");
  assert.equal(projectAdminList({ authorization_date: "2026-10-07", projects: [] }), null,
    "thieu include_inactive => null");
});

test("projectAdminAssignments di qua payload list_project_manager_assignments", () => {
  const detail = projectAdminAssignments({ authorization_date: "2026-10-07",
    project_id: "du-an-01", project_version: 3, project_active: true,
    include_history: true, active_assignment_count: 1, assignments: [ASSIGNMENT] });
  assert.equal(detail?.project_version, 3);
  assert.equal(detail?.assignments[0].assignment_id, AID);
  assert.equal(detail?.assignments[0].version, 1, "version la ASSIGNMENT version");
  assert.equal(detail?.assignments[0].project_version, 3, "project_version la PROJECT version");
  assert.equal(projectAdminAssignments({ authorization_date: "2026-10-07", project_id: "du-an-01",
    project_version: 3, project_active: true, include_history: true,
    active_assignment_count: 1, assignments: [{}] }), null, "assignment thieu key => null");
});

test("projectAdminAssignment 11 key + valid_to/revoked_at null", () => {
  const projected = projectAdminAssignment(ASSIGNMENT);
  assert.equal(projected?.valid_to, null);
  assert.equal(projected?.revoked_at, null);
  assert.equal(projectAdminAssignment({ ...ASSIGNMENT, updated_at: undefined }), null);
});

test("create tra created:true (6 key); update/set_active 5 key", () => {
  const create = projectAdminCreateMutation({ project_id: "du-an-01", display_name: "X",
    active: true, version: 1, revision_id: REV, created: true });
  assert.equal(create?.created, true);
  assert.equal(projectAdminCreateMutation({ project_id: "du-an-01", display_name: "X",
    active: true, version: 1, revision_id: REV, created: false }), null, "created phai true");
  assert.equal(projectAdminCreateMutation({ project_id: "du-an-01", display_name: "X",
    active: true, version: 1, revision_id: REV }), null, "create thieu created => null");

  const update = projectAdminMutation({ project_id: "du-an-01", display_name: "Y",
    active: true, version: 2, revision_id: REV });
  assert.equal(update?.version, 2);
  assert.equal(projectAdminMutation({ ...update, created: true }), null,
    "update co key created => null (5 key exact)");
});

test("assign 8 key va unassign 6 key khac shape, khong lan nhau", () => {
  const assign = projectAdminAssignMutation({ assignment_id: AID, project_id: "du-an-01",
    manager_recruiter_id: RID, valid_from: "2026-10-01", valid_to: null,
    version: 1, project_version: 4, already_assigned: false });
  assert.equal(assign?.project_version, 4, "assign tra project OCC version moi");
  assert.equal(assign?.version, 1, "assign version la assignment version");

  const unassign = projectAdminUnassignMutation({ assignment_id: AID, project_id: "du-an-01",
    valid_to: "2026-10-05", version: 2, project_version: 5, already_unassigned: false });
  assert.equal(unassign?.version, 2);
  assert.equal(unassign?.project_version, 5);

  // assign shape khong duoc nham thanh unassign va nguoc lai.
  assert.equal(projectAdminUnassignMutation({ assignment_id: AID, project_id: "du-an-01",
    manager_recruiter_id: RID, valid_from: "2026-10-01", valid_to: null,
    version: 1, project_version: 4, already_assigned: false }), null);
  assert.equal(projectAdminAssignMutation({ assignment_id: AID, project_id: "du-an-01",
    valid_to: "2026-10-05", version: 2, project_version: 5, already_unassigned: false }), null);
});
