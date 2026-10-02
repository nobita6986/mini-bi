/**
 * P1.5-W04 — Payload minimization: dựng payload gửi provider bằng WHITELIST.
 *
 * - Không spread packet/server object; mọi field được liệt kê tường minh.
 * - Không raw row, không PII, không display/tên thật, không Drive/source id, không ref_map/
 *   server_diagnostics, không stable UUID, không cấu hình/secret, không audit actor, không prompt tự do.
 * - Khi evidence scope.filter.provider_active = 1: KHÔNG gửi project_provider_mix và tắt mọi
 *   provider-composition feature (model không thể kết luận cơ cấu tổng thể).
 */

import { canonicalJson, canonicalHash } from "../engine-shared.mjs";
import { scanProhibitedContent } from "../../analytics/contracts/shared.mjs";
import { OUTPUT_CONTRACT, PACKET_CONTRACT, PAYLOAD_SCHEMA_VERSION } from "./prompt-registry.mjs";

export const PAYLOAD_LIMITS = Object.freeze({
  max_payload_bytes: 256 * 1024,
  max_evidence: 120,
  max_drivers_per_dimension: 20,
  max_mix_rows: 20,
  max_subject_refs: 400,
  max_sources: 50,
});

/** Key TUYỆT ĐỐI không được xuất hiện trong payload gửi provider. */
export const PAYLOAD_FORBIDDEN_KEYS = Object.freeze([
  "ref_map",
  "server_diagnostics",
  "diagnostics",
  "recruiter_id",
  "team_id",
  "membership_id",
  "alias_id",
  "change_id",
  "provider_membership_type",
  "recruiter_key",
  "project_key",
  "provider_type_key",
  "employment_type_key",
  "display",
  "recruiter_display",
  "project_display",
  "provider_type_display",
  "employment_type_display",
  "file_name",
  "drive_file_id",
  "source_id",
  "raw_row",
  "raw_value",
  "rows",
  "packet",
  "actor_ref",
  "lease_owner",
  "lease_token",
  "api_key",
  "authorization",
  "provider_error",
  "stack",
  "prompt_override",
]);

const FORBIDDEN_VALUE_PATTERNS = Object.freeze([
  { code: "PAYLOAD_STABLE_UUID", re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/ },
  { code: "PAYLOAD_STABLE_ID_PREFIX", re: /\b(?:rcr|team|alias|pm|tm|aud)_[0-9]{3}\b/ },
]);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableNumber(value) {
  return isFiniteNumber(value) ? value : null;
}

function filterActive(packet, dimension) {
  const metric = "scope.filter." + dimension + "_active";
  const found = (packet.evidence ?? []).find((entry) => entry.metric === metric);
  if (!found) return null;
  return isFiniteNumber(found.value) && found.value >= 1 ? 1 : 0;
}

/** Comparison reason deterministic (khớp evidence comparison.unavailable.* khi có). */
export function comparisonReasonOf(packet) {
  if (packet.totals?.comparable !== null) return null;
  const evidence = packet.evidence ?? [];
  if (evidence.some((entry) => entry.metric === "comparison.unavailable.ptd_equal_window_unavailable")) {
    return "PTD_EQUAL_WINDOW_UNAVAILABLE";
  }
  if (evidence.some((entry) => entry.metric === "comparison.unavailable.comparable_window_incomplete")) {
    return "COMPARABLE_WINDOW_INCOMPLETE";
  }
  return packet.period?.comparable === null ? "PTD_EQUAL_WINDOW_UNAVAILABLE" : "COMPARABLE_WINDOW_INCOMPLETE";
}

function buildFilterContext(packet) {
  const flags = {
    project_active: filterActive(packet, "project"),
    recruiter_active: filterActive(packet, "recruiter"),
    provider_active: filterActive(packet, "provider"),
    employment_active: filterActive(packet, "employment"),
  };
  const known = Object.values(flags).filter((value) => value !== null);
  return {
    project_active: flags.project_active ?? 0,
    recruiter_active: flags.recruiter_active ?? 0,
    provider_active: flags.provider_active ?? 0,
    employment_active: flags.employment_active ?? 0,
    conditional_scope: known.some((value) => value === 1),
  };
}

function buildEvidence(packet, limit) {
  const rows = [];
  for (const entry of packet.evidence ?? []) {
    if (rows.length >= limit) break;
    rows.push({
      evidence_id: entry.evidence_id,
      metric: entry.metric,
      subject_ref: entry.subject_ref,
      value: entry.value,
      unit: entry.unit,
      sufficiency: entry.sufficiency,
      quality: entry.quality,
    });
  }
  return rows;
}

function buildDrivers(packet, limit) {
  const out = [];
  for (const dimension of ["project", "recruiter", "team", "provider", "employment"]) {
    const entries = (packet.drivers?.[dimension] ?? []).slice(0, limit).map((entry) => ({
      subject_ref: entry.subject_ref,
      current: entry.current,
      comparable: nullableNumber(entry.comparable),
      delta: nullableNumber(entry.delta),
      delta_contribution_share: nullableNumber(entry.delta_contribution_share),
      share_of_current: nullableNumber(entry.share_of_current),
    }));
    if (entries.length > 0) out.push({ dimension, entries });
  }
  return out;
}

function buildMix(packet, limit) {
  return (packet.project_provider_mix ?? []).slice(0, limit).map((row) => ({
    subject_ref: row.subject_ref,
    project_total: row.project_total,
    hrp_count: row.hrp_count,
    vendor_count: row.vendor_count,
    unknown_count: row.unknown_count,
    invalid_count: row.invalid_count,
    known_total: row.known_total,
    hrp_share: nullableNumber(row.hrp_share),
    vendor_share: nullableNumber(row.vendor_share),
    known_coverage: nullableNumber(row.known_coverage),
  }));
}

/**
 * Dựng payload provider. Trả { ok:true, payload } hoặc { ok:false, code, message, path }.
 * Fail-closed: payload chứa nội dung bị cấm ⇒ KHÔNG gửi provider.
 */
export function buildProviderPayload(packet, manifest) {
  if (!packet || typeof packet !== "object") {
    return { ok: false, code: "AI_INPUT_INVALID", message: "packet thiếu", path: "packet" };
  }
  const filterContext = buildFilterContext(packet);
  const comparisonReason = comparisonReasonOf(packet);
  const providerFiltered = filterContext.provider_active === 1;

  const core = {
    payload_version: PAYLOAD_SCHEMA_VERSION,
    prompt_version: manifest.prompt_version,
    packet_contract_version: PACKET_CONTRACT,
    output_contract_version: OUTPUT_CONTRACT,
    period: {
      period_ref: packet.period.period_ref,
      type: packet.period.type,
      start: packet.period.start,
      end: packet.period.end,
      status: packet.period.status,
      elapsed_days: packet.period.elapsed_days,
      comparison_available: packet.totals.comparable !== null,
      comparison_reason: comparisonReason,
      comparable: packet.period.comparable
        ? {
            period_ref: packet.period.comparable.period_ref,
            start: packet.period.comparable.start,
            end: packet.period.comparable.end,
            elapsed_days: packet.period.comparable.elapsed_days,
          }
        : null,
    },
    totals: {
      current: packet.totals.current,
      comparable: nullableNumber(packet.totals.comparable),
      delta: nullableNumber(packet.totals.delta),
      delta_pct: nullableNumber(packet.totals.delta_pct),
    },
    stability: {
      formula: packet.stability.formula,
      formula_version: packet.stability.formula_version,
      period_points: packet.stability.period_points,
      mean: nullableNumber(packet.stability.mean),
      stddev: nullableNumber(packet.stability.stddev),
      cv: nullableNumber(packet.stability.cv),
      trend_direction: packet.stability.trend_direction,
      volatility: packet.stability.volatility,
    },
    sufficiency: (packet.sufficiency ?? []).map((row) => ({
      key: row.key,
      required_points: row.required_points,
      actual_points: row.actual_points,
      status: row.status,
      reason_code: row.reason_code,
    })),
    drivers: buildDrivers(packet, PAYLOAD_LIMITS.max_drivers_per_dimension),
    concentration: Object.fromEntries(
      ["project", "recruiter", "team", "provider", "employment"].map((dimension) => {
        const entry = packet.concentration?.[dimension] ?? {};
        return [
          dimension,
          {
            top1_ref: entry.top1_ref ?? null,
            top1_share: nullableNumber(entry.top1_share),
            top3_share: nullableNumber(entry.top3_share),
            distinct_subjects: isFiniteNumber(entry.distinct_subjects) ? entry.distinct_subjects : 0,
          },
        ];
      })
    ),
    /**
     * Provider-composition chỉ được gửi khi KHÔNG lọc theo provider. Khi provider_active = 1,
     * gửi mix sẽ cho phép model kết luận cơ cấu tổng thể từ một tập đã bị lọc.
     */
    project_provider_mix: providerFiltered ? null : buildMix(packet, PAYLOAD_LIMITS.max_mix_rows),
    provider_composition_allowed: !providerFiltered,
    team_mapping: {
      availability: packet.team_mapping.availability,
      mapped_recruited_count: packet.team_mapping.mapped_recruited_count,
      unmapped_recruited_count: packet.team_mapping.unmapped_recruited_count,
      ambiguous_recruited_count: packet.team_mapping.ambiguous_recruited_count,
      coverage_ratio: nullableNumber(packet.team_mapping.coverage_ratio),
      teams_in_scope: packet.team_mapping.teams_in_scope,
      reason_code: packet.team_mapping.reason_code,
    },
    data_quality: {
      coverage_ratio: nullableNumber(packet.data_quality.coverage_ratio),
      unknown_count: packet.data_quality.unknown_count,
      invalid_count: packet.data_quality.invalid_count,
      unknown_share: nullableNumber(packet.data_quality.unknown_share),
      invalid_share: nullableNumber(packet.data_quality.invalid_share),
      sources: (packet.data_quality.sources ?? []).slice(0, PAYLOAD_LIMITS.max_sources).map((source) => ({
        source_ref: source.source_ref,
        status: source.status,
        quality: source.quality,
      })),
    },
    filter_context: filterContext,
    subject_refs: (packet.subjects ?? []).slice(0, PAYLOAD_LIMITS.max_subject_refs).map((subject) => subject.ref),
    evidence: buildEvidence(packet, PAYLOAD_LIMITS.max_evidence),
    refs: {
      scope_hash: packet.scope.scope_hash,
      snapshot_hash: packet.snapshot.hash,
      lineage_ref: packet.snapshot.lineage_ref,
      access_scope_hash: packet.scope.access_scope_hash,
    },
  };

  const forbidden = scanForbiddenKeys(core);
  if (forbidden) return { ok: false, code: "AI_INPUT_INVALID", message: forbidden.message, path: forbidden.path };
  const prohibited = scanProhibitedContent(core);
  if (prohibited) return { ok: false, code: "AI_INPUT_INVALID", message: prohibited.message, path: prohibited.path };
  const secretLike = scanForbiddenValues(core);
  if (secretLike) return { ok: false, code: "AI_INPUT_INVALID", message: secretLike.message, path: secretLike.path };

  const size = canonicalJson(core).length;
  if (size > PAYLOAD_LIMITS.max_payload_bytes) {
    return { ok: false, code: "AI_BUDGET_LIMITED", message: "payload vượt trần " + PAYLOAD_LIMITS.max_payload_bytes + " bytes", path: "payload" };
  }

  const payload = { ...core, payload_hash: canonicalHash(core) };
  return { ok: true, payload };
}

/** Quét key bị cấm (đệ quy) — dùng cả cho test. */
export function scanForbiddenKeys(value, path = "$") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = scanForbiddenKeys(value[i], path + "[" + i + "]");
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (PAYLOAD_FORBIDDEN_KEYS.includes(key)) {
        return { path: path + "." + key, message: "payload chứa key bị cấm: " + key };
      }
      const hit = scanForbiddenKeys(value[key], path + "." + key);
      if (hit) return hit;
    }
  }
  return null;
}

/** Quét value giống stable id/secret (đệ quy). */
export function scanForbiddenValues(value, path = "$") {
  if (typeof value === "string") {
    for (const { code, re } of FORBIDDEN_VALUE_PATTERNS) {
      if (re.test(value)) return { path, message: "payload chứa value bị cấm (" + code + ")" };
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = scanForbiddenValues(value[i], path + "[" + i + "]");
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const hit = scanForbiddenValues(value[key], path + "." + key);
      if (hit) return hit;
    }
  }
  return null;
}
