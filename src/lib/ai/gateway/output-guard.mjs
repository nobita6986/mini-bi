/**
 * P1.5-W04 — Output guard: strict validation + enforcement bổ sung (W04 §4).
 *
 * - Chạy `validateBusinessAnalysis` (business-analysis/0.1) với context dựng từ packet.
 * - Thêm luật W04: comparison unavailable, team gate, data quality, filter context, unknown/invalid,
 *   raw identifier trong output.
 * - KHÔNG bao giờ sửa output thầm lặng; KHÔNG biến lỗi thành report rỗng/success.
 */

import { validateBusinessAnalysis } from "../../analytics/contracts/business-analysis.ts";
import { scanForbiddenValues } from "./payload.mjs";
import { buildAnalysisContext, buildEnforcementFlags } from "./validation-context.mjs";

export const COMPARISON_LIMITATION_PATTERNS = Object.freeze([
  /chưa\s+đủ\s+(?:dữ\s+liệu|điều\s+kiện)\s+(?:để\s+)?so\s+sánh/i,
  /không\s+(?:thể|đủ\s+dữ\s+liệu)\s+so\s+sánh/i,
  /thiếu\s+(?:dữ\s+liệu|điều\s+kiện)\s+so\s+sánh/i,
  /chưa\s+(?:có|có\s+đủ)\s+kỳ\s+so\s+sánh/i,
  /không\s+có\s+kỳ\s+so\s+sánh/i,
  /chưa\s+thể\s+kết\s+luận\s+(?:về\s+)?xu\s+hướng/i,
]);

export const DATA_QUALITY_LIMITATION_PATTERNS = Object.freeze([
  /chất\s+lượng\s+dữ\s+liệu/i,
  /dữ\s+liệu\s+(?:chưa|không)\s+đầy\s+đủ/i,
  /nguồn\s+dữ\s+liệu/i,
  /độ\s+phủ/i,
  /không\s+xác\s+định|không\s+hợp\s+lệ/i,
  /unknown|invalid/i,
]);

export const FILTER_SCOPE_PATTERNS = Object.freeze([/trong\s+phạm\s+vi/i]);
export const NO_ATTRIBUTION_PATTERNS = Object.freeze([/không\s+(?:quy|đổ)\s+(?:trách\s+nhiệm|lỗi)/i, /không\s+kết\s+luận\s+(?:về\s+)?cá\s+nhân/i]);

const PERSON_SUBJECT_RE = /^(?:recruiter|team)_[0-9]{2,}$/;
const UNKNOWN_INVALID_TOKENS_RE = /không\s+xác\s+định|không\s+hợp\s+lệ|unknown|invalid/i;
const COMPARISON_CATEGORIES = Object.freeze(["trend", "driver"]);
const PROVIDER_CLAIM_RE = /hrp|vendor|phụ\s+thuộc/i;

function fail(code, message, path) {
  return { ok: false, code, message, path };
}

function textOf(report) {
  const parts = [report.executive_analysis];
  for (const finding of report.findings ?? []) {
    parts.push(finding.headline, finding.analysis, finding.recommended_action ?? "");
    for (const limitation of finding.limitations ?? []) parts.push(limitation);
  }
  for (const limitation of report.overall_limitations ?? []) parts.push(limitation);
  return parts.filter((value) => typeof value === "string").join(" \n ");
}

function anyMatch(text, patterns) {
  return patterns.some((re) => re.test(text));
}

/**
 * Validate output AI. Trả { ok:true, value } hoặc { ok:false, code, message, path }.
 * @param analysis output thô đã parse JSON
 * @param packet packet đã pass strict validator
 */
export function validateGeneratedAnalysis(analysis, packet) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    return fail("AI_VALIDATION_FAILED", "output không phải JSON object", "analysis");
  }

  // 0. Raw identifier/stable id trong output ⇒ reject (contract scanner không phủ dạng này).
  const rawIdentifier = scanForbiddenValues(analysis);
  if (rawIdentifier) {
    return fail("RAW_IDENTIFIER_IN_OUTPUT", rawIdentifier.message, rawIdentifier.path);
  }

  // 1. Strict contract + grounding (evidence id/số/ngày/unit/team/baseline/PII/secret/HR language).
  const context = buildAnalysisContext(packet);
  const contractResult = validateBusinessAnalysis(analysis, context);
  if (!contractResult.ok) {
    return fail(contractResult.code === "UNKNOWN_FIELD" ? "AI_VALIDATION_FAILED" : contractResult.code, contractResult.message, contractResult.path ?? "analysis");
  }
  const report = contractResult.value;
  const flags = buildEnforcementFlags(packet);
  const text = textOf(report);

  // 2. Comparison unavailable ⇒ cấm mọi finding so sánh/trend/delta/contribution + bắt buộc nêu limitation.
  if (!flags.comparison_available) {
    for (let i = 0; i < report.findings.length; i++) {
      const finding = report.findings[i];
      if (COMPARISON_CATEGORIES.includes(finding.category)) {
        return fail(
          "COMPARISON_UNAVAILABLE_FINDING",
          "comparison không khả dụng (" + flags.comparison_reason + ") nhưng có finding " + finding.category,
          "findings[" + i + "]"
        );
      }
      if (finding.delta !== undefined) {
        return fail("COMPARISON_UNAVAILABLE_FINDING", "finding chứa delta khi comparison không khả dụng", "findings[" + i + "]");
      }
    }
    if (!anyMatch(text, COMPARISON_LIMITATION_PATTERNS)) {
      return fail(
        "COMPARISON_UNAVAILABLE_LIMITATION_REQUIRED",
        "executive_analysis/limitations phải nêu chưa đủ điều kiện so sánh",
        "executive_analysis"
      );
    }
  }

  // 3. Team gate.
  if (flags.team_availability === "unavailable" || flags.team_availability === "ambiguous") {
    for (let i = 0; i < report.findings.length; i++) {
      const finding = report.findings[i];
      if (finding.subject_ref.startsWith("team_")) {
        return fail("TEAM_FINDING_WHEN_UNAVAILABLE", "team mapping " + flags.team_availability + " nhưng có finding team", "findings[" + i + "]");
      }
      if (/\bteam\b/i.test(finding.analysis) && !anyMatch(text, DATA_QUALITY_LIMITATION_PATTERNS)) {
        return fail("TEAM_FINDING_WHEN_UNAVAILABLE", "nhắc team khi mapping không khả dụng mà không nêu giới hạn", "findings[" + i + "]");
      }
    }
  }
  if (flags.team_partial) {
    for (let i = 0; i < report.findings.length; i++) {
      const finding = report.findings[i];
      if (!finding.subject_ref.startsWith("team_")) continue;
      if (finding.confidence === "high" || finding.limitations.length === 0) {
        return fail("TEAM_FINDING_WITHOUT_COVERAGE_LIMITATION", "team mapping partial: finding team phải có limitation và không high confidence", "findings[" + i + "]");
      }
    }
  }

  // 4. Data quality suy giảm ⇒ bắt buộc limitation về dữ liệu (không auto-approve).
  if (flags.data_quality_degraded && !anyMatch(text, DATA_QUALITY_LIMITATION_PATTERNS)) {
    return fail(
      "DATA_QUALITY_LIMITATION_REQUIRED",
      "dữ liệu suy giảm (source/unknown/invalid/sufficiency) nhưng output không nêu limitation dữ liệu",
      "overall_limitations"
    );
  }

  // 5. Filter context: provider filter bật ⇒ cấm kết luận cơ cấu tổng thể.
  if (flags.filter_provider_active) {
    for (let i = 0; i < report.findings.length; i++) {
      const finding = report.findings[i];
      const findingText = [finding.headline, finding.analysis, finding.recommended_action ?? "", ...finding.limitations].join(" ");
      if (finding.category === "provider_mix" && finding.subject_ref === "scope") {
        return fail("PROVIDER_COMPOSITION_CLAIM_WHILE_FILTERED", "provider filter đang bật: không được kết luận cơ cấu HRP/Vendor toàn scope", "findings[" + i + "]");
      }
      if (PROVIDER_CLAIM_RE.test(findingText) && !anyMatch(findingText, FILTER_SCOPE_PATTERNS)) {
        return fail("PROVIDER_COMPOSITION_CLAIM_WHILE_FILTERED", "kết luận HRP/Vendor phải nêu 'trong phạm vi đang lọc'", "findings[" + i + "]");
      }
    }
  } else if (flags.any_filter_active) {
    for (let i = 0; i < report.findings.length; i++) {
      const finding = report.findings[i];
      const findingText = [finding.headline, finding.analysis].join(" ");
      if (/(?:^|\s)(?:toàn\s+scope|toàn\s+bộ|tổng\s+thể)(?:\s|$)/i.test(findingText) && !anyMatch(findingText, FILTER_SCOPE_PATTERNS)) {
        return fail("PROVIDER_COMPOSITION_CLAIM_WHILE_FILTERED", "kết luận toàn bộ trong khi scope đang lọc phải nêu 'trong phạm vi đang lọc'", "findings[" + i + "]");
      }
    }
  }

  // 6. Unknown/invalid: không quy trách nhiệm cho cá nhân/team.
  if (flags.unknown_count > 0 || flags.invalid_count > 0) {
    for (let i = 0; i < report.findings.length; i++) {
      const finding = report.findings[i];
      if (!PERSON_SUBJECT_RE.test(finding.subject_ref)) continue;
      const findingText = [finding.headline, finding.analysis, ...finding.limitations].join(" ");
      if (UNKNOWN_INVALID_TOKENS_RE.test(findingText) && !anyMatch(findingText, NO_ATTRIBUTION_PATTERNS)) {
        return fail(
          "SUBJECT_ATTRIBUTION_FOR_UNKNOWN_INVALID",
          "không được quy unknown/invalid cho cá nhân/team khi chưa xác định owner",
          "findings[" + i + "]"
        );
      }
    }
  }

  // 7. Baseline chưa đủ ⇒ không high confidence (validator đã chặn, khẳng định lại để rõ ràng).
  if (flags.insufficient_keys.length > 0) {
    for (let i = 0; i < report.findings.length; i++) {
      if (report.findings[i].confidence === "high") {
        return fail("HIGH_CONFIDENCE_WITHOUT_SUFFICIENCY", "baseline chưa đạt (" + flags.insufficient_keys.join(",") + ")", "findings[" + i + "]");
      }
    }
  }

  return {
    ok: true,
    value: report,
    flags: { ...flags, requires_review: true, auto_approved: false },
  };
}
