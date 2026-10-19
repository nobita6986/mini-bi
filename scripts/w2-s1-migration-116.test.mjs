import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedSubmissionReadFixture } from "./lib/s04c-submission-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const MIGRATION_115 = "20261018130000_w2_s1_portrait_stage_create_idempotency.sql";
const MIGRATION_116 = "20261018140000_w2_s1_portrait_stage_ttl_reaper.sql";
const OWNER = {
  auth_subject: "11000000-0000-4000-8000-000000000001",
  app_user_id: "21000000-0000-4000-8000-000000000001",
};
const CHECKSUM = "a".repeat(64);

test("migration #116 expires only STAGED older than 24h and leases cleanup retries", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role;" +
      " create schema auth; create table auth.users (id uuid primary key);",
    );
    const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
    assert.equal(names.length, 119);
    assert.equal(names.at(-4), MIGRATION_116);
    assert.equal(names.at(-5), MIGRATION_115);
    for (const name of names.slice(0, -4)) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }
    await db.exec(await readFile(path.join(MIGRATION_DIR, MIGRATION_116), "utf8"));
    for (const [role, expected] of [
      ["anon", false],
      ["authenticated", false],
      ["service_role", true],
    ]) {
      const { rows } = await db.query(
        "select has_function_privilege($1," +
        "'public.direct_entry_claim_expired_worker_portrait_stage_cleanup(uuid,integer)'," +
        "'EXECUTE') allowed",
        [role],
      );
      assert.equal(rows[0].allowed, expected, `${role} cleanup claim privilege`);
      const completion = await db.query(
        "select has_function_privilege($1," +
        "'public.direct_entry_complete_worker_portrait_stage_cleanup(uuid,uuid)'," +
        "'EXECUTE') allowed",
        [role],
      );
      assert.equal(completion.rows[0].allowed, expected, `${role} cleanup completion privilege`);
    }
    await assert.rejects(
      db.query(
        "select public.direct_entry_claim_expired_worker_portrait_stage_cleanup($1::uuid,null)",
        ["d9000000-0000-4000-8000-000000000000"],
      ),
      (error) => error.code === "22023",
    );

    await seedSubmissionReadFixture({
      query: (...args) => db.query(...args),
      exec: (sql) => db.exec(sql),
    });
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
      " values ($1,'document_upload','2020-01-01')",
      [OWNER.app_user_id],
    );

    const expiredId = "b8000000-0000-4000-8000-000000000011";
    const freshId = "b8000000-0000-4000-8000-000000000012";
    const claimedId = "b8000000-0000-4000-8000-000000000013";
    for (const [stageId, key] of [
      [expiredId, "b9000000-0000-4000-8000-000000000011"],
      [freshId, "b9000000-0000-4000-8000-000000000012"],
      [claimedId, "b9000000-0000-4000-8000-000000000013"],
    ]) {
      await db.query(
        "select public.direct_entry_create_worker_portrait_stage_idempotent(" +
        "$1::uuid,$2::uuid,$3::uuid,'image/jpeg',256,$4,$5)",
        [OWNER.auth_subject, OWNER.app_user_id, stageId, CHECKSUM, key],
      );
    }
    await db.query(
      "update public.direct_entry_worker_portrait_stages set created_at = case stage_id" +
      " when $1::uuid then clock_timestamp() - interval '24 hours 1 second'" +
      " when $2::uuid then clock_timestamp() - interval '24 hours' + interval '1 second'" +
      " when $3::uuid then clock_timestamp() - interval '48 hours' end" +
      " where stage_id = any($4::uuid[])",
      [expiredId, freshId, claimedId, [expiredId, freshId, claimedId]],
    );
    const claimKey = "c9000000-0000-4000-8000-000000000013";
    await db.query(
      "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,$4)",
      [OWNER.auth_subject, OWNER.app_user_id, claimedId, claimKey],
    );

    const leaseA = "d9000000-0000-4000-8000-000000000001";
    const { rows: [claimed] } = await db.query(
      "select public.direct_entry_claim_expired_worker_portrait_stage_cleanup($1::uuid,10) ids",
      [leaseA],
    );
    assert.deepEqual(claimed.ids, [expiredId],
      "only the STAGED row older than 24 hours is eligible");
    const { rows: states } = await db.query(
      "select stage_id,status,cleanup_attempts,cleanup_claim_token,cleanup_completed_at" +
      " from public.direct_entry_worker_portrait_stages where stage_id = any($1::uuid[])" +
      " order by stage_id",
      [[expiredId, freshId, claimedId]],
    );
    const byId = new Map(states.map((row) => [row.stage_id, row]));
    assert.equal(byId.get(expiredId).status, "CANCELLED");
    assert.equal(byId.get(expiredId).cleanup_claim_token, leaseA);
    assert.equal(byId.get(expiredId).cleanup_attempts, 1);
    assert.equal(byId.get(freshId).status, "STAGED");
    assert.equal(byId.get(claimedId).status, "CLAIMED",
      "the reaper never claims or releases a batch-claimed stage");

    const wrongOwner = await db.query(
      "select public.direct_entry_complete_worker_portrait_stage_cleanup($1::uuid,$2::uuid) done",
      [expiredId, "d9000000-0000-4000-8000-000000000099"],
    );
    assert.equal(wrongOwner.rows[0].done, false);

    await db.query(
      "update public.direct_entry_worker_portrait_stages" +
      " set cleanup_lease_until = clock_timestamp() - interval '1 second'" +
      " where stage_id = $1::uuid",
      [expiredId],
    );
    const leaseB = "d9000000-0000-4000-8000-000000000002";
    const { rows: [retried] } = await db.query(
      "select public.direct_entry_claim_expired_worker_portrait_stage_cleanup($1::uuid,10) ids",
      [leaseB],
    );
    assert.deepEqual(retried.ids, [expiredId],
      "a failed delete is available again after its lease expires");
    assert.equal((await db.query(
      "select cleanup_attempts from public.direct_entry_worker_portrait_stages where stage_id=$1",
      [expiredId],
    )).rows[0].cleanup_attempts, 2);

    const done = await db.query(
      "select public.direct_entry_complete_worker_portrait_stage_cleanup($1::uuid,$2::uuid) done",
      [expiredId, leaseB],
    );
    assert.equal(done.rows[0].done, true);
    assert.deepEqual((await db.query(
      "select public.direct_entry_claim_expired_worker_portrait_stage_cleanup($1::uuid,10) ids",
      ["d9000000-0000-4000-8000-000000000003"],
    )).rows[0].ids, [], "completed cleanup is not returned again");
  } finally {
    await db.close();
  }
});
