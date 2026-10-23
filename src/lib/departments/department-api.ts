import "server-only";

import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isSameOriginAuthRequest } from "../auth/same-origin-auth-request.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import {
  adminAuthorityNavPredicate,
  type NavActorProjection,
} from "../navigation/registry-capability.ts";
import {
  computeAssignAccountingMemberFingerprint,
  computeEndAccountingMemberFingerprint,
  departmentHttpStatusForError,
  parseAssignAccountingMemberBody,
  parseDepartmentIdParam,
  parseEndAccountingMemberBody,
  parseListAccountingCandidatesQuery,
  parseListAccountingMembershipsQuery,
  parseListDepartmentsQuery,
  parseListRecruitmentTeamsQuery,
  type DepartmentErrorCode,
} from "./department-contract.ts";
import type { DepartmentRepository } from "./department-repository.ts";

const MAX_DEPARTMENT_MUTATION_JSON_BYTES = 8_192;

const DISALLOWED_AUTHORITY_HEADERS = [
  "x-app-user-id",
  "x-actor-id",
  "x-auth-subject",
  "x-user-id",
  "x-capabilities",
  "x-scope",
] as const;

export type DepartmentAdminApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: DepartmentRepository;
};

function departmentError(code: DepartmentErrorCode): Response {
  return failJson(code, departmentHttpStatusForError(code));
}

function hasDisallowedAuthorityHeaders(request: Request): boolean {
  for (const headerName of DISALLOWED_AUTHORITY_HEADERS) {
    if (request.headers.get(headerName) !== null) {
      return true;
    }
  }
  return false;
}

async function resolveVerifiedFullAdminActor(
  resolveSession: () => Promise<DirectEntrySessionResult>,
): Promise<
  | {
      ok: true;
      auth_subject: string;
      app_user_id: string;
    }
  | { ok: false; response: Response }
> {
  let session: DirectEntrySessionResult;
  try {
    session = await resolveSession();
  } catch {
    console.error("[departments-admin] session resolution failed");
    return { ok: false, response: departmentError("DEPARTMENT_UNAVAILABLE") };
  }

  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? departmentError("UNAUTHENTICATED")
          : departmentError("ACTOR_NOT_AVAILABLE"),
    };
  }

  const actor = session.actor.actor;
  if (
    !actor ||
    actor.enabled !== true ||
    !isUuid(actor.auth_subject) ||
    !isUuid(actor.app_user_id)
  ) {
    return { ok: false, response: departmentError("ACTOR_NOT_AVAILABLE") };
  }

  const navActor: NavActorProjection = {
    capabilities: actor.capabilities,
    scopes: actor.scopes.map((scope) => ({ kind: scope.kind })),
  };

  if (!adminAuthorityNavPredicate(navActor)) {
    return { ok: false, response: departmentError("DEPARTMENT_ACCESS_DENIED") };
  }

  return {
    ok: true,
    auth_subject: actor.auth_subject.toLowerCase(),
    app_user_id: actor.app_user_id.toLowerCase(),
  };
}

async function readBoundedJsonBody(
  request: Request,
  limitBytes: number,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; kind: "invalid" | "too-large" }
> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const trimmed = declaredLength.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, kind: "invalid" };
    }
    const parsedLength = Number(trimmed);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return { ok: false, kind: "invalid" };
    }
    if (parsedLength > limitBytes) {
      return { ok: false, kind: "too-large" };
    }
  }

  if (!request.body) {
    return { ok: false, kind: "invalid" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limitBytes) {
        await reader.cancel();
        return { ok: false, kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, kind: "invalid" };
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    return { ok: false, kind: "invalid" };
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const rawText = new TextDecoder("utf-8", { fatal: true }).decode(combined);
    return { ok: true, value: JSON.parse(rawText) as unknown };
  } catch {
    return { ok: false, kind: "invalid" };
  }
}

export async function listDepartmentsAdmin(
  request: Request,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  const queryCheck = parseListDepartmentsQuery(parsedUrl);
  if (!queryCheck.ok) return departmentError(queryCheck.code);

  const result = await dependencies.repository.listDepartments({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
  });
  if (!result.ok) return departmentError(result.code);

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function getDepartmentAdmin(
  request: Request,
  departmentId: string,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  const parsedId = parseDepartmentIdParam(departmentId, parsedUrl);
  if (!parsedId.ok) return departmentError(parsedId.code);

  const result = await dependencies.repository.getDepartment({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    department_id: parsedId.value,
  });
  if (!result.ok) return departmentError(result.code);

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function listAccountingMembershipsAdmin(
  request: Request,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  const parsedQuery = parseListAccountingMembershipsQuery(parsedUrl);
  if (!parsedQuery.ok) return departmentError(parsedQuery.code);

  const result = await dependencies.repository.listAccountingMemberships({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    search: parsedQuery.value.search,
    include_history: parsedQuery.value.include_history,
    page: parsedQuery.value.page,
    page_size: parsedQuery.value.page_size,
  });
  if (!result.ok) return departmentError(result.code);

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function listAccountingCandidatesAdmin(
  request: Request,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  const parsedQuery = parseListAccountingCandidatesQuery(parsedUrl);
  if (!parsedQuery.ok) return departmentError(parsedQuery.code);

  const result = await dependencies.repository.listAccountingCandidates({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    search: parsedQuery.value.search,
    page: parsedQuery.value.page,
    page_size: parsedQuery.value.page_size,
  });
  if (!result.ok) return departmentError(result.code);

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function assignAccountingMemberAdmin(
  request: Request,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  if (!isSameOriginAuthRequest(request)) {
    return departmentError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0) {
      return departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
    }
  } catch {
    return departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return departmentError("CONTENT_TYPE_INVALID");
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_DEPARTMENT_MUTATION_JSON_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? departmentError("BODY_TOO_LARGE")
      : departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
  }

  const parsedBody = parseAssignAccountingMemberBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) {
    return departmentError(parsedBody.code);
  }

  const fingerprint = computeAssignAccountingMemberFingerprint({
    actor_app_user_id: actorResult.app_user_id,
    account_ref: parsedBody.value.account_ref,
    expected_pair_version: parsedBody.value.expected_pair_version,
    effective_from: parsedBody.value.effective_from,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.assignAccountingMember({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    account_ref: parsedBody.value.account_ref,
    expected_pair_version: parsedBody.value.expected_pair_version,
    effective_from: parsedBody.value.effective_from,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return departmentError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      membership: saved.data.membership,
    },
    saved.data.replayed ? 200 : 201,
  );
}

export async function endAccountingMemberAdmin(
  request: Request,
  membershipId: string,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  if (!isSameOriginAuthRequest(request)) {
    return departmentError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0) {
      return departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
    }
  } catch {
    return departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return departmentError("CONTENT_TYPE_INVALID");
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_DEPARTMENT_MUTATION_JSON_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? departmentError("BODY_TOO_LARGE")
      : departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
  }

  const parsedBody = parseEndAccountingMemberBody(
    membershipId,
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) {
    return departmentError(parsedBody.code);
  }

  const fingerprint = computeEndAccountingMemberFingerprint({
    actor_app_user_id: actorResult.app_user_id,
    membership_id: parsedBody.value.membership_id,
    expected_pair_version: parsedBody.value.expected_pair_version,
    effective_to: parsedBody.value.effective_to,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.endAccountingMember({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    membership_id: parsedBody.value.membership_id,
    expected_pair_version: parsedBody.value.expected_pair_version,
    effective_to: parsedBody.value.effective_to,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return departmentError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      membership: saved.data.membership,
    },
    200,
  );
}

export async function listRecruitmentTeamsAdmin(
  request: Request,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  const parsedQuery = parseListRecruitmentTeamsQuery(parsedUrl);
  if (!parsedQuery.ok) return departmentError(parsedQuery.code);

  const result = await dependencies.repository.listRecruitmentTeams({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    search: parsedQuery.value.search,
    include_inactive: parsedQuery.value.include_inactive,
    page: parsedQuery.value.page,
    page_size: parsedQuery.value.page_size,
  });
  if (!result.ok) return departmentError(result.code);

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}
