import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { validateEmployeeCode } from "../contracts/direct-entry-v1.ts";

export const WORKER_PROFILE_CONTRACT_VERSION = "worker-profile/1.0" as const;
export const FULL_PROFILE_MAX_ROWS = 100;
export const FULL_PROFILE_MAX_BODY_BYTES = 4 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGITS = /^\d+$/;
const ROOT_KEYS = new Set(["contract_version", "rows"]);
const ROW_KEYS = new Set([
  "project_id", "first_work_date", "employee_code", "recruiter_id", "labor_type",
  "display_name", "worker", "general_note", "payment", "employment",
]);
const WORKER_KEYS = new Set([
  "gender", "date_of_birth", "national_id", "national_id_issued_at",
  "national_id_issued_place", "address", "phone",
]);
const FORBIDDEN_KEYS = new Set([
  "actor", "actor_id", "app_user_id", "auth_subject", "capability", "capabilities",
  "scope", "scope_kind", "scope_team_id", "audit", "audit_event", "revision",
  "revision_id", "state", "entry_id", "submission_id", "candidate_id",
  "provider_type", "team", "team_id", "team_hint", "provider_hint", "row_index",
  "effective_month", "age_years", "payment_state", "bank", "bank_label",
]);

export type OptionalText =
  | { state: "omitted" | "unknown" | "intentionally_blank" }
  | { state: "provided"; value: string };

export type FullProfileRpcRow = {
  project_id: string;
  first_work_date: string;
  employee_code: string;
  recruiter_id: string;
  labor_type: "TEMPORARY" | "PERMANENT";
  display_name: string;
  worker_details: {
    gender: OptionalText;
    date_of_birth: OptionalText;
    national_id: OptionalText;
    national_id_issued_at: OptionalText;
    national_id_issued_place: OptionalText;
    address: OptionalText;
    phone: OptionalText;
  };
  general_note: OptionalText;
  payment: null | {
    state: "omitted" | "unknown" | "intentionally_blank" | "provided";
    account_number?: string | null;
    bank_id?: string;
    bank_name?: string | null;
    account_holder_name?: string | null;
  };
  employment: null | {
    initial_status: "UNCONFIRMED" | "ON" | "OFF";
    leave_date: string | null;
    leave_reason_text: string | null;
  };
};

export type FullProfilePayload = {
  contract_version: typeof WORKER_PROFILE_CONTRACT_VERSION;
  rows: FullProfileRpcRow[];
};

export type ContractIssue = {
  code: string;
  path: string;
};

export type FullProfileParseResult =
  | { ok: true; payload: FullProfilePayload }
  | { ok: false; issues: ContractIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) =>
    FORBIDDEN_KEYS.has(key) || hasForbiddenKey(item)
  );
}

function optionalText(value: unknown, path: string, maxLength: number): {
  value: OptionalText;
  issue?: ContractIssue;
} {
  if (value === undefined) return { value: { state: "omitted" } };
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["state", "value"]))) {
    return { value: { state: "omitted" }, issue: { code: "BATCH_INVALID", path } };
  }
  if (value.state === "omitted" || value.state === "unknown" ||
      value.state === "intentionally_blank") {
    if (Object.hasOwn(value, "value")) {
      return { value: { state: "omitted" }, issue: { code: "BATCH_INVALID", path } };
    }
    return { value: { state: value.state } };
  }
  if (value.state !== "provided" || typeof value.value !== "string" ||
      value.value.length > maxLength) {
    return {
      value: { state: "omitted" },
      issue: {
        code: path.endsWith(".general_note") &&
          typeof value.value === "string" && value.value.length > maxLength
          ? "GENERAL_NOTE_TOO_LONG"
          : "BATCH_INVALID",
        path,
      },
    };
  }
  return { value: { state: "provided", value: value.value } };
}

function optionalDate(
  value: unknown,
  path: string,
): { value: OptionalText; issue?: ContractIssue } {
  const parsed = optionalText(value, path, 10);
  if (parsed.value.state === "provided" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.value.value) ||
        !isRealCalendarDate(parsed.value.value))) {
    return { value: { state: "omitted" }, issue: { code: "PASTE_VALUE_FORMAT", path } };
  }
  return parsed;
}

function normalizeWorker(value: unknown, path: string, issues: ContractIssue[]) {
  const input = value === undefined ? {} : value;
  if (!isRecord(input) || !hasOnlyKeys(input, WORKER_KEYS)) {
    issues.push({ code: "BATCH_INVALID", path });
    return null;
  }
  const gender = optionalText(input.gender, `${path}.gender`, 32);
  const dateOfBirth = optionalDate(input.date_of_birth, `${path}.date_of_birth`);
  const nationalId = optionalText(input.national_id, `${path}.national_id`, 64);
  const issuedAt = optionalDate(input.national_id_issued_at, `${path}.national_id_issued_at`);
  const issuedPlace = optionalText(input.national_id_issued_place, `${path}.national_id_issued_place`, 256);
  const address = optionalText(input.address, `${path}.address`, 1024);
  const phone = optionalText(input.phone, `${path}.phone`, 64);
  for (const parsed of [gender, dateOfBirth, nationalId, issuedAt, issuedPlace, address, phone]) {
    if (parsed.issue) issues.push(parsed.issue);
  }
  if (gender.value.state === "provided" &&
      !["MALE", "FEMALE", "OTHER"].includes(gender.value.value.trim().toUpperCase())) {
    issues.push({ code: "GENDER_VOCABULARY_INVALID", path: `${path}.gender` });
  } else if (gender.value.state === "intentionally_blank") {
    issues.push({ code: "GENDER_VOCABULARY_INVALID", path: `${path}.gender` });
  } else if (gender.value.state === "provided") {
    gender.value = { state: "provided", value: gender.value.value.trim().toUpperCase() };
  }
  if (nationalId.value.state === "provided" &&
      (!DIGITS.test(nationalId.value.value) ||
        ![9, 12].includes(nationalId.value.value.length))) {
    issues.push({ code: "NATIONAL_ID_INVALID", path: `${path}.national_id` });
  }
  if (issuedPlace.value.state === "provided" &&
      issuedPlace.value.value.trim().length === 0) {
    issues.push({ code: "NATIONAL_ID_ISSUED_PLACE_INVALID", path: `${path}.national_id_issued_place` });
  }
  return {
    gender: gender.value,
    date_of_birth: dateOfBirth.value,
    national_id: nationalId.value,
    national_id_issued_at: issuedAt.value,
    national_id_issued_place: issuedPlace.value,
    address: address.value,
    phone: phone.value,
  };
}

function normalizePayment(value: unknown, path: string, issues: ContractIssue[]): FullProfileRpcRow["payment"] {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) ||
      !hasOnlyKeys(value, new Set([
        "state", "account_number", "bank_id", "bank_name", "account_holder_name",
      ])) ||
      !["omitted", "unknown", "intentionally_blank", "provided"].includes(String(value.state))) {
    issues.push({ code: "BATCH_INVALID", path });
    return null;
  }
  const normalizeText = (key: "account_number" | "bank_name" | "account_holder_name",
    maxLength: number): string | null => {
    const field = value[key];
    if (field === undefined || field === null) return null;
    if (typeof field !== "string") {
      issues.push({ code: "PAYMENT_DETAILS_INVALID", path });
      return null;
    }
    const normalized = field.trim();
    if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
      issues.push({ code: "PAYMENT_DETAILS_INVALID", path });
      return null;
    }
    return normalized || null;
  };
  const accountNumber = normalizeText("account_number", 64);
  const bankName = normalizeText("bank_name", 256);
  const accountHolderName = normalizeText("account_holder_name", 256);
  const bankIdValue = value.bank_id;
  const bankId = bankIdValue == null ? null
    : typeof bankIdValue === "string" && CATALOG_ID.test(bankIdValue.trim())
      ? bankIdValue.trim()
      : null;
  if (bankIdValue != null && bankId === null) {
    issues.push({ code: "PAYMENT_DETAILS_INVALID", path });
  }
  const hasMetadata = accountNumber !== null || bankName !== null || accountHolderName !== null;
  if (value.state !== "provided") {
    if (hasMetadata || bankId !== null) issues.push({ code: "PAYMENT_DETAILS_INVALID", path });
    return { state: value.state as "omitted" | "unknown" | "intentionally_blank" };
  }
  if (!hasMetadata) {
    if (bankId !== null) issues.push({ code: "PAYMENT_DETAILS_INVALID", path });
    return { state: "omitted" };
  }
  if (issues.some((issue) => issue.path === path)) return null;
  return {
    state: "provided",
    ...(accountNumber === null ? {} : { account_number: accountNumber }),
    ...(bankId === null ? {} : { bank_id: bankId }),
    ...(bankName === null ? {} : { bank_name: bankName }),
    ...(accountHolderName === null ? {} : { account_holder_name: accountHolderName }),
  };
}

function normalizeEmployment(
  value: unknown,
  path: string,
  issues: ContractIssue[],
): FullProfileRpcRow["employment"] {
  if (value === undefined) return null;
  if (!isRecord(value) ||
      !hasOnlyKeys(value, new Set(["initial_status", "leave_date", "leave_reason_text"])) ||
      !["UNCONFIRMED", "ON", "OFF"].includes(String(value.initial_status))) {
    issues.push({ code: "BATCH_INVALID", path });
    return null;
  }
  const leaveDate = value.leave_date;
  const leaveReason = value.leave_reason_text;
  if (value.initial_status === "OFF") {
    if (typeof leaveDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(leaveDate) ||
        !isRealCalendarDate(leaveDate) || typeof leaveReason !== "string" ||
        leaveReason.trim().length < 1 || leaveReason.length > 4000) {
      issues.push({ code: "OFF_REQUIRES_DATE_AND_REASON", path });
      return null;
    }
  } else if (leaveDate !== undefined || leaveReason !== undefined) {
    issues.push({ code: "BATCH_INVALID", path });
    return null;
  }
  return {
    initial_status: value.initial_status as "UNCONFIRMED" | "ON" | "OFF",
    leave_date: typeof leaveDate === "string" ? leaveDate : null,
    leave_reason_text: typeof leaveReason === "string" ? leaveReason : null,
  };
}

export function parseFullProfilePayload(value: unknown): FullProfileParseResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ROOT_KEYS)) {
    return {
      ok: false,
      issues: [{ code: hasForbiddenKey(value) ? "CLIENT_AUTHORITY_FIELD_FORBIDDEN" : "BATCH_INVALID", path: "body" }],
    };
  }
  if (value.contract_version !== WORKER_PROFILE_CONTRACT_VERSION) {
    return { ok: false, issues: [{ code: "CONTRACT_VERSION_UNSUPPORTED", path: "contract_version" }] };
  }
  if (!Array.isArray(value.rows) || value.rows.length < 1 ||
      value.rows.length > FULL_PROFILE_MAX_ROWS) {
    return { ok: false, issues: [{ code: "BATCH_SIZE_INVALID", path: "rows" }] };
  }

  const issues: ContractIssue[] = [];
  const seenCodes = new Set<string>();
  const rows: FullProfileRpcRow[] = [];
  value.rows.forEach((item, index) => {
    const path = `rows[${index}]`;
    if (!isRecord(item) || !hasOnlyKeys(item, ROW_KEYS)) {
      issues.push({
        code: hasForbiddenKey(item) ? "CLIENT_AUTHORITY_FIELD_FORBIDDEN" : "BATCH_INVALID",
        path,
      });
      return;
    }
    const {
      project_id, first_work_date, employee_code, recruiter_id, labor_type, display_name,
    } = item;
    if (typeof project_id !== "string" || !CATALOG_ID.test(project_id) ||
        typeof recruiter_id !== "string" || !UUID.test(recruiter_id) ||
        typeof first_work_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(first_work_date) ||
        !isRealCalendarDate(first_work_date) ||
        typeof employee_code !== "string" || typeof display_name !== "string" ||
        display_name.trim().length < 1 || display_name.length > 256 ||
        (labor_type !== "TEMPORARY" && labor_type !== "PERMANENT")) {
      issues.push({ code: "BATCH_INVALID", path });
      return;
    }
    const employeeCodeIssue = validateEmployeeCode(employee_code, first_work_date)[0];
    if (employeeCodeIssue) {
      issues.push({ code: employeeCodeIssue.code, path: `${path}.employee_code` });
    }
    if (seenCodes.has(employee_code)) {
      issues.push({ code: "EMPLOYEE_CODE_DUPLICATE", path: `${path}.employee_code` });
    }
    seenCodes.add(employee_code);

    const worker = normalizeWorker(item.worker, `${path}.worker`, issues);
    const generalNote = optionalText(item.general_note, `${path}.general_note`, 4000);
    if (generalNote.issue) issues.push(generalNote.issue);
    if (generalNote.value.state === "unknown" ||
        generalNote.value.state === "intentionally_blank") {
      issues.push({ code: "GENERAL_NOTE_INVALID", path: `${path}.general_note` });
    }
    if (generalNote.value.state === "provided" &&
        generalNote.value.value.trim().length === 0) {
      issues.push({ code: "GENERAL_NOTE_INVALID", path: `${path}.general_note` });
    }
    const payment = normalizePayment(item.payment, `${path}.payment`, issues);
    const employment = normalizeEmployment(item.employment, `${path}.employment`, issues);
    rows.push({
      project_id,
      first_work_date,
      employee_code,
      recruiter_id,
      labor_type,
      display_name,
      worker_details: worker ?? {
        gender: { state: "omitted" },
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        national_id_issued_at: { state: "omitted" },
        national_id_issued_place: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      },
      general_note: generalNote.value,
      payment,
      employment,
    });
  });

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    payload: {
      contract_version: WORKER_PROFILE_CONTRACT_VERSION,
      rows,
    },
  };
}
