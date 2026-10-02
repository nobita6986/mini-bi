/**
 * P1.5-W04 — Idempotency identity cho durable generation job.
 *
 * Identity = hash canonical của 7 nhóm thành phần (period/scope/comparison/access/analytics snapshot/
 * contract versions/prompt+provider+model). Cùng identity ⇒ cùng logical job (enqueue-or-reuse, cache hit).
 * Đổi bất kỳ thành phần nào (kể cả prompt/model version) ⇒ identity mới ⇒ job/revision mới.
 *
 * Không chứa raw data: chỉ hash + version + ref opaque.
 */

import { canonicalHash } from "../engine-shared.mjs";

export const COMPARISON_MODES = Object.freeze(["previous_period", "period_to_date_equal_window", "unavailable", "none"]);

export const IDENTITY_COMPONENT_KEYS = Object.freeze([
  "period",
  "scope",
  "comparison_mode",
  "access_scope_hash",
  "snapshot_hash",
  "packet_contract_version",
  "output_contract_version",
  "prompt_version",
  "provider_key",
  "model_key",
  "adapter_version",
]);

function normalizeFilters(filters) {
  const source = filters && typeof filters === "object" ? filters : {};
  const keys = Object.keys(source).sort();
  const out = {};
  for (const key of keys) {
    const value = source[key];
    out[key] = Array.isArray(value) ? [...value].sort() : value === undefined ? null : value;
  }
  return out;
}

/** Chuẩn hoá input identity (deterministic, không phụ thuộc thứ tự key/array). */
export function normalizeIdentityInput(input) {
  const period = input?.period ?? {};
  const scope = input?.scope ?? {};
  return {
    period: {
      period_ref: String(period.period_ref ?? ""),
      type: String(period.type ?? ""),
      start: String(period.start ?? ""),
      end: String(period.end ?? ""),
      status: String(period.status ?? ""),
      elapsed_days: Number.isInteger(period.elapsed_days) ? period.elapsed_days : 0,
    },
    scope: {
      dimensions: Array.isArray(scope.dimensions) ? [...scope.dimensions].sort() : [],
      filters: normalizeFilters(scope.filters),
      focus: typeof scope.focus === "string" && scope.focus.trim() !== "" ? scope.focus.trim() : null,
    },
    comparison_mode: String(input?.comparison_mode ?? "none"),
    access_scope_hash: String(input?.access_scope_hash ?? ""),
    snapshot_hash: String(input?.snapshot_hash ?? ""),
    packet_contract_version: String(input?.packet_contract_version ?? ""),
    output_contract_version: String(input?.output_contract_version ?? ""),
    prompt_version: String(input?.prompt_version ?? ""),
    provider_key: String(input?.provider_key ?? ""),
    model_key: String(input?.model_key ?? ""),
    adapter_version: String(input?.adapter_version ?? ""),
  };
}

/**
 * Identity hash. Trả { ok, identity_hash, components } hoặc { ok:false, code, message } khi thiếu
 * thành phần bắt buộc (fail-closed: không bao giờ enqueue job với identity rỗng).
 */
export function buildJobIdentity(input) {
  const components = normalizeIdentityInput(input);
  const missing = [];
  for (const key of IDENTITY_COMPONENT_KEYS) {
    const value = components[key];
    if (value === "" || value === null || value === undefined) missing.push(key);
  }
  if (!components.period.period_ref || !components.period.type) missing.push("period.period_ref");
  if (missing.length > 0) {
    return { ok: false, code: "AI_INPUT_INVALID", message: "identity thiếu thành phần: " + [...new Set(missing)].sort().join(", ") };
  }
  return { ok: true, identity_hash: canonicalHash(components), components };
}

/** Chỉ dùng cho status/debug: mô tả ngắn KHÔNG chứa raw data. */
export function describeIdentity(components) {
  return [
    components.period.type + ":" + components.period.period_ref,
    "scope=" + components.scope.dimensions.join("+"),
    "filters=" + Object.keys(components.scope.filters).sort().join("+"),
    "comparison=" + components.comparison_mode,
    "prompt=" + components.prompt_version,
    "provider=" + components.provider_key + "/" + components.model_key + "@" + components.adapter_version,
  ].join(" | ");
}
