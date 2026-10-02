/**
 * P1.5-W01 — Contract `analysis-packet/0.1`.
 *
 * Packet deterministic (KHÔNG gọi AI) mà analytics engine sẽ gửi cho AI Business Analyst.
 * Module thuần: không đọc DB, không gọi mạng, không đọc file, không chứa secret.
 * Chỉ dùng opaque subject ref (project_01/recruiter_03/team_02/provider_hrp/...).
 */

import { z } from "zod";

import {
  ANALYSIS_PACKET_VERSION,
  CATALOG_KEYS,
  DIMENSIONS,
  EVIDENCE_ID_RE,
  FORMULA_RE,
  HASH_RE,
  ISO_DATE_RE,
  ISO_UTC_DATETIME_RE,
  METRIC_KEY_RE,
  PERIOD_REF_RE,
  PERIOD_REF_RE_BY_TYPE,
  PERIOD_STATUS,
  PERIOD_TYPES,
  QUALITY_STATUS,
  SOURCE_REF_RE,
  SOURCE_STATUSES,
  STABILITY_FORMULA,
  STABILITY_FORMULA_VERSION,
  STABILITY_MIN_POINTS,
  SUBJECT_REF_RE,
  SUFFICIENCY_KEYS,
  SUFFICIENCY_REQUIREMENTS,
  SUFFICIENCY_STATUS,
  TEAM_AVAILABILITY,
  TEAM_SUBJECT_REF_RE,
  TIMEZONE,
  TREND_DIRECTIONS,
  UNITS,
  VOLATILITY_LEVELS,
  VOLATILITY_LOW_MAX,
  VOLATILITY_MEDIUM_MAX,
  customRefRange,
  scanProhibitedContent,
} from "./shared.mjs";

const EPS = 1e-9;

/** Số ngày của khoảng bao gồm cả hai đầu (chỉ gọi sau khi start/end đã là ISO date hợp lệ). */
function inclusiveDays(start: string, end: string): number {
  const parts1 = start.split("-").map(Number);
  const parts2 = end.split("-").map(Number);
  return Math.round((Date.UTC(parts2[0], parts2[1] - 1, parts2[2]) - Date.UTC(parts1[0], parts1[1] - 1, parts1[2])) / 86400000) + 1;
}

const isoDate = z.string().regex(ISO_DATE_RE);
const utcDateTime = z.string().regex(ISO_UTC_DATETIME_RE);
const hash = z.string().regex(HASH_RE);
const subjectRef = z.string().regex(SUBJECT_REF_RE);
const periodRef = z.string().regex(PERIOD_REF_RE);
const unitLike = z.number().finite().min(0).max(1);

const periodWindowSchema = z.strictObject({
  period_ref: periodRef,
  start: isoDate,
  end: isoDate,
  elapsed_days: z.number().int().min(1).max(400),
});

const driverEntrySchema = z.strictObject({
  subject_ref: subjectRef,
  current: z.number().finite().min(0),
  comparable: z.number().finite().min(0).nullable(),
  delta: z.number().finite().nullable(),
  delta_contribution_share: unitLike.nullable(),
  share_of_current: unitLike.nullable(),
});

const concentrationEntrySchema = z.strictObject({
  top1_ref: subjectRef.nullable(),
  top1_share: unitLike.nullable(),
  top3_share: unitLike.nullable(),
  distinct_subjects: z.number().int().min(0),
});

const evidenceSchema = z.strictObject({
  evidence_id: z.string().regex(EVIDENCE_ID_RE),
  metric: z.string().regex(METRIC_KEY_RE),
  formula: z.string().regex(FORMULA_RE),
  formula_version: z.string().regex(/^[a-z0-9_.-]{1,20}$/),
  period_ref: periodRef,
  scope_ref: hash,
  subject_ref: subjectRef,
  value: z.number().finite(),
  unit: z.enum(UNITS),
  sufficiency: z.enum(SUFFICIENCY_STATUS),
  quality: z.enum(QUALITY_STATUS),
  snapshot_ref: hash,
});

/** R7 — cơ cấu HRP/Vendor theo dự án (giữ nguyên semantics/denominator). */
export const projectProviderMixSchema = z.strictObject({
  subject_ref: subjectRef,
  project_total: z.number().int().min(0),
  hrp_count: z.number().int().min(0),
  vendor_count: z.number().int().min(0),
  unknown_count: z.number().int().min(0),
  invalid_count: z.number().int().min(0),
  known_total: z.number().int().min(0),
  hrp_share: unitLike.nullable(),
  vendor_share: unitLike.nullable(),
  known_coverage: unitLike.nullable(),
});

export const analysisPacketSchema = z
  .strictObject({
    contract_version: z.literal(ANALYSIS_PACKET_VERSION),
    generated_at: utcDateTime,
    snapshot: z.strictObject({
      hash,
      lineage_ref: hash,
      generated_from: z.string().regex(/^[a-z0-9_.:-]{3,40}$/),
    }),
    scope: z.strictObject({
      scope_hash: hash,
      access_scope_hash: hash,
      sources_in_scope: z.number().int().min(0),
      dimensions: z.array(z.enum(DIMENSIONS)).min(1),
    }),
    team_mapping: z.strictObject({
      availability: z.enum(TEAM_AVAILABILITY),
      mapped_recruited_count: z.number().int().min(0),
      unmapped_recruited_count: z.number().int().min(0),
      ambiguous_recruited_count: z.number().int().min(0),
      coverage_ratio: unitLike.nullable(),
      teams_in_scope: z.number().int().min(0),
      reason_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,40}$/),
    }),
    period: z.strictObject({
      period_ref: periodRef,
      type: z.enum(PERIOD_TYPES),
      start: isoDate,
      end: isoDate,
      timezone: z.literal(TIMEZONE),
      status: z.enum(PERIOD_STATUS),
      period_to_date: z.boolean(),
      elapsed_days: z.number().int().min(1).max(400),
      comparable: periodWindowSchema.nullable(),
    }),
    totals: z.strictObject({
      current: z.number().finite().min(0),
      comparable: z.number().finite().min(0).nullable(),
      delta: z.number().finite().nullable(),
      delta_pct: z.number().finite().nullable(),
    }),
    drivers: z.strictObject({
      project: z.array(driverEntrySchema).max(500),
      recruiter: z.array(driverEntrySchema).max(500),
      team: z.array(driverEntrySchema).max(500),
      provider: z.array(driverEntrySchema).max(50),
      employment: z.array(driverEntrySchema).max(50),
    }),
    concentration: z.strictObject({
      project: concentrationEntrySchema,
      recruiter: concentrationEntrySchema,
      team: concentrationEntrySchema,
      provider: concentrationEntrySchema,
      employment: concentrationEntrySchema,
    }),
    stability: z.strictObject({
      formula: z.literal(STABILITY_FORMULA),
      formula_version: z.literal(STABILITY_FORMULA_VERSION),
      period_points: z.number().int().min(0).max(400),
      mean: z.number().finite().min(0).nullable(),
      stddev: z.number().finite().min(0).nullable(),
      cv: z.number().finite().min(0).nullable(),
      trend_direction: z.enum(TREND_DIRECTIONS),
      volatility: z.enum(VOLATILITY_LEVELS),
    }),
    series: z.strictObject({
      granularity: z.enum(["day", "week"]),
      points: z
        .array(
          z.strictObject({
            period_start: isoDate,
            period_end: isoDate.nullable(),
            value: z.number().finite().min(0),
          })
        )
        .max(400),
    }),
    data_quality: z.strictObject({
      sources: z
        .array(
          z.strictObject({
            source_ref: z.string().regex(SOURCE_REF_RE),
            status: z.enum(SOURCE_STATUSES),
            quality: z.enum(QUALITY_STATUS),
          })
        )
        .max(200),
      coverage_ratio: unitLike.nullable(),
      unknown_count: z.number().int().min(0),
      invalid_count: z.number().int().min(0),
      unknown_share: unitLike.nullable(),
      invalid_share: unitLike.nullable(),
    }),
    project_provider_mix: z.array(projectProviderMixSchema).max(500),
    sufficiency: z
      .array(
        z.strictObject({
          key: z.enum(SUFFICIENCY_KEYS),
          required_points: z.number().int().min(1),
          actual_points: z.number().int().min(0),
          status: z.enum(SUFFICIENCY_STATUS),
          reason_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,40}$/),
        })
      )
      .min(1),
    subjects: z
      .array(
        z.strictObject({
          ref: subjectRef,
          kind: z.enum(DIMENSIONS),
          catalog_key: z.enum(CATALOG_KEYS).nullable(),
        })
      )
      .min(1),
    evidence: z.array(evidenceSchema).min(1).max(500),
  })
  .superRefine((packet, ctx) => {
    if (packet.period.end < packet.period.start) {
      ctx.addIssue({ code: "custom", message: "PERIOD_RANGE_INVALID", path: ["period", "end"] });
    }
    if (packet.period.period_to_date !== (packet.period.status === "period_to_date")) {
      ctx.addIssue({ code: "custom", message: "PERIOD_STATUS_MISMATCH", path: ["period", "status"] });
    }
    /**
     * R1 clarification: PTD được phép `comparable = null` — DUY NHẤT khi equal window không khả dụng
     * (kỳ lịch liền trước ngắn hơn số ngày đã trôi qua, ví dụ 30/03 so với tháng 2 có 28 ngày).
     * Khi comparable khác null thì bắt buộc:
     *   - `comparable.elapsed_days === period.elapsed_days` (cùng số ngày đã trôi qua), và
     *   - `inclusiveDays(comparable.start, comparable.end) === comparable.elapsed_days` (không cắt ngầm cửa sổ).
     */
    if (packet.period.comparable) {
      if (packet.period.period_to_date && packet.period.comparable.elapsed_days !== packet.period.elapsed_days) {
        ctx.addIssue({ code: "custom", message: "PTD_ELAPSED_MISMATCH", path: ["period", "comparable", "elapsed_days"] });
      }
      if (inclusiveDays(packet.period.comparable.start, packet.period.comparable.end) !== packet.period.comparable.elapsed_days) {
        ctx.addIssue({ code: "custom", message: "COMPARABLE_WINDOW_LENGTH_MISMATCH", path: ["period", "comparable", "end"] });
      }
    }
  });

export type AnalysisPacket = z.infer<typeof analysisPacketSchema>;
export type PacketEvidence = z.infer<typeof evidenceSchema>;
export type ProjectProviderMix = z.infer<typeof projectProviderMixSchema>;

export type ContractValidationError = { ok: false; code: string; message: string; path?: string };
export type ContractValidationResult<T> = { ok: true; value: T } | ContractValidationError;

function firstIssue(error: z.ZodError): ContractValidationError {
  const issue = error.issues[0];
  const path = issue?.path?.join(".") ?? "";
  const raw = issue?.message ?? "INVALID";
  const isUnknownKey = issue?.code === "unrecognized_keys" || /unrecognized key/i.test(raw);
  const code = isUnknownKey ? "UNKNOWN_FIELD" : issue?.code === "custom" ? raw : "SCHEMA_INVALID";
  return { ok: false, code, message: raw + (path ? " @ " + path : ""), path };
}

/** Kiểm tra ngữ nghĩa chéo (sau khi schema hợp lệ). Trả về lỗi đầu tiên hoặc null. */
export function checkPacketSemantics(packet: AnalysisPacket): ContractValidationError | null {
  const fail = (code: string, message: string, path?: string): ContractValidationError => ({ ok: false, code, message, path });

  // 0. Period ref (R1): prefix bắt buộc khớp period.type; custom phải khớp đúng start/end.
  const refRe = PERIOD_REF_RE_BY_TYPE[packet.period.type];
  if (!refRe.test(packet.period.period_ref)) {
    return fail("PERIOD_REF_TYPE_MISMATCH", "period_ref không khớp period.type=" + packet.period.type, "period.period_ref");
  }
  if (packet.period.type === "custom") {
    const range = customRefRange(packet.period.period_ref);
    if (!range || range.start !== packet.period.start || range.end !== packet.period.end) {
      return fail("PERIOD_REF_RANGE_MISMATCH", "custom period_ref không khớp period.start/period.end", "period.period_ref");
    }
  }
  if (packet.period.comparable) {
    if (!refRe.test(packet.period.comparable.period_ref)) {
      return fail("COMPARABLE_PERIOD_TYPE_MISMATCH", "comparable.period_ref khác loại kỳ với kỳ hiện tại", "period.comparable.period_ref");
    }
    if (packet.period.type === "custom") {
      const cRange = customRefRange(packet.period.comparable.period_ref);
      if (!cRange || cRange.start !== packet.period.comparable.start || cRange.end !== packet.period.comparable.end) {
        return fail("COMPARABLE_PERIOD_TYPE_MISMATCH", "custom comparable.period_ref không khớp start/end", "period.comparable.period_ref");
      }
    }
  }

  // 0b. Stability (R1): cv = population stddev / mean; band đã khóa; thiếu điểm hoặc mean<=0 => unknown.
  const st = packet.stability;
  if (st.period_points < STABILITY_MIN_POINTS || st.mean === null || st.mean <= 0) {
    if (st.cv !== null || st.volatility !== "unknown") {
      return fail("STABILITY_INCONSISTENT", "period_points<4 hoặc mean<=0 nhưng cv/volatility không phải null/unknown", "stability");
    }
  } else if (st.cv === null || st.stddev === null || st.stddev < 0) {
    return fail("STABILITY_INCONSISTENT", "thiếu cv/stddev dù đủ điểm và mean>0", "stability");
  } else {
    const expectedCv = st.stddev / st.mean;
    if (Math.abs(st.cv - expectedCv) > 1e-9) {
      return fail("STABILITY_INCONSISTENT", "cv không khớp stddev/mean", "stability");
    }
    const band = st.cv < VOLATILITY_LOW_MAX ? "low" : st.cv < VOLATILITY_MEDIUM_MAX ? "medium" : "high";
    if (st.volatility !== band) {
      return fail("VOLATILITY_BAND_MISMATCH", "volatility không khớp band của cv", "stability.volatility");
    }
  }

  // 0c. Team mapping (R2): fact-weighted theo sum(recruited_count), KHÔNG dùng số team làm tử số coverage.
  const tm = packet.team_mapping;
  const teamSubjectCount = packet.subjects.filter((s) => TEAM_SUBJECT_REF_RE.test(s.ref)).length;
  const current = packet.totals.current;
  const teamSum = tm.mapped_recruited_count + tm.unmapped_recruited_count + tm.ambiguous_recruited_count;
  if (teamSum !== current) {
    return fail("TEAM_MAPPING_INCONSISTENT", "mapped + unmapped + ambiguous != totals.current", "team_mapping");
  }
  if (tm.teams_in_scope !== teamSubjectCount) {
    return fail("TEAM_MAPPING_INCONSISTENT", "teams_in_scope không khớp số subject kind=team", "team_mapping");
  }
  if (current > 0) {
    const expectedCoverage = tm.mapped_recruited_count / current;
    if (tm.coverage_ratio === null || Math.abs(tm.coverage_ratio - expectedCoverage) > 1e-9) {
      return fail("TEAM_MAPPING_INCONSISTENT", "coverage_ratio không khớp mapped_recruited_count / totals.current", "team_mapping");
    }
  } else if (tm.coverage_ratio !== null) {
    return fail("TEAM_MAPPING_INCONSISTENT", "totals.current = 0 nhưng coverage_ratio khác null", "team_mapping");
  }
  if (tm.availability === "available") {
    if (tm.unmapped_recruited_count !== 0 || tm.ambiguous_recruited_count !== 0 || tm.coverage_ratio !== 1) {
      return fail("TEAM_MAPPING_INCONSISTENT", "available: unmapped = 0, ambiguous = 0, coverage = 1", "team_mapping");
    }
  } else if (tm.availability === "partial") {
    const okPartial = tm.mapped_recruited_count > 0 && tm.unmapped_recruited_count > 0 && tm.ambiguous_recruited_count === 0 && tm.coverage_ratio !== null && tm.coverage_ratio > 0 && tm.coverage_ratio < 1;
    if (!okPartial) return fail("TEAM_MAPPING_INCONSISTENT", "partial: mapped > 0, unmapped > 0, ambiguous = 0, 0 < coverage < 1", "team_mapping");
    if (teamSubjectCount === 0) return fail("TEAM_MAPPING_INCONSISTENT", "partial phải có team subject trong scope", "team_mapping");
  } else if (tm.availability === "unavailable") {
    if (tm.mapped_recruited_count !== 0 || tm.ambiguous_recruited_count !== 0) {
      return fail("TEAM_MAPPING_INCONSISTENT", "unavailable: mapped = 0, ambiguous = 0", "team_mapping");
    }
    if (teamSubjectCount > 0 || packet.drivers.team.length > 0) {
      return fail("TEAM_MAPPING_INCONSISTENT", "unavailable: không team subject/driver", "team_mapping");
    }
  } else if (tm.availability === "ambiguous") {
    if (tm.ambiguous_recruited_count <= 0) {
      return fail("TEAM_MAPPING_INCONSISTENT", "ambiguous: ambiguous_recruited_count > 0", "team_mapping");
    }
    if (teamSubjectCount > 0 || packet.drivers.team.length > 0) {
      return fail("TEAM_MAPPING_INCONSISTENT", "ambiguous: tắt team subject/driver để không suy luận sai", "team_mapping");
    }
  }

  // 1. Evidence: id duy nhất, snapshot khớp packet, subject tồn tại.
  const evidenceIds = new Set<string>();
  const subjectRefs = new Set(packet.subjects.map((s) => s.ref));
  for (const ev of packet.evidence) {
    if (evidenceIds.has(ev.evidence_id)) return fail("DUPLICATE_EVIDENCE_ID", "evidence_id trùng: " + ev.evidence_id, "evidence");
    evidenceIds.add(ev.evidence_id);
    if (ev.snapshot_ref !== packet.snapshot.hash) return fail("SNAPSHOT_REF_MISMATCH", "evidence " + ev.evidence_id + " trỏ snapshot khác packet", "evidence");
    if (ev.scope_ref !== packet.scope.scope_hash) return fail("SCOPE_REF_MISMATCH", "evidence " + ev.evidence_id + " trỏ scope khác packet", "evidence");
    if (ev.period_ref !== packet.period.period_ref) return fail("PERIOD_REF_MISMATCH", "evidence " + ev.evidence_id + " trỏ kỳ khác packet", "evidence");
    if (ev.subject_ref !== "scope" && !subjectRefs.has(ev.subject_ref)) return fail("UNKNOWN_SUBJECT_REF", "evidence trỏ subject ngoài scope: " + ev.subject_ref, "evidence");
  }

  // 2. Subjects: ref duy nhất.
  if (subjectRefs.size !== packet.subjects.length) return fail("DUPLICATE_SUBJECT_REF", "subjects có ref trùng", "subjects");

  // 3. Totals / delta.
  if (packet.totals.comparable === null && packet.totals.delta !== null) return fail("TOTAL_DELTA_MISMATCH", "delta phải null khi không có kỳ so sánh", "totals");
  if (packet.totals.comparable !== null) {
    const expected = packet.totals.current - packet.totals.comparable;
    if (packet.totals.delta === null || Math.abs(packet.totals.delta - expected) > EPS) {
      return fail("TOTAL_DELTA_MISMATCH", "delta không khớp current - comparable", "totals");
    }
  }
  if ([...packet.drivers.project, ...packet.drivers.recruiter, ...packet.drivers.team, ...packet.drivers.provider, ...packet.drivers.employment].some((d) => d.subject_ref !== "scope" && !subjectRefs.has(d.subject_ref))) {
    return fail("UNKNOWN_SUBJECT_REF", "drivers trỏ subject ngoài scope", "drivers");
  }

  // 4. Sufficiency: required_points phải đúng baseline đã khóa.
  for (const s of packet.sufficiency) {
    const expected = SUFFICIENCY_REQUIREMENTS[s.key];
    if (s.required_points !== expected) return fail("SUFFICIENCY_REQUIRED_MISMATCH", "required_points sai baseline cho " + s.key, "sufficiency");
    const derived = s.actual_points >= s.required_points ? "met" : "not_met";
    if (s.status !== derived && s.status !== "unknown") return fail("SUFFICIENCY_STATUS_MISMATCH", "status không khớp actual/required cho " + s.key, "sufficiency");
  }

  // 5. Concentration.
  for (const key of DIMENSIONS) {
    const c = packet.concentration[key];
    if (c.top1_share !== null && c.top3_share !== null && c.top1_share - c.top3_share > EPS) {
      return fail("CONCENTRATION_INVALID", "top1_share > top3_share cho " + key, "concentration." + key);
    }
  }

  // 6. R7 project × provider mix invariants.
  let mixTotal = 0;
  const mixRefs = new Set<string>();
  for (const m of packet.project_provider_mix) {
    if (mixRefs.has(m.subject_ref)) return fail("PROJECT_MIX_DUPLICATE", "subject_ref trùng trong project_provider_mix: " + m.subject_ref, "project_provider_mix");
    mixRefs.add(m.subject_ref);
    if (m.subject_ref !== "scope" && !subjectRefs.has(m.subject_ref)) return fail("UNKNOWN_SUBJECT_REF", "project_provider_mix trỏ subject ngoài scope", "project_provider_mix");
    if (m.project_total !== m.hrp_count + m.vendor_count + m.unknown_count + m.invalid_count) return fail("PROJECT_MIX_INVARIANT", "project_total != hrp+vendor+unknown+invalid cho " + m.subject_ref, "project_provider_mix");
    if (m.known_total !== m.hrp_count + m.vendor_count) return fail("PROJECT_MIX_INVARIANT", "known_total != hrp+vendor cho " + m.subject_ref, "project_provider_mix");
    if (m.known_total === 0) {
      if (m.hrp_share !== null || m.vendor_share !== null) return fail("PROJECT_MIX_INVARIANT", "known_total=0 nhưng share khác null cho " + m.subject_ref, "project_provider_mix");
    } else {
      if (m.hrp_share === null || m.vendor_share === null) return fail("PROJECT_MIX_INVARIANT", "known_total>0 nhưng share null cho " + m.subject_ref, "project_provider_mix");
      if (Math.abs(m.hrp_share + m.vendor_share - 1) > 1e-9) return fail("PROJECT_MIX_INVARIANT", "hrp_share + vendor_share != 1 cho " + m.subject_ref, "project_provider_mix");
    }
    if (m.project_total === 0) {
      if (m.known_coverage !== null) return fail("PROJECT_MIX_INVARIANT", "project_total=0 nhưng known_coverage khác null", "project_provider_mix");
    } else if (m.known_coverage === null || Math.abs(m.known_coverage - m.known_total / m.project_total) > 1e-9) {
      return fail("PROJECT_MIX_INVARIANT", "known_coverage không khớp cho " + m.subject_ref, "project_provider_mix");
    }
    mixTotal += m.project_total;
  }
  if (packet.project_provider_mix.length > 0 && mixTotal !== packet.totals.current) {
    return fail("PROJECT_MIX_TOTAL_MISMATCH", "sum(project_total)=" + mixTotal + " != totals.current=" + packet.totals.current, "project_provider_mix");
  }

  // 7. Data quality: unknown_count và invalid_count là hai chỉ số ĐỘC LẬP (R1) — grain vừa unknown vừa
  //     invalid được tính vào cả hai, nên TỔNG có thể lớn hơn totals.current. Mỗi chỉ số riêng phải
  //     <= totals.current và share phải khớp count/total.
  const dq = packet.data_quality;
  if (dq.unknown_count > packet.totals.current) {
    return fail("DATA_QUALITY_INVALID", "unknown_count vượt totals.current", "data_quality.unknown_count");
  }
  if (dq.invalid_count > packet.totals.current) {
    return fail("DATA_QUALITY_INVALID", "invalid_count vượt totals.current", "data_quality.invalid_count");
  }
  if (packet.totals.current > 0) {
    if (dq.unknown_share === null || Math.abs(dq.unknown_share - dq.unknown_count / packet.totals.current) > EPS) {
      return fail("DATA_QUALITY_INVALID", "unknown_share không khớp unknown_count / totals.current", "data_quality.unknown_share");
    }
    if (dq.invalid_share === null || Math.abs(dq.invalid_share - dq.invalid_count / packet.totals.current) > EPS) {
      return fail("DATA_QUALITY_INVALID", "invalid_share không khớp invalid_count / totals.current", "data_quality.invalid_share");
    }
  } else if (dq.unknown_share !== null || dq.invalid_share !== null) {
    return fail("DATA_QUALITY_INVALID", "totals.current = 0 nhưng share khác null", "data_quality.unknown_share");
  }
  if (dq.sources.length !== packet.scope.sources_in_scope) {
    return fail("DATA_QUALITY_INVALID", "số source status không khớp sources_in_scope", "data_quality.sources");
  }

  return null;
}

/**
 * Validate packet: (1) quét nội dung bị cấm, (2) strict schema, (3) ngữ nghĩa chéo.
 * Không bao giờ trả packet một phần và không bao giờ biến lỗi thành số 0.
 */
export function validateAnalysisPacket(input: unknown): ContractValidationResult<AnalysisPacket> {
  const prohibited = scanProhibitedContent(input);
  if (prohibited) return { ok: false, code: prohibited.code, message: prohibited.message, path: prohibited.path };
  const parsed = analysisPacketSchema.safeParse(input);
  if (!parsed.success) return firstIssue(parsed.error);
  const semantic = checkPacketSemantics(parsed.data);
  if (semantic) return semantic;
  return { ok: true, value: parsed.data };
}
