/**
 * P1.5-W03 — Deterministic analytics feature engine.
 *
 * Biến reporting aggregate facts + identity projection (W02/G2) thành payload hợp lệ theo
 * `analysis-packet/0.1`. Thuần + deterministic: không DB, không mạng, không AI, không secret,
 * không đọc đồng hồ hệ thống (as_of_date/generated_at do caller truyền).
 *
 * Module self-contained (giống P1.5-W02 `projection.ts`): runtime import DUY NHẤT là
 * `./engine-shared.mjs` (có extension) nên Node chạy test trực tiếp được; mọi import .ts khác
 * đều là `import type` (bị xoá khi strip type).
 *
 * Packet builder CHỈ tạo object mới bằng whitelist — không spread object server-side vào packet.
 * Trước khi trả, engine tự quét privacy + invariant (defense in depth).
 */

import {
  BASELINE_REQUIREMENTS,
  DIMENSIONS,
  EMPLOYMENT_FACT_KEYS,
  EMPLOYMENT_SUBJECTS,
  FORMULA_REGISTRY,
  IDENTITY_CLASSIFICATIONS,
  MAX_BASELINE_MONTHS,
  MAX_BASELINE_QUARTERS,
  MAX_BASELINE_WEEKS,
  MAX_DAY_OF_WEEK_WEEKS,
  MAX_DRIVER_SUBJECTS,
  MAX_EVIDENCE_RECORDS,
  MAX_PERIOD_DAYS,
  MAX_SERIES_POINTS,
  MAX_STABILITY_POINTS,
  PERIOD_TYPES,
  PROVIDER_FACT_KEYS,
  PROVIDER_SUBJECTS,
  QUALITY_STATUS,
  SOURCE_STATUSES,
  STABILITY_FORMULA,
  STABILITY_FORMULA_VERSION,
  STABILITY_MIN_POINTS,
  SUFFICIENCY_KEYS,
  TEAM_AVAILABILITY,
  addDays,
  buildBaselineWindows,
  buildPeriodPlan,
  buildRefMap,
  canonicalHash,
  enumerateDates,
  inclusiveDays,
  isRealCalendarDate,
  isoWeekOf,
  isoWeekStart,
  meanOf,
  populationStddevOf,
  scanForbiddenPacketContent,
  sentinelQualityOf,
  volatilityBand,
} from "./engine-shared.mjs";
import type {
  AnalysisRequestInput,
  Dimension,
  DimensionQuality,
  EngineDetail,
  EngineError,
  EngineFactRow,
  EngineResult,
  FeatureEngineInput,
  QualityStatus,
  ReportingFactInput,
  ScopeFiltersInput,
  SourceHealthInput,
  SufficiencyStatus,
  TeamCoverageInput,
  ValidationResult,
} from "./contracts";
import type { AnalysisPacket, PacketEvidence } from "../analytics/contracts/analysis-packet";

const ISO_UTC_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const HASH_RE = /^[a-f0-9]{16,64}$/;
const SOURCE_REF_RE = /^source_[0-9]{2,}$/;
const RECRUITER_REF_RE = /^recruiter_[0-9]{2,}$/;
const TEAM_REF_RE = /^team_[0-9]{2,}$/;
const GENERATED_FROM_RE = /^[a-z0-9_.:-]{3,40}$/;

function fail(code: string, message: string, path: string): EngineError {
  return { ok: false, code, message, path };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function sortRefs(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 1. Validators fail-closed
// ---------------------------------------------------------------------------

export interface NormalizedScope {
  dimensions: Dimension[];
  filters: {
    project_keys: string[] | null;
    recruiter_keys: string[] | null;
    provider_type_keys: string[] | null;
    employment_type_keys: string[] | null;
  };
}

export interface NormalizedRequest {
  period: { type: (typeof PERIOD_TYPES)[number]; as_of_date: string; custom_from: string | null; custom_to: string | null };
  scope: NormalizedScope;
}

function normalizeKeyList(value: unknown, path: string): ValidationResult<string[] | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) return fail("REQUEST_INVALID_SCOPE_FILTER", "Filter phải là mảng key.", path);
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isNonEmptyString(item)) return fail("REQUEST_INVALID_SCOPE_FILTER", "Filter key không hợp lệ.", path + "[" + i + "]");
    if (!out.includes(item)) out.push(item);
  }
  return { ok: true, value: out.sort() };
}

/** Validate + chuẩn hoá analytics request (period + scope). */
export function validateAnalyticsRequest(input: unknown): ValidationResult<NormalizedRequest> {
  if (!isPlainObject(input)) return fail("REQUEST_INVALID", "Request phải là object.", "request");
  const rawInput = input as unknown as { period?: unknown; scope?: unknown };
  const period = rawInput.period as Partial<AnalysisRequestInput["period"]> | undefined;
  if (!isPlainObject(period)) return fail("REQUEST_INVALID_PERIOD", "Thiếu period.", "request.period");

  const type = period.type;
  if (typeof type !== "string" || !PERIOD_TYPES.includes(type as never)) {
    return fail("REQUEST_INVALID_PERIOD_TYPE", "period_type phải là week|month|quarter|custom.", "request.period.type");
  }
  const asOf = period.as_of_date;
  if (typeof asOf !== "string" || !isRealCalendarDate(asOf)) {
    return fail("REQUEST_INVALID_AS_OF_DATE", "as_of_date phải là ngày lịch thật (YYYY-MM-DD).", "request.period.as_of_date");
  }

  let customFrom: string | null = null;
  let customTo: string | null = null;
  if (type === "custom") {
    const from = period.custom_from ?? null;
    const to = period.custom_to ?? null;
    if (typeof from !== "string" || typeof to !== "string" || !isRealCalendarDate(from) || !isRealCalendarDate(to)) {
      return fail(
        "REQUEST_CUSTOM_RANGE_REQUIRED",
        "period_type=custom bắt buộc custom_from/custom_to là ngày lịch thật.",
        "request.period.custom_from"
      );
    }
    if (from > to) {
      return fail("REQUEST_CUSTOM_RANGE_INVALID", "custom_from phải <= custom_to.", "request.period.custom_from");
    }
    if (to > asOf) {
      return fail("REQUEST_CUSTOM_FUTURE_DATE", "custom_to không được ở tương lai so với as_of_date.", "request.period.custom_to");
    }
    if (inclusiveDays(from, to) > MAX_PERIOD_DAYS) {
      return fail("REQUEST_CUSTOM_TOO_LONG", "custom period vượt " + MAX_PERIOD_DAYS + " ngày.", "request.period.custom_to");
    }
    customFrom = from;
    customTo = to;
  } else if (period.custom_from != null || period.custom_to != null) {
    return fail("REQUEST_CUSTOM_RANGE_UNEXPECTED", "custom_from/custom_to chỉ dùng khi period_type=custom.", "request.period.custom_from");
  }

  const scopeValue = rawInput.scope;
  if (scopeValue !== undefined && !isPlainObject(scopeValue)) {
    return fail("REQUEST_INVALID_SCOPE", "scope phải là object.", "request.scope");
  }
  const rawScope = (scopeValue ?? {}) as { dimensions?: unknown; filters?: unknown };

  let dimensions: Dimension[] = [...DIMENSIONS];
  if (rawScope.dimensions !== undefined) {
    if (!Array.isArray(rawScope.dimensions) || rawScope.dimensions.length === 0) {
      return fail("REQUEST_INVALID_DIMENSIONS", "scope.dimensions phải là mảng không rỗng.", "request.scope.dimensions");
    }
    const seen = new Set<string>();
    for (let i = 0; i < rawScope.dimensions.length; i++) {
      const dim = rawScope.dimensions[i];
      if (typeof dim !== "string" || !DIMENSIONS.includes(dim as never)) {
        return fail("REQUEST_INVALID_DIMENSIONS", "dimension không hợp lệ.", "request.scope.dimensions[" + i + "]");
      }
      if (seen.has(dim)) return fail("REQUEST_INVALID_DIMENSIONS", "dimension bị lặp.", "request.scope.dimensions[" + i + "]");
      seen.add(dim);
    }
    dimensions = DIMENSIONS.filter((d) => seen.has(d));
  }

  const rawFilters: ScopeFiltersInput = isPlainObject(rawScope.filters) ? (rawScope.filters as ScopeFiltersInput) : {};
  const projectKeys = normalizeKeyList(rawFilters.project_keys, "request.scope.filters.project_keys");
  if (!projectKeys.ok) return projectKeys;
  const recruiterKeys = normalizeKeyList(rawFilters.recruiter_keys, "request.scope.filters.recruiter_keys");
  if (!recruiterKeys.ok) return recruiterKeys;
  const providerKeys = normalizeKeyList(rawFilters.provider_type_keys, "request.scope.filters.provider_type_keys");
  if (!providerKeys.ok) return providerKeys;
  const employmentKeys = normalizeKeyList(rawFilters.employment_type_keys, "request.scope.filters.employment_type_keys");
  if (!employmentKeys.ok) return employmentKeys;

  return {
    ok: true,
    value: {
      period: {
        type: type as (typeof PERIOD_TYPES)[number],
        as_of_date: asOf,
        custom_from: customFrom,
        custom_to: customTo,
      },
      scope: {
        dimensions,
        filters: {
          project_keys: projectKeys.value,
          recruiter_keys: recruiterKeys.value,
          provider_type_keys: providerKeys.value,
          employment_type_keys: employmentKeys.value,
        },
      },
    },
  };
}

/** Validate reporting aggregate facts (grain-level, trước khi resolve identity). */
export function validateReportingFacts(input: unknown): ValidationResult<ReportingFactInput[]> {
  if (!Array.isArray(input)) return fail("FACTS_INVALID", "facts phải là mảng.", "facts");
  const out: ReportingFactInput[] = [];
  const seenGrains = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const row = input[i] as ReportingFactInput;
    const path = "facts[" + i + "]";
    if (!isPlainObject(row)) return fail("FACT_INVALID", "fact phải là object.", path);
    if (!isRealCalendarDate(row.business_date)) {
      return fail("FACT_INVALID_DATE", "business_date không phải ngày lịch thật.", path + ".business_date");
    }
    if (!isNonEmptyString(row.project_key)) return fail("FACT_INVALID_PROJECT_KEY", "project_key không được rỗng.", path + ".project_key");
    if (!isNonEmptyString(row.recruiter_key)) return fail("FACT_INVALID_RECRUITER_KEY", "recruiter_key không được rỗng.", path + ".recruiter_key");
    if (typeof row.provider_type_key !== "string" || !PROVIDER_FACT_KEYS.includes(row.provider_type_key)) {
      return fail("FACT_INVALID_PROVIDER_KEY", "provider_type_key ngoài danh mục đã khóa.", path + ".provider_type_key");
    }
    if (typeof row.employment_type_key !== "string" || !EMPLOYMENT_FACT_KEYS.includes(row.employment_type_key)) {
      return fail("FACT_INVALID_EMPLOYMENT_KEY", "employment_type_key ngoài danh mục đã khóa.", path + ".employment_type_key");
    }
    if (!isNonNegativeInt(row.recruited_count)) {
      return fail("FACT_INVALID_COUNT", "recruited_count phải là integer >= 0.", path + ".recruited_count");
    }
    if (typeof row.source_ref !== "string" || !SOURCE_REF_RE.test(row.source_ref)) {
      return fail("FACT_INVALID_SOURCE_REF", "source_ref phải có dạng source_NN.", path + ".source_ref");
    }
    const grain = [
      row.business_date,
      row.project_key,
      row.recruiter_key,
      row.provider_type_key,
      row.employment_type_key,
      row.source_ref,
    ].join("|");
    if (seenGrains.has(grain)) return fail("FACT_DUPLICATE_GRAIN", "grain trùng trong cùng snapshot.", path);
    seenGrains.add(grain);
    out.push({
      business_date: row.business_date,
      project_key: row.project_key,
      recruiter_key: row.recruiter_key,
      provider_type_key: row.provider_type_key,
      employment_type_key: row.employment_type_key,
      recruited_count: row.recruited_count,
      source_ref: row.source_ref,
    });
  }
  return { ok: true, value: out };
}

/** Validate source-health projection (opaque ref; không filename/Drive ID/source_id). */
export function validateSourceHealth(input: unknown): ValidationResult<SourceHealthInput[]> {
  if (!Array.isArray(input)) return fail("SOURCE_HEALTH_INVALID", "source_health phải là mảng.", "source_health");
  const out: SourceHealthInput[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const row = input[i] as SourceHealthInput;
    const path = "source_health[" + i + "]";
    if (!isPlainObject(row)) return fail("SOURCE_INVALID", "source health phải là object.", path);
    if (typeof row.source_ref !== "string" || !SOURCE_REF_RE.test(row.source_ref)) {
      return fail("SOURCE_INVALID_REF", "source_ref phải có dạng source_NN.", path + ".source_ref");
    }
    if (seen.has(row.source_ref)) return fail("SOURCE_DUPLICATE_REF", "source_ref bị lặp.", path + ".source_ref");
    seen.add(row.source_ref);
    if (typeof row.status !== "string" || !SOURCE_STATUSES.includes(row.status as never)) {
      return fail("SOURCE_INVALID_STATUS", "status không hợp lệ.", path + ".status");
    }
    if (typeof row.quality !== "string" || !QUALITY_STATUS.includes(row.quality as never)) {
      return fail("SOURCE_INVALID_QUALITY", "quality không hợp lệ.", path + ".quality");
    }
    if (typeof row.has_current_facts !== "boolean") {
      return fail("SOURCE_INVALID_HAS_CURRENT_FACTS", "has_current_facts phải là boolean.", path + ".has_current_facts");
    }
    out.push({ source_ref: row.source_ref, status: row.status, quality: row.quality, has_current_facts: row.has_current_facts });
  }
  out.sort((a, b) => sortRefs(a.source_ref, b.source_ref));
  return { ok: true, value: out };
}

function validateTeamCoverage(input: unknown, path: string): ValidationResult<TeamCoverageInput> {
  if (!isPlainObject(input)) return fail("TEAM_COVERAGE_INVALID", "team coverage phải là object.", path);
  const row = input as unknown as TeamCoverageInput;
  if (typeof row.availability !== "string" || !TEAM_AVAILABILITY.includes(row.availability as never)) {
    return fail("TEAM_COVERAGE_INVALID", "availability không hợp lệ.", path + ".availability");
  }
  for (const key of ["mapped_recruited_count", "unmapped_recruited_count", "ambiguous_recruited_count", "teams_in_scope"] as const) {
    if (!isNonNegativeInt(row[key])) return fail("TEAM_COVERAGE_INVALID", key + " phải là integer >= 0.", path + "." + key);
  }
  if (
    row.coverage_ratio !== null &&
    !(typeof row.coverage_ratio === "number" && Number.isFinite(row.coverage_ratio) && row.coverage_ratio >= 0 && row.coverage_ratio <= 1)
  ) {
    return fail("TEAM_COVERAGE_INVALID", "coverage_ratio phải trong [0,1] hoặc null.", path + ".coverage_ratio");
  }
  if (!isNonEmptyString(row.reason_code)) return fail("TEAM_COVERAGE_INVALID", "reason_code không được rỗng.", path + ".reason_code");
  return {
    ok: true,
    value: {
      availability: row.availability,
      mapped_recruited_count: row.mapped_recruited_count,
      unmapped_recruited_count: row.unmapped_recruited_count,
      ambiguous_recruited_count: row.ambiguous_recruited_count,
      coverage_ratio: row.coverage_ratio,
      teams_in_scope: row.teams_in_scope,
      reason_code: row.reason_code,
    },
  };
}

function validateEngineFacts(input: unknown, sourceRefs: Set<string>): ValidationResult<EngineFactRow[]> {
  if (!Array.isArray(input)) return fail("ENGINE_FACTS_INVALID", "facts phải là mảng.", "facts");
  const out: EngineFactRow[] = [];
  for (let i = 0; i < input.length; i++) {
    const row = input[i] as EngineFactRow;
    const path = "facts[" + i + "]";
    if (!isPlainObject(row)) return fail("ENGINE_FACT_INVALID", "fact phải là object.", path);
    if (!isRealCalendarDate(row.business_date)) return fail("ENGINE_FACT_INVALID_DATE", "business_date không hợp lệ.", path + ".business_date");
    if (!isNonEmptyString(row.project_key)) return fail("ENGINE_FACT_INVALID_PROJECT_KEY", "project_key không được rỗng.", path + ".project_key");
    if (typeof row.provider_type_key !== "string" || !PROVIDER_FACT_KEYS.includes(row.provider_type_key)) {
      return fail("ENGINE_FACT_INVALID_PROVIDER_KEY", "provider_type_key ngoài danh mục.", path + ".provider_type_key");
    }
    if (typeof row.employment_type_key !== "string" || !EMPLOYMENT_FACT_KEYS.includes(row.employment_type_key)) {
      return fail("ENGINE_FACT_INVALID_EMPLOYMENT_KEY", "employment_type_key ngoài danh mục.", path + ".employment_type_key");
    }
    if (!isNonNegativeInt(row.recruited_count)) {
      return fail("ENGINE_FACT_INVALID_COUNT", "recruited_count phải là integer >= 0.", path + ".recruited_count");
    }
    if (typeof row.source_ref !== "string" || !SOURCE_REF_RE.test(row.source_ref)) {
      return fail("ENGINE_FACT_INVALID_SOURCE_REF", "source_ref phải có dạng source_NN.", path + ".source_ref");
    }
    if (!sourceRefs.has(row.source_ref)) return fail("ENGINE_FACT_SOURCE_UNKNOWN", "fact trỏ source ngoài source_health.", path + ".source_ref");
    if (row.recruiter_ref !== null && !RECRUITER_REF_RE.test(String(row.recruiter_ref))) {
      return fail("ENGINE_FACT_INVALID_RECRUITER_REF", "recruiter_ref phải là opaque ref hoặc null.", path + ".recruiter_ref");
    }
    if (row.team_ref !== null && !TEAM_REF_RE.test(String(row.team_ref))) {
      return fail("ENGINE_FACT_INVALID_TEAM_REF", "team_ref phải là opaque ref hoặc null.", path + ".team_ref");
    }
    if (typeof row.identity_classification !== "string" || !IDENTITY_CLASSIFICATIONS.includes(row.identity_classification as never)) {
      return fail("ENGINE_FACT_INVALID_CLASSIFICATION", "identity_classification không hợp lệ.", path + ".identity_classification");
    }
    // Lưu ý redaction G2: window ambiguous giữ classification "mapped" nhưng team_ref = null.
    if (row.identity_classification !== "mapped" && row.team_ref !== null) {
      return fail(
        "IDENTITY_PROJECTION_INCONSISTENT",
        "classification " + row.identity_classification + " nhưng team_ref khác null.",
        path + ".team_ref"
      );
    }
    if (typeof row.recruiter_quality !== "string" || !["ok", "unknown", "invalid"].includes(row.recruiter_quality)) {
      return fail("ENGINE_FACT_INVALID_RECRUITER_QUALITY", "recruiter_quality không hợp lệ.", path + ".recruiter_quality");
    }
    out.push({
      business_date: row.business_date,
      project_key: row.project_key,
      provider_type_key: row.provider_type_key,
      employment_type_key: row.employment_type_key,
      recruited_count: row.recruited_count,
      source_ref: row.source_ref,
      recruiter_ref: row.recruiter_ref,
      team_ref: row.team_ref,
      identity_classification: row.identity_classification,
      recruiter_quality: row.recruiter_quality,
    });
  }
  return { ok: true, value: out };
}

function validateMetadata(input: unknown): ValidationResult<FeatureEngineInput["metadata"]> {
  if (!isPlainObject(input)) return fail("METADATA_INVALID", "metadata phải là object.", "metadata");
  const meta = input as unknown as FeatureEngineInput["metadata"];
  if (typeof meta.generated_at !== "string" || !ISO_UTC_DATETIME_RE.test(meta.generated_at)) {
    return fail("METADATA_INVALID_GENERATED_AT", "generated_at phải là UTC datetime ISO (Z).", "metadata.generated_at");
  }
  if (typeof meta.generated_from !== "string" || !GENERATED_FROM_RE.test(meta.generated_from)) {
    return fail("METADATA_INVALID_GENERATED_FROM", "generated_from không hợp lệ.", "metadata.generated_from");
  }
  if (typeof meta.lineage_ref !== "string" || !HASH_RE.test(meta.lineage_ref)) {
    return fail("METADATA_INVALID_LINEAGE_REF", "lineage_ref phải là hash hex.", "metadata.lineage_ref");
  }
  if (typeof meta.access_scope_hash !== "string" || !HASH_RE.test(meta.access_scope_hash)) {
    return fail("METADATA_INVALID_ACCESS_SCOPE_HASH", "access_scope_hash phải là hash hex.", "metadata.access_scope_hash");
  }
  return {
    ok: true,
    value: {
      generated_at: meta.generated_at,
      generated_from: meta.generated_from,
      lineage_ref: meta.lineage_ref,
      access_scope_hash: meta.access_scope_hash,
    },
  };
}

export interface ValidatedEngineInput {
  request: NormalizedRequest;
  facts: EngineFactRow[];
  sourceHealth: SourceHealthInput[];
  team: { current: TeamCoverageInput; comparable: TeamCoverageInput | null };
  metadata: FeatureEngineInput["metadata"];
}

/** Gate fail-closed duy nhất của engine. */
export function validateEngineInput(input: unknown): ValidationResult<ValidatedEngineInput> {
  if (!isPlainObject(input)) return fail("ENGINE_INPUT_INVALID", "Engine input phải là object.", "input");
  const raw = input as unknown as FeatureEngineInput;

  const request = validateAnalyticsRequest({ period: raw.request?.period, scope: raw.request?.scope });
  if (!request.ok) return request;

  const sourceHealth = validateSourceHealth(raw.source_health);
  if (!sourceHealth.ok) return sourceHealth;

  const facts = validateEngineFacts(raw.facts, new Set(sourceHealth.value.map((s) => s.source_ref)));
  if (!facts.ok) return facts;

  if (!isPlainObject(raw.team)) return fail("TEAM_COVERAGE_INVALID", "Thiếu team coverage.", "team");
  const current = validateTeamCoverage(raw.team.current, "team.current");
  if (!current.ok) return current;
  let comparable: TeamCoverageInput | null = null;
  if (raw.team.comparable !== undefined && raw.team.comparable !== null) {
    const validated = validateTeamCoverage(raw.team.comparable, "team.comparable");
    if (!validated.ok) return validated;
    comparable = validated.value;
  }

  const metadata = validateMetadata(raw.metadata);
  if (!metadata.ok) return metadata;

  return {
    ok: true,
    value: {
      request: request.value,
      facts: facts.value,
      sourceHealth: sourceHealth.value,
      team: { current: current.value, comparable },
      metadata: metadata.value,
    },
  };
}
// ---------------------------------------------------------------------------
// 2. Pure helpers
// ---------------------------------------------------------------------------

interface Window {
  start: string;
  end: string;
}

interface DriverEntry {
  subject_ref: string;
  current: number;
  comparable: number | null;
  delta: number | null;
  delta_contribution_share: number | null;
  share_of_current: number | null;
}

interface ConcentrationEntry {
  top1_ref: string | null;
  top1_share: number | null;
  top3_share: number | null;
  distinct_subjects: number;
}

type CatalogKey = NonNullable<AnalysisPacket["subjects"][number]["catalog_key"]>;

interface SubjectRow {
  ref: string;
  kind: Dimension;
  catalog_key: CatalogKey | null;
}

interface MixRow {
  subject_ref: string;
  project_total: number;
  hrp_count: number;
  vendor_count: number;
  unknown_count: number;
  invalid_count: number;
  known_total: number;
  hrp_share: number | null;
  vendor_share: number | null;
  known_coverage: number | null;
}

type SufficiencyKey = (typeof SUFFICIENCY_KEYS)[number];

interface SufficiencyRow {
  key: SufficiencyKey;
  required_points: number;
  actual_points: number;
  status: SufficiencyStatus;
  reason_code: string;
}

const EMPTY_CONCENTRATION: ConcentrationEntry = { top1_ref: null, top1_share: null, top3_share: null, distinct_subjects: 0 };
const QUALITY_RANK: Record<QualityStatus, number> = { ok: 0, partial: 1, failed: 2, unknown: 3 };

const PROVIDER_CATALOG_BY_REF = new Map<string, string>(
  Object.values(PROVIDER_SUBJECTS).map((entry) => [entry.ref, entry.catalog_key])
);
const EMPLOYMENT_CATALOG_BY_REF = new Map<string, string>(
  Object.values(EMPLOYMENT_SUBJECTS).map((entry) => [entry.ref, entry.catalog_key])
);

function worstQuality(a: QualityStatus, b: QualityStatus): QualityStatus {
  return QUALITY_RANK[a] >= QUALITY_RANK[b] ? a : b;
}

/** Filter theo chiều engine nhìn thấy được (recruiter_keys do builder áp trước khi resolve). */
function applyFilters(rows: readonly EngineFactRow[], filters: NormalizedScope["filters"]): EngineFactRow[] {
  return rows.filter((row) => {
    if (filters.project_keys && !filters.project_keys.includes(row.project_key)) return false;
    if (filters.provider_type_keys && !filters.provider_type_keys.includes(row.provider_type_key)) return false;
    if (filters.employment_type_keys && !filters.employment_type_keys.includes(row.employment_type_key)) return false;
    return true;
  });
}

function rowsInWindow(rows: readonly EngineFactRow[], window: Window | null): EngineFactRow[] {
  if (!window) return [];
  return rows.filter((row) => row.business_date >= window.start && row.business_date <= window.end);
}

function sumCount(rows: readonly EngineFactRow[]): number {
  let total = 0;
  for (const row of rows) total += row.recruited_count;
  return total;
}

function sumInRange(rows: readonly EngineFactRow[], start: string, end: string): number {
  let total = 0;
  for (const row of rows) if (row.business_date >= start && row.business_date <= end) total += row.recruited_count;
  return total;
}

function compareFactRows(a: EngineFactRow, b: EngineFactRow): number {
  return (
    sortRefs(a.business_date, b.business_date) ||
    sortRefs(a.project_key, b.project_key) ||
    sortRefs(String(a.recruiter_ref), String(b.recruiter_ref)) ||
    sortRefs(String(a.team_ref), String(b.team_ref)) ||
    sortRefs(a.provider_type_key, b.provider_type_key) ||
    sortRefs(a.employment_type_key, b.employment_type_key) ||
    a.recruited_count - b.recruited_count ||
    sortRefs(a.source_ref, b.source_ref)
  );
}

function dimensionQualityOf(row: EngineFactRow): { unknown: boolean; invalid: boolean } {
  const qualities: DimensionQuality[] = [
    sentinelQualityOf(row.project_key),
    row.recruiter_quality,
    sentinelQualityOf(row.provider_type_key),
    sentinelQualityOf(row.employment_type_key),
  ];
  return { unknown: qualities.includes("unknown"), invalid: qualities.includes("invalid") };
}

function dimensionAffected(rows: readonly EngineFactRow[], dimension: Dimension): boolean {
  for (const row of rows) {
    if (dimension === "project" && sentinelQualityOf(row.project_key) !== "ok") return true;
    if (dimension === "recruiter" && row.recruiter_quality !== "ok") return true;
    if (dimension === "provider" && sentinelQualityOf(row.provider_type_key) !== "ok") return true;
    if (dimension === "employment" && sentinelQualityOf(row.employment_type_key) !== "ok") return true;
  }
  return false;
}

/** Số tuần ISO ĐÃ HOÀN TẤT (trước kỳ hiện tại) có ít nhất một fact. */
function countWeeksWithFacts(rows: readonly EngineFactRow[], periodStart: string): number {
  const weeks = new Set<string>();
  for (const row of rows) {
    if (row.business_date >= periodStart) continue;
    const { year, week } = isoWeekOf(row.business_date);
    weeks.add(year + "-" + week);
  }
  return Math.min(weeks.size, MAX_DAY_OF_WEEK_WEEKS);
}

/** Khoảng liền trước có CÙNG độ dài (custom comparison/stability). */
function buildCustomBaselines(plan: { start: string; elapsed_days: number }, dataStart: string | null): Window[] {
  const out: Window[] = [];
  if (!dataStart) return out;
  const length = plan.elapsed_days;
  let cursorStart = plan.start;
  for (let i = 0; i < MAX_STABILITY_POINTS; i++) {
    const end = addDays(cursorStart, -1);
    const start = addDays(end, -(length - 1));
    if (start < dataStart) break;
    out.push({ start, end });
    cursorStart = start;
  }
  return out;
}

function buildStabilityPoints(
  plan: { status: string },
  windows: readonly Window[],
  rows: readonly EngineFactRow[],
  currentTotal: number
): number[] {
  const chronological = [...windows].reverse().map((w) => sumInRange(rows, w.start, w.end));
  const points = [...chronological];
  if (plan.status === "complete") points.push(currentTotal);
  return points.slice(-MAX_STABILITY_POINTS);
}

function buildStability(points: readonly number[], totalsComparable: number | null, totalsDelta: number | null) {
  const mean = points.length > 0 ? meanOf(points) : null;
  const stddev = points.length > 0 ? populationStddevOf(points) : null;
  const enough = points.length >= STABILITY_MIN_POINTS && mean !== null && mean > 0;
  const cv = enough ? (stddev as number) / (mean as number) : null;
  const volatility = enough ? volatilityBand(cv) : "unknown";
  const trend_direction =
    totalsComparable === null || totalsDelta === null ? "unknown" : totalsDelta > 0 ? "up" : totalsDelta < 0 ? "down" : "flat";
  return {
    formula: STABILITY_FORMULA as AnalysisPacket["stability"]["formula"],
    formula_version: STABILITY_FORMULA_VERSION as AnalysisPacket["stability"]["formula_version"],
    period_points: points.length,
    mean: mean,
    stddev: stddev,
    cv: cv,
    trend_direction: trend_direction as AnalysisPacket["stability"]["trend_direction"],
    volatility: volatility as AnalysisPacket["stability"]["volatility"],
  };
}

function buildProjectProviderMix(
  currentRows: readonly EngineFactRow[],
  projectRefs: Map<string, string>
): MixRow[] {
  const groups = new Map<string, { total: number; hrp: number; vendor: number; unknown: number; invalid: number }>();
  for (const row of currentRows) {
    const ref = projectRefs.get(row.project_key);
    if (!ref) continue;
    let group = groups.get(ref);
    if (!group) {
      group = { total: 0, hrp: 0, vendor: 0, unknown: 0, invalid: 0 };
      groups.set(ref, group);
    }
    group.total += row.recruited_count;
    if (row.provider_type_key === "hrp") group.hrp += row.recruited_count;
    else if (row.provider_type_key === "vendor") group.vendor += row.recruited_count;
    else if (row.provider_type_key === "__unknown__") group.unknown += row.recruited_count;
    else group.invalid += row.recruited_count;
  }
  return [...groups.entries()]
    .sort((a, b) => sortRefs(a[0], b[0]))
    .map(([ref, group]) => {
      const known = group.hrp + group.vendor;
      return {
        subject_ref: ref,
        project_total: group.total,
        hrp_count: group.hrp,
        vendor_count: group.vendor,
        unknown_count: group.unknown,
        invalid_count: group.invalid,
        known_total: known,
        hrp_share: known > 0 ? group.hrp / known : null,
        vendor_share: known > 0 ? group.vendor / known : null,
        known_coverage: group.total > 0 ? known / group.total : null,
      };
    });
}

interface BreakdownResult {
  drivers: Record<Dimension, DriverEntry[]>;
  concentration: Record<Dimension, ConcentrationEntry>;
  remainder: Record<Dimension, number>;
  /** Tổng current của TOÀN BỘ subject (trước khi cắt bớt driver) — dùng cho invariant reconcile. */
  covered: Record<Dimension, number>;
}

function emptyBreakdown(): BreakdownResult {
  return {
    drivers: { project: [], recruiter: [], team: [], provider: [], employment: [] },
    concentration: {
      project: { ...EMPTY_CONCENTRATION },
      recruiter: { ...EMPTY_CONCENTRATION },
      team: { ...EMPTY_CONCENTRATION },
      provider: { ...EMPTY_CONCENTRATION },
      employment: { ...EMPTY_CONCENTRATION },
    },
    remainder: { project: 0, recruiter: 0, team: 0, provider: 0, employment: 0 },
    covered: { project: 0, recruiter: 0, team: 0, provider: 0, employment: 0 },
  };
}

function refOf(row: EngineFactRow, dimension: Dimension, projectRefs: Map<string, string>): string | null {
  if (dimension === "project") return projectRefs.get(row.project_key) ?? null;
  if (dimension === "recruiter") return row.recruiter_ref;
  if (dimension === "team") return row.team_ref;
  if (dimension === "provider") return PROVIDER_SUBJECTS[row.provider_type_key as keyof typeof PROVIDER_SUBJECTS].ref;
  return EMPLOYMENT_SUBJECTS[row.employment_type_key as keyof typeof EMPLOYMENT_SUBJECTS].ref;
}

function buildDimension(
  dimension: Dimension,
  currentRows: readonly EngineFactRow[],
  comparableRows: readonly EngineFactRow[],
  comparableReady: boolean,
  projectRefs: Map<string, string>,
  totalsCurrent: number
): { entries: DriverEntry[]; concentration: ConcentrationEntry; remainder: number; covered: number } {
  const current = new Map<string, number>();
  const comparable = new Map<string, number>();
  for (const row of currentRows) {
    const ref = refOf(row, dimension, projectRefs);
    if (ref === null) continue;
    current.set(ref, (current.get(ref) ?? 0) + row.recruited_count);
  }
  if (comparableReady) {
    for (const row of comparableRows) {
      const ref = refOf(row, dimension, projectRefs);
      if (ref === null) continue;
      comparable.set(ref, (comparable.get(ref) ?? 0) + row.recruited_count);
    }
  }

  const refs = [...new Set([...current.keys(), ...comparable.keys()])].sort(sortRefs);
  const deltas = refs.map((ref) => (comparableReady ? (current.get(ref) ?? 0) - (comparable.get(ref) ?? 0) : null));
  let denominator = 0;
  if (comparableReady) for (const d of deltas) denominator += Math.abs(d as number);

  const entries: DriverEntry[] = refs.map((ref, index) => {
    const cur = current.get(ref) ?? 0;
    const delta = deltas[index];
    return {
      subject_ref: ref,
      current: cur,
      comparable: comparableReady ? comparable.get(ref) ?? 0 : null,
      delta: delta,
      delta_contribution_share: comparableReady && denominator > 0 && delta !== null ? Math.abs(delta) / denominator : null,
      share_of_current: totalsCurrent > 0 ? cur / totalsCurrent : null,
    };
  });
  entries.sort((a, b) => b.current - a.current || sortRefs(a.subject_ref, b.subject_ref));

  const positive = entries.filter((entry) => entry.current > 0);
  const concentration: ConcentrationEntry =
    totalsCurrent > 0 && positive.length > 0
      ? {
          top1_ref: positive[0].subject_ref,
          top1_share: positive[0].current / totalsCurrent,
          top3_share: positive.slice(0, 3).reduce((acc, entry) => acc + entry.current, 0) / totalsCurrent,
          distinct_subjects: positive.length,
        }
      : { ...EMPTY_CONCENTRATION };

  let covered = 0;
  for (const entry of entries) covered += entry.current;
  return { entries, concentration, remainder: totalsCurrent - covered, covered };
}

function buildBreakdowns(args: {
  currentRows: readonly EngineFactRow[];
  comparableRows: readonly EngineFactRow[];
  comparableReady: boolean;
  dimensions: readonly Dimension[];
  projectRefs: Map<string, string>;
  totalsCurrent: number;
}): BreakdownResult {
  const result = emptyBreakdown();
  // Tính MỌI dimension để remainder luôn reconcile totals.current, kể cả dimension bị scope loại.
  for (const dimension of DIMENSIONS) {
    if (dimension === "team") continue; // team dùng rule riêng (§5)
    const built = buildDimension(
      dimension,
      args.currentRows,
      args.comparableRows,
      args.comparableReady,
      args.projectRefs,
      args.totalsCurrent
    );
    if (args.dimensions.includes(dimension)) {
      result.drivers[dimension] = built.entries.slice(0, MAX_DRIVER_SUBJECTS);
      result.concentration[dimension] = built.concentration;
    }
    result.remainder[dimension] = built.remainder;
    result.covered[dimension] = built.covered;
  }
  return result;
}

function buildTeamDrivers(args: {
  currentRows: readonly EngineFactRow[];
  comparableRows: readonly EngineFactRow[];
  projectRefs: Map<string, string>;
  comparableReady: boolean;
  totalsCurrent: number;
}): { entries: DriverEntry[]; concentration: ConcentrationEntry; remainder: number; covered: number } {
  return buildDimension("team", args.currentRows, args.comparableRows, args.comparableReady, args.projectRefs, args.totalsCurrent);
}

function buildSeries(plan: ReturnType<typeof buildPeriodPlan>, currentRows: readonly EngineFactRow[]) {
  const effectiveEnd = plan.effective_end;
  if (plan.type === "quarter") {
    const first = isoWeekOf(plan.start);
    let cursor = isoWeekStart(first.year, first.week);
    const points: { period_start: string; period_end: string | null; value: number }[] = [];
    while (cursor <= effectiveEnd) {
      const weekEnd = addDays(cursor, 6);
      const start = cursor < plan.start ? plan.start : cursor;
      const end = weekEnd > effectiveEnd ? effectiveEnd : weekEnd;
      points.push({ period_start: start, period_end: end, value: sumInRange(currentRows, start, end) });
      cursor = addDays(cursor, 7);
    }
    return { granularity: "week" as const, points };
  }
  const points = enumerateDates(plan.start, effectiveEnd).map((date) => ({
    period_start: date,
    period_end: date,
    value: sumInRange(currentRows, date, date),
  }));
  return { granularity: "day" as const, points };
}

function buildDataQuality(sourceHealth: readonly SourceHealthInput[], currentRows: readonly EngineFactRow[]) {
  const expected = sourceHealth.length;
  const withFacts = sourceHealth.filter((source) => source.has_current_facts).length;
  const coverageRatio = expected > 0 ? withFacts / expected : null;

  let unknownAny = 0;
  let invalidAny = 0;
  let overlap = 0;
  for (const row of currentRows) {
    const flags = dimensionQualityOf(row);
    if (flags.unknown) unknownAny += row.recruited_count;
    if (flags.invalid) invalidAny += row.recruited_count;
    if (flags.unknown && flags.invalid) overlap += row.recruited_count;
  }
  /**
   * Contract 0.1 yêu cầu unknown_count + invalid_count <= totals.current.
   * Hai chỉ số được TÍNH ĐỘC LẬP theo từng grain; khi một grain vừa unknown vừa invalid thì
   * ở cấp packet nó chỉ được tính MỘT LẦN (invalid giữ nguyên, unknown trừ phần giao) để giữ
   * invariant hợp lệ, còn cả hai số độc lập vẫn được phát ra dưới dạng evidence.
   */
  const unknownCount = unknownAny - overlap;
  const invalidCount = invalidAny;

  const degradedReasons: string[] = [];
  let quality: QualityStatus;
  if (expected === 0) {
    quality = "unknown";
    degradedReasons.push("SOURCE_NOT_DECLARED");
  } else if (withFacts === 0) {
    quality = "failed";
    degradedReasons.push("SOURCE_NO_CURRENT_FACTS");
  } else if (withFacts < expected || sourceHealth.some((s) => s.status !== "covered") || sourceHealth.some((s) => s.quality !== "ok")) {
    quality = "partial";
    if (withFacts < expected) degradedReasons.push("SOURCE_COVERAGE_INCOMPLETE");
    if (sourceHealth.some((s) => s.status !== "covered")) degradedReasons.push("SOURCE_STATUS_NOT_COVERED");
    if (sourceHealth.some((s) => s.quality !== "ok")) degradedReasons.push("SOURCE_QUALITY_DEGRADED");
  } else {
    quality = "ok";
  }
  if (unknownAny > 0) degradedReasons.push("DIMENSION_UNKNOWN_PRESENT");
  if (invalidAny > 0) degradedReasons.push("DIMENSION_INVALID_PRESENT");

  return {
    expected_sources: expected,
    sources_with_current_facts: withFacts,
    coverage_ratio: coverageRatio,
    unknown_any_count: unknownAny,
    invalid_any_count: invalidAny,
    overlap_count: overlap,
    unknown_count: unknownCount,
    invalid_count: invalidCount,
    quality: quality,
    basis_degraded: quality !== "ok",
    degraded_reasons: degradedReasons,
  };
}

function buildSufficiency(args: {
  weekCount: number;
  monthCount: number;
  quarterCount: number;
  weeksWithFacts: number;
  stabilityPoints: number;
  quality: QualityStatus;
  degradedReasons: readonly string[];
}): SufficiencyRow[] {
  const actual: Record<SufficiencyKey, number> = {
    trend_weekly: args.weekCount,
    trend_monthly: args.monthCount,
    trend_quarterly: args.quarterCount,
    day_of_week: args.weeksWithFacts,
    consistency: args.stabilityPoints,
  };
  const degraded = args.quality !== "ok";
  const degradedReason = args.degradedReasons.includes("SOURCE_COVERAGE_INCOMPLETE")
    ? "SOURCE_COVERAGE_INCOMPLETE"
    : args.degradedReasons.includes("SOURCE_NOT_DECLARED")
      ? "SOURCE_NOT_DECLARED"
      : args.degradedReasons.includes("SOURCE_NO_CURRENT_FACTS")
        ? "SOURCE_NO_CURRENT_FACTS"
        : "SOURCE_QUALITY_DEGRADED";

  return SUFFICIENCY_KEYS.map((key) => {
    const required = BASELINE_REQUIREMENTS[key];
    const actualPoints = actual[key];
    const status: SufficiencyStatus = degraded ? "unknown" : actualPoints >= required ? "met" : "not_met";
    const reason = degraded ? degradedReason : actualPoints >= required ? "BASELINE_MET" : "BASELINE_NOT_MET";
    return { key, required_points: required, actual_points: actualPoints, status, reason_code: reason };
  });
}

function collectSubjects(args: {
  dimensions: readonly Dimension[];
  breakdown: BreakdownResult;
  mix: readonly MixRow[];
  teamBlocked: boolean;
}): SubjectRow[] {
  const map = new Map<string, SubjectRow>();
  map.set("scope", { ref: "scope", kind: "project", catalog_key: null });
  for (const dimension of args.dimensions) {
    if (dimension === "team" && args.teamBlocked) continue;
    for (const entry of args.breakdown.drivers[dimension]) {
      if (map.has(entry.subject_ref)) continue;
      map.set(entry.subject_ref, {
        ref: entry.subject_ref,
        kind: dimension,
        catalog_key:
          dimension === "provider"
            ? (PROVIDER_CATALOG_BY_REF.get(entry.subject_ref) as CatalogKey | undefined) ?? null
            : dimension === "employment"
              ? (EMPLOYMENT_CATALOG_BY_REF.get(entry.subject_ref) as CatalogKey | undefined) ?? null
              : null,
      });
    }
  }
  for (const row of args.mix) {
    if (map.has(row.subject_ref)) continue;
    map.set(row.subject_ref, { ref: row.subject_ref, kind: "project", catalog_key: null });
  }
  return [...map.values()].sort((a, b) => {
    if (a.ref === "scope") return -1;
    if (b.ref === "scope") return 1;
    return DIMENSIONS.indexOf(a.kind) - DIMENSIONS.indexOf(b.kind) || sortRefs(a.ref, b.ref);
  });
}

function checkTeamCoverage(
  coverage: TeamCoverageInput,
  currentRows: readonly EngineFactRow[],
  totalsCurrent: number
): EngineError | null {
  let mapped = 0;
  let unmapped = 0;
  let ambiguous = 0;
  const teams = new Set<string>();
  for (const row of currentRows) {
    if (row.identity_classification === "ambiguous") ambiguous += row.recruited_count;
    else if (row.identity_classification === "mapped") {
      mapped += row.recruited_count;
      if (row.team_ref !== null) teams.add(row.team_ref);
    } else unmapped += row.recruited_count;
  }
  if (
    mapped !== coverage.mapped_recruited_count ||
    unmapped !== coverage.unmapped_recruited_count ||
    ambiguous !== coverage.ambiguous_recruited_count
  ) {
    return fail(
      "TEAM_COVERAGE_INCONSISTENT",
      "team coverage không khớp classification của fact trong kỳ hiện tại.",
      "team.current"
    );
  }
  if (mapped + unmapped + ambiguous !== totalsCurrent) {
    return fail("TEAM_COVERAGE_INCONSISTENT", "mapped + unmapped + ambiguous != totals.current.", "team.current");
  }
  const expectedRatio = totalsCurrent > 0 ? mapped / totalsCurrent : null;
  if (coverage.coverage_ratio !== expectedRatio) {
    return fail("TEAM_COVERAGE_INCONSISTENT", "coverage_ratio không khớp mapped / totals.current.", "team.current.coverage_ratio");
  }
  const blocked = coverage.availability === "ambiguous" || coverage.availability === "unavailable";
  if (blocked && currentRows.some((row) => row.team_ref !== null)) {
    return fail(
      "IDENTITY_REDACTION_MISSING",
      "team mapping bị chặn nhưng fact kỳ hiện tại vẫn còn team_ref (phải redact toàn bộ).",
      "team.current"
    );
  }
  const expectedTeams = blocked ? 0 : coverage.availability === "partial" || coverage.availability === "available" ? teams.size : 0;
  if (coverage.teams_in_scope !== expectedTeams) {
    return fail("TEAM_COVERAGE_INCONSISTENT", "teams_in_scope không khớp số team resolve được.", "team.current.teams_in_scope");
  }
  if (coverage.availability === "ambiguous" && ambiguous <= 0) {
    return fail("TEAM_COVERAGE_INCONSISTENT", "availability ambiguous nhưng ambiguous_recruited_count = 0.", "team.current");
  }
  if (coverage.availability === "unavailable" && (mapped !== 0 || ambiguous !== 0)) {
    return fail("TEAM_COVERAGE_INCONSISTENT", "availability unavailable nhưng còn mapped/ambiguous.", "team.current");
  }
  return null;
}
// ---------------------------------------------------------------------------
// 3. Evidence builder
// ---------------------------------------------------------------------------

type EvidenceUnit = "people" | "percent" | "ratio" | "count" | "days";

interface EvidenceDraft {
  metric: string;
  formulaKey: keyof typeof FORMULA_REGISTRY;
  subject_ref: string;
  value: number;
  unit: EvidenceUnit;
  sufficiency: SufficiencyStatus;
  quality: QualityStatus;
}

function finalizeEvidence(
  drafts: readonly EvidenceDraft[],
  ctx: { periodRef: string; scopeRef: string; snapshotRef: string }
): ValidationResult<PacketEvidence[]> {
  const seen = new Set<string>();
  const unique: EvidenceDraft[] = [];
  for (const draft of drafts) {
    const key = draft.metric + "|" + draft.subject_ref;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(draft);
  }
  unique.sort((a, b) => sortRefs(a.metric, b.metric) || sortRefs(a.subject_ref, b.subject_ref));
  if (unique.length > MAX_EVIDENCE_RECORDS) {
    return fail("EVIDENCE_LIMIT_EXCEEDED", "Số evidence vượt " + MAX_EVIDENCE_RECORDS + ".", "evidence");
  }
  return {
    ok: true,
    value: unique.map((draft, index) => {
      const spec = FORMULA_REGISTRY[draft.formulaKey];
      return {
        evidence_id: "ev_" + String(index + 1).padStart(2, "0"),
        metric: draft.metric,
        formula: spec.formula,
        formula_version: spec.formula_version,
        period_ref: ctx.periodRef,
        scope_ref: ctx.scopeRef,
        subject_ref: draft.subject_ref,
        value: draft.value,
        unit: draft.unit,
        sufficiency: draft.sufficiency,
        quality: draft.quality,
        snapshot_ref: ctx.snapshotRef,
      };
    }),
  };
}

function topByCurrent(entries: readonly DriverEntry[], count: number): DriverEntry[] {
  return [...entries]
    .filter((entry) => entry.current > 0)
    .sort((a, b) => b.current - a.current || sortRefs(a.subject_ref, b.subject_ref))
    .slice(0, count);
}

function topByDelta(entries: readonly DriverEntry[], count: number): DriverEntry[] {
  return [...entries]
    .filter((entry) => entry.delta !== null && entry.delta !== 0)
    .sort((a, b) => Math.abs(b.delta as number) - Math.abs(a.delta as number) || sortRefs(a.subject_ref, b.subject_ref))
    .slice(0, count);
}

function buildEvidenceDrafts(args: {
  totalsCurrent: number;
  totalsComparable: number | null;
  totalsDelta: number | null;
  totalsDeltaPct: number | null;
  stability: { mean: number | null; stddev: number | null; cv: number | null };
  breakdown: BreakdownResult;
  dimensions: readonly Dimension[];
  mix: readonly MixRow[];
  quality: { quality: QualityStatus; coverage_ratio: number | null; expected_sources: number; unknown_count: number; invalid_count: number; unknown_any_count: number; invalid_any_count: number; overlap_count: number };
  currentRows: readonly EngineFactRow[];
  sufficiency: readonly SufficiencyRow[];
}): EvidenceDraft[] {
  const drafts: EvidenceDraft[] = [];
  const globalQuality = args.quality.quality;
  const basis: SufficiencyStatus = globalQuality === "ok" ? "met" : "unknown";
  const compare: SufficiencyStatus = args.totalsComparable === null ? "not_met" : globalQuality === "ok" ? "met" : "unknown";
  const consistency = args.sufficiency.find((row) => row.key === "consistency");
  const consistencyStatus: SufficiencyStatus = consistency ? consistency.status : "unknown";

  drafts.push({
    metric: "recruited_total",
    formulaKey: "recruited_total",
    subject_ref: "scope",
    value: args.totalsCurrent,
    unit: "people",
    sufficiency: basis,
    quality: globalQuality,
  });
  if (args.totalsComparable !== null) {
    drafts.push({
      metric: "recruited_total_comparable",
      formulaKey: "recruited_total_comparable",
      subject_ref: "scope",
      value: args.totalsComparable,
      unit: "people",
      sufficiency: compare,
      quality: globalQuality,
    });
  }
  if (args.totalsDelta !== null) {
    drafts.push({
      metric: "recruited_delta",
      formulaKey: "recruited_delta",
      subject_ref: "scope",
      value: args.totalsDelta,
      unit: "people",
      sufficiency: compare,
      quality: globalQuality,
    });
  }
  if (args.totalsDeltaPct !== null) {
    drafts.push({
      metric: "recruited_delta_pct",
      formulaKey: "recruited_delta_pct",
      subject_ref: "scope",
      value: args.totalsDeltaPct,
      unit: "ratio",
      sufficiency: compare,
      quality: globalQuality,
    });
  }
  if (args.stability.mean !== null) {
    drafts.push({ metric: "stability_mean", formulaKey: "stability_mean", subject_ref: "scope", value: args.stability.mean, unit: "people", sufficiency: consistencyStatus, quality: globalQuality });
  }
  if (args.stability.stddev !== null) {
    drafts.push({ metric: "stability_stddev", formulaKey: "stability_stddev", subject_ref: "scope", value: args.stability.stddev, unit: "people", sufficiency: consistencyStatus, quality: globalQuality });
  }
  if (args.stability.cv !== null) {
    drafts.push({ metric: "stability_cv", formulaKey: "stability_cv", subject_ref: "scope", value: args.stability.cv, unit: "ratio", sufficiency: consistencyStatus, quality: globalQuality });
  }

  for (const dimension of args.dimensions) {
    const dimensionQuality = worstQuality(globalQuality, dimensionAffected(args.currentRows, dimension) ? "partial" : "ok");
    const concentration = args.breakdown.concentration[dimension];
    if (concentration.top1_share !== null) {
      drafts.push({
        metric: "concentration." + dimension + ".top1_share",
        formulaKey: "concentration_top1_share",
        subject_ref: "scope",
        value: concentration.top1_share,
        unit: "ratio",
        sufficiency: basis,
        quality: dimensionQuality,
      });
    }
    if (concentration.top3_share !== null) {
      drafts.push({
        metric: "concentration." + dimension + ".top3_share",
        formulaKey: "concentration_top3_share",
        subject_ref: "scope",
        value: concentration.top3_share,
        unit: "ratio",
        sufficiency: basis,
        quality: dimensionQuality,
      });
    }
    drafts.push({
      metric: "breakdown_remainder." + dimension,
      formulaKey: "breakdown_remainder",
      subject_ref: "scope",
      value: args.breakdown.remainder[dimension],
      unit: "people",
      sufficiency: basis,
      quality: dimensionQuality,
    });

    const selected = new Map<string, DriverEntry>();
    for (const entry of topByCurrent(args.breakdown.drivers[dimension], 3)) selected.set(entry.subject_ref, entry);
    for (const entry of topByDelta(args.breakdown.drivers[dimension], 3)) selected.set(entry.subject_ref, entry);
    for (const entry of [...selected.values()].sort((a, b) => sortRefs(a.subject_ref, b.subject_ref))) {
      drafts.push({
        metric: "driver." + dimension + ".current",
        formulaKey: "driver_current",
        subject_ref: entry.subject_ref,
        value: entry.current,
        unit: "people",
        sufficiency: basis,
        quality: dimensionQuality,
      });
      if (entry.delta !== null) {
        drafts.push({
          metric: "driver." + dimension + ".delta",
          formulaKey: "driver_delta",
          subject_ref: entry.subject_ref,
          value: entry.delta,
          unit: "people",
          sufficiency: compare,
          quality: dimensionQuality,
        });
      }
      if (entry.delta_contribution_share !== null) {
        drafts.push({
          metric: "driver." + dimension + ".delta_contribution_share",
          formulaKey: "driver_delta_contribution_share",
          subject_ref: entry.subject_ref,
          value: entry.delta_contribution_share,
          unit: "ratio",
          sufficiency: compare,
          quality: dimensionQuality,
        });
      }
      if (entry.share_of_current !== null) {
        drafts.push({
          metric: "driver." + dimension + ".share_of_current",
          formulaKey: "driver_share_of_current",
          subject_ref: entry.subject_ref,
          value: entry.share_of_current,
          unit: "ratio",
          sufficiency: basis,
          quality: dimensionQuality,
        });
      }
    }
  }

  const dataQualitySufficiency: SufficiencyStatus = args.quality.expected_sources > 0 ? "met" : "unknown";
  if (args.quality.coverage_ratio !== null) {
    drafts.push({
      metric: "data_quality.source_coverage",
      formulaKey: "data_quality_source_coverage",
      subject_ref: "scope",
      value: args.quality.coverage_ratio,
      unit: "ratio",
      sufficiency: dataQualitySufficiency,
      quality: globalQuality,
    });
  }
  const qualityCounts: { metric: string; formulaKey: keyof typeof FORMULA_REGISTRY; value: number }[] = [
    { metric: "data_quality.unknown_count", formulaKey: "data_quality_unknown_count", value: args.quality.unknown_count },
    { metric: "data_quality.invalid_count", formulaKey: "data_quality_invalid_count", value: args.quality.invalid_count },
    { metric: "data_quality.unknown_any_count", formulaKey: "data_quality_unknown_any_count", value: args.quality.unknown_any_count },
    { metric: "data_quality.invalid_any_count", formulaKey: "data_quality_invalid_any_count", value: args.quality.invalid_any_count },
    { metric: "data_quality.unknown_invalid_overlap_count", formulaKey: "data_quality_unknown_invalid_overlap_count", value: args.quality.overlap_count },
  ];
  for (const entry of qualityCounts) {
    drafts.push({
      metric: entry.metric,
      formulaKey: entry.formulaKey,
      subject_ref: "scope",
      value: entry.value,
      unit: "people",
      sufficiency: dataQualitySufficiency,
      quality: globalQuality,
    });
  }

  const mixTop = [...args.mix]
    .sort((a, b) => b.project_total - a.project_total || sortRefs(a.subject_ref, b.subject_ref))
    .slice(0, 10);
  for (const row of mixTop) {
    drafts.push({
      metric: "project_mix.total",
      formulaKey: "project_total",
      subject_ref: row.subject_ref,
      value: row.project_total,
      unit: "people",
      sufficiency: basis,
      quality: globalQuality,
    });
    if (row.hrp_share !== null) {
      drafts.push({
        metric: "project_mix.hrp_share",
        formulaKey: "project_hrp_share",
        subject_ref: row.subject_ref,
        value: row.hrp_share,
        unit: "ratio",
        sufficiency: basis,
        quality: globalQuality,
      });
    }
    if (row.vendor_share !== null) {
      drafts.push({
        metric: "project_mix.vendor_share",
        formulaKey: "project_vendor_share",
        subject_ref: row.subject_ref,
        value: row.vendor_share,
        unit: "ratio",
        sufficiency: basis,
        quality: globalQuality,
      });
    }
  }

  return drafts;
}

// ---------------------------------------------------------------------------
// 4. Invariants (fail-closed, trước khi trả packet)
// ---------------------------------------------------------------------------

function findNonFiniteNumber(value: unknown, path = "$"): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findNonFiniteNumber(value[i], path + "[" + i + "]");
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const hit = findNonFiniteNumber((value as Record<string, unknown>)[key], path + "." + key);
      if (hit) return hit;
    }
  }
  return null;
}

function validatePacketInvariants(
  packet: AnalysisPacket,
  ctx: { breakdown: BreakdownResult; teamBlocked: boolean; dimensions: readonly Dimension[] }
): EngineError | null {
  const privacy = scanForbiddenPacketContent(packet);
  if (privacy) return fail("PACKET_PRIVACY_VIOLATION", privacy.message, privacy.path);

  const nonFinite = findNonFiniteNumber(packet);
  if (nonFinite) return fail("PACKET_NON_FINITE", "Packet chứa NaN/Infinity.", nonFinite);

  let seriesSum = 0;
  for (const point of packet.series.points) seriesSum += point.value;
  if (seriesSum !== packet.totals.current) {
    return fail("SERIES_TOTAL_MISMATCH", "sum(series) != totals.current.", "series");
  }

  let mixSum = 0;
  for (const row of packet.project_provider_mix) mixSum += row.project_total;
  if (packet.project_provider_mix.length > 0 && mixSum !== packet.totals.current) {
    return fail("PROJECT_MIX_TOTAL_MISMATCH", "sum(project_total) != totals.current.", "project_provider_mix");
  }

  const units: { path: string; value: number | null }[] = [];
  for (const dimension of DIMENSIONS) {
    const concentration = packet.concentration[dimension];
    units.push({ path: "concentration." + dimension + ".top1_share", value: concentration.top1_share });
    units.push({ path: "concentration." + dimension + ".top3_share", value: concentration.top3_share });
    for (let i = 0; i < packet.drivers[dimension].length; i++) {
      const entry = packet.drivers[dimension][i];
      units.push({ path: "drivers." + dimension + "[" + i + "].delta_contribution_share", value: entry.delta_contribution_share });
      units.push({ path: "drivers." + dimension + "[" + i + "].share_of_current", value: entry.share_of_current });
    }
  }
  units.push({ path: "data_quality.coverage_ratio", value: packet.data_quality.coverage_ratio });
  units.push({ path: "data_quality.unknown_share", value: packet.data_quality.unknown_share });
  units.push({ path: "data_quality.invalid_share", value: packet.data_quality.invalid_share });
  units.push({ path: "team_mapping.coverage_ratio", value: packet.team_mapping.coverage_ratio });
  for (const entry of units) {
    if (entry.value === null) continue;
    if (entry.value < 0 || entry.value > 1) {
      return fail("SHARE_OUT_OF_RANGE", "Share ngoài [0,1].", entry.path);
    }
  }

  if (packet.totals.comparable === 0 && packet.totals.delta_pct !== null) {
    return fail("GROWTH_CLAIM_WITHOUT_BASE", "comparable = 0 nhưng delta_pct khác null.", "totals.delta_pct");
  }
  // Lưu ý: totals.current = 0 vẫn có delta_pct hợp lệ khi comparable > 0 (mức giảm -100%);
  // điều bị cấm là tuyên bố tỷ lệ tăng trưởng khi comparable = 0 (đã chặn ở trên).

  const teamSubjects = packet.subjects.filter((subject) => subject.kind === "team").length;
  if (packet.team_mapping.teams_in_scope !== teamSubjects) {
    return fail("TEAM_MAPPING_INCONSISTENT", "teams_in_scope != số subject kind=team.", "team_mapping.teams_in_scope");
  }
  if (ctx.teamBlocked && (teamSubjects > 0 || packet.drivers.team.length > 0)) {
    return fail("TEAM_MAPPING_INCONSISTENT", "team mapping bị chặn nhưng vẫn có team subject/driver.", "team_mapping");
  }
  if (!ctx.dimensions.includes("team") && (teamSubjects > 0 || packet.drivers.team.length > 0)) {
    return fail("TEAM_MAPPING_INCONSISTENT", "scope loại dimension team nhưng vẫn có team subject/driver.", "team_mapping");
  }

  for (const dimension of DIMENSIONS) {
    if (ctx.breakdown.covered[dimension] + ctx.breakdown.remainder[dimension] !== packet.totals.current) {
      return fail("BREAKDOWN_RECONCILE_FAILED", "breakdown " + dimension + " không reconcile totals.current.", "drivers." + dimension);
    }
  }

  const evidenceIds = new Set<string>();
  for (const evidence of packet.evidence) {
    if (evidenceIds.has(evidence.evidence_id)) {
      return fail("DUPLICATE_EVIDENCE_ID", "evidence_id trùng.", "evidence");
    }
    evidenceIds.add(evidence.evidence_id);
  }

  return null;
}

// ---------------------------------------------------------------------------
// 5. Engine entry point
// ---------------------------------------------------------------------------


/**
 * Sinh packet fail-closed. Không bao giờ trả packet một phần, không bao giờ biến lỗi thành số 0.
 * Caller (server) chịu trách nhiệm validate packet cuối bằng `validateAnalysisPacket`.
 */
export function buildFeaturePacket(input: FeatureEngineInput): EngineResult {
  const validated = validateEngineInput(input);
  if (!validated.ok) return validated;
  const { request, facts, sourceHealth, team, metadata } = validated.value;

  const plan = buildPeriodPlan(request.period);
  if (plan.elapsed_days > MAX_PERIOD_DAYS) {
    return fail("PERIOD_TOO_LONG", "period vượt " + MAX_PERIOD_DAYS + " ngày.", "request.period");
  }

  const dimensions = request.scope.dimensions;
  if (!dimensions.includes("team") && team.current.availability === "partial") {
    return fail(
      "TEAM_DIMENSION_REQUIRED_FOR_PARTIAL",
      "team coverage partial nhưng scope loại dimension team (contract yêu cầu team subject).",
      "request.scope.dimensions"
    );
  }

  const scoped = applyFilters(facts, request.scope.filters);
  const currentRows = rowsInWindow(scoped, { start: plan.start, end: plan.effective_end });
  const comparableRows = rowsInWindow(
    scoped,
    plan.comparable ? { start: plan.comparable.start, end: plan.comparable.end } : null
  );

  const totalsCurrent = sumCount(currentRows);
  const dataStart = scoped.length > 0 ? scoped.map((row) => row.business_date).sort()[0] : null;
  const comparableCovered = plan.comparable !== null && dataStart !== null && plan.comparable.end >= dataStart;
  const totalsComparable = comparableCovered ? sumCount(comparableRows) : null;
  const totalsDelta = totalsComparable === null ? null : totalsCurrent - totalsComparable;
  const totalsDeltaPct =
    totalsComparable !== null && totalsComparable > 0 ? (totalsDelta as number) / totalsComparable : null;

  const teamError = checkTeamCoverage(team.current, currentRows, totalsCurrent);
  if (teamError) return teamError;

  const teamBlocked = team.current.availability === "ambiguous" || team.current.availability === "unavailable";
  const projectRefs = buildRefMap("project", scoped.map((row) => row.project_key));

  const breakdown = buildBreakdowns({
    currentRows,
    comparableRows,
    comparableReady: totalsComparable !== null,
    dimensions,
    projectRefs,
    totalsCurrent,
  });

  const comparableTeamReady =
    totalsComparable !== null && team.comparable !== null && team.comparable.availability === "available";
  const teamComparableReady = !teamBlocked && comparableTeamReady;
  const teamBuilt = buildTeamDrivers({
    currentRows,
    comparableRows,
    projectRefs,
    comparableReady: teamComparableReady,
    totalsCurrent,
  });
  breakdown.remainder.team = teamBuilt.remainder;
  breakdown.covered.team = teamBuilt.covered;
  if (dimensions.includes("team")) {
    breakdown.drivers.team = teamBuilt.entries.slice(0, MAX_DRIVER_SUBJECTS);
    breakdown.concentration.team = teamBuilt.concentration;
  }

  const mix = buildProjectProviderMix(currentRows, projectRefs);
  if (mix.length > 500) {
    return fail("PROJECT_MIX_TOO_MANY_SUBJECTS", "project_provider_mix vượt 500 subject.", "project_provider_mix");
  }

  const series = buildSeries(plan, currentRows);
  if (series.points.length > MAX_SERIES_POINTS) {
    return fail("SERIES_TOO_MANY_POINTS", "series vượt " + MAX_SERIES_POINTS + " điểm.", "series");
  }

  const baselines = {
    weeks: buildBaselineWindows("week", plan.start, dataStart, MAX_BASELINE_WEEKS),
    months: buildBaselineWindows("month", plan.start, dataStart, MAX_BASELINE_MONTHS),
    quarters: buildBaselineWindows("quarter", plan.start, dataStart, MAX_BASELINE_QUARTERS),
  };
  const stabilityWindows =
    plan.type === "week"
      ? baselines.weeks
      : plan.type === "month"
        ? baselines.months
        : plan.type === "quarter"
          ? baselines.quarters
          : buildCustomBaselines(plan, dataStart);
  const stabilityPoints = buildStabilityPoints(plan, stabilityWindows, scoped, totalsCurrent);
  const stability = buildStability(stabilityPoints, totalsComparable, totalsDelta);
  const weeksWithFacts = countWeeksWithFacts(scoped, plan.start);

  const quality = buildDataQuality(sourceHealth, currentRows);
  const sufficiency = buildSufficiency({
    weekCount: baselines.weeks.length,
    monthCount: baselines.months.length,
    quarterCount: baselines.quarters.length,
    weeksWithFacts,
    stabilityPoints: stabilityPoints.length,
    quality: quality.quality,
    degradedReasons: quality.degraded_reasons,
  });

  const scopeHash = canonicalHash({
    dimensions: [...dimensions],
    filters: request.scope.filters,
    sources_in_scope: sourceHealth.length,
    access_scope_hash: metadata.access_scope_hash,
  });

  const sortedFacts = [...scoped].sort(compareFactRows);
  const snapshotHash = canonicalHash({
    scope_hash: scopeHash,
    period: {
      period_ref: plan.period_ref,
      type: plan.type,
      start: plan.start,
      end: plan.end,
      status: plan.status,
      elapsed_days: plan.elapsed_days,
      comparable: plan.comparable
        ? {
            period_ref: plan.comparable.period_ref,
            start: plan.comparable.start,
            end: plan.comparable.end,
            elapsed_days: plan.comparable.elapsed_days,
          }
        : null,
    },
    facts: sortedFacts.map((row) => ({
      business_date: row.business_date,
      project_ref: projectRefs.get(row.project_key) ?? null,
      recruiter_ref: row.recruiter_ref,
      team_ref: row.team_ref,
      provider_type_key: row.provider_type_key,
      employment_type_key: row.employment_type_key,
      recruited_count: row.recruited_count,
      source_ref: row.source_ref,
      identity_classification: row.identity_classification,
    })),
    source_health: sourceHealth.map((source) => ({
      source_ref: source.source_ref,
      status: source.status,
      quality: source.quality,
      has_current_facts: source.has_current_facts,
    })),
    team: { current: team.current, comparable: team.comparable },
    lineage_ref: metadata.lineage_ref,
    generated_from: metadata.generated_from,
  });

  const subjects = collectSubjects({ dimensions, breakdown, mix, teamBlocked });
  const teamSubjectCount = subjects.filter((subject) => subject.kind === "team").length;

  const drafts = buildEvidenceDrafts({
    totalsCurrent,
    totalsComparable,
    totalsDelta,
    totalsDeltaPct,
    stability,
    breakdown,
    dimensions,
    mix,
    quality,
    currentRows,
    sufficiency,
  });
  const evidence = finalizeEvidence(drafts, {
    periodRef: plan.period_ref,
    scopeRef: scopeHash,
    snapshotRef: snapshotHash,
  });
  if (!evidence.ok) return evidence;

  const packet: AnalysisPacket = {
    contract_version: "analysis-packet/0.1",
    generated_at: metadata.generated_at,
    snapshot: {
      hash: snapshotHash,
      lineage_ref: metadata.lineage_ref,
      generated_from: metadata.generated_from,
    },
    scope: {
      scope_hash: scopeHash,
      access_scope_hash: metadata.access_scope_hash,
      sources_in_scope: sourceHealth.length,
      dimensions: [...dimensions],
    },
    team_mapping: {
      availability: team.current.availability,
      mapped_recruited_count: team.current.mapped_recruited_count,
      unmapped_recruited_count: team.current.unmapped_recruited_count,
      ambiguous_recruited_count: team.current.ambiguous_recruited_count,
      coverage_ratio: team.current.coverage_ratio,
      teams_in_scope: teamSubjectCount,
      reason_code: team.current.reason_code,
    },
    period: {
      period_ref: plan.period_ref,
      type: plan.type,
      start: plan.start,
      end: plan.end,
      timezone: "Asia/Ho_Chi_Minh",
      status: plan.status === "complete" ? "complete" : "period_to_date",
      period_to_date: plan.period_to_date,
      elapsed_days: plan.elapsed_days,
      comparable: plan.comparable
        ? {
            period_ref: plan.comparable.period_ref,
            start: plan.comparable.start,
            end: plan.comparable.end,
            elapsed_days: plan.comparable.elapsed_days,
          }
        : null,
    },
    totals: {
      current: totalsCurrent,
      comparable: totalsComparable,
      delta: totalsDelta,
      delta_pct: totalsDeltaPct,
    },
    drivers: breakdown.drivers,
    concentration: breakdown.concentration,
    stability,
    series,
    data_quality: {
      sources: sourceHealth.map((source) => ({
        source_ref: source.source_ref,
        status: source.status,
        quality: source.quality,
      })),
      coverage_ratio: quality.coverage_ratio,
      unknown_count: quality.unknown_count,
      invalid_count: quality.invalid_count,
      unknown_share: totalsCurrent > 0 ? quality.unknown_count / totalsCurrent : null,
      invalid_share: totalsCurrent > 0 ? quality.invalid_count / totalsCurrent : null,
    },
    project_provider_mix: mix,
    sufficiency,
    subjects,
    evidence: evidence.value,
  };

  const invariantError = validatePacketInvariants(packet, { breakdown, teamBlocked, dimensions });
  if (invariantError) return invariantError;

  const detail: EngineDetail = {
    current: { period_ref: plan.period_ref, start: plan.start, end: plan.effective_end, elapsed_days: plan.elapsed_days },
    comparable: plan.comparable
      ? {
          period_ref: plan.comparable.period_ref,
          start: plan.comparable.start,
          end: plan.comparable.end,
          elapsed_days: plan.comparable.elapsed_days,
        }
      : null,
    baseline_counts: {
      trend_weekly: baselines.weeks.length,
      trend_monthly: baselines.months.length,
      trend_quarterly: baselines.quarters.length,
      day_of_week: weeksWithFacts,
      consistency: stabilityPoints.length,
    },
    data_quality: {
      expected_sources: quality.expected_sources,
      sources_with_current_facts: quality.sources_with_current_facts,
      coverage_ratio: quality.coverage_ratio,
      unknown_any_count: quality.unknown_any_count,
      invalid_any_count: quality.invalid_any_count,
      overlap_count: quality.overlap_count,
      unknown_count: quality.unknown_count,
      invalid_count: quality.invalid_count,
      quality: quality.quality,
      basis_degraded: quality.basis_degraded,
      degraded_reasons: quality.degraded_reasons,
    },
    sufficiency: sufficiency.map((row) => ({ ...row })),
    breakdown_remainder: { ...breakdown.remainder },
    refs: {
      projects: projectRefs.size,
      recruiters: new Set(scoped.map((row) => row.recruiter_ref).filter((ref): ref is string => ref !== null)).size,
      teams: new Set(scoped.map((row) => row.team_ref).filter((ref): ref is string => ref !== null)).size,
      sources: sourceHealth.length,
    },
    evidence_count: evidence.value.length,
  };

  return { ok: true, packet, detail };
}
