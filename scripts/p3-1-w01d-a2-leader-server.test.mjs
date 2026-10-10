import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const MIGRATION = "supabase/migrations/20261009070000_p3_1_w01d_team_leader_lifecycle.sql";
const RPC_NAMES = [
  "direct_entry_list_team_leaders_current",
  "direct_entry_list_team_leaders_scheduled",
  "direct_entry_list_team_leader_history",
  "direct_entry_list_team_leader_candidates",
  "direct_entry_designate_team_leader",
  "direct_entry_revoke_team_leader",
];

test("A2 exposes one canonical route hierarchy over migration #71 RPC contracts", async () => {
  const migration = await readFile(path.join(ROOT, MIGRATION), "utf8");
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const repositorySource = await readFile(
    path.join(ROOT, "src/lib/direct-entry/team-leader-repository.ts"), "utf8");
  const routeFiles = [
    "src/app/api/admin/catalog/team-leaders/route.ts",
    "src/app/api/admin/catalog/team-leader-candidates/route.ts",
    "src/app/api/admin/catalog/teams/[teamId]/leaders/route.ts",
    "src/app/api/admin/catalog/teams/[teamId]/leaders/revoke/route.ts",
  ];
  for (const rpc of RPC_NAMES) assert.ok(migration.includes(rpc), rpc);
  for (const route of routeFiles) {
    const source = await readFile(path.join(ROOT, route), "utf8");
    assert.match(source, /runtime = "nodejs"/);
    assert.match(source, /dynamic = "force-dynamic"/);
  }
  const readFns = migration.slice(
    migration.indexOf("create or replace function public.direct_entry_list_team_leaders_current"),
    migration.indexOf("-- 9. Atomic leader designate/replace"),
  );
  for (const rpc of RPC_NAMES.slice(0, 3)) {
    const start = readFns.indexOf(`create or replace function public.${rpc}`);
    const next = readFns.indexOf("create or replace function public.", start + 1);
    const source = readFns.slice(start, next < 0 ? undefined : next);
    assert.match(source, /join public\.recruiters r on r\.recruiter_id = a\.leader_recruiter_id/);
    assert.match(source, /r\.display_name ilike/);
    assert.doesNotMatch(source, /direct_entry_app_users|direct_entry_app_user_recruiter_links/);
  }
  const candidateStart = migration.indexOf(
    "create or replace function public.direct_entry_list_team_leader_candidates");
  const candidateEnd = migration.indexOf("-- 9. Atomic leader designate/replace", candidateStart);
  const candidateSource = migration.slice(candidateStart, candidateEnd);
  assert.match(candidateSource, /direct_entry_assert_catalog_operator/);
  assert.match(candidateSource, /t\.code <> '__system_vendor__'/);
  assert.match(candidateSource, /errcode = 'P0002'/);
  assert.match(candidateSource, /r\.display_name/);
  assert.doesNotMatch(candidateSource, /personnel_position|'recruiter_id', recruiter_id/);
  assert.doesNotMatch(repositorySource, /\.from\s*\(/);
  assert.doesNotMatch(repositorySource, /\bselect\b/i);
  for (const rpc of RPC_NAMES) assert.ok(repositorySource.includes(rpc), rpc);
  const lane = "test:p3-1-w01d-a2-leader-server";
  assert.ok(packageJson.scripts[lane]);
  assert.equal(Object.keys(packageJson.scripts).filter((name) => name === lane).length, 1);
  assert.equal(packageJson.scripts.test.split(`pnpm ${lane}`).length - 1, 1);
});
