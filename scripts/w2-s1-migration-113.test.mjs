import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const MIGRATION_113 = "20261018090000_w2_s1_worker_portrait_enrollment_staging.sql";
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";
const CLAIM_NAME = "public.direct_entry_claim_worker_portrait_stage";
const CLAIM_SIGNATURE = CLAIM_NAME + "(uuid,uuid,uuid,text)";

test("migration #113 is append-only, service-only and transactionally rolls back on drift", async () => {
  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
    const migrationIndex = names.indexOf(MIGRATION_113);
    assert.equal(names.length, 121);
    assert.equal(names[migrationIndex + 1], "20261018110000_w2_s1_portrait_stage_recovery_cccd_scope.sql");
    assert.equal(names[migrationIndex - 1], "20261017110000_pre_w2_s1_document_direct_context_access_guard.sql");
    for (const name of names.slice(0, migrationIndex)) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    await db.exec(
      "create function " + CLAIM_NAME +
      "(p_auth_subject uuid,p_app_user_id uuid,p_stage_id uuid,p_idempotency_key text)" +
      " returns jsonb language sql as $$ select '{}'::jsonb $$",
    );
    await assert.rejects(
      db.exec(await readFile(path.join(MIGRATION_DIR, MIGRATION_113), "utf8")),
    );
    await db.exec("rollback");
    const rolledBack = await db.query(
      "select to_regclass('public.direct_entry_worker_portrait_stages') relation",
    );
    assert.equal(rolledBack.rows[0].relation, null,
      "a failed append leaves no stage table behind");
    await db.exec("drop function " + CLAIM_SIGNATURE);
    await db.exec(await readFile(path.join(MIGRATION_DIR, MIGRATION_113), "utf8"));

    const { rows } = await db.query(
      "select p.prosecdef," +
      " has_function_privilege('anon',p.oid,'EXECUTE') anon_exec," +
      " has_function_privilege('authenticated',p.oid,'EXECUTE') auth_exec," +
      " has_function_privilege('service_role',p.oid,'EXECUTE') service_exec" +
      " from pg_proc p where p.oid=$1::regprocedure",
      [CLAIM_SIGNATURE],
    );
    assert.deepEqual(rows[0], {
      prosecdef: true, anon_exec: false, auth_exec: false, service_exec: true,
    });
    for (const role of ["anon", "authenticated", "service_role"]) {
      const tablePrivilege = await db.query(
        "select has_table_privilege($1,'public.direct_entry_worker_portrait_stages','SELECT') allowed",
        [role],
      );
      assert.equal(tablePrivilege.rows[0].allowed, false);
    }
  } finally {
    await db.close();
  }
});
