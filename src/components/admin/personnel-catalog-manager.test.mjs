import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./personnel-catalog-manager.tsx", import.meta.url), "utf8");

test("Personnel UI calls the account-driven create plus canonical list/update/active/detail APIs", () => {
  assert.match(source, /fetch\(`\/api\/admin\/catalog\/personnel\?\$\{listQuery\.toString\(\)\}`/);
  assert.match(source, /url:\s*"\/api\/admin\/catalog\/personnel\/from-account"/);
  assert.match(source, /\/api\/admin\/catalog\/personnel\/eligible-accounts\?\$\{query\.toString\(\)\}/);
  assert.match(source, /\/api\/admin\/access\/accounts\/\$\{encodeURIComponent\(account\.app_user_id\)\}/);
  assert.match(source, /method:\s*"PATCH"/);
  assert.match(source, /\/api\/admin\/catalog\/personnel\/\$\{encodeURIComponent\(dialog\.personnel\.recruiter_id\)\}\/active/);
  assert.match(source, /\/api\/admin\/catalog\/personnel\/\$\{encodeURIComponent\(intent\.recruiterId\)\}/);
  assert.doesNotMatch(source, /supabase|\.rpc\(|createClient\(/i);
  // No free-create endpoint is called from the client.
  assert.doesNotMatch(source, /url:\s*"\/api\/admin\/catalog\/personnel"\s*,/);
});

test("D3-C: eligible accounts paginate page 1..1000 and drop stale selections", () => {
  assert.match(source, /changeEligiblePage/);
  assert.match(source, /Trang trước/);
  assert.match(source, /Trang sau/);
  assert.match(source, /eligibleHasMore/);
  assert.match(source, /setEligiblePage\(list\.page\)/);
  assert.match(source, /setEligibleHasMore\(list\.has_more\)/);
  // Stale detail response must never overwrite a newer selection.
  assert.match(source, /if \(selectedAccountRef\.current !== account\.app_user_id\) return;/);
  // A stale failed request must not clear the newer selection's version either.
  assert.match(source, /catch \{\s*if \(selectedAccountRef\.current !== account\.app_user_id\) return;\s*setAccountVersion\(null\);\s*\}/);
  // Page stays bounded 1..1000.
  assert.match(source, /nextPage < 1 \|\| nextPage > 1000/);
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

test("mutation errors stay visible in the dialog and an OCC conflict can be dismissed safely", () => {
  assert.match(source, /setFormError\(messageForOutcome\(outcome\)\)/);
  assert.match(source, /<p role="alert"/);
  assert.match(source, /if \(!open && !busy\) setDialog\(null\)/);
  assert.match(source, /dialog === null \? \(\s*Array\.from\(conflictIntents\.values\(\)/);
  assert.match(source, /setConflictLocks\(\(current\) => setPersonnelConflictLock\(current, intent\.lockId, true\)\)/);
  assert.match(source, /personnelConflictsForDialog\(conflictIntents, dialogLockId\)\.map/);
  assert.match(source, /if \(response\.status === 404\)/);
  assert.match(source, /next\.delete\(intent\.lockId\)/);
  assert.match(source, /không còn tồn tại hoặc không còn khả dụng/i);
  assert.doesNotMatch(source, /[\u0E00-\u0E7F]/);
});
