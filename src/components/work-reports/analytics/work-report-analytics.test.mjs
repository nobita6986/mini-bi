import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const component = await readFile(new URL("./work-report-analytics.tsx", import.meta.url), "utf8");
const page = await readFile(new URL("../../../app/work-reports/analytics/page.tsx", import.meta.url), "utf8");

test("analytics page is capability gated and consumes only the F1.5 API contract", () => {
  assert.match(page, /decideWorkReportAnalyticsPageAccess/);
  assert.match(page, /WORK_REPORTS_API_ENABLED/);
  assert.match(component, /\/api\/work-reports\/analytics\/overview/);
  assert.match(component, /\/api\/work-reports\/analytics\/breakdown/);
  assert.match(component, /\/api\/work-reports\/analytics\/contributions/);
  assert.match(component, /\/api\/work-reports\/submissions/);
  assert.match(component, /finality: "final"/);
  assert.match(component, /effective_scope\.label/);
  assert.doesNotMatch(component, /payload_json/);
  assert.doesNotMatch(component, /role|BoD|Team Leader/);
});

test("summary exposes locked filters, compliance, metric, breakdown and source fields", () => {
  for (const field of ["template_id", "version_id", "from", "to", "team_id", "assignee_id"]) assert.match(component, new RegExp(field));
  for (const field of ["due_count", "completed_count", "completion_rate", "late_submitted_count", "overdue_missing_count", "sum_value", "avg_value", "count_valid", "metric_contribution_value", "submission_id"]) assert.match(component, new RegExp(field));
});
