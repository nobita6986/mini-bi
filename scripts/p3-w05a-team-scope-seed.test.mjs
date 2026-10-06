import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
  for (const name of names) await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  return db;
}

async function seedLeader(db, i, opts = {}) {
  const team = opts.team ?? uuid(500 + i);
  const rec = opts.rec ?? uuid(600 + i);
  const auth = opts.auth ?? uuid(700 + i);
  const app = opts.app ?? uuid(800 + i);
  const withLink = opts.withLink !== false;
  const withMembership = opts.withMembership !== false;
  const teamActive = opts.teamActive !== false;
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query("insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled) values ($1,$2,true)", [app, auth]);
  await db.query("insert into public.teams (team_id, code, display_name, active) values ($1,$2,$3,$4)", [team, "TEAM_" + i, "Team " + i, teamActive]);
  await db.query("insert into public.recruiters (recruiter_id, display_name, personnel_position) values ($1,$2,'TEAM_LEADER')", [rec, "Leader " + i]);
  await db.query("insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from) values ($1,'hrp','2020-01-01')", [rec]);
  if (withMembership) await db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from) values ($1,$2,'2020-01-01')", [rec, team]);
  if (withLink) await db.query("insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from) values ($1,$2,true,'2020-01-01')", [app, rec]);
  return { team, rec, auth, app };
}

async function seedSeven(db) {
  const ids = [];
  for (let i = 1; i <= 7; i++) ids.push(await seedLeader(db, i));
  return ids;
}

async function seedCount(db) {
  const r = await db.query("select count(*)::int as c from public.direct_entry_scope_grants where scope_kind='team'");
  return r.rows[0].c;
}

test("E19: seed grants exactly one team scope per leader, idempotent, no overlap", async () => {
  const db = await buildDb();
  try {
    await seedSeven(db);
    await db.query("select public.direct_entry_seed_team_scope_grants()");
    assert.equal(await seedCount(db), 7);
    // idempotent re-run does not multiply grants.
    await db.query("select public.direct_entry_seed_team_scope_grants()");
    assert.equal(await seedCount(db), 7);
    // each leader has exactly one effective team grant, no overlap.
    const r = await db.query(
      "select app_user_id, count(*)::int as c from public.direct_entry_scope_grants where scope_kind='team' group by app_user_id",
    );
    for (const row of r.rows) assert.equal(row.c, 1, "one grant per app user");
  } finally { await db.close(); }
});

test("E19: seed refuses when leader count is not 7", async () => {
  const db = await buildDb();
  try {
    for (let i = 1; i <= 6; i++) await seedLeader(db, i);
    await assert.rejects(
      () => db.query("select public.direct_entry_seed_team_scope_grants()"),
      /expected 7 active HRP team leaders/,
    );
  } finally { await db.close(); }
});

test("E19: seed refuses a leader with no verified recruiter link", async () => {
  const db = await buildDb();
  try {
    const ids = await seedSeven(db);
    await db.query("delete from public.direct_entry_app_user_recruiter_links where recruiter_id=$1", [ids[3].rec]);
    await assert.rejects(
      () => db.query("select public.direct_entry_seed_team_scope_grants()"),
      /verified recruiter links/,
    );
  } finally { await db.close(); }
});

test("E19: DB trigger rejects an overlapping verified recruiter link (defense in depth)", async () => {
  const db = await buildDb();
  try {
    const ids = await seedSeven(db);
    await assert.rejects(
      () => db.query("insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from) values ($1,$2,true,'2021-01-01')", [ids[3].app, ids[3].rec]),
      /effective interval overlaps/,
    );
  } finally { await db.close(); }
});

test("E19: seed refuses a leader with no effective team membership", async () => {
  const db = await buildDb();
  try {
    const ids = await seedSeven(db);
    await db.query("delete from public.recruiter_team_memberships where recruiter_id=$1", [ids[3].rec]);
    await assert.rejects(
      () => db.query("select public.direct_entry_seed_team_scope_grants()"),
      /effective team memberships/,
    );
  } finally { await db.close(); }
});

test("E19: DB trigger rejects an overlapping team membership (defense in depth)", async () => {
  const db = await buildDb();
  try {
    const ids = await seedSeven(db);
    const other = uuid(999);
    await db.query("insert into public.teams (team_id, code, display_name) values ($1,'OTHER','Other')", [other]);
    await assert.rejects(
      () => db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from) values ($1,$2,'2020-01-01')", [ids[3].rec, other]),
      /effective interval overlaps/,
    );
  } finally { await db.close(); }
});

test("E19: seed refuses when the leader's team is inactive", async () => {
  const db = await buildDb();
  try {
    const ids = await seedSeven(db);
    await db.query("update public.teams set active=false where team_id=$1", [ids[3].team]);
    await assert.rejects(
      () => db.query("select public.direct_entry_seed_team_scope_grants()"),
      /effective team memberships/,
    );
  } finally { await db.close(); }
});

test("E19: seed refuses an overlapping team grant for a different team", async () => {
  const db = await buildDb();
  try {
    const ids = await seedSeven(db);
    const other = uuid(998);
    await db.query("insert into public.teams (team_id, code, display_name) values ($1,'OTHER2','Other2')", [other]);
    await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from) values ($1,'team',$2,'2020-01-01')", [ids[3].app, other]);
    await assert.rejects(
      () => db.query("select public.direct_entry_seed_team_scope_grants()"),
      /different team/,
    );
  } finally { await db.close(); }
});

test("E20: seed adds team scope only, never capability grants or all scope", async () => {
  const db = await buildDb();
  try {
    await seedSeven(db);
    await db.query("select public.direct_entry_seed_team_scope_grants()");
    const cap = await db.query("select count(*)::int as c from public.direct_entry_capability_grants");
    assert.equal(cap.rows[0].c, 0, "no capability grants may be added");
    const all = await db.query("select count(*)::int as c from public.direct_entry_scope_grants where scope_kind='all'");
    assert.equal(all.rows[0].c, 0, "no all scope may be granted");
    const team = await db.query("select count(*)::int as c from public.direct_entry_scope_grants where scope_kind='team'");
    assert.equal(team.rows[0].c, 7, "exactly 7 team grants");
  } finally { await db.close(); }
});

