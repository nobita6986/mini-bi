#!/usr/bin/env node
// R2B1 acceptance: shared Supabase DB (rolled-back synthetic fixtures) + live Cloudflare R2 Preview bucket.
// Credentials are read from a local file path given by R2B1_CREDENTIAL_FILE and never printed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import pg from "pg";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

import { resolveActor } from "../src/lib/auth/direct-entry-v2.ts";
import { reserveDirectEntryDocument } from "../src/lib/direct-entry/document-api.ts";
import {
  downloadDirectEntryDocument,
  finalizeDirectEntryDocument,
} from "../src/lib/direct-entry/document-finalize-api.ts";
import { finalObjectKey, stagingObjectKey } from "../src/lib/direct-entry/document-r2-contract.ts";
import { createR2DocumentStorage } from "../src/lib/direct-entry/r2-document-storage.ts";
import { createDirectEntryWriteRepository } from "../src/lib/direct-entry/write-repository.ts";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";
import { createMigratedDatabase } from "./lib/s04c-read-fixture.mjs";
import { readMigrations } from "./lib/migration-validation.mjs";

const PREVIEW_BUCKET = "hrp-bi-preview";
const MIGRATION = "20261005000000_p1_6_w04_s04b_r2a_direct_upload.sql";
const EFFECTIVE_DATE = "2026-10-15";
const migrationDir = path.resolve("supabase/migrations");
const checks = [];
const pass = (label) => checks.push(label);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("synthetic-r2b1"),
  Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function readR2Credentials() {
  const file = process.env.R2B1_CREDENTIAL_FILE;
  assert.ok(file, "R2B1_CREDENTIAL_FILE is required");
  const values = {};
  for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index < 1) continue;
    const name = line.slice(0, index).trim();
    if (name === "R2_BUCKET_NAME") continue;
    values[name] = line.slice(index + 1).trim();
  }
  return {
    VERCEL_ENV: "preview",
    R2_ACCOUNT_ID: values.R2_ACCOUNT_ID,
    R2_BUCKET_NAME: PREVIEW_BUCKET,
    R2_ACCESS_KEY_ID: values.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: values.R2_SECRET_ACCESS_KEY,
  };
}

async function baseline(client) {
  const { rows } = await client.query(`
    select
      (select count(*)::int from public.data_sources where active and not is_test) as "reportingSources",
      (select count(*)::int from public.data_sources where is_test) as "existingFixtureSources",
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

async function assertMigrationsAndBoundary(client) {
  const local = await readMigrations(migrationDir);
  const { rows } = await client.query("select version, checksum from public.schema_migrations order by version");
  assert.ok(local.length >= 30);
  assert.equal(rows.length, local.length);
  const applied = new Map(rows.map(({ version, checksum }) => [version, checksum]));
  assert.deepEqual(local.filter(({ name }) => !applied.has(name)), []);
  assert.deepEqual(local.filter(({ name, checksum }) => applied.get(name) !== checksum), []);
  assert.ok(applied.has(MIGRATION));
  pass(`${local.length} applied (>= R2A #30), 0 pending, 0 checksum mismatch`);

  const { rows: tables } = await client.query(`
    select c.relname, c.relrowsecurity rls, c.relforcerowsecurity frls,
      exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r'::"char", c.relowner))) a
              where a.grantee=0) public_priv,
      has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') anon_priv,
      has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') auth_priv,
      has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') service_priv
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname like 'direct_entry_%' and c.relkind in ('r','p')
  `);
  assert.ok(tables.some(({ relname }) => relname === "direct_entry_document_objects"));
  for (const t of tables) {
    assert.equal(t.rls, true, `${t.relname}: RLS`);
    assert.equal(t.frls, true, `${t.relname}: FORCE RLS`);
    assert.equal(t.public_priv, false, `${t.relname}: PUBLIC`);
    assert.equal(t.anon_priv, false, `${t.relname}: anon`);
    assert.equal(t.auth_priv, false, `${t.relname}: authenticated`);
    assert.equal(t.service_priv, false, `${t.relname}: service_role DML`);
  }
  const { rows: objectCols } = await client.query(`
    select count(*)::int triggers from pg_trigger
    where tgrelid='public.direct_entry_document_objects'::regclass and not tgisinternal
  `);
  assert.ok(objectCols[0].triggers >= 1, "sidecar immutability trigger");
  pass("every direct_entry_ table has RLS+FORCE RLS and no PUBLIC/anon/authenticated/service_role table privilege; sidecar has immutability trigger");

  const { rows: fns } = await client.query(`
    select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') config,
      has_function_privilege('anon', p.oid, 'EXECUTE') anon_exec,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_exec,
      has_function_privilege('service_role', p.oid, 'EXECUTE') service_exec,
      exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
              where a.grantee=0 and a.privilege_type='EXECUTE') public_exec
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'direct_entry_%'
  `);
  const names = new Set(fns.map(({ proname }) => proname));
  const direct = [
    "direct_entry_reserve_document_direct_upload",
    "direct_entry_document_direct_context",
    "direct_entry_finalize_document_direct_upload",
  ];
  for (const name of direct) {
    const f = fns.find(({ proname }) => proname === name);
    assert.ok(f, name);
    assert.equal(f.prosecdef, true);
    assert.ok(f.config.includes("search_path=pg_catalog, public"));
    assert.deepEqual(
      [f.public_exec, f.anon_exec, f.auth_exec, f.service_exec],
      [false, false, false, true],
      `${name}: EXECUTE ACL`,
    );
  }
  assert.equal(names.has("direct_entry_apply_document_worker_callback"), false);
  const legacy = fns.find(({ proname }) => proname === "direct_entry_reserve_document_upload");
  assert.ok(legacy);
  assert.equal(legacy.service_exec, false, "legacy reserve must not be executable");
  const inventory = fns.filter((f) => f.service_exec).length;
  // R2A baseline was 23 (22 - callback - legacy reserve + 3); later migrations only add RPCs, so the live set
  // must equal the set derived by applying every local migration from scratch.
  const scratch = await createMigratedDatabase();
  const expectedInventory = (await scratch.db.query(
    "select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace" +
    " where n.nspname='public' and p.proname like 'direct_entry\\_%' and has_function_privilege('service_role',p.oid,'EXECUTE')",
  )).rows[0].n;
  await scratch.db.close();
  assert.ok(inventory >= 23);
  assert.equal(inventory, expectedInventory);
  assert.equal(fns.filter((f) => f.anon_exec || f.auth_exec || f.public_exec).length, 0);
  pass(`service-role RPC inventory = ${inventory} (R2A baseline 23, plus later read RPCs; equals the PGlite from-scratch set); three direct-upload RPCs SECURITY DEFINER, pinned search_path, service_role-only; worker callback RPC absent; legacy reserve not executable`);

  const { rows: view } = await client.query(
    "select pg_get_viewdef('public.direct_entry_current_documents'::regclass) as def",
  );
  const def = view[0].def.replace(/\s+/g, " ");
  assert.match(def, /READY/);
  assert.match(def, /VALIDATED/);
  assert.match(def, /NOT_REQUIRED/);
  assert.match(def, /CLEAN/);
  pass("direct_entry_current_documents selects READY + VALIDATED + CLEAN|NOT_REQUIRED");
  return inventory;
}

async function roleQuery(client, role, sql, values = []) {
  const savepoint = `r2b1_role_${randomBytes(3).toString("hex")}`;
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

async function insertActor(client, actor, capabilities, teamId = null) {
  await client.query("insert into auth.users(id) values ($1)", [actor.authSubject]);
  await client.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled) values ($1,$2,true)",
    [actor.appUserId, actor.authSubject],
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
      "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text) as data",
      [args.p_auth_subject, args.p_app_user_id, JSON.stringify(args.p_rows), args.p_idempotency_key],
    ],
    direct_entry_reserve_document_direct_upload: [
      `select public.direct_entry_reserve_document_direct_upload(
        $1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text,$7::bigint,$8::text,$9::text) as data`,
      [
        args.p_auth_subject, args.p_app_user_id, args.p_entry_id, args.p_expected_entry_version,
        args.p_document_type, args.p_idempotency_key, args.p_size_bytes, args.p_mime_type, args.p_reason,
      ],
    ],
    direct_entry_document_direct_context: [
      "select public.direct_entry_document_direct_context($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text) as data",
      [args.p_auth_subject, args.p_app_user_id, args.p_entry_id, args.p_document_id, args.p_purpose],
    ],
    direct_entry_finalize_document_direct_upload: [
      `select public.direct_entry_finalize_document_direct_upload(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::integer,$6::text,$7::text,$8::text,$9::bigint,$10::text) as data`,
      [
        args.p_auth_subject, args.p_app_user_id, args.p_entry_id, args.p_document_id,
        args.p_expected_entry_version, args.p_idempotency_key, args.p_outcome,
        args.p_checksum_sha256, args.p_size_bytes, args.p_mime_type,
      ],
    ],
    direct_entry_read_projection: [
      "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as data",
      [args.p_auth_subject, args.p_app_user_id, args.p_entry_id],
    ],
  };
  const statement = statements[name];
  if (!statement) throw new Error("Unexpected RPC in R2B1 acceptance");
  const savepoint = `r2b1_rpc_${randomBytes(3).toString("hex")}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    const { rows } = await roleQuery(client, "service_role", statement[0], statement[1]);
    await client.query(`release savepoint ${savepoint}`);
    return { data: rows[0]?.data, error: null };
  } catch (error) {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
    return { data: null, error: { code: error.code, constraint: error.constraint, message: error.message } };
  }
}

function jsonRequest(url, body, idempotencyKey) {
  return new Request(url, {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function counts(client, entryId, candidateId) {
  const { rows } = await client.query(`
    select e.version,
      (select count(*)::int from public.direct_entry_document_versions d where d.candidate_id=$2) documents,
      (select count(*)::int from public.direct_entry_document_events v
        join public.direct_entry_document_versions d using(document_id) where d.candidate_id=$2::uuid) events,
      (select count(*)::int from public.direct_entry_revisions r where r.entry_id=e.entry_id) revisions,
      (select count(*)::int from public.direct_entry_audit_events a where a.resource_ref=e.entry_id::text) audits
    from public.direct_entries e where e.entry_id=$1
  `, [entryId, candidateId]);
  return rows[0];
}

async function browserPut({ origin, url, headers, bytes }) {
  const url_ = new URL(origin);
  const profile = await mkdtemp(path.join(os.tmpdir(), "r2b1-chrome-"));
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>r2b1 synthetic origin</title>");
  });
  await new Promise((resolve) => server.listen(Number(url_.port), "127.0.0.1", resolve));
  const chrome = spawn(
    process.env.R2B1_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    let port;
    for (let attempt = 0; attempt < 50 && !port; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
      } catch { /* not ready */ }
    }
    assert.ok(port, "Chrome DevTools port unavailable");
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${origin}/`, { method: "PUT" })).json();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    let id = 0;
    const pending = new Map();
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && pending.has(message.id)) pending.get(message.id)(message);
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const expression = `(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}), c => c.charCodeAt(0));
      try {
        const r = await fetch(${JSON.stringify(url)}, { method: "PUT", headers: ${JSON.stringify(headers)}, body: bytes });
        return JSON.stringify({ origin: location.origin, status: r.status, ok: r.ok });
      } catch (e) { return JSON.stringify({ origin: location.origin, error: e.name }); }
    })()`;
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    socket.close();
    return JSON.parse(response.result.result.value);
  } finally {
    chrome.kill();
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  const env = await readR2Credentials();
  const base = createR2DocumentStorage(env);
  assert.equal(base.available(), true, "R2 preview config rejected");
  const rawClient = new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const endpointHost = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const manifest = { storageKeys: new Set(), documentIds: [], entryId: null };
  const signedUrls = [];
  let downloadSigned = 0;
  const storage = {
    ...base,
    async createUploadUrl(input) {
      manifest.storageKeys.add(input.storage_key);
      const signed = await base.createUploadUrl(input);
      signedUrls.push(signed.url);
      return signed;
    },
    async createDownloadUrl(input) {
      downloadSigned += 1;
      const signed = await base.createDownloadUrl(input);
      signedUrls.push(signed.url);
      return signed;
    },
  };
  const exists = async (key) => {
    try {
      await rawClient.send(new HeadObjectCommand({ Bucket: PREVIEW_BUCKET, Key: key }));
      return true;
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404) return false;
      throw error;
    }
  };

  const config = await loadSupabaseConfig();
  const dbManifest = JSON.parse(await readFile(new URL("./p1.6-w03-g3-dev-manifest.json", import.meta.url), "utf8"));
  assert.equal(config.projectRef, dbManifest.expectedProjectRef, "refusing an unexpected Supabase project");
  const client = new pg.Client({ connectionString: config.databaseUrl, ssl: buildSslOptions() });
  await client.connect();
  const namespace = `r2b1_${randomBytes(5).toString("hex")}`;
  let transactionOpen = false;
  const fixture = {
    owner: { authSubject: randomUUID(), appUserId: randomUUID() },
    noView: { authSubject: randomUUID(), appUserId: randomUUID() },
    stranger: { authSubject: randomUUID(), appUserId: randomUUID() },
    recruiterId: randomUUID(),
    teamId: randomUUID(),
    projectId: `r2b1_${randomBytes(7).toString("hex")}`,
    employeeCode: `hrp-2026-${100000 + Number.parseInt(randomBytes(4).toString("hex"), 16) % 900000}`,
  };
  let reportingBefore;
  let inventory;
  const summary = {};
  try {
    reportingBefore = await baseline(client);
    inventory = await assertMigrationsAndBoundary(client);

    await client.query("begin");
    transactionOpen = true;
    const { owner, noView, stranger } = fixture;
    await insertActor(client, owner, ["entry_create", "submission_create", "entry_own", "document_upload", "document_view"]);
    await insertActor(client, noView, ["entry_own", "document_upload"]);
    await insertActor(client, stranger, ["entry_own", "document_upload", "document_view"]);
    await client.query("insert into public.teams(team_id,code,display_name) values ($1,$2,'Synthetic R2B1 team')", [fixture.teamId, `${namespace}_TEAM`]);
    await client.query("insert into public.recruiters(recruiter_id,display_name) values ($1,'Synthetic R2B1 recruiter')", [fixture.recruiterId]);
    await client.query("insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from) values ($1,'hrp','2020-01-01')", [fixture.recruiterId]);
    await client.query("insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from) values ($1,$2,'2020-01-01')", [fixture.recruiterId, fixture.teamId]);
    await client.query("insert into public.direct_entry_projects(project_id,display_name) values ($1,'Synthetic R2B1 project')", [fixture.projectId]);

    const resolutions = {};
    for (const [name, actor] of Object.entries({ owner, noView, stranger })) {
      resolutions[name] = await resolveFixtureActor(client, actor.authSubject);
      assert.equal(resolutions[name].ok, true, `${name} actor`);
    }
    const repository = createDirectEntryWriteRepository((name, args) => callRpc(client, name, args));
    const depsFor = (name, store = storage) => ({
      resolveSession: async () => ({ actor: resolutions[name], response_headers: {} }),
      repository,
      storage: store,
    });

    const created = await callRpc(client, "direct_entry_create_batch", {
      p_auth_subject: owner.authSubject,
      p_app_user_id: owner.appUserId,
      p_rows: [{
        project_id: fixture.projectId,
        first_work_date: EFFECTIVE_DATE,
        employee_code: fixture.employeeCode,
        worker_details: {
          display_name: "Synthetic R2B1 worker",
          date_of_birth: { state: "omitted" },
          national_id: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "omitted" },
        },
        recruiter_id: fixture.recruiterId,
        labor_type: "TEMPORARY",
      }],
      p_idempotency_key: `${namespace}_create`,
    });
    assert.equal(created.error, null, "synthetic entry creation");
    const entryId = created.data.entry_ids[0];
    manifest.entryId = entryId;
    const { rows: entryRows } = await client.query("select candidate_id, version from public.direct_entries where entry_id=$1", [entryId]);
    const candidateId = entryRows[0].candidate_id;
    let entryVersion = entryRows[0].version;
    pass("synthetic owner/stranger/no-view actors and DRAFT entry created inside a rollback transaction");

    const baseUrl = `https://example.test/api/direct-entry/entries/${entryId}/documents`;
    const reserve = async (name, body, key, store) => {
      const response = await reserveDirectEntryDocument(jsonRequest(baseUrl, body, key), entryId, "true", depsFor(name, store));
      return { status: response.status, body: await response.json() };
    };
    const finalize = async (name, documentId, version, key) => {
      const response = await finalizeDirectEntryDocument(
        jsonRequest(`${baseUrl}/${documentId}/finalize`, { expected_entry_version: version }, key),
        entryId, documentId, "true", depsFor(name),
      );
      return { status: response.status, body: await response.json() };
    };
    const download = async (name, documentId, store) => downloadDirectEntryDocument(
      new Request(`${baseUrl}/${documentId}/download`),
      entryId, documentId, "true", depsFor(name, store),
    );
    const put = async (reservation, bytes, headersOverride) => {
      const { url, headers } = reservation.body.upload;
      const response = await fetch(url, { method: "PUT", headers: headersOverride ?? headers, body: bytes });
      return response.status;
    };
    const stagingKeyOf = async (documentId) => {
      const { rows } = await client.query("select storage_key from public.direct_entry_document_versions where document_id=$1", [documentId]);
      return rows[0].storage_key;
    };
    const checksums = [];

    // 1-3 valid JPEG/PNG/PDF; PNG goes through a real browser when an origin is allowed.
    const happy = [];
    for (const [label, type, mime, bytes] of [
      ["jpeg", "CCCD_FRONT", "image/jpeg", JPEG],
      ["png", "CCCD_BACK", "image/png", PNG],
      ["pdf", "EMPLOYMENT_CONTRACT", "application/pdf", PDF],
    ]) {
      const key = `${namespace}_${label}`;
      const reserveVersion = entryVersion;
      const reservation = await reserve("owner", {
        document_type: type, expected_entry_version: entryVersion, size_bytes: bytes.length, mime_type: mime,
      }, key);
      assert.equal(reservation.status, 201, `${label} reserve`);
      assert.notEqual(reservation.body.scan_status, "CLEAN");
      assert.equal(reservation.body.upload_status, "QUEUED");
      const ttl = (Date.parse(reservation.body.upload.expires_at) - Date.now()) / 1000;
      assert.ok(ttl <= 300 && ttl > 250, `${label}: PUT URL TTL ${ttl}`);
      const query = new URL(reservation.body.upload.url).searchParams;
      assert.ok(Number(query.get("X-Amz-Expires")) <= 300);
      assert.match(query.get("X-Amz-SignedHeaders") ?? "", /content-length/);
      assert.match(query.get("X-Amz-SignedHeaders") ?? "", /content-type/);
      entryVersion = reservation.body.entry_version;
      const documentId = reservation.body.document_id;
      manifest.documentIds.push(documentId);

      const missing = await finalize("owner", documentId, entryVersion, `${key}_early`);
      assert.equal(missing.status, 409);
      assert.equal(missing.body.code, "DOCUMENT_UPLOAD_MISSING");

      if (label === "png" && process.env.R2B1_BROWSER_ORIGIN) {
        const result = await browserPut({
          origin: process.env.R2B1_BROWSER_ORIGIN,
          url: reservation.body.upload.url,
          headers: reservation.body.upload.headers,
          bytes,
        });
        summary.browserPut = result;
        assert.equal(result.status, 200, `browser PUT: ${JSON.stringify(result)}`);
        pass("browser (headless Chrome) signed PUT from allowed origin succeeded with only Content-Type set by script");
      } else {
        assert.equal(await put(reservation, bytes), 200, `${label} PUT`);
      }
      const before = await counts(client, entryId, candidateId);
      const done = await finalize("owner", documentId, entryVersion, `${key}_finalize`);
      assert.equal(done.status, 200, `${label} finalize: ${JSON.stringify(done.body)}`);
      assert.deepEqual(
        [done.body.upload_status, done.body.validation_status, done.body.scan_status],
        ["READY", "VALIDATED", "NOT_REQUIRED"],
      );
      entryVersion = done.body.entry_version;
      checksums.push(sha256(bytes));
      const storageKey = await stagingKeyOf(documentId);
      assert.equal(await exists(finalObjectKey("preview", storageKey)), true);
      assert.equal(await exists(stagingObjectKey("preview", storageKey)), false);
      const after = await counts(client, entryId, candidateId);
      assert.equal(after.documents, before.documents);
      happy.push({ reserveVersion, label, documentId, type, mime, bytes, storageKey, key });
      pass(`${label}: reserve -> signed PUT -> server HEAD/GET/SHA-256/magic -> copy to final -> DB finalize READY+VALIDATED+NOT_REQUIRED; staging deleted`);
    }

    // Finalize replay with same key/payload is idempotent and writes nothing new.
    const first = happy[0];
    const beforeReplay = await counts(client, entryId, candidateId);
    const replay = await finalize("owner", first.documentId, entryVersion, `${first.key}_finalize`);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.reused, true);
    assert.deepEqual(await counts(client, entryId, candidateId), beforeReplay);
    const reserveReplay = await reserve("owner", {
      document_type: first.type, expected_entry_version: first.reserveVersion, size_bytes: first.bytes.length, mime_type: first.mime,
    }, first.key);
    assert.ok([200, 201].includes(reserveReplay.status));
    assert.equal(reserveReplay.body.document_id, first.documentId);
    assert.deepEqual(await counts(client, entryId, candidateId), beforeReplay);
    pass("finalize and reserve replays with the same key are idempotent and add no version/event/revision/audit");

    // Same key, different payload -> conflict.
    const changed = await reserve("owner", {
      document_type: first.type, expected_entry_version: first.reserveVersion, size_bytes: first.bytes.length + 1, mime_type: first.mime,
    }, first.key);
    assert.equal(changed.status, 409);
    assert.deepEqual(await counts(client, entryId, candidateId), beforeReplay);
    pass("same idempotency key with changed payload -> 409 and no mutation");

    // Stale OCC on reserve.
    const stale = await reserve("owner", {
      document_type: "CCCD_FRONT", expected_entry_version: entryVersion - 1, size_bytes: JPEG.length, mime_type: "image/jpeg",
    }, `${namespace}_stale`);
    assert.equal(stale.status, 409);
    assert.deepEqual(await counts(client, entryId, candidateId), beforeReplay);
    pass("stale expected entry version -> 409 and no extra version/event");

    // Oversize before mutation.
    const oversize = await reserve("owner", {
      document_type: "CCCD_FRONT", expected_entry_version: entryVersion, size_bytes: 10 * 1024 * 1024 + 1, mime_type: "image/jpeg",
    }, `${namespace}_oversize`);
    assert.equal(oversize.status, 400);
    assert.deepEqual(await counts(client, entryId, candidateId), beforeReplay);
    const badMime = await reserve("owner", {
      document_type: "CCCD_FRONT", expected_entry_version: entryVersion, size_bytes: 10, mime_type: "image/svg+xml",
    }, `${namespace}_svg`);
    assert.equal(badMime.status, 400);
    assert.deepEqual(await counts(client, entryId, candidateId), beforeReplay);
    pass("oversize (>10 MiB) and disallowed MIME rejected before any mutation");

    // Client cannot supply authority fields.
    const authority = await reserve("owner", {
      document_type: "CCCD_FRONT", expected_entry_version: entryVersion, size_bytes: JPEG.length, mime_type: "image/jpeg",
      bucket: "x", storage_key: "x", scan_status: "CLEAN", upload_status: "READY",
    }, `${namespace}_authority`);
    assert.equal(authority.status, 400);
    assert.deepEqual(await counts(client, entryId, candidateId), beforeReplay);
    pass("client-supplied bucket/key/status fields rejected");

    // Replacement v2 of CCCD_FRONT with signature mismatch: PNG bytes claimed as JPEG.
    const badKey = `${namespace}_badsig`;
    const bad = await reserve("owner", {
      document_type: "CCCD_FRONT", expected_entry_version: entryVersion, size_bytes: PNG.length, mime_type: "image/jpeg",
    }, badKey);
    assert.equal(bad.status, 201);
    entryVersion = bad.body.entry_version;
    manifest.documentIds.push(bad.body.document_id);
    const badStorageKey = await stagingKeyOf(bad.body.document_id);
    assert.equal(await put(bad, PNG), 200);
    const badFinal = await finalize("owner", bad.body.document_id, entryVersion, `${badKey}_finalize`);
    assert.equal(badFinal.status, 422);
    assert.equal(await exists(stagingObjectKey("preview", badStorageKey)), false);
    assert.equal(await exists(finalObjectKey("preview", badStorageKey)), false);
    pass("wrong signature (PNG bytes labelled JPEG) -> 422; staging deleted; no final object");

    // Entry version after rejection.
    const { rows: ev } = await client.query("select version from public.direct_entries where entry_id=$1", [entryId]);
    entryVersion = ev[0].version;

    // R2 enforces signed Content-Type and Content-Length.
    const sigKey = `${namespace}_sig`;
    const sig = await reserve("owner", {
      document_type: "CCCD_FRONT", expected_entry_version: entryVersion, size_bytes: JPEG.length, mime_type: "image/jpeg",
    }, sigKey);
    assert.equal(sig.status, 201);
    entryVersion = sig.body.entry_version;
    manifest.documentIds.push(sig.body.document_id);
    const sigStorageKey = await stagingKeyOf(sig.body.document_id);
    assert.equal(await put(sig, JPEG, { "Content-Type": "image/png" }), 403, "Content-Type is signed");
    assert.equal(await put(sig, Buffer.concat([JPEG, Buffer.from([0, 0, 0])])), 403, "Content-Length is signed");
    assert.equal(await exists(stagingObjectKey("preview", sigStorageKey)), false);
    pass("R2 rejects signed-PUT with different Content-Type or Content-Length (403); nothing stored");

    // Stale OCC on finalize with a valid upload; then proper replacement v2.
    assert.equal(await put(sig, JPEG), 200);
    const staleFinalize = await finalize("owner", sig.body.document_id, entryVersion - 1, `${sigKey}_stale`);
    assert.equal(staleFinalize.status, 409);
    const sigCounts = await counts(client, entryId, candidateId);
    const okFinal = await finalize("owner", sig.body.document_id, entryVersion, `${sigKey}_finalize`);
    assert.equal(okFinal.status, 200, JSON.stringify(okFinal.body));
    entryVersion = okFinal.body.entry_version;
    assert.equal(okFinal.body.version > 1, true);
    checksums.push(sha256(JPEG));
    assert.equal((await counts(client, entryId, candidateId)).documents, sigCounts.documents);
    pass("stale OCC on finalize -> 409 without extra rows; valid replacement finalizes as a later version");

    // Pending replacement does not mask current.
    const pendingKey = `${namespace}_pending`;
    const pending = await reserve("owner", {
      document_type: "CCCD_FRONT", expected_entry_version: entryVersion, size_bytes: JPEG.length, mime_type: "image/jpeg",
    }, pendingKey);
    assert.equal(pending.status, 201);
    entryVersion = pending.body.entry_version;
    manifest.documentIds.push(pending.body.document_id);
    const { rows: current } = await client.query(`
      select c.document_type, c.version, c.document_id
      from public.direct_entry_current_documents c
      join public.direct_entry_document_versions v on v.document_id=c.document_id
      where v.candidate_id=$1 order by c.document_type`, [candidateId]);
    const front = current.find((row) => row.document_type === "CCCD_FRONT");
    assert.equal(front.document_id, sig.body.document_id, "latest eligible version is current");
    assert.equal(current.length, 3);
    const { rows: lineage } = await client.query(
      "select document_id, version from public.direct_entry_document_versions where candidate_id=$1 and document_type='CCCD_FRONT' order by version",
      [candidateId],
    );
    assert.deepEqual(lineage.map((r) => r.version), [1, 2, 3, 4]);
    pass("current-documents picks the latest READY+VALIDATED version; pending/rejected replacements do not mask it; lineage v1..v4 intact");

    // Projection leak check.
    const projection = JSON.stringify((await callRpc(client, "direct_entry_read_projection", {
      p_auth_subject: owner.authSubject, p_app_user_id: owner.appUserId, p_entry_id: entryId,
    })).data);
    const forbidden = [
      ...checksums, endpointHost, env.R2_ACCOUNT_ID, PREVIEW_BUCKET, "X-Amz", "https://",
      ...[...manifest.storageKeys], "synthetic-browser-name", "storage_key", "checksum",
    ];
    for (const value of forbidden) assert.equal(projection.includes(value), false, "projection leak");
    assert.match(projection, /NOT_REQUIRED/);
    assert.equal(/"scan_status":"CLEAN"/.test(projection), false);
    pass("restricted projection contains no checksum, storage key, bucket/account id, signed URL or filename; scan_status NOT_REQUIRED, never CLEAN");

    // Audit/revision/event leak check and scan status check.
    const { rows: textRows } = await client.query(`
      select (select coalesce(string_agg(a::text, ' '), '') from public.direct_entry_audit_events a where a.resource_ref=$1::uuid::text) audits,
             (select coalesce(string_agg(r::text, ' '), '') from public.direct_entry_revisions r where r.entry_id=$1::uuid) revisions,
             (select coalesce(string_agg(ev::text, ' '), '') from public.direct_entry_document_events ev
               join public.direct_entry_document_versions d using(document_id) where d.candidate_id=$2::uuid) events
    `, [entryId, candidateId]);
    const blob = Object.values(textRows[0]).join(" ");
    for (const value of [...checksums, "X-Amz", "https://", env.R2_SECRET_ACCESS_KEY, env.R2_ACCESS_KEY_ID, endpointHost]) {
      assert.equal(blob.includes(value), false, "audit/revision/event leak");
    }
    const { rows: scans } = await client.query(`
      select scan_status, count(*)::int n from public.direct_entry_document_versions
      where candidate_id=$1 group by scan_status`, [candidateId]);
    assert.equal(scans.some((row) => row.scan_status === "CLEAN"), false);
    pass("audit, revision and document events contain no checksum, URL or credential; no row has scan_status CLEAN");

    // Download: allowed actor.
    const checksumBefore = downloadSigned;
    const redirect = await download("owner", first.documentId);
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("cache-control"), "private, no-store");
    const location = new URL(redirect.headers.get("location"));
    assert.equal(location.host, `${PREVIEW_BUCKET}.${endpointHost}`);
    assert.ok(Number(location.searchParams.get("X-Amz-Expires")) <= 120);
    const disposition = location.searchParams.get("response-content-disposition") ?? "";
    assert.match(disposition, /^attachment; filename="cccd-front-v1\.jpg"$/);
    const object = await fetch(location);
    assert.equal(object.status, 200);
    assert.match(object.headers.get("content-disposition") ?? "", /^attachment; filename="cccd-front-v1\.jpg"$/);
    assert.equal(sha256(Buffer.from(await object.arrayBuffer())), sha256(JPEG));
    assert.equal(downloadSigned, checksumBefore + 1);
    pass("authorized download -> 302 to GET URL (<=120 s) with attachment + generic name; bytes match");

    // Download: denied before signing.
    for (const name of ["noView", "stranger"]) {
      const denied = await download(name, first.documentId);
      assert.ok([403, 404].includes(denied.status), `${name}: ${denied.status}`);
    }
    const queuedDownload = await download("owner", pending.body.document_id);
    assert.equal(queuedDownload.status, 404);
    const badDownload = await download("owner", bad.body.document_id);
    assert.equal(badDownload.status, 404);
    assert.equal(downloadSigned, checksumBefore + 1, "no URL signed for denied/ineligible requests");
    pass("download denied (no capability / out of scope / pending / rejected) before any URL is signed");

    // Anonymous direct access to objects refused.
    const finalKey = finalObjectKey("preview", first.storageKey);
    const anonymous = await fetch(`https://${PREVIEW_BUCKET}.${endpointHost}/${finalKey}`);
    assert.ok([400, 401, 403].includes(anonymous.status), `anonymous status ${anonymous.status}`);
    pass("anonymous unsigned GET of a final object is refused");

    // Invalid object not in final prefix.
    const finalListing = await rawClient.send(new ListObjectsV2Command({ Bucket: PREVIEW_BUCKET, Prefix: `preview/final/${badStorageKey}` }));
    assert.equal(finalListing.KeyCount, 0);
    pass("invalid upload has no object under the final prefix");

    // Unavailable adapter fails closed before DB mutation.
    const beforeOff = await counts(client, entryId, candidateId);
    const off = await reserve("owner", {
      document_type: "CCCD_BACK", expected_entry_version: entryVersion, size_bytes: PNG.length, mime_type: "image/png",
    }, `${namespace}_off`, createR2DocumentStorage({}));
    assert.equal(off.status, 503);
    assert.equal(off.body.code, "DOCUMENT_STORAGE_UNAVAILABLE");
    assert.deepEqual(await counts(client, entryId, candidateId), beforeOff);
    pass("missing R2 config -> DOCUMENT_STORAGE_UNAVAILABLE with zero DB mutation");

    summary.finalCounts = await counts(client, entryId, candidateId);
    await client.query("rollback");
    transactionOpen = false;
  } finally {
    if (transactionOpen) await client.query("rollback").catch(() => undefined);
    // Exact manifest cleanup of R2 objects.
    let deleted = 0;
    for (const storageKey of manifest.storageKeys) {
      for (const objectKey of [stagingObjectKey("preview", storageKey), finalObjectKey("preview", storageKey)]) {
        await rawClient.send(new DeleteObjectCommand({ Bucket: PREVIEW_BUCKET, Key: objectKey })).catch(() => undefined);
        deleted += 1;
      }
    }
    summary.manifest = {
      storageKeyCount: manifest.storageKeys.size,
      deleteCalls: deleted,
      documentIdCount: manifest.documentIds.length,
    };
    let residueObjects = 0;
    for (const storageKey of manifest.storageKeys) {
      for (const objectKey of [stagingObjectKey("preview", storageKey), finalObjectKey("preview", storageKey)]) {
        if (await exists(objectKey)) residueObjects += 1;
      }
    }
    const listing = await rawClient.send(new ListObjectsV2Command({ Bucket: PREVIEW_BUCKET, Prefix: "preview/" }));
    summary.r2ResidueObjects = residueObjects;
    summary.previewBucketObjectCount = listing.KeyCount;
    const { rows: residue } = await client.query(`
      select
        (select count(*)::int from auth.users where id=any($1::uuid[])) auth_users,
        (select count(*)::int from public.direct_entry_app_users where app_user_id=any($2::uuid[])) app_users,
        (select count(*)::int from public.direct_entries where entry_id=$3) entries,
        (select count(*)::int from public.direct_entry_document_versions where document_id=any($4::uuid[])) documents,
        (select count(*)::int from public.direct_entry_document_objects where document_id=any($4::uuid[])) objects,
        (select count(*)::int from public.direct_entry_projects where project_id=$5) projects,
        (select count(*)::int from public.recruiters where recruiter_id=$6) recruiters,
        (select count(*)::int from pg_proc where pronamespace=pg_my_temp_schema()) temp_functions,
        (select count(*)::int from pg_trigger where tgname like $7) temp_triggers
    `, [
      [fixture.owner.authSubject, fixture.noView.authSubject, fixture.stranger.authSubject],
      [fixture.owner.appUserId, fixture.noView.appUserId, fixture.stranger.appUserId],
      manifest.entryId ?? randomUUID(), manifest.documentIds.length ? manifest.documentIds : [randomUUID()],
      fixture.projectId, fixture.recruiterId, `${namespace}%`,
    ]);
    summary.dbResidue = residue[0];
    summary.reportingBaselineUnchanged =
      JSON.stringify(await baseline(client)) === JSON.stringify(reportingBefore);
    await client.end();
  }

  assert.equal(summary.r2ResidueObjects, 0, "R2 manifest objects remain");
  assert.ok(Object.values(summary.dbResidue).every((n) => n === 0), "DB residue remains");
  assert.equal(summary.reportingBaselineUnchanged, true);
  pass("cleanup: manifest R2 objects deleted and verified absent; DB rollback residue = 0; no temp functions/triggers; reporting baseline unchanged");
  console.log(JSON.stringify({
    result: "PASS",
    bucket: PREVIEW_BUCKET,
    migrations: { pending: 0, checksumMismatches: 0 },
    rpcInventory: inventory,
    checksPassed: checks.length,
    checks,
    summary,
    namespace,
  }, null, 2));
}

main().catch((error) => {
  const line = error.stack?.match(/r2b1-acceptance\.mjs:(\d+):/)?.[1] ?? "unknown";
  console.error(`R2B1 acceptance failed; name=${error.name}; code=${error.code ?? "none"}; line=${line}; message=${String(error.message).slice(0, 200).replace(/https?:\/\/\S+/g, "<url>")}`);
  process.exitCode = 1;
});
