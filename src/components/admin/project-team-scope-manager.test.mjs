import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("./project-team-scope-manager.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../../app/admin/catalog/project-team-scopes/page.tsx", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../../lib/admin/admin-navigation.ts", import.meta.url), "utf8");

test("mapping manager uses bounded no-store read and existing grant/revoke API", () => {
  assert.match(component, /buildMappingListQuery\(/);
  assert.match(component, /cache:\s*"no-store"/);
  assert.match(component, /fetch\(`\/api\/admin\/catalog\/project-team-scopes\?/);
  assert.match(component, /fetch\(url,\s*\{[\s\S]*?method:\s*"POST"/);
  assert.match(component, /\/api\/admin\/catalog\/project-team-scopes\/\$\{encodeURIComponent\(dialog\.mapping\.mapping_id\)\}\/revoke/);
  assert.match(component, /expectedPairVersion:\s*dialog\.mapping\.version/);
  assert.match(component, /expectedPairVersion:\s*\/\^\(0\|\[1-9\]\\d\*\)\$\//);
  assert.match(component, /Phiên bản cặp mapping/);
  assert.match(component, /reason/);
  assert.match(component, /newMappingKey\(\)/);
});

test("mapping UI route and navigation are restricted to canonical Full Admin", () => {
  assert.match(page, /decideAccountAccessPageAccess\(\{ actor \}\)/);
  assert.doesNotMatch(page, /decideAdminAreaAccess/);
  assert.match(navigation, /project-team-scopes[^\n]*visible:\s*adminSecurityNavPredicate/);
  assert.match(component, /Chỉ Full Admin/);
});

test("mapping UI exposes history, project filtering, empty state, and safe denied/error states", () => {
  assert.match(component, /projectIdFilter/);
  assert.match(component, /includeHistory/);
  assert.match(component, /setPage\(/);
  assert.match(component, /Chưa có mapping nào/);
  assert.match(component, /state === "denied"/);
  assert.match(component, /state === "error"/);
});
