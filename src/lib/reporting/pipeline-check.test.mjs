import assert from "node:assert/strict";
import { test } from "node:test";

import { computePipelineData } from "./pipeline-check.ts";

const srcA = {
  id: "src-a",
  drive_file_id: "drive-file-a",
  file_name: "Sheet A",
  sheet_name: "Sheet1",
  active: true,
  first_seen_at: "2026-10-01T01:00:00Z",
  last_seen_at: "2026-10-02T01:00:00Z",
  last_successful_sync_at: "2026-10-02T01:00:00Z",
};

const srcB = {
  id: "src-b",
  drive_file_id: "drive-file-b",
  file_name: "Sheet B",
  sheet_name: "Sheet1",
  active: false,
  first_seen_at: "2026-10-01T01:00:00Z",
  last_seen_at: null,
  last_successful_sync_at: null,
};

function run(over) {
  return {
    run_id: "run-1",
    source_id: "src-a",
    status: "succeeded",
    started_at: "2026-10-02T00:00:00Z",
    finished_at: "2026-10-02T00:00:05Z",
    rows_read: 0,
    rows_valid: 0,
    rows_rejected: 0,
    rows_warned: 0,
    warning_issues: 0,
    error_code: null,
    ...over,
  };
}

test("database trống: không nguồn, không run, không snapshot, không issue", () => {
  const data = computePipelineData([], [], [], []);
  assert.equal(data.overview.sourcesTotal, 0);
  assert.equal(data.overview.sourcesActive, 0);
  assert.equal(data.overview.latestRunStatus, null);
  assert.deepEqual(data.overview.totals, { rowsRead: 0, rowsValid: 0, rowsRejected: 0, rowsWarned: 0, warningIssues: 0 });
  assert.equal(data.snapshot.recruitedTotal, 0);
  assert.equal(data.snapshot.breakdownGroups, 0);
  assert.equal(data.sources.length, 0);
  assert.equal(data.issues.length, 0);
});

test("có nguồn nhưng chưa có run", () => {
  const data = computePipelineData([srcA], [], [], []);
  assert.equal(data.overview.sourcesTotal, 1);
  assert.equal(data.overview.latestRunStatus, null);
  assert.equal(data.sources[0].latestRun, null);
  assert.equal(data.overview.totals.rowsRead, 0);
});

test("run partial: phản ánh rejected và trạng thái partial", () => {
  const data = computePipelineData(
    [srcA],
    [run({ status: "partial", rows_read: 7, rows_valid: 5, rows_rejected: 2, rows_warned: 0, warning_issues: 0 })],
    [],
    []
  );
  assert.equal(data.overview.latestRunStatus, "partial");
  assert.equal(data.sources[0].latestRun.status, "partial");
  assert.equal(data.overview.totals.rowsRejected, 2);
  assert.equal(data.overview.totals.rowsRead, 7);
});

test("run failed: giữ error_code, không có snapshot", () => {
  const data = computePipelineData(
    [srcA],
    [run({ status: "failed", error_code: "SOURCE_READ_FAILED", rows_read: 0 })],
    [],
    []
  );
  assert.equal(data.overview.latestRunStatus, "failed");
  assert.equal(data.sources[0].latestRun.errorCode, "SOURCE_READ_FAILED");
  assert.equal(data.snapshot.breakdownGroups, 0);
  assert.equal(data.snapshot.recruitedTotal, 0);
});

test("snapshot: tổng, nhóm và phân bố theo chiều đúng", () => {
  const breakdown = [
    { source_id: "src-a", business_date: "2026-10-01", project_display: "Dự án A", recruiter_display: "Nguyễn Văn A", provider_type_display: "HRP", employment_type_display: "Thời vụ", recruited_count: 3 },
    { source_id: "src-a", business_date: "2026-10-01", project_display: "Dự án A", recruiter_display: "Nguyễn Văn A", provider_type_display: "HRP", employment_type_display: "Chính thức", recruited_count: 1 },
    { source_id: "src-b", business_date: "2026-10-01", project_display: "Dự án Z", recruiter_display: "Lê Văn C", provider_type_display: "Vendor", employment_type_display: "Chính thức", recruited_count: 5 },
  ];
  const data = computePipelineData([srcA, srcB], [], breakdown, []);

  assert.equal(data.snapshot.recruitedTotal, 9);
  assert.equal(data.snapshot.breakdownGroups, 3);

  assert.equal(data.snapshot.byDateSource.length, 2);
  const rowA = data.snapshot.byDateSource.find((r) => r.fileName === "Sheet A");
  const rowB = data.snapshot.byDateSource.find((r) => r.fileName === "Sheet B");
  assert.equal(rowA.recruitedCount, 4);
  assert.equal(rowA.groups, 2);
  assert.equal(rowB.recruitedCount, 5);
  assert.equal(rowB.groups, 1);

  const hrp = data.snapshot.byProvider.find((d) => d.label === "HRP");
  assert.equal(hrp.groups, 2);
  assert.equal(hrp.recruited, 4);
  const vendor = data.snapshot.byProvider.find((d) => d.label === "Vendor");
  assert.equal(vendor.recruited, 5);

  assert.equal(data.snapshot.byProject[0].label, "Dự án Z");
  assert.equal(data.snapshot.byProject[0].recruited, 5);
  assert.equal(data.snapshot.byProject[1].label, "Dự án A");
  assert.equal(data.snapshot.byProject[1].groups, 2);
});

test("issues: gắn file_name theo source; source đã xóa -> '(đã xóa)'", () => {
  const errors = [
    { source_id: "src-a", source_row_number: 12, issue_level: "error", error_code: "MISSING_DATE", created_at: "2026-10-02T00:00:01Z" },
    { source_id: "ghost", source_row_number: null, issue_level: "error", error_code: "SOURCE_READ_FAILED", created_at: null },
  ];
  const data = computePipelineData([srcA], [], [], errors);
  assert.equal(data.issues.length, 2);
  assert.equal(data.issues[0].fileName, "Sheet A");
  assert.equal(data.issues[1].fileName, "(đã xóa)");
});
