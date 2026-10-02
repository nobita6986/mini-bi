import {
  isRealCalendarDate,
  isWithinInterval,
} from "../analytics/identity/identity-shared.mjs";
import type { TeamIdentity } from "../analytics/identity/contracts.ts";
import type { ExplicitRecruiterLink } from "../contracts/direct-entry-v1.ts";

export const DIRECT_ENTRY_AUTH_CONTRACT_VERSION = "direct-entry-auth/1.1" as const;

export const CAPABILITIES = [
  "entry_create",
  "entry_own",
  "entry_team",
  "entry_admin",
  "submission_create",
  "change_request_create",
  "change_review",
  "entry_privileged_edit",
  "employment_status.request",
  "employment_status.review",
  "employment_status.apply",
  "document_upload",
  "document_view",
  "payment_view",
  "payment_edit",
  "recruiter_master_manage",
  "team_master_manage",
  "pii_view",
  "pii_export",
  "audit_view",
  "entry_restore",
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type ScopeKind = "own" | "team" | "all";

export type EffectiveScope = {
  kind: ScopeKind;
  reference: string;
  valid_from: string;
  valid_to: string | null;
};

export type SessionIdentity = {
  auth_subject: string;
  provider: "supabase";
  authenticated_at: string | null;
};

export type DirectEntryActor = {
  auth_subject: string;
  app_user_id: string;
  enabled: boolean;
  capabilities: readonly Capability[];
  scopes: readonly EffectiveScope[];
  self_recruiter_suggestion: string | null;
  session: {
    provider: "supabase";
    verification: "getUser";
    authenticated_at: string | null;
  };
};

export type AllScopeGrant = {
  valid_from: string;
  valid_to: string | null;
};

export type TeamScopeGrant = {
  team_id: string;
  valid_from: string;
  valid_to: string | null;
};

export type ActorAuthorizationRecord = {
  auth_subject: unknown;
  app_user_id: unknown;
  enabled: unknown;
  capabilities: unknown;
  recruiter_links: unknown;
  teams: unknown;
  team_scope_grants: unknown;
  all_scope_grants: unknown;
};

export type ActorRepository = {
  loadByAuthSubject(authSubject: string, at: string): Promise<unknown>;
};

export type ActorResolution =
  | { ok: true; actor: DirectEntryActor }
  | {
      ok: false;
      reason:
        | "UNAUTHENTICATED"
        | "ACTOR_MAPPING_MISSING"
        | "ACTOR_DISABLED"
        | "ACTOR_REPOSITORY_MISSING"
        | "ACTOR_REPOSITORY_INVALID"
        | "AMBIGUOUS_RECRUITER_LINK"
        | "AMBIGUOUS_TEAM_MEMBERSHIP";
    };

export type RecruiterSuggestion =
  | { kind: "none"; recruiter_id: null }
  | { kind: "suggestion"; recruiter_id: string }
  | { kind: "ambiguous"; recruiter_id: null };

export type ResourceScope = {
  kind: ScopeKind;
  reference: string;
  effective_date: string;
};

export type TrustedResourceContext = {
  reference: string;
  scope: ResourceScope;
  created_by_user_id: string | null;
  current_version: number | null;
};

export type AuthorizationAction = Capability;

export type AuditEnvelope = {
  auth_subject: string | null;
  app_user_id: string | null;
  action: AuthorizationAction;
  capability: Capability;
  resource_ref: string | null;
  scope: ResourceScope | null;
  timestamp: string;
  outcome: "ALLOW" | "DENY";
  denial_code: string | null;
  reason_ref: string | null;
};

export type AuthorizationDecision = {
  allowed: boolean;
  code: string;
  audit: AuditEnvelope;
};

export type AuthorizationInput = {
  actor: DirectEntryActor | null;
  action: AuthorizationAction;
  resource: TrustedResourceContext;
  timestamp: string;
  expected_version?: number;
  reason_ref?: string;
};

export type ClientPayloadResult =
  | { ok: true }
  | { ok: false; field: string; code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REF = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-z][a-z0-9]*_[a-z0-9][a-z0-9._:-]{0,100})$/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CAPABILITY_SET = new Set<string>(CAPABILITIES);
const REASON_REQUIRED_ACTIONS = new Set<AuthorizationAction>([
  "entry_admin",
  "change_review",
  "entry_privileged_edit",
  "employment_status.review",
  "employment_status.apply",
  "payment_edit",
  "recruiter_master_manage",
  "team_master_manage",
  "entry_restore",
]);
const VERSION_REQUIRED_ACTIONS = new Set<AuthorizationAction>([
  "entry_admin",
  "change_review",
  "entry_privileged_edit",
  "employment_status.apply",
  "payment_edit",
  "recruiter_master_manage",
  "team_master_manage",
  "entry_restore",
]);
const FORBIDDEN_CLIENT_FIELDS = new Set([
  "authsubject",
  "appuserid",
  "actorid",
  "createdbyuserid",
  "owneruserid",
  "role",
  "roles",
  "capability",
  "capabilities",
  "scope",
  "scopes",
  "scopekind",
  "effectivescope",
  "effectivescopes",
  "selfrecruitersuggestion",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRef(value: unknown): value is string {
  return typeof value === "string" && SAFE_REF.test(value);
}

function isValidInterval(from: unknown, to: unknown): from is string {
  return typeof from === "string" &&
    isRealCalendarDate(from) &&
    (to === null ||
      (typeof to === "string" && isRealCalendarDate(to) && to > from));
}

function isEffectiveAt(from: string, to: string | null, date: string): boolean {
  return isWithinInterval(date, from, to);
}

function isExplicitRecruiterLink(value: unknown): value is ExplicitRecruiterLink {
  return isRecord(value) &&
    isSafeRef(value.app_user_id) &&
    isSafeRef(value.recruiter_id) &&
    typeof value.verified === "boolean" &&
    isValidInterval(value.valid_from, value.valid_to);
}

function isTeam(value: unknown): value is TeamIdentity {
  return isRecord(value) &&
    isSafeRef(value.team_id) &&
    typeof value.code === "string" &&
    typeof value.display === "string" &&
    typeof value.active === "boolean";
}

function isTeamScopeGrant(value: unknown): value is TeamScopeGrant {
  return isRecord(value) &&
    isSafeRef(value.team_id) &&
    isValidInterval(value.valid_from, value.valid_to);
}

function isAllScopeGrant(value: unknown): value is AllScopeGrant {
  return isRecord(value) && isValidInterval(value.valid_from, value.valid_to);
}

function hasOverlappingTeamScopeGrants(grants: readonly TeamScopeGrant[]): boolean {
  const byTeam = new Map<string, TeamScopeGrant[]>();
  for (const grant of grants) {
    const group = byTeam.get(grant.team_id) ?? [];
    group.push(grant);
    byTeam.set(grant.team_id, group);
  }

  for (const teamGrants of byTeam.values()) {
    teamGrants.sort((a, b) => a.valid_from.localeCompare(b.valid_from));
    let furthestEnd: string | null | undefined;
    for (const grant of teamGrants) {
      if (furthestEnd === undefined) {
        furthestEnd = grant.valid_to;
        continue;
      }
      if (furthestEnd === null || grant.valid_from < furthestEnd) return true;
      if (grant.valid_to === null || grant.valid_to > furthestEnd) {
        furthestEnd = grant.valid_to;
      }
    }
  }
  return false;
}

function effectiveRecruiterSuggestion(
  appUserId: string,
  date: string,
  links: readonly ExplicitRecruiterLink[],
): RecruiterSuggestion {
  const matches = links.filter((link) =>
    link.app_user_id === appUserId &&
    link.verified &&
    isEffectiveAt(link.valid_from, link.valid_to, date)
  );
  if (matches.length > 1) return { kind: "ambiguous", recruiter_id: null };
  if (matches.length === 0) return { kind: "none", recruiter_id: null };
  return { kind: "suggestion", recruiter_id: matches[0].recruiter_id };
}

export function resolveSelfRecruiterSuggestion(input: {
  app_user_id: string;
  date: string;
  links: readonly ExplicitRecruiterLink[];
}): RecruiterSuggestion {
  if (!isRealCalendarDate(input.date) || !UUID.test(input.app_user_id)) {
    return { kind: "none", recruiter_id: null };
  }
  if (!input.links.every(isExplicitRecruiterLink)) {
    return { kind: "ambiguous", recruiter_id: null };
  }
  return effectiveRecruiterSuggestion(input.app_user_id, input.date, input.links);
}

export function resolveActor(
  input: {
    session: SessionIdentity | null;
    repository: ActorRepository | null | undefined;
    at: string;
  },
): Promise<ActorResolution> {
  return resolveActorInternal(input);
}

async function resolveActorInternal(input: {
  session: SessionIdentity | null;
  repository: ActorRepository | null | undefined;
  at: string;
}): Promise<ActorResolution> {
  if (!input.session || !UUID.test(input.session.auth_subject) ||
      input.session.provider !== "supabase" ||
      !isValidTimestamp(input.at) ||
      (input.session.authenticated_at !== null &&
        !isValidTimestamp(input.session.authenticated_at))) {
    return { ok: false, reason: "UNAUTHENTICATED" };
  }
  if (!input.repository ||
      typeof input.repository.loadByAuthSubject !== "function") {
    return { ok: false, reason: "ACTOR_REPOSITORY_MISSING" };
  }

  const record = await input.repository.loadByAuthSubject(
    input.session.auth_subject,
    input.at,
  );
  if (record === null || record === undefined) {
    return { ok: false, reason: "ACTOR_MAPPING_MISSING" };
  }
  if (!isValidAuthorizationRecord(record)) {
    return { ok: false, reason: "ACTOR_REPOSITORY_INVALID" };
  }
  if (record.auth_subject !== input.session.auth_subject) {
    return { ok: false, reason: "ACTOR_REPOSITORY_INVALID" };
  }
  if (!record.enabled) return { ok: false, reason: "ACTOR_DISABLED" };
  if (hasOverlappingTeamScopeGrants(record.team_scope_grants as TeamScopeGrant[])) {
    return { ok: false, reason: "AMBIGUOUS_TEAM_MEMBERSHIP" };
  }

  const appUserId = record.app_user_id as string;
  const date = input.at.slice(0, 10);
  const recruiterSuggestion = effectiveRecruiterSuggestion(
    appUserId,
    date,
    record.recruiter_links as ExplicitRecruiterLink[],
  );
  if (recruiterSuggestion.kind === "ambiguous") {
    return { ok: false, reason: "AMBIGUOUS_RECRUITER_LINK" };
  }

  const scopes: EffectiveScope[] = [{
    kind: "own",
    reference: appUserId,
    valid_from: "0001-01-01",
    valid_to: null,
  }];
  for (const grant of record.team_scope_grants as TeamScopeGrant[]) {
    const team = (record.teams as TeamIdentity[]).find((item) =>
      item.team_id === grant.team_id
    );
    if (!team || (isEffectiveAt(grant.valid_from, grant.valid_to, date) && !team.active)) {
      return { ok: false, reason: "ACTOR_REPOSITORY_INVALID" };
    }
    scopes.push({
      kind: "team",
      reference: grant.team_id,
      valid_from: grant.valid_from,
      valid_to: grant.valid_to,
    });
  }
  for (const grant of record.all_scope_grants as AllScopeGrant[]) {
    scopes.push({
      kind: "all",
      reference: "all",
      valid_from: grant.valid_from,
      valid_to: grant.valid_to,
    });
  }

  return {
    ok: true,
    actor: {
      auth_subject: input.session.auth_subject,
      app_user_id: appUserId,
      enabled: true,
      capabilities: record.capabilities as Capability[],
      scopes,
      self_recruiter_suggestion: recruiterSuggestion.kind === "suggestion"
        ? recruiterSuggestion.recruiter_id
        : null,
      session: {
        provider: "supabase",
        verification: "getUser",
        authenticated_at: input.session.authenticated_at,
      },
    },
  };
}

function isValidAuthorizationRecord(
  value: unknown,
): value is ActorAuthorizationRecord & {
  auth_subject: string;
  app_user_id: string;
  enabled: boolean;
  capabilities: Capability[];
  recruiter_links: ExplicitRecruiterLink[];
  teams: TeamIdentity[];
  team_scope_grants: TeamScopeGrant[];
  all_scope_grants: AllScopeGrant[];
} {
  if (!isRecord(value)) return false;
  return UUID.test(String(value.auth_subject)) &&
    UUID.test(String(value.app_user_id)) &&
    typeof value.enabled === "boolean" &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) =>
      typeof capability === "string" && CAPABILITY_SET.has(capability)
    ) &&
    new Set(value.capabilities).size === value.capabilities.length &&
    Array.isArray(value.recruiter_links) &&
    value.recruiter_links.every(isExplicitRecruiterLink) &&
    Array.isArray(value.teams) &&
    value.teams.every(isTeam) &&
    Array.isArray(value.team_scope_grants) &&
    value.team_scope_grants.every(isTeamScopeGrant) &&
    Array.isArray(value.all_scope_grants) &&
    value.all_scope_grants.every(isAllScopeGrant);
}

function isValidTimestamp(value: string): boolean {
  return typeof value === "string" &&
    ISO_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    isRealCalendarDate(value.slice(0, 10));
}

function isAllowedByScope(
  actor: DirectEntryActor,
  resource: TrustedResourceContext,
): boolean {
  const { scope } = resource;
  const validScopeReference = scope.kind === "all"
    ? scope.reference === "all"
    : isSafeRef(scope.reference);
  if (!validScopeReference ||
      !isRealCalendarDate(scope.effective_date) ||
      !isSafeRef(resource.reference)) {
    return false;
  }
  if (scope.kind === "own" &&
      scope.reference !== resource.created_by_user_id) {
    return false;
  }
  if (scope.kind === "team" && !isSafeRef(scope.reference)) return false;

  const effectiveScopes = actor.scopes.filter((effectiveScope) =>
    isEffectiveAt(
      effectiveScope.valid_from,
      effectiveScope.valid_to,
      scope.effective_date,
    )
  );
  const matchingScopeCount = effectiveScopes.filter((effectiveScope) =>
    effectiveScope.kind === scope.kind &&
    effectiveScope.reference === scope.reference
  ).length;
  const matchingAllCount = effectiveScopes.filter((effectiveScope) =>
    effectiveScope.kind === "all"
  ).length;
  if (matchingScopeCount > 1 || matchingAllCount > 1) return false;
  return matchingScopeCount === 1 || matchingAllCount === 1;
}

export function authorizeDirectEntry(input: AuthorizationInput): AuthorizationDecision {
  const requiredCapability = input.action;
  let code = "ALLOW";
  const actor = input.actor;

  if (!isValidTimestamp(input.timestamp)) code = "INVALID_TIMESTAMP";
  else if (!actor || !actor.enabled) code = "UNAUTHENTICATED";
  else if (!actor.capabilities.includes(requiredCapability)) code = "CAPABILITY_DENIED";
  else if (!isAllowedByScope(actor, input.resource)) code = "SCOPE_DENIED";
  else if (REASON_REQUIRED_ACTIONS.has(input.action) &&
      !isSafeRef(input.reason_ref)) code = "REASON_REQUIRED";
  else if (VERSION_REQUIRED_ACTIONS.has(input.action)) {
    if (input.expected_version === undefined) {
      code = "EXPECTED_VERSION_REQUIRED";
    } else if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 0) {
      code = "EXPECTED_VERSION_INVALID";
    } else if (!Number.isSafeInteger(input.resource.current_version) ||
        input.resource.current_version! < 0) {
      code = "RESOURCE_VERSION_INVALID";
    } else if (input.expected_version !== input.resource.current_version) {
      code = "VERSION_CONFLICT";
    }
  }

  const allowed = code === "ALLOW";
  return {
    allowed,
    code,
    audit: {
      auth_subject: actor?.auth_subject ?? null,
      app_user_id: actor?.app_user_id ?? null,
      action: input.action,
      capability: requiredCapability,
      resource_ref: isSafeRef(input.resource.reference)
        ? input.resource.reference
        : null,
      scope: isValidResourceScope(input.resource.scope)
        ? input.resource.scope
        : null,
      timestamp: isValidTimestamp(input.timestamp) ? input.timestamp : "",
      outcome: allowed ? "ALLOW" : "DENY",
      denial_code: allowed ? null : code,
      reason_ref: isSafeRef(input.reason_ref) ? input.reason_ref : null,
    },
  };
}

function isValidResourceScope(value: ResourceScope): boolean {
  return isRecord(value) &&
    (value.kind === "own" || value.kind === "team" || value.kind === "all") &&
    (value.kind === "all" ? value.reference === "all" : isSafeRef(value.reference)) &&
    isRealCalendarDate(value.effective_date);
}

export function validateClientBusinessPayload(value: unknown): ClientPayloadResult {
  const seen = new Set<object>();
  const visit = (current: unknown, path: string): ClientPayloadResult => {
    if (Array.isArray(current)) {
      if (seen.has(current)) return { ok: true };
      seen.add(current);
      for (let index = 0; index < current.length; index += 1) {
        const result = visit(current[index], `${path}[${index}]`);
        if (!result.ok) return result;
      }
      return { ok: true };
    }
    if (!isRecord(current)) return { ok: true };
    if (seen.has(current)) return { ok: true };
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      const normalized = key.replace(/[-_]/g, "").toLowerCase();
      if (FORBIDDEN_CLIENT_FIELDS.has(normalized)) {
        return {
          ok: false,
          field: path ? `${path}.${key}` : key,
          code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        };
      }
      const result = visit(child, path ? `${path}.${key}` : key);
      if (!result.ok) return result;
    }
    return { ok: true };
  };
  return visit(value, "");
}
