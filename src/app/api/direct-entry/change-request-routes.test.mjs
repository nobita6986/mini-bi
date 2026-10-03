import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const createRoute = source("./change-requests/route.ts");
const withdrawRoute = source("./change-requests/[requestId]/withdraw/route.ts");
const decisionRoute = source("./change-requests/[requestId]/decision/route.ts");
const api = source("../../../lib/direct-entry/change-request-api.ts");
const repository = source("../../../lib/direct-entry/change-request-repository.ts");
const contractSource = source("../../../lib/direct-entry/change-request-contract.ts");

const TABLE_ACCESS = /\.from\s*\(/;
const SQL_DML = /(?:insert|update|delete)\s+(?:into|from)\s+public\./i;
const CLIENT_AUTHORITY = /(?:app_user_id|auth_subject|capability|scope|team_id|created_by|proposer|reviewer)\s*:\s*(?:body|request)\./i;

test("every change request POST is gated before params, session, repository and handler", () => {
  for (const [source_, handler, params] of [
    [createRoute, "createChangeRequest(", false],
    [withdrawRoute, "withdrawChangeRequest(", true],
    [decisionRoute, "decideChangeRequest(", true],
  ]) {
    const gate = source_.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
    const notFound = source_.indexOf('code: "NOT_FOUND"');
    const auth = source_.indexOf("getDirectEntryActor(");
    const repositoryFactory = source_.indexOf("createChangeRequestRepository()");
    const handlerIndex = source_.indexOf(handler);
    assert.ok(gate >= 0 && notFound > gate, handler);
    assert.ok(auth > notFound && repositoryFactory > notFound && handlerIndex > notFound, handler);
    if (params) {
      assert.ok(source_.indexOf("await context.params") > notFound, handler);
    }
    assert.match(source_, /export async function POST\(/);
    assert.match(source_, /runtime = "nodejs"/);
    assert.match(source_, /dynamic = "force-dynamic"/);
    assert.doesNotMatch(source_, TABLE_ACCESS);
  }
});

test("change request boundary never touches tables, client authority or the decide helper", () => {
  const combined = api + repository + contractSource;
  assert.doesNotMatch(combined, TABLE_ACCESS);
  assert.doesNotMatch(combined, SQL_DML);
  assert.doesNotMatch(combined, /service_role/i);
  assert.doesNotMatch(api, CLIENT_AUTHORITY);
  assert.doesNotMatch(repository, /callRpc\("direct_entry_decide_change_request"/);
  assert.match(repository, /import "server-only"/);
  for (const routeSource of [createRoute, withdrawRoute, decisionRoute]) {
    assert.match(routeSource, /import "server-only"/);
  }
});

test("only the four granted change request RPCs are reachable and dispatch stays explicit", () => {
  const rpcNames = [...repository.matchAll(/"(direct_entry_[a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(rpcNames)].sort(), [
    "direct_entry_approve_change_request",
    "direct_entry_create_change_request",
    "direct_entry_reject_change_request",
    "direct_entry_withdraw_change_request",
  ]);
  assert.match(repository, /direct_entry_approve_change_request", "APPROVED"/);
  assert.match(repository, /direct_entry_reject_change_request", "REJECTED"/);
  assert.match(api, /parsed\.value\.decision === "approve"/);
  assert.doesNotMatch(api, /repository\[|window\[|globalThis\[/);
  assert.match(decisionRoute, /decideChangeRequest\(request, requestId, "true"/);
});
