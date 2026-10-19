import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const MIGRATION_111 = "20261017100000_pre_w2_s1_worker_portrait_private_projection.sql";
const MIGRATION_112 = "20261017110000_pre_w2_s1_document_direct_context_access_guard.sql";
const LEGACY = `    v_scope := public.direct_entry_resolve_submission_read_scope(
      p_auth_subject, p_app_user_id, v_entry.entry_id
    );
    if v_scope is null then
      v_scope := public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'entry_privileged_edit',
        v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
      );
    end if;`;
const GUARDED = `    if p_purpose = 'download' then
      perform public.direct_entry_assert_draft_access(
        p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date
      );
    else
      select * into v_document from public.direct_entry_document_versions d
       where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
      if not found then
        raise exception 'document not found' using errcode = 'P0002';
      end if;
      if v_document.document_type <> 'WORKER_PORTRAIT' then
        raise exception 'private preview is portrait-only' using errcode = 'P0002';
      end if;
      v_scope := public.direct_entry_resolve_submission_read_scope(
        p_auth_subject, p_app_user_id, v_entry.entry_id
      );
      if v_scope is null then
        v_scope := public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'entry_privileged_edit',
          v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
        );
      end if;
    end if;`;

test("migration #112 repairs the previously published #111 function offline", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role;" +
      " create schema auth; create table auth.users (id uuid primary key);",
    );
    const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
    assert.equal(names.length, 121, "the current repository ledger includes append-only migrations #113 through #121");
    assert.equal(names[names.indexOf(MIGRATION_112) - 1], MIGRATION_111,
      "#111 remains unchanged immediately before #112");
    assert.equal(names[names.indexOf(MIGRATION_112)], MIGRATION_112,
      "#112 remains in its original ledger slot");

    for (const name of names.slice(0, names.indexOf(MIGRATION_112))) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    const signature = "public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)";
    const { rows } = await db.query("select pg_get_functiondef($1::regprocedure) definition", [signature]);
    assert.equal(rows[0].definition.split(GUARDED).length - 1, 1,
      "#111 defines the authorization block to restore");
    await db.exec(rows[0].definition.replace(GUARDED, LEGACY));

    await db.exec(await readFile(path.join(MIGRATION_DIR, MIGRATION_112), "utf8"));
    const repaired = (await db.query(
      "select pg_get_functiondef($1::regprocedure) definition", [signature],
    )).rows[0].definition;
    assert.match(
      repaired,
      /if p_purpose = 'download' then\s+perform public\.direct_entry_assert_draft_access[\s\S]*?else[\s\S]*?v_document\.document_type <> 'WORKER_PORTRAIT'[\s\S]*?direct_entry_resolve_submission_read_scope[\s\S]*?entry_privileged_edit/,
      "#112 keeps download draft-guarded and portrait preview scope-guarded",
    );
    assert.doesNotMatch(
      repaired,
      /else\s+v_scope := public\.direct_entry_resolve_submission_read_scope/,
      "the published broad scope fallback is no longer unconditional",
    );
  } finally {
    await db.close();
  }
});

test("migration #112 rolls back when the document context source has drifted", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role;" +
      " create schema auth; create table auth.users (id uuid primary key);",
    );
    const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
    for (const name of names.slice(0, names.indexOf(MIGRATION_112))) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    const signature = "public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)";
    const { rows } = await db.query("select pg_get_functiondef($1::regprocedure) definition", [signature]);
    const drifted = rows[0].definition
      .replace("if p_purpose = 'download' then", "if p_purpose = 'download_v2' then")
      .replace("'entry_privileged_edit'", "'entry_privileged_edit_v2'");
    assert.notEqual(drifted, rows[0].definition, "the fixture introduces an unsupported source change");
    await db.exec(drifted);

    await assert.rejects(
      db.exec(await readFile(path.join(MIGRATION_DIR, MIGRATION_112), "utf8")),
      (error) => error.code === "55000",
    );
    await db.exec("rollback");

    const afterRollback = (await db.query(
      "select pg_get_functiondef($1::regprocedure) definition", [signature],
    )).rows[0].definition;
    assert.equal(afterRollback, drifted, "failed migration leaves the pre-migration function unchanged");
  } finally {
    await db.close();
  }
});
