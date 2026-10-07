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
 * Anything missing, ambiguous or contradictory is refused, so genuine gaps keep
 * resolving to '__unknown__' in the Dashboard.
 *
 * Modes:
 *   --check    read only: plan + current distribution, always rolled back.
 *   --dry-run  runs the exact statements plus the acceptance check, then rolls
 *              back. Nothing is persisted.
 *   --apply    requires P2_DE_DIM_REPAIR_CONFIRM=P2_DE_DIM_REPAIR_APPLY. Refuses
 *              before connecting without it. Commits ONLY when the in-transaction
 *              acceptance check passes, otherwise rolls back and exits non-zero.
 *
 * Output is counts/booleans only: never an email, UUID, worker name, national
 * id or secret.
 */
import process from "node:process";

import { Client } from "pg";

import {
  REPAIR_CONFIRM_ENV,
  REPAIR_CONFIRM_TOKEN,
  REPAIR_DISTRIBUTION_SQL,
  REPAIR_PLAN_SQL,
  REPAIR_VERIFY_SQL,
  assignmentStatements,
  auditStatements,
  deriveRepairPlan,
  distributionMatches,
  foldDistribution,
  summariseRepairPlan,
} from "./lib/p2-de-reporting-dimension-repair.mjs";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

function parseMode(argv) {
  // Exactly one mode flag: an extra argument must never be ignored.
  if (argv.length !== 1) throw new Error("ARGUMENTS_INVALID");
  if (argv[0] === "--check") return "check";
  if (argv[0] === "--dry-run") return "dry-run";
  if (argv[0] === "--apply") return "apply";
  throw new Error("ARGUMENTS_INVALID");
}

async function plan(client) {
  const rows = await client.query(REPAIR_PLAN_SQL);
  return deriveRepairPlan(rows.rows);
}

async function verify(client) {
  const window = await client.query(REPAIR_VERIFY_SQL);
  const distribution = await client.query(REPAIR_DISTRIBUTION_SQL);
  return { window: window.rows[0], distribution: foldDistribution(distribution.rows) };
}

async function executePlan(client, derived) {
  let statements = 0;
  for (const assignment of derived.assignments) {
    for (const statement of assignmentStatements(assignment)) {
      await client.query(statement.sql, statement.params);
      statements += 1;
    }
    for (const statement of auditStatements(assignment)) {
      await client.query(statement.sql, statement.params);
      statements += 1;
    }
  }
  return statements;
}

function assertRepairable(derived) {
  if (derived.refusals.length > 0) {
    const error = new Error("REFUSED_ROWS_PRESENT");
    error.refusals = derived.refusals.length;
    throw error;
  }
}

function acceptance(summary, after) {
  const match = distributionMatches(
    { provider_split: summary.provider_split, reporting_code_split: summary.reporting_code_split },
    after.distribution,
  );
  return {
    facts_total: after.window.facts_total,
    provider_unknown_remaining: after.window.provider_unknown,
    recruiter_unknown_remaining: after.window.recruiter_unknown,
    provider_split_ok: match.provider_split_ok,
    reporting_code_split_ok: match.reporting_code_split_ok,
    distribution: after.distribution,
    ok: after.window.provider_unknown === 0 && after.window.recruiter_unknown === 0 && match.ok,
  };
}

async function runCheck(client) {
  const derived = await plan(client);
  const current = await verify(client);
  return {
    mode: "check",
    plan: summariseRepairPlan(derived),
    current: current.distribution,
    unresolved_now: {
      provider_unknown: current.window.provider_unknown,
      recruiter_unknown: current.window.recruiter_unknown,
    },
  };
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  // The confirmation gate runs BEFORE any Production connection is opened.
  if (mode === "apply" && process.env[REPAIR_CONFIRM_ENV] !== REPAIR_CONFIRM_TOKEN) {
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
      const derived = await plan(client);
      const summary = summariseRepairPlan(derived);
      assertRepairable(derived);
      const statements = await executePlan(client, derived);
      const after = await verify(client);
      const result = acceptance(summary, after);
      if (!result.ok) {
        await client.query("rollback");
        console.log(JSON.stringify({ mode, applied: false, reason: "ACCEPTANCE_FAILED", statement_count: statements, plan: summary, acceptance: result }, null, 2));
        process.exitCode = 1;
        return;
      }
      if (mode === "apply") {
        await client.query("commit");
        console.log(JSON.stringify({ mode, applied: true, statement_count: statements, plan: summary, acceptance: result }, null, 2));
      } else {
        await client.query("rollback");
        console.log(JSON.stringify({ mode, applied: false, reason: "DRY_RUN_ROLLED_BACK", statement_count: statements, plan: summary, acceptance: result }, null, 2));
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
  if (error && error.refusals) console.error("refused_rows=" + error.refusals);
  process.exitCode = 1;
});
