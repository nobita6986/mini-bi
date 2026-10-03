import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const listRoute = source("./submissions/route.ts");
const detailRoute = source("./submissions/[submissionId]/route.ts");
const transitionRoute = source("./submissions/[submissionId]/transition/route.ts");
const api = source("../../../lib/direct-entry/submission-read-api.ts");
const repository = source("../../../lib/direct-entry/submission-read-repository.ts");
const contractSource = source("../../../lib/direct-entry/submission-read-contract.ts");

const TABLE_ACCESS = /\.from\s*\(/;
const SQL_DML = /(?:insert|update|delete)\s+(?:into|from)\s+public\./i;
const CLIENT_AUTHORITY = /(?:app_user_id|auth_subject|capability|scope|owner|created_by)\s*:\s*(?:body|request)\./i;

/** Route transition cua S01A phai nguyen ven trong task S02C (cap nhat hash khi doi co chu dich). */
const TRANSITION_ROUTE_SHA256 = "cbecc3d35e2776761528fabc9067b845450f1740d1d759c28400fcf477ce8761";

test("both submission read GET routes gate before params, session, repository and handler", () => {
  for (const [source_, handler, hasParams] of [
    [listRoute, "listOwnSubmissions(", false],
    [detailRoute, "readOwnSubmission(", true],
  ]) {
    const gate = source_.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
    const notFound = source_.indexOf('code: "NOT_FOUND"');
    const auth = source_.indexOf("getDirectEntryActor(");
    const repositoryFactory = source_.indexOf("createSubmissionReadRepository()");
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

test("transition POST route from S01A is untouched by S02C", () => {
  const digest = createHash("sha256").update(transitionRoute, "utf8").digest("hex");
  assert.equal(digest, TRANSITION_ROUTE_SHA256);
  assert.match(transitionRoute, /export async function POST\(/);
  assert.doesNotMatch(transitionRoute, /export async function GET\(/);
  assert.equal((transitionRoute.match(/export async function /g) ?? []).length, 1);
});

test("submission read boundary never touches tables, other RPCs or client authority", () => {
  const combined = api + repository + contractSource;
  assert.doesNotMatch(combined, TABLE_ACCESS);
  assert.doesNotMatch(combined, SQL_DML);
  assert.doesNotMatch(combined, /service_role/i);
  assert.doesNotMatch(api, CLIENT_AUTHORITY);
  assert.doesNotMatch(api, /await request\.json\(\)/);
  for (const forbidden of [
    "direct_entry_transition_submission",
    "direct_entry_create_change_request",
    "direct_entry_withdraw_change_request",
    "direct_entry_approve_change_request",
    "direct_entry_reject_change_request",
    "direct_entry_list_change_requests",
    "direct_entry_read_change_request",
    "direct_entry_assert_actor",
  ]) {
    assert.doesNotMatch(repository, new RegExp(forbidden), forbidden);
  }
  assert.match(repository, /direct_entry_list_own_submissions/);
  assert.match(repository, /direct_entry_read_own_submission/);
  assert.match(repository, /import "server-only"/);
  for (const routeSource of [listRoute, detailRoute]) {
    assert.match(routeSource, /import "server-only"/);
  }
});
