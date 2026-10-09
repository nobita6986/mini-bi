import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./personnel-catalog-manager.tsx", import.meta.url), "utf8");

test("Personnel UI calls only canonical W01B list, create, update, active and detail APIs", () => {
  assert.match(source, /fetch\(`\/api\/admin\/catalog\/personnel\?\$\{listQuery\.toString\(\)\}`/);
  assert.match(source, /url:\s*"\/api\/admin\/catalog\/personnel"/);
  assert.match(source, /method:\s*"PATCH"/);
  assert.match(source, /\/api\/admin\/catalog\/personnel\/\$\{encodeURIComponent\(dialog\.personnel\.recruiter_id\)\}\/active/);
  assert.match(source, /\/api\/admin\/catalog\/personnel\/\$\{encodeURIComponent\(intent\.recruiterId\)\}/);
  assert.doesNotMatch(source, /supabase|\.rpc\(|createClient\(/i);
});

test("strict response projection, page size and retry reuse are wired in the component", () => {
  assert.match(source, /buildPersonnelListQuery/);
  assert.match(source, /projectPersonnelListForQuery\(await response\.json\(\)/);
  assert.match(source, /projectPersonnelItem\(await response\.json\(\)\)/);
  assert.match(source, /setPendingIntent\(\{\s*\.\.\.intent,\s*retryState:\s*"retry"\s*\}\)/);
  assert.match(source, /sendIntent\(pendingIntent\)/);
  assert.match(source, /newPersonnelIntentKey\(\)/);
  assert.match(source, /buildPersonnelListQuery\(\{ search, includeInactive, page \}\)/);
});

test("loading, denied, unavailable, empty, error and conflict are separate accessible states", () => {
  for (const token of ["loading", "denied", "unavailable", "error"]) {
    assert.match(source, new RegExp(`kind === "${token}"`));
  }
  assert.match(source, /<EmptyState/);
  assert.match(source, /ConflictReload/);
  assert.match(source, /setPersonnelConflictLock/);
  assert.match(source, /role="status"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /<table/);
});
