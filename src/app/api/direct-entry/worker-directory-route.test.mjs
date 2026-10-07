import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const route = source("./workers/route.ts");
const api = source("../../../lib/direct-entry/worker-directory-api.ts");
const repository = source("../../../lib/direct-entry/worker-directory-repository.ts");
const contractSource = source("../../../lib/direct-entry/worker-directory-contract.ts");

const TABLE_ACCESS = /\.from\s*\(/;
const SQL_DML = /(?:insert|update|delete)\s+(?:into|from)\s+public\./i;
const CLIENT_AUTHORITY =
  /(?:app_user_id|auth_subject|capability|scope|owner|created_by|allowed_actions)\s*:\s*(?:body|request)\./i;

test("the worker directory route gates before params, session, repository and handler", () => {
  const gate = route.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
  const notFound = route.indexOf('code: "NOT_FOUND"');
  const auth = route.indexOf("getDirectEntryActor(");
  const repositoryFactory = route.indexOf("createWorkerDirectoryRepository()");
  const handler = route.indexOf("listWorkers(");
  assert.ok(gate >= 0 && notFound > gate);
  assert.ok(auth > notFound && repositoryFactory > notFound && handler > notFound);
  assert.match(route, /export async function GET\(/);
  assert.match(route, /runtime = "nodejs"/);
  assert.match(route, /dynamic = "force-dynamic"/);
  assert.doesNotMatch(route, TABLE_ACCESS);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
});

test("the worker directory boundary never touches tables, other RPCs or client authority", () => {
  const combined = api + repository + contractSource;
  assert.doesNotMatch(combined, TABLE_ACCESS);
  assert.doesNotMatch(combined, SQL_DML);
  assert.doesNotMatch(combined, CLIENT_AUTHORITY);
  assert.doesNotMatch(combined, /supabase\.from|createServiceSupabaseClient\(\)\s*\.from/);
  for (const forbidden of [
    "direct_entry_assign_project_manager",
    "direct_entry_actor_can_access_project",
    "direct_entry_read_projection",
    "direct_entry_list_own_submissions",
  ]) {
    assert.equal(repository.includes(forbidden), false, forbidden);
  }
});
