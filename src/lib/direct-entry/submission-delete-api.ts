import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { readBoundedJson } from "./write-api.ts";
import { projectSubmissionDeleteRequest } from "./submission-delete-contract.ts";
import type { SubmissionDeleteRepository } from "./submission-delete-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SubmissionDeleteDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: SubmissionDeleteRepository;
};

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

export async function deleteDraftSubmission(
  request: Request,
  submissionId: string,
  flag: string | undefined,
  dependencies: SubmissionDeleteDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (typeof submissionId !== "string" || !UUID.test(submissionId)) {
    return fail("SUBMISSION_ID_INVALID", 400);
  }
  if (new URL(request.url).searchParams.keys().next().done !== true) {
    return fail("SUBMISSION_QUERY_INVALID", 400);
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null || idempotencyKey.trim() === "" ||
      idempotencyKey.length > 128 || /[\u0000-\u001f\u007f]/.test(idempotencyKey)) {
    return fail("IDEMPOTENCY_KEY_INVALID", 400);
  }
  const body = await readBoundedJson(request);
  if (body === null) return fail("BODY_INVALID", 400);

  let parsed: ReturnType<typeof projectSubmissionDeleteRequest>;
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
    parsed = projectSubmissionDeleteRequest(body);
  } catch {
    return fail("SUBMISSION_DELETE_INVALID", 400);
  }
  if (!parsed) return fail("SUBMISSION_DELETE_INVALID", 400);

  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const actor = session.actor.actor;
    if (!actor || !UUID.test(actor.auth_subject) || !UUID.test(actor.app_user_id)) {
      return fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const result = await dependencies.repository.deleteDraftSubmission({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      submission_id: submissionId,
      expected_version: parsed.expected_version,
      idempotency_key: idempotencyKey,
    });
    if (!result.ok) {
      if (result.kind === "denied") return fail("SUBMISSION_DELETE_DENIED", 403);
      if (result.kind === "not-found") return fail("SUBMISSION_NOT_FOUND", 404);
      if (result.kind === "conflict") return fail("SUBMISSION_CONFLICT", 409);
      if (result.kind === "processing") return fail("SUBMISSION_PROCESSING", 409);
      if (result.kind === "invalid") return fail("SUBMISSION_DELETE_INVALID", 400);
      console.error("[direct-entry] submission deletion unavailable");
      return fail("SUBMISSION_DELETE_UNAVAILABLE", 500);
    }
    return respond({
      ok: true,
      submission_id: result.data.submission_id,
      deleted: true,
      version: result.data.version,
      entries_deleted: result.data.entries_deleted,
      cleanup_objects_queued: result.data.cleanup_objects_queued,
    }, 200);
  } catch {
    console.error("[direct-entry] submission deletion request failed");
    return fail("SUBMISSION_DELETE_UNAVAILABLE", 500);
  }
}
