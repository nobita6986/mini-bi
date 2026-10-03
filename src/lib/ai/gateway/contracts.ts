/**
 * P1.5-W04 — Kiểu dữ liệu cho AI gateway + durable generation job.
 *
 * CHỈ type (không runtime, không secret, không DB). Mọi module runtime của gateway là .mjs để
 * Node chạy test trực tiếp được (chỉ dùng specifier có extension).
 */

import type { BusinessAnalysis } from "../../analytics/contracts/business-analysis";
import type { AnalysisPacket } from "../../analytics/contracts/analysis-packet";

export type JobStatus =
  | "requested"
  | "queued"
  | "computing"
  | "ai_generating"
  | "validating"
  | "draft"
  | "failed_input"
  | "failed_config"
  | "failed_provider_transient"
  | "failed_provider_permanent"
  | "failed_validation"
  | "failed_budget"
  | "failed_internal";

/** Mã lỗi gateway (fail-closed, trả cho caller; không lộ chi tiết nội bộ). */
export type GatewayErrorCode =
  | "AI_DISABLED"
  | "AI_CONFIG_REQUIRED"
  | "AI_POLICY_REQUIRED"
  | "AI_RATE_LIMITED"
  | "AI_CONCURRENCY_LIMITED"
  | "AI_BUDGET_LIMITED"
  | "AI_PROVIDER_DISABLED"
  | "AI_PROVIDER_TIMEOUT"
  | "AI_PROVIDER_RATE_LIMITED"
  | "AI_PROVIDER_TRANSIENT"
  | "AI_PROVIDER_PERMANENT"
  | "AI_PROVIDER_MALFORMED"
  | "AI_PROVIDER_OVERSIZED"
  | "AI_VALIDATION_FAILED"
  | "AI_INPUT_INVALID"
  | "AI_JOB_NOT_FOUND"
  | "AI_WORKER_UNAUTHORIZED"
  | "AI_CSRF_REJECTED"
  | "AI_INTERNAL";

export interface PromptManifest {
  prompt_version: string;
  compatible_packet_contract: string;
  compatible_output_contract: string;
  payload_schema_version: string;
  role: string;
  system_instruction: string;
  developer_instruction: string;
  rules: { rule_id: string; text: string }[];
  manifest_hash: string;
}

/** Payload đã tối giản gửi cho provider — KHÔNG chứa raw data/stable id/display. */
export interface ProviderPayload {
  payload_version: string;
  prompt_version: string;
  packet_contract_version: string;
  output_contract_version: string;
  period: {
    period_ref: string;
    type: string;
    start: string;
    end: string;
    status: string;
    elapsed_days: number;
    comparison_available: boolean;
    comparison_reason: string | null;
    comparable: { period_ref: string; start: string; end: string; elapsed_days: number } | null;
  };
  totals: { current: number; comparable: number | null; delta: number | null; delta_pct: number | null };
  stability: Record<string, unknown>;
  sufficiency: { key: string; required_points: number; actual_points: number; status: string; reason_code: string }[];
  drivers: { dimension: string; entries: { subject_ref: string; current: number; comparable: number | null; delta: number | null; delta_contribution_share: number | null; share_of_current: number | null }[] }[];
  concentration: Record<string, { top1_ref: string | null; top1_share: number | null; top3_share: number | null; distinct_subjects: number }>;
  project_provider_mix: { subject_ref: string; project_total: number; hrp_count: number; vendor_count: number; unknown_count: number; invalid_count: number; known_total: number; hrp_share: number | null; vendor_share: number | null; known_coverage: number | null }[] | null;
  provider_composition_allowed: boolean;
  team_mapping: { availability: string; mapped_recruited_count: number; unmapped_recruited_count: number; ambiguous_recruited_count: number; coverage_ratio: number | null; teams_in_scope: number; reason_code: string };
  data_quality: { coverage_ratio: number | null; unknown_count: number; invalid_count: number; unknown_share: number | null; invalid_share: number | null; sources: { source_ref: string; status: string; quality: string }[] };
  filter_context: { project_active: number; recruiter_active: number; provider_active: number; employment_active: number; conditional_scope: boolean };
  subject_refs: string[];
  evidence: { evidence_id: string; metric: string; subject_ref: string; value: number; unit: string; sufficiency: string; quality: string }[];
  refs: { scope_hash: string; snapshot_hash: string; lineage_ref: string; access_scope_hash: string };
  payload_hash: string;
}

export interface AiProviderRequest {
  payload: ProviderPayload;
  promptManifest: PromptManifest;
  modelConfig: { provider_key: string; model_key: string; adapter_version: string; timeout_ms: number };
  timeoutSignal?: AbortSignal;
  /** Một repair call tối đa sau khi strict validator từ chối output đầu tiên. */
}

export interface AiProviderUsage {
  input_tokens: number | null;
  output_tokens: number | null;
}

export type AiProviderResult =
  | {
      ok: true;
      raw_text: string;
      structured: unknown;
      usage: AiProviderUsage;
      latency_ms: number;
      provider_version: string;
      model_key: string;
    }
  | { ok: false; error_code: GatewayErrorCode; retryable: boolean; latency_ms: number; provider_version: string; detail_ref: string };

export interface AiProviderAdapter {
  readonly provider_key: string;
  readonly adapter_version: string;
  generateStructured(request: AiProviderRequest): Promise<AiProviderResult>;
}

export interface JobIdentityInput {
  period: { period_ref: string; type: string; start: string; end: string; status: string; elapsed_days: number };
  scope: { dimensions: string[]; filters: Record<string, string[] | null>; focus: string | null };
  comparison_mode: string;
  access_scope_hash: string;
  snapshot_hash: string;
  packet_contract_version: string;
  output_contract_version: string;
  prompt_version: string;
  provider_key: string;
  model_key: string;
  adapter_version: string;
}

export interface JobRecord {
  job_id: string;
  identity_hash: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  error_code: string | null;
  revision_id: string | null;
  packet: AnalysisPacket;
}

export interface EnqueueResult {
  job_id: string;
  status: JobStatus;
  reused: boolean;
  cache_hit: boolean;
  revision_id: string | null;
}

export interface RunJobResult {
  kind: "idle" | "completed" | "failed" | "retry_scheduled" | "lease_lost";
  job_id: string | null;
  status: JobStatus | null;
  error_code: GatewayErrorCode | null;
  revision_id: string | null;
  attempts: number | null;
  next_attempt_at: string | null;
}

export interface PolicyContext {
  now_ms: number;
  actor_ref: string;
  access_scope_hash: string;
  recent_requests: number[];
  active_jobs: number;
  attempts: number;
  tokens_used_today: number;
}

export interface PolicyConfig {
  window_ms: number;
  max_requests_per_window: number;
  max_concurrent_jobs: number;
  max_attempts: number;
  provider_timeout_ms: number;
  max_response_bytes: number;
  max_payload_bytes: number;
  daily_token_ceiling: number;
}

export interface GeneratedAnalysisEnvelope {
  analysis: BusinessAnalysis;
  raw_text_ref: string;
}
