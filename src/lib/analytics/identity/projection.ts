/**
 * P1.5-W02 — Effective-date identity resolver + projection (pure, deterministic).
 *
 * Gộp resolver và projection trong MỘT module .ts để Node chạy test trực tiếp được:
 * module chỉ import `./identity-shared.mjs` (có extension) và type-only từ `./contracts`.
 *
 * Không suy identity từ display / source filename / project / account; không sửa lại
 * lịch sử theo team hiện tại; interval nửa mở [valid_from, valid_to).
 * Packet-facing output CHỈ chứa opaque ref (không stable id, không display, không PII).
 */

import {
  IDENTITY_REASON,
  QUALITY_REASON_CODES,
  SENTINEL_KEYS,
  TEAM_MAPPING_REASON,
  compareStable,
  formatOpaqueRef,
  isWithinInterval,
  normalizeReportingKey,
  resolvedFactSortKey,
} from "./identity-shared.mjs";
import type {
  IdentityClassification,
  IdentityFactInput,
  IdentityProjection,
  IdentityQualityIssue,
  IdentityRefMap,
  MembershipCatalog,
  ProjectedIdentityFact,
  ProviderMembership,
  ProviderType,
  RecruiterAlias,
  ResolvedIdentityFact,
  TeamAvailability,
  TeamCoverage,
  TeamMembership,
} from "./contracts";

function groupBy<T, K>(rows: readonly T[], keyOf: (row: T) => K | null): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

/**
 * Resolve toàn bộ facts. Kết quả được SORT ổn định và KHÔNG phụ thuộc thứ tự input.
 *
 * Classification:
 * - ambiguous: alias hoặc team membership overlap (nhiều kết quả hợp lệ cùng ngày).
 * - mapped: đúng một recruiter VÀ đúng một team membership.
 * - unmapped: thiếu recruiter hoặc thiếu team membership.
 *
 * Provider membership chỉ tạo quality issue (PROVIDER_MISMATCH / *_NOT_FOUND / *_AMBIGUOUS);
 * provider fact KHÔNG bao giờ bị overwrite và không đổi classification.
 */
export function resolveIdentityFacts(
  catalog: MembershipCatalog,
  facts: readonly IdentityFactInput[]
): ResolvedIdentityFact[] {
  const aliasByKey = groupBy<RecruiterAlias, string>(
    catalog.aliases.filter((a) => a.active),
    (a) => a.reporting_key
  );
  const teamsByRecruiter = groupBy<TeamMembership, string>(catalog.team_memberships, (m) => m.recruiter_id);
  const providersByRecruiter = groupBy<ProviderMembership, string>(catalog.provider_memberships, (m) => m.recruiter_id);

  const resolved = facts.map((fact) => resolveOne(fact, aliasByKey, teamsByRecruiter, providersByRecruiter));
  return [...resolved].sort((a, b) => compareStable(resolvedFactSortKey(a), resolvedFactSortKey(b)));
}

function resolveOne(
  fact: IdentityFactInput,
  aliasByKey: Map<string, RecruiterAlias[]>,
  teamsByRecruiter: Map<string, TeamMembership[]>,
  providersByRecruiter: Map<string, ProviderMembership[]>
): ResolvedIdentityFact {
  const reasonCodes: string[] = [];
  let ambiguous = false;
  let recruiterId: string | null = null;

  const key = normalizeReportingKey(fact.recruiter_key);
  if (key === null) {
    reasonCodes.push(IDENTITY_REASON.RECRUITER_KEY_INVALID);
  } else if (SENTINEL_KEYS.includes(key)) {
    // Unknown/invalid KHÔNG bao giờ được tự gán team.
    reasonCodes.push(IDENTITY_REASON.RECRUITER_KEY_SENTINEL);
  } else {
    const matches = (aliasByKey.get(key) ?? []).filter((a) =>
      isWithinInterval(fact.business_date, a.valid_from, a.valid_to)
    );
    if (matches.length === 0) reasonCodes.push(IDENTITY_REASON.RECRUITER_ALIAS_NOT_FOUND);
    else if (matches.length > 1) {
      ambiguous = true;
      reasonCodes.push(IDENTITY_REASON.RECRUITER_ALIAS_AMBIGUOUS);
    } else {
      recruiterId = matches[0].recruiter_id;
      reasonCodes.push(IDENTITY_REASON.RECRUITER_MAPPED);
    }
  }

  let teamId: string | null = null;
  if (recruiterId !== null) {
    const matches = (teamsByRecruiter.get(recruiterId) ?? []).filter((m) =>
      isWithinInterval(fact.business_date, m.valid_from, m.valid_to)
    );
    if (matches.length === 0) reasonCodes.push(IDENTITY_REASON.TEAM_MEMBERSHIP_NOT_FOUND);
    else if (matches.length > 1) {
      ambiguous = true;
      reasonCodes.push(IDENTITY_REASON.TEAM_MEMBERSHIP_AMBIGUOUS);
    } else {
      teamId = matches[0].team_id;
      reasonCodes.push(IDENTITY_REASON.TEAM_MAPPED);
    }
  }

  let providerMembershipType: ProviderType | null = null;
  let providerMismatch = false;
  if (recruiterId !== null) {
    const matches = (providersByRecruiter.get(recruiterId) ?? []).filter((m) =>
      isWithinInterval(fact.business_date, m.valid_from, m.valid_to)
    );
    if (matches.length === 0) reasonCodes.push(IDENTITY_REASON.PROVIDER_MEMBERSHIP_NOT_FOUND);
    else if (matches.length > 1) reasonCodes.push(IDENTITY_REASON.PROVIDER_MEMBERSHIP_AMBIGUOUS);
    else {
      providerMembershipType = matches[0].provider_type;
      const factProvider = fact.provider_type_key;
      if ((factProvider === "hrp" || factProvider === "vendor") && factProvider !== providerMembershipType) {
        providerMismatch = true;
        reasonCodes.push(IDENTITY_REASON.PROVIDER_MISMATCH);
      } else {
        reasonCodes.push(IDENTITY_REASON.PROVIDER_MATCH);
      }
    }
  }

  const classification: IdentityClassification = ambiguous
    ? "ambiguous"
    : recruiterId !== null && teamId !== null
      ? "mapped"
      : "unmapped";

  return {
    business_date: fact.business_date,
    recruiter_key: key === null ? fact.recruiter_key : key,
    provider_type_key: fact.provider_type_key,
    recruited_count: fact.recruited_count,
    recruiter_id: recruiterId,
    team_id: teamId,
    provider_membership_type: providerMembershipType,
    classification,
    provider_mismatch: providerMismatch,
    reason_codes: reasonCodes,
  };
}

/**
 * Opaque ref deterministic TRONG cùng frozen packet: sort theo stable id (không theo
 * thứ tự DB/input) rồi đánh số 01, 02, ...
 */
export function buildIdentityRefMap(resolved: readonly ResolvedIdentityFact[]): IdentityRefMap {
  const recruiterIds = [...new Set(resolved.map((r) => r.recruiter_id).filter((x): x is string => x !== null))].sort(
    compareStable
  );
  const teamIds = [...new Set(resolved.map((r) => r.team_id).filter((x): x is string => x !== null))].sort(compareStable);
  return {
    recruiters: recruiterIds.map((id, i) => ({ ref: formatOpaqueRef("recruiter", i + 1), stable_id: id })),
    teams: teamIds.map((id, i) => ({ ref: formatOpaqueRef("team", i + 1), stable_id: id })),
  };
}

/**
 * Team coverage fact-weighted theo sum(recruited_count) — KHÔNG đếm row.
 * Map trực tiếp vào contract team_mapping R2.
 */
export function buildTeamCoverage(resolved: readonly ResolvedIdentityFact[]): TeamCoverage {
  let mapped = 0;
  let unmapped = 0;
  let ambiguous = 0;
  const teams = new Set<string>();

  for (const row of resolved) {
    if (row.classification === "ambiguous") ambiguous += row.recruited_count;
    else if (row.classification === "mapped") {
      mapped += row.recruited_count;
      if (row.team_id !== null) teams.add(row.team_id);
    } else unmapped += row.recruited_count;
  }

  const total = mapped + unmapped + ambiguous;
  let availability: TeamAvailability;
  if (ambiguous > 0) availability = "ambiguous";
  else if (mapped > 0 && unmapped > 0) availability = "partial";
  else if (mapped > 0) availability = "available";
  else availability = "unavailable";

  return {
    availability,
    mapped_recruited_count: mapped,
    unmapped_recruited_count: unmapped,
    ambiguous_recruited_count: ambiguous,
    coverage_ratio: total > 0 ? mapped / total : null,
    // Ambiguous/unavailable: KHÔNG phát team subject nào để tránh suy luận sai.
    teams_in_scope: availability === "available" || availability === "partial" ? teams.size : 0,
    reason_code: TEAM_MAPPING_REASON[availability],
  };
}

/** Quality issue riêng (provider mismatch, alias/membership missing hoặc ambiguous). */
export function buildIdentityQualityIssues(resolved: readonly ResolvedIdentityFact[]): IdentityQualityIssue[] {
  const out: IdentityQualityIssue[] = [];
  for (const row of resolved) {
    for (const code of row.reason_codes) {
      if (!QUALITY_REASON_CODES.includes(code)) continue;
      out.push({
        code,
        business_date: row.business_date,
        recruiter_id: row.recruiter_id,
        recruited_count: row.recruited_count,
      });
    }
  }
  return out;
}

/**
 * Projection đầy đủ: resolve -> coverage -> opaque refs.
 * `facts` (packet-facing) chỉ chứa opaque ref; `ref_map` giữ stable id cho server/UI.
 */
export function projectIdentity(catalog: MembershipCatalog, facts: readonly IdentityFactInput[]): IdentityProjection {
  const resolved = resolveIdentityFacts(catalog, facts);
  const refMap = buildIdentityRefMap(resolved);
  const recruiterRef = new Map(refMap.recruiters.map((e) => [e.stable_id, e.ref]));
  const teamRef = new Map(refMap.teams.map((e) => [e.stable_id, e.ref]));

  const projected: ProjectedIdentityFact[] = resolved.map((row) => ({
    business_date: row.business_date,
    recruiter_ref: row.recruiter_id === null ? null : recruiterRef.get(row.recruiter_id) ?? null,
    team_ref: row.team_id === null ? null : teamRef.get(row.team_id) ?? null,
    provider_type_key: row.provider_type_key,
    recruited_count: row.recruited_count,
    classification: row.classification,
  }));

  const coverage = buildTeamCoverage(resolved);

  return {
    facts: projected,
    team_mapping: coverage,
    ref_map: refMap,
    quality_issues: buildIdentityQualityIssues(resolved),
    totals: {
      recruited_total: coverage.mapped_recruited_count + coverage.unmapped_recruited_count + coverage.ambiguous_recruited_count,
      mapped_recruited_count: coverage.mapped_recruited_count,
      unmapped_recruited_count: coverage.unmapped_recruited_count,
      ambiguous_recruited_count: coverage.ambiguous_recruited_count,
    },
  };
}

/** Resolve opaque ref -> display server-side (UI dùng sau validation, KHÔNG đưa vào packet). */
export function resolveRefForDisplay(
  refMap: IdentityRefMap,
  catalog: MembershipCatalog,
  ref: string
): { stable_id: string; display: string } | null {
  const recruiter = refMap.recruiters.find((e) => e.ref === ref);
  if (recruiter) {
    const found = catalog.recruiters.find((r) => r.recruiter_id === recruiter.stable_id);
    return { stable_id: recruiter.stable_id, display: found ? found.display : recruiter.stable_id };
  }
  const team = refMap.teams.find((e) => e.ref === ref);
  if (team) {
    const found = catalog.teams.find((t) => t.team_id === team.stable_id);
    return { stable_id: team.stable_id, display: found ? found.display : team.stable_id };
  }
  return null;
}
