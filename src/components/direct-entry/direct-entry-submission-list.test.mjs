import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const listComponent = source("./direct-entry-submission-list.tsx");
const liveComponent = source("./direct-entry-live.tsx");
const helper = source("../../lib/direct-entry/submission-lifecycle.ts");

const TABLE_ACCESS = /\.from\s*\(/;
const CLIENT_AUTHORITY = /(?:actor_id|auth_subject|app_user_id|capability|capabilities|scope|owner_user_id|created_by_user_id)\s*:/;
const RAW_LOGGING = /console\.(?:log|error|warn|info)\(/;

test("confirmation uses Radix AlertDialog without manual modal plumbing", () => {
  assert.match(listComponent, /import \{ AlertDialog \} from "radix-ui"/);
  for (const marker of ["AlertDialog.Root", "AlertDialog.Portal", "AlertDialog.Title",
    "AlertDialog.Description", "AlertDialog.Cancel", "AlertDialog.Action"]) {
    assert.match(listComponent, new RegExp(marker.replace(".", "\\.")), marker);
  }
  assert.doesNotMatch(listComponent, /window\.confirm/);
  assert.doesNotMatch(listComponent, /addEventListener\(\s*"key(down|up)"/);
  assert.doesNotMatch(listComponent, /focus\(\)/);
  assert.doesNotMatch(listComponent, /querySelectorAll\(\s*"\[tabindex/);
  assert.doesNotMatch(listComponent + liveComponent, /createFocusTrap|focus-trap|aria-modal="true"/);
});

test("UI boundary sends only contract fields and never client authority", () => {
  for (const file of [listComponent, liveComponent, helper]) {
    assert.doesNotMatch(file, CLIENT_AUTHORITY);
    assert.doesNotMatch(file, TABLE_ACCESS);
    assert.doesNotMatch(file, RAW_LOGGING);
    assert.doesNotMatch(file, /service_role|SUPABASE_|getSession\(/);
  }
  assert.match(liveComponent, /\/api\/direct-entry\/submissions\?" \+ params\.toString\(\)/);
  assert.match(liveComponent, /\/transition",/);
  assert.match(liveComponent, /method: "POST"/);
  assert.match(liveComponent, /"Idempotency-Key": resolved\.key/);
  assert.match(liveComponent, /expected_version: submission\.version,/);
  assert.match(liveComponent, /target_state: action\.target_state,/);
  assert.match(liveComponent, /idempotency_key: resolved\.key,/);
  const bodyStart = liveComponent.indexOf("body: JSON.stringify({") + "body: JSON.stringify({".length;
  const body = liveComponent.slice(bodyStart, liveComponent.indexOf("}),", bodyStart));
  assert.equal((body.match(/: /g) ?? []).length, 3, "body chi co dung ba truong contract");
  assert.match(liveComponent, /cache: "no-store"/);
  assert.match(liveComponent, /credentials: "same-origin"/);
});

test("live component reuses server projections and lifecycle helpers instead of ad hoc logic", () => {
  assert.match(liveComponent, /projectSubmissionListPage\(/);
  assert.match(liveComponent, /projectSubmissionTransitionResult\(/);
  assert.doesNotMatch(liveComponent, /parseSubmission|JSON\.parse\(/);
  for (const marker of ["isRowEditable(", "dropSubmissionRows(", "mergeReloadedDrafts(",
    "confirmBlockReason(", "resolveIntentKey(", "clearIntentKey(", "transitionErrorMessage("]) {
    assert.match(liveComponent, new RegExp(marker.replace("(", "\\(")), marker);
  }
  assert.match(liveComponent, /crypto\.randomUUID\(\)/);
  assert.match(liveComponent, /crypto\.randomUUID\(\),\s*\n\s*\);/, "key moi cho intent moi");
  assert.doesNotMatch(liveComponent, /optimistic/i);
});

test("project-scoped submissions allow proposals but keep document management out of scope", () => {
  assert.match(listComponent, /submission\.project_scoped\s*\?/);
  assert.match(listComponent, /Yêu cầu thay đổi/);
  assert.match(listComponent, /!submission\.project_scoped\s*&&\s*\(\s*<button[\s\S]*?onManageDocuments\(submission\)/);
});

test("no test or mock route exists inside the app router", () => {
  function walk(directory) {
    const entries = readdirSync(directory, { withFileTypes: true });
    const found = [];
    for (const entry of entries) {
      const full = directory + "/" + entry.name;
      if (entry.isDirectory()) found.push(...walk(full));
      else found.push(full);
    }
    return found;
  }
  const appFiles = walk(new URL("../../app", import.meta.url).pathname.replace(/^\//, ""));
  const directEntryRoutes = appFiles.filter((file) => file.includes("/api/direct-entry/"));
  assert.equal(directEntryRoutes.length > 0, true);
  const suspicious = directEntryRoutes.filter((file) => /mock|fixture|synthetic|_test/i.test(file));
  assert.deepEqual(suspicious, []);
});
