import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

import { buildAccountMetadata } from "../../src/lib/direct-entry/full-profile-batch.ts";
import {
  foldPasteToken,
  isDigitStringOfLength,
  normalizePasteDate,
} from "../../src/lib/direct-entry/paste-primitives.ts";
import { migrationChecksum } from "./migration-validation.mjs";

export const IMPORT_CONFIRM_PREFIX = "T0_WORKER_IMPORT_APPLY:";
export const IMPORT_MAX_ROWS_PER_SUBMISSION = 100;
export const IMPORT_ACTION = "t0_worker_import";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EMAIL_LIKE = /\b[^\s@]+@[^\s@]+\b/;
const NATIONAL_ID_LIKE = /(?:^|\D)(?:\d{9}|\d{12})(?:\D|$)/;
const REQUIRED_COLUMNS = Object.freeze([
  "source_row_id",
  "uploader_login",
  "project_id",
  "first_work_date",
  "display_name",
  "national_id",
  "provider_type",
  "recruiter_code",
  "labor_type",
  "target_state",
]);
const OPTIONAL_COLUMNS = Object.freeze([
  "gender",
  "date_of_birth_text",
  "national_id_issued_at_text",
  "national_id_issued_place",
  "address",
  "phone",
  "account_number",
  "bank_name",
  "account_holder_name",
  "general_note",
]);
const ALLOWED_COLUMNS = new Set([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);
const TEXT_ONLY_COLUMNS = new Set([
  "source_row_id",
  "uploader_login",
  "project_id",
  "national_id",
  "recruiter_code",
  "phone",
  "account_number",
]);
const GENDER = Object.freeze({ male: "MALE", m: "MALE", nam: "MALE", female: "FEMALE",
  f: "FEMALE", nu: "FEMALE", other: "OTHER", khac: "OTHER" });
const LABOR = Object.freeze({ temporary: "TEMPORARY", thoivu: "TEMPORARY",
  permanent: "PERMANENT", chinhthuc: "PERMANENT", toanthoigian: "PERMANENT" });

export class ImportValidationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "ImportValidationError";
    this.code = code;
    this.details = details;
  }
}

function normalizedHeader(value) {
  return String(value ?? "").normalize("NFC").trim().toLowerCase();
}

function text(value) {
  return String(value ?? "").normalize("NFC").trim();
}

function issue(code, sourceRowId = null, severity = "error") {
  return { code, source_row_id: sourceRowId, severity };
}

function provided(value) {
  return value === "" ? { state: "omitted" } : { state: "provided", value };
}

function dateObjectToIso(value) {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function cellValue(cell, key, rowNumber) {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (key === "first_work_date" || key.endsWith("_text")) return dateObjectToIso(value);
    throw new ImportValidationError("CELL_TYPE_INVALID", { row: rowNumber, field: key });
  }
  if (typeof value === "number") {
    if (TEXT_ONLY_COLUMNS.has(key)) {
      throw new ImportValidationError("IDENTIFIER_MUST_BE_TEXT", { row: rowNumber, field: key });
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") {
    if ("formula" in value || "sharedFormula" in value) {
      throw new ImportValidationError("FORMULA_NOT_ALLOWED", { row: rowNumber, field: key });
    }
    if ("text" in value) return text(value.text);
    if (Array.isArray(value.richText)) return text(value.richText.map((item) => item.text).join(""));
    throw new ImportValidationError("CELL_TYPE_INVALID", { row: rowNumber, field: key });
  }
  return text(value);
}

async function loadWorksheet(inputPath) {
  const extension = path.extname(inputPath).toLowerCase();
  const workbook = new ExcelJS.Workbook();
  if (extension === ".xlsx") await workbook.xlsx.readFile(inputPath);
  else if (extension === ".csv") await workbook.csv.readFile(inputPath);
  else throw new ImportValidationError("INPUT_FORMAT_UNSUPPORTED");
  if (workbook.worksheets.length !== 1) throw new ImportValidationError("INPUT_SHEET_COUNT_INVALID");
  return workbook.worksheets[0];
}

export async function readImportManifest(inputPath) {
  const raw = await readFile(inputPath);
  const fingerprint = createHash("sha256").update(raw).digest("hex");
  const sheet = await loadWorksheet(inputPath);
  const header = new Map();
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, column) => {
    const key = normalizedHeader(cell.value);
    if (!ALLOWED_COLUMNS.has(key)) throw new ImportValidationError("COLUMN_UNKNOWN", { field: key });
    if (header.has(key)) throw new ImportValidationError("COLUMN_DUPLICATE", { field: key });
    header.set(key, column);
  });
  for (const key of REQUIRED_COLUMNS) {
    if (!header.has(key)) throw new ImportValidationError("COLUMN_REQUIRED", { field: key });
  }
  const rows = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    const record = { _source_row_number: rowNumber };
    for (const [key, column] of header) record[key] = cellValue(row.getCell(column), key, rowNumber);
    if (Object.values(record).every((value) => value === "" || typeof value === "number")) continue;
    rows.push(record);
  }
  if (rows.length === 0) throw new ImportValidationError("INPUT_EMPTY");
  return { fingerprint, rows };
}

function normalizeDateText(value) {
  if (value === "") return { raw: "", iso: null };
  const iso = normalizePasteDate(value);
  return { raw: value, iso };
}

function normalizeManifestRow(raw, seenSourceIds, seenNationalIds) {
  const errors = [];
  const warnings = [];
  const sourceRowId = text(raw.source_row_id);
  if (!SAFE_ID.test(sourceRowId)) errors.push(issue("SOURCE_ROW_ID_INVALID", null));
  else if (seenSourceIds.has(sourceRowId)) errors.push(issue("SOURCE_ROW_ID_DUPLICATE", sourceRowId));
  else seenSourceIds.add(sourceRowId);

  const uploaderLogin = text(raw.uploader_login);
  const projectReference = text(raw.project_id);
  const recruiterCode = text(raw.recruiter_code);
  const displayName = text(raw.display_name);
  const nationalId = text(raw.national_id);
  const firstWorkDate = normalizePasteDate(text(raw.first_work_date));
  const providerFolded = foldPasteToken(text(raw.provider_type));
  const providerType = providerFolded === "hrp" ? "hrp"
    : providerFolded === "vendor" ? "vendor" : null;
  const laborRaw = text(raw.labor_type);
  const laborType = LABOR[laborRaw.toLowerCase()] ?? LABOR[foldPasteToken(laborRaw)] ?? null;
  const targetState = text(raw.target_state).toUpperCase();
  const genderRaw = text(raw.gender);
  const gender = genderRaw === "" ? null
    : GENDER[genderRaw.toLowerCase()] ?? GENDER[foldPasteToken(genderRaw)] ?? null;
  const dob = normalizeDateText(text(raw.date_of_birth_text));
  const issuedAt = normalizeDateText(text(raw.national_id_issued_at_text));

  if (uploaderLogin === "") errors.push(issue("UPLOADER_REQUIRED", sourceRowId));
  if (projectReference === "") errors.push(issue("PROJECT_REQUIRED", sourceRowId));
  if (recruiterCode === "") errors.push(issue("RECRUITER_REQUIRED", sourceRowId));
  if (displayName.length < 1 || displayName.length > 256) {
    errors.push(issue("DISPLAY_NAME_INVALID", sourceRowId));
  }
  if (firstWorkDate === null) errors.push(issue("FIRST_WORK_DATE_INVALID", sourceRowId));
  if (!isDigitStringOfLength(nationalId, [9, 12])) {
    errors.push(issue("NATIONAL_ID_INVALID", sourceRowId));
  } else if (seenNationalIds.has(nationalId)) {
    errors.push(issue("NATIONAL_ID_DUPLICATE_IN_BATCH", sourceRowId));
  } else seenNationalIds.add(nationalId);
  if (providerType === null) errors.push(issue("PROVIDER_TYPE_INVALID", sourceRowId));
  if (laborType === null) errors.push(issue("LABOR_TYPE_INVALID", sourceRowId));
  if (!new Set(["DRAFT", "SUBMITTED"]).has(targetState)) {
    errors.push(issue("TARGET_STATE_INVALID", sourceRowId));
  }
  if (genderRaw !== "" && gender === null) errors.push(issue("GENDER_INVALID", sourceRowId));
  if (dob.raw !== "" && dob.iso === null) errors.push(issue("DATE_OF_BIRTH_INVALID", sourceRowId));
  if (issuedAt.raw !== "" && issuedAt.iso === null) {
    errors.push(issue("NATIONAL_ID_ISSUED_AT_INVALID", sourceRowId));
  }
  if (text(raw.phone).length > 64) errors.push(issue("PHONE_INVALID", sourceRowId));
  if (text(raw.address).length > 1024) errors.push(issue("ADDRESS_INVALID", sourceRowId));
  if (text(raw.national_id_issued_place).length > 256) {
    errors.push(issue("NATIONAL_ID_ISSUED_PLACE_INVALID", sourceRowId));
  }
  if (text(raw.general_note).length > 4000) errors.push(issue("GENERAL_NOTE_INVALID", sourceRowId));

  if (dob.iso !== null && firstWorkDate !== null) {
    const birthYear = Number(dob.iso.slice(0, 4));
    const workYear = Number(firstWorkDate.slice(0, 4));
    const age = workYear - birthYear - (firstWorkDate.slice(5) < dob.iso.slice(5) ? 1 : 0);
    if (age < 15 || age > 80) warnings.push(issue("AGE_REQUIRES_OWNER_REVIEW", sourceRowId, "warning"));
  }

  const paymentInput = {
    account_number: provided(text(raw.account_number)),
    bank_name: provided(text(raw.bank_name)),
    account_holder_name: provided(text(raw.account_holder_name)),
  };
  const payment = buildAccountMetadata(paymentInput);
  if (payment === null && Object.values(paymentInput).some((item) => item.state === "provided")) {
    errors.push(issue("ACCOUNT_METADATA_INVALID", sourceRowId));
  }

  return {
    row: {
      sourceRowId,
      uploaderLogin,
      projectReference,
      recruiterCode,
      providerType,
      targetState,
      firstWorkDate,
      payload: {
        project_id: null,
        first_work_date: firstWorkDate,
        provider_type: providerType,
        recruiter_id: null,
        labor_type: laborType,
        display_name: displayName,
        worker_details: {
          gender: gender === null ? { state: "omitted" } : { state: "provided", value: gender },
          date_of_birth: provided(dob.raw),
          national_id: provided(nationalId),
          national_id_issued_at: provided(issuedAt.raw),
          national_id_issued_place: provided(text(raw.national_id_issued_place)),
          address: provided(text(raw.address)),
          phone: provided(text(raw.phone)),
        },
        general_note: provided(text(raw.general_note)),
        payment,
        employment: null,
      },
      nationalId,
    },
    errors,
    warnings,
  };
}

export function validateManifestRows(rawRows) {
  const rows = [];
  const errors = [];
  const warnings = [];
  const seenSourceIds = new Set();
  const seenNationalIds = new Set();
  for (const raw of rawRows) {
    const result = normalizeManifestRow(raw, seenSourceIds, seenNationalIds);
    rows.push(result.row);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }
  return { rows, errors, warnings };
}

export function validateOperatorOptions(options) {
  const problems = [];
  if (!new Set(["check", "apply"]).has(options.mode)) problems.push("MODE_INVALID");
  if (!SAFE_ID.test(options.batchId ?? "") || (options.batchId ?? "").length < 12) {
    problems.push("BATCH_ID_INVALID");
  }
  const operator = text(options.operator);
  if (operator === "" || operator.length > 320) problems.push("OPERATOR_INVALID");
  const reason = text(options.reason);
  if (reason.length < 8 || reason.length > 400 || /[\u0000-\u001f\u007f]/.test(reason)
      || EMAIL_LIKE.test(reason) || NATIONAL_ID_LIKE.test(reason)) {
    problems.push("REASON_INVALID");
  }
  return { ok: problems.length === 0, problems, operator, reason };
}

export function confirmationToken(fingerprint) {
  if (!SHA256.test(fingerprint)) throw new ImportValidationError("FINGERPRINT_INVALID");
  return IMPORT_CONFIRM_PREFIX + fingerprint;
}

export function deterministicUuid(seed) {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function safeManifestSummary(rows, errors = [], warnings = []) {
  const dates = rows.map((row) => row.firstWorkDate).filter(Boolean).sort();
  const count = (key, value) => rows.filter((row) => row[key] === value).length;
  return {
    rows: rows.length,
    valid_rows: Math.max(0, rows.length - new Set(errors.map((item) => item.source_row_id).filter(Boolean)).size),
    error_count: errors.length,
    warning_count: warnings.length,
    uploader_count: new Set(rows.map((row) => row.uploaderLogin)).size,
    project_reference_count: new Set(rows.map((row) => row.projectReference)).size,
    recruiter_reference_count: new Set(rows.map((row) => `${row.providerType}:${row.recruiterCode}`)).size,
    provider: { hrp: count("providerType", "hrp"), vendor: count("providerType", "vendor") },
    target_state: { draft: count("targetState", "DRAFT"), submitted: count("targetState", "SUBMITTED") },
    first_work_date: { min: dates[0] ?? null, max: dates.at(-1) ?? null },
  };
}

export async function checkMigrationLedger(client, migrationsDirectory) {
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const local = new Map();
  for (const name of names) {
    const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
    local.set(name, migrationChecksum(sql));
  }
  const result = await client.query("select version, checksum from public.schema_migrations order by version");
  let mismatches = 0;
  for (const row of result.rows) {
    if (!local.has(row.version) || local.get(row.version) !== row.checksum) mismatches += 1;
  }
  return { local: names.length, applied: result.rows.length, pending: names.length - result.rows.length, mismatches };
}

const ACCOUNT_SQL = `
select u.app_user_id::text, u.auth_subject::text
  from public.direct_entry_app_users u
  join auth.users a on a.id = u.auth_subject
 where u.enabled
   and (lower(coalesce(a.email, '')) = lower($1)
        or u.app_user_id::text = $1 or u.auth_subject::text = $1)`;

async function resolveAccount(client, login) {
  const result = await client.query(ACCOUNT_SQL, [login]);
  return result.rows.length === 1 ? result.rows[0] : null;
}

async function currentGrants(client, appUserId) {
  const result = await client.query(`
    select
      coalesce((select array_agg(distinct c.capability)
        from public.direct_entry_capability_grants c
        where c.app_user_id = $1 and c.valid_from <= public.direct_entry_authorization_date()
          and (c.valid_to is null or public.direct_entry_authorization_date() < c.valid_to)), '{}')
        as capabilities,
      coalesce((select array_agg(distinct s.scope_kind)
        from public.direct_entry_scope_grants s
        where s.app_user_id = $1 and s.valid_from <= public.direct_entry_authorization_date()
          and (s.valid_to is null or public.direct_entry_authorization_date() < s.valid_to)), '{}')
        as scopes,
      (select count(*)::integer from public.direct_entry_scope_grants s
        where s.app_user_id = $1 and s.scope_kind = 'own'
          and s.valid_from <= public.direct_entry_authorization_date()
          and (s.valid_to is null or public.direct_entry_authorization_date() < s.valid_to))
        as own_scope_count`, [appUserId]);
  return result.rows[0];
}

export async function resolveImportAuthority(client, operatorLogin, uploaderLogins, rows) {
  const errors = [];
  const operator = await resolveAccount(client, operatorLogin);
  if (operator === null) return { operator: null, uploaders: new Map(), errors: [issue("OPERATOR_NOT_FOUND")] };
  const operatorGrants = await currentGrants(client, operator.app_user_id);
  if (!operatorGrants.capabilities.includes("entry_admin") || !operatorGrants.scopes.includes("all")) {
    errors.push(issue("OPERATOR_NOT_AUTHORIZED"));
  }
  const uploaders = new Map();
  for (const login of [...new Set(uploaderLogins)]) {
    const account = await resolveAccount(client, login);
    if (account === null) {
      for (const row of rows.filter((item) => item.uploaderLogin === login)) {
        errors.push(issue("UPLOADER_NOT_FOUND", row.sourceRowId));
      }
      continue;
    }
    const grants = await currentGrants(client, account.app_user_id);
    uploaders.set(login, { ...account, grants });
  }
  return { operator: { ...operator, grants: operatorGrants }, uploaders, errors };
}

function resolveUnique(items, predicate) {
  const matches = items.filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}

export async function preflightDatabase(client, manifestRows, authority) {
  const errors = [...authority.errors];
  const warnings = [];
  if (authority.operator === null) return { rows: manifestRows, errors, warnings, cutoff: null };
  const dateResult = await client.query(`select public.direct_entry_authorization_date()::text as auth_date,
    public.direct_entry_reporting_cutoff()::text as cutoff_date`);
  const authDate = dateResult.rows[0].auth_date;
  const cutoff = dateResult.rows[0].cutoff_date;
  const resolved = [];
  const catalogByUploader = new Map();

  for (const [login, uploader] of authority.uploaders) {
    const required = new Set(["entry_create", "submission_create"]);
    const uploaderRows = manifestRows.filter((row) => row.uploaderLogin === login);
    if (uploaderRows.some((row) => row.payload.payment !== null)) {
      required.add("payment_view");
      required.add("payment_edit");
    }
    for (const capability of required) {
      if (!uploader.grants.capabilities.includes(capability)) {
        for (const row of uploaderRows) errors.push(issue("UPLOADER_CAPABILITY_MISSING", row.sourceRowId));
        break;
      }
    }
    if (Number(uploader.grants.own_scope_count) !== 1) {
      for (const row of uploaderRows) errors.push(issue("UPLOADER_OWN_SCOPE_MISSING", row.sourceRowId));
    }
    try {
      const result = await client.query(
        "select public.direct_entry_input_catalog($1::uuid,$2::uuid,$3::date) as catalog",
        [uploader.auth_subject, uploader.app_user_id, authDate],
      );
      catalogByUploader.set(login, result.rows[0].catalog);
    } catch {
      for (const row of uploaderRows) errors.push(issue("UPLOADER_CATALOG_UNAVAILABLE", row.sourceRowId));
    }
  }

  for (const row of manifestRows) {
    const uploader = authority.uploaders.get(row.uploaderLogin);
    const catalog = catalogByUploader.get(row.uploaderLogin);
    if (!uploader || !catalog) continue;
    const projectRef = row.projectReference.normalize("NFC").trim();
    const projectFold = projectRef.toLocaleLowerCase("vi");
    const project = resolveUnique(catalog.projects ?? [], (item) =>
      item.project_id === projectRef || String(item.display_name).normalize("NFC").trim().toLocaleLowerCase("vi") === projectFold);
    const codeFold = row.recruiterCode.toLocaleLowerCase("vi");
    const recruiter = resolveUnique(catalog.recruiters ?? [], (item) => {
      if (item.provider_type !== row.providerType) return false;
      const code = row.providerType === "hrp" ? item.personnel_code : item.vendor_id;
      return typeof code === "string" && code.toLocaleLowerCase("vi") === codeFold;
    });
    if (project === null) errors.push(issue("PROJECT_UNRESOLVED", row.sourceRowId));
    if (recruiter === null) errors.push(issue("RECRUITER_UNRESOLVED", row.sourceRowId));
    if (row.firstWorkDate !== null && row.firstWorkDate < cutoff) {
      errors.push(issue("REPORTING_CUTOFF_VIOLATION", row.sourceRowId));
    }
    if (project !== null && recruiter !== null) {
      resolved.push({
        ...row,
        uploader,
        projectId: project.project_id,
        recruiterId: recruiter.recruiter_id,
        payload: { ...row.payload, project_id: project.project_id, recruiter_id: recruiter.recruiter_id },
      });
    }
  }

  if (resolved.length > 0) {
    const evidence = resolved.map((row) => ({
      source_row_id: row.sourceRowId,
      uploader_id: row.uploader.app_user_id,
      project_id: row.projectId,
      recruiter_id: row.recruiterId,
      first_work_date: row.firstWorkDate,
      provider_type: row.providerType,
      national_id: row.nationalId,
    }));
    const result = await client.query(`
      with input as (
        select * from jsonb_to_recordset($1::jsonb) as x(
          source_row_id text, uploader_id uuid, project_id text, recruiter_id uuid,
          first_work_date date, provider_type text, national_id text)
      )
      select i.source_row_id,
        exists (
          select 1 from public.direct_entry_project_manager_assignments a
          join public.direct_entry_app_user_recruiter_links l
            on l.recruiter_id = a.manager_recruiter_id and l.app_user_id = i.uploader_id
           and l.verified and l.valid_from <= public.direct_entry_authorization_date()
           and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
          where a.project_id = i.project_id
            and (not (to_jsonb(a) ? 'valid_from')
              or (to_jsonb(a)->>'valid_from')::date <= public.direct_entry_authorization_date())
            and (not (to_jsonb(a) ? 'valid_to') or to_jsonb(a)->>'valid_to' is null
              or public.direct_entry_authorization_date() < (to_jsonb(a)->>'valid_to')::date)
        ) as is_project_manager,
        (select count(*) from public.recruiter_aliases a
          where a.recruiter_id = i.recruiter_id and a.valid_from <= i.first_work_date
            and (a.valid_to is null or i.first_work_date < a.valid_to)) as alias_count,
        (select count(*) from public.recruiter_provider_memberships m
          where m.recruiter_id = i.recruiter_id and m.provider_type = i.provider_type
            and m.valid_from <= i.first_work_date
            and (m.valid_to is null or i.first_work_date < m.valid_to)) as provider_count,
        exists (select 1 from public.direct_entries e
          where e.worker_details->'national_id'->>'state' = 'provided'
            and btrim(e.worker_details->'national_id'->>'value') = btrim(i.national_id)) as duplicate_national_id
      from input i`, [JSON.stringify(evidence)]);
    for (const item of result.rows) {
      if (!item.is_project_manager) errors.push(issue("UPLOADER_NOT_PROJECT_MANAGER", item.source_row_id));
      if (Number(item.alias_count) !== 1) errors.push(issue("REPORTING_ALIAS_INVALID", item.source_row_id));
      if (Number(item.provider_count) !== 1) errors.push(issue("REPORTING_PROVIDER_INVALID", item.source_row_id));
      if (item.duplicate_national_id) errors.push(issue("NATIONAL_ID_ALREADY_EXISTS", item.source_row_id));
    }
  }
  return { rows: resolved, errors, warnings, cutoff };
}

export function buildImportPlan(rows, batchId) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.uploader.app_user_id}:${row.targetState}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const chunks = [];
  for (const [key, items] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    for (let offset = 0; offset < items.length; offset += IMPORT_MAX_ROWS_PER_SUBMISSION) {
      const rowsInChunk = items.slice(offset, offset + IMPORT_MAX_ROWS_PER_SUBMISSION);
      const index = offset / IMPORT_MAX_ROWS_PER_SUBMISSION;
      chunks.push({
        uploader: rowsInChunk[0].uploader,
        targetState: rowsInChunk[0].targetState,
        rows: rowsInChunk,
        createKey: deterministicUuid(`${batchId}:create:${key}:${index}`),
        transitionKey: deterministicUuid(`${batchId}:submit:${key}:${index}`),
      });
    }
  }
  return chunks;
}

export async function executeImportPlan(client, chunks, context) {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [context.batchId]);
  const priorAudit = await client.query(`select count(*)::integer as count,
      coalesce(bool_and(position($4 in r.reason_text) > 0), false) as fingerprint_matches
    from public.direct_entry_audit_events a
    left join public.direct_entry_restricted_reasons r on r.reason_id = a.reason_id
    where a.app_user_id = $1 and a.action = $2 and a.resource_ref = $3`, [
    context.operator.app_user_id, IMPORT_ACTION, context.batchId, `sha256=${context.fingerprint}`,
  ]);
  if (Number(priorAudit.rows[0].count) > 0 && !priorAudit.rows[0].fingerprint_matches) {
    throw new ImportValidationError("BATCH_ID_REUSED_WITH_DIFFERENT_SOURCE");
  }
  const entryIds = [];
  const submissionIds = [];
  let replayedChunks = 0;
  for (const chunk of chunks) {
    const created = await client.query(`select public.direct_entry_create_full_profile_batch_v2(
      $1::uuid,$2::uuid,'worker-profile/1.1',$3::jsonb,$4::text) as result`, [
      chunk.uploader.auth_subject,
      chunk.uploader.app_user_id,
      JSON.stringify(chunk.rows.map((row) => row.payload)),
      chunk.createKey,
    ]);
    const result = created.rows[0]?.result;
    if (!result || !Array.isArray(result.entry_ids) || typeof result.submission_id !== "string") {
      throw new ImportValidationError("RPC_RESULT_INVALID");
    }
    if (result.replayed === true) replayedChunks += 1;
    entryIds.push(...result.entry_ids);
    submissionIds.push(result.submission_id);
    if (chunk.targetState === "SUBMITTED") {
      await client.query(`select public.direct_entry_transition_submission(
        $1::uuid,$2::uuid,$3::uuid,$4::integer,'SUBMITTED',$5::text) as result`, [
        chunk.uploader.auth_subject,
        chunk.uploader.app_user_id,
        result.submission_id,
        result.version,
        chunk.transitionKey,
      ]);
    }
  }

  if (Number(priorAudit.rows[0].count) === 0) {
    const reasonText = `${context.reason} [batch=${context.batchId}; sha256=${context.fingerprint}]`;
    const reason = await client.query("select public.direct_entry_reason($1::uuid,$2::text) as reason_id", [
      context.operator.app_user_id, reasonText,
    ]);
    await client.query(`insert into public.direct_entry_audit_events(
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, reason_id, changed_fields
    ) values ($1::uuid,$2::uuid,$3,'entry_admin',$4,'all','APPLIED',$5::uuid,$6::text[])`, [
      context.operator.auth_subject,
      context.operator.app_user_id,
      IMPORT_ACTION,
      context.batchId,
      reason.rows[0].reason_id,
      ["submissions_created", "entries_created", "delegated_uploader_preserved"],
    ]);
  }
  return { entryIds, submissionIds, replayedChunks };
}

export async function postcheckImport(client, execution, expectedRows, context) {
  const result = await client.query(`
    with selected as (
      select e.entry_id, e.submission_id, e.project_id, e.provider_type, e.recruiter_id, s.state
      from public.direct_entries e
      join public.direct_entry_submissions s on s.submission_id = e.submission_id
      where e.entry_id = any($1::uuid[]) and e.deleted_at is null
    ), facts as (
      select f.entry_id, f.recruiter_key, f.provider_type_key
      from public.direct_entry_reporting_facts_v01 f where f.entry_id = any($1::uuid[])
    )
    select
      (select count(*) from selected)::integer as entry_count,
      (select count(distinct submission_id) from selected)::integer as submission_count,
      (select count(*) from selected where state = 'DRAFT')::integer as draft_count,
      (select count(*) from selected where state = 'SUBMITTED')::integer as submitted_count,
      (select count(*) from selected where provider_type = 'hrp')::integer as hrp_count,
      (select count(*) from selected where provider_type = 'vendor')::integer as vendor_count,
      (select count(*) from facts)::integer as reporting_fact_count,
      (select coalesce(jsonb_agg(n order by n), '[]'::jsonb) from
        (select count(*)::integer n from selected group by project_id) x) as project_group_counts,
      (select coalesce(jsonb_agg(n order by n), '[]'::jsonb) from
        (select count(*)::integer n from selected group by recruiter_id) x) as recruiter_group_counts,
      (select count(*) from facts where recruiter_key in ('__unknown__','__invalid__'))::integer
        as recruiter_unknown_count,
      (select count(*) from facts where provider_type_key in ('__unknown__','__invalid__'))::integer
        as provider_unknown_count,
      (select count(*) from public.direct_entry_audit_events
        where app_user_id = $2 and action = $3 and resource_ref = $4)::integer as operator_audit_count`, [
    execution.entryIds, context.operator.app_user_id, IMPORT_ACTION, context.batchId,
  ]);
  const actual = result.rows[0];
  const expected = {
    entries: expectedRows.length,
    submissions: execution.submissionIds.length,
    draft: expectedRows.filter((row) => row.targetState === "DRAFT").length,
    submitted: expectedRows.filter((row) => row.targetState === "SUBMITTED").length,
    hrp: expectedRows.filter((row) => row.providerType === "hrp").length,
    vendor: expectedRows.filter((row) => row.providerType === "vendor").length,
  };
  const ok = Number(actual.entry_count) === expected.entries
    && Number(actual.submission_count) === expected.submissions
    && Number(actual.draft_count) === expected.draft
    && Number(actual.submitted_count) === expected.submitted
    && Number(actual.hrp_count) === expected.hrp
    && Number(actual.vendor_count) === expected.vendor
    && Number(actual.reporting_fact_count) === expected.submitted
    && Number(actual.recruiter_unknown_count) === 0
    && Number(actual.provider_unknown_count) === 0
    && Number(actual.operator_audit_count) === 1;
  return {
    ok,
    entry_count: Number(actual.entry_count),
    submission_count: Number(actual.submission_count),
    state: { draft: Number(actual.draft_count), submitted: Number(actual.submitted_count) },
    provider: { hrp: Number(actual.hrp_count), vendor: Number(actual.vendor_count) },
    project_group_counts: actual.project_group_counts,
    recruiter_group_counts: actual.recruiter_group_counts,
    reporting_unknown: {
      fact_count: Number(actual.reporting_fact_count),
      recruiter: Number(actual.recruiter_unknown_count),
      provider: Number(actual.provider_unknown_count),
    },
    operator_audit_count: Number(actual.operator_audit_count),
    replayed_chunks: execution.replayedChunks,
  };
}

export function sanitizedIssues(items) {
  return items.map((item) => ({ code: item.code, source_row_id: item.source_row_id }));
}
