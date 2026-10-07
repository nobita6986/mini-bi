#!/usr/bin/env node
/**
 * P3-W07D - historical all-scope data-plane operation for one owner account.
 *
 * Root cause this supports: direct_entry_list_own_drafts evaluates scope grants
 * at the entry's first_work_date. The owner account's scopes start 2026-10-04,
 * so older imported DRAFT rows match no scope and disappear (and multi-scope
 * rows tripped the exact-one scope assertion). This operation makes the account
 * hold an effective all scope from the requested historical date.
 *
 * Check mode is read-only and prints counts / booleans only - no email, no UUID,
 * no PII. Apply mode is reserved for the integration/release lane and requires an
 * explicit confirmation token. Never run apply from this task.
 *
 * Usage:
 *   node scripts/p3-w07d-historical-all-scope.mjs --check
 *   P3_W07D_CONFIRM=P3_W07D_HISTORICAL_ALL_SCOPE_APPLY node scripts/p3-w07d-historical-all-scope.mjs --apply
 */
import process from "node:process";

import { Client } from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const PROFILE_ACCOUNT_EMAIL = "nobita6986@gmail.com";
const HISTORICAL_FROM = "2026-10-02";
const APPLY_CONFIRM_TOKEN = "P3_W07D_HISTORICAL_ALL_SCOPE_APPLY";
const AUDIT_ACTION = "w07d_historical_all_scope";
const AUDIT_REASON = "W07D restore historical all scope for an imported owner draft batch";

function parseMode(argv) {
  // Exactly one mode flag, nothing else: an extra argument must never be ignored.
  if (argv.length !== 1) throw new Error("ARGUMENTS_INVALID");
  if (argv[0] === "--check") return "check";
  if (argv[0] === "--apply") return "apply";
  throw new Error("ARGUMENTS_INVALID");
}

async function resolveAccount(client) {
  const res = await client.query(
    "select a.app_user_id, a.enabled from public.direct_entry_app_users a" +
    " join auth.users u on u.id = a.auth_subject" +
    " where lower(u.email) = lower($1) order by a.app_user_id",
    [PROFILE_ACCOUNT_EMAIL],
  );
  return res.rows;
}

async function grantSummary(client, appUserId) {
  const res = await client.query(
    "select count(*)::int as total," +
    " count(*) filter (where g.valid_to is null)::int as open_total," +
    " count(*) filter (where g.valid_from <= $2::date and (g.valid_to is null or $2::date < g.valid_to))::int as effective_at_historical" +
    " from public.direct_entry_scope_grants g" +
    " where g.app_user_id = $1 and g.scope_kind = 'all'",
    [appUserId, HISTORICAL_FROM],
  );
  return res.rows[0];
}

async function draftSummary(client, appUserId) {
  // Counts only: how many persisted DRAFT rows this owner holds, split by whether
  // the row's own first_work_date falls before the account's scope start.
  const res = await client.query(
    "select count(*)::int as total," +
    " count(*) filter (where e.first_work_date < $2::date)::int as before_scope_start," +
    " count(*) filter (where e.first_work_date >= $2::date)::int as from_scope_start," +
    " count(distinct e.submission_id)::int as distinct_submissions" +
    " from public.direct_entries e" +
    " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
    " where s.state = 'DRAFT' and e.deleted_at is null and e.created_by_user_id = $1",
    [appUserId, "2026-10-04"],
  );
  return res.rows[0];
}

async function listDraftProbe(client, authSubject, appUserId) {
  try {
    await client.query("savepoint w07d_probe");
    const res = await client.query(
      "select public.direct_entry_list_own_drafts($1::uuid,$2::uuid) as data",
      [authSubject, appUserId],
    );
    await client.query("release savepoint w07d_probe");
    const drafts = res.rows[0]?.data?.drafts;
    return { denied: false, code: null, row_count: Array.isArray(drafts) ? drafts.length : 0 };
  } catch (error) {
    await client.query("rollback to savepoint w07d_probe");
    return { denied: true, code: String(error && error.code ? error.code : "UNKNOWN"), row_count: 0 };
  }
}

async function runCheck(client) {
  const accounts = await resolveAccount(client);
  const enabledCount = accounts.filter((row) => row.enabled).length;
  const summary = {
    mode: "check",
    resolution: {
      matched_accounts: accounts.length,
      enabled_accounts: enabledCount,
      exactly_one_enabled: accounts.length === 1 && enabledCount === 1,
    },
    historical_from: HISTORICAL_FROM,
  };
  if (accounts.length !== 1 || enabledCount !== 1) return summary;
  const appUserId = accounts[0].app_user_id;
  const auth = await client.query(
    "select auth_subject from public.direct_entry_app_users where app_user_id = $1",
    [appUserId],
  );
  summary.all_scope = await grantSummary(client, appUserId);
  summary.owned_drafts = await draftSummary(client, appUserId);
  summary.probe = await listDraftProbe(client, auth.rows[0].auth_subject, appUserId);
  return summary;
}

async function runApply(client) {
  // Defence in depth: main() already refused before connecting, so this branch is
  // only reachable if the token disappeared mid-run. Never mutate on a maybe.
  if (process.env.P3_W07D_CONFIRM !== APPLY_CONFIRM_TOKEN) {
    return { mode: "apply", applied: false, reason: "CONFIRMATION_REQUIRED" };
  }
  const accounts = await resolveAccount(client);
  const enabledCount = accounts.filter((row) => row.enabled).length;
  if (accounts.length !== 1 || enabledCount !== 1) {
    return { mode: "apply", applied: false, reason: "ACCOUNT_NOT_UNIQUE_ENABLED" };
  }
  const appUserId = accounts[0].app_user_id;
  const open = await client.query(
    "select grant_id, valid_from::text as valid_from from public.direct_entry_scope_grants" +
    " where app_user_id = $1 and scope_kind = 'all' and valid_to is null for update",
    [appUserId],
  );
  if (open.rows.length !== 1) {
    return { mode: "apply", applied: false, reason: "ALL_GRANT_NOT_UNIQUE_OPEN" };
  }
  if (open.rows[0].valid_from <= HISTORICAL_FROM) {
    return { mode: "apply", applied: false, already_effective: true, reason: "ALREADY_EFFECTIVE" };
  }
  const reason = await client.query(
    "select public.direct_entry_reason($1::uuid, $2::text) as reason_id",
    [appUserId, AUDIT_REASON],
  );
  await client.query(
    "update public.direct_entry_scope_grants set valid_from = $2::date where grant_id = $1::uuid",
    [open.rows[0].grant_id, HISTORICAL_FROM],
  );
  await client.query(
    "insert into public.direct_entry_audit_events" +
    " (auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id, changed_fields)" +
    " select a.auth_subject, a.app_user_id, $2::text, 'entry_admin', null, 'all', 'APPLIED', $3::uuid, array['scope_grant.valid_from']" +
    " from public.direct_entry_app_users a where a.app_user_id = $1::uuid",
    [appUserId, AUDIT_ACTION, reason.rows[0].reason_id],
  );
  return { mode: "apply", applied: true, historical_from: HISTORICAL_FROM };
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  // The confirmation gate runs BEFORE any Production connection is opened, so a
  // refusal cannot even reach the database.
  if (mode === "apply" && process.env.P3_W07D_CONFIRM !== APPLY_CONFIRM_TOKEN) {
    console.log(JSON.stringify(
      { mode: "apply", applied: false, reason: "CONFIRMATION_REQUIRED" },
      null,
      2,
    ));
    return;
  }
  const config = await loadSupabaseConfig();
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: buildSslOptions(),
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  try {
    if (mode === "check") {
      await client.query("begin read only");
      try {
        console.log(JSON.stringify(await runCheck(client), null, 2));
      } finally {
        await client.query("rollback");
      }
      return;
    }
    await client.query("begin");
    try {
      const summary = await runApply(client);
      if (summary.applied === true) await client.query("commit");
      else await client.query("rollback");
      console.log(JSON.stringify(summary, null, 2));
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`P3_W07D_DATA_PLANE_FAILED ${error?.message ?? "UNKNOWN"}`);
  process.exitCode = 1;
});

