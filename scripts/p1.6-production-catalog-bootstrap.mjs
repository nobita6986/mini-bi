#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";

const CONFIRMATION = "APPLY_P1_6_I04C2B_PRODUCTION_CATALOG";
const ACTOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const PLAN_KEYS = [
  "source_fingerprint",
  "project_count",
  "recruiter_count",
  "provider_period_count",
  "invalid_count",
  "ambiguous_count",
  "catalog_empty",
];

function validatePlan(plan) {
  if (
    plan === null ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    Object.keys(plan).sort().join(",") !== [...PLAN_KEYS].sort().join(",") ||
    typeof plan.source_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(plan.source_fingerprint) ||
    !["project_count", "recruiter_count", "provider_period_count", "invalid_count", "ambiguous_count"]
      .every((key) => Number.isInteger(plan[key]) && plan[key] >= 0) ||
    typeof plan.catalog_empty !== "boolean"
  ) {
    throw new Error("catalog plan response violates the sanitized contract");
  }
  return plan;
}

async function callRpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    const code = typeof error.code === "string" && /^[A-Z0-9]{2,8}$/.test(error.code)
      ? error.code
      : "RPC_ERROR";
    throw new Error(`catalog bootstrap RPC failed (${code})`);
  }
  return data;
}

export async function runCatalogBootstrap({
  mode,
  client,
  authSubject,
  appUserId,
  confirmation,
  idempotencyKey,
  log = console.log,
}) {
  if (!["check", "apply"].includes(mode)) throw new Error("mode must be check or apply");
  if (!ACTOR_ID.test(authSubject ?? "") || !ACTOR_ID.test(appUserId ?? "")) {
    throw new Error("secure Owner actor IDs are required");
  }
  if (mode === "apply") {
    if (confirmation !== CONFIRMATION) throw new Error("catalog apply confirmation token is missing");
    if (!IDEMPOTENCY_KEY.test(idempotencyKey ?? "")) {
      throw new Error("a valid catalog idempotency key is required");
    }
  }

  const plan = validatePlan(await callRpc(client, "direct_entry_catalog_bootstrap_plan", {
    p_auth_subject: authSubject,
    p_app_user_id: appUserId,
  }));

  if (mode === "check") {
    log(JSON.stringify({ mode, ...plan }));
    return plan;
  }

  if (
    plan.project_count !== 8 ||
    plan.recruiter_count !== 10 ||
    plan.provider_period_count < 1 ||
    plan.invalid_count !== 0 ||
    plan.ambiguous_count !== 0
  ) {
    throw new Error("catalog plan does not match the approved Production reporting baseline");
  }

  const result = await callRpc(client, "direct_entry_apply_catalog_bootstrap", {
    p_auth_subject: authSubject,
    p_app_user_id: appUserId,
    p_expected_source_fingerprint: plan.source_fingerprint,
    p_idempotency_key: idempotencyKey,
    p_reason: "Owner-approved P1.6-I04C2B Production catalog bootstrap",
  });

  if (
    result === null ||
    typeof result !== "object" ||
    result.status !== "APPLIED" ||
    result.replayed !== false ||
    result.source_fingerprint !== plan.source_fingerprint ||
    result.project_count !== plan.project_count ||
    result.recruiter_count !== plan.recruiter_count ||
    result.team_count !== 1 ||
    result.provider_membership_count !== plan.provider_period_count
  ) {
    throw new Error("catalog apply response violates the expected result contract");
  }

  log(JSON.stringify({
    mode,
    status: result.status,
    source_fingerprint: result.source_fingerprint,
    project_count: result.project_count,
    recruiter_count: result.recruiter_count,
    team_count: result.team_count,
    provider_membership_count: result.provider_membership_count,
  }));
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.length === 0 || args[0] === "--check"
    ? "check"
    : args.length === 1 && args[0] === "--apply"
      ? "apply"
      : null;
  if (!mode) throw new Error("usage: node scripts/p1.6-production-catalog-bootstrap.mjs [--check|--apply]");

  const authSubject = process.env.P1_6_CATALOG_BOOTSTRAP_AUTH_SUBJECT;
  const appUserId = process.env.P1_6_CATALOG_BOOTSTRAP_APP_USER_ID;
  if (mode === "apply" && process.env.P1_6_CATALOG_BOOTSTRAP_CONFIRM !== CONFIRMATION) {
    throw new Error("catalog apply confirmation token is missing");
  }
  const config = await loadSupabaseConfig();
  const client = createClient(config.url, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  await runCatalogBootstrap({
    mode,
    client,
    authSubject,
    appUserId,
    confirmation: process.env.P1_6_CATALOG_BOOTSTRAP_CONFIRM,
    idempotencyKey: process.env.P1_6_CATALOG_BOOTSTRAP_IDEMPOTENCY_KEY,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Catalog bootstrap failed: ${error instanceof Error ? error.message : "unexpected error"}`);
    process.exitCode = 1;
  });
}
