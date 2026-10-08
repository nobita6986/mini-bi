#!/usr/bin/env node
/**
 * P2.5 hotfix - operator provisioning cho Accounting Project Admin.
 *
 * Muc dich DUY NHAT: cap them capability entry_admin cho mot tai khoan ke toan
 * da co reviewer bundle, de dung duoc Project Operations (W02) voi effective
 * all scope hien co. KHONG tao RBAC/role framework thu hai: authority van la
 * capability grants + scope grants tai DB.
 *
 * An toan:
 *   --check (mac dinh) : CHI doc, khong ghi, khong can token.
 *   --apply            : bat buoc P2_5_ACCOUNTING_CONFIRM=<token> duoc kiem tra
 *                        TRUOC khi mo ket noi DB; bat buoc --email (tai khoan
 *                        duoc cap), --actor (nguoi van hanh) va --reason.
 *   Idempotent: chi chen grant con thieu; chay lai khong doi trang thai.
 *   Audit: ghi direct_entry_audit_events trong cung transaction voi grant.
 *   Khong hardcode email tai khoan nao trong product authorization.
 *
 * T1A khong chay --apply tren Production. T0 apply sau review.
 */
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

/** Reviewer bundle hien huu (W05) - phai da co truoc khi cap entry_admin. */
export const REVIEWER_BUNDLE = Object.freeze(["change_review", "pii_view", "payment_view"]);
/** Phan bo sung cua Accounting de dung Project Operations (W02). */
export const ACCOUNTING_ADDITION = Object.freeze(["entry_admin"]);
export const REQUIRED_SCOPE = "all";
/** Capability KHONG duoc cap boi script nay (can T0 phe duyet rieng). */
export const FORBIDDEN_CAPABILITIES = Object.freeze([
  "payment_edit", "employment_status.apply", "entry_privileged_edit",
  "document_view", "document_upload", "pii_export",
]);
export const APPLY_CONFIRM_ENV = "P2_5_ACCOUNTING_CONFIRM";
export const APPLY_CONFIRM_TOKEN = "P2_5_ACCOUNTING_APPLY";

/**
 * Ke hoach cap quyen thuan (khong I/O): tra ve dung nhung gi con thieu.
 * Fail-closed: neu reviewer bundle chua day du thi KHONG cap entry_admin.
 */
export function planBundle(state) {
  if (state === null || typeof state !== "object") return { ok: false, code: "TARGET_NOT_FOUND" };
  const capabilities = new Set(state.capabilities ?? []);
  const scopeKinds = new Set(state.scopeKinds ?? []);
  const missingReviewer = REVIEWER_BUNDLE.filter((capability) => !capabilities.has(capability));
  const forbidden = [...capabilities].filter((capability) =>
    FORBIDDEN_CAPABILITIES.includes(capability));
  const missingScope = !scopeKinds.has(REQUIRED_SCOPE);
  const missingCapabilities = ACCOUNTING_ADDITION.filter((capability) => !capabilities.has(capability));
  if (missingReviewer.length > 0) {
    return { ok: false, code: "REVIEWER_BUNDLE_INCOMPLETE", missingReviewer };
  }
  if (missingScope) return { ok: false, code: "ALL_SCOPE_REQUIRED", missingReviewer: [] };
  if (missingCapabilities.length === 0) {
    return { ok: true, code: "ALREADY_GRANTED", missingCapabilities: [], forbidden,
      missingScope: false };
  }
  return { ok: true, code: "GRANT_REQUIRED", missingCapabilities, forbidden, missingScope: false };
}

function parseArgs(argv) {
  const options = { apply: false, email: null, actor: null, reason: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") continue;
    if (arg === "--apply") { options.apply = true; continue; }
    if (arg === "--email" || arg === "--actor" || arg === "--reason") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.trim() === "") throw new Error("ARGUMENT_VALUE_REQUIRED");
      options[arg.slice(2)] = value.trim();
      index += 1;
      continue;
    }
    throw new Error("ARGUMENTS_INVALID");
  }
  if (options.email === null) throw new Error("EMAIL_REQUIRED");
  if (options.apply && (options.actor === null || options.reason === null)) {
    throw new Error("ACTOR_AND_REASON_REQUIRED");
  }
  return options;
}

/** Confirm token duoc kiem tra TRUOC khi mo bat ky ket noi nao. */
export function assertApplyConfirmed(options, env) {
  if (!options.apply) return;
  if (env[APPLY_CONFIRM_ENV] !== APPLY_CONFIRM_TOKEN) {
    throw new Error("APPLY_CONFIRMATION_REQUIRED");
  }
}

async function readState(client, email) {
  const target = await client.query(
    "select u.id as auth_subject, a.app_user_id, a.enabled" +
    " from auth.users u" +
    " join public.direct_entry_app_users a on a.auth_subject = u.id" +
    " where lower(u.email) = lower($1)", [email]);
  if (target.rows.length !== 1) return null;
  const { auth_subject: authSubject, app_user_id: appUserId, enabled } = target.rows[0];
  const capabilities = await client.query(
    "select capability from public.direct_entry_capability_grants" +
    " where app_user_id = $1" +
    " and valid_from <= public.direct_entry_authorization_date()" +
    " and (valid_to is null or public.direct_entry_authorization_date() < valid_to)",
    [appUserId]);
  const scopes = await client.query(
    "select scope_kind from public.direct_entry_scope_grants" +
    " where app_user_id = $1" +
    " and valid_from <= public.direct_entry_authorization_date()" +
    " and (valid_to is null or public.direct_entry_authorization_date() < valid_to)",
    [appUserId]);
  return {
    email,
    authSubject,
    appUserId,
    enabled,
    capabilities: capabilities.rows.map((row) => row.capability).sort(),
    scopeKinds: [...new Set(scopes.rows.map((row) => row.scope_kind))].sort(),
  };
}

async function actorRef(client, email) {
  const actor = await client.query(
    "select u.id as auth_subject, a.app_user_id" +
    " from auth.users u" +
    " join public.direct_entry_app_users a on a.auth_subject = u.id" +
    " where lower(u.email) = lower($1)", [email]);
  if (actor.rows.length !== 1) throw new Error("ACTOR_NOT_FOUND");
  return actor.rows[0];
}

async function applyGrants(client, { target, actor, plan, reason }) {
  await client.query("begin");
  try {
    const reasonRow = await client.query(
      "select public.direct_entry_reason($1::uuid,$2::text) as reason_id",
      [actor.app_user_id, reason]);
    const reasonId = reasonRow.rows[0].reason_id;
    for (const capability of plan.missingCapabilities) {
      await client.query(
        "insert into public.direct_entry_capability_grants" +
        " (app_user_id, capability, valid_from)" +
        " values ($1,$2,public.direct_entry_authorization_date())" +
        " on conflict (app_user_id, capability, valid_from) do nothing",
        [target.appUserId, capability]);
      await client.query(
        "insert into public.direct_entry_audit_events" +
        " (auth_subject, app_user_id, action, capability, resource_ref, scope_kind," +
        "  outcome, reason_id, changed_fields)" +
        " values ($1,$2,'accounting_project_admin_grant',$3,$4,'all','APPLIED',$5,$6)",
        [actor.auth_subject, actor.app_user_id, capability, target.appUserId,
          reasonId, ["capability", "scope"]]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export async function run(options, env = process.env, log = console.log) {
  assertApplyConfirmed(options, env);
  const config = await loadSupabaseConfig();
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: buildSslOptions(config),
  });
  await client.connect();
  try {
    const target = await readState(client, options.email);
    const plan = planBundle(target);
    log("target=" + options.email);
    log("mode=" + (options.apply ? "apply" : "check"));
    log("capabilities=" + (target ? target.capabilities.join(",") : ""));
    log("scopes=" + (target ? target.scopeKinds.join(",") : ""));
    log("plan=" + plan.code);
    if (!plan.ok) throw new Error(plan.code);
    if (plan.missingCapabilities.length === 0) {
      log("no_change=true");
      return { applied: false, plan };
    }
    log("missing=" + plan.missingCapabilities.join(","));
    if (plan.forbidden.length > 0) log("forbidden_present=" + plan.forbidden.join(","));
    if (!options.apply) {
      log("dry_run=true (dung --apply voi token de ghi)");
      return { applied: false, plan };
    }
    const actor = await actorRef(client, options.actor);
    await applyGrants(client, { target, actor, plan, reason: options.reason });
    log("applied=" + plan.missingCapabilities.join(","));
    return { applied: true, plan };
  } finally {
    await client.end();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await run(options);
}

if (process.argv[1] &&
    fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) {
  main().catch((error) => {
    process.stderr.write("FAILED: " + (error instanceof Error ? error.message : "UNKNOWN") + "\n");
    process.exitCode = 1;
  });
}
