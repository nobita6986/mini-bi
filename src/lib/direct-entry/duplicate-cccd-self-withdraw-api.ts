/**
 * HF Duplicate CCCD Self-Service Actions - API boundary tu rut trung ho so (POST).
 *
 * Pipeline:
 *   1. DIRECT_ENTRY_API_ENABLED gate
 *   2. CSRF / same-origin guard
 *   3. Content-Type: application/json
 *   4. Bounded JSON body + client authority field rejection
 *   5. Strict request projection (entry_id, expected_entry_version, idempotency_key, reason?)
 *   6. Server-resolved trusted session actor
 *   7. Narrow creator-only RPC repository
 *   8. Sanitized response (`Cache-Control: private, no-store`)
 */
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import {
  failJson as fail,
  noStoreJson as respond,
  resolveTrustedSessionActor,
} from "../http/direct-entry-api-guard.ts";
import { projectDuplicateCccdSelfWithdrawRequest } from "./duplicate-cccd-report-contract.ts";
import type { DuplicateCccdSelfWithdrawRepository } from "./duplicate-cccd-self-withdraw-repository.ts";
import { readBoundedJson } from "./write-api.ts";

export type DuplicateCccdSelfWithdrawDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: DuplicateCccdSelfWithdrawRepository;
};

const EXTRA_FORBIDDEN_FIELDS = new Set([
  "authority",
  "canselfwithdraw",
  "canmarkoff",
  "projectid",
  "managedonly",
]);

function hasExtraForbiddenField(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    if (EXTRA_FORBIDDEN_FIELDS.has(normalized)) return true;
  }
  return false;
}

export async function duplicateCccdSelfWithdraw(
  request: Request,
  flag: string | undefined,
  dependencies: DuplicateCccdSelfWithdrawDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);

  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }

  const body = await readBoundedJson(request);
  if (body === null) return fail("BODY_INVALID", 400);
  if (!validateClientBusinessPayload(body).ok || hasExtraForbiddenField(body)) {
    return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
  }

  const parsed = projectDuplicateCccdSelfWithdrawRequest(body);
  if (!parsed) return fail("SELF_WITHDRAW_INVALID", 422);

  const session = await resolveTrustedSessionActor(dependencies.resolveSession, {
    unavailableCode: "SELF_WITHDRAW_UNAVAILABLE",
    logLabel: "duplicate CCCD self-withdraw",
  });
  if (!session.ok) return session.response;

  let result: Awaited<ReturnType<DuplicateCccdSelfWithdrawRepository["selfWithdraw"]>>;
  try {
    result = await dependencies.repository.selfWithdraw({
      auth_subject: session.actor.auth_subject,
      app_user_id: session.actor.app_user_id,
      entry_id: parsed.entry_id,
      expected_version: parsed.expected_entry_version,
      reason: parsed.reason,
      idempotency_key: parsed.idempotency_key,
    });
  } catch {
    console.error("[direct-entry] duplicate CCCD self-withdraw failed");
    return fail("SELF_WITHDRAW_UNAVAILABLE", 500);
  }

  if (!result.ok) {
    if (result.kind === "denied") return fail(result.code, 403);
    if (result.kind === "not-found") return fail(result.code, 404);
    if (result.kind === "conflict") return fail(result.code, 409);
    if (result.kind === "invalid") return fail(result.code, 422);
    console.error("[direct-entry] duplicate CCCD self-withdraw unavailable");
    return fail(result.code, 500);
  }

  return respond({
    ok: true,
    entry_id: result.data.entry_id,
    version: result.data.version,
  }, 200);
}
