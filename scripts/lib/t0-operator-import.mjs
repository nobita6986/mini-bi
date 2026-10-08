/**
 * P2.5-HF-R5B - T0 operator worker importer (rebaseline tren contract P2.5 #57-#61).
 *
 * Chi dung canonical service-role RPC `direct_entry_create_full_profile_batch_v2` (+
 * `direct_entry_transition_submission` khi manifest yeu cau SUBMITTED). Khong migration/schema/
 * capability moi, khong DML truc tiep tren canonical data, khong import engine thu hai.
 *
 * Tai su dung: quy tac canonical CMT/CCCD (src/lib/contracts/national-id.ts), contract full-profile
 * worker-profile/1.1, idempotency cua RPC (#58), episode guard (#58-#60), config/TLS loader
 * (scripts/lib/load-supabase-config.mjs, supabase-tls.mjs).
 *
 * Moi output chi gom counts, so dong manifest va ma loi an toan: khong ten, CCCD, dien thoai,
 * tai khoan ngan hang, UUID, email hay raw DB message.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { isCanonicalNationalId } from "../../src/lib/contracts/national-id.ts";

export const IMPORT_CONFIRM_PREFIX = "T0_WORKER_IMPORT_APPLY:";
export const IMPORT_CONTRACT_VERSION = "worker-profile/1.1";
export const IMPORT_MAX_ROWS = 100;
/** Contract bat buoc truoc khi apply: initial-ON (#57) va chuoi episode/CCCD (#58-#61). */
export const IMPORT_REQUIRED_MIGRATIONS = Object.freeze([
  "20261008170000_p2_5_initial_employment_status_on.sql",
  "20261008180000_p2_5_hf_worker_create_and_rehire.sql",
  "20261008190000_p2_5_hf_r1_episode_status_guard_and_lookup_boundary.sql",
  "20261008200000_p2_5_hf_r2_cccd_canonicalization_guard.sql",
  "20261008210000_p2_5_hf_r3_worker_full_correction.sql",
]);
export const IMPORT_TARGET_STATES = Object.freeze(["DRAFT", "SUBMITTED"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const EMPLOYEE_CODE = /^hrp-[0-9]{4}-[0-9]{6}$/;
const LABOR_TYPES = Object.freeze(["TEMPORARY", "PERMANENT"]);
const PAYMENT_STATES = Object.freeze(["omitted", "unknown", "intentionally_blank", "provided"]);
const ROW_KEYS = Object.freeze([
  "source_row_id", "project_id", "recruiter_id", "first_work_date", "labor_type", "provider_type",
  "display_name", "national_id", "date_of_birth", "gender", "address", "phone",
  "national_id_issued_at", "national_id_issued_place", "payment", "uploader",
]);
/** Ma loi DB duoc phep di ra ngoai nguyen van: chung la hang so, khong chua du lieu. */
const SAFE_DB_MESSAGES = Object.freeze([
  "BANK_NOT_ACTIVE", "BATCH_INVALID", "EMPLOYEE_CODE_DUPLICATE", "EMPLOYEE_CODE_YEAR",
  "EMPLOYEE_CODE_SEQUENCE_EXHAUSTED", "EMPLOYEE_CODE_LEGACY_QUARANTINE", "GENERAL_NOTE_TOO_LONG",
  "NATIONAL_ID_DUPLICATE", "NATIONAL_ID_INVALID", "OFF_REQUIRES_DATE_AND_REASON",
  "PAYMENT_DETAILS_INVALID", "PROFILE_DATE_INVALID", "PROJECT_NOT_ACTIVE", "RECRUITER_NOT_ACTIVE",
  "RECRUITER_MEMBERSHIP_INVALID",
]);

export class ImportValidationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "ImportValidationError";
    this.code = code;
    this.details = details;
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function issue(code, sourceRowId = null, severity = "error") {
  return { code, source_row_id: sourceRowId, severity };
}

function optionalValue(value) {
  if (value === undefined || value === null) return { state: "omitted" };
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? { state: "omitted" } : { state: "provided", value: trimmed };
}

export function confirmationToken(fingerprint) {
  return IMPORT_CONFIRM_PREFIX + String(fingerprint).slice(0, 16).toUpperCase();
}

function fingerprintOf(rows, targetState) {
  const canonical = JSON.stringify({
    target_state: targetState,
    rows: rows.map((row) => ({ ...row })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function readImportManifest(inputPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    throw new ImportValidationError("MANIFEST_UNREADABLE");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
      !Array.isArray(parsed.rows)) {
    throw new ImportValidationError("MANIFEST_INVALID");
  }
  const targetState = text(parsed.target_state).toUpperCase() || "DRAFT";
  if (!IMPORT_TARGET_STATES.includes(targetState)) {
    throw new ImportValidationError("TARGET_STATE_INVALID");
  }
  const rows = [];
  for (const raw of parsed.rows) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ImportValidationError("MANIFEST_INVALID");
    }
    rows.push(raw);
  }
  return { targetState, rows, fingerprint: fingerprintOf(rows, targetState) };
}

export function validateOperatorOptions(options) {
  const problems = [];
  if (options.mode !== "check" && options.mode !== "apply") problems.push("MODE_INVALID");
  if (typeof options.input !== "string" || options.input.trim() === "") problems.push("INPUT_REQUIRED");
  if (typeof options.batchId !== "string" || !UUID.test(options.batchId)) {
    problems.push("BATCH_ID_INVALID");
  }
  if (typeof options.operator !== "string" || options.operator.trim() === "" ||
      options.operator.length > 320) {
    problems.push("OPERATOR_REQUIRED");
  }
  if (typeof options.reason !== "string" || options.reason.trim() === "" ||
      options.reason.trim().length > 1000) {
    problems.push("REASON_REQUIRED");
  }
  if (options.mode === "check" && options.confirm !== null && options.confirm !== undefined) {
    problems.push("CONFIRM_NOT_ALLOWED_FOR_CHECK");
  }
  const ok = problems.length === 0;
  return {
    ok,
    problems,
    operator: ok ? options.operator.trim() : null,
    reason: ok ? options.reason.trim() : null,
  };
}

export function validateManifestRows(rawRows) {
  const rows = [];
  const errors = [];
  const warnings = [];
  if (rawRows.length === 0) errors.push(issue("MANIFEST_EMPTY"));
  if (rawRows.length > IMPORT_MAX_ROWS) errors.push(issue("MANIFEST_TOO_LARGE"));
  const seenSource = new Set();
  const seenNationalId = new Map();
  for (const [index, raw] of rawRows.entries()) {
    const rowNumber = index + 1;
    const sourceRowId = text(raw.source_row_id) || String(rowNumber);
    for (const key of Object.keys(raw)) {
      if (!ROW_KEYS.includes(key)) {
        errors.push(issue("ROW_COLUMN_UNSUPPORTED", sourceRowId));
        break;
      }
    }
    if (seenSource.has(sourceRowId)) errors.push(issue("ROW_SOURCE_ID_DUPLICATE", sourceRowId));
    seenSource.add(sourceRowId);
    const projectId = text(raw.project_id);
    if (!SAFE_ID.test(projectId)) errors.push(issue("ROW_PROJECT_INVALID", sourceRowId));
    const recruiterId = text(raw.recruiter_id);
    if (!UUID.test(recruiterId)) errors.push(issue("ROW_RECRUITER_INVALID", sourceRowId));
    const firstWorkDate = text(raw.first_work_date);
    if (!ISO_DATE.test(firstWorkDate)) {
      errors.push(issue("ROW_FIRST_WORK_DATE_INVALID", sourceRowId));
    }
    const laborType = text(raw.labor_type).toUpperCase();
    if (!LABOR_TYPES.includes(laborType)) errors.push(issue("ROW_LABOR_TYPE_INVALID", sourceRowId));
    const displayName = text(raw.display_name);
    if (displayName === "" || displayName.length > 256) {
      errors.push(issue("ROW_DISPLAY_NAME_INVALID", sourceRowId));
    }
    // Ky tu dinh dang bi TU CHOI (khong tu chuan hoa du lieu nguoi nhap): ghi phai la
    // dung dang canonical 9/12 chu so, giu so 0 dau.
    const nationalId = text(raw.national_id);
    if (!isCanonicalNationalId(nationalId)) {
      // Gia tri CCCD khong bao gio duoc tra ve hay ghi log.
      errors.push(issue("ROW_NATIONAL_ID_INVALID", sourceRowId));
    } else if (seenNationalId.has(nationalId)) {
      errors.push(issue("ROW_NATIONAL_ID_DUPLICATE", sourceRowId));
    }
    if (nationalId !== "") seenNationalId.set(nationalId, sourceRowId);
    const gender = text(raw.gender).toUpperCase();
    if (gender !== "" && !["MALE", "FEMALE", "OTHER"].includes(gender)) {
      errors.push(issue("ROW_GENDER_INVALID", sourceRowId));
    }
    const workerDetails = {
      display_name: displayName,
      date_of_birth: optionalValue(raw.date_of_birth),
      national_id: { state: "provided", value: nationalId },
      address: optionalValue(raw.address),
      phone: optionalValue(raw.phone),
    };
    if (gender !== "") workerDetails.gender = { state: "provided", value: gender };
    if (raw.national_id_issued_at !== undefined) {
      workerDetails.national_id_issued_at = optionalValue(raw.national_id_issued_at);
    }
    if (raw.national_id_issued_place !== undefined) {
      workerDetails.national_id_issued_place = optionalValue(raw.national_id_issued_place);
    }
    let payment = null;
    if (raw.payment !== undefined && raw.payment !== null) {
      if (typeof raw.payment !== "object" || Array.isArray(raw.payment)) {
        errors.push(issue("ROW_PAYMENT_INVALID", sourceRowId));
      } else {
        const state = text(raw.payment.state);
        if (!PAYMENT_STATES.includes(state)) {
          errors.push(issue("ROW_PAYMENT_INVALID", sourceRowId));
        } else {
          payment = { state };
          if (state === "provided") {
            const accountNumber = text(raw.payment.account_number);
            const bankId = text(raw.payment.bank_id);
            const holder = text(raw.payment.account_holder_name);
            if (accountNumber === "" || bankId === "" || holder === "") {
              errors.push(issue("ROW_PAYMENT_INVALID", sourceRowId));
            } else {
              payment.account_number = accountNumber;
              payment.bank_id = bankId;
              payment.account_holder_name = holder;
            }
          }
        }
      }
    }
    // provider_type la metadata bat buoc: no phai khop membership cua recruiter.
    const providerType = text(raw.provider_type);
    if (!SAFE_ID.test(providerType)) {
      errors.push(issue("ROW_PROVIDER_INVALID", sourceRowId));
    }
    rows.push({
      sourceRowId,
      project_id: projectId,
      recruiter_id: recruiterId,
      first_work_date: firstWorkDate,
      labor_type: laborType,
      provider_type: providerType,
      display_name: displayName,
      national_id: nationalId,
      worker_details: workerDetails,
      payment,
      uploader: text(raw.uploader) || null,
    });
  }
  return { rows, errors, warnings };
}

/** Payload canonical worker-profile/1.1: provider/team duoc server dan xuat tu membership. */
export function toContractRow(row) {
  const contract = {
    project_id: row.project_id,
    first_work_date: row.first_work_date,
    recruiter_id: row.recruiter_id,
    labor_type: row.labor_type,
    display_name: row.display_name,
    worker_details: row.worker_details,
  };
  contract.provider_type = row.provider_type;
  if (row.payment !== null) contract.payment = row.payment;
  return contract;
}

export function buildImportPlan(rows, batchId) {
  // Mot manifest = mot RPC call = mot transaction: batch khong the partial write.
  return [{
    idempotencyKey: batchId,
    rows,
    payload: rows.map(toContractRow),
  }];
}

export function safeManifestSummary(rows, errors = [], warnings = []) {
  return {
    rows: rows.length,
    errors: errors.length,
    warnings: warnings.length,
    target_state: "DRAFT",
  };
}

export function sanitizedIssues(items) {
  return items.map((item) => ({
    code: item.code,
    source_row_id: item.source_row_id ?? null,
    severity: item.severity ?? "error",
  }));
}

export function classifyDatabaseError(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  const message = typeof error?.message === "string" ? error.message : "";
  if (code === "42P01") return { code: "MIGRATION_LEDGER_UNAVAILABLE", sqlstate: code };
  if (code === "42501") return { code: "AUTHORITY_DENIED", sqlstate: code };
  if (code === "40001") return { code: "VERSION_CONFLICT", sqlstate: code };
  if (code === "23505") {
    if (message.includes("worker_active_episode_exists")) {
      return { code: "ACTIVE_EPISODE_EXISTS", sqlstate: code };
    }
    if (message.includes("worker_episode_reopen_forbidden")) {
      return { code: "EPISODE_REOPEN_FORBIDDEN", sqlstate: code };
    }
    return { code: "ROW_CONFLICT", sqlstate: code };
  }
  if (code === "22023" && message.includes("idempotency key reused with different input")) {
    return { code: "IDEMPOTENCY_CONFLICT", sqlstate: code };
  }
  if (message !== "" && SAFE_DB_MESSAGES.includes(message)) {
    return { code: message, sqlstate: code };
  }
  if (code === "22023" || code === "23514" || code === "22008") {
    return { code: "ROW_INVALID", sqlstate: code };
  }
  return { code: "IMPORT_FAILED", sqlstate: code };
}

export async function checkMigrationLedger(client) {
  const applied = await client.query("select version from public.schema_migrations");
  const appliedVersions = new Set(applied.rows.map((row) => String(row.version)));
  const pending = IMPORT_REQUIRED_MIGRATIONS.filter((version) => !appliedVersions.has(version));
  return {
    applied: appliedVersions.size,
    required: IMPORT_REQUIRED_MIGRATIONS.length,
    required_pending: pending.length,
    pending_names: pending,
  };
}

const OPERATOR_SQL = `
select u.app_user_id::text as app_user_id, u.auth_subject::text as auth_subject
  from public.direct_entry_app_users u
  join auth.users a on a.id = u.auth_subject
 where u.enabled
   and (lower(coalesce(a.email, '')) = lower($1)
        or u.app_user_id::text = $1 or u.auth_subject::text = $1)`;

export async function resolveOperator(client, operatorKey) {
  const result = await client.query(OPERATOR_SQL, [operatorKey]);
  if (result.rows.length !== 1) return null;
  return { auth_subject: result.rows[0].auth_subject, app_user_id: result.rows[0].app_user_id };
}

export async function executeImportPlan(client, plan, context) {
  const chunk = plan[0];
  const created = await client.query(
    "select public.direct_entry_create_full_profile_batch_v2(" +
    "$1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text) as data",
    [context.operator.auth_subject, context.operator.app_user_id, IMPORT_CONTRACT_VERSION,
      JSON.stringify(chunk.payload), chunk.idempotencyKey]);
  const data = created.rows[0]?.data ?? null;
  const entryIds = Array.isArray(data?.entry_ids) ? data.entry_ids : null;
  const employeeCodes = Array.isArray(data?.employee_codes) ? data.employee_codes : null;
  if (entryIds === null || employeeCodes === null || entryIds.length !== chunk.rows.length ||
      employeeCodes.length !== entryIds.length ||
      !entryIds.every((value) => typeof value === "string" && UUID.test(value)) ||
      !employeeCodes.every((value) => typeof value === "string" && EMPLOYEE_CODE.test(value))) {
    throw new ImportValidationError("RPC_RESULT_INVALID");
  }
  const execution = {
    entryIds, employeeCodes, batchId: context.batchId, targetState: context.targetState,
    submissionIds: [],
  };
  if (context.targetState === "SUBMITTED") {
    for (const entryId of entryIds) {
      const submission = await client.query(
        "select submission_id::text as submission_id from public.direct_entries" +
        " where entry_id = $1::uuid", [entryId]);
      const submissionId = submission.rows[0]?.submission_id;
      if (typeof submissionId !== "string" || !UUID.test(submissionId)) {
        throw new ImportValidationError("RPC_RESULT_INVALID");
      }
      // Duong submit canonical: DRAFT -> REVIEW -> SUBMITTED, cung idempotency key cua batch.
      await client.query(
        "select public.direct_entry_transition_submission(" +
        "$1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text)",
        [context.operator.auth_subject, context.operator.app_user_id, submissionId, 1, "REVIEW",
          context.batchId]);
      await client.query(
        "select public.direct_entry_transition_submission(" +
        "$1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text)",
        [context.operator.auth_subject, context.operator.app_user_id, submissionId, 2, "SUBMITTED",
          context.batchId]);
      execution.submissionIds.push(submissionId);
    }
  }
  return execution;
}

const POSTCHECK_SQL = "select e.entry_id::text as entry_id, e.employee_code, e.project_id," +
  " e.deleted_at, e.first_work_date::text as first_work_date," +
  " e.recruiter_id::text as recruiter_id, e.labor_type, e.provider_type," +
  " (e.team_id is not null) as has_team," +
  " (select st.status from public.direct_entry_employment_status_events st" +
  "   where st.entry_id = e.entry_id order by st.version desc limit 1) as latest_status," +
  " (select count(*)::int from public.direct_entry_employment_status_events st" +
  "   where st.entry_id = e.entry_id) as status_events," +
  " (select count(*)::int from public.direct_entry_audit_events a" +
  "   where a.resource_ref = e.entry_id::text) as audits" +
  " from public.direct_entries e where e.entry_id = $1::uuid";

export async function postcheckImport(client, execution, rows) {
  const byEntry = new Map();
  for (const entryId of execution.entryIds) {
    const found = await client.query(POSTCHECK_SQL, [entryId]);
    if (found.rows.length === 1) byEntry.set(entryId, found.rows[0]);
  }
  const problems = [];
  let statusOn = 0;
  let metadata = 0;
  let audit = 0;
  for (const [index, entryId] of execution.entryIds.entries()) {
    const row = rows[index];
    const found = byEntry.get(entryId);
    if (found === undefined || found.deleted_at !== null) {
      problems.push(issue("POSTCHECK_ROW_MISSING", row.sourceRowId));
      continue;
    }
    if (found.employee_code !== execution.employeeCodes[index]) {
      problems.push(issue("POSTCHECK_EMPLOYEE_CODE_MISMATCH", row.sourceRowId));
    }
    // #57: ho so moi mac dinh ON va khong append mot ON event thua.
    if (found.latest_status !== "ON") {
      problems.push(issue("POSTCHECK_STATUS_NOT_ON", row.sourceRowId));
    } else if (Number(found.status_events) !== 1) {
      problems.push(issue("POSTCHECK_STATUS_EVENTS_UNEXPECTED", row.sourceRowId));
    } else {
      statusOn += 1;
    }
    const metadataOk = found.project_id === row.project_id &&
      found.recruiter_id === row.recruiter_id &&
      found.first_work_date === row.first_work_date &&
      found.labor_type === row.labor_type &&
      found.has_team === true &&
      typeof found.provider_type === "string" && found.provider_type !== "";
    if (!metadataOk) problems.push(issue("POSTCHECK_METADATA_MISSING", row.sourceRowId));
    else metadata += 1;
    if (Number(found.audits) < 1) problems.push(issue("POSTCHECK_AUDIT_MISSING", row.sourceRowId));
    else audit += 1;
  }
  return { ok: problems.length === 0, problems, status_on: statusOn, metadata, audit };
}

export async function countBatchResidue(client, entryIds) {
  let entries = 0;
  let statusEvents = 0;
  for (const entryId of entryIds) {
    const found = await client.query(
      "select (select count(*)::int from public.direct_entries where entry_id = $1::uuid) as entries," +
      " (select count(*)::int from public.direct_entry_employment_status_events st" +
      "   where st.entry_id = $1::uuid) as status_events", [entryId]);
    entries += Number(found.rows[0].entries);
    statusEvents += Number(found.rows[0].status_events);
  }
  return { entries, status_events: statusEvents };
}

export async function localMigrations() {
  const directory = path.resolve("supabase", "migrations");
  return (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
}
