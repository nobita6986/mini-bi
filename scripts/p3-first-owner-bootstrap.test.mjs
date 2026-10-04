import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { CAPABILITIES } from "../src/lib/auth/direct-entry-v2.ts";
import { readMigrations } from "./lib/migration-validation.mjs";
import { runBootstrap } from "./p3-first-owner-bootstrap.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const SUBJECT = "19000000-0000-4000-8000-000000000001";
const OTHER_SUBJECT = "19000000-0000-4000-8000-000000000002";
const EMAIL = "synthetic-owner@example.invalid";

async function database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await (await import("node:fs/promises")).readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  await db.exec(
    "alter table auth.users add column email text;" +
    "alter table auth.users add column email_confirmed_at timestamptz;" +
    "alter table auth.users add column banned_until timestamptz;" +
    "alter table auth.users add column deleted_at timestamptz;",
  );
  return db;
}

async function addAuthUser(db, {
  id = SUBJECT,
  email = EMAIL,
  confirmed = true,
  banned = false,
  deleted = false,
} = {}) {
  await db.query(
    `insert into auth.users (id, email, email_confirmed_at, banned_until, deleted_at)
     values ($1::uuid, $2, $3, $4, $5)`,
    [
      id,
      email,
      confirmed ? "2026-10-01T00:00:00Z" : null,
      banned ? "2999-01-01T00:00:00Z" : null,
      deleted ? "2026-10-01T00:00:00Z" : null,
    ],
  );
}

async function counts(db, subject = SUBJECT) {
  const { rows } = await db.query(
    `select
       (select count(*)::int from public.direct_entry_app_users where auth_subject = $1::uuid) as mappings,
       (select count(*)::int from public.direct_entry_capability_grants where app_user_id in
         (select app_user_id from public.direct_entry_app_users where auth_subject = $1::uuid)) as capabilities,
       (select count(*)::int from public.direct_entry_scope_grants where app_user_id in
         (select app_user_id from public.direct_entry_app_users where auth_subject = $1::uuid)) as scopes,
       (select count(*)::int from public.direct_entry_audit_events where app_user_id in
         (select app_user_id from public.direct_entry_app_users where auth_subject = $1::uuid)) as audits`,
    [subject],
  );
  return rows[0];
}

async function run(db, { apply = false, email = EMAIL } = {}) {
  return runBootstrap({ client: db, email, apply });
}

test("check-only validates target without mutating mapping, grants, scopes, or audit", async () => {
  const db = await database();
  await addAuthUser(db);
  const before = await counts(db);

  const result = await run(db);

  assert.equal(result.outcome, "READY_TO_APPLY");
  assert.equal(result.migrationCount, (await readMigrations(MIGRATION_DIR)).length);
  assert.equal(result.authUserMatches, 1);
  assert.equal(result.appUserMappings, 0);
  assert.equal(result.bootstrapAuditEventsWritten, 0);
  assert.deepEqual(await counts(db), before);
  const output = JSON.stringify(result);
  assert.equal(output.includes(EMAIL), false);
  assert.equal(output.includes(SUBJECT), false);
  await db.close();
});

test("missing and case-insensitively non-unique Auth identities fail closed", async () => {
  const db = await database();
  await assert.rejects(run(db), { code: "AUTH_USER_NOT_FOUND" });
  await addAuthUser(db);
  await addAuthUser(db, { id: OTHER_SUBJECT, email: "SYNTHETIC-OWNER@EXAMPLE.INVALID" });
  await assert.rejects(run(db), { code: "AUTH_USER_NOT_UNIQUE" });
  assert.deepEqual(await counts(db), { mappings: 0, capabilities: 0, scopes: 0, audits: 0 });
  await db.close();
});

test("unconfirmed, banned, and deleted Auth users are rejected without mutation", async () => {
  for (const [status, options] of [
    ["unconfirmed", { confirmed: false }],
    ["banned", { banned: true }],
    ["deleted", { deleted: true }],
  ]) {
    const db = await database();
    await addAuthUser(db, options);
    await assert.rejects(run(db), { code: "AUTH_USER_NOT_ELIGIBLE" }, status);
    assert.deepEqual(await counts(db), { mappings: 0, capabilities: 0, scopes: 0, audits: 0 });
    await db.close();
  }
});

test("a foreign existing app user blocks a new first-owner mapping", async () => {
  const db = await database();
  await addAuthUser(db);
  await addAuthUser(db, { id: OTHER_SUBJECT, email: "other@example.invalid" });
  await db.query(
    "insert into public.direct_entry_app_users (auth_subject, enabled) values ($1::uuid, true)",
    [OTHER_SUBJECT],
  );
  await assert.rejects(run(db), { code: "FIRST_OWNER_BOOTSTRAP_CONFLICT" });
  assert.deepEqual(await counts(db), { mappings: 0, capabilities: 0, scopes: 0, audits: 0 });
  await db.close();
});

test("first apply grants canonical capabilities and own/all scopes; replay is idempotent", async () => {
  const db = await database();
  await addAuthUser(db);

  const applied = await run(db, { apply: true });
  assert.equal(applied.outcome, "APPLIED");
  assert.equal(applied.appUserMappings, 1);
  assert.equal(applied.enabled, true);
  assert.equal(applied.effectiveCapabilityCount, 21);
  assert.equal(applied.effectiveOwnScopeCount, 1);
  assert.equal(applied.effectiveAllScopeCount, 1);
  assert.equal(applied.effectiveTeamScopeCount, 0);
  assert.deepEqual(applied.actorContext, {
    enabled: true,
    capabilityCount: 21,
    ownScope: true,
    allScope: true,
    teamScopeCount: 0,
  });
  assert.equal(applied.bootstrapAuditEventsWritten, 0);
  assert.deepEqual(await counts(db), { mappings: 1, capabilities: 21, scopes: 2, audits: 0 });

  const replay = await run(db, { apply: true, email: "SYNTHETIC-OWNER@EXAMPLE.INVALID" });
  assert.equal(replay.outcome, "ALREADY_BOOTSTRAPPED");
  assert.deepEqual(await counts(db), { mappings: 1, capabilities: 21, scopes: 2, audits: 0 });
  const checked = await run(db);
  assert.equal(checked.outcome, "ALREADY_BOOTSTRAPPED");
  assert.equal(checked.securityBoundaryUnchanged, true);
  assert.equal(checked.reportingBaselineUnchanged, true);
  await db.close();
});

test("failed grant insert rolls the complete bootstrap transaction back", async () => {
  const db = await database();
  await addAuthUser(db);
  await db.exec(`
    create function public.test_bootstrap_reject_grant()
    returns trigger language plpgsql as $$
    begin
      if new.capability = 'entry_restore' then
        raise exception 'synthetic grant rejection' using errcode = '23514';
      end if;
      return new;
    end
    $$;
    create trigger test_bootstrap_reject_grant
      before insert on public.direct_entry_capability_grants
      for each row execute function public.test_bootstrap_reject_grant();
  `);
  await assert.rejects(run(db, { apply: true }), { code: "BOOTSTRAP_DATABASE_ERROR" });
  assert.deepEqual(await counts(db), { mappings: 0, capabilities: 0, scopes: 0, audits: 0 });
  await db.close();
});

test("canonical capability vocabulary matches immutable schema vocabulary", async () => {
  const sql = await readFile(
    path.join(MIGRATION_DIR, "20261002170000_p1_6_direct_entry_foundation.sql"),
    "utf8",
  );
  const check = sql.match(/capability text not null check \(capability in \(([\s\S]*?)\)\)/);
  assert.ok(check, "capability CHECK constraint must exist");
  const schemaCapabilities = [...check[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.equal(CAPABILITIES.length, 21);
  assert.deepEqual([...schemaCapabilities].sort(), [...CAPABILITIES].sort());
});
