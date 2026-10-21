import assert from "node:assert/strict";
import test from "node:test";

import {
  getWorkReportAnalyticsBreakdown,
  getWorkReportAnalyticsContributions,
  getWorkReportAnalyticsOverview,
} from "./analytics-api.ts";
import {
  computeWorkReportWeightedRatio,
  createAnalyticsRepository,
} from "./analytics-repository.ts";
import { getWorkReportSubmission } from "./submission-api.ts";

const AUTH = "10000000-0000-4000-8000-000000000001";
const APP = "20000000-0000-4000-8000-000000000001";
const TEMPLATE_ID = "30000000-0000-4000-8000-000000000001";
const VERSION_ID = "40000000-0000-4000-8000-000000000001";
const TEAM_A = "50000000-0000-4000-8000-000000000001";
const TEAM_B = "50000000-0000-4000-8000-000000000002";
const ASSIGNEE_A = "60000000-0000-4000-8000-000000000001";
const OBLIGATION_ID = "70000000-0000-4000-8000-000000000001";
const SUBMISSION_ID = "80000000-0000-4000-8000-000000000001";

const activeSession = async () => ({
  actor: {
    ok: true,
    actor: { auth_subject: AUTH, app_user_id: APP },
  },
});

const SAMPLE_OVERVIEW = {
  as_of: "2026-10-21T12:00:00.000000Z",
  effective_scope: { kind: "team", label: "Team Tuyển Dụng A" },
  compliance: {
    due_count: 20,
    completed_count: 18,
    on_time_count: 15,
    late_submitted_count: 3,
    pending_due_count: 0,
    overdue_missing_count: 2,
    exempted_count: 1,
    pending_review_count: 0,
    completion_rate: 90,
  },
  metrics: [
    {
      metric_key: "calls_made",
      label: "Số cuộc gọi",
      unit: "cuộc",
      compatible_group: "recruitment_daily_calls_made_v1",
      sum_value: 40,
      avg_value: 13.33,
      min_value: 2,
      max_value: 20,
      count_valid: 3,
      missing_value_count: 0,
    },
  ],
  ratios: [
    {
      ratio_key: "interested_per_call_rate",
      label: "Tỷ lệ ứng viên quan tâm / cuộc gọi",
      numerator_metric_key: "interested_candidates",
      denominator_metric_key: "calls_made",
      numerator_sum: 10,
      denominator_sum: 40,
      scale_factor: 100,
      value: 25,
    },
  ],
};

const SAMPLE_BREAKDOWN = {
  as_of: "2026-10-21T12:00:00.000000Z",
  effective_scope: { kind: "team", label: "Team Tuyển Dụng A" },
  group_by: "team",
  page: 1,
  page_size: 50,
  total_groups: 1,
  items: [
    {
      group_id: TEAM_A,
      group_label: "Team Tuyển Dụng A",
      due_count: 20,
      completed_count: 18,
      on_time_count: 15,
      late_submitted_count: 3,
      pending_due_count: 0,
      overdue_missing_count: 2,
      exempted_count: 1,
      pending_review_count: 0,
      completion_rate: 90,
      metrics: SAMPLE_OVERVIEW.metrics,
    },
  ],
};

const SAMPLE_CONTRIBUTIONS = {
  as_of: "2026-10-21T12:00:00.000000Z",
  effective_scope: { kind: "team", label: "Team Tuyển Dụng A" },
  next_cursor: `2026-10-20T10:00:00.000000Z|2026-10-20|${OBLIGATION_ID}`,
  items: [
    {
      obligation_id: OBLIGATION_ID,
      submission_id: SUBMISSION_ID,
      revision_no: 2,
      assignee_app_user_id: ASSIGNEE_A,
      assignee_display_name: "Staff A1",
      snapshot_team_id: TEAM_A,
      team_display_name: "Team Tuyển Dụng A",
      period_key: "2026-10-20",
      state: "COMPLETED",
      submitted_at: "2026-10-20T10:00:00Z",
      is_late: false,
      has_post_deadline_amendment: false,
      metric_contribution_value: 30,
    },
  ],
};

test("AG-06: computeWorkReportWeightedRatio uses SUM(numerator)/SUM(denominator) and never averages row ratios", () => {
  const rows = [
    { interested: 1, calls: 2 },
    { interested: 9, calls: 18 },
    { interested: 0, calls: 20 },
  ];
  const numeratorSum = rows.reduce((acc, r) => acc + r.interested, 0);
  const denominatorSum = rows.reduce((acc, r) => acc + r.calls, 0);
  const weighted = computeWorkReportWeightedRatio(numeratorSum, denominatorSum, 100);
  const unweightedAverage =
    Math.round(
      ((rows.reduce((acc, r) => acc + (r.interested / r.calls) * 100, 0) / rows.length) + Number.EPSILON) * 100,
    ) / 100;

  assert.equal(weighted, 25);
  assert.notEqual(weighted, unweightedAverage);
  assert.equal(computeWorkReportWeightedRatio(10, 0, 100), null);
  assert.equal(computeWorkReportWeightedRatio(null, 40, 100), null);
});

test("analytics API enforces feature flag, query allowlist, date/pagination validation, and no-store headers", async () => {
  const repo = createAnalyticsRepository(async (name) => {
    if (name === "work_report_analytics_overview") return { data: SAMPLE_OVERVIEW, error: null };
    if (name === "work_report_analytics_breakdown") return { data: SAMPLE_BREAKDOWN, error: null };
    if (name === "work_report_analytics_contributions") return { data: SAMPLE_CONTRIBUTIONS, error: null };
    return { data: null, error: { code: "P0002" } };
  });
  const deps = { resolveSession: activeSession, repository: repo };

  // Feature flag off -> 404
  const flagOff = await getWorkReportAnalyticsOverview(
    new Request(`http://localhost/api/work-reports/analytics/overview?template_id=${TEMPLATE_ID}`),
    "false",
    deps,
  );
  assert.equal(flagOff.status, 404);

  // Missing template_id -> 400
  const missingTemplate = await getWorkReportAnalyticsOverview(
    new Request("http://localhost/api/work-reports/analytics/overview"),
    "true",
    deps,
  );
  assert.equal(missingTemplate.status, 400);
  assert.equal((await missingTemplate.json()).code, "WORK_REPORT_QUERY_INVALID");

  // Unknown query parameter -> 400
  const unknownParam = await getWorkReportAnalyticsOverview(
    new Request(`http://localhost/api/work-reports/analytics/overview?template_id=${TEMPLATE_ID}&role=BoD`),
    "true",
    deps,
  );
  assert.equal(unknownParam.status, 400);

  // Invalid finality in F1.5 (e.g. provisional_included is F2-only) -> 400
  const invalidFinality = await getWorkReportAnalyticsOverview(
    new Request(
      `http://localhost/api/work-reports/analytics/overview?template_id=${TEMPLATE_ID}&finality=provisional_included`,
    ),
    "true",
    deps,
  );
  assert.equal(invalidFinality.status, 400);

  // Invalid calendar date or reversed date range -> 400
  const invalidDate = await getWorkReportAnalyticsOverview(
    new Request(
      `http://localhost/api/work-reports/analytics/overview?template_id=${TEMPLATE_ID}&from=2026-02-30&to=2026-03-01`,
    ),
    "true",
    deps,
  );
  assert.equal(invalidDate.status, 400);

  const reversedRange = await getWorkReportAnalyticsOverview(
    new Request(
      `http://localhost/api/work-reports/analytics/overview?template_id=${TEMPLATE_ID}&from=2026-10-25&to=2026-10-20`,
    ),
    "true",
    deps,
  );
  assert.equal(reversedRange.status, 400);

  // Client-supplied as_of is forbidden -> 400 WORK_REPORT_QUERY_INVALID
  const clientAsOfOverview = await getWorkReportAnalyticsOverview(
    new Request(
      `http://localhost/api/work-reports/analytics/overview?template_id=${TEMPLATE_ID}&as_of=2020-01-01T00:00:00Z`,
    ),
    "true",
    deps,
  );
  assert.equal(clientAsOfOverview.status, 400);
  assert.equal((await clientAsOfOverview.json()).code, "WORK_REPORT_QUERY_INVALID");

  const clientAsOfBreakdown = await getWorkReportAnalyticsBreakdown(
    new Request(
      `http://localhost/api/work-reports/analytics/breakdown?template_id=${TEMPLATE_ID}&group_by=team&as_of=2020-01-01T00:00:00Z`,
    ),
    "true",
    deps,
  );
  assert.equal(clientAsOfBreakdown.status, 400);
  assert.equal((await clientAsOfBreakdown.json()).code, "WORK_REPORT_QUERY_INVALID");

  // Valid overview call -> 200 with Cache-Control: private, no-store and DB as_of in response
  const okOverview = await getWorkReportAnalyticsOverview(
    new Request(
      `http://localhost/api/work-reports/analytics/overview?template_id=${TEMPLATE_ID}&version_id=${VERSION_ID}&from=2026-10-01&to=2026-10-31&team_id=${TEAM_A}&assignee_id=${ASSIGNEE_A}&finality=final`,
    ),
    "true",
    deps,
  );
  assert.equal(okOverview.status, 200);
  assert.equal(okOverview.headers.get("cache-control"), "private, no-store");
  const overviewBody = await okOverview.json();
  assert.equal(overviewBody.ok, true);
  assert.equal(overviewBody.data.as_of, SAMPLE_OVERVIEW.as_of);
  assert.equal(overviewBody.data.compliance.completion_rate, 90);

  // Invalid breakdown group_by or page_size -> 400
  const badBreakdown = await getWorkReportAnalyticsBreakdown(
    new Request(
      `http://localhost/api/work-reports/analytics/breakdown?template_id=${TEMPLATE_ID}&group_by=project`,
    ),
    "true",
    deps,
  );
  assert.equal(badBreakdown.status, 400);

  const okBreakdown = await getWorkReportAnalyticsBreakdown(
    new Request(
      `http://localhost/api/work-reports/analytics/breakdown?template_id=${TEMPLATE_ID}&group_by=team&page=1&page_size=50`,
    ),
    "true",
    deps,
  );
  assert.equal(okBreakdown.status, 200);
  const breakdownBody = await okBreakdown.json();
  assert.equal(breakdownBody.data.as_of, SAMPLE_BREAKDOWN.as_of);
  assert.equal(breakdownBody.data.items.length, 1);

  // Bare UUID cursor or malformed keyset cursor -> 400 WORK_REPORT_QUERY_INVALID
  const bareUuidCursor = await getWorkReportAnalyticsContributions(
    new Request(
      `http://localhost/api/work-reports/analytics/contributions?template_id=${TEMPLATE_ID}&cursor=${OBLIGATION_ID}`,
    ),
    "true",
    deps,
  );
  assert.equal(bareUuidCursor.status, 400);
  assert.equal((await bareUuidCursor.json()).code, "WORK_REPORT_QUERY_INVALID");

  // Valid contributions call with keyset cursor -> 200
  const validCursor = encodeURIComponent(`2026-10-20T10:00:00.000000Z|2026-10-20|${OBLIGATION_ID}`);
  const okContrib = await getWorkReportAnalyticsContributions(
    new Request(
      `http://localhost/api/work-reports/analytics/contributions?template_id=${TEMPLATE_ID}&metric_key=calls_made&target_team_id=${TEAM_A}&cursor=${validCursor}&limit=100`,
    ),
    "true",
    deps,
  );
  assert.equal(okContrib.status, 200);
  const contribBody = await okContrib.json();
  assert.equal(contribBody.data.as_of, SAMPLE_CONTRIBUTIONS.as_of);
  assert.equal(contribBody.data.next_cursor, SAMPLE_CONTRIBUTIONS.next_cursor);
  assert.equal(contribBody.data.items[0].submission_id, SUBMISSION_ID);
  assert.equal(contribBody.data.items[0].metric_contribution_value, 30);
});

test("analytics API maps scope denial (SEC-WR-02), capability denial (SEC-WR-03/07), and disabled actor (SEC-WR-06)", async () => {
  // SEC-WR-06: Disabled actor session
  const disabledDeps = {
    resolveSession: async () => ({ actor: { ok: false, reason: "ACTOR_DISABLED" } }),
    repository: createAnalyticsRepository(async () => ({ data: SAMPLE_OVERVIEW, error: null })),
  };
  const disabledRes = await getWorkReportAnalyticsOverview(
    new Request(`http://localhost/api/work-reports/analytics/overview?template_id=${TEMPLATE_ID}`),
    "true",
    disabledDeps,
  );
  assert.equal(disabledRes.status, 403);
  assert.equal((await disabledRes.json()).code, "ACTOR_NOT_AVAILABLE");

  // SEC-WR-02: Out-of-scope team_id -> 403 WORK_REPORT_SCOPE_DENIED
  const scopeDeniedRepo = createAnalyticsRepository(async () => ({
    data: null,
    error: { code: "42501", message: "WORK_REPORT_SCOPE_DENIED" },
  }));
  const scopeDeniedRes = await getWorkReportAnalyticsOverview(
    new Request(`http://localhost/api/work-reports/analytics/overview?template_id=${TEMPLATE_ID}&team_id=${TEAM_B}`),
    "true",
    { resolveSession: activeSession, repository: scopeDeniedRepo },
  );
  assert.equal(scopeDeniedRes.status, 403);
  assert.equal((await scopeDeniedRes.json()).code, "WORK_REPORT_SCOPE_DENIED");

  // SEC-WR-03 / SEC-WR-07: Missing report_analytics_view / report_view -> 403 WORK_REPORT_ACCESS_DENIED
  const capDeniedRepo = createAnalyticsRepository(async () => ({
    data: null,
    error: { code: "42501", message: "WORK_REPORT_CAPABILITY_DENIED" },
  }));
  const capDeniedRes = await getWorkReportAnalyticsContributions(
    new Request(`http://localhost/api/work-reports/analytics/contributions?template_id=${TEMPLATE_ID}`),
    "true",
    { resolveSession: activeSession, repository: capDeniedRepo },
  );
  assert.equal(capDeniedRes.status, 403);
  assert.equal((await capDeniedRes.json()).code, "WORK_REPORT_ACCESS_DENIED");

  // Source evidence endpoint compatibility with submission_id
  const evidenceRes = await getWorkReportSubmission(
    new Request(`http://localhost/api/work-reports/submissions/${SUBMISSION_ID}`),
    SUBMISSION_ID,
    "true",
    {
      resolveSession: activeSession,
      repository: {
        async listMine() { return { ok: true, data: [] }; },
        async get(input) {
          assert.equal(input.obligation_id, SUBMISSION_ID);
          return {
            ok: true,
            data: {
              obligation: { obligation_id: OBLIGATION_ID },
              template: { template_code: "RECRUITMENT_DAILY_V1", display_name: "Báo cáo ngày", schema_json: { version: "work-report-schema/1.0", sections: [] } },
              submission: {
                submission_id: SUBMISSION_ID,
                state: "COMPLETED",
                draft_payload_json: { calls_made: 30 },
                first_submitted_at: "2026-10-20T10:00:00Z",
                latest_submitted_at: "2026-10-20T10:00:00Z",
                is_late: false,
                has_post_deadline_amendment: false,
                current_revision_id: "90000000-0000-4000-8000-000000000001",
                version: 1,
              },
              revisions: [],
            },
          };
        },
        async saveDraft() { return { ok: false, kind: "unavailable" }; },
        async submit() { return { ok: false, kind: "unavailable" }; },
      },
    },
  );
  assert.equal(evidenceRes.status, 200);
  const evidenceBody = await evidenceRes.json();
  assert.equal(evidenceBody.ok, true);
  assert.equal(evidenceBody.data.submission.submission_id, SUBMISSION_ID);
});
