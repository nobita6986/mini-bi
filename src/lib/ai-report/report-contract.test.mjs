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
  projectCapabilityResponse,
  projectUiReportResponse,
  projectEnqueueResponse,
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

// ---------------------------------------------------------------------------
// R1 — Strict projection cho response UI
// ---------------------------------------------------------------------------

const ANALYSIS = {
  contract_version: "business-analysis/0.1",
  period_ref: "week:2026-W41",
  executive_analysis: "Tuyển dụng tuần này tăng nhẹ, chủ yếu ở dự án A.",
  executive_evidence_refs: ["ev_01"],
  findings: [
    { finding_id: "f_01", category: "driver", subject_ref: "project_01", headline: "Dự án A dẫn đầu", analysis: "Dự án A tuyển 5 người, tăng so với tuần trước.", evidence_refs: ["ev_02"], confidence: "medium", limitations: [], recommended_action: "Theo dõi tiếp" },
  ],
  overall_limitations: ["Chất lượng dữ liệu chưa đầy đủ ở một nguồn"],
};

function draftResponse() {
  return {
    ok: true,
    job_id: "11111111-1111-4111-8111-111111111111",
    status: "draft",
    error_code: null,
    attempts: 1,
    max_attempts: 3,
    revision: {
      revision_id: "22222222-2222-4222-8222-222222222222",
      revision_number: 1,
      lifecycle_status: "draft",
      contract_version: "business-analysis/0.1",
      created_at: "2026-10-02T00:00:00.000Z",
      analysis: ANALYSIS,
    },
    review_capability: { approve: false, reject: false, regenerate: true, reason: "review_rpc_pending" },
  };
}

function noDraftResponse() {
  return {
    ok: true,
    job_id: "11111111-1111-4111-8111-111111111111",
    status: "ai_generating",
    error_code: null,
    attempts: 1,
    max_attempts: 3,
    revision: null,
    review_capability: { approve: false, reject: false, regenerate: true, reason: "review_rpc_pending" },
  };
}

test("S01-R1-C1: projectUiReportResponse — draft hợp lệ ⇒ view đầy đủ (không cần type assertion)", () => {
  const result = projectUiReportResponse(draftResponse());
  assert.equal(result.ok, true);
  assert.equal(result.view.job_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(result.view.status, "draft");
  assert.equal(result.view.revision.lifecycle_status, "draft");
  assert.equal(result.view.revision.analysis.executive_analysis, ANALYSIS.executive_analysis);
  assert.equal(result.view.revision.analysis.findings.length, 1);
  assert.equal(result.view.revision.analysis.overall_limitations.length, 1);
});

test("S01-R1-C2: projectUiReportResponse — chưa có draft ⇒ revision null, vẫn có attempts/max_attempts", () => {
  const result = projectUiReportResponse(noDraftResponse());
  assert.equal(result.ok, true);
  assert.equal(result.view.revision, null);
  assert.equal(result.view.status, "ai_generating");
  assert.equal(result.view.attempts, 1);
  assert.equal(result.view.max_attempts, 3);
});

test("S01-R1-C3: projectUiReportResponse — malformed ⇒ AI_INTERNAL (không render dữ liệu một phần)", () => {
  const goodRevision = draftResponse().revision;
  const malformed = [
    ["không phải object", null],
    ["thiếu ok:true", { job_id: "x", status: "draft" }],
    ["ok sai kiểu", { ...draftResponse(), ok: "true" }],
    ["thiếu job_id", { ...draftResponse(), job_id: "" }],
    ["thiếu attempts", { ...draftResponse(), attempts: undefined }],
    ["attempts không phải số", { ...draftResponse(), attempts: "1" }],
    ["revision rỗng object", { ...draftResponse(), revision: {} }],
    ["revision thiếu analysis", { ...draftResponse(), revision: { revision_id: "r", revision_number: 1, lifecycle_status: "draft", contract_version: "x", created_at: "t" } }],
    ["analysis thiếu findings", { ...draftResponse(), revision: { ...goodRevision, analysis: { ...ANALYSIS, findings: undefined } } }],
    ["finding thiếu evidence_refs", { ...draftResponse(), revision: { ...goodRevision, analysis: { ...ANALYSIS, findings: [{ ...ANALYSIS.findings[0], evidence_refs: undefined }] } } }],
    ["confidence sai", { ...draftResponse(), revision: { ...goodRevision, analysis: { ...ANALYSIS, findings: [{ ...ANALYSIS.findings[0], confidence: "super" }] } } }],
  ];
  for (const [label, raw] of malformed) {
    const result = projectUiReportResponse(raw);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "AI_INTERNAL", label);
  }
});

test("S01-R1-C4: projectCapabilityResponse — hợp lệ + malformed fail-closed", () => {
  const ok = projectCapabilityResponse({ ok: true, ai_enabled: true, config_ready: true, review: { approve: false, reject: false, regenerate: true, reason: "review_rpc_pending" } });
  assert.equal(ok.ok, true);
  assert.equal(ok.capability.ai_enabled, true);
  assert.equal(ok.capability.review.regenerate, true);

  for (const raw of [null, {}, { ok: true, ai_enabled: "true", config_ready: true }, { ok: true, ai_enabled: true }]) {
    const result = projectCapabilityResponse(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, "AI_INTERNAL");
  }
});

// ---------------------------------------------------------------------------
// R2 — Strengthen projection: UUID/status/lifecycle/contract/created_at + capability review strict
// ---------------------------------------------------------------------------

test("S01-R2-C1: projectUiReportResponse — UUID/status/lifecycle/contract/created_at sai đều AI_INTERNAL", () => {
  const goodRevision = draftResponse().revision;
  const cases = [
    ["job_id không phải UUID", { ...draftResponse(), job_id: "not-a-uuid" }],
    ["status ngoài tập", { ...draftResponse(), status: "weird" }],
    ["revision_id không phải UUID", { ...draftResponse(), revision: { ...goodRevision, revision_id: "r" } }],
    ["lifecycle_status ngoài tập", { ...draftResponse(), revision: { ...goodRevision, lifecycle_status: "published" } }],
    ["contract_version sai", { ...draftResponse(), revision: { ...goodRevision, contract_version: "business-analysis/9.9" } }],
    ["created_at không parse", { ...draftResponse(), revision: { ...goodRevision, created_at: "hôm qua" } }],
  ];
  for (const [label, raw] of cases) {
    const result = projectUiReportResponse(raw);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "AI_INTERNAL", label);
  }
  // Hợp lệ vẫn pass.
  assert.equal(projectUiReportResponse(draftResponse()).ok, true);
});

test("S01-R2-C2: projectCapabilityResponse — review phải là object với 3 boolean thật + reason non-empty", () => {
  const ok = projectCapabilityResponse({ ok: true, ai_enabled: true, config_ready: true, review: { approve: false, reject: false, regenerate: false, reason: "review_rpc_pending" } });
  assert.equal(ok.ok, true);
  assert.equal(ok.capability.review.regenerate, false, "regenerate=false phải giữ nguyên, không fallback true");

  const bad = [
    ["thiếu review", { ok: true, ai_enabled: true, config_ready: true }],
    ["review không phải object", { ok: true, ai_enabled: true, config_ready: true, review: "yes" }],
    ["regenerate không boolean", { ok: true, ai_enabled: true, config_ready: true, review: { approve: false, reject: false, regenerate: 1, reason: "x" } }],
    ["approve thiếu", { ok: true, ai_enabled: true, config_ready: true, review: { reject: false, regenerate: true, reason: "x" } }],
    ["reason rỗng", { ok: true, ai_enabled: true, config_ready: true, review: { approve: false, reject: false, regenerate: true, reason: "" } }],
    ["reason sai kiểu", { ok: true, ai_enabled: true, config_ready: true, review: { approve: false, reject: false, regenerate: true, reason: 7 } }],
  ];
  for (const [label, raw] of bad) {
    const result = projectCapabilityResponse(raw);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "AI_INTERNAL", label);
  }
});

test("S01-R2-C3: projectEnqueueResponse — UUID/status/boolean bắt buộc, malformed ⇒ AI_INTERNAL", () => {
  const good = { ok: true, request_id: "11111111-1111-4111-8111-111111111111", job_id: "11111111-1111-4111-8111-111111111111", status: "requested", reused: false, cache_hit: false, revision_id: null };
  const ok = projectEnqueueResponse(good);
  assert.equal(ok.ok, true);
  assert.equal(ok.view.job_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(ok.view.reused, false);

  const bad = [
    ["job_id không UUID", { ok: true, job_id: "x", status: "requested", reused: false, cache_hit: false }],
    ["status sai", { ok: true, job_id: "11111111-1111-4111-8111-111111111111", status: "bogus", reused: false, cache_hit: false }],
    ["thiếu reused", { ok: true, job_id: "11111111-1111-4111-8111-111111111111", status: "requested", cache_hit: false }],
    ["cache_hit sai kiểu", { ok: true, job_id: "11111111-1111-4111-8111-111111111111", status: "requested", reused: false, cache_hit: "false" }],
  ];
  for (const [label, raw] of bad) {
    const result = projectEnqueueResponse(raw);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "AI_INTERNAL", label);
  }
});
