import "server-only";

import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { failJson, isUuid, noStoreJson, resolveTrustedSessionActor } from "../http/direct-entry-api-guard.ts";
import {
  parseWorkerEditHistorySearchQuery,
  workerEditHistoryHttpStatus,
  type WorkerEditHistoryError,
} from "./worker-edit-history-contract.ts";
import type { WorkerEditHistoryRepository } from "./worker-edit-history-repository.ts";

const DISALLOWED_AUTHORITY_HEADERS = [
  "x-app-user-id", "x-actor-id", "x-auth-subject", "x-user-id", "x-capabilities", "x-scope",
] as const;

export type WorkerEditHistoryApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: WorkerEditHistoryRepository;
};

function errorResponse(code: WorkerEditHistoryError): Response {
  return failJson(code, workerEditHistoryHttpStatus(code));
}

function hasDisallowedAuthorityHeaders(request: Request): boolean {
  return DISALLOWED_AUTHORITY_HEADERS.some((name) => request.headers.get(name) !== null);
}

export async function getWorkerEditHistory(
  request: Request,
  dependencies: WorkerEditHistoryApiDependencies,
): Promise<Response> {
  if (hasDisallowedAuthorityHeaders(request)) return errorResponse("WORKER_EDIT_HISTORY_QUERY_INVALID");
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return errorResponse("WORKER_EDIT_HISTORY_QUERY_INVALID");
  }
  const parsed = parseWorkerEditHistorySearchQuery(url);
  if (!parsed.ok) return errorResponse(parsed.code);
  const actor = await resolveTrustedSessionActor(dependencies.resolveSession, {
    unavailableCode: "WORKER_EDIT_HISTORY_UNAVAILABLE",
    logLabel: "worker edit history",
  });
  if (!actor.ok) return actor.response;
  const result = await dependencies.repository.search({
    ...actor.actor,
    ...parsed.value,
  });
  if (!result.ok) return errorResponse(result.code);
  return noStoreJson({ ok: true, data: result.value }, 200);
}

export async function getWorkerEditHistoryRevision(
  request: Request,
  entryId: string,
  revisionId: string,
  dependencies: WorkerEditHistoryApiDependencies,
): Promise<Response> {
  let hasQuery = true;
  try {
    hasQuery = new URL(request.url).search !== "";
  } catch {
    return errorResponse("WORKER_EDIT_HISTORY_QUERY_INVALID");
  }
  if (hasDisallowedAuthorityHeaders(request) || hasQuery || !isUuid(entryId) || !isUuid(revisionId)) {
    return errorResponse("WORKER_EDIT_HISTORY_QUERY_INVALID");
  }
  const actor = await resolveTrustedSessionActor(dependencies.resolveSession, {
    unavailableCode: "WORKER_EDIT_HISTORY_UNAVAILABLE",
    logLabel: "worker edit history detail",
  });
  if (!actor.ok) return actor.response;
  const result = await dependencies.repository.getRevision({
    ...actor.actor,
    entry_id: entryId,
    revision_id: revisionId,
  });
  if (!result.ok) return errorResponse(result.code);
  return noStoreJson({ ok: true, data: result.value }, 200);
}
