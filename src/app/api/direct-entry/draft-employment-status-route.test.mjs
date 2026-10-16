import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL(
  "./entries/[entryId]/employment-status/route.ts",
  import.meta.url,
), "utf8");

test("employment-status PATCH is gated before params, session and repository setup", () => {
  const gate = route.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
  const notFound = route.indexOf('code: "NOT_FOUND"');
  const params = route.indexOf("await context.params");
  const session = route.indexOf("getDirectEntryActor(");
  const repository = route.indexOf("createDirectEntryWriteRepository()");
  const handler = route.indexOf("applyDraftEmploymentStatus(");

  assert.ok(gate >= 0 && notFound > gate && params > notFound);
  assert.ok(session > params && repository > params && handler > params);
  assert.match(route, /export async function PATCH\(/);
  assert.match(route, /runtime = "nodejs"/);
  assert.match(route, /dynamic = "force-dynamic"/);
  assert.doesNotMatch(route, /\.from\s*\(/);
});

test("employment-status route derives actor from session and uses the draft API", () => {
  assert.match(route, /resolveSession:\s*\(\)\s*=>\s*getDirectEntryActor\(createDirectEntryActorRepository\(\)\)/);
  assert.match(route, /repository:\s*createDirectEntryWriteRepository\(\)/);
  assert.match(route, /applyDraftEmploymentStatus\(request,\s*entryId,\s*"true"/);
  assert.doesNotMatch(route, /(?:app_user_id|auth_subject|capability|scope)\s*:\s*(?:body|request)\./i);
});
