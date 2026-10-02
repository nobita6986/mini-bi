/**
 * P1.5-W04 — Dựng context validate output từ packet (KHÔNG gọi AI, không DB).
 *
 * Context này là đầu vào của `validateBusinessAnalysis` (business-analysis/0.1) cộng thêm các
 * cờ enforcement của W04 §4.
 */

/** Context lõi đúng contract business-analysis/0.1 + cờ mở rộng (không thay schema). */
export function buildAnalysisContext(packet) {
  const evidence = (packet.evidence ?? []).map((entry) => ({
    evidence_id: entry.evidence_id,
    value: entry.value,
    unit: entry.unit,
  }));
  const insufficientKeys = (packet.sufficiency ?? [])
    .filter((row) => row.status !== "met")
    .map((row) => row.key);
  const allowedDates = [
    packet.period.start,
    packet.period.end,
    packet.period.comparable ? packet.period.comparable.start : null,
    packet.period.comparable ? packet.period.comparable.end : null,
    ...(packet.series?.points ?? []).flatMap((point) => [point.period_start, point.period_end]),
  ].filter((value) => typeof value === "string");
  return {
    periodRef: packet.period.period_ref,
    evidenceIds: (packet.evidence ?? []).map((entry) => entry.evidence_id),
    subjectRefs: (packet.subjects ?? []).map((subject) => subject.ref).filter((ref) => ref !== "scope"),
    evidence,
    insufficientKeys,
    teamAvailability: packet.team_mapping.availability,
    allowedDates: [...new Set(allowedDates)],
  };
}

import { resolveComparisonReason } from "./payload.mjs";

function filterActive(packet, dimension) {
  const metric = "scope.filter." + dimension + "_active";
  const found = (packet.evidence ?? []).find((entry) => entry.metric === metric);
  return Boolean(found && found.value >= 1);
}

/**
 * Cờ enforcement W04 §4 (dùng cho output guard). Không nằm trong contract output ⇒ không đổi schema.
 */
export function buildEnforcementFlags(packet) {
  const comparisonAvailable = packet.totals.comparable !== null;
  // Dùng CHUNG authority với payload builder (R1: không tự suy diễn fallback).
  const resolved = resolveComparisonReason(packet);
  const comparisonReason = comparisonAvailable ? null : resolved.ok ? resolved.reason : "COMPARISON_REASON_UNRECOGNIZED";

  const sources = packet.data_quality?.sources ?? [];
  const sourceDegraded =
    sources.length === 0 ||
    sources.some((source) => source.status !== "covered" || source.quality !== "ok") ||
    (packet.data_quality.coverage_ratio !== null && packet.data_quality.coverage_ratio < 1);
  const dimensionDegraded = (packet.data_quality?.unknown_count ?? 0) > 0 || (packet.data_quality?.invalid_count ?? 0) > 0;
  /**
   * Chỉ tính là suy giảm DỮ LIỆU khi sufficiency unknown vì lý do NGUỒN (SOURCE_*).
   * Unknown vì comparison không khả dụng (PTD_EQUAL_WINDOW_UNAVAILABLE/COMPARABLE_WINDOW_INCOMPLETE)
   * là giới hạn so sánh, không phải lỗi chất lượng dữ liệu.
   */
  const sufficiencyDegraded = (packet.sufficiency ?? []).some(
    (row) => row.status === "unknown" && typeof row.reason_code === "string" && row.reason_code.startsWith("SOURCE_")
  );

  return {
    comparison_available: comparisonAvailable,
    comparison_reason: comparisonReason,
    team_availability: packet.team_mapping.availability,
    team_partial: packet.team_mapping.availability === "partial",
    data_quality_degraded: sourceDegraded || dimensionDegraded || sufficiencyDegraded,
    source_degraded: sourceDegraded,
    dimension_degraded: dimensionDegraded,
    unknown_count: packet.data_quality?.unknown_count ?? 0,
    invalid_count: packet.data_quality?.invalid_count ?? 0,
    filter_provider_active: filterActive(packet, "provider"),
    filter_project_active: filterActive(packet, "project"),
    filter_recruiter_active: filterActive(packet, "recruiter"),
    filter_employment_active: filterActive(packet, "employment"),
    any_filter_active:
      filterActive(packet, "provider") ||
      filterActive(packet, "project") ||
      filterActive(packet, "recruiter") ||
      filterActive(packet, "employment"),
    insufficient_keys: (packet.sufficiency ?? []).filter((row) => row.status !== "met").map((row) => row.key),
  };
}
