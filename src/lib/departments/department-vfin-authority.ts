/**
 * ORG-SHELL-01 — Minimal internal Vendor Finance default authority primitive.
 *
 * Security invariants (VFIN-01 Masterplan §6.3, §7.1, §14):
 *   1. Keyed strictly on canonical Full Admin OR active membership in the
 *      immutable `system_key === "ACCOUNTING"` department.
 *   2. Never consults department `name` / `code`, user `display_name` / `login_id` /
 *      email, `catalog_master_manage`, or retired `payment_view` / `payment_edit`.
 *   3. Never synthesizes actor-wide `all` scope or mutates Direct Entry / Work Reports
 *      capabilities; only evaluates the isolated VFIN default authority primitive
 *      prepared for Work Package 2 (`VFIN-01`).
 */

export type OrgShellDepartmentMembershipFact = {
  system_key: string;
  is_department_active: boolean;
  effective: boolean;
};

export type OrgShellVfinAuthorityInput = {
  enabled: boolean;
  capabilities: readonly string[];
  scopes: readonly { kind: string }[];
  department_memberships?: readonly OrgShellDepartmentMembershipFact[];
};

export type OrgShellVfinDefaultAuthority =
  | {
      allowed: true;
      authority_source: "full_admin" | "accounting_department";
      can_view: true;
      can_record: true;
    }
  | {
      allowed: false;
      authority_source: "none";
      can_view: false;
      can_record: false;
    };

const DENIED_VFIN_AUTHORITY: OrgShellVfinDefaultAuthority = Object.freeze({
  allowed: false,
  authority_source: "none",
  can_view: false,
  can_record: false,
});

const FULL_ADMIN_VFIN_AUTHORITY: OrgShellVfinDefaultAuthority = Object.freeze({
  allowed: true,
  authority_source: "full_admin",
  can_view: true,
  can_record: true,
});

const ACCOUNTING_DEPT_VFIN_AUTHORITY: OrgShellVfinDefaultAuthority = Object.freeze({
  allowed: true,
  authority_source: "accounting_department",
  can_view: true,
  can_record: true,
});

export function resolveOrgShellVfinDefaultAuthority(
  input: OrgShellVfinAuthorityInput,
): OrgShellVfinDefaultAuthority {
  if (!input.enabled) {
    return DENIED_VFIN_AUTHORITY;
  }

  const capabilitySet = new Set(input.capabilities);
  const hasAllScope = input.scopes.some((scope) => scope.kind === "all");

  const isCanonicalFullAdmin =
    hasAllScope &&
    capabilitySet.has("entry_admin") &&
    capabilitySet.has("recruiter_master_manage") &&
    capabilitySet.has("team_master_manage");

  if (isCanonicalFullAdmin) {
    return FULL_ADMIN_VFIN_AUTHORITY;
  }

  const hasActiveAccountingMembership = (input.department_memberships ?? []).some(
    (membership) =>
      membership.system_key === "ACCOUNTING" &&
      membership.is_department_active === true &&
      membership.effective === true,
  );

  if (hasActiveAccountingMembership) {
    return ACCOUNTING_DEPT_VFIN_AUTHORITY;
  }

  return DENIED_VFIN_AUTHORITY;
}
