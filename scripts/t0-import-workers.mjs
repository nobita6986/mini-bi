#!/usr/bin/env node
/**
 * P2.5-HF-R5B - T0 operator worker importer CLI (.xlsx/.csv -> canonical RPC).
 *
 * --check : validate + chay dung execution plan cua apply roi rollback.
 * --apply : chi commit khi confirmation token (SHA-256 day du cua file nguon) dung.
 * Token duoc kiem tra TRUOC khi load DB config / mo connection.
 * Technical operator chi xuat hien trong batch audit; created_by la uploader nghiep vu.
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
  openBatchAudit,
  postcheckImport,
  preflightAuthority,
  readImportSource,
  resolveOperator,
  resolveRows,
  resolveUploaders,
  sanitizedIssues,
  validateManifest,
  validateOperatorOptions,
  IMPORT_REQUIRED_COLUMNS,
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

export async function runImport(options, dependencies = {}) {
  const parsedArgs = validateOperatorOptions(options);
  if (!parsedArgs.ok) {
    return { ok: false, code: "OPERATOR_INPUT_INVALID", problems: parsedArgs.problems };
  }
  let source;
  try {
    source = await readImportSource(path.resolve(options.input));
  } catch (error) {
    return { ok: false, code: sanitizedFailure(error).code };
  }
  const token = confirmationToken(source.fingerprint);
  if (options.mode === "apply" && options.confirm !== token) {
    // Chua doc config, chua mo connection nao.
    return { ok: false, code: "CONFIRMATION_REQUIRED", fingerprint: source.fingerprint,
      confirmation_token: token };
  }
  for (const column of IMPORT_REQUIRED_COLUMNS) {
    if (!source.header.includes(column)) {
      return { ok: false, code: "MANIFEST_COLUMNS_INVALID", missing: [column] };
    }
  }
  const local = validateManifest(source.records);
  if (local.errors.length > 0) {
    return { ok: false, code: "MANIFEST_INVALID", mode: options.mode,
      fingerprint: source.fingerprint, rows: local.rows.length,
      errors: sanitizedIssues(local.errors) };
  }

  const config = dependencies.loadConfig ? await dependencies.loadConfig()
    : await loadSupabaseConfig();
  const client = dependencies.createClient ? dependencies.createClient(config)
    : new Client({ connectionString: config.databaseUrl, ssl: buildSslOptions(),
      connectionTimeoutMillis: 10000 });
  await client.query("begin");
  try {
    const ledger = await checkMigrationLedger(client);
    if (ledger.required_pending > 0) {
      await client.query("rollback");
      return { ok: false, code: "MIGRATION_LEDGER_PENDING", mode: options.mode, ledger };
    }
    const operator = await resolveOperator(client, parsedArgs.operator);
    if (!operator.ok) {
      await client.query("rollback");
      return { ok: false, code: operator.code, mode: options.mode, ledger };
    }
    const uploaderResolution = await resolveUploaders(client, local.rows);
    if (uploaderResolution.errors.length > 0) {
      await client.query("rollback");
      return { ok: false, code: "UPLOADER_NOT_FOUND", mode: options.mode, ledger,
        errors: sanitizedIssues(uploaderResolution.errors) };
    }
    const referenceResolution = await resolveRows(client, local.rows, uploaderResolution.uploaders);
    if (referenceResolution.errors.length > 0) {
      await client.query("rollback");
      return { ok: false, code: "REFERENCE_NOT_RESOLVED", mode: options.mode, ledger,
        errors: sanitizedIssues(referenceResolution.errors) };
    }
    const authority = await preflightAuthority(client, referenceResolution.rows);
    if (authority.errors.length > 0) {
      await client.query("rollback");
      const distinct = authority.errors.every((item) =>
        item.code === authority.errors[0].code) ? authority.errors[0].code : "AUTHORITY_DENIED";
      return { ok: false, code: distinct, mode: options.mode, ledger,
        errors: sanitizedIssues(authority.errors) };
    }
    const context = { batchId: options.batchId, fingerprint: source.fingerprint,
      operator: operator.operator, reason: parsedArgs.reason };
    const plan = buildImportPlan(referenceResolution.rows, options.batchId);
    const audit = await openBatchAudit(client, context);
    const execution = await executeImportPlan(client, plan, context);
    const ordered = plan.flatMap((chunk) => chunk.rows);
    const acceptance = await postcheckImport(client, execution, ordered, context);
    if (!acceptance.ok) {
      await client.query("rollback");
      return { ok: false, code: "POSTCHECK_FAILED", mode: options.mode,
        acceptance: { problems: sanitizedIssues(acceptance.problems) } };
    }
    if (options.mode === "apply") await client.query("commit");
    else await client.query("rollback");
    return {
      ok: true,
      mode: options.mode,
      committed: options.mode === "apply",
      fingerprint: source.fingerprint,
      rows: ordered.length,
      groups: new Set(plan.map((chunk) => chunk.uploaderLogin + "|" + chunk.targetState)).size,
      chunks: plan.length,
      transitions: execution.transitionCount,
      ledger,
      batch_audit: { count: audit.auditCount, replayed: audit.replayed },
      checks: { status_on: acceptance.status_on, metadata: acceptance.metadata,
        audit: acceptance.audit, operator_audit: acceptance.operator_audit },
    };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // rollback loi thi van bao ma an toan ben duoi
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
