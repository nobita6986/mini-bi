/**
 * P1.5-W05-S01 — Test thuần cho contract phía client của UI báo cáo AI.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildReportRequest,
  codeToMessage,
  groupFindings,
  isActiveJobStatus,
  isFailedJobStatus,
  jobStatusLabel,
  lifecycleLabel,
} from "./report-contract.ts";

test("S01-C1: buildReportRequest — week/custom/focus/scope đúng contract validateAnalyticsRequest", () => {
  const week = buildReportRequest({
    period_type: "week",
    as_of_date: "2026-10-11",
    dimensions: ["project", "provider", "employment"],
  });
  assert.deepEqual(week.period, { type: "week", as_of_date: "2026-10-11" });
  assert.deepEqual(week.scope, { dimensions: ["project", "provider", "employment"] });
  assert.equal("focus" in week, false);

  const custom = buildReportRequest({
    period_type: "custom",
    as_of_date: "2026-10-11",
    custom_from: "2026-09-01",
    custom_to: "2026-09-30",
    dimensions: ["project"],
    focus: "  Điểm mạnh/yếu  ",
  });
  assert.deepEqual(custom.period, { type: "custom", as_of_date: "2026-10-11", custom_from: "2026-09-01", custom_to: "2026-09-30" });
  assert.equal(custom.focus, "Điểm mạnh/yếu");
});

test("S01-C2: trạng thái job — active/failed/retryable và nhãn tiếng Việt ổn định", () => {
  for (const status of ["requested", "queued", "computing", "ai_generating", "validating"]) {
    assert.equal(isActiveJobStatus(status), true, status);
  }
  for (const status of ["failed_input", "failed_config", "failed_provider_transient", "failed_provider_permanent", "failed_validation", "failed_budget", "failed_internal"]) {
    assert.equal(isFailedJobStatus(status), true, status);
  }
  assert.equal(isActiveJobStatus("draft"), false);
  assert.equal(isFailedJobStatus("draft"), false);
  assert.equal(jobStatusLabel("ai_generating"), "AI đang phân tích");
  assert.equal(jobStatusLabel("draft"), "Bản nháp AI");
  assert.equal(jobStatusLabel("not-a-status"), "not-a-status");
});

test("S01-C3: mã lỗi → thông điệp an toàn (không echo chi tiết nội bộ)", () => {
  assert.equal(codeToMessage("AI_DISABLED").kind, "unavailable");
  assert.equal(codeToMessage("AI_CONFIG_REQUIRED").text, "Chưa có cấu hình provider hoạt động.");
  assert.equal(codeToMessage("AI_RATE_LIMITED").kind, "limit");
  assert.equal(codeToMessage("AI_BUDGET_LIMITED").kind, "limit");
  assert.equal(codeToMessage("AI_IDENTITY_CATALOG_REQUIRED").text.includes("P1.6"), true);
  assert.equal(codeToMessage("SOME_UNKNOWN").kind, "error");
  assert.equal(codeToMessage("SOME_UNKNOWN").text.includes("SOME_UNKNOWN"), false);
  assert.equal(codeToMessage(null).kind, "error");
});

test("S01-C4: groupFindings gom đúng nhóm thời điểm/cá nhân/nhóm/vendor/khác", () => {
  const findings = [
    { finding_id: "f_01", category: "time_pattern", subject_ref: "scope", headline: "H1", analysis: "A1", evidence_refs: ["ev_01"], confidence: "medium", limitations: [], recommended_action: null },
    { finding_id: "f_02", category: "driver", subject_ref: "recruiter_01", headline: "H2", analysis: "A2", evidence_refs: ["ev_02"], confidence: "low", limitations: [], recommended_action: "R2" },
    { finding_id: "f_03", category: "risk", subject_ref: "team_01", headline: "H3", analysis: "A3", evidence_refs: ["ev_03"], confidence: "high", limitations: ["L"], recommended_action: null },
    { finding_id: "f_04", category: "provider_mix", subject_ref: "project_01", headline: "H4", analysis: "A4", evidence_refs: ["ev_04"], confidence: "medium", limitations: [], recommended_action: null },
    { finding_id: "f_05", category: "trend", subject_ref: "scope", headline: "H5", analysis: "A5", evidence_refs: ["ev_05"], confidence: "low", limitations: [], recommended_action: null },
  ];
  const groups = groupFindings(findings);
  const byKey = Object.fromEntries(groups.map((group) => [group.key, group.items.length]));
  assert.deepEqual(byKey, { time: 1, individual: 1, team: 1, vendor: 1, other: 1 });
  assert.equal(groups[0].label, "Thời điểm");
  assert.equal(groups.find((group) => group.key === "vendor").label, "Phụ thuộc Vendor");
});

test("S01-C5: lifecycle label phân biệt draft/approved/rejected", () => {
  assert.equal(lifecycleLabel("draft"), "Bản nháp AI (chưa duyệt)");
  assert.equal(lifecycleLabel("approved"), "Đã duyệt");
  assert.equal(lifecycleLabel("rejected"), "Đã từ chối");
  assert.equal(lifecycleLabel("other"), "—");
  assert.equal(lifecycleLabel(null), "—");
});
