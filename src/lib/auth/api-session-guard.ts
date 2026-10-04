import "server-only";

/**
 * P1.7-H04 - Guard toi thieu cho cac API route tung nam sau Pilot HTTP Basic Auth.
 *
 * Module nay KHONG tao auth framework moi: no chi tai dung dung helper Supabase
 * session/actor da co (getDirectEntryActor + createDirectEntryActorRepository) va
 * chuan hoa response fail-closed. Khong doc/ghi cookie ngoai helper, khong log PII,
 * khong tra UUID/capability/raw error ra ngoai.
 */
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";

import { getDirectEntryActor } from "./direct-entry-session";
import type { ActorResolution } from "./direct-entry-v2";

export type ApiSessionActor = Extract<ActorResolution, { ok: true }>["actor"];

export type ApiSessionGuardResult =
  | { ok: true; actor: ApiSessionActor }
  | { ok: false; response: Response };

export const API_SESSION_ERROR_CODES = ["UNAUTHENTICATED", "ACTOR_NOT_AVAILABLE"] as const;
export type ApiSessionErrorCode = (typeof API_SESSION_ERROR_CODES)[number];

/** Response loi da sanitize. Khong bao gio chua UUID, capability hay raw error. */
export function apiSessionError(code: ApiSessionErrorCode, status: number): Response {
  return new Response(JSON.stringify({ ok: false, code }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * Xac thuc request bang Supabase session + actor mapping.
 * - chua dang nhap            => 401 UNAUTHENTICATED
 * - da dang nhap nhung actor khong dung duoc (thieu mapping / disabled / ambiguous)
 *                             => 403 ACTOR_NOT_AVAILABLE
 * - loi ha tang khi resolve   => 403 ACTOR_NOT_AVAILABLE (fail closed; khong redirect HTML)
 */
export async function guardApiSession(): Promise<ApiSessionGuardResult> {
  let resolution: ActorResolution;
  try {
    resolution = (await getDirectEntryActor(createDirectEntryActorRepository())).actor;
  } catch {
    return { ok: false, response: apiSessionError("ACTOR_NOT_AVAILABLE", 403) };
  }
  if (resolution.ok) return { ok: true, actor: resolution.actor };
  if (resolution.reason === "UNAUTHENTICATED") {
    return { ok: false, response: apiSessionError("UNAUTHENTICATED", 401) };
  }
  return { ok: false, response: apiSessionError("ACTOR_NOT_AVAILABLE", 403) };
}
