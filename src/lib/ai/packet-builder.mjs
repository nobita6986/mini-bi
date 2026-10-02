/**
 * P1.5-W03 — Packet builder (server-side orchestration).
 *
 * Nối: analytics request → reporting aggregate facts → identity projection G2 (W02) → feature engine
 * → strict validator `analysis-packet/0.1`.
 *
 * Module .mjs có chủ đích: nó import các module .ts bằng specifier có extension (giống test .mjs của
 * repo), nên Node chạy trực tiếp được mà không cần `allowImportingTsExtensions` (không sửa tsconfig).
 *
 * KHÔNG gọi AI/mạng/DB. Chỉ glue thuần + fail-closed: input sai ⇒ discriminated union lỗi rõ ràng,
 * không bao giờ trả packet một phần.
 */

import { QUALITY_STATUS, SOURCE_STATUSES, buildPeriodPlan, sentinelQualityOf } from "./engine-shared.mjs";
import { normalizeReportingKey } from "../analytics/identity/identity-shared.mjs";
import { buildFeaturePacket, validateAnalyticsRequest, validateReportingFacts } from "./feature-engine.ts";
import { validateAnalysisPacket } from "../analytics/contracts/analysis-packet.ts";
import {
  buildIdentityRefMap,
  buildTeamCoverage,
  projectIdentity,
  resolveIdentityFacts,
  validateIdentityFacts,
  validateMembershipCatalog,
} from "../analytics/identity/projection.ts";

function fail(code, message, path) {
  return { ok: false, code, message, path };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** source_key (stable id, server-side) → source_ref opaque, deterministic theo sort. */
function mapSourceHealth(input) {
  if (!Array.isArray(input)) return fail("SOURCE_HEALTH_INVALID", "source_health phải là mảng.", "source_health");
  const entries = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    const path = "source_health[" + i + "]";
    if (!isPlainObject(raw)) return fail("SOURCE_INVALID", "source health phải là object.", path);
    if (typeof raw.source_key !== "string" || raw.source_key.trim() === "") {
      return fail("SOURCE_INVALID_KEY", "source_key không được rỗng.", path + ".source_key");
    }
    if (typeof raw.status !== "string" || !SOURCE_STATUSES.includes(raw.status)) {
      return fail("SOURCE_INVALID_STATUS", "status không hợp lệ.", path + ".status");
    }
    if (typeof raw.quality !== "string" || !QUALITY_STATUS.includes(raw.quality)) {
      return fail("SOURCE_INVALID_QUALITY", "quality không hợp lệ.", path + ".quality");
    }
    if (typeof raw.has_current_facts !== "boolean") {
      return fail("SOURCE_INVALID_HAS_CURRENT_FACTS", "has_current_facts phải là boolean.", path + ".has_current_facts");
    }
    entries.push({
      source_key: raw.source_key,
      status: raw.status,
      quality: raw.quality,
      has_current_facts: raw.has_current_facts,
    });
  }
  const keys = [...new Set(entries.map((entry) => entry.source_key))].sort(compareText);
  if (keys.length !== entries.length) return fail("SOURCE_DUPLICATE_KEY", "source_key bị lặp.", "source_health");
  const refByKey = new Map(keys.map((key, index) => [key, "source_" + String(index + 1).padStart(2, "0")]));
  const packetFacing = entries
    .map((entry) => ({
      source_ref: refByKey.get(entry.source_key),
      status: entry.status,
      quality: entry.quality,
      has_current_facts: entry.has_current_facts,
    }))
    .sort((a, b) => compareText(a.source_ref, b.source_ref));
  return { ok: true, refByKey, packetFacing };
}

/** Gắn source_ref opaque cho fact; fail-closed nếu fact trỏ source không khai báo. */
function mapFactSources(input, refByKey) {
  if (!Array.isArray(input)) return fail("FACTS_INVALID", "facts phải là mảng.", "facts");
  const mapped = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    const path = "facts[" + i + "]";
    if (!isPlainObject(raw)) return fail("FACT_INVALID", "fact phải là object.", path);
    const ref = refByKey.get(raw.source_key);
    if (!ref) return fail("FACT_SOURCE_UNKNOWN", "fact trỏ source_key ngoài source_health.", path + ".source_key");
    mapped.push({
      business_date: raw.business_date,
      project_key: raw.project_key,
      recruiter_key: raw.recruiter_key,
      provider_type_key: raw.provider_type_key,
      employment_type_key: raw.employment_type_key,
      recruited_count: raw.recruited_count,
      source_ref: ref,
    });
  }
  return { ok: true, value: mapped };
}

/** Scope filter (đã chuẩn hoá) — áp trên key thô, gồm cả recruiter_key mà engine không thấy. */
function applyScopeFilters(facts, filters) {
  return facts.filter((fact) => {
    if (filters.project_keys && !filters.project_keys.includes(fact.project_key)) return false;
    if (filters.recruiter_keys && !filters.recruiter_keys.includes(fact.recruiter_key)) return false;
    if (filters.provider_type_keys && !filters.provider_type_keys.includes(fact.provider_type_key)) return false;
    if (filters.employment_type_keys && !filters.employment_type_keys.includes(fact.employment_type_key)) return false;
    return true;
  });
}

function identityRowKey(businessDate, recruiterKey, providerKey) {
  return businessDate + "|" + recruiterKey + "|" + providerKey;
}

/**
 * Gộp fact thành identity fact theo (business_date, recruiter_key đã chuẩn hoá, provider_type_key).
 * Nhờ gộp, khoá ngược (business_date|key|provider) là DUY NHẤT ⇒ map 1-1 với kết quả resolver.
 */
function aggregateIdentityFacts(facts) {
  const map = new Map();
  for (const fact of facts) {
    const key = normalizeReportingKey(fact.recruiter_key) ?? fact.recruiter_key;
    const composite = identityRowKey(fact.business_date, key, fact.provider_type_key);
    const existing = map.get(composite);
    if (existing) existing.recruited_count += fact.recruited_count;
    else
      map.set(composite, {
        business_date: fact.business_date,
        recruiter_key: key,
        provider_type_key: fact.provider_type_key,
        recruited_count: fact.recruited_count,
      });
  }
  return [...map.values()].sort(
    (a, b) =>
      compareText(a.business_date, b.business_date) ||
      compareText(a.recruiter_key, b.recruiter_key) ||
      compareText(a.provider_type_key, b.provider_type_key)
  );
}

/**
 * Dựng packet từ nguồn thô (server-side).
 *
 * @param input {{ request: unknown, facts: unknown, source_health: unknown, catalog: unknown, metadata: unknown }}
 * @returns {{ ok: true, packet: object, detail: object } | { ok: false, code: string, message: string, path: string }}
 */
export function buildPacketFromSource(input) {
  if (!isPlainObject(input)) return fail("BUILDER_INPUT_INVALID", "Builder input phải là object.", "input");

  const request = validateAnalyticsRequest(input.request);
  if (!request.ok) return request;

  const sourceHealth = mapSourceHealth(input.source_health);
  if (!sourceHealth.ok) return sourceHealth;

  const mappedFacts = mapFactSources(input.facts, sourceHealth.refByKey);
  if (!mappedFacts.ok) return mappedFacts;
  const factsResult = validateReportingFacts(mappedFacts.value);
  if (!factsResult.ok) return factsResult;

  const facts = applyScopeFilters(factsResult.value, request.value.scope.filters);

  // --- G2: catalog + identity facts phải qua validator W02 -------------------
  const catalogCheck = validateMembershipCatalog(input.catalog);
  if (!catalogCheck.ok) return catalogCheck;

  const identityFacts = aggregateIdentityFacts(facts);
  const identityCheck = validateIdentityFacts(identityFacts);
  if (!identityCheck.ok) return identityCheck;

  // Ref opaque ổn định trên UNION của mọi window (current + comparable + baseline).
  const unionResolved = resolveIdentityFacts(input.catalog, identityFacts);
  const unionRefMap = buildIdentityRefMap(unionResolved);
  const recruiterRefById = new Map(unionRefMap.recruiters.map((entry) => [entry.stable_id, entry.ref]));
  const teamRefById = new Map(unionRefMap.teams.map((entry) => [entry.stable_id, entry.ref]));
  const resolvedByKey = new Map(
    unionResolved.map((row) => [identityRowKey(row.business_date, row.recruiter_key, row.provider_type_key), row])
  );

  const plan = buildPeriodPlan(request.value.period);
  const inCurrent = (date) => date >= plan.start && date <= plan.effective_end;

  const currentIdentityFacts = identityFacts.filter((row) => inCurrent(row.business_date));
  const currentProjection = projectIdentity(input.catalog, currentIdentityFacts);
  if (!currentProjection.ok) return currentProjection;
  const currentCoverage = currentProjection.projection.team_mapping;
  const currentBlocked = currentProjection.projection.server_diagnostics.ambiguous_blocked === true;

  let comparableCoverage = null;
  if (plan.comparable) {
    const comparableFacts = identityFacts.filter(
      (row) => row.business_date >= plan.comparable.start && row.business_date <= plan.comparable.end
    );
    comparableCoverage = buildTeamCoverage(resolveIdentityFacts(input.catalog, comparableFacts));
  }

  // --- Packet-facing rows: chỉ opaque ref, không stable id/display/key ---------
  const rows = [];
  for (const fact of facts) {
    const recruiterKey = normalizeReportingKey(fact.recruiter_key) ?? fact.recruiter_key;
    const resolved = resolvedByKey.get(identityRowKey(fact.business_date, recruiterKey, fact.provider_type_key));
    if (!resolved) return fail("IDENTITY_RESOLUTION_MISSING", "Không map được identity fact.", "facts");
    const teamRef = resolved.team_id === null ? null : teamRefById.get(resolved.team_id) ?? null;
    rows.push({
      business_date: fact.business_date,
      project_key: fact.project_key,
      provider_type_key: fact.provider_type_key,
      employment_type_key: fact.employment_type_key,
      recruited_count: fact.recruited_count,
      source_ref: fact.source_ref,
      recruiter_ref: resolved.recruiter_id === null ? null : recruiterRefById.get(resolved.recruiter_id) ?? null,
      // Redaction G2: window hiện tại ambiguous ⇒ toàn bộ team_ref của window đó = null.
      team_ref: currentBlocked && inCurrent(fact.business_date) ? null : teamRef,
      identity_classification: resolved.classification,
      recruiter_quality: sentinelQualityOf(recruiterKey),
    });
  }

  const engineResult = buildFeaturePacket({
    request: request.value,
    facts: rows,
    source_health: sourceHealth.packetFacing,
    team: { current: currentCoverage, comparable: comparableCoverage },
    metadata: input.metadata,
  });
  if (!engineResult.ok) return engineResult;

  const validated = validateAnalysisPacket(engineResult.packet);
  if (!validated.ok) {
    return fail(validated.code, validated.message, validated.path ? validated.path : "packet");
  }

  return { ok: true, packet: validated.value, detail: engineResult.detail };
}
