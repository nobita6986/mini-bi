/**
 * P3.1-HF-R1 - API boundary cho GET preflight canh bao CCCD trung.
 *
 * Pipeline:
 *   1. DIRECT_ENTRY_API_ENABLED gate
 *   2. validate submissionId (UUID)
 *   3. session server-side (getDirectEntryActor)
 *   4. actor mapping fail-closed
 *   5. repository goi RPC read-only duy nhat
 *   6. strict projection (da lam o repository)
 *   7. sanitized response (private, no-store)
 *
 * GET khong mutation nen khong co CSRF/origin check (theo pattern read hien co cua Direct
 * Entry); duong mutation duy nhat - confirm DRAFT -> REVIEW - van di qua POST transition
 * voi day du same-origin/CSRF, exact-key projection, OCC va idempotency.
 * Khong danh gia capability/scope o application; khong doc bang truc tiep; khong log identity,
 * fingerprint hay raw error.
 */
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import type { DuplicateCccdPreflightRepository } from "./submission-duplicate-cccd-repository.ts";
import type { DuplicateCccdConflict } from "./submission-duplicate-cccd-contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DuplicateCccdPreflightDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: DuplicateCccdPreflightRepository;
};

type TrustedActor = { auth_subject: string; app_user_id: string };

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

async function resolveTrustedActor(
  dependencies: DuplicateCccdPreflightDependencies,
): Promise<{ ok: true; actor: TrustedActor } | { ok: false; response: Response }> {
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return {
        ok: false,
        response: session.actor.reason === "UNAUTHENTICATED"
          ? fail("UNAUTHENTICATED", 401)
          : fail("ACTOR_NOT_AVAILABLE", 403),
      };
    }
    const actor = session.actor.actor;
    if (!actor || typeof actor.auth_subject !== "string" || !UUID.test(actor.auth_subject) ||
        typeof actor.app_user_id !== "string" || !UUID.test(actor.app_user_id)) {
      return { ok: false, response: fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    return { ok: true, actor: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id } };
  } catch {
    console.error("[direct-entry] duplicate CCCD preflight session unavailable");
    return { ok: false, response: fail("SUBMISSION_UNAVAILABLE", 500) };
  }
}

export async function duplicateCccdPreflight(
  _request: Request,
  submissionId: string,
  flag: string | undefined,
  dependencies: DuplicateCccdPreflightDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (typeof submissionId !== "string" || !UUID.test(submissionId)) {
    return fail("SUBMISSION_ID_INVALID", 400);
  }

  const session = await resolveTrustedActor(dependencies);
  if (!session.ok) return session.response;

  let result: Awaited<ReturnType<DuplicateCccdPreflightRepository["preflight"]>>;
  try {
    result = await dependencies.repository.preflight({
      ...session.actor,
      submission_id: submissionId,
    });
  } catch {
    console.error("[direct-entry] duplicate CCCD preflight request failed");
    return fail("SUBMISSION_UNAVAILABLE", 500);
  }
  if (!result.ok) {
    if (result.kind === "denied") return fail("SUBMISSION_DENIED", 403);
    if (result.kind === "not-found") return fail("SUBMISSION_NOT_FOUND", 404);
    if (result.kind === "invalid") return fail("SUBMISSION_TRANSITION_INVALID", 400);
    console.error("[direct-entry] duplicate CCCD preflight unavailable");
    return fail("SUBMISSION_UNAVAILABLE", 500);
  }

  const conflicts: DuplicateCccdConflict[] = result.data.conflicts.map((conflict) => ({
    conflict_ref: conflict.conflict_ref,
    draft_display_name: conflict.draft_display_name,
    project_display: conflict.project_display,
    employment_status: conflict.employment_status,
    employment_status_label: conflict.employment_status_label,
    cccd_last4: conflict.cccd_last4,
  }));
  return respond({
    ok: true,
    submission_id: result.data.submission_id,
    version: result.data.version,
    fingerprint: result.data.fingerprint,
    conflict_count: result.data.conflict_count,
    conflicts,
  }, 200);
}
