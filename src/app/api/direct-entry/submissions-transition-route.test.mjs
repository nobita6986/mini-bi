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

test("only the transition RPCs are reachable from the repository boundary", () => {
  const rpcNames = [...repository.matchAll(/callRpc\(\s*"([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rpcNames, [
    "direct_entry_transition_submission_duplicate_cccd_confirmed",
    "direct_entry_transition_submission",
  ]);
  assert.match(repository, /console\.error\("\[direct-entry\] submission transition RPC failed"\)/);
});

test("the duplicate-CCCD preflight boundary calls exactly one read RPC", () => {
  const preflightRepository = readFileSync(new URL(
    "../../../lib/direct-entry/submission-duplicate-cccd-repository.ts",
    import.meta.url,
  ), "utf8");
  const preflightApi = readFileSync(new URL(
    "../../../lib/direct-entry/submission-duplicate-cccd-api.ts",
    import.meta.url,
  ), "utf8");
  const preflightRoute = readFileSync(new URL(
    "./submissions/[submissionId]/duplicate-cccd-preflight/route.ts",
    import.meta.url,
  ), "utf8");
  const names = [...preflightRepository.matchAll(/callRpc\(\s*"([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(names, ["direct_entry_submission_duplicate_cccd_preflight"]);
  assert.doesNotMatch(preflightRepository, TABLE_ACCESS);
  assert.doesNotMatch(preflightApi, TABLE_ACCESS);
  assert.doesNotMatch(preflightApi, SQL_DML);
  assert.doesNotMatch(preflightRepository, /service_role/i);
  assert.match(preflightRepository, /import "server-only"/);
  assert.match(preflightApi, /"Cache-Control": "private, no-store"/);
  assert.match(preflightApi, /SUBMISSION_DENIED/);
  assert.match(preflightApi, /SUBMISSION_TRANSITION_INVALID/);
  assert.doesNotMatch(preflightRoute, TABLE_ACCESS);
  assert.match(preflightRoute, /export async function GET\(/);
  assert.match(preflightRoute, /runtime = "nodejs"/);
  assert.match(preflightRoute, /dynamic = "force-dynamic"/);
});

test("the confirm path maps a changed conflict set to a 409 acknowledgement-required code", () => {
  assert.match(api, /duplicate-confirmation/);
  assert.match(api, /DUPLICATE_CCCD_CONFIRMATION_REQUIRED/);
  assert.match(api, /duplicate_cccd_fingerprint/);
  assert.match(repository, /direct_entry_transition_submission_duplicate_cccd_confirmed/);
  assert.match(repository, /p_ack_fingerprint/);
  assert.match(repository, /p_ack_conflict_count/);
});
