import assert from "node:assert/strict";
import test from "node:test";

import { computeReporting, teamBucketKey } from "./p1-reporting.ts";
import { P2_W04A_DIRECT_ENTRY_SOURCE, P2_W04A_DIRECT_ENTRY_SOURCE_ID } from "./p2-w04a-cutover.ts";
import {
  authorizeBucket,
  buildTeamDetail,
  decodeBucket,
  selectBucketFacts,
} from "./p3-w06d-team-report-core.ts";

const TEAM_A = "TEAM_A";
const TEAM_B = "TEAM_B";
const A_KEY = teamBucketKey(TEAM_A);
const B_KEY = teamBucketKey(TEAM_B);

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

function fact(overrides = {}) {
  return {
    source_id: P2_W04A_DIRECT_ENTRY_SOURCE_ID,
    business_date: "2026-10-10",
    project_key: "project a",
    project_display: "Project A",
    recruiter_key: "rec a",
    recruiter_display: "Recruiter A",
    provider_type_key: "hrp",
    provider_type_display: "HRP",
    employment_type_key: "thời vụ",
    employment_type_display: "Thời vụ",
    recruited_count: 1,
    first_work_date: "2026-10-10",
    entry_id: uuid(1),
    team_id: "team-a-id",
    team_code: TEAM_A,
    team_display_name: "Team A",
    team_active: true,
    ...overrides,
  };
}

function teamAFacts() {
  return [
    fact({ entry_id: uuid(1), business_date: "2026-10-10", recruiter_key: "rec a", recruiter_display: "Recruiter A" }),
    fact({ entry_id: uuid(2), business_date: "2026-10-09", recruiter_key: "rec b", recruiter_display: "Recruiter B" }),
    fact({ entry_id: uuid(3), business_date: "2026-10-08", recruiter_key: "rec c", recruiter_display: "Recruiter C" }),
  ];
}

test("W06D-R2 core: BoD selecting team A sees only team A, not company-wide or team B", () => {
  const companyFacts = [
    ...teamAFacts(),
    fact({ entry_id: uuid(9), recruiter_key: "rec z", recruiter_display: "Recruiter Z", team_id: "team-b-id", team_code: TEAM_B, team_display_name: "Team B" }),
  ];
  const decoded = decodeBucket(A_KEY);
  assert.deepEqual(decoded, { kind: "team", code: TEAM_A });

  const teamFacts = selectBucketFacts(companyFacts, decoded);
  assert.equal(teamFacts.length, 3);
  assert.ok(teamFacts.every((f) => f.team_code === TEAM_A), "only team A facts are selected");

  const presence = new Set([P2_W04A_DIRECT_ENTRY_SOURCE_ID]);
  const teamAReport = computeReporting([P2_W04A_DIRECT_ENTRY_SOURCE], teamFacts, {}, presence);
  const companyReport = computeReporting([P2_W04A_DIRECT_ENTRY_SOURCE], companyFacts, {}, presence);

  assert.equal(teamAReport.recruitedTotal, 3);
  assert.equal(companyReport.recruitedTotal, 4);
  assert.notEqual(teamAReport.recruitedTotal, companyReport.recruitedTotal);
  assert.equal(Object.values(teamAReport.byRecruiter).length, 3);
  assert.equal(teamAReport.byRecruiter[Object.keys(teamAReport.byRecruiter)[0]].recruitedCount, 1);
  assert.equal(Object.values(teamAReport.byTeam).length, 1);
  assert.equal(Object.values(teamAReport.byTeam)[0].display, "Team A");
  // Team B's recruiter is absent from team A's member contribution.
  assert.ok(!Object.values(teamAReport.byRecruiter).some((b) => b.display === "Recruiter Z"));

  assert.equal(authorizeBucket("all", decoded, teamFacts.length > 0), "ok");
  assert.equal(authorizeBucket("all", decodeBucket(B_KEY), false), "invalid");
});

test("W06D-R2 core: a team audience reads only a team inside its authorized scope", () => {
  const decodedA = decodeBucket(A_KEY);
  const decodedB = decodeBucket(B_KEY);
  // In-scope: the team has facts inside the actor's authorized set.
  assert.equal(authorizeBucket("team", decodedA, true), "ok");
  // Out-of-scope: the authorized set of a team audience holds only its own
  // teams, so another team has no matching fact and is refused.
  assert.equal(authorizeBucket("team", decodedB, false), "denied");
  assert.equal(authorizeBucket("own", decodedA, true), "denied");
  assert.equal(authorizeBucket("own", decodedB, false), "denied");
  assert.equal(authorizeBucket(null, decodedA, true), "denied");
});

test("W06D-R2 core: the unknown bucket is company-wide only", () => {
  assert.deepEqual(decodeBucket("unknown"), { kind: "unknown" });
  assert.equal(authorizeBucket("all", decodeBucket("unknown"), true), "ok");
  assert.equal(authorizeBucket("team", decodeBucket("unknown"), false), "denied");
  assert.equal(authorizeBucket("own", decodeBucket("unknown"), false), "denied");
  assert.equal(decodeBucket("__unknown__"), null);
  assert.equal(decodeBucket("not-a-bucket"), null);
});

test("W06D-R2 core: detail pages the sanitized seven-field rows with an opaque cursor", () => {
  const facts = teamAFacts();
  const first = buildTeamDetail({ facts, wantsUnknown: false, cursor: null, limit: 2 });
  assert.equal(first.total, 3);
  assert.equal(first.rows.length, 2);
  assert.deepEqual(Object.keys(first.rows[0]).sort(), [
    "business_date", "employment_type_display", "first_work_date",
    "project_display", "provider_type_display", "recruited_count", "recruiter_display",
  ]);
  assert.equal(typeof first.nextCursor, "string");
  assert.equal(first.legacy_aggregate_total, null);

  const second = buildTeamDetail({ facts, wantsUnknown: false, cursor: first.nextCursor, limit: 2 });
  assert.equal(second.rows.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(second.total, 3);

  // A cursor beyond the last row is an empty page, never an error.
  const beyond = buildTeamDetail({ facts: facts.slice(0, 2), wantsUnknown: false, cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(beyond.rows, []);
  assert.equal(beyond.nextCursor, null);
});

test("W06D-R2 core: the unknown bucket keeps legacy apart from the paginated anomaly rows", () => {
  const facts = [
    fact({ entry_id: uuid(1), team_id: null, team_code: null, team_display_name: null, team_active: null }),
    {
      ...fact({ entry_id: undefined, first_work_date: undefined }),
      source_id: "00000000-0000-4000-8000-000000000002",
      business_date: "2026-09-20",
      recruited_count: 7,
      team_id: null,
      team_code: null,
      team_display_name: null,
      team_active: null,
    },
  ];
  const decoded = decodeBucket("unknown");
  const bucketFacts = selectBucketFacts(facts, decoded);
  assert.equal(bucketFacts.length, 2);

  const detail = buildTeamDetail({ facts: bucketFacts, wantsUnknown: true, cursor: null, limit: 25 });
  assert.equal(detail.total, 1);
  assert.equal(detail.rows.length, 1);
  assert.equal(detail.legacy_aggregate_total.recruited_count, 7);
  assert.equal(detail.legacy_aggregate_total.from, "2026-09-20");
  assert.equal(detail.legacy_aggregate_total.to, "2026-09-20");
});
