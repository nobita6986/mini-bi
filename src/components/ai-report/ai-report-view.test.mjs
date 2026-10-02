/**
 * P1.5-W05-S01-R1 — Component test CÓ HÀNH VI THẬT: render ReportView qua react-dom/server
 * (không chỉ source.includes) và xác nhận draft render đầy đủ executive/findings/limitations/badge.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ReportView } from "./report-view.ts";

const ANALYSIS = {
  contract_version: "business-analysis/0.1",
  period_ref: "week:2026-W41",
  executive_analysis: "Tuyển dụng tuần này tăng nhẹ, dẫn đầu bởi dự án A.",
  executive_evidence_refs: ["ev_01"],
  findings: [
    {
      finding_id: "f_01",
      category: "provider_mix",
      subject_ref: "project_01",
      headline: "Dự án A phụ thuộc nhiều vào Vendor",
      analysis: "Phần lớn người tuyển của dự án A đến từ nguồn Vendor.",
      evidence_refs: ["ev_02"],
      confidence: "medium",
      limitations: ["Chỉ xét trong phạm vi đang lọc"],
      recommended_action: "Đa dạng nguồn tuyển",
    },
  ],
  overall_limitations: ["Chất lượng dữ liệu chưa đầy đủ ở một nguồn"],
};

test("S01-R1-V1: draft render đầy đủ executive/findings/limitations và badge draft", () => {
  const html = renderToStaticMarkup(createElement(ReportView, { analysis: ANALYSIS, lifecycle: "draft" }));

  assert.ok(html.includes("Tóm tắt điều hành"), "phải có tiêu đề Tóm tắt điều hành");
  assert.ok(html.includes("Tuyển dụng tuần này tăng nhẹ"), "phải render nội dung executive");
  assert.ok(html.includes("Dự án A phụ thuộc nhiều vào Vendor"), "phải render finding headline");
  assert.ok(html.includes("Phụ thuộc Vendor"), "phải gom nhóm provider_mix");
  assert.ok(html.includes("Giới hạn:"), "phải render limitations của finding");
  assert.ok(html.includes("Cảnh báo dữ liệu"), "phải render overall limitations");
  assert.ok(html.includes("Chất lượng dữ liệu chưa đầy đủ"), "phải render nội dung limitation");
  assert.ok(html.includes("Bản nháp AI (chưa duyệt)"), "phải có badge draft rõ ràng");
  assert.ok(html.includes("Minh chứng: ev_02"), "phải render evidence refs");
  assert.ok(html.includes("Đề xuất: Đa dạng nguồn tuyển"), "phải render recommended_action");
});

test("S01-R1-V2: lifecycle khác (approved) không hiện nhãn draft, không có lời nhắc draft", () => {
  const html = renderToStaticMarkup(createElement(ReportView, { analysis: ANALYSIS, lifecycle: "approved" }));
  assert.ok(html.includes("Đã duyệt"), "phải hiện nhãn Đã duyệt");
  assert.ok(!html.includes("Bản nháp do AI tạo"), "không được nhắc 'chưa duyệt' khi approved");
});
