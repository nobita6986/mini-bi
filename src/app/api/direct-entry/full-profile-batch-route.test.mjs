import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./batches/full-profile/route.ts", import.meta.url),
  "utf8",
);

test("full-profile route gates before constructing session or repository dependencies", () => {
  const gate = source.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
  const response = source.indexOf('code: "NOT_FOUND"');
  const actor = source.indexOf("getDirectEntryActor(");
  const repo = source.indexOf("createFullProfileRepository()");
  const handler = source.indexOf("postFullProfileBatch(");
  assert.ok(gate >= 0 && response > gate && actor > response && repo > response && handler > response);
  assert.match(source, /runtime = "nodejs"/);
  assert.match(source, /dynamic = "force-dynamic"/);
  assert.doesNotMatch(source, /request\.(?:json|text|formData)\(/);
});

test("route does not accept actor, capability, scope, provider or team authority from the request", () => {
  assert.doesNotMatch(source, /(?:app_user_id|auth_subject|capability|scope_kind|provider_type|team_id)\s*:\s*request/i);
});
