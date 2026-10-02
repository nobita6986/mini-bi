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
  PROVIDER_FACT_KEYS,
  QUALITY_REASON_CODES,
  SENTINEL_KEYS,
  TEAM_MAPPING_REASON,
  compareStable,
  formatOpaqueRef,
  isNonEmptyId,
  isNonNegativeInteger,
  isRealCalendarDate,
  isValidInterval,
  isWithinInterval,
  normalizeReportingKey,
  resolvedFactSortKey,
} from "./identity-shared.mjs";
import type {
  IdentityClassification,
  IdentityFactInput,
  IdentityProjectionResult,
  IdentityQualityIssue,
  IdentityRefMap,
  IdentityValidationCode,
  IdentityValidationFailure,
  IdentityValidationResult,
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

const PROVIDER_MEMBERSHIP_TYPES = ["hrp", "vendor"];
const AUDIT_ENTITIES = ["recruiter", "team", "recruiter_alias", "provider_membership", "team_membership"];

function fail(code: IdentityValidationCode, message: string, path: string): IdentityValidationFailure {
  return { ok: false, code, message, path };
}

/**
 * Validate catalog TRƯỚC khi resolve (fail-closed).
 *
 * Overlap alias/team membership KHÔNG bị sửa hay ưu tiên ở đây: resolver vẫn phân loại
 * `ambiguous`. Hàm này chỉ chặn input KHÔNG THỂ resolve đúng.
 */
export function validateMembershipCatalog(catalog: MembershipCatalog): IdentityValidationResult {
  if (!catalog || typeof catalog !== "object") return fail("CATALOG_NOT_OBJECT", "Catalog không phải object.", "catalog");
  const lists = [
    catalog.recruiters,
    catalog.aliases,
    catalog.teams,
    catalog.provider_memberships,
    catalog.team_memberships,
    catalog.audit,
  ];
  if (lists.some((list) => !Array.isArray(list))) {
    return fail("CATALOG_NOT_OBJECT", "Catalog thiếu mảng bắt buộc.", "catalog");
  }

  const recruiterIds = new Set<string>();
  for (let i = 0; i < catalog.recruiters.length; i++) {
    const row = catalog.recruiters[i];
    const path = `recruiters[${i}]`;
    if (!isNonEmptyId(row?.recruiter_id)) return fail("CATALOG_ID_EMPTY", "recruiter_id rỗng.", path + ".recruiter_id");
    if (recruiterIds.has(row.recruiter_id)) {
      return fail("CATALOG_ID_DUPLICATE", "recruiter_id trùng: " + row.recruiter_id + ".", path + ".recruiter_id");
    }
    recruiterIds.add(row.recruiter_id);
    if (typeof row.active !== "boolean") return fail("CATALOG_INVALID_FLAG", "recruiter.active phải là boolean.", path + ".active");
  }

  const teamIds = new Set<string>();
  for (let i = 0; i < catalog.teams.length; i++) {
    const row = catalog.teams[i];
    const path = `teams[${i}]`;
    if (!isNonEmptyId(row?.team_id)) return fail("CATALOG_ID_EMPTY", "team_id rỗng.", path + ".team_id");
    if (teamIds.has(row.team_id)) return fail("CATALOG_ID_DUPLICATE", "team_id trùng: " + row.team_id + ".", path + ".team_id");
    teamIds.add(row.team_id);
    if (typeof row.active !== "boolean") return fail("CATALOG_INVALID_FLAG", "team.active phải là boolean.", path + ".active");
  }

  const aliasIds = new Set<string>();
  for (let i = 0; i < catalog.aliases.length; i++) {
    const row = catalog.aliases[i];
    const path = `aliases[${i}]`;
    if (!isNonEmptyId(row?.alias_id)) return fail("CATALOG_ID_EMPTY", "alias_id rỗng.", path + ".alias_id");
    if (aliasIds.has(row.alias_id)) return fail("CATALOG_ID_DUPLICATE", "alias_id trùng: " + row.alias_id + ".", path + ".alias_id");
    aliasIds.add(row.alias_id);
    if (!recruiterIds.has(row.recruiter_id)) {
      return fail("CATALOG_DANGLING_RECRUITER", "alias trỏ recruiter không tồn tại: " + row.recruiter_id + ".", path + ".recruiter_id");
    }
    const normalized = normalizeReportingKey(row.reporting_key);
    if (normalized === null || normalized !== row.reporting_key) {
      return fail(
        "CATALOG_INVALID_REPORTING_KEY",
        "reporting_key phải đã normalize (trim/lowercase) và không rỗng.",
        path + ".reporting_key"
      );
    }
    if (SENTINEL_KEYS.includes(row.reporting_key)) {
      return fail("CATALOG_INVALID_REPORTING_KEY", "reporting_key không được là sentinel key.", path + ".reporting_key");
    }
    if (!isValidInterval(row.valid_from, row.valid_to)) {
      return fail("CATALOG_INVALID_INTERVAL", "alias cần valid_from hợp lệ và valid_to > valid_from (hoặc null).", path + ".valid_to");
    }
  }

  const providerIds = new Set<string>();
  for (let i = 0; i < catalog.provider_memberships.length; i++) {
    const row = catalog.provider_memberships[i];
    const path = `provider_memberships[${i}]`;
    if (!isNonEmptyId(row?.membership_id)) return fail("CATALOG_ID_EMPTY", "membership_id rỗng.", path + ".membership_id");
    if (providerIds.has(row.membership_id)) {
      return fail("CATALOG_ID_DUPLICATE", "membership_id trùng: " + row.membership_id + ".", path + ".membership_id");
    }
    providerIds.add(row.membership_id);
    if (!recruiterIds.has(row.recruiter_id)) {
      return fail("CATALOG_DANGLING_RECRUITER", "provider membership trỏ recruiter không tồn tại: " + row.recruiter_id + ".", path + ".recruiter_id");
    }
    if (!PROVIDER_MEMBERSHIP_TYPES.includes(row.provider_type)) {
      return fail("CATALOG_INVALID_PROVIDER_TYPE", "provider_type không hợp lệ: " + String(row.provider_type) + ".", path + ".provider_type");
    }
    if (!isValidInterval(row.valid_from, row.valid_to)) {
      return fail("CATALOG_INVALID_INTERVAL", "provider membership cần valid_from hợp lệ và valid_to > valid_from (hoặc null).", path + ".valid_to");
    }
  }

  const teamMembershipIds = new Set<string>();
  for (let i = 0; i < catalog.team_memberships.length; i++) {
    const row = catalog.team_memberships[i];
    const path = `team_memberships[${i}]`;
    if (!isNonEmptyId(row?.membership_id)) return fail("CATALOG_ID_EMPTY", "membership_id rỗng.", path + ".membership_id");
    if (teamMembershipIds.has(row.membership_id)) {
      return fail("CATALOG_ID_DUPLICATE", "membership_id trùng: " + row.membership_id + ".", path + ".membership_id");
    }
    teamMembershipIds.add(row.membership_id);
    if (!recruiterIds.has(row.recruiter_id)) {
      return fail("CATALOG_DANGLING_RECRUITER", "team membership trỏ recruiter không tồn tại: " + row.recruiter_id + ".", path + ".recruiter_id");
    }
    if (!teamIds.has(row.team_id)) {
      return fail("CATALOG_DANGLING_TEAM", "team membership trỏ team không tồn tại: " + row.team_id + ".", path + ".team_id");
    }
    if (!isValidInterval(row.valid_from, row.valid_to)) {
      return fail("CATALOG_INVALID_INTERVAL", "team membership cần valid_from hợp lệ và valid_to > valid_from (hoặc null).", path + ".valid_to");
    }
  }

  const changeIds = new Set<string>();
  for (let i = 0; i < catalog.audit.length; i++) {
    const row = catalog.audit[i];
    const path = `audit[${i}]`;
    if (!isNonEmptyId(row?.change_id)) return fail("CATALOG_INVALID_AUDIT", "change_id rỗng.", path + ".change_id");
    if (changeIds.has(row.change_id)) return fail("CATALOG_INVALID_AUDIT", "change_id trùng: " + row.change_id + ".", path + ".change_id");
    changeIds.add(row.change_id);
    if (!AUDIT_ENTITIES.includes(row.entity)) return fail("CATALOG_INVALID_AUDIT", "entity không hợp lệ: " + String(row.entity) + ".", path + ".entity");
    if (!isNonEmptyId(row.ref)) return fail("CATALOG_INVALID_AUDIT", "ref rỗng.", path + ".ref");
    if (!isNonEmptyId(row.after_revision_ref)) return fail("CATALOG_INVALID_AUDIT", "after_revision_ref rỗng.", path + ".after_revision_ref");
    if (!isNonEmptyId(row.actor_ref)) return fail("CATALOG_INVALID_AUDIT", "actor_ref rỗng.", path + ".actor_ref");
    if (!isRealCalendarDate(row.effective_date)) return fail("CATALOG_INVALID_DATE", "effective_date không phải ngày hợp lệ.", path + ".effective_date");
  }

  return { ok: true };
}

/** Validate fact input (fail-closed). Sentinel key vẫn hợp lệ — đó là dữ liệu, không phải lỗi contract. */
export function validateIdentityFacts(facts: readonly IdentityFactInput[]): IdentityValidationResult {
  if (!Array.isArray(facts)) return fail("FACT_INVALID_DATE", "facts phải là mảng.", "facts");
  for (let i = 0; i < facts.length; i++) {
    const row = facts[i];
    const path = `facts[${i}]`;
    if (!isRealCalendarDate(row?.business_date)) return fail("FACT_INVALID_DATE", "business_date không phải ngày hợp lệ.", path + ".business_date");
    if (!isNonNegativeInteger(row.recruited_count)) {
      return fail("FACT_INVALID_COUNT", "recruited_count phải là integer >= 0.", path + ".recruited_count");
    }
    if (typeof row.provider_type_key !== "string" || !PROVIDER_FACT_KEYS.includes(row.provider_type_key)) {
      return fail("FACT_INVALID_PROVIDER_KEY", "provider_type_key không thuộc catalog đã khóa: " + String(row.provider_type_key) + ".", path + ".provider_type_key");
    }
    if (typeof row.recruiter_key !== "string") {
      return fail("FACT_INVALID_RECRUITER_KEY", "recruiter_key phải là string.", path + ".recruiter_key");
    }
  }
  return { ok: true };
}

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
 *
 * Lịch sử là BẤT BIẾN: alias được lọc DUY NHẤT theo interval [valid_from, valid_to).
 * Không có cờ `active` nào tham gia resolve, nên đóng/mở hiệu lực hiện tại không viết lại
 * quá khứ. Recruiter/team inactive vẫn map được fact lịch sử.
 *
 * Precondition: catalog/facts đã hợp lệ. Dùng `projectIdentity` để có fail-closed.
 */
export function resolveIdentityFacts(
  catalog: MembershipCatalog,
  facts: readonly IdentityFactInput[]
): ResolvedIdentityFact[] {
  const aliasByKey = groupBy<RecruiterAlias, string>(catalog.aliases, (a) => a.reporting_key);
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
 *
 * `blockTeams`: khi team mapping ambiguous, KHÔNG cấp team ref nào ⇒ phía packet
 * không thể dựng team subject/driver từ dữ liệu mơ hồ.
 */
export function buildIdentityRefMap(
  resolved: readonly ResolvedIdentityFact[],
  options: { blockTeams?: boolean } = {}
): IdentityRefMap {
  const recruiterIds = [...new Set(resolved.map((r) => r.recruiter_id).filter((x): x is string => x !== null))].sort(
    compareStable
  );
  const teamIds = options.blockTeams
    ? []
    : [...new Set(resolved.map((r) => r.team_id).filter((x): x is string => x !== null))].sort(compareStable);
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
 * Projection đầy đủ: validate -> resolve -> coverage -> opaque refs.
 *
 * FAIL-CLOSED: input không hợp lệ trả lỗi rõ ràng (`ok: false` + code + path), KHÔNG bao giờ
 * trả projection "thành công" hay tổng 0 giả.
 *
 * REDACTION: khi team mapping `ambiguous`, MỌI packet-facing `team_ref` bị đặt null và
 * `ref_map.teams` rỗng — kể cả những fact riêng lẻ trước đó resolve được team.
 * Recruiter ref vẫn giữ nếu recruiter identity không mơ hồ.
 * Stable team id chỉ còn trong `server_diagnostics` (ops-only, không packet-facing).
 */
export function projectIdentity(
  catalog: MembershipCatalog,
  facts: readonly IdentityFactInput[]
): IdentityProjectionResult {
  const catalogCheck = validateMembershipCatalog(catalog);
  if (!catalogCheck.ok) return catalogCheck;
  const factCheck = validateIdentityFacts(facts);
  if (!factCheck.ok) return factCheck;

  const resolved = resolveIdentityFacts(catalog, facts);
  const coverage = buildTeamCoverage(resolved);
  const ambiguousBlocked = coverage.availability === "ambiguous";
  const refMap = buildIdentityRefMap(resolved, { blockTeams: ambiguousBlocked });
  const recruiterRef = new Map(refMap.recruiters.map((e) => [e.stable_id, e.ref]));
  const teamRef = new Map(refMap.teams.map((e) => [e.stable_id, e.ref]));

  const projected: ProjectedIdentityFact[] = resolved.map((row) => ({
    business_date: row.business_date,
    recruiter_ref: row.recruiter_id === null ? null : recruiterRef.get(row.recruiter_id) ?? null,
    team_ref: ambiguousBlocked || row.team_id === null ? null : teamRef.get(row.team_id) ?? null,
    provider_type_key: row.provider_type_key,
    recruited_count: row.recruited_count,
    classification: row.classification,
  }));

  const observedTeamIds = [
    ...new Set(resolved.map((row) => row.team_id).filter((id): id is string => id !== null)),
  ].sort(compareStable);

  return {
    ok: true,
    projection: {
      facts: projected,
      team_mapping: coverage,
      ref_map: refMap,
      server_diagnostics: { ambiguous_blocked: ambiguousBlocked, observed_team_ids: observedTeamIds },
      quality_issues: buildIdentityQualityIssues(resolved),
      totals: {
        recruited_total:
          coverage.mapped_recruited_count + coverage.unmapped_recruited_count + coverage.ambiguous_recruited_count,
        mapped_recruited_count: coverage.mapped_recruited_count,
        unmapped_recruited_count: coverage.unmapped_recruited_count,
        ambiguous_recruited_count: coverage.ambiguous_recruited_count,
      },
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
