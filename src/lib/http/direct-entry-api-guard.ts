/**
 * R2.1 — Shared HTTP / session guard helpers for Direct Entry API boundaries.
 *
 * Centralizes private no-store JSON responses, UUID validation, and fail-closed
 * server-side session actor extraction so API boundaries do not duplicate them.
 */
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TrustedSessionActor = {
  auth_subject: string;
  app_user_id: string;
};

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}

export function noStoreJson(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export function failJson(code: string, status: number): Response {
  return noStoreJson({ ok: false, code }, status);
}

export async function resolveTrustedSessionActor(
  resolveSession: () => Promise<DirectEntrySessionResult>,
  options: {
    unavailableCode: string;
    logLabel: string;
  },
): Promise<{ ok: true; actor: TrustedSessionActor } | { ok: false; response: Response }> {
  let session: DirectEntrySessionResult;
  try {
    session = await resolveSession();
  } catch {
    console.error(`[direct-entry] ${options.logLabel} session unavailable`);
    return { ok: false, response: failJson(options.unavailableCode, 500) };
  }
  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? failJson("UNAUTHENTICATED", 401)
          : failJson("ACTOR_NOT_AVAILABLE", 403),
    };
  }
  const actor = session.actor.actor;
  if (!actor || !isUuid(actor.auth_subject) || !isUuid(actor.app_user_id)) {
    return { ok: false, response: failJson("ACTOR_NOT_AVAILABLE", 403) };
  }
  return {
    ok: true,
    actor: {
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
    },
  };
}
