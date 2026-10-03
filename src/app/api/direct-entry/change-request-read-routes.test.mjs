import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const collectionRoute = source("./change-requests/route.ts");
const detailRoute = source("./change-requests/[requestId]/route.ts");
const api = source("../../../lib/direct-entry/change-request-read-api.ts");
const repository = source("../../../lib/direct-entry/change-request-read-repository.ts");
const contractSource = source("../../../lib/direct-entry/change-request-read-contract.ts");

const TABLE_ACCESS = /\.from\s*\(/;
const SQL_DML = /(?:insert|update|delete)\s+(?:into|from)\s+public\./i;

test("both read routes gate before params, session, repository and handler", () => {
  for (const [source_, handler, hasParams] of [
    [collectionRoute, "listChangeRequests(", false],
    [detailRoute, "readChangeRequest(", true],
  ]) {
    const gate = source_.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
    const notFound = source_.indexOf('code: "NOT_FOUND"');
    const auth = source_.indexOf("getDirectEntryActor(");
    const repositoryFactory = source_.indexOf("createChangeRequestReadRepository()");
    const handlerIndex = source_.indexOf(handler);
    assert.ok(gate >= 0 && notFound > gate, handler);
    assert.ok(auth > notFound && repositoryFactory > notFound && handlerIndex > notFound, handler);
    if (hasParams) assert.ok(source_.indexOf("await context.params") > notFound, handler);
    assert.match(source_, /export async function GET\(/);
    assert.match(source_, /runtime = "nodejs"/);
    assert.match(source_, /dynamic = "force-dynamic"/);
    assert.doesNotMatch(source_, TABLE_ACCESS);
  }
});

test("collection route keeps the existing POST semantics next to GET", () => {
  assert.match(collectionRoute, /export async function POST\(request: Request\)/);
  assert.match(collectionRoute, /return createChangeRequest\(request, "true", \{/);
  assert.match(collectionRoute, /repository: createChangeRequestRepository\(\)/);
  assert.match(collectionRoute, /return listChangeRequests\(request, "true", \{/);
  const posts = collectionRoute.match(/export async function POST/g) ?? [];
  assert.equal(posts.length, 1);
});

test("read boundary never touches tables, mutation RPCs or client authority", () => {
  const combined = api + repository + contractSource;
  assert.doesNotMatch(combined, TABLE_ACCESS);
  assert.doesNotMatch(combined, SQL_DML);
  assert.doesNotMatch(combined, /service_role/i);
  for (const forbidden of [
    "direct_entry_create_change_request",
    "direct_entry_withdraw_change_request",
    "direct_entry_approve_change_request",
    "direct_entry_reject_change_request",
    "direct_entry_decide_change_request",
  ]) {
    assert.doesNotMatch(repository, new RegExp(forbidden), forbidden);
  }
  assert.match(repository, /direct_entry_list_change_requests/);
  assert.match(repository, /direct_entry_read_change_request/);
  assert.doesNotMatch(api, /request\.headers\.get\("idempotency-key"\)/);
  assert.doesNotMatch(api, /await request\.json\(\)/);
  assert.match(repository, /import "server-only"/);
  for (const routeSource of [collectionRoute, detailRoute]) {
    assert.match(routeSource, /import "server-only"/);
  }
});
