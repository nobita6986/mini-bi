/**
 * P1.6-I04C3-R3A - Parser thuan cho ho so NLĐ day du (header-based, khong co dinh so cot).
 *
 * Khong I/O, khong mutation, khong resolve catalog (viec do thuoc worker-profile-preview.ts).
 * Khong evaluate cong thuc Excel. Khong dung Number() cho national_id / phone / account_number
 * (giu nguyen so 0 dau).
 *
 * Truong tuy chon vang mat => { state: "omitted" }; module nay KHONG sinh "unknown" hay
 * "intentionally_blank" vi UI chua cho nguoi dung chon ro.
 */
import type { LaborType } from "../contracts/direct-entry-v1.ts";
import {
  foldPasteToken,
  isDigitStringOfLength,
  isFormulaLikeCell,
  normalizePasteDate,
  PASTE_MAX_ROWS,
  splitPasteCells,
  splitPasteLines,
} from "./paste-primitives.ts";
import {
  WORKER_PROFILE_CONTRACT_VERSION,
  issue,
  resolveWorkerProfileHeader,
  workerProfileField,
  type ResolvedColumn,
  type WorkerProfileIssue,
} from "./worker-profile-import-contract.ts";

export { PASTE_MAX_ROWS };

export const GENDER_VALUES = ["MALE", "FEMALE", "OTHER"] as const;
export type Gender = (typeof GENDER_VALUES)[number];

export const EMPLOYMENT_STATUS_VALUES = ["UNCONFIRMED", "ON", "OFF"] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUS_VALUES)[number];

export const NATIONAL_ID_LENGTHS = [9, 12] as const;

export type WorkerProfileOptional<T> =
  | { state: "provided"; value: T }
  | { state: "omitted" };

export type WorkerProfileRow = {
  /** So dong nguon trong khoi dan (1-based, tinh ca dong header). */
  sourceRow: number;
  employee_code: string;
  project_label: string;
  first_work_date: string;
  /** A2: plain string, khong phai OptionalValue. */
  display_name: string;
  recruiter_label: string;
  labor_type: LaborType;
  general_note: WorkerProfileOptional<string>;
  worker: {
    gender: WorkerProfileOptional<Gender>;
    date_of_birth: WorkerProfileOptional<string>;
    national_id: WorkerProfileOptional<string>;
    national_id_issued_at: WorkerProfileOptional<string>;
    national_id_issued_place: WorkerProfileOptional<string>;
    address: WorkerProfileOptional<string>;
    phone: WorkerProfileOptional<string>;
  };
  payment: {
    account_number: WorkerProfileOptional<string>;
    bank_name: WorkerProfileOptional<string>;
    account_holder_name: WorkerProfileOptional<string>;
  };
  employment: {
    initial_status: WorkerProfileOptional<EmploymentStatus>;
    leave_date: WorkerProfileOptional<string>;
    leave_reason_text: WorkerProfileOptional<string>;
  };
  /** Validation-only (D5). KHONG nam trong write model. */
  derived: {
    row_index: number | null;
    effective_month: string;
    age_years: number | null;
    team_hint: string | null;
    provider_hint: string | null;
  };
};

export type WorkerProfileParseResult = {
  contractVersion: string;
  columns: readonly ResolvedColumn[];
  rows: WorkerProfileRow[];
  issues: WorkerProfileIssue[];
  errorCount: number;
  warningCount: number;
  canProceed: boolean;
};

const EMPLOYEE_CODE = /^hrp-[0-9]{4}-[0-9]{6}$/;

// Khoa da duoc fold (bo dau, bo ky tu khong phai chu/so) de tra cuu duoc ca "Thời vụ" lan "thoi vu".
const LABOR_ALIASES: Readonly<Record<string, LaborType>> = Object.freeze({
  temporary: "TEMPORARY",
  thoivu: "TEMPORARY",
  permanent: "PERMANENT",
  toanthoigian: "PERMANENT",
});

const GENDER_ALIASES: Readonly<Record<string, Gender>> = Object.freeze({
  male: "MALE", m: "MALE", nam: "MALE",
  female: "FEMALE", f: "FEMALE", nu: "FEMALE",
  other: "OTHER", khac: "OTHER",
});

const STATUS_ALIASES: Readonly<Record<string, EmploymentStatus>> = Object.freeze({
  unconfirmed: "UNCONFIRMED", chuaxacnhan: "UNCONFIRMED",
  on: "ON", danglam: "ON", danglamviec: "ON",
  off: "OFF", danghi: "OFF", nghiviec: "OFF", danghiviec: "OFF",
});

function omit<T>(): WorkerProfileOptional<T> {
  return { state: "omitted" };
}

function provided<T>(value: T): WorkerProfileOptional<T> {
  return { state: "provided", value };
}

/** Tuoi theo ngay tham chieu (A3): khong dung tuoi da dan lam authority. */
export function deriveAgeYears(dateOfBirth: string, referenceDate: string): number | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dateOfBirth)) return null;
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(referenceDate)) return null;
  const years = Number(referenceDate.slice(0, 4)) - Number(dateOfBirth.slice(0, 4));
  const beforeBirthday = referenceDate.slice(5) < dateOfBirth.slice(5);
  const age = years - (beforeBirthday ? 1 : 0);
  return Number.isSafeInteger(age) && age >= 0 ? age : null;
}

function parseMonthToken(value: string): string | null {
  const iso = /^([0-9]{4})-([0-9]{1,2})$/.exec(value.trim());
  if (iso) {
    const month = Number(iso[2]);
    if (month < 1 || month > 12) return null;
    return iso[1] + "-" + String(month).padStart(2, "0");
  }
  const slash = /^([0-9]{1,2})\/([0-9]{4})$/.exec(value.trim());
  if (slash) {
    const month = Number(slash[1]);
    if (month < 1 || month > 12) return null;
    return slash[2] + "-" + String(month).padStart(2, "0");
  }
  return null;
}

type RowContext = {
  cells: readonly string[];
  columnIndex: ReadonlyMap<string, number>;
  issues: WorkerProfileIssue[];
  sourceRow: number;
};

function rawCell(context: RowContext, key: string): string | undefined {
  const index = context.columnIndex.get(key);
  if (index === undefined) return undefined;
  const value = context.cells[index];
  return value === undefined ? undefined : value.trim();
}

function fail(context: RowContext, code: string, field: string,
  severity: "error" | "warning" = "error"): void {
  context.issues.push(issue(code, severity, context.sourceRow, field));
}

/**
 * Doc mot o tuy chon. Tra ve omitted khi o vang mat/rong.
 * O giong cong thuc bi tu choi voi cot "constrained"; voi cot text tu do thi giu nguyen van ban.
 */
function optionalText(
  context: RowContext,
  key: string,
): WorkerProfileOptional<string> {
  const raw = rawCell(context, key);
  if (raw === undefined || raw === "") return omit<string>();
  const spec = workerProfileField(key);
  if (spec && spec.constrained && isFormulaLikeCell(raw)) {
    fail(context, "PASTE_FORMULA_CELL", key);
    return omit<string>();
  }
  if (spec?.maxLength !== undefined && raw.length > spec.maxLength) {
    fail(context, "PASTE_TEXT_TOO_LONG", key);
    return omit<string>();
  }
  return provided(raw);
}

function requiredText(context: RowContext, key: string): string {
  const raw = rawCell(context, key);
  if (raw === undefined || raw === "") {
    fail(context, "PASTE_VALUE_REQUIRED", key);
    return "";
  }
  const spec = workerProfileField(key);
  if (spec?.constrained === true && isFormulaLikeCell(raw)) {
    // Xu ly nhu TEXT (khong bao gio evaluate) va bao loi: cot nay khong chap nhan van ban do.
    fail(context, "PASTE_FORMULA_CELL", key);
    return raw;
  }
  if (spec?.maxLength !== undefined && raw.length > spec.maxLength) {
    fail(context, "PASTE_TEXT_TOO_LONG", key);
    return "";
  }
  return raw;
}

function optionalDate(context: RowContext, key: string): WorkerProfileOptional<string> {
  const raw = rawCell(context, key);
  if (raw === undefined || raw === "") return omit<string>();
  const spec = workerProfileField(key);
  if (spec?.constrained && isFormulaLikeCell(raw)) {
    fail(context, "PASTE_FORMULA_CELL", key);
    return omit<string>();
  }
  const normalized = normalizePasteDate(raw);
  if (normalized === null) {
    fail(context, "PASTE_DATE_INVALID", key);
    return omit<string>();
  }
  return provided(normalized);
}

function valueOf<T>(target: WorkerProfileOptional<T>): T | null {
  return target.state === "provided" ? target.value : null;
}

function buildRow(
  cells: readonly string[],
  columnIndex: ReadonlyMap<string, number>,
  sourceRow: number,
  referenceDate: string,
): { row: WorkerProfileRow; issues: WorkerProfileIssue[] } {
  const context: RowContext = { cells, columnIndex, issues: [], sourceRow };

  // --- required ---
  const employeeCodeRaw = requiredText(context, "employee_code");
  const projectLabel = requiredText(context, "project_id");
  const recruiterLabel = requiredText(context, "recruiter_id");
  const displayName = requiredText(context, "display_name");
  const startRaw = rawCell(context, "first_work_date");
  const firstWorkDate = startRaw === undefined || startRaw === "" ? "" : startRaw;
  if (firstWorkDate === "") {
    fail(context, "PASTE_VALUE_REQUIRED", "first_work_date");
  } else if (isFormulaLikeCell(firstWorkDate)) {
    fail(context, "PASTE_FORMULA_CELL", "first_work_date");
  }
  const normalizedStart = firstWorkDate === "" ? null : normalizePasteDate(firstWorkDate);
  if (firstWorkDate !== "" && !isFormulaLikeCell(firstWorkDate) && normalizedStart === null) {
    fail(context, "PASTE_DATE_INVALID", "first_work_date");
  }

  if (employeeCodeRaw !== "" && !isFormulaLikeCell(employeeCodeRaw) &&
      !EMPLOYEE_CODE.test(employeeCodeRaw)) {
    fail(context, "PASTE_EMPLOYEE_CODE_FORMAT", "employee_code");
  } else if (employeeCodeRaw !== "" && !isFormulaLikeCell(employeeCodeRaw) &&
      normalizedStart !== null &&
      employeeCodeRaw.slice(4, 8) !== normalizedStart.slice(0, 4)) {
    fail(context, "PASTE_EMPLOYEE_CODE_YEAR", "employee_code");
  }

  const laborRaw = rawCell(context, "labor_type");
  let laborType: LaborType = "TEMPORARY";
  if (laborRaw === undefined || laborRaw === "") {
    fail(context, "PASTE_VALUE_REQUIRED", "labor_type");
  } else if (isFormulaLikeCell(laborRaw)) {
    fail(context, "PASTE_FORMULA_CELL", "labor_type");
  } else {
    const resolved = LABOR_ALIASES[laborRaw.toLowerCase()] ?? LABOR_ALIASES[foldPasteToken(laborRaw)];
    void resolved;
    if (resolved === undefined) fail(context, "PASTE_LABOR_TYPE_INVALID", "labor_type");
    else laborType = resolved;
  }

  // --- optional worker profile ---
  const dob = optionalDate(context, "date_of_birth");
  const issuedAt = optionalDate(context, "national_id_issued_at");
  if (valueOf(dob) !== null && valueOf(dob)! > referenceDate) {
    fail(context, "PASTE_DOB_FUTURE", "date_of_birth");
  }
  if (valueOf(issuedAt) !== null && valueOf(issuedAt)! > referenceDate) {
    fail(context, "PASTE_ISSUED_FUTURE", "national_id_issued_at");
  }
  if (valueOf(dob) !== null && valueOf(issuedAt) !== null &&
      valueOf(issuedAt)! < valueOf(dob)!) {
    fail(context, "PASTE_ISSUED_BEFORE_DOB", "national_id_issued_at");
  }

  const genderRaw = rawCell(context, "gender");
  let gender: WorkerProfileOptional<Gender> = omit<Gender>();
  if (genderRaw !== undefined && genderRaw !== "") {
    if (isFormulaLikeCell(genderRaw)) {
      fail(context, "PASTE_FORMULA_CELL", "gender");
    } else {
      const resolved = GENDER_ALIASES[genderRaw.toLowerCase()] ?? GENDER_ALIASES[foldPasteToken(genderRaw)];
      if (resolved === undefined) fail(context, "PASTE_GENDER_INVALID", "gender");
      else gender = provided(resolved);
    }
  }

  const nationalIdRaw = rawCell(context, "national_id");
  let nationalId: WorkerProfileOptional<string> = omit<string>();
  if (nationalIdRaw !== undefined && nationalIdRaw !== "") {
    if (isFormulaLikeCell(nationalIdRaw)) {
      fail(context, "PASTE_FORMULA_CELL", "national_id");
    } else if (!isDigitStringOfLength(nationalIdRaw, NATIONAL_ID_LENGTHS)) {
      fail(context, "PASTE_NATIONAL_ID_INVALID", "national_id");
    } else {
      nationalId = provided(nationalIdRaw);
    }
  }

  // --- entry note (D13) ---
  const generalNote = optionalText(context, "general_note");

  // --- employment lifecycle (D16) ---
  const statusRaw = rawCell(context, "initial_status");
  let initialStatus: WorkerProfileOptional<EmploymentStatus> = omit<EmploymentStatus>();
  if (statusRaw !== undefined && statusRaw !== "") {
    if (isFormulaLikeCell(statusRaw)) {
      fail(context, "PASTE_FORMULA_CELL", "initial_status");
    } else {
      const resolved = STATUS_ALIASES[statusRaw.toLowerCase()] ?? STATUS_ALIASES[foldPasteToken(statusRaw)];
      if (resolved === undefined) fail(context, "PASTE_STATUS_INVALID", "initial_status");
      else initialStatus = provided(resolved);
    }
  }
  const leaveDate = optionalDate(context, "leave_date");
  const leaveReason = optionalText(context, "leave_reason_text");
  const status = valueOf(initialStatus);
  if (status === "OFF") {
    if (valueOf(leaveDate) === null) fail(context, "PASTE_LEAVE_MISSING", "leave_date");
    if (valueOf(leaveReason) === null) fail(context, "PASTE_LEAVE_REASON_MISSING", "leave_reason_text");
  } else if (valueOf(leaveDate) !== null || valueOf(leaveReason) !== null) {
    fail(context, "PASTE_LEAVE_REQUIRES_OFF", "leave_date");
  }
  if (valueOf(leaveDate) !== null && normalizedStart !== null &&
      valueOf(leaveDate)! < normalizedStart) {
    fail(context, "PASTE_LEAVE_BEFORE_START", "leave_date");
  }

  // --- R4-S02: metadata tai khoan de doi chieu ---
  // Ba cot doc lap, deu optional: nhap mot, hai hoac ca ba deu hop le. Khong tu suy ra payment
  // state, khong doi chieu catalog ngan hang, khong yeu cau bank active.
  const accountNumberRaw = rawCell(context, "account_number");
  let accountNumber: WorkerProfileOptional<string> = omit<string>();
  if (accountNumberRaw !== undefined && accountNumberRaw !== "") {
    if (isFormulaLikeCell(accountNumberRaw)) {
      fail(context, "PASTE_FORMULA_CELL", "account_number");
    } else if (accountNumberRaw.length > 64 || /[\u0000-\u001f\u007f]/.test(accountNumberRaw)) {
      fail(context, "PASTE_ACCOUNT_NUMBER_INVALID", "account_number");
    } else {
      accountNumber = provided(accountNumberRaw);
    }
  }
  const bankName = optionalText(context, "bank_name");
  const accountHolder = optionalText(context, "account_holder_name");

  // --- derived / validation-only (D5): khong vao write model ---
  const indexRaw = rawCell(context, "row_index");
  let rowIndex: number | null = null;
  if (indexRaw !== undefined && indexRaw !== "") {
    if (!/^[0-9]{1,9}$/.test(indexRaw) || Number(indexRaw) < 1) {
      fail(context, "PASTE_DERIVED_INVALID", "row_index", "warning");
    } else {
      rowIndex = Number(indexRaw);
    }
  }
  const derivedMonth = normalizedStart === null ? "" : normalizedStart.slice(0, 7);
  const monthRaw = rawCell(context, "effective_month");
  if (monthRaw !== undefined && monthRaw !== "") {
    const parsedMonth = isFormulaLikeCell(monthRaw) ? null : parseMonthToken(monthRaw);
    if (parsedMonth === null) {
      fail(context, "PASTE_DERIVED_INVALID", "effective_month", "warning");
    } else if (derivedMonth !== "" && parsedMonth !== derivedMonth) {
      fail(context, "PASTE_MONTH_MISMATCH", "effective_month");
    }
  }
  const derivedAge = valueOf(dob) === null ? null : deriveAgeYears(valueOf(dob)!, referenceDate);
  const ageRaw = rawCell(context, "age_years");
  if (ageRaw !== undefined && ageRaw !== "") {
    if (!/^[0-9]{1,3}$/.test(ageRaw)) {
      fail(context, "PASTE_DERIVED_INVALID", "age_years", "warning");
    } else if (derivedAge !== null && Number(ageRaw) !== derivedAge) {
      fail(context, "PASTE_AGE_MISMATCH", "age_years", "warning");
    }
  }
  const teamHint = rawCell(context, "team_hint");
  const providerHint = rawCell(context, "provider_hint");
  if (teamHint !== undefined && teamHint !== "") {
    fail(context, "PASTE_TEAM_CONFIRM", "team_hint", "warning");
  }
  if (providerHint !== undefined && providerHint !== "") {
    fail(context, "PASTE_PROVIDER_CONFIRM", "provider_hint", "warning");
  }

  const row: WorkerProfileRow = {
    sourceRow,
    employee_code: employeeCodeRaw,
    project_label: projectLabel,
    first_work_date: normalizedStart ?? "",
    display_name: displayName,
    recruiter_label: recruiterLabel,
    labor_type: laborType,
    general_note: generalNote,
    worker: {
      gender,
      date_of_birth: dob,
      national_id: nationalId,
      national_id_issued_at: issuedAt,
      national_id_issued_place: optionalText(context, "national_id_issued_place"),
      address: optionalText(context, "address"),
      phone: optionalText(context, "phone"),
    },
    payment: { account_number: accountNumber, bank_name: bankName,
      account_holder_name: accountHolder },
    employment: { initial_status: initialStatus, leave_date: leaveDate,
      leave_reason_text: leaveReason },
    derived: {
      row_index: rowIndex,
      effective_month: derivedMonth,
      age_years: derivedAge,
      team_hint: teamHint === undefined || teamHint === "" ? null : teamHint,
      provider_hint: providerHint === undefined || providerHint === "" ? null : providerHint,
    },
  };
  return { row, issues: context.issues };
}

/**
 * Hinh dang write model phia CLIENT. KHONG phai server DTO: T1B chua chot wrapper day du.
 * Day la guard de cac cot validation-only (STT, Thang, Tuoi, Chi nhanh/Team, HRP/Vendor)
 * khong bao gio lot vao payload.
 */
export type WorkerProfileWriteModel = {
  employee_code: string;
  project_label: string;
  first_work_date: string;
  display_name: string;
  recruiter_label: string;
  labor_type: LaborType;
  general_note: WorkerProfileOptional<string>;
  worker: WorkerProfileRow["worker"];
  payment: WorkerProfileRow["payment"];
  employment: WorkerProfileRow["employment"];
};

export function toWorkerProfileWriteModel(row: WorkerProfileRow): WorkerProfileWriteModel {
  return {
    employee_code: row.employee_code,
    project_label: row.project_label,
    first_work_date: row.first_work_date,
    display_name: row.display_name,
    recruiter_label: row.recruiter_label,
    labor_type: row.labor_type,
    general_note: row.general_note,
    worker: { ...row.worker },
    payment: { ...row.payment },
    employment: { ...row.employment },
  };
}

/**
 * Parse khoi dan ho so day du. Header bat buoc; thu tu cot tuy y; cot tuy chon co the vang mat.
 */
export function parseWorkerProfilePaste(input: {
  text: string;
  referenceDate: string;
}): WorkerProfileParseResult {
  const issues: WorkerProfileIssue[] = [];
  const lines = splitPasteLines(input.text);
  const headerLine = lines.findIndex((line) => line.trim() !== "");
  if (headerLine < 0) {
    issues.push(issue("PASTE_EMPTY", "error", 0, null));
    return { contractVersion: WORKER_PROFILE_CONTRACT_VERSION, columns: [], rows: [],
      issues, errorCount: 1, warningCount: 0, canProceed: false };
  }

  const header = resolveWorkerProfileHeader(splitPasteCells(lines[headerLine]));
  issues.push(...header.issues);
  if (!header.ok) {
    return { contractVersion: WORKER_PROFILE_CONTRACT_VERSION, columns: header.columns, rows: [],
      issues, errorCount: header.issues.length, warningCount: 0, canProceed: false };
  }

  const columnIndex = new Map(header.columns.map((column) => [column.key, column.index]));
  const rows: WorkerProfileRow[] = [];
  let dataRows = 0;
  for (let index = headerLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    dataRows += 1;
    if (dataRows > PASTE_MAX_ROWS) {
      issues.push(issue("PASTE_ROW_LIMIT", "error", index + 1, null));
      continue;
    }
    const cells = splitPasteCells(line);
    if (cells.length > header.columns.length) {
      const extra = cells.slice(header.columns.length);
      if (extra.some((cell) => cell !== "")) {
        issues.push(issue("PASTE_ROW_CELL_COUNT", "error", index + 1, null));
        continue;
      }
    }
    const built = buildRow(cells, columnIndex, index + 1, input.referenceDate);
    rows.push(built.row);
    issues.push(...built.issues);
  }

  if (dataRows === 0) issues.push(issue("PASTE_NO_DATA_ROWS", "error", 0, null));

  const errorCount = issues.filter((item) => item.severity === "error").length;
  const warningCount = issues.filter((item) => item.severity === "warning").length;
  return {
    contractVersion: WORKER_PROFILE_CONTRACT_VERSION,
    columns: header.columns,
    rows,
    issues,
    errorCount,
    warningCount,
    canProceed: errorCount === 0 && rows.length > 0,
  };
}
