#!/usr/bin/env node
/**
 * Temporary T0 worker importer. Canonical rows are written only through the
 * existing full-profile + submission-transition RPCs. Check mode executes the
 * exact transaction and rolls it back; apply requires a source-bound token.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import {
  ImportValidationError,
  buildImportPlan,
  checkMigrationLedger,
  confirmationToken,
  executeImportPlan,
  postcheckImport,
  preflightDatabase,
  readImportManifest,
  resolveImportAuthority,
  safeManifestSummary,
  sanitizedIssues,
  validateManifestRows,
  validateOperatorOptions,
} from "./lib/t0-worker-import.mjs";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

export function parseImportArgs(argv) {
  const options = {
    mode: null,
    input: null,
    batchId: null,
    operator: null,
    reason: null,
    confirm: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check" || arg === "--apply") {
      if (options.mode !== null) throw new ImportValidationError("ARGUMENTS_INVALID");
      options.mode = arg.slice(2);
      continue;
    }
    const fields = {
      "--input": "input",
      "--batch-id": "batchId",
      "--operator": "operator",
      "--reason": "reason",
      "--confirm": "confirm",
    };
    const field = fields[arg];
    if (!field) throw new ImportValidationError("ARGUMENTS_INVALID");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ImportValidationError("ARGUMENTS_INVALID");
    }
    options[field] = value;
    index += 1;
  }
  if (!options.input) throw new ImportValidationError("ARGUMENTS_INVALID");
  return options;
}

function output(payload, error = false) {
  const stream = error ? console.error : console.log;
  stream(JSON.stringify(payload, null, 2));
}

function fail(code, details = {}, exitCode = 1) {
  output({ ok: false, code, ...details }, true);
  process.exitCode = exitCode;
}

function sanitizedFailure(error) {
  if (error instanceof ImportValidationError) {
    return { code: error.code, details: error.details };
  }
  const sqlstate = typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)
    ? error.code : null;
  return { code: "IMPORT_FAILED", ...(sqlstate ? { sqlstate } : {}) };
}

export async function runImport(options, dependencies = {}) {
  const offline = validateOperatorOptions(options);
  if (!offline.ok) return { ok: false, code: "OPERATOR_INPUT_INVALID", problems: offline.problems };

  const manifest = await readImportManifest(path.resolve(options.input));
  const expectedToken = confirmationToken(manifest.fingerprint);
  if (options.mode === "apply" && options.confirm !== expectedToken) {
    return {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
      fingerprint: manifest.fingerprint,
      confirmation_token: expectedToken,
    };
  }
  if (options.mode === "check" && options.confirm !== null) {
    return { ok: false, code: "ARGUMENTS_INVALID" };
  }

  const local = validateManifestRows(manifest.rows);
  const localSummary = safeManifestSummary(local.rows, local.errors, local.warnings);
  if (local.errors.length > 0) {
    return {
      ok: false,
      code: "MANIFEST_INVALID",
      mode: options.mode,
      fingerprint: manifest.fingerprint,
      summary: localSummary,
      errors: sanitizedIssues(local.errors),
      warnings: sanitizedIssues(local.warnings),
    };
  }

  const config = dependencies.loadConfig
    ? await dependencies.loadConfig()
    : await loadSupabaseConfig();
  const client = dependencies.createClient
    ? dependencies.createClient(config)
    : new Client({
      connectionString: config.databaseUrl,
      ssl: buildSslOptions(),
      connectionTimeoutMillis: 10000,
    });
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query("begin");
    transactionOpen = true;
    const ledger = await checkMigrationLedger(
      client,
      path.join(process.cwd(), "supabase", "migrations"),
    );
    if (ledger.mismatches !== 0) {
      await client.query("rollback");
      transactionOpen = false;
      return { ok: false, code: "MIGRATION_LEDGER_MISMATCH", ledger };
    }
    const authority = await resolveImportAuthority(
      client,
      offline.operator,
      local.rows.map((row) => row.uploaderLogin),
      local.rows,
    );
    const preflight = await preflightDatabase(client, local.rows, authority);
    const allErrors = [...preflight.errors];
    const allWarnings = [...local.warnings, ...preflight.warnings];
    const summary = safeManifestSummary(local.rows, allErrors, allWarnings);
    if (allErrors.length > 0) {
      await client.query("rollback");
      transactionOpen = false;
      return {
        ok: false,
        code: "PREFLIGHT_FAILED",
        mode: options.mode,
        fingerprint: manifest.fingerprint,
        confirmation_token: expectedToken,
        summary,
        ledger,
        errors: sanitizedIssues(allErrors),
        warnings: sanitizedIssues(allWarnings),
      };
    }

    const chunks = buildImportPlan(preflight.rows, options.batchId);
    const context = {
      batchId: options.batchId,
      fingerprint: manifest.fingerprint,
      operator: authority.operator,
      reason: offline.reason,
    };
    const execution = await executeImportPlan(client, chunks, context);
    const acceptance = await postcheckImport(client, execution, preflight.rows, context);
    if (!acceptance.ok) {
      await client.query("rollback");
      transactionOpen = false;
      return {
        ok: false,
        code: "POSTCHECK_FAILED",
        mode: options.mode,
        fingerprint: manifest.fingerprint,
        summary,
        acceptance,
      };
    }
    if (options.mode === "apply") {
      await client.query("commit");
      transactionOpen = false;
      return {
        ok: true,
        mode: "apply",
        applied: true,
        fingerprint: manifest.fingerprint,
        batch_id: options.batchId,
        summary,
        ledger,
        warnings: sanitizedIssues(allWarnings),
        acceptance,
      };
    }
    await client.query("rollback");
    transactionOpen = false;
    return {
      ok: true,
      mode: "check",
      applied: false,
      reason: "DRY_RUN_ROLLED_BACK",
      fingerprint: manifest.fingerprint,
      batch_id: options.batchId,
      confirmation_token: expectedToken,
      summary,
      ledger,
      warnings: sanitizedIssues(allWarnings),
      acceptance,
    };
  } catch (error) {
    if (transactionOpen) {
      try { await client.query("rollback"); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const options = parseImportArgs(process.argv.slice(2));
  const result = await runImport(options);
  output(result, !result.ok);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    const failure = sanitizedFailure(error);
    fail(failure.code, failure.details ? { details: failure.details } :
      failure.sqlstate ? { sqlstate: failure.sqlstate } : {});
  });
}
