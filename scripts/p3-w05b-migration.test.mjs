import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const MIGRATION = path.resolve("supabase/migrations/20261011180000_p3_w05b_a_team_reporting.sql");
const MIGRATION_DIR = path.resolve("supabase/migrations");
const FILTER_SOURCE = path.resolve("src/lib/reporting/p1-filter.ts");

 test("W05B migration is one append-only patch-live migration with fail-closed drift guards", async () => {
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.equal(names.length, 120);
  assert.equal(names.at(-(35 + 1)), "20261011180000_p3_w05b_a_team_reporting.sql");
  const source = await readFile(MIGRATION, "utf8");
  assert.match(source, /pg_get_viewdef/);
  assert.match(source, /pg_get_functiondef/);
  assert.match(source, /p_expected_count/);
  assert.match(source, /using errcode = '55000'/);
  assert.match(source, /drop function public\.direct_entry_w05b_replace_view_source/);
  assert.match(source, /drop function public\.direct_entry_w05b_replace_proc_source/);
  assert.match(source, /team_id,team_code,team_display_name,team_active/);
  assert.match(source, /direct_entry_reporting_employment_display/);
  assert.match(source, /direct_entry_reporting_team_drill_down/);
  assert.match(source, /service_role/);
  const filterSource = await readFile(FILTER_SOURCE, "utf8");
  assert.doesNotMatch(filterSource, /team_active|bucket_key|cursor|limit/);
});

test("W05B migration keeps the shared options path untouched", async () => {
  const source = await readFile(MIGRATION, "utf8");
  assert.doesNotMatch(source, /create or replace function public\.direct_entry_reporting_scoped_options/);
  assert.doesNotMatch(source, /create or replace view public\.direct_entry_reporting_dimension_options_v01/);
  assert.doesNotMatch(source, /create or replace view public\.reporting_dimension_options_v01/);
});
