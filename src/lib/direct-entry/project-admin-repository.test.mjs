import assert from "node:assert/strict";
import test from "node:test";

import {
  projectAdminAssignment,
  projectAdminDetail,
  projectAdminList,
  projectAdminMutation,
  projectAdminProject,
} from "./project-admin-contract.ts";
import {
  classifyProjectAdminError,
  createProjectAdminRepository,
} from "./project-admin-repository.ts";

const ACTOR = { auth_subject: "a", app_user_id: "u" };
const PROJECT = { project_id: "p1", display_name: "Công ty ABC", active: true, version: 3 };
const ASSIGNMENT = {
  assignment_id: "as1", project_id: "p1", project_version: 3, manager_recruiter_id: "r1",
  valid_from: "2026-10-01", valid_to: null, effective: true, version: 2,
  revoked_at: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
};
const MUTATION = { project_id: "p1", display_name: "Công ty ABC", active: true, version: 4, revision_id: "rev1" };

function fakeRpc(response) {
  const calls = [];
  return { calls, rpc: async (name, args) => { calls.push({ name, args }); return response; } };
}
function okRepo(response) { const f = fakeRpc({ data: response, error: null }); return { ...f, repo: createProjectAdminRepository(f.rpc) }; }

test("projection fail-closed: thieu/thua key hoac sai kieu => null", () => {
  assert.deepEqual(projectAdminProject(PROJECT), PROJECT);
  assert.equal(projectAdminProject({ ...PROJECT, extra: 1 }), null, "thua key => null");
  const missing = { ...PROJECT };
  delete missing.version;
  assert.equal(projectAdminProject(missing), null, "thieu key => null");
  assert.equal(projectAdminProject({ ...PROJECT, version: 3.5 }), null, "version khong nguyen => null");
  assert.equal(projectAdminProject({ ...PROJECT, active: "true" }), null, "active khong boolean => null");
  assert.equal(projectAdminProject({ ...PROJECT, display_name: "   " }), null, "ten rong => null");
  assert.equal(projectAdminProject(null), null);
});

test("assignment projection: valid_to/revoked_at null duoc phep, thieu key thi khong", () => {
  const projected = projectAdminAssignment(ASSIGNMENT);
  assert.equal(projected?.assignment_id, "as1");
  assert.equal(projected?.valid_to, null);
  assert.equal(projected?.effective, true);
  const missingAssignment = { ...ASSIGNMENT };
  delete missingAssignment.updated_at;
  assert.equal(projectAdminAssignment(missingAssignment), null);
});

test("list/detail/mutation projections", () => {
  const list = projectAdminList({
    authorization_date: "2026-10-07", include_inactive: true, projects: [PROJECT],
  });
  assert.equal(list?.projects.length, 1);
  assert.equal(projectAdminList({ authorization_date: "2026-10-07", include_inactive: true, projects: [{ bad: 1 }] }), null);
  assert.equal(projectAdminList({ authorization_date: "2026-10-07", projects: [] }), null, "thieu include_inactive => null");

  const detail = projectAdminDetail({
    authorization_date: "2026-10-07", project_id: "p1", project_version: 3,
    project_active: true, active_assignment_count: 1, assignments: [ASSIGNMENT],
  });
  assert.equal(detail?.active_assignment_count, 1);
  assert.equal(projectAdminDetail({
    authorization_date: "2026-10-07", project_id: "p1", project_version: 3,
    project_active: true, active_assignment_count: 1, assignments: [{}],
  }), null);

  assert.deepEqual(projectAdminMutation(MUTATION), MUTATION);
  assert.equal(projectAdminMutation({ ...MUTATION, revision_id: "" }), null);
});

test("SQLSTATE -> kind, fail-closed voi ma la", () => {
  assert.equal(classifyProjectAdminError({ code: "40001" }), "conflict", "OCC stale");
  assert.equal(classifyProjectAdminError({ code: "23505" }), "conflict", "idempotency unique");
  assert.equal(classifyProjectAdminError({ code: "42501" }), "denied", "capability/scope");
  assert.equal(classifyProjectAdminError({ code: "P0002" }), "not-found");
  assert.equal(classifyProjectAdminError({ code: "23514" }), "invalid");
  assert.equal(classifyProjectAdminError({ code: "22023", message: "x" }), "invalid");
  assert.equal(classifyProjectAdminError({ code: "22023", message: "idempotency key reused with different input" }), "conflict");
  assert.equal(classifyProjectAdminError({ code: "XX000" }), "unavailable", "ma la => unavailable");
  assert.equal(classifyProjectAdminError({}), "unavailable");
});

test("repository goi dung RPC canonical va truyen dung tham so", async () => {
  const list = okRepo({ authorization_date: "2026-10-07", include_inactive: false, projects: [PROJECT] });
  const r1 = await list.repo.listProjects({ ...ACTOR, include_inactive: false });
  assert.equal(list.calls[0].name, "direct_entry_list_projects_admin");
  assert.equal(list.calls[0].args.p_include_inactive, false);
  assert.equal(r1.ok, true);
  assert.equal(list.calls[0].args.p_auth_subject, "a", "actor lay tu server context");

  const detail = okRepo({ authorization_date: "2026-10-07", project_id: "p1", project_version: 3,
    project_active: true, active_assignment_count: 0, assignments: [] });
  await detail.repo.getProject({ ...ACTOR, project_id: "p1" });
  assert.equal(detail.calls[0].name, "direct_entry_get_project_admin");

  const create = okRepo(MUTATION);
  await create.repo.createProject({ ...ACTOR, project_id: "p1", display_name: "X", reason: "ly do", idempotency_key: "k1" });
  assert.equal(create.calls[0].name, "direct_entry_create_project");
  assert.equal(create.calls[0].args.p_reason, "ly do");

  const update = okRepo(MUTATION);
  await update.repo.updateProject({ ...ACTOR, project_id: "p1", expected_version: 3, display_name: "Y", reason: "r", idempotency_key: "k" });
  assert.equal(update.calls[0].name, "direct_entry_update_project");
  assert.equal(update.calls[0].args.p_expected_version, 3, "OCC theo project_version");
});

test("deactivate dung direct_entry_set_project_active(..., false), khong co RPC rieng", async () => {
  const f = okRepo({ ...MUTATION, active: false });
  await f.repo.setProjectActive({ ...ACTOR, project_id: "p1", active: false, expected_version: 3, reason: "ngung dung", idempotency_key: "k" });
  assert.equal(f.calls[0].name, "direct_entry_set_project_active");
  assert.equal(f.calls[0].args.p_active, false);
  assert.equal(f.calls.length, 1, "khong goi them RPC nao khac");
});

test("assign/unassign: dung RPC, OCC ca hai version, co already flag", async () => {
  const assign = okRepo({ assignment_id: "as2", project_id: "p1", manager_recruiter_id: "r2",
    valid_from: "2026-10-01", valid_to: null, version: 1, project_version: 4, already_assigned: false });
  const a = await assign.repo.assignManager({ ...ACTOR, project_id: "p1", manager_recruiter_id: "r2",
    valid_from: "2026-10-01", expected_project_version: 3, reason: "them quan ly", idempotency_key: "k" });
  assert.equal(assign.calls[0].name, "direct_entry_assign_project_manager");
  assert.equal(assign.calls[0].args.p_expected_project_version, 3);
  assert.equal(a.ok, true);
  assert.equal(a.data.already, false);

  const unassign = okRepo({ assignment_id: "as2", project_id: "p1", valid_to: "2026-10-05",
    version: 2, project_version: 5, already_unassigned: false });
  const u = await unassign.repo.unassignManager({ ...ACTOR, assignment_id: "as2", expected_version: 1,
    expected_project_version: 4, reason: "thu hoi", idempotency_key: "k" });
  assert.equal(unassign.calls[0].name, "direct_entry_unassign_project_manager");
  assert.equal(unassign.calls[0].args.p_expected_version, 1, "OCC assignment version");
  assert.equal(unassign.calls[0].args.p_expected_project_version, 4, "OCC project version");
  assert.equal(u.data.already, false);
});

test("malformed 2xx => unavailable, khong bao gio success", async () => {
  const malformed = okRepo({ ok: true, unexpected: true });
  const r = await malformed.repo.listProjects({ ...ACTOR, include_inactive: true });
  assert.deepEqual(r, { ok: false, kind: "unavailable" });

  const partial = okRepo({ authorization_date: "2026-10-07", include_inactive: true, projects: [{ project_id: "p1" }] });
  assert.deepEqual(await partial.repo.listProjects({ ...ACTOR, include_inactive: true }),
    { ok: false, kind: "unavailable" });
});

test("loi RPC duoc map dung va khong lo chi tiet", async () => {
  const denied = fakeRpc({ data: null, error: { code: "42501", message: "raw db detail" } });
  const repo = createProjectAdminRepository(denied.rpc);
  const r = await repo.getProject({ ...ACTOR, project_id: "p1" });
  assert.deepEqual(r, { ok: false, kind: "denied" });
  assert.equal(JSON.stringify(r).includes("raw db detail"), false, "khong lo message DB");
});
