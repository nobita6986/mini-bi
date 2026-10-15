/**
 * PRE-W2-HF Project↔Team authority (T1A) - Strict contract for the mapping
 * admin API. Mirrors migration #94 RPC envelopes exactly; fail-closed.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ProjectTeamScopeMapping = {
  mapping_id: string;
  project_id: string;
  project_display_name: string;
  team_id: string;
  team_display_name: string;
  team_code: string;
  valid_from: string;
  valid_to: string | null;
  effective: boolean;
  state: "CURRENT" | "SCHEDULED" | "HISTORY";
  version: number;
  revoked_at: string | null;
  created_at: string;
};

export type ProjectTeamScopeList = {
  authorization_date: string;
  include_history: boolean;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  mappings: readonly ProjectTeamScopeMapping[];
};

export type ProjectTeamScopeGrantResult = {
  mapping_id: string;
  project_id: string;
  team_id: string;
  valid_from: string;
  valid_to: string | null;
  version: number;
  created: boolean;
};

export type ProjectTeamScopeRevokeResult = {
  mapping_id: string;
  project_id: string;
  team_id: string;
  valid_to: string | null;
  version: number;
  revoked: boolean;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function exact(v: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(v).sort().join(",") === [...keys].sort().join(",");
}
function uuid(v: unknown): string | null {
  return typeof v === "string" && UUID.test(v) ? v : null;
}
function projectId(v: unknown): string | null {
  return typeof v === "string" && PROJECT_ID.test(v) ? v : null;
}
function int(v: unknown, min: number): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : null;
}
function day(v: unknown): string | null {
  return typeof v === "string" && DATE.test(v) ? v : null;
}
function nullableDay(v: unknown): string | null | undefined {
  return v === null ? null : (day(v) ?? undefined);
}
function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() !== "" && v.length <= max ? v : null;
}

function state(v: unknown): ProjectTeamScopeMapping["state"] | null {
  if (v === "CURRENT" || v === "SCHEDULED" || v === "HISTORY") return v;
  return null;
}

function projectMapping(value: unknown): ProjectTeamScopeMapping | null {
  if (!isRecord(value) ||
      !exact(value, ["mapping_id", "project_id", "project_display_name", "team_id",
        "team_display_name", "team_code", "valid_from", "valid_to", "effective",
        "state", "version", "revoked_at", "created_at"])) return null;
  const mapping_id = uuid(value.mapping_id);
  const project_id = projectId(value.project_id);
  const project_display_name = text(value.project_display_name, 256);
  const team_id = uuid(value.team_id);
  const team_display_name = text(value.team_display_name, 256);
  const team_code = typeof value.team_code === "string" ? value.team_code : null;
  const valid_from = day(value.valid_from);
  const valid_to = nullableDay(value.valid_to);
  const effective = typeof value.effective === "boolean" ? value.effective : null;
  const mappedState = state(value.state);
  const version = int(value.version, 1);
  const revoked_at = nullableDay(value.revoked_at) === undefined ? undefined : (typeof value.revoked_at === "string" ? value.revoked_at : null);
  const created_at = typeof value.created_at === "string" ? value.created_at : null;
  if (mapping_id === null || project_id === null || !project_display_name ||
      team_id === null || !team_display_name || team_code === null ||
      !valid_from || valid_to === undefined || effective === null ||
      mappedState === null || version === null || revoked_at === undefined || created_at === null) return null;
  return {
    mapping_id, project_id, project_display_name, team_id, team_display_name, team_code,
    valid_from, valid_to, effective, state: mappedState, version, revoked_at, created_at,
  };
}

export function projectProjectTeamScopeList(value: unknown): ProjectTeamScopeList | null {
  if (!isRecord(value) ||
      !exact(value, ["authorization_date", "include_history", "page", "page_size",
        "total", "has_more", "mappings"])) return null;
  if (!isRecord(value) || typeof value.authorization_date !== "string" ||
      typeof value.include_history !== "boolean" ||
      typeof value.page !== "number" || typeof value.page_size !== "number" ||
      typeof value.total !== "number" || typeof value.has_more !== "boolean" ||
      !Array.isArray(value.mappings)) return null;
  const mappings: ProjectTeamScopeMapping[] = [];
  for (const raw of value.mappings) {
    const row = projectMapping(raw);
    if (!row) return null;
    mappings.push(row);
  }
  return {
    authorization_date: value.authorization_date,
    include_history: value.include_history,
    page: value.page as number,
    page_size: value.page_size as number,
    total: value.total as number,
    has_more: value.has_more,
    mappings,
  };
}

export function projectGrantResult(value: unknown): ProjectTeamScopeGrantResult | null {
  if (!isRecord(value) || !exact(value, ["mapping_id", "project_id", "team_id",
    "valid_from", "valid_to", "version", "created"])) return null;
  const mapping_id = uuid(value.mapping_id);
  const project_id = projectId(value.project_id);
  const team_id = uuid(value.team_id);
  const valid_from = day(value.valid_from);
  const valid_to = nullableDay(value.valid_to);
  const version = int(value.version, 1);
  if (mapping_id === null || project_id === null || team_id === null ||
      !valid_from || valid_to === undefined || version === null ||
      value.created !== true) return null;
  return { mapping_id, project_id, team_id, valid_from, valid_to, version, created: true };
}

export function projectRevokeResult(value: unknown): ProjectTeamScopeRevokeResult | null {
  if (!isRecord(value) || !exact(value, ["mapping_id", "project_id", "team_id",
    "valid_to", "version", "revoked"])) return null;
  const mapping_id = uuid(value.mapping_id);
  const project_id = projectId(value.project_id);
  const team_id = uuid(value.team_id);
  const valid_to = nullableDay(value.valid_to);
  const version = int(value.version, 1);
  if (mapping_id === null || project_id === null || team_id === null ||
      valid_to === undefined || version === null || value.revoked !== true) return null;
  return { mapping_id, project_id, team_id, valid_to, version, revoked: true };
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: string };

function reject(): Parsed<never> {
  return { ok: false, code: "PROJECT_TEAM_SCOPE_INVALID" };
}

export type GrantRequest = {
  project_id: string;
  team_id: string;
  expected_pair_version: number;
  effective_from: string | null;
  reason: string;
  idempotency_key: string;
};
export function parseGrant(body: unknown): Parsed<GrantRequest> {
  if (!isRecord(body) || !exact(body, ["project_id", "team_id", "expected_pair_version",
    "effective_from", "reason", "idempotency_key"])) return reject();
  const project_id = projectId(body.project_id);
  const team_id = uuid(body.team_id);
  const expected_pair_version = int(body.expected_pair_version, 0);
  const effective_from_raw = body.effective_from;
  const effective_from = effective_from_raw === null ? null : day(effective_from_raw);
  const reason = text(body.reason, 4000);
  const idempotency_key = uuid(body.idempotency_key);
  if (!project_id || !team_id || expected_pair_version === null ||
      effective_from_raw === undefined || !reason || !idempotency_key) return reject();
  return { ok: true, value: { project_id, team_id, expected_pair_version, effective_from, reason, idempotency_key } };
}

export type RevokeRequest = {
  mapping_id: string;
  expected_pair_version: number;
  effective_to: string | null;
  reason: string;
  idempotency_key: string;
};
export function parseRevoke(body: unknown): Parsed<RevokeRequest> {
  if (!isRecord(body) || !exact(body, ["mapping_id", "expected_pair_version",
    "effective_to", "reason", "idempotency_key"])) return reject();
  const mapping_id = uuid(body.mapping_id);
  const expected_pair_version = int(body.expected_pair_version, 1);
  const effective_to_raw = body.effective_to;
  const effective_to = effective_to_raw === null ? null : day(effective_to_raw);
  const reason = text(body.reason, 4000);
  const idempotency_key = uuid(body.idempotency_key);
  if (!mapping_id || expected_pair_version === null ||
      effective_to_raw === undefined || !reason || !idempotency_key) return reject();
  return { ok: true, value: { mapping_id, expected_pair_version, effective_to, reason, idempotency_key } };
}
