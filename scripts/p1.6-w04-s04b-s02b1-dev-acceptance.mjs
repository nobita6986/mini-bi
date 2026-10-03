#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import path from "node:path";
import pg from "pg";

import { resolveActor } from "../src/lib/auth/direct-entry-v2.ts";
import {
  receiveDocumentWorkerCallback,
  signDocumentWorkerCallback,
} from "../src/lib/direct-entry/document-worker-callback-api.ts";
import { createDirectEntryWriteRepository } from "../src/lib/direct-entry/write-repository.ts";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";
import { readMigrations } from "./lib/migration-validation.mjs";

const migrationDir = path.resolve("supabase/migrations");
const migrationName = "20261004010000_p1_6_w04_s04b_s02b1_worker_callback.sql";
const expectedRpcCount = 22;
const callbackSecret = randomBytes(32).toString("hex");
const checks = [];

function pass(label) {
  checks.push(label);
}

function key(namespace, label) {
  return `${namespace}_${label}_${randomBytes(3).toString("hex")}`;
}

async function roleQuery(client, role, sql, values = []) {
  const savepoint = `s02b1_role_${randomBytes(3).toString("hex")}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(`set local role ${role}`);
    const result = await client.query(sql, values);
    await client.query("reset role");
    await client.query(`release savepoint ${savepoint}`);
    return result;
  } catch (error) {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
    throw error;
  }
}

async function baseline(client) {
  const { rows } = await client.query(`
    select
      (select count(*)::int from public.data_sources where active and not is_test) as sources,
      (select coalesce(sum(b.recruited_count), 0)::bigint
         from public.daily_recruitment_breakdown b
         join public.data_sources s on s.id=b.source_id
        where s.active and not s.is_test) as total,
      (select count(*)::int
         from public.daily_recruitment_breakdown b
         join public.data_sources s on s.id=b.source_id
        where s.active and not s.is_test) as rows
  `);
  return rows[0];
}

async function assertDatabaseBoundary(client) {
  const { rows: migrationRows } = await client.query(
    "select version, checksum from public.schema_migrations order by version",
  );
  const local = await readMigrations(migrationDir);
  assert.equal(local.length, 29);
  assert.equal(migrationRows.length, 29);
  const applied = new Map(migrationRows.map(({ version, checksum }) => [version, checksum]));
  assert.deepEqual(local.filter(({ name }) => !applied.has(name)), []);
  assert.deepEqual(local.filter(({ name, checksum }) =>
    applied.has(name) && applied.get(name) !== checksum
  ), []);
  assert.ok(applied.has(migrationName));
  pass("29 migrations applied; no pending migrations or checksum mismatches");

  const { rows: tables } = await client.query(`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity,
      exists (select 1 from aclexplode(coalesce(c.relacl,
        acldefault('r'::"char",c.relowner))) a
        where a.grantee=0 and a.privilege_type in
          ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE')) as public_dml,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as anon_dml,
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as auth_dml
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname like 'direct_entry_%'
      and c.relkind in ('r','p')
  `);
  assert.ok(tables.length > 0);
  for (const table of tables) {
    assert.equal(table.relrowsecurity, true, `${table.relname}: RLS`);
    assert.equal(table.relforcerowsecurity, true, `${table.relname}: FORCE RLS`);
    assert.equal(table.public_dml, false, `${table.relname}: PUBLIC DML`);
    assert.equal(table.anon_dml, false, `${table.relname}: anon DML`);
    assert.equal(table.auth_dml, false, `${table.relname}: authenticated DML`);
  }

  const { rows: rpc } = await client.query(`
    select p.prosecdef,
      coalesce(array_to_string(p.proconfig, ','), '') as config,
      coalesce(bool_or(a.grantee=0 and a.privilege_type='EXECUTE'),false) as public_exec,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon_exec,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as auth_exec,
      has_function_privilege('service_role',p.oid,'EXECUTE') as service_exec,
      (select count(*)::int from pg_proc q join pg_namespace qn on qn.oid=q.pronamespace
        where qn.nspname='public' and q.proname like 'direct_entry_%'
          and has_function_privilege('service_role',q.oid,'EXECUTE')) as rpc_count
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    left join lateral aclexplode(coalesce(p.proacl,
      acldefault('f'::"char",p.proowner))) a on true
    where n.nspname='public' and p.oid =
      'public.direct_entry_apply_document_worker_callback(uuid,uuid,integer,integer,integer,text,text,bigint,text,text,text)'::regprocedure
    group by p.oid
  `);
  assert.equal(rpc.length, 1);
  assert.equal(rpc[0].prosecdef, true);
  assert.ok(rpc[0].config.includes("search_path=pg_catalog, public"));
  assert.equal(rpc[0].public_exec, false);
  assert.equal(rpc[0].anon_exec, false);
  assert.equal(rpc[0].auth_exec, false);
  assert.equal(rpc[0].service_exec, true);
  assert.equal(rpc[0].rpc_count, expectedRpcCount);
  pass("callback RPC service_role-only SECURITY DEFINER; RLS/FORCE RLS and DML ACL unchanged");
}

async function insertActor(client, actor, capabilities) {
  await client.query("insert into auth.users(id) values ($1)", [actor.auth_subject]);
  await client.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled) values ($1,$2,true)",
    [actor.app_user_id, actor.auth_subject],
  );
  for (const capability of capabilities) {
    await client.query(`
      insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)
      values ($1,$2,public.direct_entry_authorization_date()-1)
    `, [actor.app_user_id, capability]);
  }
  await client.query(`
    insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from)
    values ($1,'own',public.direct_entry_authorization_date()-1)
  `, [actor.app_user_id]);
}

async function resolveFixtureActor(client, authSubject) {
  const { rows } = await roleQuery(
    client,
    "service_role",
    "select public.direct_entry_resolve_actor_context($1::uuid) as context",
    [authSubject],
  );
  return resolveActor({
    session: { auth_subject: authSubject, provider: "supabase", authenticated_at: null },
    repository: { loadByAuthSubject: async () => rows[0]?.context ?? null },
    at: new Date().toISOString(),
  });
}

async function rpc(client, name, args) {
  const queries = {
    direct_entry_create_batch: [
      `select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text) data`,
      [args.auth_subject, args.app_user_id, JSON.stringify(args.rows), args.idempotency_key],
    ],
    direct_entry_reserve_document_upload: [
      `select public.direct_entry_reserve_document_upload(
        $1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text,$7::text,
        $8::bigint,$9::text,$10::text) data`,
      [
        args.auth_subject, args.app_user_id, args.entry_id, args.expected_entry_version,
        args.document_type, args.idempotency_key, args.checksum_sha256,
        args.size_bytes, args.mime_type, args.reason,
      ],
    ],
    direct_entry_apply_document_worker_callback: [
      `select public.direct_entry_apply_document_worker_callback(
        $1::uuid,$2::uuid,$3::integer,$4::integer,$5::integer,$6::text,
        $7::text,$8::bigint,$9::text,$10::text,$11::text) data`,
      [
        args.callback_id, args.document_id, args.document_version, args.event_sequence,
        args.attempt, args.storage_object_ref, args.checksum_sha256, args.size_bytes,
        args.mime_type, args.upload_outcome, args.scan_outcome,
      ],
    ],
    direct_entry_read_projection: [
      "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) data",
      [args.auth_subject, args.app_user_id, args.entry_id],
    ],
  };
  const query = queries[name];
  if (!query) throw new Error("Unexpected RPC in S02B1 acceptance");
  try {
    const { rows } = await roleQuery(client, "service_role", query[0], query[1]);
    return { data: rows[0]?.data, error: null };
  } catch (error) {
    return { data: null, error: { code: error.code, message: error.message } };
  }
}

function callbackRequest(payload, secret = callbackSecret) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Request("https://example.invalid/api/direct-entry/document-worker/callback", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-direct-entry-signature": signDocumentWorkerCallback(body, secret),
    },
    body,
  });
}

async function sendCallback(payload, repository, secret = callbackSecret) {
  return receiveDocumentWorkerCallback(callbackRequest(payload, secret), "true", {
    repository,
    secret,
  });
}

async function snapshot(client, entryId, appUserId) {
  const { rows } = await client.query(`
    select e.version,
      (select count(*)::int from public.direct_entry_document_versions d
        where d.candidate_id=e.candidate_id) documents,
      (select count(*)::int from public.direct_entry_document_events ev
        join public.direct_entry_document_versions d using(document_id)
        where d.candidate_id=e.candidate_id) events,
      (select count(*)::int from public.direct_entry_revisions r where r.entry_id=e.entry_id) revisions,
      (select count(*)::int from public.direct_entry_audit_events a
        where a.resource_ref=e.entry_id::text and a.action='document_worker_callback') audits,
      (select count(*)::int from public.direct_entry_rpc_idempotency i
        where i.app_user_id=$2 and i.action='document_worker_callback') idempotencies
    from public.direct_entries e where e.entry_id=$1
  `, [entryId, appUserId]);
  assert.equal(rows.length, 1);
  return rows[0];
}

async function fixture(client, namespace) {
  const actor = { auth_subject: randomUUID(), app_user_id: randomUUID() };
  const recruiterId = randomUUID();
  const teamId = randomUUID();
  const projectId = `${namespace}_project`;
  const employeeCode = `hrp-2026-${100000 + Number.parseInt(randomBytes(4).toString("hex"), 16) % 900000}`;
  await insertActor(client, actor, [
    "entry_create", "submission_create", "entry_own", "document_upload", "document_view",
  ]);
  await client.query("insert into public.teams(team_id,code,display_name) values ($1,$2,$3)", [
    teamId, `${namespace}_team`, "Synthetic S02B1 team",
  ]);
  await client.query(
    "insert into public.recruiters(recruiter_id,display_name) values ($1,$2)",
    [recruiterId, "Synthetic S02B1 recruiter"],
  );
  await client.query(`
    insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from)
    values ($1,'hrp','2020-01-01')
  `, [recruiterId]);
  await client.query(`
    insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)
    values ($1,$2,'2020-01-01')
  `, [recruiterId, teamId]);
  await client.query(
    "insert into public.direct_entry_projects(project_id,display_name) values ($1,$2)",
    [projectId, "Synthetic S02B1 project"],
  );
  const resolved = await resolveFixtureActor(client, actor.auth_subject);
  assert.equal(resolved.ok, true);
  const created = await rpc(client, "direct_entry_create_batch", {
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    idempotency_key: key(namespace, "create"),
    rows: [{
      project_id: projectId,
      first_work_date: "2026-10-15",
      employee_code: employeeCode,
      worker_details: {
        display_name: "Synthetic S02B1 worker",
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      },
      recruiter_id: recruiterId,
      labor_type: "TEMPORARY",
    }],
  });
  assert.equal(created.error, null, created.error?.message);
  const { rows } = await client.query(
    "select entry_id,candidate_id,version from public.direct_entries where employee_code=$1",
    [employeeCode],
  );
  assert.equal(rows.length, 1);
  return { actor, entry: rows[0], employeeCode, recruiterId, teamId, projectId };
}

async function reserve(client, fixtureData, type = "CCCD_FRONT", label = "reserve") {
  const checksum = createHash("sha256").update(`synthetic-${label}`).digest("hex");
  const { rows: entryRows } = await client.query(
    "select version from public.direct_entries where entry_id=$1",
    [fixtureData.entry.entry_id],
  );
  assert.equal(entryRows.length, 1);
  const result = await rpc(client, "direct_entry_reserve_document_upload", {
    auth_subject: fixtureData.actor.auth_subject,
    app_user_id: fixtureData.actor.app_user_id,
    entry_id: fixtureData.entry.entry_id,
    expected_entry_version: entryRows[0].version,
    document_type: type,
    idempotency_key: key("s02b1", label),
    checksum_sha256: checksum,
    size_bytes: 512,
    mime_type: "image/png",
    reason: "Synthetic worker boundary acceptance",
  });
  assert.equal(result.error, null, result.error?.message);
  return {
    ...result.data,
    checksum_sha256: checksum,
    size_bytes: 512,
    mime_type: "image/png",
  };
}

function callbackFor(reservation, values = {}) {
  return {
    callback_id: randomUUID(),
    document_id: reservation.document_id,
    document_version: reservation.version,
    event_sequence: reservation.event_sequence,
    attempt: reservation.attempt,
    storage_object_ref: reservation.storage_key,
    checksum_sha256: reservation.checksum_sha256,
    size_bytes: reservation.size_bytes,
    mime_type: reservation.mime_type,
    upload_outcome: "success",
    scan_outcome: "clean",
    ...values,
  };
}

async function runAcceptance(client, reportingBefore) {
  const namespace = `s02b1_${randomBytes(5).toString("hex")}`;
  let transactionOpen = false;
  let data;
  try {
    await client.query("begin");
    transactionOpen = true;
    data = await fixture(client, namespace);
    const repository = createDirectEntryWriteRepository((name, args) => {
      if (name === "direct_entry_apply_document_worker_callback") {
        return rpc(client, name, {
          callback_id: args.p_callback_id,
          document_id: args.p_document_id,
          document_version: args.p_document_version,
          event_sequence: args.p_event_sequence,
          attempt: args.p_attempt,
          storage_object_ref: args.p_storage_object_ref,
          checksum_sha256: args.p_checksum_sha256,
          size_bytes: args.p_size_bytes,
          mime_type: args.p_mime_type,
          upload_outcome: args.p_upload_outcome,
          scan_outcome: args.p_scan_outcome,
        });
      }
      return rpc(client, name, args);
    });

    const reservation = await reserve(client, data);
    const clean = callbackFor(reservation);
    const accepted = await sendCallback(clean, repository);
    assert.equal(accepted.status, 200);
    const ready = await accepted.json();
    assert.equal(ready.upload_status, "READY");
    assert.equal(ready.scan_status, "CLEAN");
    const afterReady = await snapshot(client, data.entry.entry_id, data.actor.app_user_id);
    assert.equal(afterReady.documents, 1);
    assert.equal(afterReady.events, 5);
    assert.equal(afterReady.audits, 1);
    assert.equal(afterReady.idempotencies, 1);
    const { rows: protectedRows } = await client.query(`
      select
        (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb)
           from public.direct_entry_audit_events a
          where a.resource_ref=$1::text and a.action='document_worker_callback') audits,
        (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
           from public.direct_entry_revisions r where r.entry_id=$2) revisions,
        (select coalesce(jsonb_agg(to_jsonb(ev)), '[]'::jsonb)
           from public.direct_entry_document_events ev
           join public.direct_entry_document_versions d using(document_id)
          where d.candidate_id=$3) events
    `, [data.entry.entry_id, data.entry.entry_id, data.entry.candidate_id]);
    const protectedText = JSON.stringify(protectedRows[0]);
    assert.equal(protectedText.includes(reservation.storage_key), false);
    assert.equal(protectedText.includes(reservation.checksum_sha256), false);
    assert.equal(protectedText.includes("synthetic-browser-name"), false);

    const replay = await sendCallback(clean, repository);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).reused, true);
    assert.deepEqual(await snapshot(client, data.entry.entry_id, data.actor.app_user_id), afterReady);
    pass("authenticated upload+clean transition reaches READY once; replay is idempotent");

    const pendingReservation = await reserve(client, data, "CCCD_FRONT", "replacement_pending");
    const pending = callbackFor(pendingReservation, { scan_outcome: "pending" });
    const pendingResponse = await sendCallback(pending, repository);
    assert.equal(pendingResponse.status, 200);
    const pendingResult = await pendingResponse.json();
    assert.equal(pendingResult.upload_status, "QUARANTINED");
    assert.equal(pendingResult.scan_status, "PENDING");
    const projectionResult = await rpc(client, "direct_entry_read_projection", {
      auth_subject: data.actor.auth_subject,
      app_user_id: data.actor.app_user_id,
      entry_id: data.entry.entry_id,
    });
    assert.equal(projectionResult.error, null);
    const documents = projectionResult.data.documents;
    assert.equal(documents.length, 1);
    assert.equal(documents[0].version, 1);
    const projectionText = JSON.stringify(projectionResult.data);
    for (const privateValue of [
      reservation.storage_key, reservation.checksum_sha256, pendingReservation.storage_key,
    ]) assert.equal(projectionText.includes(privateValue), false);
    pass("replacement pending remains excluded; prior READY+CLEAN projection is preserved and private");

    const pendingScan = callbackFor(pendingReservation, {
      callback_id: randomUUID(),
      event_sequence: pendingResult.event_sequence,
      attempt: pendingReservation.attempt,
      scan_outcome: "clean",
    });
    const scanAccepted = await sendCallback(pendingScan, repository);
    assert.equal(scanAccepted.status, 200);
    assert.equal((await scanAccepted.json()).upload_status, "READY");

    const stale = await sendCallback(pending, repository);
    assert.equal(stale.status, 200);
    assert.equal((await stale.json()).reused, true);
    const outOfOrder = await sendCallback(callbackFor(pendingReservation, {
      callback_id: randomUUID(),
      event_sequence: pendingReservation.event_sequence,
    }), repository);
    assert.equal(outOfOrder.status, 409);
    pass("scan-pending completes on returned sequence; stale/out-of-order callback cannot overwrite newer state");

    const infectedReservation = await reserve(client, data, "CCCD_BACK", "infected");
    const infected = await sendCallback(callbackFor(infectedReservation, {
      scan_outcome: "infected",
    }), repository);
    assert.equal(infected.status, 200);
    const infectedResult = await infected.json();
    assert.equal(infectedResult.upload_status, "QUARANTINED");
    assert.equal(infectedResult.scan_status, "REJECTED");
    const afterInfectedProjection = await rpc(client, "direct_entry_read_projection", {
      auth_subject: data.actor.auth_subject,
      app_user_id: data.actor.app_user_id,
      entry_id: data.entry.entry_id,
    });
    assert.equal(afterInfectedProjection.error, null);
    assert.equal(
      afterInfectedProjection.data.documents.some((document) => document.document_type === "CCCD_BACK"),
      false,
    );
    const suspiciousReservation = await reserve(client, data, "CCCD_BACK", "suspicious");
    const suspicious = await sendCallback(callbackFor(suspiciousReservation, {
      scan_outcome: "suspicious",
    }), repository);
    assert.equal(suspicious.status, 200);
    const suspiciousResult = await suspicious.json();
    assert.equal(suspiciousResult.upload_status, "QUARANTINED");
    assert.equal(suspiciousResult.scan_status, "REJECTED");

    const failureReservation = await reserve(client, data, "EMPLOYMENT_CONTRACT", "transient");
    const transient = await sendCallback(callbackFor(failureReservation, {
      upload_outcome: "transient_failure",
      scan_outcome: "pending",
    }), repository);
    assert.equal(transient.status, 200);
    const failedResult = await transient.json();
    assert.equal(failedResult.upload_status, "FAILED");
    assert.equal(failedResult.attempts, 1);
    const terminalAttempts = await reserve(client, data, "EMPLOYMENT_CONTRACT", "terminal_attempts");
    let sequence = terminalAttempts.event_sequence;
    let attempt = terminalAttempts.attempt;
    let terminalResult;
    for (let count = 0; count < 3; count += 1) {
      const retryReservation = count === 0 ? terminalAttempts : {
        ...terminalAttempts, event_sequence: sequence, attempt,
      };
      const response = await sendCallback(callbackFor(retryReservation, {
        callback_id: randomUUID(),
        upload_outcome: "transient_failure",
        scan_outcome: "pending",
      }), repository);
      if (response.status === 200) {
        terminalResult = await response.json();
        sequence = terminalResult.event_sequence;
        attempt = terminalResult.attempts + 1;
      } else {
        break;
      }
    }
    assert.equal(terminalResult?.upload_status, "FAILED");
    assert.equal(terminalResult?.attempts, 3);
    const exhausted = await sendCallback(callbackFor({
      ...terminalAttempts, event_sequence: sequence, attempt,
    }, {
      callback_id: randomUUID(),
      upload_outcome: "transient_failure",
      scan_outcome: "pending",
    }), repository);
    assert.equal(exhausted.status, 400);
    pass("retry attempts stop at three; infected/suspicious content is quarantined from current projection");

    const conflictReservation = await reserve(client, data, "EMPLOYMENT_CONTRACT", "changed_payload");
    const conflictPayload = callbackFor(conflictReservation);
    const firstConflict = await sendCallback(conflictPayload, repository);
    assert.ok(firstConflict.status === 200 || firstConflict.status === 409);
    const altered = { ...conflictPayload, scan_outcome: "infected" };
    const changedKey = await sendCallback(altered, repository);
    assert.equal(changedKey.status, 409);
    pass("same callback id with changed payload conflicts");

    const rollbackReservation = await reserve(client, data, "EMPLOYMENT_CONTRACT", "rollback");
    const beforeRollback = await snapshot(client, data.entry.entry_id, data.actor.app_user_id);
    const triggerName = `${namespace}_audit_failure`;
    await client.query(`
      create function pg_temp.${triggerName}_fn() returns trigger language plpgsql as $$
      begin
        if new.action = 'document_worker_callback' then
          raise exception 'synthetic audit insert failure' using errcode='P0001';
        end if;
        return new;
      end $$;
    `);
    await client.query(`
      create trigger ${triggerName} before insert on public.direct_entry_audit_events
      for each row execute function pg_temp.${triggerName}_fn()
    `);
    const failedTransition = await sendCallback(callbackFor(rollbackReservation), repository);
    await client.query(`drop trigger ${triggerName} on public.direct_entry_audit_events`);
    await client.query(`drop function pg_temp.${triggerName}_fn()`);
    assert.equal(failedTransition.status, 500);
    assert.deepEqual(await snapshot(client, data.entry.entry_id, data.actor.app_user_id), beforeRollback);
    const { rows: tempObjects } = await client.query(`
      select
        (select count(*)::int from pg_trigger where tgname=$1) triggers,
        (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='pg_temp_' || pg_my_temp_schema()::text and p.proname=$2) functions
    `, [triggerName, `${triggerName}_fn`]);
    assert.deepEqual(tempObjects[0], { triggers: 0, functions: 0 });
    pass("audit failure rolls back callback events, revision, audit and idempotency atomically");

    const beforeInvalidAuth = await snapshot(client, data.entry.entry_id, data.actor.app_user_id);
    const invalidAuth = await receiveDocumentWorkerCallback(
      callbackRequest(callbackFor(rollbackReservation), "wrong synthetic callback key"),
      "true",
      { repository, secret: callbackSecret },
    );
    assert.equal(invalidAuth.status, 401);
    assert.deepEqual(
      await snapshot(client, data.entry.entry_id, data.actor.app_user_id),
      beforeInvalidAuth,
    );
    pass("callback authentication failure is rejected before database mutation");

    await client.query("rollback");
    transactionOpen = false;
    const residue = await client.query(`
      select
        (select count(*)::int from public.direct_entry_app_users where app_user_id=$1) actors,
        (select count(*)::int from public.direct_entries where employee_code=$2) entries,
        (select count(*)::int from public.teams where code=$3) teams,
        (select count(*)::int from public.direct_entry_candidates where candidate_id=$4) candidates,
        (select count(*)::int from public.recruiters where recruiter_id=$5) recruiters,
        (select count(*)::int from public.direct_entry_projects where project_id=$6) projects,
        (select count(*)::int from public.direct_entry_document_versions d
          where d.candidate_id=$4) documents,
        (select count(*)::int from public.direct_entry_document_events ev
          join public.direct_entry_document_versions d using(document_id)
          where d.candidate_id=$4) events
    `, [
      data.actor.app_user_id, data.employeeCode, `${namespace}_team`,
      data.entry.candidate_id, data.recruiterId, `${namespace}_project`,
    ]);
    assert.deepEqual(residue.rows[0], {
      actors: 0, entries: 0, teams: 0, candidates: 0, recruiters: 0, projects: 0,
      documents: 0, events: 0,
    });
    assert.deepEqual(await baseline(client), reportingBefore);
    pass("outer transaction rollback leaves zero synthetic fixture residue; reporting baseline unchanged");
  } catch (error) {
    if (transactionOpen) await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function main() {
  const { databaseUrl, projectRef, usesPooler } = await loadSupabaseConfig();
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: buildSslOptions(),
    application_name: "p1.6-s04b-s02b1-dev-acceptance",
  });
  await client.connect();
  try {
    console.log(`DEV acceptance project: ${projectRef.slice(0, 4)}***; pooler=${usesPooler ? "yes" : "no"}`);
    await assertDatabaseBoundary(client);
    const reportingBefore = await baseline(client);
    await runAcceptance(client, reportingBefore);
    for (const [index, label] of checks.entries()) console.log(`PASS ${index + 1}. ${label}`);
    console.log(`S04B-S02B1 DEV acceptance: ${checks.length} checks passed.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`S04B-S02B1 DEV acceptance failed; SQLSTATE=${error.code ?? "none"}; constraint=${error.constraint ?? "none"}; message=${error.message}`);
  process.exitCode = 1;
});
