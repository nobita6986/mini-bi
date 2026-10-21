import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererPath = new URL("./work-report-form-renderer.tsx", import.meta.url);
const inboxPath = new URL("./my-obligations.tsx", import.meta.url);

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
