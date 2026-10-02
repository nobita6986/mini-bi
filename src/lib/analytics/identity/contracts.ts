/**
 * P1.5-W02 — Domain contract cho recruiter/team/provider identity & effective membership.
 *
 * CHỈ là domain contract + type: không schema DB, không migration, không UI master.
 * P1.6 sẽ triển khai schema production cho CÙNG stable identities/memberships này.
 *
 * Không chứa PII: display chỉ phục vụ server/UI và KHÔNG bao giờ là identity.
 */

import {
  CLASSIFICATIONS,
  IDENTITY_PROJECTION_VERSION,
  TEAM_AVAILABILITIES,
} from "./identity-shared.mjs";

export { IDENTITY_PROJECTION_VERSION };
export const IDENTITY_CLASSIFICATIONS = CLASSIFICATIONS;
export const IDENTITY_TEAM_AVAILABILITIES = TEAM_AVAILABILITIES;

export type ProviderType = "hrp" | "vendor";
export type ProviderFactKey = "hrp" | "vendor" | "__unknown__" | "__invalid__";
export type IdentityClassification = (typeof CLASSIFICATIONS)[number];
export type TeamAvailability = (typeof TEAM_AVAILABILITIES)[number];

/**
 * Recruiter identity: stable id + display (presentation-only) + active state.
 *
 * `active` CHỈ nghĩa là "còn hiệu lực hiện tại" (eligibility/UI). Nó KHÔNG bao giờ
 * tham gia resolve fact lịch sử: recruiter đã inactive vẫn map được fact cũ.
 */
export interface RecruiterIdentity {
  recruiter_id: string;
  display: string;
  active: boolean;
}

/**
 * Alias reporting key -> recruiter, có hiệu lực CHỈ theo khoảng ngày [valid_from, valid_to).
 *
 * KHÔNG có cờ `active`: alias đã hết hiệu lực vẫn phải resolve được fact lịch sử.
 * Muốn ngừng dùng một alias trong tương lai thì đóng interval (set valid_to),
 * KHÔNG xoá/sửa lịch sử. (Quyết định G2 — đã chốt.)
 */
export interface RecruiterAlias {
  alias_id: string;
  recruiter_id: string;
  reporting_key: string;
  valid_from: string;
  valid_to: string | null;
}

export interface TeamIdentity {
  team_id: string;
  code: string;
  display: string;
  active: boolean;
}

/** Provider membership theo thời gian: HRP/Vendor của một recruiter. */
export interface ProviderMembership {
  membership_id: string;
  recruiter_id: string;
  provider_type: ProviderType;
  valid_from: string;
  valid_to: string | null;
}

/** Team membership theo thời gian: recruiter thuộc team nào. */
export interface TeamMembership {
  membership_id: string;
  recruiter_id: string;
  team_id: string;
  valid_from: string;
  valid_to: string | null;
}

/**
 * Audit projection: version/actor/reason/effective date.
 * Không chứa PII và không chứa secret; actor_ref là opaque reference.
 */
export interface IdentityAuditRecord {
  change_id: string;
  version: number;
  entity: "recruiter" | "team" | "recruiter_alias" | "provider_membership" | "team_membership";
  ref: string;
  before_revision_ref: string | null;
  after_revision_ref: string;
  actor_ref: string;
  reason: string;
  effective_date: string;
  recorded_at: string;
}

/** Catalog thuần (synthetic trong W02; P1.6 sẽ đọc từ schema production). */
export interface MembershipCatalog {
  recruiters: RecruiterIdentity[];
  aliases: RecruiterAlias[];
  teams: TeamIdentity[];
  provider_memberships: ProviderMembership[];
  team_memberships: TeamMembership[];
  audit: IdentityAuditRecord[];
}

/** Fact input tối thiểu cho resolver (từ reporting read-model, KHÔNG có PII). */
export interface IdentityFactInput {
  business_date: string;
  recruiter_key: string;
  provider_type_key: string;
  recruited_count: number;
}

export interface ResolvedIdentityFact {
  business_date: string;
  recruiter_key: string;
  provider_type_key: string;
  recruited_count: number;
  recruiter_id: string | null;
  team_id: string | null;
  provider_membership_type: ProviderType | null;
  classification: IdentityClassification;
  /** Provider fact KHÔNG bị overwrite; mismatch chỉ được ghi nhận ở đây. */
  provider_mismatch: boolean;
  reason_codes: string[];
}

export interface IdentityQualityIssue {
  code: string;
  business_date: string;
  /** Stable id (không phải PII); null khi không resolve được recruiter. */
  recruiter_id: string | null;
  recruited_count: number;
}

/** Output map trực tiếp vào contract team_mapping R2. */
export interface TeamCoverage {
  availability: TeamAvailability;
  mapped_recruited_count: number;
  unmapped_recruited_count: number;
  ambiguous_recruited_count: number;
  coverage_ratio: number | null;
  teams_in_scope: number;
  reason_code: string;
}

export interface OpaqueRefEntry {
  ref: string;
  stable_id: string;
}

/** Bảng resolve opaque ref -> stable id, CHỈ dùng server-side/UI sau validation. */
export interface IdentityRefMap {
  recruiters: OpaqueRefEntry[];
  teams: OpaqueRefEntry[];
}

/** Fact đã chiếu sang opaque ref — phần này mới được đưa vào AI packet. */
export interface ProjectedIdentityFact {
  business_date: string;
  recruiter_ref: string | null;
  team_ref: string | null;
  provider_type_key: string;
  recruited_count: number;
  classification: IdentityClassification;
}

/**
 * Server-only diagnostics: KHÔNG bao giờ đi vào AI packet, không chứa display/PII.
 * Tách khỏi ref_map để redaction team khi ambiguous không làm mất khả năng vận hành.
 */
export interface IdentityServerDiagnostics {
  /** true khi team_mapping.availability === "ambiguous" ⇒ toàn bộ team ref bị redact. */
  ambiguous_blocked: boolean;
  /** Stable team id quan sát được (ops-only, không packet-facing). */
  observed_team_ids: string[];
}

export interface IdentityProjection {
  /** Packet-facing: chỉ opaque ref, không stable id, không display. */
  facts: ProjectedIdentityFact[];
  /** Map trực tiếp vào analysis-packet/0.1 team_mapping. */
  team_mapping: TeamCoverage;
  /**
   * Server-side resolution map (KHÔNG gửi cho AI).
   * Khi team mapping ambiguous: `teams` rỗng ⇒ không thể dựng team subject/driver.
   */
  ref_map: IdentityRefMap;
  /** Ops-only, không packet-facing. */
  server_diagnostics: IdentityServerDiagnostics;
  quality_issues: IdentityQualityIssue[];
  totals: {
    recruited_total: number;
    mapped_recruited_count: number;
    unmapped_recruited_count: number;
    ambiguous_recruited_count: number;
  };
}

/** Mã lỗi contract input (fail-closed). */
export type IdentityValidationCode =
  | "CATALOG_NOT_OBJECT"
  | "CATALOG_ID_EMPTY"
  | "CATALOG_ID_DUPLICATE"
  | "CATALOG_DANGLING_RECRUITER"
  | "CATALOG_DANGLING_TEAM"
  | "CATALOG_INVALID_DATE"
  | "CATALOG_INVALID_INTERVAL"
  | "CATALOG_INVALID_REPORTING_KEY"
  | "CATALOG_INVALID_PROVIDER_TYPE"
  | "CATALOG_INVALID_FLAG"
  | "CATALOG_INVALID_AUDIT"
  | "FACT_INVALID_DATE"
  | "FACT_INVALID_COUNT"
  | "FACT_INVALID_PROVIDER_KEY"
  | "FACT_INVALID_RECRUITER_KEY";

export interface IdentityValidationFailure {
  ok: false;
  code: IdentityValidationCode;
  message: string;
  /** Đường dẫn field vi phạm, ví dụ `aliases[2].valid_to`. */
  path: string;
}

export type IdentityValidationResult = { ok: true } | IdentityValidationFailure;

/** Kết quả projection: fail-closed, KHÔNG bao giờ trả tổng 0 giả khi input sai. */
export type IdentityProjectionResult =
  | { ok: true; projection: IdentityProjection }
  | IdentityValidationFailure;
