import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const MIGRATION_114 = "20261018110000_w2_s1_portrait_stage_recovery_cccd_scope.sql";
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";
async function applyBefore114(db) {
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.equal(names.at(-6), MIGRATION_114);
  assert.equal(names.length, 119);
  const migrationIndex = names.indexOf(MIGRATION_114);
  for (const name of names.slice(0, migrationIndex)) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

test("migration #114 appends, narrows upload capability and adds service-only recovery", async () => {
  const db = new PGlite();
  try {
    await applyBefore114(db);
    await db.exec(await readFile(path.join(MIGRATION_DIR, MIGRATION_114), "utf8"));

    const { rows: count } = await db.query(
      "select count(*)::integer count from pg_proc p join pg_namespace n on n.oid=p.pronamespace" +
      " where n.nspname='public' and p.proname='direct_entry_recover_worker_portrait_stage'",
    );
    assert.equal(count[0].count, 1);
    for (const [name, signature] of [
      ["direct_entry_recover_worker_portrait_stage", "(uuid,uuid,uuid)"],
      ["direct_entry_create_full_profile_batch_with_portrait_stages", "(uuid,uuid,text,jsonb,text,uuid[])"],
    ]) {
      const { rows } = await db.query(
        "select has_function_privilege('anon',p.oid,'EXECUTE') anon_exec," +
        " has_function_privilege('authenticated',p.oid,'EXECUTE') auth_exec," +
        " has_function_privilege('service_role',p.oid,'EXECUTE') service_exec" +
        " from pg_proc p where p.oid=('public.' || $1 || $2)::regprocedure",
        [name, signature],
      );
      assert.deepEqual(rows[0], {
        anon_exec: false, auth_exec: false, service_exec: true,
      });
    }
    for (const [name, signature] of [
      ["direct_entry_create_worker_portrait_stage", "(uuid,uuid,uuid,text,bigint,text)"],
      ["direct_entry_claim_worker_portrait_stage", "(uuid,uuid,uuid,text)"],
    ]) {
      const { rows } = await db.query(
        "select pg_get_functiondef(p.oid) definition from pg_proc p" +
        " where p.oid=('public.' || $1 || $2)::regprocedure",
        [name, signature],
      );
      assert.match(rows[0].definition, /g\.capability = 'document_upload'/);
      assert.doesNotMatch(rows[0].definition, /change_request_create/);
    }
    const { rows: directContext } = await db.query(
      "select pg_get_functiondef(" +
      "'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure) definition",
    );
    assert.match(directContext[0].definition, /p_purpose = 'cccd_preview'/);
    assert.match(directContext[0].definition, /'document_view'/);
    assert.match(directContext[0].definition, /p_purpose = 'download'/);
  } finally {
    await db.close();
  }
});

test("migration #114 rolls back completely on source drift and leaves the session usable", async () => {
  const db = new PGlite();
  try {
    await applyBefore114(db);
    await db.exec(
      "create or replace function public.direct_entry_create_worker_portrait_stage" +
      "(p_auth_subject uuid,p_app_user_id uuid,p_stage_id uuid,p_mime_type text," +
      "p_size_bytes bigint,p_checksum_sha256 text) returns jsonb language sql as $$" +
      "select '{}'::jsonb $$",
    );
    await assert.rejects(
      db.exec(await readFile(path.join(MIGRATION_DIR, MIGRATION_114), "utf8")),
      (error) => error.code === "55000",
      "unexpected source shape must fail closed",
    );
    await db.exec("rollback");
    const { rows } = await db.query(
      "select to_regprocedure(" +
      "'public.direct_entry_w2s1_r2_replace_function_source(regprocedure,text,text,integer)')" +
      " helper, to_regprocedure(" +
      "'public.direct_entry_recover_worker_portrait_stage(uuid,uuid,uuid)') recovery",
    );
    assert.deepEqual(rows[0], { helper: null, recovery: null });
    assert.equal((await db.query("select 1 value")).rows[0].value, 1);
  } finally {
    await db.close();
  }
});
