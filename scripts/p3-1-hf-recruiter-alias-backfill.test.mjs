import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const MIGRATION = "20261009090000_p3_1_hf_recruiter_alias_backfill.sql";
const AUTH = "10000000-0000-4000-8000-000000000073";
const APP = "20000000-0000-4000-8000-000000000073";
const TEAM = "30000000-0000-4000-8000-000000000073";
const RECRUITER_MISSING = "40000000-0000-4000-8000-000000000073";
const RECRUITER_LATE = "40000000-0000-4000-8000-000000000074";

async function migrationNames() {
  return (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
}

async function databaseBeforeHotfix() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = await migrationNames();
  assert.equal(names.length, 73);
  assert.equal(names.at(-1), MIGRATION);
  for (const name of names.slice(0, -1)) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return db;
}

async function applyHotfix(db) {
  await db.exec(await readFile(path.join(MIGRATION_DIR, MIGRATION), "utf8"));
}

async function seedActor(db) {
  await db.query("insert into auth.users(id) values ($1::uuid)", [AUTH]);
  await db.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name)" +
    " values ($1::uuid,$2::uuid,true,'Synthetic Catalog Operator')",
    [APP, AUTH],
  );
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
    " values ($1::uuid,'catalog_master_manage','2020-01-01')",
    [APP],
  );
  await db.query(
    "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from)" +
    " values ($1::uuid,'all','2020-01-01')",
    [APP],
  );
}

async function insertReportingFact(db, recruiterId, suffix) {
  const submission = `50000000-0000-4000-8000-0000000000${suffix}`;
  const candidate = `60000000-0000-4000-8000-0000000000${suffix}`;
  const entry = `70000000-0000-4000-8000-0000000000${suffix}`;
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates(candidate_id) values ($1::uuid)", [candidate]);
    await db.query(
    "insert into public.direct_entry_submissions(submission_id,created_by_user_id,state,version)" +
    " values ($1::uuid,$2::uuid,'DRAFT',1)",
    [submission, APP],
  );
    await db.query(
    "insert into public.direct_entries(entry_id,submission_id,candidate_id,created_by_user_id," +
    "project_id,first_work_date,employee_code,worker_details,recruiter_id,team_id,provider_type,labor_type)" +
    " values ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'proj-alias','2026-10-01',$5," +
    "$6::jsonb,$7::uuid,$8::uuid,'hrp','TEMPORARY')",
    [entry, submission, candidate, APP, `hrp-2026-1000${suffix}`,
      JSON.stringify({
        display_name: `Worker ${suffix}`,
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      }), recruiterId, TEAM],
  );
    await db.query(
    "update public.direct_entry_submissions set state='REVIEW',version=2" +
    " where submission_id=$1::uuid",
    [submission],
  );
    await db.query(
    "update public.direct_entry_submissions set state='SUBMITTED',version=3" +
    " where submission_id=$1::uuid",
    [submission],
    );
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

test("#73 backfills missing and late aliases before the first work date", async () => {
  const db = await databaseBeforeHotfix();
  try {
    await seedActor(db);
    await db.query(
      "insert into public.teams(team_id,code,display_name) values ($1::uuid,'ALIAS_TEAM','Alias Team')",
      [TEAM],
    );
    await db.exec("insert into public.direct_entry_projects(project_id,display_name)" +
      " values ('proj-alias','Alias Project')");
    await db.query(
      "insert into public.recruiters(recruiter_id,display_name,personnel_code) values" +
      " ($1::uuid,'Named Missing','named.missing'),($2::uuid,'Named Late','named.late')",
      [RECRUITER_MISSING, RECRUITER_LATE],
    );
    for (const recruiter of [RECRUITER_MISSING, RECRUITER_LATE]) {
      await db.query(
        "insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from)" +
        " values ($1::uuid,'hrp','2026-01-01')",
        [recruiter],
      );
      await db.query(
        "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)" +
        " values ($1::uuid,$2::uuid,'2026-01-01')",
        [recruiter, TEAM],
      );
    }
    await db.query(
      "insert into public.recruiter_aliases(recruiter_id,reporting_key,valid_from)" +
      " values ($1::uuid,'named.late','2026-10-05')",
      [RECRUITER_LATE],
    );
    await insertReportingFact(db, RECRUITER_MISSING, "73");
    await insertReportingFact(db, RECRUITER_LATE, "74");

    const before = await db.query(
      "select count(*) filter (where recruiter_key='__unknown__')::int as unknown" +
      " from public.direct_entry_reporting_facts_v01",
    );
    assert.equal(before.rows[0].unknown, 2,
      "named recruiters without an effective alias reproduce the dashboard defect");

    await applyHotfix(db);

    const facts = await db.query(
      "select recruiter_key,recruiter_display from public.direct_entry_reporting_facts_v01" +
      " order by recruiter_key",
    );
    assert.deepEqual(facts.rows, [
      { recruiter_key: "named.late", recruiter_display: "Named Late" },
      { recruiter_key: "named.missing", recruiter_display: "Named Missing" },
    ]);
    const aliases = await db.query(
      "select reporting_key,valid_from::text as valid_from from public.recruiter_aliases" +
      " where recruiter_id in ($1::uuid,$2::uuid) order by reporting_key",
      [RECRUITER_MISSING, RECRUITER_LATE],
    );
    assert.deepEqual(aliases.rows, [
      { reporting_key: "named.late", valid_from: "2026-01-01" },
      { reporting_key: "named.missing", valid_from: "2026-01-01" },
    ]);
  } finally {
    await db.close();
  }
});

test("catalog create writes the canonical alias in the same transaction", async () => {
  const db = await databaseBeforeHotfix();
  try {
    await applyHotfix(db);
    await seedActor(db);
    const result = await db.query(
      "select public.direct_entry_create_personnel($1::uuid,$2::uuid,0," +
      "'new.person','New Person','STAFF','2026-01-10','Create canonical person','alias-create-73') as result",
      [AUTH, APP],
    );
    const recruiterId = result.rows[0].result.recruiter_id;
    const alias = await db.query(
      "select reporting_key,valid_from::text as valid_from from public.recruiter_aliases" +
      " where recruiter_id=$1::uuid",
      [recruiterId],
    );
    assert.deepEqual(alias.rows, [{ reporting_key: "new.person", valid_from: "2026-01-10" }]);

    await db.exec("create function public.test_alias_rollback() returns trigger language plpgsql as" +
      " $x$ begin raise exception 'synthetic revision failure' using errcode='23514'; end $x$;" +
      " create trigger test_alias_rollback before insert on public.direct_entry_personnel_revisions" +
      " for each row execute function public.test_alias_rollback();");
    await assert.rejects(
      db.query(
        "select public.direct_entry_create_personnel($1::uuid,$2::uuid,0," +
        "'rollback.person','Rollback Person','STAFF','2026-01-10','Rollback canonical person','alias-rollback-73')",
        [AUTH, APP],
      ),
    );
    const residue = await db.query(
      "select (select count(*)::int from public.recruiters where personnel_code='rollback.person') as recruiters," +
      " (select count(*)::int from public.recruiter_aliases where reporting_key='rollback.person') as aliases",
    );
    assert.deepEqual(residue.rows[0], { recruiters: 0, aliases: 0 });
  } finally {
    await db.close();
  }
});

test("provider-membership boundary covers importer and raw canonical insert paths", async () => {
  const db = await databaseBeforeHotfix();
  try {
    await applyHotfix(db);
    const recruiter = "40000000-0000-4000-8000-000000000075";
    await db.query(
      "insert into public.recruiters(recruiter_id,display_name,personnel_code)" +
      " values ($1::uuid,'Imported Person','import.person')",
      [recruiter],
    );
    await db.query(
      "insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from)" +
      " values ($1::uuid,'hrp','2026-02-01')",
      [recruiter],
    );
    const alias = await db.query(
      "select reporting_key,valid_from::text as valid_from from public.recruiter_aliases" +
      " where recruiter_id=$1::uuid",
      [recruiter],
    );
    assert.deepEqual(alias.rows, [{ reporting_key: "import.person", valid_from: "2026-02-01" }]);

    const acl = await db.query(
      "select has_function_privilege('anon'," +
      "'public.direct_entry_seed_recruiter_alias_from_provider()','EXECUTE') as anon," +
      "has_function_privilege('authenticated'," +
      "'public.direct_entry_seed_recruiter_alias_from_provider()','EXECUTE') as authenticated," +
      "has_function_privilege('service_role'," +
      "'public.direct_entry_seed_recruiter_alias_from_provider()','EXECUTE') as service_role",
    );
    assert.deepEqual(acl.rows[0], { anon: false, authenticated: false, service_role: false });
  } finally {
    await db.close();
  }
});
