import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererPath = new URL("./work-report-form-renderer.tsx", import.meta.url);
const inboxPath = new URL("./my-obligations.tsx", import.meta.url);
const assignmentManagerPath = new URL("./assignment-manager.tsx", import.meta.url);
const assignmentPagePath = new URL("../../../app/work-reports/assignments/page.tsx", import.meta.url);

test("dynamic renderer covers all eight F0 field types and preserves disabled fieldset semantics", async () => {
  const source = await readFile(rendererPath, "utf8");
  for (const type of ["textarea", "integer", "decimal", "date", "boolean", "single_select", "multi_select"]) {
    assert.ok(source.includes(`field.field_type === "${type}"`), `renderer missing ${type}`);
  }
  assert.match(source, /type="text"/);
  assert.match(source, /validateWorkReportSubmission\(schema, payload/);
  assert.match(source, /disabled=\{!canEdit \|\| busy\}/);
  assert.match(source, /Lịch sử các lần nộp/);
});

test("inbox exposes loading and explicit retryable error states", async () => {
  const source = await readFile(inboxPath, "utf8");
  assert.match(source, /Đang tải nghĩa vụ báo cáo/);
  assert.match(source, /Không tải được danh sách báo cáo/);
  assert.match(source, /Tải lại/);
});

test("assignment page resolves the request actor and requires report_assign scope server-side", async () => {
  const source = await readFile(assignmentPagePath, "utf8");
  assert.match(source, /resolveActorForRequest\(\)/);
  assert.match(source, /decideWorkReportAssignmentsPageAccess\(\{ actor \}\)/);
  assert.match(source, /case "ACCESS_DENIED": return <AccessDenied \/>/);
  assert.doesNotMatch(source, /actor\.(?:role|title)|role_name|job_title/i);
});

test("assignment form loads scoped templates and targets without accepting client identity", async () => {
  const source = await readFile(assignmentManagerPath, "utf8");
  assert.match(source, /response\.status === 403/);
  assert.match(source, /WORK_REPORT_ACCESS_DENIED/);
  assert.match(source, /fetch\(`\/api\/work-reports\/assignments\$\{query\}`/);
  assert.match(source, /Danh sách nhân viên được xác định từ liên kết tài khoản và thành viên nhóm hiện hành/);
  assert.doesNotMatch(source, /nhập mã định danh|UUID, cách nhau/i);
  assert.match(source, /disabled=\{busy \|\| !templates\.length \|\| !teamId \|\| !templatesLoaded\}/);
});
