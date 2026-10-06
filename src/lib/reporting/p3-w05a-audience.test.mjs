import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REPORTING_AUDIENCE_ALL_LABEL,
  REPORTING_AUDIENCE_OWN_FALLBACK_LABEL,
  reportingAudienceFromDb,
  resolveReportingAudienceKind,
} from "./p3-w05a-audience.ts";

const AT = "2026-10-06T00:00:00Z";

function actorWith(scopes) {
  return {
    auth_subject: "10000000-0000-4000-8000-000000000001",
    app_user_id: "20000000-0000-4000-8000-000000000001",
    enabled: true,
    capabilities: [],
    scopes,
    self_recruiter_suggestion: null,
    session: { provider: "supabase", verification: "getUser", authenticated_at: null },
  };
}

function scope(kind, reference, valid_from, valid_to = null) {
  return { kind, reference, valid_from, valid_to };
}

test("audience priority: all beats team and own", () => {
  const actor = actorWith([
    scope("own", "u1", "0001-01-01"),
    scope("team", "t1", "2020-01-01"),
    scope("all", "all", "2020-01-01"),
  ]);
  assert.equal(resolveReportingAudienceKind(actor, AT), "all");
});

test("audience priority: team beats synthetic own", () => {
  const actor = actorWith([
    scope("own", "u1", "0001-01-01"),
    scope("team", "t1", "2020-01-01"),
  ]);
  assert.equal(resolveReportingAudienceKind(actor, AT), "team");
});

test("audience: no all/team resolves to own", () => {
  const actor = actorWith([scope("own", "u1", "0001-01-01")]);
  assert.equal(resolveReportingAudienceKind(actor, AT), "own");
});

test("audience: expired team grant does not resolve to team", () => {
  const actor = actorWith([
    scope("own", "u1", "0001-01-01"),
    scope("team", "t1", "2020-01-01", "2021-01-01"),
  ]);
  assert.equal(resolveReportingAudienceKind(actor, AT), "own");
});

test("reportingAudienceFromDb: normalizes a team audience", () => {
  assert.deepEqual(
    reportingAudienceFromDb({ audience: "team", label: "TEAM1", team_ids: ["t1"] }),
    { kind: "team", label: "TEAM1" },
  );
});

test("reportingAudienceFromDb: all audience keeps the fixed label", () => {
  assert.deepEqual(
    reportingAudienceFromDb({ audience: "all", label: REPORTING_AUDIENCE_ALL_LABEL }),
    { kind: "all", label: REPORTING_AUDIENCE_ALL_LABEL },
  );
});

test("reportingAudienceFromDb: own audience with missing label falls back safely", () => {
  assert.deepEqual(
    reportingAudienceFromDb({ audience: "own", label: "" }),
    { kind: "own", label: REPORTING_AUDIENCE_OWN_FALLBACK_LABEL },
  );
});

test("reportingAudienceFromDb: malformed payload returns null (fail closed)", () => {
  assert.equal(reportingAudienceFromDb(null), null);
  assert.equal(reportingAudienceFromDb({}), null);
  assert.equal(reportingAudienceFromDb({ audience: "unknown", label: "x" }), null);
});

