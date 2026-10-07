#!/usr/bin/env node
/**
 * P2 Direct Entry reporting dimension classification hotfix - data-plane repair.
 *
 * Repairs ONLY the evidence-backed metadata the reporting projection reads:
 *   * recruiter_provider_memberships.valid_from for a recruiter whose single
 *     membership row carries the same provider_type as every stored fact but
 *     starts AFTER those facts;
 *   * recruiter_aliases rows (the reporting vocabulary) whose reporting_key is
 *     taken from recruiters.personnel_code (HRP) or
 *     recruiter_provider_memberships.vendor_id (Vendor).
 * The anchor date is the earliest first_work_date of the recruiter's facts inside
 * the reporting window, never a Draft or out-of-window row. Anything missing,
 * ambiguous, expired or already claimed by another recruiter is refused, so
 * genuine gaps keep resolving to '__unknown__' in the Dashboard.
 *
 * Modes:
 *   --check                read only: plan + current distribution, rolled back.
 *   --dry-run --actor U --reason TEXT
 *                          runs the exact statements plus the acceptance check,
 *                          then rolls back. Nothing is persisted.
 *   --apply --actor U --reason TEXT
 *                          additionally requires
 *                          P2_DE_DIM_REPAIR_CONFIRM=P2_DE_DIM_REPAIR_APPLY. The
 *                          gate runs BEFORE connecting. The actor must be an
 *                          enabled account holding recruiter_master_manage or
 *                          entry_admin; the reason must be non-empty. Commits ONLY
 *                          when the in-transaction acceptance check passes.
 *
 * A second run after a successful repair is a valid no-op: nothing is rewritten,
 * no alias is duplicated and no extra audit row is written.
 *
 * Output is counts/booleans only: never an email, UUID, worker name, national id
 * or secret.
 */
import process from "node:process";

import { Client } from "pg";

import {
  REPAIR_ACTOR_SQL,
  REPAIR_CONFIRM_ENV,
  REPAIR_CONFIRM_TOKEN,
  REPAIR_DISTRIBUTION_SQL,
  REPAIR_PLAN_SQL,
  REPAIR_REASON_SQL,
  REPAIR_VERIFY_SQL,
  acceptanceCheck,
  assignmentStatements,
  auditStatements,
  deriveRepairPlan,
  foldDistribution,
  summariseRepairPlan,
  validateOperatorInput,
} from "./lib/p2-de-reporting-dimension-repair.mjs";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const MODES = ["--check", "--dry-run", "--apply"];

function parseOptions(argv) {
  const options = { mode: null, actor: null, reason: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (MODES.includes(arg)) {
      // Exactly one mode flag: a second one is a mistake, not a precedence rule.
      if (options.mode !== null) throw new Error("ARGUMENTS_INVALID");
      options.mode = arg.slice(2);
      continue;
    }
    if (arg === "--actor" || arg === "--reason") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("ARGUMENTS_INVALID");
      if (arg === "--actor") options.actor = value;
      else options.reason = value;
      index += 1;
      continue;
    }
    throw new Error("ARGUMENTS_INVALID");
  }
  if (options.mode === null) throw new Error("ARGUMENTS_INVALID");
  if (options.mode === "check" && (options.actor !== null || options.reason !== null)) {
    throw new Error("ARGUMENTS_INVALID");
  }
  return options;
}

function refuse(payload, code) {
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = code;
}

async function currentState(client) {
  const window = await client.query(REPAIR_VERIFY_SQL);
  const distribution = await client.query(REPAIR_DISTRIBUTION_SQL);
  return { window: window.rows[0], distribution: foldDistribution(distribution.rows) };
}

async function plan(client) {
  const rows = await client.query(REPAIR_PLAN_SQL);
  return deriveRepairPlan(rows.rows);
}

async function resolveActor(client, operator) {
  const res = await client.query(REPAIR_ACTOR_SQL, [operator.actor]);
  if (res.rows.length !== 1) return null;
  const row = res.rows[0];
  if (!row.capability) return null;
  return { authSubject: row.auth_subject, appUserId: row.app_user_id, capability: row.capability };
}

async function executePlan(client, derived, actor) {
  let statements = 0;
  let reasonId = null;
  if (derived.assignments.length > 0) {
    const reason = await client.query(REPAIR_REASON_SQL, [actor.appUserId, actor.reasonText]);
    reasonId = reason.rows[0].reason_id;
    for (const assignment of derived.assignments) {
      for (const statement of assignmentStatements(assignment)) {
        await client.query(statement.sql, statement.params);
        statements += 1;
      }
      for (const statement of auditStatements(assignment, {
        authSubject: actor.authSubject,
        appUserId: actor.appUserId,
        capability: actor.capability,
        reasonId,
      })) {
        await client.query(statement.sql, statement.params);
        statements += 1;
      }
    }
  }
  return { statements, reasonId };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const operator = options.mode === "check"
    ? null
    : validateOperatorInput({ actor: options.actor, reason: options.reason });
  // Both gates are offline and run before any Production connection is opened:
  // the operator flags first (a precise reason), then the confirmation token as
  // the last gate before the database is touched.
  if (operator && !operator.ok) {
    refuse({ mode: options.mode, applied: false, reason: "OPERATOR_INVALID", problems: operator.problems }, 1);
    return;
  }
  if (options.mode === "apply" && process.env[REPAIR_CONFIRM_ENV] !== REPAIR_CONFIRM_TOKEN) {
    refuse({ mode: "apply", applied: false, reason: "CONFIRMATION_REQUIRED" }, 0);
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
    if (options.mode === "check") {
      await client.query("begin read only");
      try {
        const derived = await plan(client);
        const state = await currentState(client);
        console.log(JSON.stringify({
          mode: "check",
          plan: summariseRepairPlan(derived),
          refusal_reasons: summariseRepairPlan(derived).refusal_reasons,
          current: state.distribution,
          unresolved_now: {
            provider_unknown: state.window.provider_unknown,
            recruiter_unknown: state.window.recruiter_unknown,
          },
        }, null, 2));
      } finally {
        await client.query("rollback");
      }
      return;
    }
    await client.query("begin");
    try {
      const actor = await resolveActor(client, operator);
      if (actor === null) {
        await client.query("rollback");
        refuse({ mode: options.mode, applied: false, reason: "ACTOR_NOT_AUTHORIZED" }, 1);
        return;
      }
      const before = await currentState(client);
      const derived = await plan(client);
      const summary = summariseRepairPlan(derived);
      if (derived.refusals.length > 0) {
        await client.query("rollback");
        refuse({
          mode: options.mode,
          applied: false,
          reason: "REFUSED_ROWS_PRESENT",
          plan: summary,
        }, 1);
        return;
      }
      const executed = await executePlan(client, derived, {
        ...actor,
        reasonText: operator.reason,
      });
      const after = await currentState(client);
      const acceptance = acceptanceCheck(before, after, derived);
      const payload = {
        mode: options.mode,
        already_applied: derived.assignments.length === 0,
        statement_count: executed.statements,
        plan: summary,
        acceptance,
      };
      if (!acceptance.ok) {
        await client.query("rollback");
        refuse({ ...payload, applied: false, reason: "ACCEPTANCE_FAILED" }, 1);
        return;
      }
      if (options.mode === "apply") {
        await client.query("commit");
        console.log(JSON.stringify({ ...payload, applied: true }, null, 2));
      } else {
        await client.query("rollback");
        console.log(JSON.stringify({ ...payload, applied: false, reason: "DRY_RUN_ROLLED_BACK" }, null, 2));
      }
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const reason = error && error.message ? error.message : "UNKNOWN";
  console.error("P2_DE_DIM_REPAIR_FAILED " + reason);
  process.exitCode = 1;
});
