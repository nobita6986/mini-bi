import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTORS,
  createMigratedDatabase,
  seedSubmissionReadFixture,
} from "./lib/s04c-submission-read-fixture.mjs";

const migrations = await createMigratedDatabase();
const db = migrations.db;
const fixture = await seedSubmissionReadFixture(db);
const entryId = fixture.draft.entryIds[0];
const privileged = {
  auth_subject: "11000000-0000-4000-8000-000000000006",
  app_user_id: "21000000-0000-4000-8000-000000000006",
};

await db.query("insert into auth.users(id) values ($1)", [privileged.auth_subject]);
await db.query(
  "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name)" +
  " values ($1,$2,true,'Synthetic Privileged Actor')",
  [privileged.app_user_id, privileged.auth_subject],
);
await db.query(
  "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
  " values ($1,'entry_privileged_edit','2020-01-01')",
  [privileged.app_user_id],
);
await db.query(
  "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from)" +
  " values ($1,'all','2020-01-01')",
  [privileged.app_user_id],
);

test("migration 111 appends to the verified ledger and keeps its security boundaries", async () => {
  assert.equal(migrations.migrationNames.length, 111);
  assert.equal(migrations.migrationNames.at(-1),
    "20261017100000_pre_w2_s1_worker_portrait_private_projection.sql");
  for (const role of ["anon", "authenticated", "service_role"]) {
    const { rows } = await db.query(
      "select has_table_privilege($1,'public.direct_entry_candidates','UPDATE') allowed",
      [role],
    );
    assert.equal(rows[0].allowed, false, `${role} cannot change portrait origin`);
  }
  const { rows } = await db.query(
    "select p.prosecdef, has_function_privilege('anon',p.oid,'EXECUTE') anon_exec," +
    " has_function_privilege('authenticated',p.oid,'EXECUTE') auth_exec," +
    " has_function_privilege('service_role',p.oid,'EXECUTE') service_exec" +
    " from pg_proc p where p.oid=" +
    "'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure",
  );
  assert.deepEqual(rows[0], {
    prosecdef: true, anon_exec: false, auth_exec: false, service_exec: true,
  });
});

test("privileged edit scope reads the entry while an actor outside scope is denied", async () => {
  const allowed = await db.query(
    "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) data",
    [privileged.auth_subject, privileged.app_user_id, entryId],
  );
  assert.equal(allowed.rows[0].data.entry_id, entryId);
  assert.equal(allowed.rows[0].data.scope_kind, "all");

  await assert.rejects(db.query(
    "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid)",
    [ACTORS.otherOwner.auth_subject, ACTORS.otherOwner.app_user_id, entryId],
  ), (error) => error.code === "42501");
});

test("portrait upload uses the existing reservation/finalize lifecycle and snapshots current version", async () => {
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
    " values ($1,'document_upload','2020-01-01'),($1,'document_view','2020-01-01')",
    [ACTORS.owner.app_user_id],
  );
  const { rows: entryRows } = await db.query(
    "select version from public.direct_entries where entry_id=$1",
    [entryId],
  );
  const reserved = await db.query(
    "select public.direct_entry_reserve_document_direct_upload(" +
    "$1::uuid,$2::uuid,$3::uuid,$4::integer,'WORKER_PORTRAIT'," +
    "'w2s1-portrait-reserve',512,'image/jpeg',null) data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId, entryRows[0].version],
  );
  const reservation = reserved.rows[0].data;
  assert.equal(reservation.upload_status, "QUEUED");
  assert.match(reservation.storage_key, /\/WORKER_PORTRAIT\/1\//);

  const finalized = await db.query(
    "select public.direct_entry_finalize_document_direct_upload(" +
    "$1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::integer," +
    "'w2s1-portrait-finalize','validated',$6,256,'image/jpeg') data",
    [
      ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId,
      reservation.document_id, reservation.entry_version, "a".repeat(64),
    ],
  );
  assert.equal(finalized.rows[0].data.upload_status, "READY");

  const context = await db.query(
    "select public.direct_entry_document_direct_context(" +
    "$1::uuid,$2::uuid,$3::uuid,$4::uuid,'preview') data",
    [
      ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId, reservation.document_id,
    ],
  );
  assert.equal(context.rows[0].data.document_type, "WORKER_PORTRAIT");
  assert.equal(context.rows[0].data.size_bytes, 256);
  assert.equal(context.rows[0].data.checksum_sha256, "a".repeat(64));

  const projection = await db.query(
    "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId],
  );
  assert.deepEqual(projection.rows[0].data.worker_portrait, {
    origin: "ENROLLMENT",
    added_at: null,
    status: "READY",
    current: {
      document_id: reservation.document_id,
      version: 1,
      checksum_sha256: "a".repeat(64),
      mime_type: "image/jpeg",
      size_bytes: 256,
    },
  });
  assert.equal(
    projection.rows[0].data.documents.some(({ document_type }) =>
      document_type === "WORKER_PORTRAIT"),
    false,
  );

  const { rows: revisions } = await db.query(
    "select after_snapshot from public.direct_entry_revisions" +
    " where entry_id=$1 order by version desc limit 1",
    [entryId],
  );
  assert.deepEqual(revisions[0].after_snapshot.worker_portrait, {
    origin: "ENROLLMENT",
    added_at: null,
    current: {
      document_id: reservation.document_id,
      version: 1,
      checksum_sha256: "a".repeat(64),
      mime_type: "image/jpeg",
      size_bytes: 256,
    },
  });
});
