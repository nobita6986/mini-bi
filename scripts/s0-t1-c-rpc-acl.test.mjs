/**
 * S0-T1-C RPC ACL regression on an isolated, native PostgreSQL cluster.
 *
 * Starts initdb/pg_ctl in a temporary directory, applies the current migration
 * baseline, simulates broad staging grants, then applies the S0-T1-C forward
 * migration. It reads catalog metadata and uses scratch-only trigger probes.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import {
  F1_WORK_REPORTS_MIGRATION_NAME,
  F1_WORK_REPORTS_SERVICE_RPC_SIGNATURES,
  migrationChecksum,
  runMigrationApply,
  runMigrationValidation,
  S0_T1_C_PRE_PR92_CHECKSUM,
} from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const ACL_MIGRATION = "20261020180000_s0_t1_c_rpc_acl_allowlist.sql";
const R1_2_MIGRATION = "20261021100000_r1_2_worker_management_uat_fixes.sql";
const R2_1_MIGRATION = "20261021120000_r2_1_change_request_queues_and_project_team_guard.sql";
const R1_2_SERVICE_RPC =
  "public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer, text)";
const TARGET_PATTERN = "^(direct_entry_|work_report_|ai_report_|ai_provider_config_|recruitment_|(expand|replace|reject|upsert)_daily_recruitment|record_recruitment_source_failure_|set_updated_at$)";

function binary(name) {
  const binDir = process.env.P3_1_W02A_PG_BIN
    ?? (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
  return result.error ? null : candidate;
}

function run(file, args, { ignoreOutput = false } = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(ignoreOutput ? { stdio: "ignore" } : {}),
  });
  assert.equal(result.status, 0, `${path.basename(file)} failed:\n${result.stderr || result.stdout}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function connect(port, database = "postgres", applicationName = "s0-t1-c-acl") {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    application_name: applicationName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function prepareDatabase(client) {
  await client.query(
    "create role anon nologin; create role authenticated nologin;"
      + " create role service_role nologin bypassrls;"
      + " create schema auth; create table auth.users (id uuid primary key);"
      + " create table public.schema_migrations (version text primary key, checksum text not null, applied_at timestamptz not null default now());",
  );
}

async function migrationNames() {
  return (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
}

async function applyMigrations(client, names) {
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

async function aclSnapshot(client) {
  const { rows } = await client.query(
    `select p.oid::bigint as oid,
            p.proname,
            p.oid::pg_catalog.regprocedure::text as signature,
            p.prosecdef,
            pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE') as owner_exec,
            pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
            pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
            pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
            exists (
              select 1
                from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
               where a.grantee = 0 and a.privilege_type = 'EXECUTE'
            ) as public_exec
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prokind in ('f', 'p')
        and p.proname ~ $1
      order by p.proname, p.oid::pg_catalog.regprocedure::text`,
    [TARGET_PATTERN],
  );
  return rows;
}

async function policySnapshot(client) {
  const { rows } = await client.query(
    `select p.polrelid::pg_catalog.regclass::text as table_name,
            p.polname,
            p.polcmd,
            p.polpermissive,
            p.polroles::text as role_oids,
            pg_catalog.pg_get_expr(p.polqual, p.polrelid) as using_expr,
            pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
       from pg_catalog.pg_policy p
       join pg_catalog.pg_class c on c.oid = p.polrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
      order by table_name, p.polname`,
  );
  return rows;
}

async function miniBiPolicyRoutineDependencies(client) {
  const { rows } = await client.query(
    `select pol.polrelid::pg_catalog.regclass::text as table_name,
            pol.polname,
            p.oid::pg_catalog.regprocedure::text as function_signature
       from pg_catalog.pg_depend d
       join pg_catalog.pg_policy pol
         on d.classid = 'pg_catalog.pg_policy'::pg_catalog.regclass and d.objid = pol.oid
       join pg_catalog.pg_proc p
         on d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.refobjid = p.oid
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prokind in ('f', 'p')
        and p.proname ~ $1
      order by table_name, pol.polname, function_signature`,
    [TARGET_PATTERN],
  );
  return rows;
}

async function triggerSnapshot(client) {
  const { rows } = await client.query(
    `select t.tgrelid::pg_catalog.regclass::text as table_name,
            t.tgname,
            t.tgfoid::pg_catalog.regprocedure::text as function_signature,
            pg_catalog.pg_get_triggerdef(t.oid, true) as definition
       from pg_catalog.pg_trigger t
       join pg_catalog.pg_class c on c.oid = t.tgrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal
      order by table_name, t.tgname`,
  );
  return rows;
}

async function aclDefaultsSnapshot(client) {
  const { rows } = await client.query(
    `select d.defaclrole::regrole::text as role_name,
            d.defaclnamespace::regnamespace::text as schema_name,
            d.defaclobjtype,
            d.defaclacl::text as acl
       from pg_catalog.pg_default_acl d
      order by role_name, schema_name, d.defaclobjtype`,
  );
  return rows;
}

test("S0-T1-C revokes broad Mini BI RPC ACLs while preserving the server allowlist and trigger paths",
  async (t) => {
    const initdb = binary("initdb");
    const pgCtl = binary("pg_ctl");
    if (!initdb || !pgCtl) {
      t.skip("PostgreSQL initdb and pg_ctl are required for the native ACL regression");
      return;
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "s0-t1-c-rpc-acl-"));
    const dataDir = path.join(tempDir, "data");
    const logFile = path.join(tempDir, "postgres.log");
    const port = await freePort();
    const databaseName = `s0_t1c_${process.pid}`;
    let serverStarted = false;
    let admin;
    let client;

    try {
      run(initdb, [
        "--username=postgres",
        "--auth-local=trust",
        "--auth-host=trust",
        "--no-locale",
        "--encoding=UTF8",
        "--pgdata", dataDir,
      ]);
      run(pgCtl, [
        "-D", dataDir,
        "-l", logFile,
        "-o", `-h 127.0.0.1 -p ${port}${process.platform === "win32" ? "" : ` -k ${tempDir}`}`,
        "-w", "start",
      ], { ignoreOutput: process.platform === "win32" });
      serverStarted = true;

      admin = await connect(port);
      await admin.query(`create database ${databaseName}`);
      client = await connect(port, databaseName, "s0-t1-c-setup");
      await prepareDatabase(client);
      const names = await migrationNames();
      const aclMigrationIndex = names.indexOf(ACL_MIGRATION);
      assert.notEqual(aclMigrationIndex, -1, "the T1-C migration is present in the migration chain");
      assert.ok(names.slice(0, aclMigrationIndex).includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
        "the selected c29 baseline is applied before the T1-C migration");
      await applyMigrations(client, names.slice(0, aclMigrationIndex));

      const before = await aclSnapshot(client);
      const sourceService = before.filter((row) => row.service_exec);
      const sourceOpen = before.filter((row) => row.anon_exec || row.authenticated_exec || row.public_exec);
      const sourceAnon = before.filter((row) => row.anon_exec).length;
      const sourceAuthenticated = before.filter((row) => row.authenticated_exec).length;
      const sourcePublic = before.filter((row) => row.public_exec).length;
      const sourceSecurityDefiner = before.filter((row) => row.prosecdef).length;
      assert.equal(sourceOpen.length, 1, "only the audit trigger helper has an open source-baseline grant");
      assert.deepEqual(sourceOpen.map((row) => row.signature), ["ai_report_audit_immutable()"],
        "the only open source-baseline routine is the audit trigger helper");

      const policiesBefore = await policySnapshot(client);
      const policyRoutineDependenciesBefore = await miniBiPolicyRoutineDependencies(client);
      assert.deepEqual(policyRoutineDependenciesBefore, [],
        "no RLS policy directly depends on a Mini BI RPC whose client EXECUTE grant is removed");
      const triggersBefore = await triggerSnapshot(client);
      const defaultsBefore = await aclDefaultsSnapshot(client);

      await client.query(
        "create role s0_t1c_runner nologin;"
          + " grant postgres to s0_t1c_runner with admin false, inherit true, set false;"
          + " grant direct_entry_catalog_bootstrap_executor to s0_t1c_runner"
          + " with admin true, inherit false, set false;",
      );
      const { rows: runnerMembershipBefore } = await client.query(
        `select m.grantor::regrole::text as grantor, m.admin_option, m.inherit_option, m.set_option
           from pg_catalog.pg_auth_members m
          where m.member = 's0_t1c_runner'::regrole
            and m.roleid = 'direct_entry_catalog_bootstrap_executor'::regrole
          order by grantor`,
      );
      assert.equal(runnerMembershipBefore.length, 1);
      assert.equal(runnerMembershipBefore[0].set_option, false,
        "the migration runner has ADMIN but not SET on the executor role");
      const { rows: runnerSetBefore } = await client.query(
        `select pg_catalog.pg_has_role('s0_t1c_runner',
          'direct_entry_catalog_bootstrap_executor', 'SET') as can_set_executor`,
      );
      assert.equal(runnerSetBefore[0].can_set_executor, false,
        "the migration runner must use the temporary scoped membership path");

      // Reproduce the live bootstrap-owner ACL drift before broad staging grants.
      await client.query("set role direct_entry_catalog_bootstrap_executor");
      await client.query(
        "grant execute on function public.direct_entry_catalog_bootstrap_projection(),"
          + " public.direct_entry_catalog_bootstrap_plan(uuid,uuid),"
          + " public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)"
          + " to public, anon, authenticated, service_role",
      );
      await client.query("reset role");

      // Model the broad staging ACL with catalog-only grants inside this disposable cluster.
      await client.query(
        "create function public.s0_t1c_unrelated_probe() returns integer language sql immutable as $$ select 1 $$;"
          + " grant execute on all functions in schema public to public, anon, authenticated, service_role;",
      );
      const broadened = await aclSnapshot(client);
      assert.equal(broadened.filter((row) => row.anon_exec).length, broadened.length);
      assert.equal(broadened.filter((row) => row.authenticated_exec).length, broadened.length);
      assert.equal(broadened.filter((row) => row.service_exec).length, broadened.length);
      const migration = await readFile(path.join(MIGRATION_DIR, ACL_MIGRATION), "utf8");
      await client.query("set session authorization s0_t1c_runner");
      try {
        await client.query("begin");
        await client.query(migration);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        await client.query("reset session authorization");
      }
      const { rows: runnerMembershipAfter } = await client.query(
        `select m.grantor::regrole::text as grantor, m.admin_option, m.inherit_option, m.set_option
           from pg_catalog.pg_auth_members m
          where m.member = 's0_t1c_runner'::regrole
            and m.roleid = 'direct_entry_catalog_bootstrap_executor'::regrole
          order by grantor`,
      );
      assert.deepEqual(runnerMembershipAfter, runnerMembershipBefore,
        "the migration removes its temporary SET membership and preserves the original role grant");
      const { rows: runnerSetAfter } = await client.query(
        `select pg_catalog.pg_has_role('s0_t1c_runner',
          'direct_entry_catalog_bootstrap_executor', 'SET') as can_set_executor`,
      );
      assert.equal(runnerSetAfter[0].can_set_executor, false,
        "the temporary SET capability does not survive migration commit");
      const policiesAfterAcl = await policySnapshot(client);
      const triggersAfterAcl = await triggerSnapshot(client);
      const defaultsAfterAcl = await aclDefaultsSnapshot(client);
      assert.deepEqual(policiesAfterAcl, policiesBefore, "the ACL migration leaves RLS policy definitions and role lists unchanged");
      assert.deepEqual(await miniBiPolicyRoutineDependencies(client), policyRoutineDependenciesBefore,
        "the ACL migration leaves RLS policy function dependencies unchanged");
      assert.deepEqual(triggersAfterAcl, triggersBefore, "the ACL migration leaves trigger bindings unchanged");
      assert.deepEqual(defaultsAfterAcl, defaultsBefore,
        "the ACL migration does not alter global or schema default privileges");
      const r2_1Index = names.indexOf(R2_1_MIGRATION);
      assert.notEqual(r2_1Index, -1, "the R2.1 migration is present in the migration chain");
      await applyMigrations(client, names.slice(aclMigrationIndex + 1, r2_1Index));

      // Seed schema_migrations for #1..#128 with #124 carrying its pre-PR #92 historical checksum:
      for (const appliedName of names.slice(0, r2_1Index)) {
        const sqlText = await readFile(path.join(MIGRATION_DIR, appliedName), "utf8");
        const checksum =
          appliedName === ACL_MIGRATION
            ? S0_T1_C_PRE_PR92_CHECKSUM
            : migrationChecksum(sqlText);
        await client.query(
          "insert into public.schema_migrations (version, checksum) values ($1, $2)",
          [appliedName, checksum],
        );
      }

      const passthroughClient = () => ({
        async connect() {},
        query: (sql, params) => client.query(sql, params),
        async end() {},
      });

      // Verify fail-closed when an internal helper's ACL is broadened on a DB with #124's pre-PR #92 checksum:
      await client.query(
        "grant execute on function public.set_updated_at() to service_role",
      );
      await client.query("set session authorization s0_t1c_runner");
      try {
        const failedPreflight = await runMigrationValidation({
          mode: "dry-run",
          directory: MIGRATION_DIR,
          loadConfig: async () => ({ databaseUrl: "postgres://local" }),
          createClient: passthroughClient,
          log() {},
        });
        assert.deepEqual(
          failedPreflight.mismatches,
          [ACL_MIGRATION],
          "historical #124 checksum must fail closed when ACL postconditions are violated",
        );
      } finally {
        await client.query("reset session authorization");
      }
      await client.query(
        "revoke execute on function public.set_updated_at() from service_role",
      );

      // Verify preflight dry-run PASSES and official runMigrationApply applies #129 under non-superuser s0_t1c_runner
      // without mutating #124's historical ledger checksum or re-executing #124:
      await client.query("set session authorization s0_t1c_runner");
      try {
        const preflight = await runMigrationValidation({
          mode: "dry-run",
          directory: MIGRATION_DIR,
          loadConfig: async () => ({ databaseUrl: "postgres://local" }),
          createClient: passthroughClient,
          log() {},
        });
        assert.deepEqual(preflight.mismatches, [], "preflight dry-run passes when #124 postconditions hold");

        const applySummary = await runMigrationApply({
          directory: MIGRATION_DIR,
          loadConfig: async () => ({ databaseUrl: "postgres://local", projectRef: "s0t1" }),
          createClient: passthroughClient,
          log() {},
        });
        assert.equal(
          applySummary.appliedCount,
          names.length - r2_1Index,
          "only migrations from #129 onward are applied",
        );
        assert.equal(applySummary.skippedCount, r2_1Index, "all 128 prior migrations are skipped");
      } finally {
        await client.query("reset session authorization");
      }

      const { rows: ledger124After } = await client.query(
        "select checksum from public.schema_migrations where version = $1",
        [ACL_MIGRATION],
      );
      assert.equal(
        ledger124After[0]?.checksum,
        S0_T1_C_PRE_PR92_CHECKSUM,
        "compatibility check never rewrites #124's historical ledger checksum",
      );
      const { rows: ledgerCountAfter } = await client.query(
        "select count(*)::integer as total from public.schema_migrations",
      );
      assert.equal(ledgerCountAfter[0]?.total, names.length, "ledger reaches 129/129 after applying #129");

      const expectedSignatures = [...migration.matchAll(/^\s+'(public\.[^']+)'[,]?$/gm)]
        .map((match) => match[1]);
      const r1_2Migration = await readFile(path.join(MIGRATION_DIR, R1_2_MIGRATION), "utf8");
      const r1_2Normalized = r1_2Migration.replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase();
      const r1_2Grant = "grant execute on function " + R1_2_SERVICE_RPC.toLowerCase() + " to service_role;";
      const r1_2Revoke = "revoke all on function " + R1_2_SERVICE_RPC.toLowerCase() +
        " from public, anon, authenticated, service_role;";
      assert.ok(r1_2Normalized.includes(r1_2Grant),
        "R1.2 explicitly grants only its new search RPC to service_role");
      assert.ok(r1_2Normalized.includes(r1_2Revoke),
        "R1.2 revokes client and inherited role access before adding the service grant");
      const f1Migration = await readFile(path.join(MIGRATION_DIR, F1_WORK_REPORTS_MIGRATION_NAME), "utf8");
      assert.match(
        f1Migration,
        /revoke all on function %s from public, anon, authenticated, service_role/,
        "F1 Work Reports revokes all work_report_* functions before granting allowlisted RPCs",
      );
      expectedSignatures.push(R1_2_SERVICE_RPC, ...F1_WORK_REPORTS_SERVICE_RPC_SIGNATURES);
      assert.ok(expectedSignatures.length > 0, "the explicit server/invoker allowlist is not empty");
      assert.equal(new Set(expectedSignatures).size, expectedSignatures.length, "the allowlist has no duplicates");
      const { rows: resolvedExpected } = await client.query(
        "select signature, pg_catalog.to_regprocedure(signature)::oid::bigint as oid"
          + " from unnest($1::text[]) as signatures(signature) order by 1",
        [expectedSignatures],
      );
      assert.ok(resolvedExpected.every((row) => row.oid !== null), "all explicit allowlist signatures resolve");
      const expectedOids = resolvedExpected.map((row) => String(row.oid)).sort();
      const expectedOidSet = new Set(expectedOids);
      const sourceServiceOidSet = new Set(sourceService.map((row) => String(row.oid)));
      const allowlistMissingFromSource = resolvedExpected
        .filter((row) => !sourceServiceOidSet.has(String(row.oid))).map((row) => row.signature);
      assert.deepEqual(
        allowlistMissingFromSource,
        [R1_2_SERVICE_RPC, ...F1_WORK_REPORTS_SERVICE_RPC_SIGNATURES].sort(),
        "only the explicitly reviewed post-S0 RPCs add service_role grants after the S0 baseline",
      );
      const removedSourceService = sourceService
        .filter((row) => !expectedOidSet.has(String(row.oid))).map((row) => row.signature).sort();

      const after = await aclSnapshot(client);
      assert.ok(after.every((row) => !row.anon_exec && !row.authenticated_exec && !row.public_exec),
        "no current or later Mini BI RPC exposes EXECUTE to anon, authenticated or PUBLIC");
      const serviceOids = after.filter((row) => row.service_exec).map((row) => String(row.oid)).sort();
      assert.deepEqual(serviceOids, expectedOids, "service_role EXECUTE exactly matches the explicit allowlist");
      assert.ok(after.every((row) => row.owner_exec), "function owners retain owner EXECUTE");

      const { rows: bootstrapOwner } = await client.query(
        `select pg_catalog.has_function_privilege('direct_entry_catalog_bootstrap_executor',
          'public.direct_entry_catalog_bootstrap_plan(uuid,uuid)', 'EXECUTE') as plan_exec,
          pg_catalog.has_function_privilege('direct_entry_catalog_bootstrap_executor',
          'public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)', 'EXECUTE') as apply_exec,
          pg_catalog.has_function_privilege('direct_entry_catalog_bootstrap_executor',
          'public.direct_entry_catalog_bootstrap_projection()', 'EXECUTE') as projection_exec,
          pg_catalog.pg_has_role('s0_t1c_runner',
          'direct_entry_catalog_bootstrap_executor', 'MEMBER') as membership_unchanged`,
      );
      assert.equal(bootstrapOwner[0].plan_exec, true, "catalog bootstrap executor retains its intended plan rights");
      assert.equal(bootstrapOwner[0].apply_exec, true, "catalog bootstrap executor retains its intended apply rights");
      assert.equal(bootstrapOwner[0].projection_exec, true, "catalog bootstrap executor retains owner rights to its private projection helper");
      assert.equal(bootstrapOwner[0].membership_unchanged, true, "the migration does not alter executor role membership");

      // Open-schema functions outside Mini BI's name families are untouched.
      const { rows: unrelated } = await client.query(
        `select pg_catalog.has_function_privilege('anon', 'public.s0_t1c_unrelated_probe()', 'EXECUTE') as anon_exec,
                pg_catalog.has_function_privilege('service_role', 'public.s0_t1c_unrelated_probe()', 'EXECUTE') as service_exec`,
      );
      assert.equal(unrelated[0].anon_exec, true);
      assert.equal(unrelated[0].service_exec, true);

      // Neither client role can invoke a SECURITY DEFINER entry point directly.
      for (const role of ["anon", "authenticated"]) {
        await client.query(`set role ${role}`);
        await assert.rejects(
          client.query("select public.direct_entry_resolve_actor_context($1::uuid)",
            ["00000000-0000-4000-8000-000000000001"]),
          (error) => error?.code === "42501",
          `${role} must be rejected by function EXECUTE ACL before the RPC body runs`,
        );
        await client.query("reset role");
      }

      // A representative allowlisted server RPC returns a constant and reads no application rows.
      await client.query("set role service_role");
      const capability = await client.query("select public.ai_report_review_capability() as value");
      await client.query("reset role");
      assert.equal(capability.rows[0].value.ok, true, "service_role can still call an allowlisted server RPC");

      // Trigger calls do not consult function EXECUTE ACL at row-update time.
      await client.query(
        "create table public.s0_t1c_updated_at_probe(updated_at timestamptz not null);"
          + " insert into public.s0_t1c_updated_at_probe values ('2000-01-01 UTC');"
          + " create trigger s0_t1c_updated_at_before_update before update on public.s0_t1c_updated_at_probe"
          + " for each row execute function public.set_updated_at();"
          + " grant select, update on public.s0_t1c_updated_at_probe to service_role;"
          + " create table public.s0_t1c_immutable_probe(id integer primary key);"
          + " insert into public.s0_t1c_immutable_probe values (1);"
          + " create trigger s0_t1c_immutable_before_update before update or delete on public.s0_t1c_immutable_probe"
          + " for each row execute function public.ai_report_audit_immutable();"
          + " grant select, update, delete on public.s0_t1c_immutable_probe to service_role;",
      );
      await client.query("set role service_role");
      const { rows: updatedAtRows } = await client.query(
        "update public.s0_t1c_updated_at_probe set updated_at='2001-01-01 UTC' returning updated_at",
      );
      await client.query("reset role");
      assert.notEqual(new Date(updatedAtRows.at(-1).updated_at).toISOString(), "2001-01-01T00:00:00.000Z",
        "the existing updated_at trigger still fires without a direct service_role EXECUTE grant");
      await client.query("set role service_role");
      await assert.rejects(
        client.query("update public.s0_t1c_immutable_probe set id=1 where id=1"),
        (error) => error?.code === "P0001" && error.message.includes("append-only"),
        "the immutable trigger still rejects a mutation without direct function EXECUTE",
      );
      await client.query("reset role");

      // Keep a lightweight static guard on the actor source boundary this ACL change relies on.
      const actorRepository = await readFile(path.join(ROOT, "src", "lib", "direct-entry", "actor-context-repository.ts"), "utf8");
      const actorAuth = await readFile(path.join(ROOT, "src", "lib", "auth", "direct-entry-v2.ts"), "utf8");
      const supabaseServer = await readFile(path.join(ROOT, "src", "lib", "supabase", "server.ts"), "utf8");
      assert.match(actorRepository, /createServiceSupabaseClient\(\)/);
      assert.match(actorRepository, /p_auth_subject:\s*authSubject/);
      assert.match(actorAuth, /input\.session\.auth_subject/);
      assert.match(supabaseServer, /SUPABASE_SECRET_KEY/);

      t.diagnostic(`Mini BI RPC ACL: source functions=${before.length}, SECURITY DEFINER=${sourceSecurityDefiner}, anon=${sourceAnon}, authenticated=${sourceAuthenticated}, PUBLIC=${sourcePublic}, service_role=${sourceService.length}; source service grants removed=${removedSourceService.length}, allowlist grants added=${allowlistMissingFromSource.length}; allowlisted service_role=${serviceOids.length}, client/PUBLIC EXECUTE=0`);
    } finally {
      await client?.query("reset role").catch(() => {});
      await client?.end().catch(() => {});
      await admin?.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]).catch(() => {});
      await admin?.query(`drop database if exists ${databaseName}`).catch(() => {});
      await admin?.end().catch(() => {});
      if (serverStarted) {
        const pgCtlPath = pgCtl;
        spawnSync(pgCtlPath, ["-D", dataDir, "-m", "fast", "-w", "stop"], {
          encoding: "utf8", windowsHide: true, stdio: "ignore",
        });
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
