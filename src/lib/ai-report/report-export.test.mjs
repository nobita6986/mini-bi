import assert from "node:assert/strict";
import test from "node:test";

import {
  REPORT_EXPORT_VERSION,
  buildReportExportHtml,
  projectReportExportData,
  reportExportFileName,
} from "./report-export.ts";

const exportData = {
  version: REPORT_EXPORT_VERSION,
  period: {
    ref: "week:2026-09-28:2026-10-03",
    start: "2026-09-28",
    end: "2026-10-03",
    generated_at: "2026-10-03T06:00:00.000Z",
  },
  totals: { current: 30, comparable: 24, delta: 6 },
  trend: [
    { label: "2026-09-28", value: 4 },
    { label: "2026-10-03", value: 8 },
  ],
  dimensions: [
    { key: "project", title: "Tuyển dụng theo dự án", items: [{ label: "Dự án 1", value: 7 }] },
    { key: "provider", title: "Cơ cấu HRP/Vendor", items: [{ label: "Vendor", value: 15 }, { label: "HRP", value: 15 }] },
  ],
  project_provider_mix: [{ label: "Dự án 1", total: 7, hrp: 2, vendor: 5, other: 0 }],
};

const analysis = {
  contract_version: "business-analysis/0.1",
  period_ref: exportData.period.ref,
  executive_analysis: "Tổng quan <script>alert('x')</script>",
  executive_evidence_refs: ["ev_01"],
  findings: [{
    finding_id: "finding_01",
    category: "provider_mix",
    subject_ref: "scope",
    headline: "Phụ thuộc Vendor <img src=x onerror=alert(1)>",
    analysis: "Vendor chiếm tỷ trọng cao.",
    evidence_refs: ["ev_02"],
    confidence: "high",
    limitations: ["Mẫu nhỏ"],
    recommended_action: "Theo dõi thêm.",
  }],
  overall_limitations: ["Chỉ dùng dữ liệu reporting hiện có."],
};

test("projectReportExportData accepts a bounded aggregate projection", () => {
  assert.deepEqual(projectReportExportData(exportData), exportData);
});

test("projectReportExportData rejects malformed mix and oversized data", () => {
  assert.equal(projectReportExportData({ ...exportData, project_provider_mix: [{ ...exportData.project_provider_mix[0], total: 8 }] }), null);
  assert.equal(projectReportExportData({ ...exportData, trend: Array.from({ length: 401 }, (_, index) => ({ label: String(index), value: index })) }), null);
});

test("buildReportExportHtml emits an offline chart report and escapes AI text", () => {
  const html = buildReportExportHtml({
    title: "Báo cáo AI tuần <script>bad()</script>",
    reportCode: "abc12345",
    lifecycleLabel: "Bản nháp",
    revisionCreatedAt: "2026-10-03T06:00:00.000Z",
    analysis,
    exportData,
  });

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Xu hướng tuyển dụng/);
  assert.match(html, /Tỷ lệ HRP\/Vendor theo dự án/);
  assert.match(html, /<svg /);
  assert.match(html, /In \/ Lưu PDF/);
  assert.match(html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("reportExportFileName returns a stable portable HTML name", () => {
  assert.equal(reportExportFileName("Báo cáo AI Tuần 40", "2026-10-03T06:00:00.000Z"), "bao-cao-ai-tuan-40-2026-10-03.html");
});
