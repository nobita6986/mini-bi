import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const HERE = new URL("./", import.meta.url);
const page = readFileSync(new URL("../../app/dashboard/page.tsx", HERE), "utf8");
const server = readFileSync(new URL("./p2-w04a-reporting-server.ts", HERE), "utf8");
const audience = readFileSync(new URL("./p3-w05a-audience.ts", HERE), "utf8");

test("E21: dashboard page resolves actor, decides access, then fetches with actor input", () => {
  const guard = page.indexOf("decideSessionPageAccess(actor)");
  const fetchAt = page.indexOf("fetchCutoverReporting(params, actor.actor)");
  assert.ok(guard > 0, "page must run decideSessionPageAccess");
  assert.ok(fetchAt > guard, "page must decide access BEFORE fetching facts");
  assert.match(page, /fetchCutoverReporting\(params, actor\.actor\)/);
  assert.match(page, /fetchCutoverReportingOptions\(actor\.actor\)/);
  assert.ok(!/fetchCutoverReporting\(params\)/.test(page), "no unscoped fallback remains");
  assert.ok(!/fetchCutoverReportingOptions\(\)/.test(page), "no unscoped options fallback remains");
});

test("E21: reporting server takes actor as a mandatory input and calls the scoped RPC", () => {
  assert.match(server, /fetchCutoverReporting\(\s*params: Record<string, string \| string\[\] \| undefined>,\s*actor: DirectEntryActor/);
  assert.match(server, /direct_entry_reporting_scoped_facts/);
  assert.ok(!/\.from\("direct_entry_reporting_facts_v01"\)/.test(server), "facts must go through the scoped RPC, not the raw view");
});

test("E22: audience projection carries only kind + label (no UUID/grants/raw scope)", () => {
  const typeMatch = audience.match(/interface ReportingAudience \{[\s\S]*?\}/);
  assert.ok(typeMatch, "ReportingAudience type must exist");
  const body = typeMatch[0];
  assert.match(body, /kind/);
  assert.match(body, /label/);
  assert.ok(!/app_user_id|auth_subject|team_id|recruiter_id|grant|scope_kind|email/.test(body), "projection must not carry actor identity/grants");
});

