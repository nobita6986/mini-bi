/**
 * P1.5-W04-R1 — Payload minimization: dựng payload gửi provider bằng WHITELIST + CLOSURE.
 *
 * Nguyên tắc R1:
 * - Không spread packet/server object; mọi field liệt kê tường minh.
 * - CLOSURE: mọi subject_ref xuất hiện trong drivers/concentration/mix/evidence phải có trong subject_refs;
 *   mọi feature số gửi model phải có evidence tương ứng (metric + subject) — nếu không thì field đó = null
 *   hoặc feature bị prune; không bao giờ gửi số vô căn cứ.
 * - Budget: prune deterministic theo thứ tự feature; không thể giữ core evidence ⇒ AI_BUDGET_LIMITED.
 * - Kích thước tính bằng UTF-8 bytes (Buffer.byteLength), không dùng string.length.
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

export const DIMENSION_ORDER = Object.freeze(["project", "recruiter", "team", "provider", "employment"]);

/**
 * R2 — Mapping RÕ RÀNG cho vocabulary legacy của fixture G1 (12 golden packet).
 * Key = metric legacy, value = metric canonical tương ứng. Chỉ dùng khi metric canonical
 * KHÔNG có trong packet ⇒ legacy evidence vẫn ground được feature, không bịa số.
 */
export const LEGACY_METRIC_MAP = Object.freeze({
  recruited_total_previous: "recruited_total_comparable",
  team_delta: "driver.team.delta",
  team_delta_share: "driver.team.delta_contribution_share",
  project_total: "project_mix.total",
  project_vendor_share: "project_mix.vendor_share",
});

/** Metric legacy (theo vocabulary fixture G1). */
export const LEGACY_METRIC_KEYS = Object.freeze(Object.keys(LEGACY_METRIC_MAP));

/** Phân loại vocabulary evidence của packet (canonical vs legacy) — dùng cho test/handoff. */
export function classifyEvidenceVocabulary(packet) {
  const canonical = [];
  const legacy = [];
  const canonicalValues = new Set(Object.values(LEGACY_METRIC_MAP));
  for (const entry of packet?.evidence ?? []) {
    const metric = entry.metric ?? "";
    if (LEGACY_METRIC_KEYS.includes(metric)) legacy.push(metric);
    else if (canonicalValues.has(metric) || metric.startsWith("driver.") || metric.startsWith("data_quality.") || metric.startsWith("scope.filter.") || metric.startsWith("concentration.") || metric.startsWith("stability.") || metric.startsWith("comparison.") || metric.startsWith("breakdown_remainder.")) {
      canonical.push(metric);
    } else canonical.push(metric);
  }
  return { canonical: [...new Set(canonical)].sort(), legacy: [...new Set(legacy)].sort() };
}

/** Lý do comparison deterministic (evidence do W03 phát). */
export const COMPARISON_REASON_METRICS = Object.freeze({
  PTD_EQUAL_WINDOW_UNAVAILABLE: "comparison.unavailable.ptd_equal_window_unavailable",
  COMPARABLE_WINDOW_INCOMPLETE: "comparison.unavailable.comparable_window_incomplete",
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

export function utf8ByteLength(value) {
  const text = typeof value === "string" ? value : canonicalJson(value);
  if (typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function") {
    return Buffer.byteLength(text, "utf8");
  }
  return new TextEncoder().encode(text).length;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableNumber(value) {
  return isFiniteNumber(value) ? value : null;
}

function fail(code, message, path) {
  return { ok: false, code, message, path };
}

/**
 * Resolve lý do comparison — FAIL-CLOSED (R1):
 * khi totals.comparable = null phải có ĐÚNG MỘT evidence reason được công nhận và khớp period semantics.
 * Trả { ok:true, reason|null } hoặc { ok:false, code, message }.
 */
export function resolveComparisonReason(packet) {
  if (!packet || typeof packet !== "object" || !packet.totals || !packet.period) {
    return fail("AI_INPUT_INVALID", "packet thiếu totals/period để xác định comparison", "packet");
  }
  if (packet.totals.comparable !== null) return { ok: true, reason: null };

  const present = [];
  for (const [reason, metric] of Object.entries(COMPARISON_REASON_METRICS)) {
    const found = (packet.evidence ?? []).filter((entry) => entry.metric === metric);
    if (found.length > 0) present.push({ reason, count: found.length });
  }
  if (present.length === 0) {
    return fail("AI_INPUT_INVALID", "comparable null nhưng thiếu evidence lý do comparison", "packet.evidence");
  }
  if (present.length > 1 || present[0].count > 1) {
    return fail("AI_INPUT_INVALID", "comparable null nhưng có nhiều evidence lý do comparison xung đột", "packet.evidence");
  }

  const reason = present[0].reason;
  const isPeriodToDate = packet.period.status === "period_to_date";
  const hasComparableWindow = packet.period.comparable !== null && packet.period.comparable !== undefined;
  if (reason === "PTD_EQUAL_WINDOW_UNAVAILABLE") {
    if (!isPeriodToDate || hasComparableWindow) {
      return fail("AI_INPUT_INVALID", "lý do PTD_EQUAL_WINDOW_UNAVAILABLE không khớp period semantics", "packet.period");
    }
  } else if (reason === "COMPARABLE_WINDOW_INCOMPLETE") {
    if (!hasComparableWindow) {
      return fail("AI_INPUT_INVALID", "lý do COMPARABLE_WINDOW_INCOMPLETE nhưng period.comparable = null", "packet.period");
    }
  }
  return { ok: true, reason };
}

/** Tương thích: trả reason hoặc null (KHÔNG tự suy diễn fallback). */
export function comparisonReasonOf(packet) {
  const resolved = resolveComparisonReason(packet);
  return resolved.ok ? resolved.reason : null;
}

function filterActive(packet, dimension) {
  const metric = "scope.filter." + dimension + "_active";
  const found = (packet.evidence ?? []).find((entry) => entry.metric === metric);
  if (!found) return null;
  return isFiniteNumber(found.value) && found.value >= 1 ? 1 : 0;
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

function evidenceKey(metric, subjectRef) {
  return metric + "|" + subjectRef;
}

/** Index evidence của packet theo (metric, subject). */
function indexEvidence(packet) {
  const map = new Map();
  for (const entry of packet.evidence ?? []) {
    const key = evidenceKey(entry.metric, entry.subject_ref);
    if (!map.has(key)) map.set(key, entry);
  }
  return map;
}

/** Core evidence: scope-level + stability/data-quality/filter/comparison (không bao giờ prune). */
function isCoreEvidence(entry) {
  if (entry.subject_ref === "scope") return true;
  const metric = entry.metric ?? "";
  if (metric.startsWith("stability.") || metric.startsWith("data_quality.") || metric.startsWith("scope.filter.")) return true;
  if (metric.startsWith("comparison.unavailable.")) return true;
  return false;
}

/**
 * Thu feature theo subject và giá trị số CHỈ khi có evidence tương ứng (metric + subject).
 * Trả { features, requiredEvidence:Set<key>, referencedRefs:Set<string> }.
 */
function collectSubjectFeatures(packet, providerFiltered, limits) {
  const evidenceIndex = indexEvidence(packet);
  const features = [];
  const referenced = new Set();

  const aliasFor = (metric) => {
    for (const [legacyMetric, canonicalMetric] of Object.entries(LEGACY_METRIC_MAP)) {
      if (canonicalMetric === metric) return legacyMetric;
    }
    return null;
  };

  /**
   * C (R3) — Grounding CHẶT: evidence phải khớp metric + subject_ref + value + unit.
   * Nếu không khớp (kể cả khi có evidence cùng metric/subject nhưng value/unit lệch) ⇒ KHÔNG gửi số đó.
   */
  const numberWithEvidence = (metric, subjectRef, value, unit) => {
    if (!isFiniteNumber(value)) return null;
    const candidates = [
      evidenceIndex.get(evidenceKey(metric, subjectRef)),
      (() => {
        const alias = aliasFor(metric);
        return alias === null ? undefined : evidenceIndex.get(evidenceKey(alias, subjectRef));
      })(),
    ];
    for (const entry of candidates) {
      if (!entry) continue;
      if (entry.value !== value) continue;
      if (typeof unit === "string" && entry.unit !== unit) continue;
      return { value, evidence: entry };
    }
    return null;
  };

  for (const dimension of DIMENSION_ORDER) {
    if (dimension === "team" && packet.team_mapping?.availability !== "available" && packet.team_mapping?.availability !== "partial") {
      continue;
    }
    const entries = [...(packet.drivers?.[dimension] ?? [])].sort(
      (a, b) => b.current - a.current || (a.subject_ref < b.subject_ref ? -1 : a.subject_ref > b.subject_ref ? 1 : 0)
    );
    let kept = 0;
    const keptEntries = [];
    const keptEvidence = [];
    for (const entry of entries) {
      if (kept >= limits.max_drivers_per_dimension) break;
      const current = numberWithEvidence("driver." + dimension + ".current", entry.subject_ref, entry.current, "people");
      if (!current) continue; // thiếu evidence ⇒ feature không được gửi
      const comparable = packet.totals.comparable === null ? null : numberWithEvidence("driver." + dimension + ".comparable", entry.subject_ref, entry.comparable, "people");
      const delta = packet.totals.comparable === null ? null : numberWithEvidence("driver." + dimension + ".delta", entry.subject_ref, entry.delta, "people");
      const contribution = numberWithEvidence("driver." + dimension + ".delta_contribution_share", entry.subject_ref, entry.delta_contribution_share, "ratio");
      const share = numberWithEvidence("driver." + dimension + ".share_of_current", entry.subject_ref, entry.share_of_current, "ratio");
      keptEntries.push({
        subject_ref: entry.subject_ref,
        current: current.value,
        comparable: comparable === null ? null : comparable.value,
        delta: delta === null ? null : delta.value,
        delta_contribution_share: contribution === null ? null : contribution.value,
        share_of_current: share === null ? null : share.value,
      });
      for (const candidate of [current, comparable, delta, contribution, share]) {
        if (candidate) keptEvidence.push(candidate.evidence);
      }
      kept += 1;
    }
    if (keptEntries.length > 0) {
      features.push({ kind: "driver", dimension, subjects: keptEntries.map((entry) => entry.subject_ref), evidence: keptEvidence, entry: { dimension, entries: keptEntries } });
      for (const entry of keptEntries) referenced.add(entry.subject_ref);
    }
  }

  if (!providerFiltered && Array.isArray(packet.project_provider_mix) && packet.project_provider_mix.length > 0) {
    const rows = [...packet.project_provider_mix]
      .sort((a, b) => (a.subject_ref < b.subject_ref ? -1 : a.subject_ref > b.subject_ref ? 1 : 0))
      .slice(0, limits.max_mix_rows);
    const keptRows = [];
    const keptEvidence = [];
    for (const row of rows) {
      const total = numberWithEvidence("project_mix.total", row.subject_ref, row.project_total, "people");
      const hrpCount = numberWithEvidence("project_mix.hrp_count", row.subject_ref, row.hrp_count, "people");
      const vendorCount = numberWithEvidence("project_mix.vendor_count", row.subject_ref, row.vendor_count, "people");
      const unknownCount = numberWithEvidence("project_mix.unknown_count", row.subject_ref, row.unknown_count, "people");
      const invalidCount = numberWithEvidence("project_mix.invalid_count", row.subject_ref, row.invalid_count, "people");
      const knownTotal = numberWithEvidence("project_mix.known_total", row.subject_ref, row.known_total, "people");
      // Row chỉ được gửi khi TOÀN BỘ count có evidence khớp ⇒ mix row luôn tự nhất quán (total = hrp+vendor+unknown+invalid).
      if (!total || !hrpCount || !vendorCount || !unknownCount || !invalidCount || !knownTotal) continue;
      const hrp = numberWithEvidence("project_mix.hrp_share", row.subject_ref, row.hrp_share, "ratio");
      const vendor = numberWithEvidence("project_mix.vendor_share", row.subject_ref, row.vendor_share, "ratio");
      const coverage = numberWithEvidence("project_mix.known_coverage", row.subject_ref, row.known_coverage, "ratio");
      keptRows.push({
        subject_ref: row.subject_ref,
        project_total: total.value,
        hrp_count: hrpCount.value,
        vendor_count: vendorCount.value,
        unknown_count: unknownCount.value,
        invalid_count: invalidCount.value,
        known_total: knownTotal.value,
        hrp_share: hrp === null ? null : hrp.value,
        vendor_share: vendor === null ? null : vendor.value,
        known_coverage: coverage === null ? null : coverage.value,
      });
      for (const candidate of [total, hrpCount, vendorCount, unknownCount, invalidCount, knownTotal, hrp, vendor, coverage]) {
        if (candidate) keptEvidence.push(candidate.evidence);
      }
    }
    if (keptRows.length > 0) {
      features.push({ kind: "mix", subjects: keptRows.map((row) => row.subject_ref), evidence: keptEvidence, rows: keptRows });
      for (const row of keptRows) referenced.add(row.subject_ref);
    }
  }

  return { features, referenced, evidenceIndex };
}

/**
 * Concentration (R2): giữ NGUYÊN semantics của packet khi subject tương ứng còn trong feature set.
 * - top1_ref/top1_share giữ khi ref còn trong featureRefs VÀ evidence scope-level tồn tại;
 * - chỉ null khi subject đã bị prune (hoặc evidence thiếu);
 * - top3_share giữ khi có evidence (là chỉ số scope-level, không phụ thuộc subject cụ thể);
 * - không tạo subject_ref mồ côi (top1_ref luôn nằm trong featureRefs).
 */
function buildConcentration(packet, evidenceIndex, featureRefs) {
  const out = {};
  for (const dimension of DIMENSION_ORDER) {
    const entry = packet.concentration?.[dimension] ?? {};
    const top1 = evidenceIndex.get(evidenceKey("concentration." + dimension + ".top1_share", "scope"));
    const top3 = evidenceIndex.get(evidenceKey("concentration." + dimension + ".top3_share", "scope"));
    const candidateRef = typeof entry.top1_ref === "string" && entry.top1_ref !== "scope" ? entry.top1_ref : null;
    const top1Ref = candidateRef !== null && featureRefs.has(candidateRef) ? candidateRef : null;
    const keepShare = top1 !== undefined && top1Ref !== null;
    out[dimension] = {
      top1_ref: keepShare ? top1Ref : null,
      top1_share: keepShare ? nullableNumber(entry.top1_share) : null,
      top3_share: top3 ? nullableNumber(entry.top3_share) : null,
      distinct_subjects: isFiniteNumber(entry.distinct_subjects) ? entry.distinct_subjects : 0,
    };
  }
  return out;
}

function assemblePayload({ packet, manifest, filterContext, comparisonReason, features, keptRefs, limits, additionalLimit = 0 }) {
  const coreEvidence = (packet.evidence ?? []).filter(isCoreEvidence);
  const featureEvidence = features.flatMap((feature) => feature.evidence);
  /**
   * Tier 3 — evidence bổ sung: mọi evidence còn lại của packet (đã sort deterministic).
   * Vẫn bảo đảm closure (subject_ref được thêm vào subject_refs) nhưng KHÔNG dùng để ground feature số
   * (feature số luôn cần evidence khớp metric+subject ở tier 2) ⇒ không có số vô căn cứ.
   */
  const requiredKeys = new Set([...coreEvidence, ...featureEvidence].map((entry) => evidenceKey(entry.metric, entry.subject_ref)));
  const additionalEvidence = [...(packet.evidence ?? [])]
    .filter((entry) => !requiredKeys.has(evidenceKey(entry.metric, entry.subject_ref)))
    .sort((a, b) => (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : a.subject_ref < b.subject_ref ? -1 : a.subject_ref > b.subject_ref ? 1 : 0))
    .slice(0, Math.max(0, additionalLimit));
  const seen = new Set();
  const evidence = [];
  for (const entry of [...coreEvidence, ...featureEvidence, ...additionalEvidence]) {
    const key = evidenceKey(entry.metric, entry.subject_ref);
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({
      evidence_id: entry.evidence_id,
      metric: entry.metric,
      subject_ref: entry.subject_ref,
      value: entry.value,
      unit: entry.unit,
      sufficiency: entry.sufficiency,
      quality: entry.quality,
    });
    if (entry.subject_ref !== "scope") keptRefs.add(entry.subject_ref);
  }

  // drivers giữ dạng MẢNG [{ dimension, entries }] (đúng contract ProviderPayload) và chỉ gồm
  // dimension có entry ⇒ feature thiếu evidence không tồn tại trong payload.
  const drivers = [];
  let mix = null;
  for (const feature of features) {
    if (feature.kind === "driver") drivers.push(feature.entry);
    else if (feature.kind === "mix") mix = feature.rows;
  }

  const providerFiltered = filterContext.provider_active === 1;
  return {
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
    drivers,
    concentration: {},
    project_provider_mix: providerFiltered ? null : mix,
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
      sources: (packet.data_quality.sources ?? []).slice(0, limits.max_sources).map((source) => ({
        source_ref: source.source_ref,
        status: source.status,
        quality: source.quality,
      })),
    },
    filter_context: filterContext,
    subject_refs: [...keptRefs].sort(),
    evidence,
    refs: {
      scope_hash: packet.scope.scope_hash,
      snapshot_hash: packet.snapshot.hash,
      lineage_ref: packet.snapshot.lineage_ref,
      access_scope_hash: packet.scope.access_scope_hash,
    },
  };
}

/**
 * Dựng payload provider với closure + prune deterministic.
 * @param packet packet đã pass strict validator
 * @param manifest prompt manifest
 * @param options { max_payload_bytes }
 */
export function buildProviderPayload(packet, manifest, options = {}) {
  if (!packet || typeof packet !== "object") return fail("AI_INPUT_INVALID", "packet thiếu", "packet");
  const limits = { ...PAYLOAD_LIMITS, ...(isFiniteNumber(options.max_payload_bytes) ? { max_payload_bytes: options.max_payload_bytes } : {}) };

  const comparison = resolveComparisonReason(packet);
  if (!comparison.ok) return comparison;

  const filterContext = buildFilterContext(packet);
  const providerFiltered = filterContext.provider_active === 1;
  const collected = collectSubjectFeatures(packet, providerFiltered, limits);

  const allPacketEvidence = packet.evidence ?? [];
  if (allPacketEvidence.length === 0) {
    return fail("AI_INPUT_INVALID", "packet không có evidence nào để phân tích", "packet.evidence");
  }

  let features = collected.features;
  let additionalLimit = allPacketEvidence.length;

  for (;;) {
    // Refs của feature CÒN LẠI (dùng cho closure + concentration semantics).
    const featureRefs = new Set();
    for (const feature of features) for (const ref of feature.subjects) featureRefs.add(ref);
    const concentration = buildConcentration(packet, collected.evidenceIndex, featureRefs);

    const coreRefs = new Set();
    for (const entry of allPacketEvidence) {
      if (isCoreEvidence(entry) && entry.subject_ref !== "scope") coreRefs.add(entry.subject_ref);
    }
    const keptRefs = new Set([...featureRefs, ...coreRefs]);
    for (const dimension of DIMENSION_ORDER) {
      const top1 = concentration[dimension]?.top1_ref;
      if (typeof top1 === "string" && top1 !== "scope") keptRefs.add(top1);
    }

    const payloadCore = assemblePayload({
      packet,
      manifest,
      filterContext,
      comparisonReason: comparison.reason,
      features,
      keptRefs,
      limits,
      additionalLimit,
    });
    payloadCore.concentration = concentration;
    payloadCore.subject_refs = [...keptRefs].sort();

    // R2: hash nằm TRONG payload cuối ⇒ đo UTF-8 byte trên payload cuối (gồm payload_hash).
    const finalized = { ...payloadCore, payload_hash: canonicalHash(payloadCore) };
    const bytes = utf8ByteLength(finalized);
    const fits =
      finalized.evidence.length <= limits.max_evidence &&
      finalized.subject_refs.length <= limits.max_subject_refs &&
      bytes <= limits.max_payload_bytes;

    if (fits) {
      const forbidden = scanForbiddenKeys(finalized);
      if (forbidden) return fail("AI_INPUT_INVALID", forbidden.message, forbidden.path);
      const prohibited = scanProhibitedContent(finalized);
      if (prohibited) return fail("AI_INPUT_INVALID", prohibited.message, prohibited.path);
      const secretLike = scanForbiddenValues(finalized);
      if (secretLike) return fail("AI_INPUT_INVALID", secretLike.message, secretLike.path);

      // Closure check cuối: không feature/evidence/concentration ref mồ côi.
      const refSet = new Set(finalized.subject_refs);
      for (const dimension of finalized.drivers) {
        for (const entry of dimension.entries) {
          if (!refSet.has(entry.subject_ref)) {
            return fail("AI_INPUT_INVALID", "driver subject thiếu trong subject_refs", "drivers." + dimension.dimension);
          }
        }
      }
      for (const row of finalized.project_provider_mix ?? []) {
        if (!refSet.has(row.subject_ref)) return fail("AI_INPUT_INVALID", "mix subject thiếu trong subject_refs", "project_provider_mix");
      }
      for (const dimension of DIMENSION_ORDER) {
        const top1 = finalized.concentration[dimension]?.top1_ref;
        if (top1 !== null && top1 !== undefined && !refSet.has(top1)) {
          return fail("AI_INPUT_INVALID", "concentration top1_ref thiếu trong subject_refs", "concentration." + dimension);
        }
      }
      for (const entry of finalized.evidence) {
        if (entry.subject_ref !== "scope" && !refSet.has(entry.subject_ref)) {
          return fail("AI_INPUT_INVALID", "evidence subject thiếu trong subject_refs", "evidence");
        }
      }

      return { ok: true, payload: finalized, payload_bytes: bytes, pruned_features: collected.features.length - features.length };
    }

    // Prune deterministic: 1) giảm evidence bổ sung (tier 3) trước, 2) mới bỏ subject feature (tier 2).
    if (additionalLimit > 0) {
      additionalLimit = Math.max(0, additionalLimit - 1);
      continue;
    }
    if (features.length === 0) {
      return fail("AI_BUDGET_LIMITED", "payload vượt budget ngay cả khi đã prune hết subject feature", "payload");
    }
    features = features.slice(0, features.length - 1);
  }
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