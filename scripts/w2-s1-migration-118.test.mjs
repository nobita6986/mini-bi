import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedSubmissionReadFixture } from "./lib/s04c-submission-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const MIGRATION_118 = "20261018160000_w2_s1_worker_document_staging.sql";
const MIGRATION_119 = "20261018170000_w2_s1_multi_document_stage_batch_limit.sql";
const OWNER = {
  auth_subject: "11000000-0000-4000-8000-000000000001",
  app_user_id: "21000000-0000-4000-8000-000000000001",
};

test("W2S1 migrations #118-#119 stage worker documents and allow up to four per row", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role;" +
      " create schema auth; create table auth.users (id uuid primary key);",
    );
    const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
    assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
      "migration inventory includes the #122 baseline");
    assert.equal(names.indexOf(MIGRATION_118), 117, "migration chronology remains append-only");
    assert.equal(names.indexOf(MIGRATION_119), 118, "migration chronology remains append-only");
    for (const name of names.slice(0, names.indexOf(MIGRATION_118))) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }
    await db.exec(await readFile(path.join(MIGRATION_DIR, MIGRATION_118), "utf8"));
    await db.exec(await readFile(path.join(MIGRATION_DIR, MIGRATION_119), "utf8"));

    for (const [role, expected] of [["anon", false], ["authenticated", false], ["service_role", true]]) {
      for (const signature of [
        "public.direct_entry_create_worker_document_stage_idempotent(uuid,uuid,uuid,text,text,bigint,text,text)",
        "public.direct_entry_get_worker_document_stage(uuid,uuid,uuid)",
        "public.direct_entry_complete_worker_document_stage(uuid,uuid,uuid,text,uuid,uuid)",
        "public.direct_entry_create_full_profile_batch_with_portrait_stages(uuid,uuid,text,jsonb,text,uuid[])",
      ]) {
        const { rows } = await db.query(
          "select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature],
        );
        assert.equal(rows[0].allowed, expected, `${role} privilege for ${signature}`);
      }
    }

    await seedSubmissionReadFixture({
      query: (...args) => db.query(...args),
      exec: (sql) => db.exec(sql),
    });
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
      " values ($1,'document_upload','2020-01-01')",
      [OWNER.app_user_id],
    );

    const stageId = "b8000000-0000-4000-8000-000000000118";
    const createKey = "b9000000-0000-4000-8000-000000000118";
    const created = await db.query(
      "select public.direct_entry_create_worker_document_stage_idempotent(" +
      "$1::uuid,$2::uuid,$3::uuid,'CCCD_FRONT','application/pdf',10,$4,$5) stage",
      [OWNER.auth_subject, OWNER.app_user_id, stageId, "a".repeat(64), createKey],
    );
    assert.equal(created.rows[0].stage.stage.document_type, "CCCD_FRONT");
    const read = await db.query(
      "select public.direct_entry_get_worker_document_stage($1::uuid,$2::uuid,$3::uuid) stage",
      [OWNER.auth_subject, OWNER.app_user_id, stageId],
    );
    assert.equal(read.rows[0].stage.document_type, "CCCD_FRONT");

    await assert.rejects(
      db.query(
        "select public.direct_entry_create_worker_document_stage_idempotent(" +
        "$1::uuid,$2::uuid,'b8000000-0000-4000-8000-000000000119'::uuid," +
        "'WORKER_PORTRAIT','application/pdf',10,$3,$4)",
        [OWNER.auth_subject, OWNER.app_user_id, "a".repeat(64), "b9000000-0000-4000-8000-000000000119"],
      ),
      (error) => error.code === "22023",
      "portrait stage must continue to reject PDF",
    );

    const tooMany = Array.from({ length: 401 }, (_, index) =>
      `c8000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    await assert.rejects(
      db.query(
        "select public.direct_entry_create_full_profile_batch_with_portrait_stages(" +
        "$1::uuid,$2::uuid,'worker-profile/1.1','[]'::jsonb,$3,$4::uuid[])",
        [OWNER.auth_subject, OWNER.app_user_id, "c9000000-0000-4000-8000-000000000001", tooMany],
      ),
      (error) => error.code === "22023",
      "more than four staged files for each of 100 rows must be rejected",
    );

    const fourHundred = tooMany.slice(0, 400);
    await assert.rejects(
      db.query(
        "select public.direct_entry_create_full_profile_batch_with_portrait_stages(" +
        "$1::uuid,$2::uuid,'worker-profile/1.1','[]'::jsonb,$3,$4::uuid[])",
        [OWNER.auth_subject, OWNER.app_user_id, "c9000000-0000-4000-8000-000000000002", fourHundred],
      ),
      (error) => error.code === "42501",
      "400 stage IDs pass the count guard and reach owner validation",
    );
  } finally {
    await db.close();
  }
});
