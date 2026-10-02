/**
 * P1.5-W03 — Contract của deterministic analytics feature engine.
 *
 * CHỈ type: không runtime, không DB, không AI, không secret.
 * Packet-facing input KHÔNG chứa stable id/display/raw row — chỉ opaque ref.
 */

import type { AnalysisPacket } from "../analytics/contracts/analysis-packet";

export type PeriodType = "week" | "month" | "quarter" | "custom";
export type Dimension = "project" | "recruiter" | "team" | "provider" | "employment";
export type SourceStatus = "covered" | "incomplete" | "stale_snapshot" | "never_succeeded" | "running" | "no_run";
export type QualityStatus = "ok" | "partial" | "failed" | "unknown";
export type SufficiencyStatus = "met" | "not_met" | "unknown";
export type DimensionQuality = "ok" | "unknown" | "invalid";
export type IdentityClassificationInput = "mapped" | "unmapped" | "ambiguous";
export type TeamAvailabilityInput = "available" | "partial" | "unavailable" | "ambiguous";

/** Filter/scope đã chuẩn hóa (key thô chỉ nằm server-side, không vào packet). */
export interface ScopeFiltersInput {
  project_keys?: readonly string[];
  recruiter_keys?: readonly string[];
  provider_type_keys?: readonly string[];
  employment_type_keys?: readonly string[];
}

export interface AnalysisRequestInput {
  period: {
    type: PeriodType;
    /** Ngày "hôm nay" theo Asia/Ho_Chi_Minh (YYYY-MM-DD). */
    as_of_date: string;
    custom_from?: string | null;
    custom_to?: string | null;
  };
  scope?: {
    dimensions?: readonly Dimension[];
    filters?: ScopeFiltersInput;
  };
}

/** Fact aggregate từ reporting read-model (có key thô — CHỈ dùng server-side). */
export interface ReportingFactInput {
  business_date: string;
  project_key: string;
  recruiter_key: string;
  provider_type_key: string;
  employment_type_key: string;
  recruited_count: number;
  /** Opaque source ref (source_NN) — KHÔNG phải source_id thật. */
  source_ref: string;
}

/** Source-health projection (opaque ref + trạng thái; không filename/Drive ID). */
export interface SourceHealthInput {
  source_ref: string;
  status: SourceStatus;
  quality: QualityStatus;
  has_current_facts: boolean;
}

export interface EngineMetadataInput {
  /** UTC datetime ISO (Z) — do caller truyền, engine không đọc đồng hồ hệ thống. */
  generated_at: string;
  generated_from: string;
  /** Hash lineage của snapshot nguồn (chỉ là hash). */
  lineage_ref: string;
  /** Hash của access scope (RBAC) — chỉ là hash. */
  access_scope_hash: string;
}

/** Team coverage của MỘT window (đầu ra G2 — W02), chỉ để phản chiếu vào packet. */
export interface TeamCoverageInput {
  availability: TeamAvailabilityInput;
  mapped_recruited_count: number;
  unmapped_recruited_count: number;
  ambiguous_recruited_count: number;
  coverage_ratio: number | null;
  teams_in_scope: number;
  reason_code: string;
}

/**
 * Fact đã gắn identity packet-facing: KHÔNG có recruiter_id/team_id/display.
 * `recruiter_quality` là kết luận sentinel của recruiter_key (key thô không đi vào engine).
 */
export interface EngineFactRow {
  business_date: string;
  project_key: string;
  provider_type_key: string;
  employment_type_key: string;
  recruited_count: number;
  source_ref: string;
  recruiter_ref: string | null;
  team_ref: string | null;
  identity_classification: IdentityClassificationInput;
  recruiter_quality: DimensionQuality;
}

/** Đầu vào engine (đã resolve identity qua G2 ở tầng builder). */
export interface FeatureEngineInput {
  request: AnalysisRequestInput;
  facts: readonly EngineFactRow[];
  source_health: readonly SourceHealthInput[];
  /** Team coverage current window (G2, đã redaction) + comparable window. */
  team: {
    current: TeamCoverageInput;
    comparable: TeamCoverageInput | null;
  };
  metadata: EngineMetadataInput;
}

export interface EngineWindowDetail {
  period_ref: string;
  start: string;
  end: string;
  elapsed_days: number;
}

export interface EngineDataQualityDetail {
  expected_sources: number;
  sources_with_current_facts: number;
  coverage_ratio: number | null;
  /** Người thuộc grain có ≥1 chiều unknown (độc lập với invalid). */
  unknown_any_count: number;
  /** Người thuộc grain có ≥1 chiều invalid (độc lập với unknown). */
  invalid_any_count: number;
  /** Người thuộc grain vừa unknown vừa invalid. */
  overlap_count: number;
  /** Giá trị đi vào packet (không đếm trùng một grain ở cả hai chỉ số). */
  unknown_count: number;
  invalid_count: number;
  quality: QualityStatus;
  basis_degraded: boolean;
  degraded_reasons: string[];
}

/** Chi tiết server-side của engine (KHÔNG gửi AI; không chứa key thô/stable id). */
export interface EngineDetail {
  current: EngineWindowDetail;
  comparable: EngineWindowDetail | null;
  baseline_counts: {
    trend_weekly: number;
    trend_monthly: number;
    trend_quarterly: number;
    day_of_week: number;
    consistency: number;
  };
  data_quality: EngineDataQualityDetail;
  sufficiency: { key: string; required_points: number; actual_points: number; status: SufficiencyStatus; reason_code: string }[];
  breakdown_remainder: Record<Dimension, number>;
  refs: { projects: number; recruiters: number; teams: number; sources: number };
  evidence_count: number;
}

export type EngineError = { ok: false; code: string; message: string; path: string };
export type EngineResult = { ok: true; packet: AnalysisPacket; detail: EngineDetail } | EngineError;

export type ValidationResult<T> = { ok: true; value: T } | EngineError;
