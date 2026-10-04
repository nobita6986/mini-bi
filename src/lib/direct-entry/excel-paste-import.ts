/**
 * P1.6-I04C3-R2 - Tang import thuan cho "Dan tu Excel".
 *
 * Khong I/O, khong mutation: catalog duoc truyen vao tu tang UI (moi effective date chi
 * resolve mot lan), preview chi doc du lieu da paste. Server van la authority cua batch.
 *
 * Quy tac match catalog: exact ID hoac exact display label sau khi trim outer whitespace +
 * chuan hoa case. Khong fuzzy-match; thieu hoac nhieu ket qua => loi tai dung dong do.
 * Client khong bao gio tu khai HRP/Vendor/team hay truong authority.
 */
import { validateEmployeeCode } from "../contracts/direct-entry-v1.ts";
import {
  EXCEL_PASTE_COLUMN_CODES,
  parseExcelPasteReport,
  type ExcelPasteParsedRow,
} from "./excel-paste.ts";
import type { LaborType } from "../contracts/direct-entry-v1.ts";

export const PASTE_COLUMN_HEADINGS: readonly string[] = Object.freeze([
  "Mã NLĐ",
  "Ngày bắt đầu làm việc",
  "Họ tên",
  "Dự án",
  "Người tuyển",
  "Loại hình lao động",
]);

export type PasteCatalogOption = { id: string; label: string };

export type PasteCatalog = {
  projects: readonly PasteCatalogOption[];
  recruiters: readonly PasteCatalogOption[];
};

export type PastePreviewIssue = { line: number; column: number | null; message: string };

export type PastePreviewRow = {
  line: number;
  employeeCode: string;
  firstWorkDate: string;
  workerName: string;
  projectText: string;
  recruiterText: string;
  laborType: LaborType;
  projectId: string;
  recruiterId: string;
  issues: PastePreviewIssue[];
};

export type PastePreview = {
  rows: PastePreviewRow[];
  issues: PastePreviewIssue[];
  validCount: number;
  errorCount: number;
  /** Chi bat khi co it nhat mot dong VA khong con loi nao. */
  canSubmit: boolean;
};

/** Chuan hoa doi chieu catalog: chi trim outer whitespace + ha case, khong bo dau. */
export function normalizeCatalogMatchText(value: string): string {
  return value.trim().toLowerCase();
}

export type CatalogMatch =
  | { ok: true; id: string }
  | { ok: false; reason: "EMPTY" | "MISSING" | "AMBIGUOUS" };

/** Exact ID (uu tien) hoac exact label. Khong fuzzy, khong prefix, khong substring. */
export function matchCatalogReference(
  text: string,
  options: readonly PasteCatalogOption[],
): CatalogMatch {
  const needle = normalizeCatalogMatchText(text);
  if (needle === "") return { ok: false, reason: "EMPTY" };
  const byId = options.filter((option) => normalizeCatalogMatchText(option.id) === needle);
  if (byId.length === 1) return { ok: true, id: byId[0].id };
  const byLabel = options.filter((option) => normalizeCatalogMatchText(option.label) === needle);
  if (byLabel.length === 1) return { ok: true, id: byLabel[0].id };
  return { ok: false, reason: byLabel.length === 0 ? "MISSING" : "AMBIGUOUS" };
}

function catalogMessage(kind: "project" | "recruiter", reason: "EMPTY" | "MISSING" | "AMBIGUOUS"):
  string {
  const label = kind === "project" ? "Dự án" : "Người tuyển";
  if (reason === "EMPTY") return label + " không được để trống.";
  if (reason === "AMBIGUOUS") {
    return label + " khớp nhiều mục trong danh mục; hãy dùng đúng mã hoặc tên đầy đủ.";
  }
  return label + " không có trong danh mục của ngày hiệu lực.";
}

const EMPLOYEE_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  EMPLOYEE_CODE_FORMAT: "Mã NLĐ không đúng định dạng.",
  EMPLOYEE_CODE_LEGACY_QUARANTINE: "Mã NLĐ theo định dạng cũ không còn được chấp nhận.",
  EMPLOYEE_CODE_YEAR: "Năm trong mã NLĐ phải khớp năm của ngày bắt đầu làm việc.",
  EMPLOYEE_CODE_DUPLICATE: "Mã NLĐ trùng với một dòng chưa lưu đang có trên trang.",
});

function issue(line: number, column: number | null, message: string): PastePreviewIssue {
  return { line, column, message };
}

/**
 * Dung preview tu text da paste + catalog da tai theo tung effective date.
 * `catalogs` thieu mot ngay => loi o muc dong (khong doan bua).
 */
export function buildPastePreview(input: {
  text: string;
  catalogs: Readonly<Record<string, PasteCatalog>>;
  /** Ma NLĐ cua cac dong CHUA LUU dang co tren trang (khong chi trong khoi vua paste). */
  existingEmployeeCodes?: readonly string[];
}): PastePreview {
  const existingCodes = input.existingEmployeeCodes ?? [];
  const report = parseExcelPasteReport(input.text);
  const issues: PastePreviewIssue[] = report.errors.map((error) =>
    issue(error.line, error.column, error.message));

  const rows: PastePreviewRow[] = [];
  for (const parsed of report.rows) {
    rows.push(projectRow(parsed, input.catalogs, existingCodes, issues));
  }

  const validCount = rows.filter((row) => row.issues.length === 0).length;
  return {
    rows,
    issues,
    validCount,
    errorCount: issues.length,
    canSubmit: rows.length > 0 && issues.length === 0,
  };
}

function projectRow(
  parsed: ExcelPasteParsedRow,
  catalogs: Readonly<Record<string, PasteCatalog>>,
  existingCodes: readonly string[],
  issues: PastePreviewIssue[],
): PastePreviewRow {
  const row: PastePreviewRow = {
    line: parsed.line,
    employeeCode: parsed.employee_code,
    firstWorkDate: parsed.first_work_date,
    workerName: parsed.worker_display_name,
    projectText: parsed.project,
    recruiterText: parsed.recruiter,
    laborType: parsed.labor_type,
    projectId: "",
    recruiterId: "",
    issues: [],
  };
  const add = (column: number | null, message: string) => {
    const entry = issue(parsed.line, column, message);
    row.issues.push(entry);
    issues.push(entry);
  };

  if (row.workerName.trim() === "" || row.workerName.length > 256) {
    add(EXCEL_PASTE_COLUMN_CODES.workerName, "Họ tên không được để trống và tối đa 256 ký tự.");
  }
  for (const problem of validateEmployeeCode(row.employeeCode, row.firstWorkDate, existingCodes)) {
    add(EXCEL_PASTE_COLUMN_CODES.employeeCode,
      EMPLOYEE_CODE_MESSAGES[problem.code] ?? "Mã NLĐ không hợp lệ.");
  }

  const catalog = catalogs[row.firstWorkDate];
  if (!catalog) {
    add(null, "Chưa tải được danh mục dự án/người tuyển cho ngày " + row.firstWorkDate + ".");
    return row;
  }
  const project = matchCatalogReference(row.projectText, catalog.projects);
  if (project.ok) row.projectId = project.id;
  else add(EXCEL_PASTE_COLUMN_CODES.project, catalogMessage("project", project.reason));

  const recruiter = matchCatalogReference(row.recruiterText, catalog.recruiters);
  if (recruiter.ok) row.recruiterId = recruiter.id;
  else add(EXCEL_PASTE_COLUMN_CODES.recruiter, catalogMessage("recruiter", recruiter.reason));

  return row;
}

/** Cac effective date can co catalog de preview dung (moi ngay chi tai mot lan). */
export function requiredCatalogDates(text: string): string[] {
  const dates = new Set<string>();
  for (const row of parseExcelPasteReport(text).rows) dates.add(row.first_work_date);
  return [...dates].sort();
}

/** Dong gui len POST /api/direct-entry/batches - dung contract cua server, khong them field. */
export type PasteBatchRowPayload = {
  project_id: string;
  first_work_date: string;
  employee_code: string;
  worker: {
    display_name: string;
    date_of_birth: { state: "omitted" };
    national_id: { state: "omitted" };
    address: { state: "omitted" };
    phone: { state: "omitted" };
  };
  recruiter_id: string;
  labor_type: LaborType;
};

/**
 * Chi dung payload tu dong da qua preview hop le. Khong truyen actor/role/quyen/scope:
 * server tu resolve actor tu session.
 */
export function buildPasteBatchPayload(rows: readonly PastePreviewRow[]): PasteBatchRowPayload[] {
  return rows.map((row) => ({
    project_id: row.projectId,
    first_work_date: row.firstWorkDate,
    employee_code: row.employeeCode,
    worker: {
      display_name: row.workerName,
      date_of_birth: { state: "omitted" },
      national_id: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
    recruiter_id: row.recruiterId,
    labor_type: row.laborType,
  }));
}
