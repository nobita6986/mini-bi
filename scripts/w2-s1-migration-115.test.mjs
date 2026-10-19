import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const MIGRATION_114 = "20261018110000_w2_s1_portrait_stage_recovery_cccd_scope.sql";
const MIGRATION_115 = "20261018130000_w2_s1_portrait_stage_create_idempotency.sql";

test("migration #115 appends portrait-stage create idempotency without changing prior migrations", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role;" +
      " create schema auth; create table auth.users (id uuid primary key);",
    );
    const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
    assert.equal(names.length, 121);
    assert.equal(names.at(-7), MIGRATION_115);
    assert.equal(names.at(-8), MIGRATION_114);
    for (const name of names.slice(0, -7)) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }
    await db.exec(await readFile(path.join(MIGRATION_DIR, MIGRATION_115), "utf8"));

    const stageFunction =
      "public.direct_entry_create_worker_portrait_stage_idempotent(uuid,uuid,uuid,text,bigint,text,text)";
    const { rows: privileges } = await db.query(
      "select p.prosecdef," +
      " has_function_privilege('anon',p.oid,'EXECUTE') anon_exec," +
      " has_function_privilege('authenticated',p.oid,'EXECUTE') auth_exec," +
      " has_function_privilege('service_role',p.oid,'EXECUTE') service_exec" +
      " from pg_proc p where p.oid=$1::regprocedure",
      [stageFunction],
    );
    assert.deepEqual(privileges[0], {
      prosecdef: true, anon_exec: false, auth_exec: false, service_exec: true,
    });

    const { rows: oldFunctionPrivileges } = await db.query(
      "select has_function_privilege('service_role',p.oid,'EXECUTE') service_exec" +
      " from pg_proc p where p.oid=" +
      "'public.direct_entry_create_worker_portrait_stage(uuid,uuid,uuid,text,bigint,text)'::regprocedure",
    );
    assert.equal(oldFunctionPrivileges[0].service_exec, false,
      "the non-idempotent RPC is no longer executable by the API service role");
    const { rows: index } = await db.query(
      "select indexdef from pg_indexes where schemaname='public'" +
      " and indexname='direct_entry_worker_portrait_stages_create_key_uq'",
    );
    assert.match(index[0].indexdef, /created_by_user_id, create_idempotency_key/);
    assert.match(index[0].indexdef, /WHERE \(create_idempotency_key IS NOT NULL\)/i);
  } finally {
    await db.close();
  }
});
