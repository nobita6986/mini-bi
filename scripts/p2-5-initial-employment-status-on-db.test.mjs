import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const MIGRATION = "20261008170000_p2_5_initial_employment_status_on.sql";

async function database() {
  const db = new PGlite();
  await db.exec(
    "create role anon; create role authenticated; create role service_role;" +
    " create schema auth; create table auth.users (id uuid primary key);",
  );
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  return { db, names };
}

test("initial employment status policy is migration #57 and patches every creation path", async () => {
  const { db, names } = await database();
  try {
    assert.equal(names.length, 68);
    assert.equal(names.at(-12), MIGRATION);
    const result = await db.query(`
      select p.proname, p.prosrc
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.oid in (
         'public.direct_entry_create_batch(uuid,uuid,jsonb,text)'::regprocedure,
         'public.direct_entry_create_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
         'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure
       ) order by p.proname
    `);
    assert.equal(result.rows.length, 3);
    for (const row of result.rows) {
      assert.match(row.prosrc,
        /v_entry_id, 'ON', v_first_work_date, 1, p_app_user_id, v_reason_id/,
        `${row.proname} must create ON as version 1`);
    }
    const full = result.rows.find((row) => row.proname === "direct_entry_create_full_profile_batch");
    assert.match(full.prosrc, /if v_status = 'OFF' then/);
    assert.doesNotMatch(full.prosrc, /if v_status in \('ON','OFF'\) then/);
  } finally {
    await db.close();
  }
});

test("status trigger accepts ON as the first append-only event at first_work_date", async () => {
  const { db } = await database();
  try {
    await db.exec(`
      insert into auth.users(id) values ('10000000-0000-4000-8000-000000000001');
      insert into public.direct_entry_app_users(app_user_id,auth_subject, display_name) values
        ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001', 'Synthetic Account');
      insert into public.direct_entry_projects(project_id,display_name) values
        ('initial_on_project','Initial ON project');
      insert into public.teams(team_id,code,display_name) values
        ('30000000-0000-4000-8000-000000000001','INITIAL_ON','Initial ON team');
      insert into public.recruiters(recruiter_id,display_name) values
        ('40000000-0000-4000-8000-000000000001','Initial ON recruiter');
      insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from)
        values ('40000000-0000-4000-8000-000000000001','hrp','2020-01-01');
      insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)
        values ('40000000-0000-4000-8000-000000000001',
          '30000000-0000-4000-8000-000000000001','2020-01-01');
      insert into public.direct_entry_submissions(submission_id,created_by_user_id) values
        ('50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001');
      insert into public.direct_entry_candidates(candidate_id) values
        ('60000000-0000-4000-8000-000000000001');
      insert into public.direct_entries(
        entry_id,submission_id,candidate_id,created_by_user_id,project_id,first_work_date,
        employee_code,worker_details,recruiter_id,team_id,provider_type,labor_type
      ) values (
        '70000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
        'initial_on_project','2026-10-08','hrp-2026-999999',
        '{"display_name":"Initial ON worker","gender":{"state":"unknown"},"date_of_birth":{"state":"unknown"},"national_id":{"state":"unknown"},"national_id_issued_at":{"state":"unknown"},"national_id_issued_place":{"state":"unknown"},"address":{"state":"unknown"},"phone":{"state":"unknown"}}',
        '40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',
        'hrp','TEMPORARY'
      );
      with reason as (
        insert into public.direct_entry_restricted_reasons(actor_user_id,reason_text)
        values ('20000000-0000-4000-8000-000000000001','Initial ON regression') returning reason_id
      )
      insert into public.direct_entry_employment_status_events(
        entry_id,status,effective_date,version,actor_user_id,reason_id
      ) select '70000000-0000-4000-8000-000000000001','ON','2026-10-08',1,
        '20000000-0000-4000-8000-000000000001',reason_id from reason;
    `);
    const state = await db.query(
      "select status,effective_date::text,version from public.direct_entry_employment_status_events",
    );
    assert.deepEqual(state.rows, [{ status: "ON", effective_date: "2026-10-08", version: 1 }]);
  } finally {
    await db.close();
  }
});
