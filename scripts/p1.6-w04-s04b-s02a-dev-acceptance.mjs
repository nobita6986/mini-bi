#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

import { resolveActor } from "../src/lib/auth/direct-entry-v2.ts";
import { uploadDirectEntryDocument } from "../src/lib/direct-entry/document-api.ts";
import { createDirectEntryWriteRepository } from "../src/lib/direct-entry/write-repository.ts";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";
import { readMigrations } from "./lib/migration-validation.mjs";

const migrationDir = path.resolve("supabase/migrations");
const migrationName = "20261003230000_p1_6_w04_s04b_document_reservation_adapter.sql";
const effectiveDate = "2026-10-15";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const checks = [];

function pass(label) {
  checks.push(label);
}

function key(namespace, label) {
  return `${namespace}_${label}_${randomBytes(3).toString("hex")}`;
}

async function baseline(client) {
  const { rows } = await client.query(`
    select
      (select count(*)::int from public.data_sources where active and not is_test)
        as "reportingSources",
      (select count(*)::int from public.data_sources where is_test)
        as "existingFixtureSources",
      (select coalesce(sum(b.recruited_count), 0)::bigint
         from public.daily_recruitment_breakdown b
         join public.data_sources s on s.id = b.source_id
        where s.active and not s.is_test) as "recruitedTotal",
      (select count(*)::int
         from public.daily_recruitment_breakdown b
         join public.data_sources s on s.id = b.source_id
        where s.active and not s.is_test) as "breakdownRows"
  `);
  return rows[0];
}

async function assertMigrations(client) {
  const local = await readMigrations(migrationDir);
  const { rows } = await client.query(
    "select version, checksum from public.schema_migrations order by version",
  );
  assert.equal(local.length, 28);
  assert.equal(rows.length, 28);
  const applied = new Map(rows.map(({ version, checksum }) => [version, checksum]));
  const pending = local.filter(({ name }) => !applied.has(name)).map(({ name }) => name);
  const mismatch = local.filter(({ name, checksum }) =>
    applied.has(name) && applied.get(name) !== checksum
  ).map(({ name }) => name);
  assert.deepEqual(pending, []);
  assert.deepEqual(mismatch, []);
  assert.ok(applied.has(migrationName));
  pass("28 local/DEV migration records; 0 pending and 0 checksum mismatch");
}

async function assertDatabaseBoundary(client) {
  const dml = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"];
  const { rows: tables } = await client.query(`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity,
      exists (
        select 1 from aclexplode(coalesce(
          c.relacl, acldefault('r'::"char", c.relowner)
        )) a where a.grantee=0 and a.privilege_type=any($1::text[])
      ) as public_read_or_dml,
      has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
      has_table_privilege('anon', c.oid, 'INSERT') as anon_insert,
      has_table_privilege('anon', c.oid, 'UPDATE') as anon_update,
      has_table_privilege('anon', c.oid, 'DELETE') as anon_delete,
      has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
      has_table_privilege('authenticated', c.oid, 'INSERT') as auth_insert,
      has_table_privilege('authenticated', c.oid, 'UPDATE') as auth_update,
      has_table_privilege('authenticated', c.oid, 'DELETE') as auth_delete,
      has_table_privilege('service_role', c.oid, 'SELECT') as service_select,
      has_table_privilege('service_role', c.oid, 'INSERT') as service_insert,
      has_table_privilege('service_role', c.oid, 'UPDATE') as service_update,
      has_table_privilege('service_role', c.oid, 'DELETE') as service_delete
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname like 'direct_entry_%'
      and c.relkind in ('r','p')
    order by c.relname
  `, [dml]);
  assert.ok(tables.length > 0);
  for (const table of tables) {
    assert.equal(table.relrowsecurity, true, `${table.relname}: RLS`);
    assert.equal(table.relforcerowsecurity, true, `${table.relname}: FORCE RLS`);
    assert.equal(table.public_read_or_dml, false, `${table.relname}: PUBLIC access`);
    for (const rolePrivilege of [
      "anon_select", "anon_insert", "anon_update", "anon_delete",
      "auth_select", "auth_insert", "auth_update", "auth_delete",
      "service_select", "service_insert", "service_update", "service_delete",
    ]) assert.equal(table[rolePrivilege], false, `${table.relname}: ${rolePrivilege}`);
  }

  const { rows: reservation } = await client.query(`
    select p.prosecdef,
      coalesce(array_to_string(p.proconfig, ','), '') as config,
      coalesce(bool_or(a.grantee=0 and a.privilege_type='EXECUTE'), false) as public_exec,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
      (select count(*)::int from pg_proc q join pg_namespace qn on qn.oid=q.pronamespace
        where qn.nspname='public' and q.proname like 'direct_entry_%'
          and has_function_privilege('service_role', q.oid, 'EXECUTE')) as rpc_count
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    left join lateral aclexplode(coalesce(
      p.proacl, acldefault('f'::"char", p.proowner)
    )) a on true
    where n.nspname='public'
      and p.oid='public.direct_entry_reserve_document_upload(uuid,uuid,uuid,integer,text,text,text,bigint,text,text)'::regprocedure
    group by p.oid
  `);
  assert.equal(reservation.length, 1);
  assert.equal(reservation[0].prosecdef, true);
  assert.ok(reservation[0].config.includes("search_path=pg_catalog, public"));
  assert.equal(reservation[0].public_exec, false);
  assert.equal(reservation[0].anon_exec, false);
  assert.equal(reservation[0].auth_exec, false);
  assert.equal(reservation[0].service_exec, true);
  assert.equal(reservation[0].rpc_count, 21);

  const { rows: eventRpc } = await client.query(`
    select has_function_privilege('anon',
      'public.direct_entry_append_document_event(uuid,integer,text,text,integer,text)', 'EXECUTE') anon,
      has_function_privilege('authenticated',
      'public.direct_entry_append_document_event(uuid,integer,text,text,integer,text)', 'EXECUTE') authenticated,
      has_function_privilege('service_role',
      'public.direct_entry_append_document_event(uuid,integer,text,text,integer,text)', 'EXECUTE') service_role
  `);
  assert.deepEqual(eventRpc[0], { anon: false, authenticated: false, service_role: true });
  pass("21 RPCs; reservation/event RPC ACL, SECURITY DEFINER, safe search_path, and table RLS/ACL verified");
  return reservation[0].rpc_count;
}

async function roleQuery(client, role, sql, values = []) {
  const savepoint = `s02a_role_${randomBytes(3).toString("hex")}`;
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

async function expectSqlState(client, label, callback, code) {
  const savepoint = `s02a_expect_${randomBytes(3).toString("hex")}`;
  await client.query(`savepoint ${savepoint}`);
  let caught;
  try {
    await callback();
  } catch (error) {
    caught = error;
  }
  await client.query(`rollback to savepoint ${savepoint}`);
  await client.query(`release savepoint ${savepoint}`);
  assert.ok(caught, `${label}: expected rejection`);
  assert.equal(caught.code, code, `${label}: SQLSTATE`);
  pass(label);
}

async function resolveFixtureActor(client, authSubject) {
  const { rows } = await roleQuery(
    client,
    "service_role",
    "select public.direct_entry_resolve_actor_context($1::uuid) as context",
    [authSubject],
  );
  const context = rows[0]?.context;
  if (!context) return { ok: false, reason: "ACTOR_MAPPING_MISSING" };
  return resolveActor({
    session: { auth_subject: authSubject, provider: "supabase", authenticated_at: null },
    repository: { loadByAuthSubject: async () => context },
    at: new Date().toISOString(),
  });
}

async function insertActor(client, actor, capabilities, { enabled = true, teamId = null } = {}) {
  await client.query("insert into auth.users(id) values ($1)", [actor.authSubject]);
  await client.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled) values ($1,$2,$3)",
    [actor.appUserId, actor.authSubject, enabled],
  );
  for (const capability of capabilities) {
    await client.query(`
      insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)
      values ($1,$2,public.direct_entry_authorization_date()-1)
    `, [actor.appUserId, capability]);
  }
  await client.query(`
    insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from)
    values ($1,$2,$3,public.direct_entry_authorization_date()-1)
  `, [actor.appUserId, teamId ? "team" : "own", teamId]);
}

async function callRpc(client, name, args) {
  const statements = {
    direct_entry_create_batch: [
      `select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text) as data`,
      [args.p_auth_subject, args.p_app_user_id, JSON.stringify(args.p_rows), args.p_idempotency_key],
    ],
    direct_entry_reserve_document_upload: [
      `select public.direct_entry_reserve_document_upload(
        $1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text,$7::text,
        $8::bigint,$9::text,$10::text
      ) as data`,
      [
        args.p_auth_subject, args.p_app_user_id, args.p_entry_id,
        args.p_expected_entry_version, args.p_document_type, args.p_idempotency_key,
        args.p_checksum_sha256, args.p_size_bytes, args.p_mime_type, args.p_reason,
      ],
    ],
    direct_entry_read_projection: [
      `select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as data`,
      [args.p_auth_subject, args.p_app_user_id, args.p_entry_id],
    ],
  };
  const statement = statements[name];
  if (!statement) throw new Error("Unexpected RPC in document acceptance");
  try {
    const { rows } = await roleQuery(client, "service_role", statement[0], statement[1]);
    return { data: rows[0]?.data, error: null };
  } catch (error) {
    return { data: null, error: { code: error.code, constraint: error.constraint, message: error.message } };
  }
}

function uploadRequest(entryId, {
  idempotencyKey,
  expectedVersion,
  bytes = png,
  mimeType = "image/png",
  documentType = "CCCD_FRONT",
  fields = {},
  includeFile = true,
} = {}) {
  const form = new FormData();
  form.set("document_type", documentType);
  form.set("expected_entry_version", String(expectedVersion));
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  if (includeFile) form.set("file", new Blob([bytes], { type: mimeType }), "synthetic-browser-name.png");
  return new Request(`https://example.test/api/direct-entry/entries/${entryId}/documents`, {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "idempotency-key": idempotencyKey,
    },
    body: form,
  });
}

async function snapshot(client, entryId, candidateId, appUserId, keys) {
  const { rows } = await client.query(`
    select e.version,
      (select count(*)::int from public.direct_entry_document_versions d
        where d.candidate_id=e.candidate_id) documents,
      (select count(*)::int from public.direct_entry_document_events v
        join public.direct_entry_document_versions d using(document_id)
        where d.candidate_id=e.candidate_id) events,
      (select count(*)::int from public.direct_entry_revisions r where r.entry_id=e.entry_id) revisions,
      (select count(*)::int from public.direct_entry_audit_events a
        where a.resource_ref=e.entry_id::text and a.action='document_metadata_create') audits,
      (select count(*)::int from public.direct_entry_rpc_idempotency i
        where i.app_user_id=$3 and i.action='document_metadata_create'
          and i.idempotency_key=any($4::text[])) idempotencies
    from public.direct_entries e where e.entry_id=$1 and e.candidate_id=$2
  `, [entryId, candidateId, appUserId, keys]);
  assert.equal(rows.length, 1);
  return rows[0];
}

async function injectFailure(client, namespace, table, suffix, condition) {
  const name = `${namespace.toLowerCase()}_${suffix}`;
  await client.query(`
    create function pg_temp.${name}_fn() returns trigger language plpgsql as $$
    begin
      if ${condition} then raise exception 'S04B synthetic failure' using errcode='P0001'; end if;
      return new;
    end
    $$
  `);
  await client.query(`
    create trigger ${name}_trigger before insert on public.${table}
    for each row execute function pg_temp.${name}_fn()
  `);
  return async () => {
    await client.query(`drop trigger ${name}_trigger on public.${table}`);
    await client.query(`drop function pg_temp.${name}_fn()`);
  };
}

async function runAcceptance(client, namespace, reportingBefore) {
  const owner = { authSubject: randomUUID(), appUserId: randomUUID() };
  const outsider = { authSubject: randomUUID(), appUserId: randomUUID() };
  const disabled = { authSubject: randomUUID(), appUserId: randomUUID() };
  const viewer = { authSubject: randomUUID(), appUserId: randomUUID() };
  const unmappedAuth = randomUUID();
  const recruiterId = randomUUID();
  const teamId = randomUUID();
  const projectId = `s04b_${randomBytes(7).toString("hex")}`;
  const employeeCode = `hrp-2026-${100000 + Number.parseInt(randomBytes(4).toString("hex"), 16) % 900000}`;
  const fixtureKeys = [];
  const actorIds = [owner, outsider, disabled, viewer];
  let entryId;
  let candidateId;
  let submissionId;
  let transactionOpen = false;

  await client.query("begin");
  transactionOpen = true;
  try {
    await insertActor(client, owner, [
      "entry_create", "submission_create", "entry_own", "document_upload", "document_view",
    ]);
    await insertActor(client, outsider, ["entry_own", "document_upload"]);
    await insertActor(client, disabled, ["entry_own", "document_upload"], { enabled: false });
    await client.query(
      "insert into public.teams(team_id,code,display_name) values ($1,$2,$3)",
      [teamId, `${namespace}_TEAM`, "Synthetic S04B team"],
    );
    await insertActor(client, viewer, ["entry_team"], { teamId });
    await client.query("insert into auth.users(id) values ($1)", [unmappedAuth]);
    await client.query(
      "insert into public.recruiters(recruiter_id,display_name) values ($1,$2)",
      [recruiterId, "Synthetic S04B recruiter"],
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
      [projectId, "Synthetic S04B project"],
    );

    const ownerResolution = await resolveFixtureActor(client, owner.authSubject);
    assert.equal(ownerResolution.ok, true);
    assert.ok(ownerResolution.actor.capabilities.includes("entry_own"));
    assert.equal((await resolveFixtureActor(client, disabled.authSubject)).reason, "ACTOR_DISABLED");
    assert.equal((await resolveFixtureActor(client, unmappedAuth)).reason, "ACTOR_MAPPING_MISSING");

    const repository = createDirectEntryWriteRepository((name, args) => callRpc(client, name, args));
    const session = { actor: ownerResolution, response_headers: {} };
    const unavailableDeps = {
      resolveSession: async () => session,
      repository,
      storage: { available: () => false, async upload() { throw new Error("must not upload"); } },
    };
    const createKey = key(namespace, "create");
    const created = await callRpc(client, "direct_entry_create_batch", {
      p_auth_subject: owner.authSubject,
      p_app_user_id: owner.appUserId,
      p_rows: [{
        project_id: projectId,
        first_work_date: effectiveDate,
        employee_code: employeeCode,
        worker_details: {
          display_name: "Synthetic document acceptance worker",
          date_of_birth: { state: "omitted" },
          national_id: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "omitted" },
        },
        recruiter_id: recruiterId,
        labor_type: "TEMPORARY",
      }],
      p_idempotency_key: createKey,
    });
    if (created.error) {
      const error = new Error("synthetic batch creation was rejected");
      error.code = created.error.code;
      error.constraint = created.error.constraint;
      throw error;
    }
    entryId = created.data.entry_ids[0];
    submissionId = created.data.submission_id;
    const { rows: entryRows } = await client.query(
      "select candidate_id,version from public.direct_entries where entry_id=$1",
      [entryId],
    );
    candidateId = entryRows[0].candidate_id;
    let entryVersion = entryRows[0].version;
    pass("synthetic valid owner and scoped DRAFT fixture resolved and created");

    const unavailableKey = key(namespace, "adapter_off");
    const admissionKeys = [unavailableKey];
    const initial = await snapshot(client, entryId, candidateId, owner.appUserId, admissionKeys);
    const noStorage = await uploadDirectEntryDocument(
      uploadRequest(entryId, { idempotencyKey: unavailableKey, expectedVersion: entryVersion }),
      entryId, "true", unavailableDeps,
    );
    assert.equal(noStorage.status, 503);
    assert.equal((await noStorage.json()).code, "DOCUMENT_STORAGE_UNAVAILABLE");
    assert.deepEqual(await snapshot(client, entryId, candidateId, owner.appUserId, admissionKeys), initial);

    const validationKey = (label) => {
      const idempotencyKey = key(namespace, label);
      admissionKeys.push(idempotencyKey);
      return idempotencyKey;
    };
    const invalid = [
      [uploadRequest(entryId, {
        idempotencyKey: validationKey("bad_magic"), expectedVersion: entryVersion,
        bytes: Buffer.from("%PDF-1.7"),
      }), "DOCUMENT_CONTENT_INVALID"],
      [uploadRequest(entryId, {
        idempotencyKey: validationKey("bad_mime"), expectedVersion: entryVersion,
        mimeType: "text/plain",
      }), "DOCUMENT_MIME_INVALID"],
      [uploadRequest(entryId, {
        idempotencyKey: validationKey("oversized"), expectedVersion: entryVersion,
        bytes: Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]),
      }), "DOCUMENT_SIZE_INVALID"],
      [uploadRequest(entryId, {
        idempotencyKey: validationKey("bad_type"), expectedVersion: entryVersion,
        documentType: "PASSPORT",
      }), "DOCUMENT_TYPE_INVALID"],
      [uploadRequest(entryId, {
        idempotencyKey: validationKey("missing_file"), expectedVersion: entryVersion,
        includeFile: false,
      }), "DOCUMENT_FILE_REQUIRED"],
    ];
    for (const [request, expectedCode] of invalid) {
      const response = await uploadDirectEntryDocument(request, entryId, "true", unavailableDeps);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, expectedCode);
    }
    const authorityResponse = await uploadDirectEntryDocument(
      uploadRequest(entryId, {
        idempotencyKey: validationKey("authority"), expectedVersion: entryVersion,
        fields: { metadata: JSON.stringify([{ actor: { app_user_id: outsider.appUserId } }]) },
      }),
      entryId, "true", unavailableDeps,
    );
    assert.equal(authorityResponse.status, 400);
    assert.equal((await authorityResponse.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
    for (const [field, value] of [
      ["storage_key", "arbitrary-key"], ["upload_status", "READY"],
      ["scan_status", "CLEAN"], ["public_url", "https://example.test/file"],
    ]) {
      const response = await uploadDirectEntryDocument(
        uploadRequest(entryId, {
          idempotencyKey: validationKey(`inject_${field}`), expectedVersion: entryVersion,
          fields: { [field]: value },
        }),
        entryId, "true", unavailableDeps,
      );
      assert.equal(response.status, 400, field);
    }
    assert.deepEqual(await snapshot(client, entryId, candidateId, owner.appUserId, admissionKeys), initial);
    pass("missing/invalid/oversize/authority and forged storage/READY/CLEAN/URL inputs reject before mutation");

    const uploads = [];
    const mockDeps = {
      resolveSession: async () => session,
      repository,
      storage: {
        available: () => true,
        async upload(input) {
          uploads.push(input);
          return {
            kind: "durable",
            document_id: input.document_id,
            version: input.version,
            storage_key: input.storage_key,
            checksum_sha256: input.checksum_sha256,
            object_version: "synthetic-object-revision",
          };
        },
      },
    };
    const firstKey = key(namespace, "first");
    fixtureKeys.push(firstKey);
    const firstExpectedVersion = entryVersion;
    const firstRequest = () => uploadRequest(entryId, {
      idempotencyKey: firstKey, expectedVersion: firstExpectedVersion,
    });
    const firstResponse = await uploadDirectEntryDocument(firstRequest(), entryId, "true", mockDeps);
    assert.equal(firstResponse.status, 202);
    const first = await firstResponse.json();
    assert.equal(first.upload_status, "QUEUED");
    assert.equal(first.scan_status, "PENDING");
    assert.equal(first.callback_pending, true);
    assert.equal("storage_key" in first, false);
    assert.equal("checksum_sha256" in first, false);
    assert.equal(uploads.length, 1);
    const checksum = createHash("sha256").update(png).digest("hex");
    assert.equal(uploads[0].checksum_sha256, checksum);
    assert.equal(uploads[0].bytes.byteLength, png.byteLength);
    assert.equal("filename" in uploads[0], false);
    const { rows: storedRows } = await client.query(`
      select d.document_id,d.version,d.checksum_sha256,d.storage_key,d.upload_status,
        d.scan_status,d.supersedes_document_id,e.version as entry_version
      from public.direct_entry_document_versions d
      join public.direct_entries e on e.candidate_id=d.candidate_id
      where d.candidate_id=$1 and d.document_type='CCCD_FRONT' and d.version=1
    `, [candidateId]);
    assert.equal(storedRows.length, 1);
    assert.equal(storedRows[0].checksum_sha256, checksum);
    assert.match(storedRows[0].storage_key,
      /^p1\.6\/[0-9a-f-]{36}\/CCCD_FRONT\/1\/[0-9a-f-]{36}$/i);
    assert.equal(storedRows[0].storage_key.includes(employeeCode), false);
    assert.equal(storedRows[0].upload_status, "QUEUED");
    assert.equal(storedRows[0].scan_status, "PENDING");
    entryVersion = storedRows[0].entry_version;

    const firstCounts = await snapshot(client, entryId, candidateId, owner.appUserId, [firstKey]);
    assert.deepEqual(
      {
        documents: firstCounts.documents,
        events: firstCounts.events,
        revisions: firstCounts.revisions,
        audits: firstCounts.audits,
        idempotencies: firstCounts.idempotencies,
      },
      { documents: 1, events: 1, revisions: 2, audits: 1, idempotencies: 1 },
    );
    const replay = await uploadDirectEntryDocument(firstRequest(), entryId, "true", mockDeps);
    const replayBody = await replay.json();
    if (replay.status !== 202) {
      const error = new Error("same-key retry failed");
      error.marker = replayBody.code ?? `HTTP_${replay.status}`;
      throw error;
    }
    assert.equal(replayBody.document_id, first.document_id);
    assert.equal(uploads[1].storage_key, uploads[0].storage_key);
    assert.deepEqual(
      {
        documents: (await snapshot(client, entryId, candidateId, owner.appUserId, [firstKey])).documents,
        events: (await snapshot(client, entryId, candidateId, owner.appUserId, [firstKey])).events,
        revisions: (await snapshot(client, entryId, candidateId, owner.appUserId, [firstKey])).revisions,
        audits: (await snapshot(client, entryId, candidateId, owner.appUserId, [firstKey])).audits,
        idempotencies: (await snapshot(client, entryId, candidateId, owner.appUserId, [firstKey])).idempotencies,
      },
      { documents: 1, events: 1, revisions: 2, audits: 1, idempotencies: 1 },
    );
    pass("server checksum/opaque key, same-key replay, and exactly-once event/revision/audit/idempotency verified");

    const changed = await uploadDirectEntryDocument(
      uploadRequest(entryId, {
        idempotencyKey: firstKey,
        expectedVersion: 1,
        bytes: Buffer.concat([png, Buffer.from([0x01])]),
      }),
      entryId, "true", mockDeps,
    );
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).code, "DOCUMENT_VERSION_CONFLICT");
    assert.deepEqual(
      await snapshot(client, entryId, candidateId, owner.appUserId, [firstKey]),
      firstCounts,
    );
    const staleKey = key(namespace, "stale");
    fixtureKeys.push(staleKey);
    const beforeStale = await snapshot(client, entryId, candidateId, owner.appUserId, [firstKey, staleKey]);
    const stale = await uploadDirectEntryDocument(
      uploadRequest(entryId, {
        idempotencyKey: staleKey, expectedVersion: 1,
      }),
      entryId, "true", mockDeps,
    );
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "DOCUMENT_VERSION_CONFLICT");
    assert.deepEqual(
      await snapshot(client, entryId, candidateId, owner.appUserId, [firstKey, staleKey]),
      beforeStale,
    );
    assert.equal(uploads.length, 2);
    pass("same-key changed content and stale OCC return stable 409 without upload/retry");

    const replacementKey = key(namespace, "replacement");
    fixtureKeys.push(replacementKey);
    const replacementResponse = await uploadDirectEntryDocument(
      uploadRequest(entryId, {
        idempotencyKey: replacementKey, expectedVersion: entryVersion,
      }),
      entryId, "true", mockDeps,
    );
    assert.equal(replacementResponse.status, 202);
    const replacement = await replacementResponse.json();
    const { rows: lineage } = await client.query(`
      select document_id,version,supersedes_document_id,upload_status,scan_status
      from public.direct_entry_document_versions
      where candidate_id=$1 and document_type='CCCD_FRONT'
      order by version
    `, [candidateId]);
    assert.equal(lineage.length, 2);
    assert.equal(lineage[1].version, 2);
    assert.equal(lineage[1].supersedes_document_id, lineage[0].document_id);
    assert.equal(lineage[1].upload_status, "QUEUED");
    assert.equal(lineage[1].scan_status, "PENDING");
    entryVersion = replacement.entry_version;
    pass("replacement preserves v1 and creates v2 with supersedes lineage, QUEUED/PENDING");

    const fullProjection = await callRpc(client, "direct_entry_read_projection", {
      p_auth_subject: owner.authSubject, p_app_user_id: owner.appUserId, p_entry_id: entryId,
    });
    assert.equal(fullProjection.error, null);
    const fullText = JSON.stringify(fullProjection.data);
    for (const forbidden of [
      "checksum_sha256", "storage_key", "synthetic-browser-name.png",
      "public_url", "synthetic-object-revision",
    ]) assert.equal(fullText.includes(forbidden), false, forbidden);
    const restrictedProjection = await callRpc(client, "direct_entry_read_projection", {
      p_auth_subject: viewer.authSubject, p_app_user_id: viewer.appUserId, p_entry_id: entryId,
    });
    assert.equal(restrictedProjection.error, null);
    assert.deepEqual(restrictedProjection.data.documents, []);
    const { rows: privateRows } = await client.query(`
      select
        (select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb)
           from public.direct_entry_revisions r where r.entry_id=$1) revisions,
        (select coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb)
           from public.direct_entry_audit_events a where a.resource_ref=$1::text
             and a.action='document_metadata_create') audits,
        (select coalesce(jsonb_agg(to_jsonb(v)),'[]'::jsonb)
           from public.direct_entry_document_events v
           join public.direct_entry_document_versions d using(document_id)
          where d.candidate_id=$2) events
    `, [entryId, candidateId]);
    const privateText = JSON.stringify(privateRows[0]);
    for (const forbidden of [
      "checksum_sha256", "storage_key", "synthetic-browser-name.png",
      "public_url", "synthetic-object-revision",
    ]) assert.equal(privateText.includes(forbidden), false, forbidden);
    assert.ok(privateRows[0].audits.length > 0);
    assert.ok(privateRows[0].revisions.length > 0);
    assert.ok(privateRows[0].events.length >= 2);
    pass("full/restricted projections and audit/revision/event contain no storage internals or filename");

    for (const [label, actor] of [
      ["disabled actor denied", disabled],
      ["out-of-scope actor denied", outsider],
    ]) {
      const denialKey = key(namespace, label.replaceAll(" ", "_"));
      fixtureKeys.push(denialKey);
      await expectSqlState(client, label, () => roleQuery(
        client,
        "service_role",
        `select public.direct_entry_reserve_document_upload(
          $1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text,$7::text,
          $8::bigint,$9::text,$10::text
        )`,
        [
          actor.authSubject, actor.appUserId, entryId, entryVersion, "CCCD_BACK",
          denialKey, createHash("sha256").update(png).digest("hex"), png.length, "image/png", null,
        ],
      ), "42501");
    }
    const deniedArgs = [
      unmappedAuth, randomUUID(), entryId, entryVersion, "CCCD_BACK",
      key(namespace, "unmapped"), createHash("sha256").update(png).digest("hex"), png.length,
      "image/png", null,
    ];
    fixtureKeys.push(deniedArgs[5]);
    await expectSqlState(client, "unmapped actor denied", () => roleQuery(
      client,
      "service_role",
      `select public.direct_entry_reserve_document_upload(
        $1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text,$7::text,
        $8::bigint,$9::text,$10::text
      )`,
      deniedArgs,
    ), "42501");
    for (const role of ["anon", "authenticated"]) {
      await expectSqlState(client, `${role} cannot execute reservation RPC`, () => roleQuery(
        client,
        role,
        `select public.direct_entry_reserve_document_upload(
          $1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text,$7::text,
          $8::bigint,$9::text,$10::text
        )`,
        [
          owner.authSubject, owner.appUserId, entryId, entryVersion, "CCCD_BACK",
          key(namespace, role), createHash("sha256").update(png).digest("hex"),
          png.length, "image/png", null,
        ],
      ), "42501");
    }

    for (const [table, suffix, condition] of [
      ["direct_entry_audit_events", "audit", "new.action='document_metadata_create'"],
      ["direct_entry_revisions", "revision", `new.entry_id='${entryId}'::uuid`],
    ]) {
      const failureKey = key(namespace, `failure_${suffix}`);
      fixtureKeys.push(failureKey);
      const before = await snapshot(client, entryId, candidateId, owner.appUserId, [failureKey]);
      const removeTrigger = await injectFailure(client, namespace, table, suffix, condition);
      try {
        const response = await uploadDirectEntryDocument(
          uploadRequest(entryId, {
            idempotencyKey: failureKey,
            expectedVersion: entryVersion,
            documentType: "EMPLOYMENT_CONTRACT",
          }),
          entryId, "true", mockDeps,
        );
        assert.equal(response.status, 500);
        assert.equal((await response.json()).code, "DOCUMENT_UNAVAILABLE");
      } finally {
        await removeTrigger();
      }
      assert.deepEqual(
        await snapshot(client, entryId, candidateId, owner.appUserId, [failureKey]),
        before,
      );
      pass(`${suffix} insertion failure atomically rolls back reservation`);
    }

    await client.query("rollback");
    transactionOpen = false;
    const { rows: residue } = await client.query(`
      select
        (select count(*)::int from auth.users where id=any($1::uuid[])) auth_users,
        (select count(*)::int from public.direct_entry_app_users where app_user_id=any($2::uuid[])) app_users,
        (select count(*)::int from public.direct_entry_capability_grants where app_user_id=any($2::uuid[])) capabilities,
        (select count(*)::int from public.direct_entry_scope_grants where app_user_id=any($2::uuid[])) scopes,
        (select count(*)::int from public.recruiters where recruiter_id=$3) recruiters,
        (select count(*)::int from public.teams where team_id=$4) teams,
        (select count(*)::int from public.direct_entry_projects where project_id=$5) projects,
        (select count(*)::int from public.recruiter_provider_memberships where recruiter_id=$3) provider_memberships,
        (select count(*)::int from public.recruiter_team_memberships where recruiter_id=$3) team_memberships,
        (select count(*)::int from public.direct_entry_submissions where submission_id=$6) submissions,
        (select count(*)::int from public.direct_entries where entry_id=$7 and employee_code=$8) entries,
        (select count(*)::int from public.direct_entry_candidates where candidate_id=$9) candidates,
        (select count(*)::int from public.direct_entry_document_versions where candidate_id=$9) documents,
        (select count(*)::int from public.direct_entry_document_events v
          join public.direct_entry_document_versions d using(document_id)
          where d.candidate_id=$9) events,
        (select count(*)::int from public.direct_entry_revisions where entry_id=$7) revisions,
        (select count(*)::int from public.direct_entry_audit_events where resource_ref=$7::text) audits,
        (select count(*)::int from public.direct_entry_rpc_idempotency
          where idempotency_key=any($10::text[])) idempotencies,
        (select count(*)::int from pg_trigger
          where tgname like $11) temporary_triggers,
        (select count(*)::int from pg_proc
          where pronamespace=pg_my_temp_schema() and proname like $11) temporary_functions
    `, [
      [...actorIds.map(({ authSubject }) => authSubject), unmappedAuth],
      actorIds.map(({ appUserId }) => appUserId),
      recruiterId, teamId, projectId, submissionId, entryId, employeeCode, candidateId,
      [createKey, ...fixtureKeys],
      `${namespace.toLowerCase()}_%`,
    ]);
    assert.deepEqual(residue[0], {
      auth_users: 0,
      app_users: 0,
      capabilities: 0,
      scopes: 0,
      recruiters: 0,
      teams: 0,
      projects: 0,
      provider_memberships: 0,
      team_memberships: 0,
      submissions: 0,
      entries: 0,
      candidates: 0,
      documents: 0,
      events: 0,
      revisions: 0,
      audits: 0,
      idempotencies: 0,
      temporary_triggers: 0,
      temporary_functions: 0,
    });
    assert.deepEqual(await baseline(client), reportingBefore);
    pass("transaction rollback leaves zero fixture or temporary-function residue; reporting baseline unchanged");
  } finally {
    if (transactionOpen) await client.query("rollback").catch(() => {});
  }
}

async function main() {
  const config = await loadSupabaseConfig();
  const manifest = JSON.parse(await readFile(
    new URL("./p1.6-w03-g3-dev-manifest.json", import.meta.url),
    "utf8",
  ));
  assert.equal(config.projectRef, manifest.expectedProjectRef, "refusing a non-DEV project");
  const client = new pg.Client({
    connectionString: config.databaseUrl,
    ssl: buildSslOptions(),
  });
  await client.connect();
  try {
    const reportingBefore = await baseline(client);
    await assertMigrations(client);
    const rpcCount = await assertDatabaseBoundary(client);
    await runAcceptance(client, `s04b_s02a_${randomBytes(6).toString("hex")}`, reportingBefore);
    console.log(JSON.stringify({
      result: "PASS",
      environment: "DEV",
      migrationCount: 28,
      pendingMigrations: 0,
      checksumMismatches: 0,
      rpcInventory: { before: 20, after: rpcCount },
      checksPassed: checks.length,
      checks,
      reportingBaseline: reportingBefore,
      reportingBaselineUnchanged: true,
      fixtureResidue: 0,
      temporaryTriggersOrFunctions: 0,
      productionStorageAdapter: "fail-closed",
      mockStorage: "in-memory synthetic acknowledgment; no network",
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const sqlState = /^[0-9A-Z]{5}$/.test(error.code ?? "") ? error.code : "none";
  const line = error.stack?.match(/p1\.6-w04-s04b-s02a-dev-acceptance\.mjs:(\d+):/)?.[1] ?? "unknown";
  console.error(
    `S04B-S02A DEV acceptance failed; SQLSTATE=${sqlState}; constraint=${error.constraint ?? "none"}; marker=${error.marker ?? "none"}; checkLine=${line}; fixture transaction rollback was attempted.`,
  );
  process.exitCode = 1;
});
