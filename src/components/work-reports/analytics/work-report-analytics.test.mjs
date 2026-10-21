import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const component = await readFile(new URL("./work-report-analytics.tsx", import.meta.url), "utf8");
const page = await readFile(new URL("../../../app/work-reports/analytics/page.tsx", import.meta.url), "utf8");
const uiModel = await readFile(new URL("../../../lib/work-reports/analytics-ui-model.mjs", import.meta.url), "utf8");
const reviewUi = await readFile(new URL("../renderer/review-inbox.tsx", import.meta.url), "utf8");
const delegationUi = await readFile(new URL("../renderer/delegation-manager.tsx", import.meta.url), "utf8");
const navigationPredicates = await readFile(new URL("../../../lib/navigation/registry-capability.ts", import.meta.url), "utf8");
const workReportsPage = await readFile(new URL("../../../app/work-reports/page.tsx", import.meta.url), "utf8");
const reviewsPage = await readFile(new URL("../../../app/work-reports/reviews/page.tsx", import.meta.url), "utf8");
const delegationsPage = await readFile(new URL("../../../app/work-reports/delegations/page.tsx", import.meta.url), "utf8");

test("analytics page is capability gated and consumes only the F1.5 API contract", () => {
  assert.match(page, /decideWorkReportAnalyticsPageAccess/);
  assert.match(page, /WORK_REPORTS_API_ENABLED/);
  assert.match(component, /\/api\/work-reports\/analytics\/overview/);
  assert.match(component, /\/api\/work-reports\/analytics\/breakdown/);
  assert.match(uiModel, /\/api\/work-reports\/analytics\/contributions/);
  assert.match(component, /\/api\/work-reports\/submissions/);
  assert.match(component, /useState<Finality>\("final"\)/);
  assert.match(component, /new URLSearchParams\(\{ finality \}\)/);
  assert.match(component, /Tạm tính \(Chờ duyệt\)/);
  assert.match(component, /Chốt \(Đã duyệt\)/);
  assert.match(component, /effective_scope\.label/);
  assert.doesNotMatch(component, /payload_json/);
  assert.doesNotMatch(component, /role|BoD|Team Leader/);
});

test("review inbox uses server-filtered queue, reviewer detail and versioned decision API", () => {
  assert.match(reviewsPage, /WORK_REPORTS_API_ENABLED/);
  assert.match(reviewsPage, /workReportReviewPredicate\(resolution\.actor\)/);
  assert.match(workReportsPage, /href="\/work-reports\/reviews"/);
  assert.match(navigationPredicates, /effective_report_review_scopes/);
  assert.match(navigationPredicates, /workReportReviewPredicate/);
  assert.match(reviewUi, /\/api\/work-reports\/reviews\?/);
  assert.match(reviewUi, /page_size: "50"/);
  assert.match(reviewUi, /\/api\/work-reports\/reviews\/\$\{encodeURIComponent\(item\.obligation_id\)\}/);
  assert.match(reviewUi, /\/decision/);
  assert.match(reviewUi, /expected_version: detail\.value\.submission\.version/);
  assert.match(reviewUi, /decision === "REJECT" && !normalizedReason/);
  assert.match(reviewUi, /crypto\.randomUUID\(\)/);
  assert.doesNotMatch(reviewUi, /actor\.(?:role|title)|role_name|job_title|Team Leader|BoD/);
});

test("delegation UI consumes server-projected scope/options and versioned revoke contract", () => {
  assert.match(delegationsPage, /workReportDelegationPredicate\(resolution\.actor\)/);
  assert.match(workReportsPage, /href="\/work-reports\/delegations"/);
  assert.match(delegationUi, /\/api\/work-reports\/delegations/);
  assert.match(delegationUi, /options\.capabilities/);
  assert.match(delegationUi, /options\.delegates/);
  assert.match(delegationUi, /options\.templates/);
  assert.match(delegationUi, /options\.scopes/);
  assert.match(delegationUi, /expected_version: item\.version/);
  assert.match(delegationUi, /\/revoke/);
  assert.match(delegationUi, /ủy quyền tiếp từ giao diện này/);
  assert.doesNotMatch(delegationUi, /actor\.(?:role|title)|role_name|job_title|Team Leader|BoD/);
});

test("summary exposes locked filters, compliance, metric, breakdown and source fields", () => {
  for (const field of ["template_id", "version_id", "from", "to", "team_id", "assignee_id"]) assert.match(component, new RegExp(field));
  for (const field of ["due_count", "completed_count", "completion_rate", "late_submitted_count", "overdue_missing_count", "sum_value", "avg_value", "count_valid", "metric_contribution_value", "submission_id"]) assert.match(component, new RegExp(field));
});
