import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyProjectAdminError,
  createProjectAdminRepository,
} from "./project-admin-repository.ts";

const ACTOR = { auth_subject: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", app_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const REV = "99999999-9999-4999-8999-999999999999";
const RID = "66666666-6666-4666-8666-666666666666";
const AID = "77777777-7777-4777-8777-777777777777";
const TS = "2026-10-01T00:00:00+00:00";

const PROJECT = { project_id: "du-an-01", display_name: "Công ty ABC", active: true, version: 3,
  created_at: TS, updated_at: TS, revision_count: 2, active_assignment_count: 1 };
const ASSIGNMENT = { assignment_id: AID, project_id: "du-an-01", project_version: 3,
  manager_recruiter_id: RID, valid_from: "2026-10-01", valid_to: null, effective: true,
  version: 1, revoked_at: null, created_at: TS, updated_at: TS };

function fakeRpc(response) {
  const calls = [];
  return { calls, rpc: async (name, args) => { calls.push({ name, args }); return response; } };
}
function repoWith(response) {
  const f = fakeRpc({ data: response, error: null });
  return { ...f, repo: createProjectAdminRepository(f.rpc) };
}

test("SQLSTATE -> kind, fail-closed voi ma la", () => {
  assert.equal(classifyProjectAdminError({ code: "40001" }), "conflict");
  assert.equal(classifyProjectAdminError({ code: "23505" }), "conflict");
  assert.equal(classifyProjectAdminError({ code: "42501" }), "denied");
  assert.equal(classifyProjectAdminError({ code: "P0002" }), "not-found");
  assert.equal(classifyProjectAdminError({ code: "23514" }), "invalid");
  assert.equal(classifyProjectAdminError({ code: "22023", message: "x" }), "invalid");
  assert.equal(classifyProjectAdminError({ code: "22023", message: "idempotency key reused with different input" }), "conflict");
  assert.equal(classifyProjectAdminError({ code: "XX000" }), "unavailable");
  assert.equal(classifyProjectAdminError({}), "unavailable");
});

test("listProjects dung direct_entry_list_projects_admin + project payload 8 key", async () => {
  const f = repoWith({ authorization_date: "2026-10-07", include_inactive: false,
    projects: [PROJECT] });
  const result = await f.repo.listProjects({ ...ACTOR, include_inactive: false });
  assert.equal(f.calls[0].name, "direct_entry_list_projects_admin");
  assert.equal(f.calls[0].args.p_include_inactive, false);
  assert.equal(f.calls[0].args.p_auth_subject, ACTOR.auth_subject);
  assert.equal(result.ok, true);
  assert.equal(result.data.projects[0].active_assignment_count, 1);
});

test("project list endpoint returns every project without a server page bound", async () => {
  const migration = readFileSync(new URL(
    "../../../supabase/migrations/20261008110000_p2_5_w02_multi_manager_project_authority.sql",
    import.meta.url), "utf8");
  const start = migration.indexOf("create or replace function public.direct_entry_list_projects_admin(");
  const bodyStart = migration.indexOf("as $$", start) + "as $$".length;
  const bodyEnd = migration.indexOf("\n$$;", bodyStart);
  assert.ok(start >= 0 && bodyStart >= "as $$".length && bodyEnd > bodyStart);
  const functionBody = migration.slice(bodyStart, bodyEnd);
  assert.match(functionBody, /from public\.direct_entry_projects p/);
  assert.match(functionBody, /jsonb_agg\(/);
  assert.doesNotMatch(functionBody, /\b(?:limit|offset)\b/i);

  const projects = Array.from({ length: 150 }, (_, index) => ({
    ...PROJECT, project_id: "project-" + String(index).padStart(3, "0"),
  }));
  const f = repoWith({ authorization_date: "2026-10-07", include_inactive: true, projects });
  const result = await f.repo.listProjects({ ...ACTOR, include_inactive: true });
  assert.equal(result.ok, true);
  assert.equal(result.data.projects.length, projects.length);
});

test("getProject dung direct_entry_get_project_admin tra MASTER row (khong assignments)", async () => {
  const f = repoWith(PROJECT);
  const result = await f.repo.getProject({ ...ACTOR, project_id: "du-an-01" });
  assert.equal(f.calls[0].name, "direct_entry_get_project_admin");
  assert.equal(result.ok, true);
  assert.equal(result.data.project_id, "du-an-01");
  assert.equal(result.data.revision_count, 2);
});

test("getProjectDetail dung CA HAI RPC: get_project_admin + list_project_manager_assignments", async () => {
  // Tra tuong ung theo ten RPC.
  const f = fakeRpc({ data: null, error: null });
  f.rpc = async (name, args) => {
    f.calls.push({ name, args });
    if (name === "direct_entry_get_project_admin") return { data: PROJECT, error: null };
    if (name === "direct_entry_list_project_manager_assignments") {
      return { data: { authorization_date: "2026-10-07", project_id: "du-an-01",
        project_version: 3, project_active: true, include_history: true,
        active_assignment_count: 1, assignments: [ASSIGNMENT] }, error: null };
    }
    return { data: null, error: { code: "XX000" } };
  };
  const repo = createProjectAdminRepository(f.rpc);
  const result = await repo.getProjectDetail({ ...ACTOR, project_id: "du-an-01" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].name, "direct_entry_get_project_admin");
  assert.equal(f.calls[1].name, "direct_entry_list_project_manager_assignments");
  assert.equal(f.calls[1].args.p_include_history, true, "chi tiet phai keo ca lich su");
  assert.equal(result.ok, true);
  assert.equal(result.data.master.project_id, "du-an-01");
  assert.equal(result.data.assignments.assignments.length, 1);
});

test("getProjectDetail: master not-found => khong goi assignments, tra not-found", async () => {
  const f = fakeRpc({ data: null, error: { code: "P0002" } });
  const repo = createProjectAdminRepository(f.rpc);
  const result = await repo.getProjectDetail({ ...ACTOR, project_id: "missing" });
  assert.equal(f.calls.length, 1, "dung lai o master, khong goi assignments");
  assert.equal(result.ok, false);
  assert.equal(result.kind, "not-found");
});

test("create/update/set-active dung dung RPC va projection", async () => {
  const create = repoWith({ project_id: "du-an-01", display_name: "X", active: true,
    version: 1, revision_id: REV, created: true });
  const c = await create.repo.createProject({ ...ACTOR, project_id: "du-an-01",
    display_name: "X", reason: "ly do", idempotency_key: "k1" });
  assert.equal(create.calls[0].name, "direct_entry_create_project");
  assert.equal(c.ok, true);
  assert.equal(c.data.created, true);

  const update = repoWith({ project_id: "du-an-01", display_name: "Y", active: true,
    version: 2, revision_id: REV });
  await update.repo.updateProject({ ...ACTOR, project_id: "du-an-01", expected_version: 1,
    display_name: "Y", reason: "r", idempotency_key: "k" });
  assert.equal(update.calls[0].name, "direct_entry_update_project");
  assert.equal(update.calls[0].args.p_expected_version, 1);
});

test("deactivate dung direct_entry_set_project_active(..., false), khong RPC rieng", async () => {
  const f = repoWith({ project_id: "du-an-01", display_name: "X", active: false,
    version: 2, revision_id: REV });
  await f.repo.setProjectActive({ ...ACTOR, project_id: "du-an-01", active: false,
    expected_version: 1, reason: "ngung dung", idempotency_key: "k" });
  assert.equal(f.calls[0].name, "direct_entry_set_project_active");
  assert.equal(f.calls[0].args.p_active, false);
  assert.equal(f.calls.length, 1);
});

test("assign/unassign dung RPC, OCC ca hai version, project_version duoc giu", async () => {
  const assign = repoWith({ assignment_id: AID, project_id: "du-an-01",
    manager_recruiter_id: RID, valid_from: "2026-10-01", valid_to: null,
    version: 1, project_version: 4, already_assigned: false });
  const a = await assign.repo.assignManager({ ...ACTOR, project_id: "du-an-01",
    manager_recruiter_id: RID, valid_from: "2026-10-01", expected_project_version: 3,
    reason: "them quan ly", idempotency_key: "k" });
  assert.equal(assign.calls[0].name, "direct_entry_assign_project_manager");
  assert.equal(assign.calls[0].args.p_expected_project_version, 3);
  assert.equal(a.data.project_version, 4, "assign tra project_version moi");
  assert.equal(a.data.version, 1, "version la assignment version");

  const unassign = repoWith({ assignment_id: AID, project_id: "du-an-01",
    valid_to: "2026-10-05", version: 2, project_version: 5, already_unassigned: false });
  const u = await unassign.repo.unassignManager({ ...ACTOR, assignment_id: AID,
    expected_version: 1, expected_project_version: 4, reason: "thu hoi", idempotency_key: "k" });
  assert.equal(unassign.calls[0].name, "direct_entry_unassign_project_manager");
  assert.equal(unassign.calls[0].args.p_expected_version, 1);
  assert.equal(unassign.calls[0].args.p_expected_project_version, 4);
  assert.equal(u.data.project_version, 5);
});

test("malformed 2xx => unavailable, khong bao gio success", async () => {
  const malformed = repoWith({ ok: true, unexpected: true });
  assert.deepEqual(await malformed.repo.listProjects({ ...ACTOR, include_inactive: true }),
    { ok: false, kind: "unavailable" });
});

test("loi RPC duoc map dung va khong lo chi tiet", async () => {
  const denied = fakeRpc({ data: null, error: { code: "42501", message: "raw db detail" } });
  const repo = createProjectAdminRepository(denied.rpc);
  const r = await repo.getProject({ ...ACTOR, project_id: "du-an-01" });
  assert.deepEqual(r, { ok: false, kind: "denied" });
  assert.equal(JSON.stringify(r).includes("raw db detail"), false);
});
