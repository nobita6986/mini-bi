import {
  teamMembershipList,
  teamMembershipMutation,
  type AdminTeamMembership,
  type AdminTeamMembershipList,
  type AdminTeamMembershipMutation,
  type MembershipState,
} from "../direct-entry/team-membership-contract.ts";
import {
  teamCatalogList,
  type AdminTeam,
  type AdminTeamList,
} from "../direct-entry/team-catalog-contract.ts";
import { parseIsoDate } from "../direct-entry/direct-entry-date-format.ts";
import {
  newIdempotencyKey,
  validateReason,
  validateUuid,
  validateVersion,
} from "../direct-entry/project-operations-model.ts";

export const MEMBERSHIP_PAGE_SIZE = 25;
export const TEAM_PAGE_SIZE = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE_VALUE: Readonly<Record<MembershipState, string>> = {
  CURRENT: "current",
  SCHEDULED: "scheduled",
  HISTORY: "history",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function pageIsValid(page: number, max: number): boolean {
  return Number.isSafeInteger(page) && page >= 1 && page <= max;
}

export function buildMembershipListQuery(
  recruiterId: string,
  state: MembershipState,
  page: number,
): URLSearchParams | null {
  if (!UUID.test(recruiterId) || !pageIsValid(page, 1000)) return null;
  return new URLSearchParams({
    recruiter_id: recruiterId,
    state: STATE_VALUE[state],
    page: String(page),
    page_size: String(MEMBERSHIP_PAGE_SIZE),
  });
}

export function projectMembershipList(
  payload: unknown,
  query: { recruiterId: string; state: MembershipState; page: number },
): AdminTeamMembershipList | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "list"]) || payload.ok !== true) return null;
  const list = teamMembershipList(payload.list);
  if (!list || list.page !== query.page || list.page_size !== MEMBERSHIP_PAGE_SIZE ||
      list.memberships.some((row) => row.recruiter_id !== query.recruiterId ||
        row.state !== query.state)) {
    return null;
  }
  return list;
}

export function buildTeamCatalogListQuery(page: number): URLSearchParams | null {
  if (!pageIsValid(page, 1000)) return null;
  return new URLSearchParams({
    include_inactive: "false",
    page: String(page),
    page_size: String(TEAM_PAGE_SIZE),
  });
}

export function projectActiveTeams(
  payload: unknown,
  page: number,
): AdminTeamList | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "list"]) || payload.ok !== true) return null;
  const list = teamCatalogList(payload.list);
  return list && list.page === page && list.page_size === TEAM_PAGE_SIZE &&
    list.include_inactive === false && list.search === null
    ? { ...list, teams: list.teams.filter((team) => team.active) }
    : null;
}

export type MembershipMutationRequest = {
  url: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
};

function mutationPath(recruiterId: string, teamId?: string, move = false): string | null {
  if (!UUID.test(recruiterId) || (teamId !== undefined && !UUID.test(teamId))) return null;
  return `/api/admin/catalog/personnel/${encodeURIComponent(recruiterId)}/team-memberships${
    teamId ? `/${encodeURIComponent(teamId)}${move ? "/move" : ""}` : "/unassign"
  }`;
}

export function buildAssignMembershipRequest(input: {
  recruiterId: string;
  teamId: string;
  validFrom: string;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
  move?: boolean;
}): { ok: true; request: MembershipMutationRequest } | { ok: false; message: string } {
  const url = mutationPath(input.recruiterId, input.teamId, input.move === true);
  if (url === null) return { ok: false, message: "Hồ sơ hoặc nhóm không hợp lệ." };
  const failure = (parseIsoDate(input.validFrom) ? null : "Ngày hiệu lực không hợp lệ.")
    ?? validateVersion(input.expectedVersion) ?? (input.expectedVersion < 1
      ? "Phiên bản hồ sơ không hợp lệ."
      : null)
    ?? validateReason(input.reason)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    request: {
      url,
      body: {
        valid_from: input.validFrom,
        expected_version: input.expectedVersion,
        reason: input.reason,
        idempotency_key: input.idempotencyKey,
      },
      idempotencyKey: input.idempotencyKey,
    },
  };
}

export function buildUnassignMembershipRequest(input: {
  recruiterId: string;
  validTo: string;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}): { ok: true; request: MembershipMutationRequest } | { ok: false; message: string } {
  const url = mutationPath(input.recruiterId);
  if (url === null) return { ok: false, message: "Hồ sơ không hợp lệ." };
  const failure = (parseIsoDate(input.validTo) ? null : "Ngày kết thúc không hợp lệ.")
    ?? validateVersion(input.expectedVersion) ?? (input.expectedVersion < 1
      ? "Phiên bản hồ sơ không hợp lệ."
      : null)
    ?? validateReason(input.reason)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    request: {
      url,
      body: {
        valid_to: input.validTo,
        expected_version: input.expectedVersion,
        reason: input.reason,
        idempotency_key: input.idempotencyKey,
      },
      idempotencyKey: input.idempotencyKey,
    },
  };
}

export type MembershipMutationOutcome =
  | { kind: "applied"; membership: AdminTeamMembershipMutation }
  | { kind: "conflict"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

export function classifyMembershipMutation(
  status: number,
  payload: unknown,
  recruiterId: string,
  operation: "assign" | "move" | "unassign",
): MembershipMutationOutcome {
  if (status === 200) {
    if (isRecord(payload) && exactKeys(payload, ["ok", "membership"]) && payload.ok === true) {
      const membership = teamMembershipMutation(payload.membership);
      const expectedChange = operation === "assign" ? "ASSIGN"
        : operation === "move" ? "MOVE" : null;
      if (membership && membership.recruiter_id === recruiterId &&
          (expectedChange === null || membership.change === expectedChange) &&
          (operation !== "unassign" ||
            membership.change === "UNASSIGN" || membership.change === "CANCEL")) {
        return { kind: "applied", membership };
      }
    }
    return { kind: "unavailable", message: "Phản hồi thao tác không hợp lệ." };
  }
  if (status === 401) return { kind: "unauthenticated", message: "Phiên đăng nhập không còn hiệu lực." };
  if (status === 403) return { kind: "denied", message: "Bạn không có quyền quản lý nhóm của hồ sơ này." };
  if (status === 404) return { kind: "not-found", message: "Hồ sơ hoặc nhóm không còn khả dụng." };
  if (status === 409) return { kind: "conflict", message: "Hồ sơ đã thay đổi. Tải lại dữ liệu trước khi tiếp tục." };
  if (status === 400 || status === 422) return { kind: "invalid", message: "Thông tin gửi lên không hợp lệ." };
  return { kind: "unavailable", message: "Dịch vụ hiện chưa khả dụng." };
}

export function setMembershipConflictLock(
  locks: ReadonlySet<string>,
  recruiterId: string,
  locked: boolean,
): Set<string> {
  const next = new Set(locks);
  if (locked) next.add(recruiterId);
  else next.delete(recruiterId);
  return next;
}

export function newMembershipIntentKey(): string {
  return newIdempotencyKey();
}

export type { AdminTeam, AdminTeamMembership, AdminTeamMembershipList };
