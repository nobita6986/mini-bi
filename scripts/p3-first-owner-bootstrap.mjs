#!/usr/bin/env node
import { Client } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CAPABILITIES, resolveActor } from "../src/lib/auth/direct-entry-v2.ts";
import { readMigrations } from "./lib/migration-validation.mjs";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const LOCK_KEY = "p3-first-owner-bootstrap-s02a";
const EMAIL_SCHEMA = z.email().max(254);
const MIGRATION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
const AUTH_TABLES = [
  "direct_entry_app_users",
  "direct_entry_capability_grants",
  "direct_entry_scope_grants",
  "direct_entry_audit_events",
];

/**
 * P2.5-HF-R5: direct_entry_app_users.display_name is NOT NULL and canonical.
 * The owner account display name is the login label (the part before "@" of the
 * verified email). A blank label fails closed - no placeholder, no UUID.
 */
function displayNameFromEmail(email) {
  const displayName = String(email ?? "").split("@")[0].trim();
  if (displayName.length < 1 || displayName.length > 256) {
    throw new Error("DISPLAY_NAME_INVALID");
  }
  return displayName;
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function sameSet(actual, expected) {
  return actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value));
}

function isEffective(row, today) {
  return row.valid_from <= today && (row.valid_to === null || today < row.valid_to);
}

async function one(client, sql, values = []) {
  const result = await client.query(sql, values);
  if (result.rows.length !== 1) fail("DATABASE_INVARIANT_FAILED");
  return result.rows[0];
}

async function securitySnapshot(client) {
  const tables = await client.query(
    `select c.relname as table_name, c.relrowsecurity, c.relforcerowsecurity,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
       has_table_privilege('anon', c.oid, 'INSERT') as anon_insert,
       has_table_privilege('anon', c.oid, 'UPDATE') as anon_update,
       has_table_privilege('anon', c.oid, 'DELETE') as anon_delete,
       has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
       has_table_privilege('authenticated', c.oid, 'INSERT') as authenticated_insert,
       has_table_privilege('authenticated', c.oid, 'UPDATE') as authenticated_update,
       has_table_privilege('authenticated', c.oid, 'DELETE') as authenticated_delete,
       has_table_privilege('service_role', c.oid, 'SELECT') as service_select,
       has_table_privilege('service_role', c.oid, 'INSERT') as service_insert,
       has_table_privilege('service_role', c.oid, 'UPDATE') as service_update,
       has_table_privilege('service_role', c.oid, 'DELETE') as service_delete
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = any($1::text[])
    order by c.relname`,
    [AUTH_TABLES],
  );
  if (tables.rows.length !== AUTH_TABLES.length ||
      tables.rows.some((row) => !row.relrowsecurity || !row.relforcerowsecurity)) {
    fail("SECURITY_BOUNDARY_UNEXPECTED");
  }
  for (const row of tables.rows) {
    for (const role of ["anon", "authenticated"]) {
      for (const operation of ["select", "insert", "update", "delete"]) {
        if (row[`${role}_${operation}`]) fail("SECURITY_BOUNDARY_UNEXPECTED");
      }
    }
    for (const operation of ["select", "insert", "update", "delete"]) {
      if (row[`service_${operation}`]) fail("SECURITY_BOUNDARY_UNEXPECTED");
    }
  }
  const rpc = await one(
    client,
    `select has_function_privilege('anon', 'public.direct_entry_resolve_actor_context(uuid)', 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', 'public.direct_entry_resolve_actor_context(uuid)', 'EXECUTE') as authenticated_exec,
       has_function_privilege('service_role', 'public.direct_entry_resolve_actor_context(uuid)', 'EXECUTE') as service_exec`,
  );
  if (rpc.anon_exec || rpc.authenticated_exec || !rpc.service_exec) {
    fail("SECURITY_BOUNDARY_UNEXPECTED");
  }
  const auditTrigger = await one(
    client,
    `select t.tgenabled, pg_get_triggerdef(t.oid) as definition
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'direct_entry_audit_events'
        and t.tgname = 'direct_entry_audit_immutable' and not t.tgisinternal`,
  );
  if (auditTrigger.tgenabled !== "O" ||
      !/BEFORE (?:UPDATE OR DELETE|DELETE OR UPDATE)/i.test(auditTrigger.definition)) {
    fail("SECURITY_BOUNDARY_UNEXPECTED");
  }
  const inventory = await one(
    client,
    `select count(*)::int as total,
       count(*) filter (where has_function_privilege('service_role', p.oid, 'EXECUTE'))::int as service_exec
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'direct_entry_%'`,
  );
  return {
    tables: tables.rows.map((row) => [
      row.table_name,
      row.relrowsecurity,
      row.relforcerowsecurity,
      row.anon_select, row.anon_insert, row.anon_update, row.anon_delete,
      row.authenticated_select, row.authenticated_insert,
      row.authenticated_update, row.authenticated_delete,
      row.service_select, row.service_insert, row.service_update, row.service_delete,
    ]),
    auditAppendOnly: [auditTrigger.tgenabled, auditTrigger.definition],
    rpc: [rpc.anon_exec, rpc.authenticated_exec, rpc.service_exec],
    inventory: [inventory.total, inventory.service_exec],
  };
}

async function reportingSnapshot(client) {
  const counts = [];
  for (const table of ["data_sources", "sync_runs", "daily_recruitment_breakdown", "sync_errors"]) {
    const row = await one(client, `select count(*)::bigint as total from public.${table}`);
    counts.push([table, Number(row.total)]);
  }
  return counts;
}

async function inspectSubject(client, email, today, capabilities) {
  const authUsers = await client.query(
    `select id, email_confirmed_at, banned_until, deleted_at
       from auth.users
      where lower(email) = lower($1)`,
    [email],
  );
  if (authUsers.rows.length === 0) fail("AUTH_USER_NOT_FOUND");
  if (authUsers.rows.length !== 1) fail("AUTH_USER_NOT_UNIQUE");
  const user = authUsers.rows[0];
  if (!user.email_confirmed_at ||
      (user.banned_until && new Date(user.banned_until).getTime() > Date.now()) ||
      user.deleted_at) {
    fail("AUTH_USER_NOT_ELIGIBLE");
  }

  const mappings = await client.query(
    `select app_user_id, enabled
       from public.direct_entry_app_users
      where auth_subject = $1::uuid`,
    [user.id],
  );
  if (mappings.rows.length > 1) fail("APP_USER_MAPPING_NOT_UNIQUE");
  const totalUsers = await one(
    client,
    "select count(*)::int as total from public.direct_entry_app_users",
  );
  if (mappings.rows.length === 0 && totalUsers.total !== 0) {
    fail("FIRST_OWNER_BOOTSTRAP_CONFLICT");
  }

  const appUserId = mappings.rows[0]?.app_user_id ?? null;
  if (!appUserId) {
    return {
      authSubject: user.id,
      appUserId: null,
      enabled: false,
      mapped: false,
      capabilities: [],
      scopes: [],
      actor: null,
      auditCount: 0,
      insertedCapabilities: capabilities.length,
      insertedScopes: 2,
      authConfirmed: true,
    };
  }

  const capabilityRows = await client.query(
    `select capability, valid_from::text, valid_to::text
       from public.direct_entry_capability_grants
      where app_user_id = $1::uuid
      order by capability, valid_from`,
    [appUserId],
  );
  const activeCapabilities = capabilityRows.rows.filter((row) => isEffective(row, today));
  const activeCapabilityNames = activeCapabilities.map((row) => row.capability);
  if (new Set(activeCapabilityNames).size !== activeCapabilityNames.length ||
      activeCapabilityNames.some((item) => !capabilities.includes(item))) {
    fail("EXISTING_CAPABILITY_GRANTS_CONFLICT");
  }
  const missingCapabilities = capabilities.filter((item) => !activeCapabilityNames.includes(item));
  for (const grant of capabilityRows.rows) {
    if (missingCapabilities.includes(grant.capability) &&
        grant.valid_from > today && (grant.valid_to === null || today < grant.valid_to)) {
      fail("FUTURE_CAPABILITY_GRANT_CONFLICT");
    }
  }

  const scopeRows = await client.query(
    `select scope_kind, team_id, valid_from::text, valid_to::text
       from public.direct_entry_scope_grants
      where app_user_id = $1::uuid
      order by scope_kind, valid_from`,
    [appUserId],
  );
  const effectiveScopes = scopeRows.rows.filter((row) => isEffective(row, today));
  const activeTeams = effectiveScopes.filter((row) => row.scope_kind === "team");
  const ownScopes = effectiveScopes.filter((row) => row.scope_kind === "own" && row.team_id === null);
  const allScopes = effectiveScopes.filter((row) => row.scope_kind === "all" && row.team_id === null);
  if (activeTeams.length > 0 || ownScopes.length > 1 || allScopes.length > 1 ||
      effectiveScopes.some((row) =>
        (row.scope_kind === "own" || row.scope_kind === "all") && row.team_id !== null)) {
    fail("EXISTING_SCOPE_GRANTS_CONFLICT");
  }
  for (const scope of scopeRows.rows) {
    if ((scope.scope_kind === "own" || scope.scope_kind === "all") &&
        scope.valid_from > today && (scope.valid_to === null || today < scope.valid_to)) {
      fail("FUTURE_SCOPE_GRANT_CONFLICT");
    }
  }
  const missingScopes = [];
  if (ownScopes.length === 0) missingScopes.push("own");
  if (allScopes.length === 0) missingScopes.push("all");
  if (effectiveScopes.some((row) =>
    (row.scope_kind === "own" || row.scope_kind === "all") && row.valid_to !== null)) {
    fail("EXISTING_SCOPE_GRANTS_CONFLICT");
  }

  const audit = await one(
    client,
    "select count(*)::int as total from public.direct_entry_audit_events where app_user_id = $1::uuid",
    [appUserId],
  );
  let actor = null;
  const needsApply = !mappings.rows[0].enabled ||
    missingCapabilities.length > 0 || missingScopes.length > 0;
  if (!needsApply) {
    const context = await one(
      client,
      "select public.direct_entry_resolve_actor_context($1::uuid) as context",
      [user.id],
    );
    const resolution = await resolveActor({
      session: {
        auth_subject: user.id,
        provider: "supabase",
        authenticated_at: null,
      },
      repository: { loadByAuthSubject: async () => context.context },
      at: `${today}T12:00:00.000Z`,
    });
    if (!resolution.ok || resolution.actor.enabled !== true ||
        !sameSet([...resolution.actor.capabilities], capabilities) ||
        !sameSet(resolution.actor.scopes.map((scope) => scope.kind), ["own", "all"])) {
      fail("ACTOR_CONTEXT_VALIDATION_FAILED");
    }
    actor = {
      enabled: resolution.actor.enabled,
      capabilityCount: resolution.actor.capabilities.length,
      ownScope: resolution.actor.scopes.some((scope) => scope.kind === "own"),
      allScope: resolution.actor.scopes.some((scope) => scope.kind === "all"),
      teamScopeCount: resolution.actor.scopes.filter((scope) => scope.kind === "team").length,
    };
  }
  return {
    authSubject: user.id,
    appUserId,
    enabled: mappings.rows[0].enabled,
    mapped: true,
    capabilities: activeCapabilityNames,
    scopes: effectiveScopes,
    missingCapabilities,
    missingScopes,
    actor,
    auditCount: audit.total,
    insertedCapabilities: missingCapabilities.length,
    insertedScopes: missingScopes.length,
    authConfirmed: true,
    needsApply,
  };
}

export async function runBootstrap({ client, email, apply = false, capabilities = CAPABILITIES }) {
  if (!EMAIL_SCHEMA.safeParse(email).success ||
      !Array.isArray(capabilities) ||
      capabilities.length !== CAPABILITIES.length ||
      new Set(capabilities).size !== capabilities.length) {
    fail("BOOTSTRAP_INPUT_INVALID");
  }
  const migrationCount = (await readMigrations(MIGRATION_DIR)).length;

  let transactionOpen = false;
  try {
    await client.query(apply ? "begin" : "begin read only");
    transactionOpen = true;
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [LOCK_KEY]);

    const date = await one(
      client,
      "select public.direct_entry_authorization_date()::text as today",
    );
    const beforeSecurity = await securitySnapshot(client);
    const beforeReporting = await reportingSnapshot(client);
    const before = await inspectSubject(client, email.trim(), date.today, capabilities);
    let appUserId = before.appUserId;
    let state = before;

    if (apply && (!before.mapped || before.needsApply)) {
      if (!appUserId) {
        const inserted = await one(
          client,
          `insert into public.direct_entry_app_users (auth_subject, enabled, display_name)
           values ($1::uuid, true, $2::text) returning app_user_id`,
          [before.authSubject, displayNameFromEmail(email)],
        );
        appUserId = inserted.app_user_id;
      } else if (!before.enabled) {
        await client.query(
          "update public.direct_entry_app_users set enabled = true where app_user_id = $1::uuid",
          [appUserId],
        );
      }

      await client.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)
         select $1::uuid, capability, $2::date
           from unnest($3::text[]) as requested(capability)`,
        [appUserId, date.today, before.mapped ? before.missingCapabilities : capabilities],
      );
      const toInsertScopes = before.mapped
        ? before.missingScopes
        : ["own", "all"];
      for (const scopeKind of toInsertScopes) {
        await client.query(
          `insert into public.direct_entry_scope_grants
             (app_user_id, scope_kind, team_id, valid_from, valid_to)
           values ($1::uuid, $2, null, $3::date, null)`,
          [appUserId, scopeKind, date.today],
        );
      }

      state = await inspectSubject(client, email.trim(), date.today, capabilities);
      if (!state.mapped || state.needsApply || !state.actor) {
        fail("POST_APPLY_VALIDATION_FAILED");
      }
    } else if (before.mapped && before.needsApply) {
      state.actor = null;
    }

    const afterSecurity = await securitySnapshot(client);
    if (JSON.stringify(afterSecurity) !== JSON.stringify(beforeSecurity)) {
      fail("SECURITY_BOUNDARY_CHANGED");
    }
    const afterReporting = await reportingSnapshot(client);
    if (JSON.stringify(afterReporting) !== JSON.stringify(beforeReporting)) {
      fail("REPORTING_BASELINE_CHANGED");
    }
    if (state.mapped && state.auditCount !== before.auditCount) {
      fail("AUDIT_BOUNDARY_CHANGED");
    }
    if (apply) {
      await client.query("commit");
    } else {
      await client.query("rollback");
    }
    transactionOpen = false;

    const changed = apply && (!before.mapped || before.needsApply);
    return {
      mode: apply ? "apply" : "check",
      outcome: changed ? "APPLIED" :
        state.mapped && !state.needsApply ? "ALREADY_BOOTSTRAPPED" :
        apply ? "APPLIED" : "READY_TO_APPLY",
      authUserMatches: 1,
      authEmailConfirmed: state.authConfirmed,
      appUserMappings: state.mapped ? 1 : 0,
      enabled: state.enabled || (apply && state.mapped),
      effectiveCapabilityCount: state.mapped ? state.capabilities.length : 0,
      requiredCapabilityCount: capabilities.length,
      effectiveOwnScopeCount: state.mapped
        ? state.scopes.filter((scope) => scope.scope_kind === "own" && isEffective(scope, date.today)).length
        : 0,
      effectiveAllScopeCount: state.mapped
        ? state.scopes.filter((scope) => scope.scope_kind === "all" && isEffective(scope, date.today)).length
        : 0,
      effectiveTeamScopeCount: state.mapped
        ? state.scopes.filter((scope) => scope.scope_kind === "team" && isEffective(scope, date.today)).length
        : 0,
      actorContext: state.actor,
      bootstrapAuditEventsWritten: 0,
      reportingBaselineUnchanged: true,
      securityBoundaryUnchanged: true,
      migrationCount,
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("rollback");
      } catch {
        fail("BOOTSTRAP_ROLLBACK_FAILED");
      }
    }
    if (typeof error?.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code)) throw error;
    fail("BOOTSTRAP_DATABASE_ERROR");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply") || args.filter((arg) => arg === "--apply").length > 1) {
    fail("BOOTSTRAP_ARGUMENTS_INVALID");
  }
  const email = process.env.P3_FIRST_OWNER_EMAIL;
  if (!email) fail("BOOTSTRAP_INPUT_REQUIRED");

  const config = await loadSupabaseConfig();
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: buildSslOptions(),
    connectionTimeoutMillis: 10000,
  });
  try {
    await client.connect();
    const summary = await runBootstrap({
      client,
      email,
      apply: args.includes("--apply"),
    });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) {
  main().catch((error) => {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : "BOOTSTRAP_DATABASE_ERROR";
    console.error(`FIRST_OWNER_BOOTSTRAP_FAILED ${code}`);
    process.exitCode = 1;
  });
}
