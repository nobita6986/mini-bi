/**
 * PRE-W2-HF-D3-B - Supabase Auth Admin integration for the two Auth-crossing
 * operations (CREATE_ACCOUNT, RESET_PASSWORD).
 *
 * - Server-only; never expose the service-role key to the browser/log/audit.
 * - The provenance marker (intent_token) is written to app_metadata.account_intent
 *   by this module and is ALWAYS re-read through the Auth Admin API before it is
 *   trusted. It is never read from the client/JWT.
 * - Password lives only in memory for the single Auth call; it is never logged,
 *   stored in the intent, or returned.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export type AccountOperationAuth = {
  createAuthAccount(input: { login_id: string; password: string; intent_token: string }): Promise<AuthCreateResult>;
  resetAuthPassword(input: { auth_subject: string; password: string }): Promise<AuthResetResult>;
  readAuthUserProvenance(input: { auth_subject: string; intent_token: string }): Promise<AuthUserProvenance>;
  findAuthUserByLoginId(input: { login_id: string; intent_token: string }): Promise<AuthUserProvenance>;
};

export type AuthCreateResult =
  | { kind: "created"; auth_subject: string }
  | { kind: "failure"; code: string }
  | { kind: "unknown" };

export type AuthResetResult =
  | { kind: "applied" }
  | { kind: "failure"; code: string }
  | { kind: "unknown" };

export type AuthUserProvenance =
  | { kind: "match"; auth_subject: string }
  | { kind: "mismatch"; auth_subject: string }
  | { kind: "missing" }
  | { kind: "unknown" };

function adminClient(): SupabaseClient["auth"]["admin"] {
  return createServiceSupabaseClient().auth.admin;
}

/** A returned AuthError with a 4xx status is a deterministic, observed failure. */
function isDeterministic(error: { status?: number; code?: string } | null): boolean {
  return error !== null && typeof error.status === "number" &&
    error.status >= 400 && error.status < 500;
}

function failureCode(error: { status?: number; code?: string } | null): string {
  if (error?.code) return String(error.code).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64);
  return "auth_error";
}

export function canonicalAuthEmail(loginId: string): string {
  return loginId + "@hrpartner.vn";
}

export async function createAuthAccount(input: {
  login_id: string;
  password: string;
  intent_token: string;
}): Promise<AuthCreateResult> {
  try {
    const { data, error } = await adminClient().createUser({
      email: canonicalAuthEmail(input.login_id),
      password: input.password,
      email_confirm: true,
      app_metadata: { account_intent: input.intent_token },
    });
    if (error) {
      return isDeterministic(error) ? { kind: "failure", code: failureCode(error) } : { kind: "unknown" };
    }
    if (!data?.user?.id) return { kind: "unknown" };
    return { kind: "created", auth_subject: data.user.id };
  } catch {
    return { kind: "unknown" };
  }
}

export async function resetAuthPassword(input: {
  auth_subject: string;
  password: string;
}): Promise<AuthResetResult> {
  try {
    const { error } = await adminClient().updateUserById(input.auth_subject, { password: input.password });
    if (error) {
      return isDeterministic(error) ? { kind: "failure", code: failureCode(error) } : { kind: "unknown" };
    }
    return { kind: "applied" };
  } catch {
    return { kind: "unknown" };
  }
}

/** Read the marker back through the Admin API; never trust the JWT/client. */
export async function readAuthUserProvenance(input: {
  auth_subject: string;
  intent_token: string;
}): Promise<AuthUserProvenance> {
  try {
    const { data, error } = await adminClient().getUserById(input.auth_subject);
    if (error) return { kind: "unknown" };
    const marker = (data?.user?.app_metadata as Record<string, unknown> | undefined)?.account_intent;
    if (marker === input.intent_token) return { kind: "match", auth_subject: input.auth_subject };
    return { kind: "mismatch", auth_subject: input.auth_subject };
  } catch {
    return { kind: "unknown" };
  }
}

/** Find an Auth user by canonical email (reconcile path); bounded, read-only. */
export async function findAuthUserByLoginId(input: {
  login_id: string;
  intent_token: string;
}): Promise<AuthUserProvenance> {
  const email = canonicalAuthEmail(input.login_id);
  try {
    for (let page = 1; page <= 5; page += 1) {
      const { data, error } = await adminClient().listUsers({ page, perPage: 1000 });
      if (error) return { kind: "unknown" };
      const users = data?.users ?? [];
      const found = users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
      if (found) {
        const marker = (found.app_metadata as Record<string, unknown> | undefined)?.account_intent;
        return marker === input.intent_token
          ? { kind: "match", auth_subject: found.id }
          : { kind: "mismatch", auth_subject: found.id };
      }
      if (users.length === 0) break;
    }
    return { kind: "missing" };
  } catch {
    return { kind: "unknown" };
  }
}
