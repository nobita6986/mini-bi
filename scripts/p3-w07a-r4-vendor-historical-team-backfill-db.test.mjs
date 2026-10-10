/**
 * P3-W07A-R4 - historical Vendor team backfill (#66), PGlite regression.
 *
 * Proves the append-only data correction:
 *  - every Vendor entry on a business team moves to the reserved system team,
 *    in every state, including a soft-deleted row, with version +1;
 *  - a Vendor already on the reserved team keeps its version;
 *  - HRP rows keep their business team and version;
 *  - exactly one actor-null system audit event per changed row, and a replay is
 *    a no-op;
 *  - the team audience stops returning Vendor while the all audience still does;
 *  - the reserved team stays hidden and still rejects membership/scope;
 *  - a non-canonical reserved row fails the whole migration.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const R4 = "20261009020000_p3_w07a_r4_vendor_historical_team_backfill.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const TEAM = "00000000-0000-4000-8000-00000000e001";
const REC_VENDOR = "00000000-0000-4000-8000-00000000e002";
const REC_HRP = "00000000-0000-4000-8000-00000000e003";
const AUTH_TEAM = "00000000-0000-4000-8000-00000000e004";
const AUTH_ALL = "00000000-0000-4000-8000-00000000e005";
const APP_TEAM = "00000000-0000-4000-8000-00000000e006";
const APP_ALL = "00000000-0000-4000-8000-00000000e007";

const E_VENDOR_DRAFT = "00000000-0000-4000-8000-00000000e101";
const E_VENDOR_SUBMITTED = "00000000-0000-4000-8000-00000000e102";
const E_VENDOR_DELETED = "00000000-0000-4000-8000-00000000e103";
const E_VENDOR_ALREADY = "00000000-0000-4000-8000-00000000e104";
const E_HRP = "00000000-0000-4000-8000-00000000e105";

async function ledger() {
  return (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
}

async function upTo(db, names, stopAt) {
  for (const n of names.slice(0, names.indexOf(stopAt))) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, n), "utf8"));
  }
}

async function applyR4(db) {
  await db.exec(await readFile(path.join(MIGRATION_DIR, R4), "utf8"));
}

function worker(name) {
  const optional = { state: "unknown" };
  return JSON.stringify({
    display_name: name,
    date_of_birth: optional,
    national_id: optional,
    address: optional,
    phone: optional,
  });
}

async function seed(db, { reservedTeamId }) {
  await db.exec(`
    insert into auth.users (id, email) values
      ('${AUTH_TEAM}','r4.team@example.test'), ('${AUTH_ALL}','r4.all@example.test');
    insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name) values
      ('${APP_TEAM}','${AUTH_TEAM}',true,'R4 Team Actor'), ('${APP_ALL}','${AUTH_ALL}',true,'R4 All Actor');
    insert into public.teams (team_id, code, display_name) values
      ('${TEAM}','W07A-R4-BIZ','R4 Business Team');
    insert into public.recruiters (recruiter_id, display_name, personnel_code) values
      ('${REC_VENDOR}','R4 Vendor','r4.vendor'), ('${REC_HRP}','R4 HRP','r4.hrp');
    insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from) values
      ('${REC_VENDOR}','vendor','2020-01-01'), ('${REC_HRP}','hrp','2020-01-01');
    insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from) values
      ('${REC_VENDOR}','${TEAM}','2020-01-01'), ('${REC_HRP}','${TEAM}','2020-01-01');
    insert into public.direct_entry_projects (project_id, display_name) values ('r4_proj','R4 Project');
    insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from)
      values ('${APP_TEAM}','team','${TEAM}','2020-01-01');
    insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from)
      values ('${APP_ALL}','all','2020-01-01');
    insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from) values
      ('${APP_TEAM}','entry_team','2020-01-01'),
      ('${APP_ALL}','entry_admin','2020-01-01'), ('${APP_ALL}','entry_create','2020-01-01');
  `);

  const groups = [
    { entries: [[E_VENDOR_DRAFT, "vendor", REC_VENDOR, TEAM, "hrp-2026-000101", "r4-v1"]] },
    { entries: [[E_VENDOR_SUBMITTED, "vendor", REC_VENDOR, TEAM, "hrp-2026-000102", "r4-v2"]] },
    { entries: [[E_VENDOR_ALREADY, "vendor", REC_VENDOR, reservedTeamId, "hrp-2026-000104", "r4-v4"]] },
    { entries: [
      [E_HRP, "hrp", REC_HRP, TEAM, "hrp-2026-000105", "r4-h1"],
      [E_VENDOR_DELETED, "vendor", REC_VENDOR, TEAM, "hrp-2026-000103", "r4-v3"],
    ] },
  ];
  let i = 0;
  for (const group of groups) {
    i += 1;
    const submissionId = `00000000-0000-4000-8000-00000000e2${String(i).padStart(2, "0")}`;
    // The non-empty-submission check is a deferred constraint trigger, so a
    // submission and its entries must be created in one transaction.
    await db.exec("begin");
    await db.query(
      "insert into public.direct_entry_submissions" +
      " (submission_id, created_by_user_id, state) values ($1,$2,'DRAFT')",
      [submissionId, APP_ALL],
    );
    let entryIndex = 0;
    for (const [entryId, provider, recruiter, teamId, code, key] of group.entries) {
      entryIndex += 1;
      const candidateId = "00000000-0000-4000-8000-" + String(400000000000 + i * 10 + entryIndex);
      await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [candidateId]);
      await db.query(
        "insert into public.direct_entries" +
        " (entry_id, submission_id, candidate_id, created_by_user_id, project_id, first_work_date," +
        "  employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type)" +
        " values ($1,$2,$3,$4,'r4_proj','2026-10-01',$5,$6::jsonb,$7,$8,$9,'TEMPORARY')",
        [entryId, submissionId, candidateId, APP_ALL, code, worker(key), recruiter, teamId, provider],
      );
    }
    await db.exec("commit");
    await db.query(
      "update public.direct_entry_submissions set state='REVIEW', version=2 where submission_id=$1",
      [submissionId],
    );
    await db.query(
      "update public.direct_entry_submissions" +
      " set state='SUBMITTED', version=3, submitted_at=now() where submission_id=$1",
      [submissionId],
    );
  }
  // A soft-deleted Vendor row must still be corrected by the backfill.
  await db.query(
    "update public.direct_entries set deleted_at = now(), version = version + 1 where entry_id=$1",
    [E_VENDOR_DELETED],
  );

  const { rows } = await db.query(
    "select team_id from public.direct_entries where entry_id=$1", [E_VENDOR_DRAFT]);
  assert.equal(rows[0].team_id, TEAM);
}
async function versions(db) {
  const { rows } = await db.query(
    "select entry_id, version, team_id from public.direct_entries order by entry_id");
  return new Map(rows.map((r) => [r.entry_id, r]));
}

async function authorizedEntries(db, authSubject, appUserId) {
  const { rows } = await db.query(
    "select entry_id from public.direct_entry_reporting_authorized_entries($1::uuid,$2::uuid)",
    [authSubject, appUserId]);
  return new Set(rows.map((r) => r.entry_id));
}

async function auditCount(db) {
  const { rows } = await db.query(
    "select count(*)::int as n from public.direct_entry_audit_events" +
    " where action='p3_w07a_r4_vendor_team_backfill'");
  return rows[0].n;
}

test("P3-W07A-R4: #66 is followed by P3.1-W01A #67 and P3.1-W01B #68, and the historical Vendor rows are corrected", async () => {
  const names = await ledger();
  assert.equal(names.length, 75, "ledger carries 75 migrations");
  assert.equal(names[names.length - (10)], R4, "later P3.1 migrations append after P3-W07A-R4 #66");

  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    await upTo(db, names, R4);

    const reserved = (await db.query(
      "select public.direct_entry_system_vendor_team_id() as id")).rows[0].id;
    assert.equal((await db.query(
      "select count(*)::int as n from public.teams where code='__system_vendor__'")).rows[0].n, 1);

    await seed(db, { reservedTeamId: reserved });

    // BEFORE: the team audience sees the misattributed Vendor rows.
    const before = await authorizedEntries(db, AUTH_TEAM, APP_TEAM);
    assert.equal(before.has(E_VENDOR_DRAFT), true, "team scope sees the misattributed Vendor (draft)");
    assert.equal(before.has(E_VENDOR_SUBMITTED), true, "team scope sees the misattributed Vendor (submitted)");
    assert.equal(before.has(E_HRP), true);

    const beforeVersions = await versions(db);
    await applyR4(db);
    const afterVersions = await versions(db);

    // AFTER: every Vendor sits on the reserved team; HRP is untouched.
    assert.equal(afterVersions.get(E_VENDOR_DRAFT).team_id, reserved);
    assert.equal(afterVersions.get(E_VENDOR_SUBMITTED).team_id, reserved);
    assert.equal(afterVersions.get(E_VENDOR_DELETED).team_id, reserved, "deleted rows are covered too");
    assert.equal(afterVersions.get(E_VENDOR_ALREADY).team_id, reserved);
    assert.equal(afterVersions.get(E_HRP).team_id, TEAM, "HRP keeps its business team");

    for (const id of [E_VENDOR_DRAFT, E_VENDOR_SUBMITTED, E_VENDOR_DELETED]) {
      assert.equal(afterVersions.get(id).version, beforeVersions.get(id).version + 1, id + " version +1");
    }
    assert.equal(afterVersions.get(E_VENDOR_ALREADY).version, beforeVersions.get(E_VENDOR_ALREADY).version,
      "an already-correct Vendor keeps its version");
    assert.equal(afterVersions.get(E_HRP).version, beforeVersions.get(E_HRP).version, "HRP version unchanged");

    // One actor-null system audit event per changed row, team_id only.
    assert.equal(await auditCount(db), 3);
    const audit = await db.query(
      "select auth_subject, app_user_id, outcome, changed_fields, resource_ref" +
      " from public.direct_entry_audit_events where action='p3_w07a_r4_vendor_team_backfill'");
    for (const row of audit.rows) {
      assert.equal(row.auth_subject, null);
      assert.equal(row.app_user_id, null);
      assert.equal(row.outcome, "APPLIED");
      assert.deepEqual(row.changed_fields, ["team_id"]);
      assert.equal([E_VENDOR_DRAFT, E_VENDOR_SUBMITTED, E_VENDOR_DELETED].includes(row.resource_ref), true);
    }
    assert.equal((await db.query(
      "select count(*)::int as n from public.direct_entry_revisions r" +
      " join public.direct_entries e on e.entry_id = r.entry_id" +
      " where e.provider_type = 'vendor'")).rows[0].n, 0, "no revision is fabricated");

    // Replay is a no-op.
    await applyR4(db);
    assert.equal(await auditCount(db), 3, "replay adds no audit event");
    const replayed = await versions(db);
    for (const id of [E_VENDOR_DRAFT, E_VENDOR_SUBMITTED, E_VENDOR_DELETED, E_VENDOR_ALREADY, E_HRP]) {
      assert.equal(replayed.get(id).version, afterVersions.get(id).version, id + " version stable on replay");
    }

    // Team audience no longer returns Vendor; the all audience still does.
    const teamAfter = await authorizedEntries(db, AUTH_TEAM, APP_TEAM);
    assert.equal(teamAfter.has(E_VENDOR_DRAFT), false, "team scope loses the Vendor row");
    assert.equal(teamAfter.has(E_VENDOR_SUBMITTED), false);
    assert.equal(teamAfter.has(E_HRP), true, "team scope keeps the HRP row");
    const allAfter = await authorizedEntries(db, AUTH_ALL, APP_ALL);
    for (const id of [E_VENDOR_DRAFT, E_VENDOR_SUBMITTED, E_VENDOR_ALREADY, E_HRP]) {
      assert.equal(allAfter.has(id), true, "all scope still reads " + id);
    }
    assert.equal(allAfter.has(E_VENDOR_DELETED), false,
      "a soft-deleted row stays outside the reporting row set for every audience");

    // Reserved team stays hidden from the two real read contracts and still
    // rejects membership / team scope. The legacy
    // reporting_dimension_options_v01 view has no team dimension at all, so it
    // is deliberately NOT used as hidden-team evidence.
    const catalog = (await db.query(
      "select public.direct_entry_input_catalog($1::uuid,$2::uuid,public.direct_entry_authorization_date()) as v",
      [AUTH_ALL, APP_ALL])).rows[0].v;
    const vendorRows = (catalog.recruiters ?? []).filter((r) => r.provider_type === "vendor");
    assert.ok(vendorRows.length >= 1, "the Vendor recruiter is still listed in the catalog");
    const vendorRow = vendorRows.find((r) => r.recruiter_id === REC_VENDOR);
    assert.ok(vendorRow, "the exact Vendor recruiter is present");
    assert.equal(vendorRow.team_id, null, "a Vendor recruiter has no business team");
    assert.equal(vendorRow.team_display_name, null, "a Vendor recruiter has no team display name");
    for (const r of catalog.recruiters ?? []) {
      assert.notEqual(r.team_id, reserved, "the reserved team is never a business-team option");
      assert.notEqual(r.team_display_name, "Vendor", "the reserved team label never appears as a team option");
    }
    assert.equal(JSON.stringify(catalog).includes("__system_vendor__"), false,
      "the reserved team code never reaches the catalog payload");

    assert.equal((await db.query(
      "select count(*)::int as n from public.direct_entry_reporting_dimension_options_v01" +
      " where dimension='team'")).rows[0].n, 0,
      "the real reporting contract emits no team dimension");
    assert.equal((await db.query(
      "select count(*)::int as n from public.direct_entry_reporting_dimension_options_v01" +
      " where key = $1", [reserved])).rows[0].n, 0,
      "the reserved team id is never a reporting option key");
    assert.ok((await db.query(
      "select count(*)::int as n from public.direct_entry_reporting_dimension_options_v01" +
      " where dimension='provider' and display='Vendor'")).rows[0].n >= 1,
      "a submitted Vendor row still yields a provider='Vendor' option");
    await assert.rejects(
      db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)" +
        " values ($1,$2,'2020-01-01')", [REC_HRP, reserved]),
      (e) => e.code === "23514",
      "membership on the reserved team is rejected",
    );
    await assert.rejects(
      db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from)" +
        " values ($1,'team',$2,'2020-01-01')", [APP_ALL, reserved]),
      (e) => e.code === "23514",
      "team scope on the reserved team is rejected",
    );
  } finally {
    await db.close();
  }
});

test("P3-W07A-R4: a non-canonical reserved row aborts the migration with real rows untouched", async () => {
  const names = await ledger();
  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    await upTo(db, names, R4);

    // The reserved row exists first, then is made non-canonical: the preflight
    // must reject before the UPDATE can move anything.
    const reserved = (await db.query(
      "select public.direct_entry_system_vendor_team_id() as id")).rows[0].id;
    await seed(db, { reservedTeamId: reserved });
    await db.exec("update public.teams set active = false where team_id = '" + reserved + "'");

    const beforeVersions = await versions(db);
    assert.equal(beforeVersions.get(E_VENDOR_DRAFT).team_id, TEAM);
    assert.equal(beforeVersions.get(E_VENDOR_SUBMITTED).team_id, TEAM);
    assert.equal(beforeVersions.get(E_HRP).team_id, TEAM);

    await assert.rejects(applyR4(db), /P3-W07A-R4 reserved Vendor team row is not canonical/);
    try { await db.exec("rollback"); } catch { /* the aborted transaction is expected */ }

    const after = await versions(db);
    // A real Vendor row was pending a backfill: if the canonical preflight were
    // dropped, or the UPDATE ran before it, these rows and versions would move.
    assert.equal(after.get(E_VENDOR_DRAFT).team_id, TEAM, "Vendor stays on the business team");
    assert.equal(after.get(E_VENDOR_SUBMITTED).team_id, TEAM, "Vendor stays on the business team");
    assert.equal(after.get(E_VENDOR_DRAFT).version, beforeVersions.get(E_VENDOR_DRAFT).version);
    assert.equal(after.get(E_VENDOR_SUBMITTED).version, beforeVersions.get(E_VENDOR_SUBMITTED).version);
    assert.equal(after.get(E_HRP).team_id, TEAM, "the HRP control row is unchanged");
    assert.equal(after.get(E_HRP).version, beforeVersions.get(E_HRP).version);
    assert.equal(await auditCount(db), 0, "no backfill audit event is written");
    assert.equal((await db.query(
      "select count(*)::int as n from public.direct_entries" +
      " where provider_type='vendor' and team_id not in ($1,$2)",
      [TEAM, reserved])).rows[0].n, 0, "no Vendor row moved to another team");
  } finally {
    await db.close();
  }
});
