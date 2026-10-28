import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_NAME = "20261028100000_hf_postgrest_conflict_sqlstate_pt409.sql";
const MIGRATION_DIR = path.resolve("supabase/migrations");
const APP_CONFLICT = "errcode[[:space:]]*=[[:space:]]*'40001'";

test("PT409 migration rewrites app conflicts without changing function security metadata", async () => {
  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
    const migrationIndex = names.indexOf(MIGRATION_NAME);
    assert.notEqual(migrationIndex, -1, "forward migration exists");

    for (const name of names.slice(0, migrationIndex)) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    const { rows: before } = await db.query(
      `select p.oid, p.proowner, p.proacl, p.prosecdef, p.proconfig
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         join pg_catalog.pg_language l on l.oid = p.prolang
        where n.nspname = 'public' and l.lanname = 'plpgsql'
          and p.prosrc ~* $1
        order by p.oid`,
      [APP_CONFLICT],
    );
    assert.ok(before.length >= 50, `expected broad active coverage, found ${before.length} functions`);

    await db.exec(`
      create function public.postgrest_conflict_sqlstate_test_probe()
      returns void language plpgsql as $$
      begin
        raise exception using errcode = '40001', message = 'test version conflict';
      end
      $$;
      grant execute on function public.postgrest_conflict_sqlstate_test_probe() to service_role;
    `);
    const { rows: probeBefore } = await db.query(
      `select oid, proowner, proacl, prosecdef, proconfig
         from pg_catalog.pg_proc
        where oid = 'public.postgrest_conflict_sqlstate_test_probe()'::regprocedure`,
    );
    await db.query(`
      create temporary table conflict_function_snapshot (
        oid oid primary key,
        proowner oid,
        proacl aclitem[],
        prosecdef boolean,
        proconfig text[]
      )
    `);
    await db.query(
      `insert into conflict_function_snapshot (oid, proowner, proacl, prosecdef, proconfig)
       select oid, proowner, proacl, prosecdef, proconfig from unnest($1::oid[]) as f(oid)
       join pg_catalog.pg_proc p using (oid)`,
      [before.map((row) => row.oid)],
    );
    await db.query(
      `insert into conflict_function_snapshot (oid, proowner, proacl, prosecdef, proconfig)
       values ($1, $2, $3, $4, $5)`,
      [probeBefore[0].oid, probeBefore[0].proowner, probeBefore[0].proacl, probeBefore[0].prosecdef, probeBefore[0].proconfig],
    );

    await db.exec(await readFile(path.join(MIGRATION_DIR, MIGRATION_NAME), "utf8"));

    const { rows: remaining } = await db.query(
      `select count(*)::int as count
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         join pg_catalog.pg_language l on l.oid = p.prolang
        where n.nspname = 'public' and l.lanname = 'plpgsql' and p.prosrc ~* $1`,
      [APP_CONFLICT],
    );
    assert.equal(remaining[0].count, 0, "no public function retains app-raised 40001");

    const { rows: metadata } = await db.query(`
      select count(*)::int as total,
             count(*) filter (where p.oid is null)::int as missing,
             count(*) filter (where p.prosrc !~* 'errcode[[:space:]]*=[[:space:]]*''PT409''')::int as not_rewritten,
             count(*) filter (where p.proowner is distinct from s.proowner
               or p.proacl is distinct from s.proacl
               or p.prosecdef is distinct from s.prosecdef
               or p.proconfig is distinct from s.proconfig)::int as security_metadata_changed
        from conflict_function_snapshot s
        left join pg_catalog.pg_proc p on p.oid = s.oid
    `);
    assert.equal(metadata[0].total, before.length + 1);
    assert.equal(metadata[0].missing, 0);
    assert.equal(metadata[0].not_rewritten, 0);
    assert.equal(metadata[0].security_metadata_changed, 0);

    await assert.rejects(
      () => db.query("select public.postgrest_conflict_sqlstate_test_probe()"),
      (error) => error.code === "PT409",
    );
  } finally {
    await db.close();
  }
});
