import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { readBoundedJson } from "./write-api.ts";
import {
  parseAccountListQuery,
  parseAccountMutation,
  parseAccountRef,
} from "./app-user-access-contract.ts";
import type { AccountAccessRepository } from "./app-user-access-repository.ts";

export type AccountAccessDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: AccountAccessRepository;
};
export type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

type TrustedActor = { auth_subject: string; app_user_id: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function respond(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function readPreflight(flag: string | undefined): Response | null {
  return flag === "true" ? null : fail("NOT_FOUND", 404);
}
function mutationPreflight(request: Request, flag: string | undefined): Response | null {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  return origin.ok ? null : fail("CSRF_REJECTED", 403);
}

async function resolveTrustedActor(
  dependencies: AccountAccessDependencies,
): Promise<Parsed<TrustedActor>> {
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return { ok: false, response: session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401) : fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    const actor = session.actor.actor;
    if (!actor || typeof actor.auth_subject !== "string" || typeof actor.app_user_id !== "string" ||
        !UUID.test(actor.auth_subject) || !UUID.test(actor.app_user_id)) {
      return { ok: false, response: fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    return { ok: true, value: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id } };
  } catch {
    console.error("[account-access] session unavailable");
    return { ok: false, response: fail("ACCOUNT_UNAVAILABLE", 500) };
  }
}

export function accountAccessErrorResponse(kind: string): Response {
  if (kind === "denied") return fail("ACCOUNT_DENIED", 403);
  if (kind === "not-found") return fail("ACCOUNT_NOT_FOUND", 404);
  if (kind === "conflict") return fail("ACCOUNT_CONFLICT", 409);
  if (kind === "invalid") return fail("ACCOUNT_INVALID", 400);
  console.error("[account-access] unavailable");
  return fail("ACCOUNT_UNAVAILABLE", 500);
}

async function mutationBody(request: Request): Promise<Parsed<unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return { ok: false, response: fail("ACCOUNT_INVALID", 400) };
  }
  const body = await readBoundedJson(request);
  if (body === null) return { ok: false, response: fail("ACCOUNT_INVALID", 400) };
  return { ok: true, value: body };
}

export async function listAccounts(
  request: Request, flag: string | undefined, dependencies: AccountAccessDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const parsed = parseAccountListQuery(new URL(request.url));
  if (!parsed.ok) return fail(parsed.code, 400);
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.listAccounts({ ...actor.value, ...parsed.value });
    if (!result.ok) return accountAccessErrorResponse(result.kind);
    return respond({ ok: true, list: result.data }, 200);
  } catch {
    return fail("ACCOUNT_UNAVAILABLE", 500);
  }
}

export async function getAccount(
  request: Request, accountRef: string, flag: string | undefined,
  dependencies: AccountAccessDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const target = parseAccountRef(accountRef);
  if (!target) return fail("ACCOUNT_INVALID", 400);
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.getAccount({ ...actor.value, target_app_user_id: target });
    if (!result.ok) return accountAccessErrorResponse(result.kind);
    return respond({ ok: true, account: result.data }, 200);
  } catch {
    return fail("ACCOUNT_UNAVAILABLE", 500);
  }
}

export async function mutateAccount(
  request: Request, accountRef: string, action: "enable" | "disable",
  flag: string | undefined, dependencies: AccountAccessDependencies,
): Promise<Response> {
  const blocked = mutationPreflight(request, flag);
  if (blocked) return blocked;
  const target = parseAccountRef(accountRef);
  if (!target) return fail("ACCOUNT_INVALID", 400);
  const body = await mutationBody(request);
  if (!body.ok) return body.response;
  const authorityFields = validateClientBusinessPayload(body.value);
  if (!authorityFields.ok) return fail("ACCOUNT_INVALID", 400);
  const value = record(body.value);
  if (!value || Object.keys(value).some((key) => !["expected_version", "reason", "idempotency_key"].includes(key)) ||
      !("expected_version" in value) || !("idempotency_key" in value)) {
    return fail("ACCOUNT_INVALID", 400);
  }
  const parsed = parseAccountMutation(body.value);
  if (!parsed.ok) return fail(parsed.code, 400);
  const header = request.headers.get("idempotency-key");
  if (header !== null && header !== parsed.value.idempotency_key) return fail("ACCOUNT_INVALID", 400);
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const input = { ...actor.value, target_app_user_id: target, ...parsed.value };
    const result = action === "enable"
      ? await dependencies.repository.enableAccount(input)
      : await dependencies.repository.disableAccount(input);
    if (!result.ok) return accountAccessErrorResponse(result.kind);
    return respond({ ok: true }, 200);
  } catch {
    return fail("ACCOUNT_UNAVAILABLE", 500);
  }
}
