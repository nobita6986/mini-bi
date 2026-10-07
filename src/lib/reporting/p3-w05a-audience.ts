/**
 * P3-W05A - Reporting audience projection for W06C.
 *
 * A minimal typed server-side projection:
 *   { kind: 'all',  label: 'Toan cong ty' }
 *   { kind: 'team', label: teamDisplayName }
 *   { kind: 'own',  label: recruiterDisplayName | safe fallback }
 *
 * The DB is the authority for the resolved audience (including the display
 * label). This module:
 *   - exposes the locked priority rule all > team > own as a pure, testable
 *     function (the actor resolver always synthesizes an own scope);
 *   - normalizes the sanitized audience jsonb returned by the scoped RPC.
 *
 * No internal UUID, auth subject, capability/grant record, email or PII is
 * present in the projection.
 */

import type { DirectEntryActor } from "@/lib/auth/direct-entry-v2";

export type ReportingAudienceKind = "all" | "team" | "own";

export interface ReportingAudience {
  kind: ReportingAudienceKind;
  label: string;
}

export const REPORTING_AUDIENCE_ALL_LABEL = "Toàn công ty";
export const REPORTING_AUDIENCE_OWN_FALLBACK_LABEL = "Cá nhân";

/**
 * Resolve the audience KIND from an actor's effective scopes at the given
 * date. Priority: all > team > own (the resolver always synthesizes own).
 */
export function resolveReportingAudienceKind(
  actor: DirectEntryActor,
  at: string,
): ReportingAudienceKind {
  const date = at.slice(0, 10);
  const scopes = actor.scopes.filter(
    (scope) =>
      scope.valid_from <= date &&
      (scope.valid_to === null || date < scope.valid_to),
  );
  if (scopes.some((scope) => scope.kind === "all")) return "all";
  if (scopes.some((scope) => scope.kind === "team")) return "team";
  return "own";
}

/**
 * Normalize the sanitized audience jsonb returned by the scoped RPCs into
 * the typed projection. Returns null when the payload is malformed (the
 * caller must fail closed, not default to a zero dashboard).
 */
export function reportingAudienceFromDb(value: unknown): ReportingAudience | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const kind = record["audience"];
  if (kind !== "all" && kind !== "team" && kind !== "own") return null;
  const rawLabel = record["label"];
  const label =
    typeof rawLabel === "string" && rawLabel.trim() !== ""
      ? rawLabel
      : kind === "all"
        ? REPORTING_AUDIENCE_ALL_LABEL
        : REPORTING_AUDIENCE_OWN_FALLBACK_LABEL;
  return { kind, label };
}

/**
 * Count the effective team scope the DB reported for a team audience. The RPC
 * resolves the audience from EVERY effective team scope grant but returns only
 * the first team's display label, so callers need the count to keep the label
 * inclusive. Only a count is derived here - no team UUID leaves this module.
 */
export function audienceTeamScopeCount(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  const teamIds = (value as Record<string, unknown>)["team_ids"];
  if (!Array.isArray(teamIds)) return 0;
  return teamIds.length;
}

/**
 * Keep the team scope label inclusive when more than one team is in scope.
 * A single team keeps the DB label verbatim; a multi-team scope is labelled so
 * the dashboard can never claim the whole scope is one named team.
 */
export function resolveAudienceScopeLabel(
  audience: ReportingAudience,
  teamCount: number,
): string {
  if (audience.kind !== "team") return audience.label;
  if (!Number.isFinite(teamCount) || teamCount <= 1) return audience.label;
  const others = Math.trunc(teamCount) - 1;
  return audience.label + " và " + others + " nhóm khác";
}
