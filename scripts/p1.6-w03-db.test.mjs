import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

const migrationPath = new URL("../supabase/migrations/20261002170000_p1_6_direct_entry_foundation.sql", import.meta.url);

function syntheticWorker(displayName) {
  const optional = { state: "unknown" };
  return {
    display_name: displayName,
    date_of_birth: optional,
    national_id: optional,
    address: optional,
    phone: optional,
  };
}

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
  `);
  await db.exec(await readFile(migrationPath, "utf8"));
  return db;
}

async function seedSubmission(db) {
  await db.exec(`
    begin;
    insert into auth.users (id) values ('10000000-0000-4000-8000-000000000001');
    insert into auth.users (id) values ('10000000-0000-4000-8000-000000000002');
    insert into public.direct_entry_app_users (app_user_id, auth_subject)
      values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
    insert into public.direct_entry_app_users (app_user_id, auth_subject)
      values ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002');
    insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from)
      values
        ('20000000-0000-4000-8000-000000000001', 'submission_create', '2020-01-01'),
        ('20000000-0000-4000-8000-000000000001', 'entry_create', '2020-01-01'),
        ('20000000-0000-4000-8000-000000000001', 'entry_own', '2020-01-01'),
        ('20000000-0000-4000-8000-000000000001', 'employment_status.apply', '2020-01-01'),
        ('20000000-0000-4000-8000-000000000001', 'document_upload', '2020-01-01'),
        ('20000000-0000-4000-8000-000000000001', 'document_view', '2020-01-01'),
        ('20000000-0000-4000-8000-000000000001', 'change_request_create', '2020-01-01'),
        ('20000000-0000-4000-8000-000000000001', 'change_review', '2020-01-01'),
        ('20000000-0000-4000-8000-000000000001', 'entry_privileged_edit', '2020-01-01'),
        ('20000000-0000-4000-8000-000000000001', 'pii_view', '2020-01-01'),
        ('20000000-0000-4000-8000-000000000001', 'audit_view', '2020-01-01'),
        ('20000000-0000-4000-8000-000000000001', 'payment_view', '2020-01-01');
    insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from)
      values ('20000000-0000-4000-8000-000000000002', 'change_review', '2020-01-01');
    insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, valid_from)
      values ('20000000-0000-4000-8000-000000000001', 'own', '2020-01-01');
    insert into public.direct_entry_projects (project_id, display_name)
      values ('project_synthetic_01', 'Synthetic project');
    insert into public.direct_entry_banks (bank_id, display_name)
      values ('synthetic_bank', 'Synthetic bank');
    insert into public.recruiters (recruiter_id, display_name)
      values ('30000000-0000-4000-8000-000000000001', 'Synthetic recruiter');
    insert into public.teams (team_id, code, display_name)
      values ('40000000-0000-4000-8000-000000000001', 'SYNTH', 'Synthetic team');
    insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, team_id, valid_from)
      values ('20000000-0000-4000-8000-000000000002', 'team',
        '40000000-0000-4000-8000-000000000001', '2020-01-01');
    insert into public.recruiter_provider_memberships
      (recruiter_id, provider_type, valid_from)
      values ('30000000-0000-4000-8000-000000000001', 'hrp', '2020-01-01');
    insert into public.recruiter_team_memberships
      (recruiter_id, team_id, valid_from)
      values ('30000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001', '2020-01-01');
    insert into public.direct_entry_submissions
      (submission_id, created_by_user_id)
      values ('50000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001');
    insert into public.direct_entry_candidates (candidate_id)
      values ('60000000-0000-4000-8000-000000000001');
    insert into public.direct_entries (
      entry_id, submission_id, candidate_id, created_by_user_id, project_id,
      first_work_date, employee_code, worker_details, recruiter_id, team_id,
      provider_type, labor_type
    ) values (
      '70000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      'project_synthetic_01', '2020-01-15', 'hrp-2020-000001',
      '{"display_name":"Synthetic Person","date_of_birth":{"state":"unknown"},"national_id":{"state":"unknown"},"address":{"state":"unknown"},"phone":{"state":"unknown"}}',
      '30000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001', 'hrp', 'TEMPORARY'
    );
    with reason as (
      insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)
        values ('20000000-0000-4000-8000-000000000001', 'Synthetic initial status')
        returning reason_id
    )
    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, version, actor_user_id, reason_id
    )
    select '70000000-0000-4000-8000-000000000001', 'UNCONFIRMED', '2020-01-15', 1,
      '20000000-0000-4000-8000-000000000001', reason_id from reason;
    commit;
  `);
}

test("migration enforces deny-by-default RLS and RPC-only grants", async () => {
  const db = await createDatabase();
  try {
    const { rows: tables } = await db.query(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and (
         c.relname like 'direct_entry_%' or c.relname in (
           'recruiters', 'teams', 'recruiter_aliases',
           'recruiter_provider_memberships', 'recruiter_team_memberships',
           'direct_entries'
         )
       )
         and c.relkind = 'r'
    `);
    assert.equal(tables.length, 26);
    for (const table of tables) {
      assert.equal(table.relrowsecurity, true, table.relname);
      assert.equal(table.relforcerowsecurity, true, table.relname);
      for (const role of ["anon", "authenticated", "service_role"]) {
        const { rows } = await db.query(
          "select has_table_privilege($1, $2, 'INSERT, UPDATE, DELETE, TRUNCATE') as allowed",
          [role, `public.${table.relname}`],
        );
        assert.equal(rows[0].allowed, false, `${role} DML on ${table.relname}`);
      }
    }

    const { rows: functions } = await db.query(`
      select has_function_privilege('anon',
        'public.direct_entry_transition_submission(uuid,uuid,uuid,integer,text,text)', 'EXECUTE') as anon_exec,
        has_function_privilege('authenticated',
        'public.direct_entry_transition_submission(uuid,uuid,uuid,integer,text,text)', 'EXECUTE') as auth_exec,
        has_function_privilege('service_role',
        'public.direct_entry_transition_submission(uuid,uuid,uuid,integer,text,text)', 'EXECUTE') as service_exec
    `);
    assert.deepEqual(functions[0], { anon_exec: false, auth_exec: false, service_exec: true });
    for (const role of ["anon", "authenticated", "service_role"]) {
      const { rows: viewPrivileges } = await db.query(
        "select has_table_privilege($1, 'public.direct_entry_current_documents', 'SELECT') as allowed",
        [role],
      );
      assert.equal(viewPrivileges[0].allowed, false, `${role} select on document view`);
    }
    const { rows: rpcGrants } = await db.query(`
      select p.proname,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'direct_entry_%'
    `);
    const grantedToService = rpcGrants.filter((row) => row.service_exec).map((row) => row.proname).sort();
    assert.deepEqual(grantedToService, [
      "direct_entry_apply_employment_status",
      "direct_entry_append_document_event",
      "direct_entry_approve_change_request",
      "direct_entry_create_batch",
      "direct_entry_create_change_request",
      "direct_entry_create_document_metadata",
      "direct_entry_correct_latest_status",
      "direct_entry_create_draft_row",
      "direct_entry_delete_draft_row",
      "direct_entry_privileged_edit",
      "direct_entry_read_audit",
      "direct_entry_read_projection",
      "direct_entry_reject_change_request",
      "direct_entry_transition_submission",
      "direct_entry_update_draft_row",
      "direct_entry_update_payment",
      "direct_entry_withdraw_change_request",
    ].sort());
    const { rows: documentEventGrant } = await db.query(`
      select has_function_privilege('anon',
        'public.direct_entry_append_document_event(uuid,integer,text,text,integer,text)', 'EXECUTE') as anon_exec,
        has_function_privilege('authenticated',
        'public.direct_entry_append_document_event(uuid,integer,text,text,integer,text)', 'EXECUTE') as auth_exec,
        has_function_privilege('service_role',
        'public.direct_entry_append_document_event(uuid,integer,text,text,integer,text)', 'EXECUTE') as service_exec
    `);
    assert.deepEqual(documentEventGrant[0], { anon_exec: false, auth_exec: false, service_exec: true });
    const { rows: documentArguments } = await db.query(`
      select proargnames from pg_proc
       where oid = 'public.direct_entry_create_document_metadata(uuid,uuid,uuid,integer,text,text,text,bigint,text,text)'::regprocedure
    `);
    assert.equal(documentArguments[0].proargnames.includes("p_storage_key"), false);
    for (const grant of rpcGrants) {
      assert.equal(grant.anon_exec, false, `${grant.proname} executable by anon`);
      assert.equal(grant.auth_exec, false, `${grant.proname} executable by authenticated`);
    }
    const { rows: auditColumns } = await db.query(`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'direct_entry_audit_events'
    `);
    const names = auditColumns.map((column) => column.column_name);
    for (const forbidden of [
      "reason_text", "account_number", "account_holder_name",
      "document_content", "national_id", "worker_details",
    ]) {
      assert.equal(names.includes(forbidden), false, `audit stores ${forbidden}`);
    }
  } finally {
    await db.close();
  }
});

test("UUID team scope rejects unknown IDs; effective memberships reject overlap but allow adjacency", async () => {
  const db = await createDatabase();
  try {
    await db.exec(`
      insert into auth.users (id) values ('10000000-0000-4000-8000-000000000001');
      insert into public.direct_entry_app_users (app_user_id, auth_subject)
      values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
    `);
    await assert.rejects(db.exec(`
      insert into public.direct_entry_scope_grants
        (app_user_id, scope_kind, team_id, valid_from)
      values ('20000000-0000-4000-8000-000000000001', 'team',
        '90000000-0000-4000-8000-000000000001', '2026-01-01')
    `), /foreign key/i);

    await db.exec(`
      insert into public.recruiters (recruiter_id, display_name)
      values ('30000000-0000-4000-8000-000000000001', 'Synthetic recruiter');
      insert into public.recruiter_provider_memberships
        (recruiter_id, provider_type, valid_from, valid_to)
      values ('30000000-0000-4000-8000-000000000001', 'hrp', '2026-01-01', '2026-02-01');
    `);
    await assert.rejects(db.exec(`
      insert into public.recruiter_provider_memberships
        (recruiter_id, provider_type, valid_from, valid_to)
      values ('30000000-0000-4000-8000-000000000001', 'vendor', '2026-01-15', '2026-02-15')
    `), /overlaps an existing/i);
    await db.exec(`
      insert into public.recruiter_provider_memberships
        (recruiter_id, provider_type, valid_from, valid_to)
      values ('30000000-0000-4000-8000-000000000001', 'vendor', '2026-02-01', '2026-03-01')
    `);
  } finally {
    await db.close();
  }
});

test("submission transition checks trusted actor, scope, capability, and optimistic version", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    await db.exec("set role service_role");
    await assert.rejects(db.query(
      `select public.direct_entry_transition_submission(
        '10000000-0000-4000-8000-000000000002',
        '20000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001', 1, 'REVIEW', 'idem_synthetic_01')`,
    ), /actor mapping denied/);
    await assert.rejects(db.query(
      `select public.direct_entry_transition_submission(
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001', 0, 'REVIEW', 'idem_synthetic_02')`,
    ), /version conflict/);

    const { rows } = await db.query(
      `select public.direct_entry_transition_submission(
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001', 1, 'REVIEW', 'idem_synthetic_01') as result`,
    );
    assert.deepEqual(rows[0].result, {
      submission_id: "50000000-0000-4000-8000-000000000001",
      state: "REVIEW",
      version: 2,
    });
    const { rows: replay } = await db.query(
      `select public.direct_entry_transition_submission(
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001', 1, 'REVIEW', 'idem_synthetic_01') as result`,
    );
    assert.deepEqual(replay[0].result, rows[0].result);
    await assert.rejects(db.query(
      `select public.direct_entry_transition_submission(
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001', 1, 'DRAFT', 'idem_synthetic_01')`,
    ), /idempotency key reused with different input/);
    await db.exec("reset role");
    const { rows: audit } = await db.query(
      "select action, outcome, changed_fields from public.direct_entry_audit_events",
    );
    assert.deepEqual(audit, [{
      action: "submission_transition",
      outcome: "APPLIED",
      changed_fields: ["state", "version"],
    }]);
    assert.equal(JSON.stringify(audit).includes("Synthetic Person"), false);
  } finally {
    await db.close();
  }
});

test("audit failure rolls submission transition back atomically", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    await db.exec(`
      create function public.test_reject_audit_insert()
      returns trigger language plpgsql as $$
      begin raise exception 'synthetic audit insert failure'; end;
      $$;
      create trigger test_reject_audit_insert
        before insert on public.direct_entry_audit_events
        for each row execute function public.test_reject_audit_insert();
      begin;
      savepoint before_mutation;
      set role service_role;
    `);
    await assert.rejects(db.query(
      `select public.direct_entry_transition_submission(
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001', 1, 'REVIEW', 'idem_rollback_01')`,
    ), /synthetic audit insert failure/);
    await db.exec("rollback to savepoint before_mutation; commit;");
    const { rows } = await db.query(
      "select state, version from public.direct_entry_submissions where submission_id = '50000000-0000-4000-8000-000000000001'",
    );
    assert.deepEqual(rows, [{ state: "DRAFT", version: 1 }]);
    const { rows: audit } = await db.query("select count(*)::int as count from public.direct_entry_audit_events");
    assert.equal(audit[0].count, 0);
    const { rows: idempotency } = await db.query("select count(*)::int as count from public.direct_entry_rpc_idempotency");
    assert.equal(idempotency[0].count, 0);
  } finally {
    await db.close();
  }
});

test("revision insert failure rolls payment mutation, audit, and idempotency back", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    await db.exec(`
      create function public.fail_entry_revision() returns trigger language plpgsql as $$
      begin
        raise exception 'synthetic revision failure';
      end $$;
      create trigger synthetic_fail_entry_revision
        before insert on public.direct_entry_revisions
        for each row execute function public.fail_entry_revision();
      set role service_role;
    `);
    await assert.rejects(db.query(
      `select public.direct_entry_update_payment(
        $1,$2,$3,1,0,
        '{"state":"unknown","account_number":null,"bank_id":null,"account_holder_name":null}'::jsonb,
        'Synthetic rollback reason','revision_rollback_synthetic_01')`,
      [
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        "70000000-0000-4000-8000-000000000001",
      ],
    ), /synthetic revision failure/i);
    await db.exec("reset role");
    const { rows } = await db.query(`
      select e.version,
             (select count(*) from public.direct_entry_payments p where p.entry_id=e.entry_id) as payments,
             (select count(*) from public.direct_entry_audit_events a
               where a.resource_ref=e.entry_id::text and a.action='payment_update') as audits,
             (select count(*) from public.direct_entry_rpc_idempotency i
               where i.action='payment_update'
                 and i.idempotency_key='revision_rollback_synthetic_01') as keys
        from public.direct_entries e
       where e.entry_id='70000000-0000-4000-8000-000000000001'
    `);
    assert.equal(rows[0].version, 1);
    assert.equal(rows[0].payments, 0);
    assert.equal(rows[0].audits, 0);
    assert.equal(rows[0].keys, 0);
  } finally {
    await db.close();
  }
});

test("batch and draft RPCs bind idempotency, versions, scope, revisions, and audit atomically", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    await db.exec("set role service_role");
    const payload = JSON.stringify([{
      project_id: "project_synthetic_01",
      first_work_date: "2020-01-15",
      employee_code: "hrp-2020-000002",
      worker_details: {
        ...syntheticWorker("Synthetic Batch Person"),
        national_id: { state: "provided", value: "SYNTHETIC-NOT-REAL" },
      },
      recruiter_id: "30000000-0000-4000-8000-000000000001",
      labor_type: "TEMPORARY",
    }]);
    const { rows: first } = await db.query(
      "select public.direct_entry_create_batch($1,$2,$3::jsonb,$4) as result",
      [
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        payload,
        "batch_synthetic_01",
      ],
    );
    const { rows: replay } = await db.query(
      "select public.direct_entry_create_batch($1,$2,$3::jsonb,$4) as result",
      [
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        payload,
        "batch_synthetic_01",
      ],
    );
    assert.deepEqual(replay[0].result, first[0].result);
    const forbiddenPayload = JSON.stringify([{
      project_id: "project_synthetic_01",
      first_work_date: "2020-01-15",
      employee_code: "hrp-2020-000004",
      worker_details: { contacts: [{ "owner-user-id": "forged" }] },
      recruiter_id: "30000000-0000-4000-8000-000000000001",
      labor_type: "TEMPORARY",
    }]);
    await assert.rejects(db.query(
      "select public.direct_entry_create_batch($1,$2,$3::jsonb,$4)",
      [
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        forbiddenPayload,
        "forbidden_authority_synthetic_01",
      ],
    ), /client authority field forbidden/i);
    await db.exec("reset role");
    const { rows: harmlessOwnerName } = await db.query(
      `select public.direct_entry_contains_authority(
        '{"beneficial_owner_name":"synthetic"}'::jsonb) as forbidden`,
    );
    assert.equal(harmlessOwnerName[0].forbidden, false);
    await db.exec("set role service_role");
    await assert.rejects(db.query(
      "select public.direct_entry_create_batch($1,$2,$3::jsonb,$4)",
      [
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        payload.replace("000002", "000003"),
        "batch_synthetic_01",
      ],
    ), /idempotency key reused/i);
    const entryId = first[0].result.entry_ids[0];
    const { rows: update } = await db.query(
      "select public.direct_entry_update_draft_row($1,$2,$3,1,$4::jsonb,$5) as result",
      [
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        entryId,
        JSON.stringify({ worker_details: syntheticWorker("Synthetic Updated Person") }),
        "draft_update_synthetic_01",
      ],
    );
    assert.equal(update[0].result.version, 2);
    await assert.rejects(db.query(
      "select public.direct_entry_update_draft_row($1,$2,$3,1,$4::jsonb,$5)",
      [
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        entryId,
        '{"labor_type":"PERMANENT"}',
        "draft_update_stale_synthetic",
      ],
    ), /entry version conflict/i);
    await db.exec("reset role");
    const { rows: stored } = await db.query(
      `select (select count(*) from public.direct_entry_revisions where entry_id=$1) as revisions,
              (select count(*) from public.direct_entry_employment_status_events where entry_id=$1) as statuses,
              (select count(*) from public.direct_entry_submission_revisions
                where submission_id=$2) as submission_revisions,
              (select string_agg(to_jsonb(a)::text, ' ') from public.direct_entry_audit_events a
                where a.resource_ref=$1::text) as audit`,
      [entryId, first[0].result.submission_id],
    );
    assert.equal(stored[0].revisions, 2);
    assert.equal(stored[0].statuses, 1);
    assert.equal(stored[0].submission_revisions, 2);
    assert.doesNotMatch(stored[0].audit, /SYNTHETIC-NOT-REAL|Synthetic Batch Person|national_id/i);
  } finally {
    await db.close();
  }
});

test("draft delete is soft, versioned, replayable, and cannot empty a batch", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    await db.exec("set role service_role");
    const payload = JSON.stringify([10, 11].map((suffix) => ({
      project_id: "project_synthetic_01",
      first_work_date: "2020-01-15",
      employee_code: `hrp-2020-${String(suffix).padStart(6, "0")}`,
      worker_details: syntheticWorker(`Synthetic Delete ${suffix}`),
      recruiter_id: "30000000-0000-4000-8000-000000000001",
      labor_type: "TEMPORARY",
    })));
    const { rows: batch } = await db.query(
      "select public.direct_entry_create_batch($1,$2,$3::jsonb,$4) as result",
      [
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        payload,
        "delete_batch_synthetic_01",
      ],
    );
    const [first, second] = batch[0].result.entry_ids;
    const { rows: deleted } = await db.query(
      "select public.direct_entry_delete_draft_row($1,$2,$3,1,$4) as result",
      [
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        first,
        "delete_entry_synthetic_01",
      ],
    );
    const { rows: replay } = await db.query(
      "select public.direct_entry_delete_draft_row($1,$2,$3,1,$4) as result",
      [
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        first,
        "delete_entry_synthetic_01",
      ],
    );
    assert.deepEqual(replay[0].result, deleted[0].result);
    await assert.rejects(db.query(
      "select public.direct_entry_delete_draft_row($1,$2,$3,1,$4)",
      [
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        second,
        "delete_final_row_synthetic_01",
      ],
    ), /cannot delete final draft row/i);
    await db.exec("reset role");
    const { rows: stored } = await db.query(
      `select e.deleted_at is not null as deleted,
              e.version,
              (select count(*) from public.direct_entry_revisions where entry_id=e.entry_id) as revisions,
              (select count(*) from public.direct_entry_submission_revisions
                where submission_id=e.submission_id) as submission_revisions
         from public.direct_entries e where e.entry_id=$1`,
      [first],
    );
    assert.equal(stored[0].deleted, true);
    assert.equal(stored[0].version, 2);
    assert.equal(stored[0].revisions, 2);
    assert.equal(stored[0].submission_revisions, 2);
  } finally {
    await db.close();
  }
});

test("payment, employment status, and document metadata RPCs use OCC and sanitized audit", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    await db.exec(`
      insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)
        values
          ('20000000-0000-4000-8000-000000000002', 'entry_team', '2020-01-01'),
          ('20000000-0000-4000-8000-000000000002', 'document_upload', '2020-01-01');
    `);
    await db.exec(`
      insert into public.direct_entry_document_versions (
        document_id, candidate_id, document_type, version, idempotency_key,
        checksum_sha256, size_bytes, mime_type, storage_key, upload_status,
        scan_status, created_by_user_id
      ) values (
        '80000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001',
        'CCCD_FRONT', 1, 'ready_fixture_synthetic', repeat('9',64), 128,
        'image/jpeg',
        'p1.6/60000000-0000-4000-8000-000000000001/CCCD_FRONT/1/80000000-0000-4000-8000-000000000001',
        'READY', 'CLEAN', '20000000-0000-4000-8000-000000000001'
      );
      insert into public.direct_entry_document_events (
        document_id, upload_status, scan_status, attempts
      ) values ('80000000-0000-4000-8000-000000000001','READY','CLEAN',1);
    `);
    await db.exec("set role service_role");
    const actor = "10000000-0000-4000-8000-000000000001";
    const user = "20000000-0000-4000-8000-000000000001";
    const entry = "70000000-0000-4000-8000-000000000001";
    const { rows: payment } = await db.query(
      `select public.direct_entry_update_payment(
        $1,$2,$3,1,0,
        '{"state":"intentionally_blank","account_number":null,"bank_id":null,"account_holder_name":null}'::jsonb,
        'Synthetic payment correction','payment_synthetic_01') as result`,
      [actor, user, entry],
    );
    assert.equal(payment[0].result.entry_version, 2);
    assert.equal(payment[0].result.payment_version, 1);
    const { rows: status } = await db.query(
      `select public.direct_entry_apply_employment_status(
        $1,$2,$3,2,'ON',current_date,null,'Synthetic status reason','status_synthetic_01') as result`,
      [actor, user, entry],
    );
    assert.equal(status[0].result.entry_version, 3);
    const { rows: document } = await db.query(
      `select public.direct_entry_create_document_metadata(
        $1,$2,$3,3,'CCCD_FRONT','document_synthetic_01',
        repeat('a',64),1024,'image/jpeg','Synthetic document metadata'
      ) as result`,
      [actor, user, entry],
    );
    assert.equal(document[0].result.version, 2);
    const { rows: pendingReplacementProjection } = await db.query(
      `select public.direct_entry_read_projection($1,$2,$3) as result`,
      [actor, user, entry],
    );
    assert.equal(pendingReplacementProjection[0].result.documents.length, 1);
    assert.equal(pendingReplacementProjection[0].result.documents[0].version, 1);
    const { rows: documentReplay } = await db.query(
      `select public.direct_entry_create_document_metadata(
        $1,$2,$3,3,'CCCD_FRONT','document_synthetic_01',
        repeat('a',64),1024,'image/jpeg','Synthetic document metadata') as result`,
      [actor, user, entry],
    );
    assert.deepEqual(documentReplay[0].result, document[0].result);
    await assert.rejects(db.query(
      `select public.direct_entry_create_document_metadata(
        $1,$2,$3,3,'CCCD_FRONT','document_synthetic_01',
        repeat('b',64),1024,'image/jpeg','Synthetic document metadata')`,
      [actor, user, entry],
    ), /idempotency key reused/i);
    const reviewerActor = "10000000-0000-4000-8000-000000000002";
    const reviewerUser = "20000000-0000-4000-8000-000000000002";
    const { rows: crossActorRetry } = await db.query(
      `select public.direct_entry_create_document_metadata(
        $1,$2,$3,3,'CCCD_FRONT','document_synthetic_01',
        repeat('a',64),1024,'image/jpeg','Synthetic document metadata') as result`,
      [reviewerActor, reviewerUser, entry],
    );
    assert.equal(crossActorRetry[0].result.reused, true);
    assert.equal(crossActorRetry[0].result.entry_version, 4);
    await db.exec("reset role");
    const { rows: noDuplicateMutation } = await db.query(
      `select e.version,
         (select count(*) from public.direct_entry_revisions r where r.entry_id=e.entry_id) as revisions,
         (select count(*) from public.direct_entry_audit_events a
           where a.resource_ref=e.entry_id::text) as audits
       from public.direct_entries e where e.entry_id=$1`,
      [entry],
    );
    assert.equal(noDuplicateMutation[0].version, 4);
    assert.equal(noDuplicateMutation[0].revisions, 3);
    assert.equal(noDuplicateMutation[0].audits, 3);
    await db.exec("set role service_role");
    const documentId = document[0].result.document_id;
    const { rows: uploading } = await db.query(
      `select public.direct_entry_append_document_event(
        $1,1,'UPLOADING','PENDING',0,'uploader_start_synthetic') as result`,
      [documentId],
    );
    assert.equal(uploading[0].result.version, 2);
    assert.equal(uploading[0].result.reused, false);
    const { rows: uploadingReplay } = await db.query(
      `select public.direct_entry_append_document_event(
        $1,1,'UPLOADING','PENDING',0,'uploader_start_synthetic') as result`,
      [documentId],
    );
    assert.equal(uploadingReplay[0].result.reused, true);
    await assert.rejects(db.query(
      `select public.direct_entry_append_document_event(
        $1,1,'FAILED','REJECTED',0,'uploader_start_synthetic')`,
      [documentId],
    ), /idempotency key reused/i);
    for (const [expectedVersion, uploadStatus, scanStatus, attempts, key] of [
      [2, "QUARANTINED", "PENDING", 0, "uploader_quarantine_synthetic"],
      [3, "SCANNING", "PENDING", 0, "uploader_scan_synthetic"],
      [4, "FAILED", "REJECTED", 0, "uploader_reject_synthetic"],
    ]) {
      await db.query(
        `select public.direct_entry_append_document_event($1,$2,$3,$4,$5,$6)`,
        [documentId, expectedVersion, uploadStatus, scanStatus, attempts, key],
      );
    }
    const { rows: projection } = await db.query(
      `select public.direct_entry_read_projection($1,$2,$3) as result`,
      [actor, user, entry],
    );
    assert.equal(projection[0].result.worker_details.display_name, "Synthetic Person");
    assert.equal(projection[0].result.payment.state, "intentionally_blank");
    assert.equal(projection[0].result.documents.length, 1);
    assert.equal(projection[0].result.documents[0].version, 1);
    const { rows: resumed } = await db.query(
      `select public.direct_entry_append_document_event(
        $1,5,'UPLOADING','PENDING',1,'uploader_retry_synthetic') as result`,
      [documentId],
    );
    assert.equal(resumed[0].result.attempts, 1);
    await assert.rejects(db.query(
      `select public.direct_entry_append_document_event(
        $1,6,'QUARANTINED','PENDING',0,'uploader_attempts_decrease_synthetic')`,
      [documentId],
    ), /attempts cannot decrease|invalid document event transition/i);
    for (const [expectedVersion, uploadStatus, scanStatus, attempts, key] of [
      [6, "QUARANTINED", "PENDING", 1, "uploader_retry_quarantine_synthetic"],
      [7, "SCANNING", "PENDING", 1, "uploader_retry_scan_synthetic"],
      [8, "READY", "CLEAN", 1, "uploader_ready_synthetic"],
    ]) {
      await db.query(
        `select public.direct_entry_append_document_event($1,$2,$3,$4,$5,$6)`,
        [documentId, expectedVersion, uploadStatus, scanStatus, attempts, key],
      );
    }
    const { rows: readyProjection } = await db.query(
      `select public.direct_entry_read_projection($1,$2,$3) as result`,
      [actor, user, entry],
    );
    assert.equal(readyProjection[0].result.documents.length, 1);
    assert.equal(readyProjection[0].result.documents[0].version, 2);
    await db.exec("reset role");
    const { rows: storedDocument } = await db.query(
      `select storage_key, supersedes_document_id from public.direct_entry_document_versions
        where candidate_id='60000000-0000-4000-8000-000000000001'`,
    );
    assert.match(storedDocument[0].storage_key,
      /^p1\.6\/60000000-0000-4000-8000-000000000001\/CCCD_FRONT\/2\/[0-9a-f-]{36}$/);
    assert.equal(storedDocument[0].supersedes_document_id, "80000000-0000-4000-8000-000000000001");
    const { rows: audit } = await db.query(
      "select string_agg(to_jsonb(a)::text, ' ') as value from public.direct_entry_audit_events a where resource_ref=$1",
      [entry],
    );
    assert.doesNotMatch(audit[0].value, /Synthetic payment correction|Synthetic status reason|account_number|storage_key|checksum/i);
    const { rows: history } = await db.query(
      `select
         (select count(*) from public.direct_entry_revisions where entry_id=$1) as revisions,
         (select count(*) from public.direct_entry_document_events) as document_events,
         (select count(*) from public.direct_entry_employment_status_events where entry_id=$1) as status_events`,
      [entry],
    );
    assert.equal(history[0].revisions, 3);
    assert.equal(history[0].document_events, 10);
    assert.equal(history[0].status_events, 2);
  } finally {
    await db.close();
  }
});

test("privileged edit requires reason and version; read projection masks restricted fields", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    const actor = "10000000-0000-4000-8000-000000000001";
    const user = "20000000-0000-4000-8000-000000000001";
    const entry = "70000000-0000-4000-8000-000000000001";
    await db.exec(`
      delete from public.direct_entry_capability_grants
       where app_user_id='${user}' and capability in ('pii_view','payment_view','document_view');
      insert into public.direct_entry_payments
        (entry_id,state,account_number,bank_id,account_holder_name)
      values ('${entry}','provided','123456789','synthetic_bank','Synthetic Account Holder');
    `);
    await db.exec("set role service_role");
    await assert.rejects(db.query(
      `select public.direct_entry_privileged_edit($1,$2,$3,1,'{"labor_type":"PERMANENT"}'::jsonb,null,'privileged_missing_reason')`,
      [actor, user, entry],
    ), /reason required/i);
    const { rows: privileged } = await db.query(
      `select public.direct_entry_privileged_edit(
        $1,$2,$3,1,'{"labor_type":"PERMANENT"}'::jsonb,
        'Synthetic privileged correction','privileged_valid_reason') as result`,
      [actor, user, entry],
    );
    assert.equal(privileged[0].result.version, 2);
    const { rows } = await db.query(
      "select public.direct_entry_read_projection($1,$2,$3) as result",
      [actor, user, entry],
    );
    assert.deepEqual(rows[0].result.worker_details, {});
    assert.equal(rows[0].result.payment.account_number, "•••••6789");
    assert.equal(rows[0].result.payment.account_holder_name, undefined);
    assert.deepEqual(rows[0].result.documents, []);
  } finally {
    await db.close();
  }
});

test("change request approval is versioned, scoped, idempotent, and atomic across entries", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    await db.exec("set role service_role");
    const actor = "10000000-0000-4000-8000-000000000001";
    const user = "20000000-0000-4000-8000-000000000001";
    const reviewerActor = "10000000-0000-4000-8000-000000000002";
    const reviewerUser = "20000000-0000-4000-8000-000000000002";
    const submission = "50000000-0000-4000-8000-000000000001";
    const firstEntry = "70000000-0000-4000-8000-000000000001";
    await db.query(
      "select public.direct_entry_transition_submission($1,$2,$3,1,'REVIEW','review_synthetic_01')",
      [actor, user, submission],
    );
    await db.query(
      "select public.direct_entry_transition_submission($1,$2,$3,2,'SUBMITTED','submit_synthetic_01')",
      [actor, user, submission],
    );
    const { rows: request } = await db.query(
      `select public.direct_entry_create_change_request(
        $1,$2,$3::jsonb,'Synthetic request reason','change_create_synthetic_01') as result`,
      [actor, user, JSON.stringify([{
        entry_id: firstEntry,
        target_kind: "ENTRY_FIELD",
        expected_version: 1,
        proposal: { worker_details: {
          ...syntheticWorker("Synthetic revised name"),
          national_id: { state: "provided", value: "NOT-REAL" },
        } },
      }])],
    );
    const requestId = request[0].result.request_id;
    await assert.rejects(db.query(
      `select public.direct_entry_approve_change_request(
        $1,$2,$3,1,'Synthetic self review','self_review_synthetic_01')`,
      [actor, user, requestId],
    ), /cannot review own request/i);
    const { rows: approved } = await db.query(
      `select public.direct_entry_approve_change_request(
        $1,$2,$3,1,'Synthetic review reason','change_approve_synthetic_01') as result`,
      [reviewerActor, reviewerUser, requestId],
    );
    const { rows: replay } = await db.query(
      `select public.direct_entry_approve_change_request(
        $1,$2,$3,1,'Synthetic review reason','change_approve_synthetic_01') as result`,
      [reviewerActor, reviewerUser, requestId],
    );
    assert.deepEqual(replay[0].result, approved[0].result);
    assert.equal(approved[0].result.state, "APPROVED");
    const { rows: pendingForWithdrawal } = await db.query(
      `select public.direct_entry_create_change_request(
        $1,$2,$3::jsonb,'Synthetic withdraw reason','change_withdraw_create_01') as result`,
      [actor, user, JSON.stringify([{
        entry_id: firstEntry, target_kind: "ENTRY_FIELD", expected_version: 2,
        proposal: { labor_type: "TEMPORARY" },
      }])],
    );
    const withdrawId = pendingForWithdrawal[0].result.request_id;
    const { rows: withdrawn } = await db.query(
      `select public.direct_entry_withdraw_change_request(
        $1,$2,$3,1,'change_withdraw_synthetic_01') as result`,
      [actor, user, withdrawId],
    );
    assert.equal(withdrawn[0].result.state, "WITHDRAWN");
    const { rows: withdrawnReplay } = await db.query(
      `select public.direct_entry_withdraw_change_request(
        $1,$2,$3,1,'change_withdraw_synthetic_01') as result`,
      [actor, user, withdrawId],
    );
    assert.deepEqual(withdrawnReplay[0].result, withdrawn[0].result);
    const { rows: pendingForRejection } = await db.query(
      `select public.direct_entry_create_change_request(
        $1,$2,$3::jsonb,'Synthetic rejection reason','change_reject_create_01') as result`,
      [actor, user, JSON.stringify([{
        entry_id: firstEntry, target_kind: "ENTRY_FIELD", expected_version: 2,
        proposal: { labor_type: "TEMPORARY" },
      }])],
    );
    const rejectId = pendingForRejection[0].result.request_id;
    const { rows: rejected } = await db.query(
      `select public.direct_entry_reject_change_request(
        $1,$2,$3,1,'Synthetic reject reason','change_reject_synthetic_01') as result`,
      [reviewerActor, reviewerUser, rejectId],
    );
    assert.equal(rejected[0].result.state, "REJECTED");
    await db.exec("reset role");
    const { rows: result } = await db.query(
      `select e.version, e.worker_details,
              r.state as request_state, r.version as request_version,
              (select count(*) from public.direct_entry_revisions where entry_id=e.entry_id) as revisions,
              (select count(*) from public.direct_entry_change_request_revisions where request_id=r.request_id) as request_revisions,
              (select count(*) from public.direct_entry_change_request_revisions where request_id=$3) as withdrawn_revisions,
              (select count(*) from public.direct_entry_change_requests where request_id=$3 and state='WITHDRAWN') as withdrawn,
              (select count(*) from public.direct_entry_change_requests where request_id=$4 and state='REJECTED') as rejected,
              (select string_agg(to_jsonb(a)::text, ' ') from public.direct_entry_audit_events a
                where a.resource_ref in (e.entry_id::text,r.request_id::text)) as audit
         from public.direct_entries e
         join public.direct_entry_change_requests r on r.request_id=$1
        where e.entry_id=$2`,
      [requestId, firstEntry, withdrawId, rejectId],
    );
    assert.equal(result[0].version, 2);
    assert.equal(result[0].request_state, "APPROVED");
    assert.equal(result[0].request_version, 2);
    assert.equal(result[0].revisions, 1);
    assert.equal(result[0].request_revisions, 2);
    assert.equal(result[0].withdrawn_revisions, 2);
    assert.equal(result[0].withdrawn, 1);
    assert.equal(result[0].rejected, 1);
    assert.doesNotMatch(result[0].audit, /NOT-REAL|Synthetic review reason|national_id/i);
  } finally {
    await db.close();
  }
});

test("multi-entry change approval rolls back all rows, revisions, audit, state, and idempotency on failure", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    await db.exec("set role service_role");
    const actor = "10000000-0000-4000-8000-000000000001";
    const user = "20000000-0000-4000-8000-000000000001";
    const reviewerActor = "10000000-0000-4000-8000-000000000002";
    const reviewerUser = "20000000-0000-4000-8000-000000000002";
    const payload = JSON.stringify([
      {
        project_id: "project_synthetic_01", first_work_date: "2020-01-15",
        employee_code: "hrp-2020-000010", worker_details: syntheticWorker("Synthetic Row One"),
        recruiter_id: "30000000-0000-4000-8000-000000000001", labor_type: "TEMPORARY",
      },
      {
        project_id: "project_synthetic_01", first_work_date: "2020-01-15",
        employee_code: "hrp-2020-000011", worker_details: syntheticWorker("Synthetic Row Two"),
        recruiter_id: "30000000-0000-4000-8000-000000000001", labor_type: "TEMPORARY",
      },
    ]);
    const { rows: batch } = await db.query(
      "select public.direct_entry_create_batch($1,$2,$3::jsonb,$4) as result",
      [actor, user, payload, "atomic_batch_synthetic_01"],
    );
    const [first, second] = batch[0].result.entry_ids;
    const batchSubmission = batch[0].result.submission_id;
    await db.query(
      "select public.direct_entry_transition_submission($1,$2,$3,1,'REVIEW','atomic_review_01')",
      [actor, user, batchSubmission],
    );
    await db.query(
      "select public.direct_entry_transition_submission($1,$2,$3,2,'SUBMITTED','atomic_submit_01')",
      [actor, user, batchSubmission],
    );
    const { rows: change } = await db.query(
      `select public.direct_entry_create_change_request(
        $1,$2,$3::jsonb,'Synthetic atomic reason','atomic_change_create_01') as result`,
      [actor, user, JSON.stringify([first, second].map((entryId) => ({
        entry_id: entryId, target_kind: "ENTRY_FIELD", expected_version: 1,
        proposal: { labor_type: "PERMANENT" },
      })))],
    );
    const requestId = change[0].result.request_id;
    await db.exec("reset role");
    await db.exec(`
      create function public.fail_second_approval_audit() returns trigger language plpgsql as $$
      begin
        if new.action = 'change_request_approve' and new.resource_ref = '${second}' then
          raise exception 'synthetic audit failure';
        end if;
        return new;
      end $$;
      create trigger synthetic_fail_second_approval
        before insert on public.direct_entry_audit_events
        for each row execute function public.fail_second_approval_audit();
    `);
    await db.exec("set role service_role");
    await assert.rejects(db.query(
      `select public.direct_entry_approve_change_request(
        $1,$2,$3,1,'Synthetic approval reason','atomic_approve_synthetic_01')`,
      [reviewerActor, reviewerUser, requestId],
    ), /synthetic audit failure/i);
    await db.exec("reset role");
    const { rows: state } = await db.query(
      `select
         (select string_agg(version::text, ',' order by entry_id) from public.direct_entries where entry_id in ($1,$2)) as versions,
         (select state from public.direct_entry_change_requests where request_id=$3) as request_state,
         (select count(*) from public.direct_entry_change_request_revisions where request_id=$3) as request_revisions,
         (select count(*) from public.direct_entry_rpc_idempotency
            where app_user_id=$4 and action='change_request_approved'
              and idempotency_key='atomic_approve_synthetic_01') as idempotency_result`,
      [first, second, requestId, reviewerUser],
    );
    assert.equal(state[0].versions, "1,1");
    assert.equal(state[0].request_state, "PENDING");
    assert.equal(state[0].request_revisions, 1);
    assert.equal(state[0].idempotency_result, 0);
  } finally {
    await db.close();
  }
});

test("authorization date uses Ho Chi Minh today while resource memberships remain effective-dated", async () => {
  const db = await createDatabase();
  try {
    await db.exec("set time zone 'Pacific/Honolulu'");
    const { rows } = await db.query(`
      select public.direct_entry_authorization_date() as authorization_date,
             (statement_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date as hcm_date
    `);
    assert.equal(
      rows[0].authorization_date.toISOString().slice(0, 10),
      rows[0].hcm_date.toISOString().slice(0, 10),
    );
  } finally {
    await db.close();
  }
});

test("worker_details SQL constraint matches the W01 shape and rejects malformed optional values", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    const { rows: valid } = await db.query(
      "select public.direct_entry_valid_worker_details($1::jsonb) as valid",
      [JSON.stringify(syntheticWorker("Synthetic Worker"))],
    );
    assert.equal(valid[0].valid, true);
    for (const malformed of [
      { display_name: "Synthetic Worker" },
      { ...syntheticWorker("Synthetic Worker"), date_of_birth: { state: "provided" } },
      { ...syntheticWorker("Synthetic Worker"), date_of_birth: { state: "provided", value: "2025-02-30" } },
      { ...syntheticWorker("Synthetic Worker"), unknown_field: "not in W01" },
    ]) {
      const { rows } = await db.query(
        "select public.direct_entry_valid_worker_details($1::jsonb) as valid",
        [JSON.stringify(malformed)],
      );
      assert.equal(rows[0].valid, false);
    }
    await assert.rejects(db.query(
      `update public.direct_entries set worker_details='{"display_name":"Malformed"}'::jsonb,
         version=version+1 where entry_id='70000000-0000-4000-8000-000000000001'`,
    ), /direct_entries_worker_details_check/i);
  } finally {
    await db.close();
  }
});

test("status transitions reject no-op and invalid dates; correction supersedes only latest event", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    const { rows: todayRow } = await db.query(
      "select public.direct_entry_authorization_date() as today",
    );
    const today = todayRow[0].today.toISOString().slice(0, 10);
    await db.exec("set role service_role");
    const actor = "10000000-0000-4000-8000-000000000001";
    const user = "20000000-0000-4000-8000-000000000001";
    const entry = "70000000-0000-4000-8000-000000000001";
    await db.query(
      `select public.direct_entry_apply_employment_status(
        $1,$2,$3,1,'ON',$4::date,null,
        'Synthetic status transition','status_transition_synthetic')`,
      [actor, user, entry, today],
    );
    await assert.rejects(db.query(
      `select public.direct_entry_apply_employment_status(
        $1,$2,$3,2,'ON',$4::date,null,
        'Synthetic no-op','status_noop_synthetic')`,
      [actor, user, entry, today],
    ), /invalid employment status transition/i);
    await assert.rejects(db.query(
      `select public.direct_entry_apply_employment_status(
        $1,$2,$3,2,'OFF',$4::date+1,null,
        'Synthetic future date','status_future_synthetic')`,
      [actor, user, entry, today],
    ), /current or backdated to latest status/i);
    await assert.rejects(db.query(
      `select public.direct_entry_apply_employment_status(
        $1,$2,$3,2,'OFF','2020-01-15',null,
        'Synthetic backdated date','status_past_synthetic')`,
      [actor, user, entry],
    ), /current or backdated to latest status/i);
    await db.query(
      `select public.direct_entry_correct_latest_status(
        $1,$2,$3,2,2,'OFF',$4::date,'Synthetic leave reason',
        'Synthetic correction','status_correction_synthetic')`,
      [actor, user, entry, today],
    );
    await assert.rejects(db.query(
      `select public.direct_entry_correct_latest_status(
        $1,$2,$3,3,3,'OFF',$4::date,'Synthetic leave reason',
        'Synthetic no-op correction','status_correction_noop_synthetic')`,
      [actor, user, entry, today],
    ), /cannot be a no-op/i);
    await db.query(
      `select public.direct_entry_apply_employment_status(
        $1,$2,$3,3,'ON',$4::date,null,
        'Synthetic return transition','status_return_synthetic')`,
      [actor, user, entry, today],
    );
    await assert.rejects(db.query(
      `select public.direct_entry_correct_latest_status(
        $1,$2,$3,4,4,'UNCONFIRMED',$4::date,null,
        'Synthetic invalid correction','status_invalid_correction_synthetic')`,
      [actor, user, entry, today],
    ), /invalid employment status transition/i);
    await db.exec("reset role");
    const { rows } = await db.query(
      `select event_id, status, version, supersedes_event_id from public.direct_entry_employment_status_events
        where entry_id=$1 order by version`,
      [entry],
    );
    assert.deepEqual(rows.map(({ status, version, supersedes_event_id }) => ({
      status, version, supersedes_event_id,
    })), [
      { status: "UNCONFIRMED", version: 1, supersedes_event_id: null },
      { status: "ON", version: 2, supersedes_event_id: null },
      { status: "OFF", version: 3, supersedes_event_id: rows[1].event_id },
      { status: "ON", version: 4, supersedes_event_id: null },
    ]);
  } finally {
    await db.close();
  }
});

test("draft, privileged, and approval edits roll back when destination team scope is outside authority", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    await db.exec(`
      insert into public.teams (team_id, code, display_name)
        values ('40000000-0000-4000-8000-000000000002', 'SYNTH2', 'Synthetic team two');
      insert into public.recruiters (recruiter_id, display_name)
        values ('30000000-0000-4000-8000-000000000002', 'Synthetic recruiter two');
      insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from)
        values ('30000000-0000-4000-8000-000000000002', 'vendor', '2020-01-01');
      insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)
        values ('30000000-0000-4000-8000-000000000002',
          '40000000-0000-4000-8000-000000000002', '2020-01-01');
      insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)
        values
          ('20000000-0000-4000-8000-000000000002', 'entry_team', '2020-01-01'),
          ('20000000-0000-4000-8000-000000000002', 'entry_privileged_edit', '2020-01-01');
    `);
    const reviewerActor = "10000000-0000-4000-8000-000000000002";
    const reviewerUser = "20000000-0000-4000-8000-000000000002";
    const ownerActor = "10000000-0000-4000-8000-000000000001";
    const ownerUser = "20000000-0000-4000-8000-000000000001";
    const entry = "70000000-0000-4000-8000-000000000001";
    await db.exec("set role service_role");
    await assert.rejects(db.query(
      `select public.direct_entry_update_draft_row(
        $1,$2,$3,1,'{"recruiter_id":"30000000-0000-4000-8000-000000000002"}'::jsonb,
        'draft_destination_scope_synthetic')`,
      [reviewerActor, reviewerUser, entry],
    ), /scope.*denied/i);
    await assert.rejects(db.query(
      `select public.direct_entry_privileged_edit(
        $1,$2,$3,1,'{"recruiter_id":"30000000-0000-4000-8000-000000000002"}'::jsonb,
        'Synthetic reason','privileged_destination_scope_synthetic')`,
      [reviewerActor, reviewerUser, entry],
    ), /resource scope denied/i);
    const { rows: review } = await db.query(
      `select public.direct_entry_transition_submission($1,$2,$3,1,'REVIEW','destination_review_synthetic')`,
      [ownerActor, ownerUser, "50000000-0000-4000-8000-000000000001"],
    );
    assert.ok(review);
    await db.query(
      `select public.direct_entry_transition_submission($1,$2,$3,2,'SUBMITTED','destination_submit_synthetic')`,
      [ownerActor, ownerUser, "50000000-0000-4000-8000-000000000001"],
    );
    const { rows: request } = await db.query(
      `select public.direct_entry_create_change_request(
        $1,$2,$3::jsonb,'Synthetic change reason','destination_change_create_synthetic') as result`,
      [ownerActor, ownerUser, JSON.stringify([{
        entry_id: entry, target_kind: "ENTRY_FIELD", expected_version: 1,
        proposal: { recruiter_id: "30000000-0000-4000-8000-000000000002" },
      }])],
    );
    await assert.rejects(db.query(
      `select public.direct_entry_approve_change_request(
        $1,$2,$3,1,'Synthetic review reason','destination_approve_synthetic')`,
      [reviewerActor, reviewerUser, request[0].result.request_id],
    ), /resource scope denied/i);
    await db.exec("reset role");
    const { rows: unchanged } = await db.query(
      `select e.version, e.team_id, e.recruiter_id, r.state,
         (select count(*) from public.direct_entry_revisions where entry_id=e.entry_id) as revisions,
         (select count(*) from public.direct_entry_rpc_idempotency
           where idempotency_key in (
             'draft_destination_scope_synthetic','privileged_destination_scope_synthetic',
             'destination_approve_synthetic')) as failed_idempotencies
       from public.direct_entries e
       join public.direct_entry_change_requests r on r.request_id=$2
       where e.entry_id=$1`,
      [entry, request[0].result.request_id],
    );
    assert.equal(unchanged[0].version, 1);
    assert.equal(unchanged[0].team_id, "40000000-0000-4000-8000-000000000001");
    assert.equal(unchanged[0].recruiter_id, "30000000-0000-4000-8000-000000000001");
    assert.equal(unchanged[0].state, "PENDING");
    assert.equal(unchanged[0].revisions, 0);
    assert.equal(unchanged[0].failed_idempotencies, 0);
  } finally {
    await db.close();
  }
});

test("REVIEW is read-only and ordinary submitted users must use change requests", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    await db.exec("set role service_role");
    const actor = "10000000-0000-4000-8000-000000000001";
    const user = "20000000-0000-4000-8000-000000000001";
    const entry = "70000000-0000-4000-8000-000000000001";
    const submission = "50000000-0000-4000-8000-000000000001";
    await db.query(
      `select public.direct_entry_transition_submission($1,$2,$3,1,'REVIEW','lifecycle_review_synthetic')`,
      [actor, user, submission],
    );
    await assert.rejects(db.query(
      `select public.direct_entry_update_payment(
        $1,$2,$3,1,0,
        '{"state":"intentionally_blank","account_number":null,"bank_id":null,"account_holder_name":null}'::jsonb,
        'Synthetic reason','review_payment_denied_synthetic')`,
      [actor, user, entry],
    ), /REVIEW submissions are read-only/i);
    await assert.rejects(db.query(
      `select public.direct_entry_create_document_metadata(
        $1,$2,$3,1,'CCCD_FRONT','review_document_denied_synthetic',
        repeat('c',64),512,'image/png','Synthetic reason')`,
      [actor, user, entry],
    ), /REVIEW submissions are read-only/i);
    await assert.rejects(db.query(
      `select public.direct_entry_apply_employment_status(
        $1,$2,$3,1,'ON',current_date,null,'Synthetic reason','review_status_denied_synthetic')`,
      [actor, user, entry],
    ), /REVIEW submissions are read-only/i);
    await assert.rejects(db.query(
      `select public.direct_entry_privileged_edit(
        $1,$2,$3,1,'{"labor_type":"PERMANENT"}'::jsonb,
        'Synthetic reason','review_privileged_denied_synthetic')`,
      [actor, user, entry],
    ), /REVIEW submissions are read-only/i);
    await db.exec("reset role");
    await db.query(
      `delete from public.direct_entry_capability_grants
        where app_user_id=$1 and capability='entry_privileged_edit'`,
      [user],
    );
    await db.exec("set role service_role");
    await db.query(
      `select public.direct_entry_transition_submission($1,$2,$3,2,'SUBMITTED','lifecycle_submit_synthetic')`,
      [actor, user, submission],
    );
    await assert.rejects(db.query(
      `select public.direct_entry_update_payment(
        $1,$2,$3,1,0,
        '{"state":"intentionally_blank","account_number":null,"bank_id":null,"account_holder_name":null}'::jsonb,
        'Synthetic reason','lifecycle_direct_payment_synthetic')`,
      [actor, user, entry],
    ), /capability denied/i);
    await assert.rejects(db.query(
      `select public.direct_entry_create_document_metadata(
        $1,$2,$3,1,'CCCD_FRONT','lifecycle_direct_document_synthetic',
        repeat('c',64),512,'image/png','Synthetic reason')`,
      [actor, user, entry],
    ), /capability denied/i);
    await assert.rejects(db.query(
      `select public.direct_entry_create_change_request(
        $1,$2,$3::jsonb,'Synthetic document reason','lifecycle_fake_key_synthetic')`,
      [actor, user, JSON.stringify([{
        entry_id: entry, target_kind: "DOCUMENT", expected_version: 1,
        proposal: {
          document_type: "CCCD_FRONT", idempotency_key: "fake_key",
          checksum_sha256: "d".repeat(64), size_bytes: 512, mime_type: "image/png",
          storage_key: "caller/controlled/key",
        },
      }])],
    ), /unsupported change proposal field/i);
    const { rows: request } = await db.query(
      `select public.direct_entry_create_change_request(
        $1,$2,$3::jsonb,'Synthetic change reason','lifecycle_change_create_synthetic') as result`,
      [actor, user, JSON.stringify([{
        entry_id: entry, target_kind: "PAYMENT", expected_version: 1,
        proposal: {
          state: "intentionally_blank", account_number: null,
          bank_id: null, account_holder_name: null,
        },
      }])],
    );
    const { rows: approved } = await db.query(
      `select public.direct_entry_approve_change_request(
        $1,$2,$3,1,'Synthetic review reason','lifecycle_approve_synthetic') as result`,
      ["10000000-0000-4000-8000-000000000002",
        "20000000-0000-4000-8000-000000000002", request[0].result.request_id],
    );
    assert.equal(approved[0].result.state, "APPROVED");
    await db.exec("reset role");
    const { rows: stored } = await db.query(
      `select (select count(*) from public.direct_entry_payments where entry_id=$1) as payments,
         (select count(*) from public.direct_entry_document_versions) as documents,
         (select count(*) from public.direct_entry_revisions where entry_id=$1) as revisions`,
      [entry],
    );
    assert.equal(stored[0].payments, 1);
    assert.equal(stored[0].documents, 0);
    assert.equal(stored[0].revisions, 1);
  } finally {
    await db.close();
  }
});

test("privileged submitted payment and document edits require their capability, version, reason, revision, and audit", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    await db.exec(`
      insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)
        values
          ('20000000-0000-4000-8000-000000000002', 'payment_edit', '2020-01-01'),
          ('20000000-0000-4000-8000-000000000002', 'document_upload', '2020-01-01'),
          ('20000000-0000-4000-8000-000000000002', 'entry_privileged_edit', '2020-01-01'),
          ('20000000-0000-4000-8000-000000000002', 'entry_team', '2020-01-01');
    `);
    await db.exec("set role service_role");
    const ownerActor = "10000000-0000-4000-8000-000000000001";
    const ownerUser = "20000000-0000-4000-8000-000000000001";
    const privilegedActor = "10000000-0000-4000-8000-000000000002";
    const privilegedUser = "20000000-0000-4000-8000-000000000002";
    const entry = "70000000-0000-4000-8000-000000000001";
    const submission = "50000000-0000-4000-8000-000000000001";
    await db.query(
      `select public.direct_entry_transition_submission($1,$2,$3,1,'REVIEW','privileged_lifecycle_review_synthetic')`,
      [ownerActor, ownerUser, submission],
    );
    await db.query(
      `select public.direct_entry_transition_submission($1,$2,$3,2,'SUBMITTED','privileged_lifecycle_submit_synthetic')`,
      [ownerActor, ownerUser, submission],
    );
    const { rows: payment } = await db.query(
      `select public.direct_entry_update_payment(
        $1,$2,$3,1,0,
        '{"state":"intentionally_blank","account_number":null,"bank_id":null,"account_holder_name":null}'::jsonb,
        'Synthetic accounting correction','submitted_privileged_payment_synthetic') as result`,
      [privilegedActor, privilegedUser, entry],
    );
    assert.equal(payment[0].result.entry_version, 2);
    const { rows: document } = await db.query(
      `select public.direct_entry_create_document_metadata(
        $1,$2,$3,2,'CCCD_FRONT','submitted_privileged_document_synthetic',
        repeat('e',64),512,'image/png','Synthetic accounting document correction') as result`,
      [privilegedActor, privilegedUser, entry],
    );
    assert.equal(document[0].result.entry_version, 3);
    assert.equal(document[0].result.reused, false);
    await assert.rejects(db.query(
      `select public.direct_entry_update_payment(
        $1,$2,$3,3,1,
        '{"state":"intentionally_blank","account_number":null,"bank_id":null,"account_holder_name":null}'::jsonb,
        '','submitted_privileged_missing_reason_synthetic')`,
      [privilegedActor, privilegedUser, entry],
    ), /reason required/i);
    await db.exec("reset role");
    const { rows: stored } = await db.query(
      `select e.version,
         (select count(*) from public.direct_entry_revisions r where r.entry_id=e.entry_id) as revisions,
         (select count(*) from public.direct_entry_audit_events a
           where a.resource_ref=e.entry_id::text and a.outcome='APPLIED') as audits,
         (select count(*) from public.direct_entry_payments p where p.entry_id=e.entry_id) as payments,
         (select count(*) from public.direct_entry_document_versions d
           where d.candidate_id=e.candidate_id) as documents
       from public.direct_entries e where e.entry_id=$1`,
      [entry],
    );
    assert.equal(stored[0].version, 3);
    assert.equal(stored[0].revisions, 2);
    assert.equal(stored[0].audits, 2);
    assert.equal(stored[0].payments, 1);
    assert.equal(stored[0].documents, 1);
  } finally {
    await db.close();
  }
});

test("employment status accepts a valid backdated transition but not dates before latest or after HCM today", async () => {
  const db = await createDatabase();
  try {
    await seedSubmission(db);
    const { rows: dateRows } = await db.query(
      "select public.direct_entry_authorization_date() as today",
    );
    const today = dateRows[0].today.toISOString().slice(0, 10);
    const yesterday = new Date(`${today}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const backdated = yesterday.toISOString().slice(0, 10);
    const dayBefore = new Date(yesterday);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const tooEarly = dayBefore.toISOString().slice(0, 10);
    await db.exec("set role service_role");
    const actor = "10000000-0000-4000-8000-000000000001";
    const user = "20000000-0000-4000-8000-000000000001";
    const entry = "70000000-0000-4000-8000-000000000001";
    const { rows: off } = await db.query(
      `select public.direct_entry_apply_employment_status(
        $1,$2,$3,1,'OFF',$4::date,'Synthetic leave','Synthetic status reason',
        'status_backdated_off_synthetic') as result`,
      [actor, user, entry, backdated],
    );
    assert.equal(off[0].result.status, "OFF");
    await assert.rejects(db.query(
      `select public.direct_entry_apply_employment_status(
        $1,$2,$3,2,'ON',$4::date,null,'Synthetic status reason',
        'status_before_latest_synthetic')`,
      [actor, user, entry, tooEarly],
    ), /current or backdated to latest status/i);
    await assert.rejects(db.query(
      `select public.direct_entry_apply_employment_status(
        $1,$2,$3,2,'ON',$4::date+1,null,'Synthetic status reason',
        'status_after_today_synthetic')`,
      [actor, user, entry, today],
    ), /current or backdated to latest status/i);
  } finally {
    await db.close();
  }
});
