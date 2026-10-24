import "server-only";

import {
  projectAccountingCandidateListResponse,
  projectAccountingMembershipListResponse,
  projectAccountingMembershipMutationResponse,
  projectDepartmentDetailResponse,
  projectDepartmentListResponse,
  projectRecruitmentTeamsResponse,
  type AccountingCandidateListProjection,
  type AccountingMembershipListProjection,
  type AccountingMembershipMutationProjection,
  type DepartmentDetailProjection,
  type DepartmentErrorCode,
  type DepartmentListProjection,
  type RecruitmentTeamListProjection,
} from "./department-contract.ts";

export type DepartmentRpcCaller = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type DepartmentActorRef = {
  auth_subject: string;
  app_user_id: string;
};

export type ListDepartmentsResult =
  | { ok: true; data: DepartmentListProjection }
  | { ok: false; code: DepartmentErrorCode };

export type GetDepartmentDetailResult =
  | { ok: true; data: DepartmentDetailProjection }
  | { ok: false; code: DepartmentErrorCode };

export type ListAccountingMembershipsInput = DepartmentActorRef & {
  search: string | null;
  include_history: boolean;
  page: number;
  page_size: number;
};

export type ListAccountingMembershipsResult =
  | { ok: true; data: AccountingMembershipListProjection }
  | { ok: false; code: DepartmentErrorCode };

export type ListAccountingCandidatesInput = DepartmentActorRef & {
  search: string | null;
  page: number;
  page_size: number;
};

export type ListAccountingCandidatesResult =
  | { ok: true; data: AccountingCandidateListProjection }
  | { ok: false; code: DepartmentErrorCode };

export type AssignAccountingMemberInput = DepartmentActorRef & {
  account_ref: string;
  expected_pair_version: number;
  effective_from: string | null;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type EndAccountingMemberInput = DepartmentActorRef & {
  membership_id: string;
  expected_pair_version: number;
  effective_to: string | null;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type AccountingMembershipMutationResult =
  | { ok: true; data: AccountingMembershipMutationProjection }
  | { ok: false; code: DepartmentErrorCode };

export type ListRecruitmentTeamsInput = DepartmentActorRef & {
  search: string | null;
  include_inactive: boolean;
  page: number;
  page_size: number;
};

export type ListRecruitmentTeamsResult =
  | { ok: true; data: RecruitmentTeamListProjection }
  | { ok: false; code: DepartmentErrorCode };

export type DepartmentRepository = {
  listDepartments(actor: DepartmentActorRef): Promise<ListDepartmentsResult>;
  getDepartment(
    input: DepartmentActorRef & { department_id: string },
  ): Promise<GetDepartmentDetailResult>;
  listAccountingMemberships(
    input: ListAccountingMembershipsInput,
  ): Promise<ListAccountingMembershipsResult>;
  listAccountingCandidates(
    input: ListAccountingCandidatesInput,
  ): Promise<ListAccountingCandidatesResult>;
  assignAccountingMember(
    input: AssignAccountingMemberInput,
  ): Promise<AccountingMembershipMutationResult>;
  endAccountingMember(
    input: EndAccountingMemberInput,
  ): Promise<AccountingMembershipMutationResult>;
  listRecruitmentTeams(
    input: ListRecruitmentTeamsInput,
  ): Promise<ListRecruitmentTeamsResult>;
};

const KNOWN_RPC_TOKENS: ReadonlyMap<string, DepartmentErrorCode> = new Map([
  ["DEPARTMENT_QUERY_INVALID", "DEPARTMENT_QUERY_INVALID"],
  ["DEPARTMENT_SEARCH_INVALID", "DEPARTMENT_SEARCH_INVALID"],
  ["DEPARTMENT_NOT_FOUND", "DEPARTMENT_NOT_FOUND"],
  ["DEPARTMENT_INACTIVE", "DEPARTMENT_INACTIVE"],
  ["DEPARTMENT_MEMBERSHIP_UNSUPPORTED", "DEPARTMENT_MEMBERSHIP_UNSUPPORTED"],
  ["DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID", "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID"],
  ["DEPARTMENT_MEMBERSHIP_REASON_INVALID", "DEPARTMENT_MEMBERSHIP_REASON_INVALID"],
  [
    "DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID",
    "DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID",
  ],
  ["DEPARTMENT_MEMBERSHIP_NOT_FOUND", "DEPARTMENT_MEMBERSHIP_NOT_FOUND"],
  ["TARGET_ACCOUNT_NOT_FOUND", "TARGET_ACCOUNT_NOT_FOUND"],
  ["TARGET_ACCOUNT_DISABLED", "TARGET_ACCOUNT_DISABLED"],
  ["DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT", "DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT"],
  ["DEPARTMENT_MEMBERSHIP_OVERLAP", "DEPARTMENT_MEMBERSHIP_OVERLAP"],
  ["DEPARTMENT_MEMBERSHIP_ALREADY_ENDED", "DEPARTMENT_MEMBERSHIP_ALREADY_ENDED"],
  ["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_CONFLICT"],
]);

function serviceRoleRpc(): DepartmentRpcCaller {
  const clientPromise = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await clientPromise).rpc(name, args);
}

function classifyDepartmentRpcError(
  error: { code?: string; message?: string },
  mode: "read" | "mutation",
): DepartmentErrorCode {
  const trimmed = typeof error.message === "string" ? error.message.trim() : "";
  const exact = KNOWN_RPC_TOKENS.get(trimmed);
  if (exact) {
    return exact;
  }

  for (const [token, mapped] of KNOWN_RPC_TOKENS.entries()) {
    if (trimmed.includes(token)) {
      return mapped;
    }
  }

  if (trimmed.includes("actor mapping denied")) {
    return "ACTOR_NOT_AVAILABLE";
  }

  if (error.code === "42501") {
    return "DEPARTMENT_ACCESS_DENIED";
  }
  if (error.code === "P0002") {
    return mode === "mutation"
      ? "DEPARTMENT_MEMBERSHIP_NOT_FOUND"
      : "DEPARTMENT_NOT_FOUND";
  }
  if (error.code === "40001") {
    return "DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT";
  }
  if (error.code === "23505") {
    return "IDEMPOTENCY_CONFLICT";
  }
  if (error.code === "23P01") {
    return "DEPARTMENT_MEMBERSHIP_OVERLAP";
  }
  if (error.code === "22023" || error.code === "23514") {
    return mode === "mutation"
      ? "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID"
      : "DEPARTMENT_QUERY_INVALID";
  }

  return "DEPARTMENT_UNAVAILABLE";
}

export function createServiceDepartmentRepository(
  rpc?: DepartmentRpcCaller,
): DepartmentRepository {
  let resolvedRpc = rpc;

  return {
    async listDepartments(actor) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_list_departments_admin", {
          p_auth_subject: actor.auth_subject,
          p_app_user_id: actor.app_user_id,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "read") };
        }
        const projected = projectDepartmentListResponse(result.data);
        if (!projected) {
          console.error("[departments-admin] list departments returned non-canonical projection");
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] list departments RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async getDepartment(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_get_department_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_department_id: input.department_id,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "read") };
        }
        const projected = projectDepartmentDetailResponse(result.data);
        if (!projected) {
          console.error("[departments-admin] get department returned non-canonical projection");
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] get department RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async listAccountingMemberships(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_list_accounting_memberships_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_include_history: input.include_history,
          p_page: input.page,
          p_page_size: input.page_size,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "read") };
        }
        const projected = projectAccountingMembershipListResponse(result.data);
        if (!projected) {
          console.error(
            "[departments-admin] list accounting memberships returned non-canonical projection",
          );
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] list accounting memberships RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async listAccountingCandidates(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_list_accounting_candidates_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_page: input.page,
          p_page_size: input.page_size,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "read") };
        }
        const projected = projectAccountingCandidateListResponse(result.data);
        if (!projected) {
          console.error(
            "[departments-admin] list accounting candidates returned non-canonical projection",
          );
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] list accounting candidates RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async assignAccountingMember(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_assign_accounting_member", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_target_app_user_id: input.account_ref,
          p_expected_pair_version: input.expected_pair_version,
          p_effective_from: input.effective_from,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "mutation") };
        }
        const projected = projectAccountingMembershipMutationResponse(result.data);
        if (!projected) {
          console.error(
            "[departments-admin] assign accounting member returned non-canonical projection",
          );
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] assign accounting member RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async endAccountingMember(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_end_accounting_member", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_membership_id: input.membership_id,
          p_expected_pair_version: input.expected_pair_version,
          p_effective_to: input.effective_to,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "mutation") };
        }
        const projected = projectAccountingMembershipMutationResponse(result.data);
        if (!projected) {
          console.error(
            "[departments-admin] end accounting member returned non-canonical projection",
          );
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] end accounting member RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async listRecruitmentTeams(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_list_recruitment_teams_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_include_inactive: input.include_inactive,
          p_page: input.page,
          p_page_size: input.page_size,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "read") };
        }
        const projected = projectRecruitmentTeamsResponse(result.data);
        if (!projected) {
          console.error(
            "[departments-admin] list recruitment teams returned non-canonical projection",
          );
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] list recruitment teams RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },
  };
}
