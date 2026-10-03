import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL(
  "./submissions/[submissionId]/transition/route.ts",
  import.meta.url,
), "utf8");
const api = readFileSync(new URL(
  "../../../lib/direct-entry/submission-transition-api.ts",
  import.meta.url,
), "utf8");
const repository = readFileSync(new URL(
  "../../../lib/direct-entry/submission-transition-repository.ts",
  import.meta.url,
), "utf8");
const contractSource = readFileSync(new URL(
  "../../../lib/direct-entry/submission-transition-contract.ts",
  import.meta.url,
), "utf8");

const TABLE_ACCESS = /\.from\s*\(/;
const SQL_DML = /(?:insert|update|delete)\s+(?:into|from)\s+public\./i;
const CLIENT_AUTHORITY = /(?:app_user_id|auth_subject|capability|scope|team_id|created_by)\s*:\s*(?:body|request)\./i;

test("transition POST is gated before params, session, repository and handler", () => {
  const gate = route.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
  const notFound = route.indexOf('code: "NOT_FOUND"');
  const params = route.indexOf("await context.params");
  const auth = route.indexOf("getDirectEntryActor(");
  const repositoryFactory = route.indexOf("createSubmissionTransitionRepository()");
  const handler = route.indexOf("transitionSubmission(");
  assert.ok(gate >= 0 && notFound > gate && params > notFound && auth > params);
  assert.ok(repositoryFactory > params && handler > params);
  assert.match(route, /export async function POST\(/);
  assert.match(route, /runtime = "nodejs"/);
  assert.match(route, /dynamic = "force-dynamic"/);
  assert.doesNotMatch(route, TABLE_ACCESS);
});

test("submission boundary code never reads client-supplied authority or tables directly", () => {
  const combined = api + repository + contractSource;
  assert.doesNotMatch(combined, TABLE_ACCESS);
  assert.doesNotMatch(combined, SQL_DML);
  assert.doesNotMatch(combined, /service_role/i);
  assert.doesNotMatch(route + api, CLIENT_AUTHORITY);
  assert.match(repository, /direct_entry_transition_submission/);
  assert.match(repository, /import "server-only"/);
  assert.match(route, /import "server-only"/);
});

test("only the transition RPC is reachable from the repository boundary", () => {
  const rpcNames = [...repository.matchAll(/callRpc\("([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rpcNames, ["direct_entry_transition_submission"]);
  assert.match(repository, /console\.error\("\[direct-entry\] submission transition RPC failed"\)/);
});
