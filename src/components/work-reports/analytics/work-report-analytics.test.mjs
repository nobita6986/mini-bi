import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const component = await readFile(new URL("./work-report-analytics.tsx", import.meta.url), "utf8");
const tabs = await readFile(new URL("./work-report-analytics-tabs.tsx", import.meta.url), "utf8");
const page = await readFile(new URL("../../../app/work-reports/analytics/page.tsx", import.meta.url), "utf8");
const reader = await readFile(new URL("../reader/readable-submissions.tsx", import.meta.url), "utf8");
const readerModel = await readFile(new URL("../../../lib/work-reports/reader-ui-model.ts", import.meta.url), "utf8");
const reviewUi = await readFile(new URL("../renderer/review-inbox.tsx", import.meta.url), "utf8");
const delegationUi = await readFile(new URL("../renderer/delegation-manager.tsx", import.meta.url), "utf8");
const nav = await readFile(new URL("../work-reports-nav.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("../work-reports-shell.tsx", import.meta.url), "utf8");
const reviewsPage = await readFile(new URL("../../../app/work-reports/reviews/page.tsx", import.meta.url), "utf8");
const delegationsPage = await readFile(new URL("../../../app/work-reports/delegations/page.tsx", import.meta.url), "utf8");

test("analytics page stays capability gated and hosts two server-scoped tabs", () => {
  assert.match(page, /decideWorkReportAnalyticsPageAccess/);
  assert.match(page, /WORK_REPORTS_API_ENABLED/);
  assert.match(page, /workReportViewPredicate\(actor\.actor\)/);
  assert.match(page, /<WorkReportAnalyticsTabs canViewSubmissions=\{canViewSubmissions\} \/>/);
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /role="tab"/);
  assert.match(tabs, /role="tabpanel"/);
  assert.match(tabs, /Bài nộp/);
  assert.match(tabs, /Tổng hợp/);
  assert.match(tabs, /useState<"submissions" \| "summary">/);
  // The original analytics dashboard stays the "Tổng hợp" tab.
  assert.match(component, /\/api\/work-reports\/analytics\/overview/);
  assert.match(component, /\/api\/work-reports\/analytics\/breakdown/);
});

test("reader list uses body.data, human labels, server cursor and stale-request isolation", () => {
  assert.match(reader, /parseReaderList\(body\)/);
  assert.match(reader, /body\.data/);
  assert.match(reader, /filter_options\.templates/);
  assert.match(reader, /\/api\/work-reports\/submissions/);
  assert.match(reader, /CursorLoadMore/);
  assert.match(reader, /Xem báo cáo/);
  assert.match(reader, /readerStateLabel\(/);
  assert.match(reader, /generation\.current/);
  assert.match(reader, /AbortController/);
  assert.match(reader, /mergeReaderItems\(current, parsed\.items\)/);
  assert.doesNotMatch(reader, />\{item\.(obligation_id|submission_id|template_id|template_version_id|assignee_app_user_id)\}</);
  assert.doesNotMatch(reader, /JSON\.stringify/);
  // The reader model mirrors the F0 field vocabulary and select-label mapping.
  for (const type of ["integer", "decimal", "boolean", "single_select", "multi_select"]) {
    assert.ok(readerModel.includes(`field.field_type === "${type}"`), `reader model missing ${type}`);
  }
  assert.match(readerModel, /return Array\.isArray\(value\) \? value\.map\(String\)\.join\(", "\) : String\(value\)/);
  assert.match(readerModel, /Có/);
  assert.match(readerModel, /Không/);
  assert.match(readerModel, /option\.option_key === code\)\?\.label/);
  assert.match(readerModel, /return "—"/);
});

test("review inbox loads the full scoped queue without a template UUID input", () => {
  assert.match(reviewsPage, /WORK_REPORTS_API_ENABLED/);
  assert.match(reviewsPage, /workReportReviewPredicate\(resolution\.actor\)/);
  assert.match(reviewUi, /\/api\/work-reports\/reviews\?/);
  assert.match(reviewUi, /page_size: "50"/);
  assert.match(reviewUi, /\/api\/work-reports\/reviews\/\$\{encodeURIComponent\(item\.obligation_id\)\}/);
  assert.match(reviewUi, /\/decision/);
  assert.match(reviewUi, /expected_version: detail\.value\.submission\.version/);
  assert.match(reviewUi, /decision === "REJECT" && !normalizedReason/);
  assert.match(reviewUi, /crypto\.randomUUID\(\)/);
  assert.match(reviewUi, /ReportReadonlyContent/);
  assert.doesNotMatch(reviewUi, /template_id|Mã mẫu|templateId/);
  assert.doesNotMatch(reviewUi, /actor\.(?:role|title)|role_name|job_title|Team Leader|BoD/);
});

test("module navigation exposes authority-driven links with an active state", () => {
  assert.match(nav, /usePathname\(\)/);
  assert.match(nav, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(nav, /role="tablist"|aria-label="Báo cáo công việc"/);
  assert.match(nav, /flex-wrap/);
  assert.match(shell, /workReportAnalyticsPredicate\(actor\)/);
  assert.match(shell, /workReportAssignmentPredicate\(actor\)/);
  assert.match(shell, /workReportTemplateManagePredicate\(actor\)/);
  assert.match(shell, /workReportReviewPredicate\(actor\)/);
  assert.match(shell, /workReportDelegationPredicate\(actor\)/);
  assert.doesNotMatch(shell, /actor\.(?:role|title)|role_name|job_title|Team Leader|BoD/);
});

test("delegation UI consumes server-projected scope/options and versioned revoke contract", () => {
  assert.match(delegationsPage, /workReportDelegationPredicate\(resolution\.actor\)/);
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
