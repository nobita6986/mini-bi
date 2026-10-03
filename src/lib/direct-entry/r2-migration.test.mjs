import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(new URL("../../../supabase/migrations/20261005000000_p1_6_w04_s04b_r2a_direct_upload.sql", import.meta.url), "utf8");

test("R2A migration is forward-only, represents NOT_REQUIRED and VALIDATED, and retires the callback RPC", () => {
  assert.match(sql, /NOT_REQUIRED/);
  assert.match(sql, /validation_status/);
  assert.match(sql, /drop function if exists public\.direct_entry_apply_document_worker_callback/i);
  assert.doesNotMatch(sql, /scan_status[^;]*'CLEAN'[^;]*NOT_REQUIRED[^;]*insert/i);
});

test("every new RPC is SECURITY DEFINER with a fixed search_path and service_role-only execute", () => {
  for (const name of ["direct_entry_reserve_document_direct_upload", "direct_entry_document_direct_context", "direct_entry_finalize_document_direct_upload"]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${name}`, "i"));
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}[^;]*from public, anon, authenticated`, "i"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}[^;]*to service_role`, "i"));
  }
  assert.equal((sql.match(/security definer/gi) ?? []).length >= 3, true);
  assert.equal((sql.match(/set search_path = pg_catalog, public/gi) ?? []).length >= 3, true);
  assert.doesNotMatch(sql, /grant (?:select|insert|update|delete)[^;]*to (?:anon|authenticated|public)/i);
});

test("object sidecar keeps checksum private under forced RLS with no grants", () => {
  assert.match(sql, /alter table public\.direct_entry_document_objects force row level security/i);
  assert.match(sql, /revoke all on table public\.direct_entry_document_objects\s+from public, anon, authenticated/i);
});