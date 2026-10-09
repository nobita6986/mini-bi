/**
 * P3.1-W01C-B - Strict projections cho team membership lifecycle admin RPC (#70).
 *
 * Payload dung chinh xac theo migration #70
 * (20261009060000_p3_1_w01c_b_team_membership.sql):
 * - ba read (current/scheduled/history) tra 8 key moi membership;
 * - envelope list 5 key;
 * - mutation (assign/move/unassign) tra 8 key voi change discriminator.
 *
 * Server la authority: moi projection FAIL-CLOSED. Thieu/thua key, sai kieu hoac
 * gia tri khong hop le => null. KHONG bao gio chua auth_subject, email, app-user
 * UUID, grant/scope/capability row hay reason text.
 */

export type MembershipState = "CURRENT" | "SCHEDULED" | "HISTORY";
export type MembershipChange = "ASSIGN" | "MOVE" | "UNASSIGN" | "CANCEL";

export type AdminTeamMembership = {
  membership_id: string;
  recruiter_id: string;
  team_id: string;
  team_display_name: string;
  valid_from: string;
  valid_to: string | null;
  recruiter_version: number;
  state: MembershipState;
};

export type AdminTeamMembershipList = {
  authorization_date: string;
  page: number;
  page_size: number;
  total: number;
  memberships: readonly AdminTeamMembership[];
};

export type AdminTeamMembershipMutation = {
  membership_id: string;
  recruiter_id: string;
  team_id: string;
  valid_from: string;
  valid_to: string | null;
  recruiter_version: number;
  revision_id: string;
  change: MembershipChange;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function day(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
function state(value: unknown): MembershipState | null {
  return value === "CURRENT" || value === "SCHEDULED" || value === "HISTORY" ? value : null;
}
function change(value: unknown): MembershipChange | null {
  return value === "ASSIGN" || value === "MOVE" || value === "UNASSIGN" || value === "CANCEL"
    ? value : null;
}

const ITEM_KEYS = ["membership_id", "recruiter_id", "team_id", "team_display_name",
  "valid_from", "valid_to", "recruiter_version", "state"] as const;
const LIST_KEYS = ["authorization_date", "page", "page_size", "total", "memberships"] as const;
const MUTATION_KEYS = ["membership_id", "recruiter_id", "team_id", "valid_from", "valid_to",
  "recruiter_version", "revision_id", "change"] as const;

/** Membership row 8 key (all three reads). */
export function teamMembershipItem(value: unknown): AdminTeamMembership | null {
  if (!isRecord(value) || !exactKeys(value, ITEM_KEYS)) return null;
  const membership_id = str(value.membership_id);
  const recruiter_id = str(value.recruiter_id);
  const team_id = str(value.team_id);
  const team_display_name = str(value.team_display_name);
  const valid_from = day(value.valid_from);
  const valid_to = value.valid_to === null ? null : day(value.valid_to);
  const recruiter_version = int(value.recruiter_version);
  const parsedState = state(value.state);
  if (membership_id === null || recruiter_id === null || team_id === null ||
      team_display_name === null || valid_from === null || valid_to === null && value.valid_to !== null ||
      recruiter_version === null || parsedState === null) {
    return null;
  }
  return { membership_id, recruiter_id, team_id, team_display_name, valid_from, valid_to,
    recruiter_version, state: parsedState };
}

export function teamMembershipList(value: unknown): AdminTeamMembershipList | null {
  if (!isRecord(value) || !exactKeys(value, LIST_KEYS)) return null;
  const authorization_date = day(value.authorization_date);
  const page = int(value.page);
  const page_size = int(value.page_size);
  const total = int(value.total);
  if (authorization_date === null || page === null || page_size === null || total === null ||
      !Array.isArray(value.memberships)) {
    return null;
  }
  const memberships: AdminTeamMembership[] = [];
  for (const item of value.memberships) {
    const row = teamMembershipItem(item);
    if (!row) return null;
    memberships.push(row);
  }
  return { authorization_date, page, page_size, total, memberships };
}

export function teamMembershipMutation(value: unknown): AdminTeamMembershipMutation | null {
  if (!isRecord(value) || !exactKeys(value, MUTATION_KEYS)) return null;
  const membership_id = str(value.membership_id);
  const recruiter_id = str(value.recruiter_id);
  const team_id = str(value.team_id);
  const valid_from = day(value.valid_from);
  const valid_to = value.valid_to === null ? null : day(value.valid_to);
  const recruiter_version = int(value.recruiter_version);
  const revision_id = str(value.revision_id);
  const parsedChange = change(value.change);
  if (membership_id === null || recruiter_id === null || team_id === null ||
      valid_from === null || (valid_to === null && value.valid_to !== null) ||
      recruiter_version === null || revision_id === null || parsedChange === null) {
    return null;
  }
  return { membership_id, recruiter_id, team_id, valid_from, valid_to, recruiter_version,
    revision_id, change: parsedChange };
}
