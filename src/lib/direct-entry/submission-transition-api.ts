/**
 * P1.6-W04-S04C-S01A - API boundary cho POST transition submission.
 *
 * Pipeline bat buoc (theo pattern mutation hien co cua Direct Entry):
 *   1. flag gate DIRECT_ENTRY_API_ENABLED
 *   2. same-origin/CSRF
 *   3. submissionId UUID
 *   4. content-type + JSON bounded
 *   5. strict request projection (khong nhan authority tu client)
 *   6. resolve session server-side
 *   7. actor mapping fail-closed
 *   8. repository/RPC
 *   9. response sanitized
 *
 * Khong tra raw DB message, stack, auth claim hay chi tiet SQL. Capability/scope/OCC/idempotency
 * do RPC enforce; module nay KHONG danh gia capability hay scope.
 */
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { readBoundedJson } from "./write-api.ts";
import { projectSubmissionTransitionRequest } from "./submission-transition-contract.ts";
import type { SubmissionTransitionRepository } from "./submission-transition-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SubmissionTransitionDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: SubmissionTransitionRepository;
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

export async function transitionSubmission(
  request: Request,
  submissionId: string,
  flag: string | undefined,
  dependencies: SubmissionTransitionDependencies,
): Promise<Response> {
  // 1. Gate truoc moi thu: khong doc params/session/repository khi API tat.
  if (flag !== "true") return fail("NOT_FOUND", 404);

  // 2. CSRF/same-origin theo pattern mutation hien co.
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);

  // 3. submissionId phai la UUID truoc khi doc body.
  if (typeof submissionId !== "string" || !UUID.test(submissionId)) {
    return fail("SUBMISSION_ID_INVALID", 400);
  }

  // 4. JSON bounded.
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }
  const body = await readBoundedJson(request);
  if (body === null) return fail("BODY_INVALID", 400);

  // 5. Strict projection: exact fields, khong authority, khong state/version/submitted_at tu client.
  let parsed: ReturnType<typeof projectSubmissionTransitionRequest>;
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
    parsed = projectSubmissionTransitionRequest(body);
  } catch {
    return fail("SUBMISSION_TRANSITION_INVALID", 400);
  }
  if (!parsed.ok) return fail(parsed.code, 400);

  // Idempotency key di kem trong body; neu client cung gui header thi phai khop (khong co hai nguon su that).
  const headerKey = request.headers.get("idempotency-key");
  if (headerKey !== null && headerKey !== parsed.value.idempotency_key) {
    return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  }

  try {
    // 6-7. Session/actor lay tu server, fail-closed.
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const actor = session.actor.actor;
    if (!actor || typeof actor.auth_subject !== "string" || !UUID.test(actor.auth_subject) ||
        typeof actor.app_user_id !== "string" || !UUID.test(actor.app_user_id)) {
      return fail("ACTOR_NOT_AVAILABLE", 403);
    }

    // 8. Repository/RPC voi actor do server suy ra. Hai dang request duoc phep:
    //    * 3 key  -> duong cu (DRAFT -> REVIEW khong conflict, REVIEW -> DRAFT, SUBMITTED);
    //    * 5 key  -> entry point da xac nhan, server se tu kiem tra lai tap conflict.
    const result = await dependencies.repository.transitionSubmission({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      submission_id: submissionId,
      expected_version: parsed.value.expected_version,
      target_state: parsed.value.target_state,
      idempotency_key: parsed.value.idempotency_key,
      ...(parsed.value.duplicate_cccd_fingerprint === undefined
        ? {}
        : {
            duplicate_cccd_fingerprint: parsed.value.duplicate_cccd_fingerprint,
            duplicate_cccd_count: parsed.value.duplicate_cccd_count,
          }),
    });
    if (!result.ok) {
      if (result.kind === "denied") return fail("SUBMISSION_DENIED", 403);
      if (result.kind === "not-found") return fail("SUBMISSION_NOT_FOUND", 404);
      if (result.kind === "conflict") return fail("SUBMISSION_CONFLICT", 409);
      if (result.kind === "duplicate-confirmation") {
        // Tap conflict da thay doi: khong submit, client phai preflight lai va xac nhan lai.
        return fail("DUPLICATE_CCCD_CONFIRMATION_REQUIRED", 409);
      }
      if (result.kind === "invalid") return fail("SUBMISSION_TRANSITION_INVALID", 400);
      console.error("[direct-entry] submission transition unavailable");
      return fail("SUBMISSION_UNAVAILABLE", 500);
    }

    // 9. Response chi gom metadata RPC tra ve (khong co reused/submitted_at trong hop dong RPC).
    return respond({
      ok: true,
      submission_id: result.data.submission_id,
      state: result.data.state,
      version: result.data.version,
    }, 200);
  } catch {
    console.error("[direct-entry] submission transition request failed");
    return fail("SUBMISSION_UNAVAILABLE", 500);
  }
}
