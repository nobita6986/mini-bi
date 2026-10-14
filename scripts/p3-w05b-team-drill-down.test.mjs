import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APP_ALL,
  APP_TEAM,
  AUTH_ALL,
  AUTH_TEAM,
  buildDb,
  query,
  seedReportingFixture,
  uuid,
} from "./lib/p3-w05b-team-fixture.mjs";

const MIGRATION = "20261011180000_p3_w05b_a_team_reporting.sql";
const TEAM_A_BUCKET = "team." + Buffer.from("TEAM_A").toString("base64url");
const INACTIVE_BUCKET = "team." + Buffer.from("TEAM_INACTIVE").toString("base64url");
const VENDOR_BUCKET = "team." + Buffer.from("__system_vendor__").toString("base64url");

async function rpc(db, auth, app, bucket, filters = {}, cursor = null, limit = 25) {
  const rows = await query(db,
    "select public.direct_entry_reporting_team_drill_down($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text,$6::integer) as data",
    [auth, app, bucket, JSON.stringify(filters), cursor, limit]);
  return rows[0].data;
}

function sqlState(error, code) {
  return error && error.code === code;
}

test("W05B migration #85 exposes the 19-column projection, RPC and ACL", async () => {
  const { db, migrationNames } = await buildDb();
  try {
    assert.equal(migrationNames.length, 93);
    assert.equal(migrationNames.at(-8), MIGRATION);
    const columns = await query(db, "select array_to_string(array_agg(attname order by attnum), ',') as columns from pg_attribute where attrelid='public.direct_entry_reporting_facts_v01'::regclass and attnum>0 and not attisdropped");
    assert.equal(columns[0].columns, "source_id,business_date,project_key,project_display,recruiter_key,recruiter_display,provider_type_key,provider_type_display,employment_type_key,employment_type_display,recruited_count,first_work_date,entry_id,submission_id,cutoff_date,team_id,team_code,team_display_name,team_active");
    const acl = await query(db, "select has_function_privilege('service_role',$1::regprocedure,'execute') as service_exec, has_function_privilege('anon',$1::regprocedure,'execute') as anon_exec, has_function_privilege('authenticated',$1::regprocedure,'execute') as auth_exec", ["public.direct_entry_reporting_team_drill_down(uuid,uuid,text,jsonb,text,integer)"]);
    assert.deepEqual(acl[0], { service_exec: true, anon_exec: false, auth_exec: false });
    const view = await query(db, "select pg_get_viewdef('public.direct_entry_reporting_facts_v01'::regclass,true) as definition");
    assert.match(view[0].definition, /direct_entry_reporting_employment_display/);
    assert.doesNotMatch(view[0].definition, /CASE e\.labor_type/i);
    const options = await query(db, "select pg_get_viewdef('public.direct_entry_reporting_dimension_options_v01'::regclass,true) as definition");
    assert.doesNotMatch(options[0].definition, /'team'/i);
  } finally {
    await db.close();
  }
});

test("W05B known-team drill-down pages facts with exact seven-field rows", async () => {
  const { db } = await buildDb();
  try {
    await seedReportingFixture(db);
    const first = await rpc(db, AUTH_ALL, APP_ALL, TEAM_A_BUCKET, {}, null, 1);
    assert.equal(first.bucket.key, TEAM_A_BUCKET);
    assert.equal(first.bucket.display, "Team A");
    assert.equal(first.total, 2);
    assert.equal(first.rows.length, 1);
    assert.deepEqual(Object.keys(first.rows[0]).sort(), [
      "business_date", "employment_type_display", "first_work_date", "project_display",
      "provider_type_display", "recruited_count", "recruiter_display",
    ]);
    assert.equal(typeof first.nextCursor, "string");
    const second = await rpc(db, AUTH_ALL, APP_ALL, TEAM_A_BUCKET, {}, first.nextCursor, 1);
    assert.equal(second.rows.length, 1);
    assert.equal(second.total, 2);
    assert.equal(second.nextCursor, null);
    assert.notEqual(first.rows[0].business_date, second.rows[0].business_date);
  } finally {
    await db.close();
  }
});

test("W05B inactive, Vendor and Unknown buckets preserve attribution and I-5", async () => {
  const { db } = await buildDb();
  try {
    await seedReportingFixture(db);
    const inactive = await rpc(db, AUTH_ALL, APP_ALL, INACTIVE_BUCKET);
    assert.equal(inactive.bucket.display, "Inactive Team (Đã ngừng hoạt động)");
    assert.equal(inactive.total, 1);
    assert.equal(inactive.rows[0].project_display, "Project A");

    const vendor = await rpc(db, AUTH_ALL, APP_ALL, VENDOR_BUCKET);
    assert.equal(vendor.bucket.display, "Vendor");
    assert.equal(vendor.total, 0);
    assert.deepEqual(vendor.rows, []);

    const unknown = await rpc(db, AUTH_ALL, APP_ALL, "unknown");
    assert.equal(unknown.total, 1);
    assert.equal(unknown.legacy_aggregate_total.recruited_count, 7);
    assert.equal(unknown.legacy_aggregate_total.recruited_count + unknown.total, 8);
    assert.equal(unknown.rows.length, 1);
    assert.equal(Object.keys(unknown.rows[0]).includes("team_active"), false);
  } finally {
    await db.close();
  }
});

test("W05B re-resolves all audience and rejects invalid drill-down input", async () => {
  const { db } = await buildDb();
  try {
    await seedReportingFixture(db);
    await assert.rejects(() => rpc(db, AUTH_TEAM, APP_TEAM, TEAM_A_BUCKET), (error) => sqlState(error, "42501"));
    await assert.rejects(() => rpc(db, AUTH_ALL, APP_ALL, "__unknown__"), (error) => sqlState(error, "22023"));
    await assert.rejects(() => rpc(db, AUTH_ALL, APP_ALL, TEAM_A_BUCKET, { source: uuid(900) }), (error) => sqlState(error, "22023"));
    await assert.rejects(() => rpc(db, AUTH_ALL, APP_ALL, TEAM_A_BUCKET, {}, null, 101), (error) => sqlState(error, "22023"));
    await assert.rejects(() => rpc(db, AUTH_ALL, APP_ALL, TEAM_A_BUCKET, {}, "not-a-cursor", 25), (error) => sqlState(error, "22023"));

    await db.query("insert into public.teams(team_id,code,display_name,active) values ($1,'__unknown__','Sentinel Team',true),($2,'unknown','Plain Unknown Team',true)", [uuid(901), uuid(902)]);
    const sentinel = await rpc(db, AUTH_ALL, APP_ALL, "team." + Buffer.from("__unknown__").toString("base64url"));
    const plain = await rpc(db, AUTH_ALL, APP_ALL, "team." + Buffer.from("unknown").toString("base64url"));
    assert.equal(sentinel.bucket.display, "Sentinel Team");
    assert.equal(plain.bucket.display, "Plain Unknown Team");

    const wideCode = "🦄".repeat(128);
    await db.query("insert into public.teams(team_id,code,display_name,active) values ($1,$2,'Wide Team',true)", [uuid(903), wideCode]);
    const wide = await rpc(db, AUTH_ALL, APP_ALL, "team." + Buffer.from(wideCode).toString("base64url"));
    assert.equal(wide.bucket.display, "Wide Team");
    await assert.rejects(
      rpc(db, AUTH_ALL, APP_ALL, "team." + Buffer.from("🦄".repeat(129)).toString("base64url")),
      (error) => sqlState(error, "22023"),
    );
  } finally {
    await db.close();
  }
});
