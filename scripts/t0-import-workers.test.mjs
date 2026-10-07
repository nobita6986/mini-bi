import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import {
  confirmationToken,
  deterministicUuid,
  readImportManifest,
  validateManifestRows,
} from "./lib/t0-worker-import.mjs";
import { parseImportArgs, runImport } from "./t0-import-workers.mjs";

const OPERATOR_ID = "10000000-0000-4000-8000-000000000001";
const OPERATOR_AUTH = "10000000-0000-4000-8000-000000000002";
const UPLOADER_ID = "20000000-0000-4000-8000-000000000001";
const UPLOADER_AUTH = "20000000-0000-4000-8000-000000000002";
const RECRUITER_ID = "30000000-0000-4000-8000-000000000001";
const ENTRY_ID = "40000000-0000-4000-8000-000000000001";
const SUBMISSION_ID = "50000000-0000-4000-8000-000000000001";
const REASON_ID = "60000000-0000-4000-8000-000000000001";

const HEADERS = [
  "source_row_id", "uploader_login", "project_id", "first_work_date", "display_name",
  "gender", "date_of_birth_text", "national_id", "national_id_issued_at_text",
  "national_id_issued_place", "address", "phone", "provider_type", "recruiter_code",
  "labor_type", "account_number", "bank_name", "account_holder_name", "general_note",
  "target_state",
];

function row(overrides = {}) {
  return {
    source_row_id: "row-001",
    uploader_login: "uploader@example.com",
    project_id: "project-a",
    first_work_date: "02/10/2026",
    display_name: "Sensitive Worker Name",
    gender: "Nữ",
    date_of_birth_text: "23/06/1996",
    national_id: "026196004170",
    national_id_issued_at_text: "",
    national_id_issued_place: "",
    address: "Sensitive address",
    phone: "0776799777",
    provider_type: "Vendor",
    recruiter_code: "vendor-a",
    labor_type: "Thời vụ",
    account_number: "",
    bank_name: "",
    account_holder_name: "",
    general_note: "",
    target_state: "SUBMITTED",
    ...overrides,
  };
}

async function workbookFile(rows) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "t0-worker-import-"));
  const file = path.join(directory, "manifest.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Import");
  sheet.addRow(HEADERS);
  for (const item of rows) sheet.addRow(HEADERS.map((key) => item[key] ?? ""));
  await workbook.xlsx.writeFile(file);
  return { directory, file };
}

class FakeClient {
  constructor({ replayed = false, failCreateAt = null, mismatchedFingerprint = false } = {}) {
    this.commands = [];
    this.connected = false;
    this.auditInserted = false;
    this.createCount = 0;
    this.replayed = replayed;
    this.failCreateAt = failCreateAt;
    this.mismatchedFingerprint = mismatchedFingerprint;
  }
  async connect() { this.connected = true; }
  async end() { this.connected = false; }
  async query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    this.commands.push(normalized.toLowerCase());
    if (["begin", "rollback", "commit"].includes(normalized.toLowerCase())) return { rows: [] };
    if (normalized.includes("from public.schema_migrations")) return { rows: [] };
    if (normalized.includes("join auth.users")) {
      if (params[0] === "operator@example.com") {
        return { rows: [{ app_user_id: OPERATOR_ID, auth_subject: OPERATOR_AUTH }] };
      }
      if (params[0] === "uploader@example.com") {
        return { rows: [{ app_user_id: UPLOADER_ID, auth_subject: UPLOADER_AUTH }] };
      }
      return { rows: [] };
    }
    if (normalized.includes("array_agg(distinct c.capability)")) {
      if (params[0] === OPERATOR_ID) {
        return { rows: [{ capabilities: ["entry_admin"], scopes: ["all"], own_scope_count: 0 }] };
      }
      return { rows: [{
        capabilities: ["entry_create", "submission_create"], scopes: ["own"], own_scope_count: 1,
      }] };
    }
    if (normalized.includes("direct_entry_authorization_date()::text")) {
      return { rows: [{ auth_date: "2026-10-08", cutoff_date: "2026-09-30" }] };
    }
    if (normalized.includes("direct_entry_input_catalog")) {
      return { rows: [{ catalog: {
        projects: [{ project_id: "project-a", display_name: "Project A" }],
        recruiters: [{
          recruiter_id: RECRUITER_ID, provider_type: "vendor", vendor_id: "vendor-a",
          personnel_code: null,
        }],
        banks: [], effective_date: "2026-10-08",
      } }] };
    }
    if (normalized.includes("jsonb_to_recordset")) {
      const input = JSON.parse(params[0]);
      return { rows: input.map((item) => ({
        source_row_id: item.source_row_id,
        is_project_manager: true,
        alias_count: 1,
        provider_count: 1,
        duplicate_national_id: false,
      })) };
    }
    if (normalized.includes("pg_advisory_xact_lock")) return { rows: [{}] };
    if (normalized.includes("direct_entry_create_full_profile_batch_v2")) {
      this.createCount += 1;
      if (this.failCreateAt === this.createCount) throw Object.assign(new Error("private db detail"), { code: "23514" });
      const suffix = String(this.createCount).padStart(12, "0");
      return { rows: [{ result: {
        submission_id: SUBMISSION_ID.slice(0, -12) + suffix,
        entry_ids: [ENTRY_ID.slice(0, -12) + suffix],
        state: "DRAFT", version: 1, replayed: this.replayed,
      } }] };
    }
    if (normalized.includes("direct_entry_transition_submission")) {
      return { rows: [{ result: { state: "SUBMITTED", version: 2 } }] };
    }
    if (normalized.includes("fingerprint_matches") && normalized.includes("direct_entry_audit_events")) {
      const exists = this.auditInserted || this.replayed || this.mismatchedFingerprint;
      return { rows: [{ count: exists ? 1 : 0,
        fingerprint_matches: exists && !this.mismatchedFingerprint }] };
    }
    if (normalized.includes("direct_entry_reason")) return { rows: [{ reason_id: REASON_ID }] };
    if (normalized.startsWith("insert into public.direct_entry_audit_events")) {
      this.auditInserted = true;
      return { rows: [] };
    }
    if (normalized.startsWith("with selected as")) {
      return { rows: [{
        entry_count: 1, submission_count: 1, draft_count: 0, submitted_count: 1,
        hrp_count: 0, vendor_count: 1, reporting_fact_count: 1,
        project_group_counts: [1], recruiter_group_counts: [1],
        recruiter_unknown_count: 0, provider_unknown_count: 0, operator_audit_count: 1,
      }] };
    }
    throw new Error(`UNHANDLED_QUERY:${normalized.slice(0, 80)}`);
  }
}

function options(file, overrides = {}) {
  return {
    mode: "check",
    input: file,
    batchId: "owner-batch-2026-10-08-a",
    operator: "operator@example.com",
    reason: "Owner approved temporary worker import",
    confirm: null,
    ...overrides,
  };
}

test("manifest parsing preserves identifiers as text and reuses current normalization", async () => {
  const fixture = await workbookFile([row()]);
  try {
    const parsed = await readImportManifest(fixture.file);
    const validated = validateManifestRows(parsed.rows);
    assert.equal(validated.errors.length, 0);
    assert.equal(validated.rows[0].nationalId, "026196004170");
    assert.equal(validated.rows[0].firstWorkDate, "2026-10-02");
    assert.equal(validated.rows[0].payload.worker_details.gender.value, "FEMALE");
    assert.equal(validated.rows[0].payload.labor_type, "TEMPORARY");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("numeric national id is rejected instead of losing leading zeros", async () => {
  const fixture = await workbookFile([row({ national_id: 26196004170 })]);
  try {
    await assert.rejects(() => readImportManifest(fixture.file), { message: "IDENTIFIER_MUST_BE_TEXT" });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("duplicate national id is denied offline before opening a database connection", async () => {
  const fixture = await workbookFile([row(), row({ source_row_id: "row-002" })]);
  let configLoads = 0;
  try {
    const result = await runImport(options(fixture.file), {
      loadConfig: async () => { configLoads += 1; return {}; },
    });
    assert.equal(result.code, "MANIFEST_INVALID");
    assert.equal(configLoads, 0);
    assert.ok(result.errors.some((item) => item.code === "NATIONAL_ID_DUPLICATE_IN_BATCH"));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("apply confirmation is bound to the exact source fingerprint and checked before connect", async () => {
  const fixture = await workbookFile([row()]);
  let configLoads = 0;
  try {
    const result = await runImport(options(fixture.file, { mode: "apply", confirm: "wrong" }), {
      loadConfig: async () => { configLoads += 1; return {}; },
    });
    assert.equal(result.code, "CONFIRMATION_REQUIRED");
    assert.equal(result.confirmation_token, confirmationToken(result.fingerprint));
    assert.equal(configLoads, 0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("check executes the real RPC path, verifies it, then rolls back without leaking PII", async () => {
  const fixture = await workbookFile([row()]);
  const client = new FakeClient();
  try {
    const result = await runImport(options(fixture.file), {
      loadConfig: async () => ({ databaseUrl: "unused" }),
      createClient: () => client,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "DRY_RUN_ROLLED_BACK");
    assert.equal(result.acceptance.ok, true);
    assert.ok(client.commands.some((item) => item.includes("direct_entry_create_full_profile_batch_v2")));
    assert.ok(client.commands.some((item) => item.includes("direct_entry_transition_submission")));
    assert.equal(client.commands.at(-1), "rollback");
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /Sensitive Worker Name|026196004170|uploader@example\.com/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("retry with the same batch uses deterministic RPC keys and can commit a replay", async () => {
  const fixture = await workbookFile([row()]);
  const parsed = await readImportManifest(fixture.file);
  const client = new FakeClient({ replayed: true });
  try {
    const result = await runImport(options(fixture.file, {
      mode: "apply",
      confirm: confirmationToken(parsed.fingerprint),
    }), {
      loadConfig: async () => ({ databaseUrl: "unused" }),
      createClient: () => client,
    });
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(result.acceptance.replayed_chunks, 1);
    assert.equal(client.commands.at(-1), "commit");
    assert.equal(deterministicUuid("same"), deterministicUuid("same"));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a batch id already audited for another fingerprint is denied", async () => {
  const fixture = await workbookFile([row()]);
  const client = new FakeClient({ mismatchedFingerprint: true });
  try {
    await assert.rejects(() => runImport(options(fixture.file), {
      loadConfig: async () => ({ databaseUrl: "unused" }),
      createClient: () => client,
    }), { message: "BATCH_ID_REUSED_WITH_DIFFERENT_SOURCE" });
    assert.equal(client.commands.at(-1), "rollback");
    assert.equal(client.commands.some((item) => item.includes("direct_entry_create_full_profile_batch_v2")), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a later RPC failure rolls the whole multi-submission batch back", async () => {
  const fixture = await workbookFile([
    row({ target_state: "DRAFT" }),
    row({ source_row_id: "row-002", national_id: "026196004171", target_state: "SUBMITTED" }),
  ]);
  const client = new FakeClient({ failCreateAt: 2 });
  try {
    await assert.rejects(() => runImport(options(fixture.file), {
      loadConfig: async () => ({ databaseUrl: "unused" }),
      createClient: () => client,
    }));
    assert.equal(client.commands.at(-1), "rollback");
    assert.equal(client.commands.includes("commit"), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("argument parser requires one explicit mode and the complete operator contract", () => {
  const parsed = parseImportArgs([
    "--check", "--input", "batch.xlsx", "--batch-id", "batch-2026-10-08",
    "--operator", "operator@example.com", "--reason", "approved batch import",
  ]);
  assert.equal(parsed.mode, "check");
  assert.equal(parsed.input, "batch.xlsx");
  assert.throws(() => parseImportArgs(["--check", "--apply", "--input", "x.xlsx"]));
});
