#!/usr/bin/env node
/**
 * P2.5-HF-R5B - T0 operator worker importer CLI.
 *
 * --check : validate + chay dung transaction/RPC cua apply roi rollback (khong ghi gi).
 * --apply : chi commit khi confirmation token dung.
 * Token duoc kiem tra TRUOC khi load DB config / mo connection.
 * Khong migration, khong UI, khong DML truc tiep tren canonical data: chi canonical RPC.
 */
import path from "node:path";
import process from "node:process";

import { Client } from "pg";

import {
  ImportValidationError,
  buildImportPlan,
  checkMigrationLedger,
  classifyDatabaseError,
  confirmationToken,
  executeImportPlan,
  postcheckImport,
  readImportManifest,
  resolveOperator,
  safeManifestSummary,
  sanitizedIssues,
  validateManifestRows,
  validateOperatorOptions,
} from "./lib/t0-operator-import.mjs";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

export function parseImportArgs(argv) {
  const options = { mode: null, input: null, batchId: null, operator: null, reason: null,
    confirm: null };
  const fields = {
    "--input": "input", "--batch-id": "batchId", "--operator": "operator",
    "--reason": "reason", "--confirm": "confirm",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check" || arg === "--apply") {
      if (options.mode !== null) throw new ImportValidationError("ARGUMENTS_INVALID");
      options.mode = arg.slice(2);
      continue;
    }
    const field = fields[arg];
    if (!field) throw new ImportValidationError("ARGUMENTS_INVALID");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ImportValidationError("ARGUMENTS_INVALID");
    }
    options[field] = value;
    index += 1;
  }
  return options;
}

function output(payload, isError = false) {
  const stream = isError ? console.error : console.log;
  stream(JSON.stringify(payload, null, 2));
}

function sanitizedFailure(error) {
  if (error instanceof ImportValidationError) return { code: error.code };
  return classifyDatabaseError(error);
}

/** Tra ve payload an toan (counts/ma loi); dependencies cho phep test tiem config/client. */
export async function runImport(options, dependencies = {}) {
  const parsedArgs = validateOperatorOptions(options);
  if (!parsedArgs.ok) {
    return { ok: false, code: "OPERATOR_INPUT_INVALID", problems: parsedArgs.problems };
  }

  let manifest;
  try {
    manifest = await readImportManifest(path.resolve(options.input));
  } catch (error) {
    return { ok: false, code: sanitizedFailure(error).code };
  }
  const expectedToken = confirmationToken(manifest.fingerprint);
  if (options.mode === "apply" && options.confirm !== expectedToken) {
    // Chua doc config, chua mo connection nao.
    return { ok: false, code: "CONFIRMATION_REQUIRED", fingerprint: manifest.fingerprint,
      confirmation_token: expectedToken };
  }

  const local = validateManifestRows(manifest.rows);
  const summary = safeManifestSummary(local.rows, local.errors, local.warnings);
  summary.target_state = manifest.targetState;
  if (local.errors.length > 0) {
    return { ok: false, code: "MANIFEST_INVALID", mode: options.mode,
      fingerprint: manifest.fingerprint, summary, errors: sanitizedIssues(local.errors) };
  }

  const config = dependencies.loadConfig
    ? await dependencies.loadConfig()
    : await loadSupabaseConfig();
  const client = dependencies.createClient
    ? dependencies.createClient(config)
    : new Client({ connectionString: config.databaseUrl, ssl: buildSslOptions(),
      connectionTimeoutMillis: 10000 });
  await client.query("begin");
  try {
    const ledger = await checkMigrationLedger(client);
    if (ledger.required_pending > 0) {
      await client.query("rollback");
      return { ok: false, code: "MIGRATION_LEDGER_PENDING", mode: options.mode,
        fingerprint: manifest.fingerprint, ledger };
    }
    const operator = await resolveOperator(client, parsedArgs.operator);
    if (operator === null) {
      await client.query("rollback");
      return { ok: false, code: "OPERATOR_NOT_FOUND", mode: options.mode, ledger };
    }
    const context = { batchId: options.batchId, fingerprint: manifest.fingerprint, operator,
      reason: parsedArgs.reason, targetState: manifest.targetState };
    const plan = buildImportPlan(local.rows, options.batchId);
    const execution = await executeImportPlan(client, plan, context);
    const acceptance = await postcheckImport(client, execution, local.rows);
    if (!acceptance.ok) {
      await client.query("rollback");
      return { ok: false, code: "POSTCHECK_FAILED", mode: options.mode, summary, ledger,
        acceptance: { problems: sanitizedIssues(acceptance.problems) } };
    }
    if (options.mode === "apply") {
      await client.query("commit");
    } else {
      await client.query("rollback");
    }
    return {
      ok: true,
      mode: options.mode,
      committed: options.mode === "apply",
      target_state: manifest.targetState,
      fingerprint: manifest.fingerprint,
      summary,
      ledger,
      checks: { rows: acceptance.status_on, status_on: acceptance.status_on,
        metadata: acceptance.metadata, audit: acceptance.audit },
    };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // rollback loi thi van bao ma loi an toan ben duoi
    }
    return { ok: false, code: sanitizedFailure(error).code, mode: options.mode };
  } finally {
    if (typeof client.end === "function") {
      try {
        await client.end();
      } catch {
        // ignore
      }
    }
  }
}

async function main() {
  let options;
  try {
    options = parseImportArgs(process.argv.slice(2));
  } catch {
    output({ ok: false, code: "ARGUMENTS_INVALID" }, true);
    process.exitCode = 2;
    return;
  }
  const result = await runImport(options);
  output(result, result.ok === false);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("t0-import-workers.mjs")) {
  await main();
}
