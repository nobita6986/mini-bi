/**
 * P1.6-I04C3 - Pure parser cho "Dan tu Excel".
 *
 * Parse tab/newline tu clipboard Excel sang cac dong de xuat; KHONG evaluate formula, KHONG goi
 * mutation API, KHONG resolve catalog o day (project/recruiter duoc resolve o tang UI theo
 * first_work_date). Server van la authority cua batch; day chi la buoc nhap du lieu.
 */
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";

export const EXCEL_PASTE_MAX_ROWS = 100;
export const EXCEL_PASTE_COLUMN_COUNT = 6;

export const LABOR_TYPE_ALIASES: Readonly<Record<string, "TEMPORARY" | "PERMANENT">> = Object.freeze({
  temporary: "TEMPORARY",
  permanent: "PERMANENT",
  "thời vụ": "TEMPORARY",
  "toàn thời gian": "PERMANENT",
});

export type ExcelPasteParsedRow = {
  line: number;
  employee_code: string;
  first_work_date: string;
  worker_display_name: string;
  project: string;
  recruiter: string;
  labor_type: "TEMPORARY" | "PERMANENT";
};

export type ExcelPasteRowError = { line: number; message: string };

export type ExcelPasteParseResult =
  | { ok: true; rows: ExcelPasteParsedRow[] }
  | { ok: false; errors: ExcelPasteRowError[] };

const HEADER_TOKENS = [
  ["ma nld", "employee code", "employee_code", "manv"],
  ["ngay dau tien di lam", "first work date", "first_work_date", "ngaybd"],
  ["ho ten", "display name", "display_name", "hoten", "ten nld"],
  ["du an", "project", "project_id"],
  ["nguoi tuyen", "recruiter", "recruiter_id"],
  ["loai hinh lao dong", "labor type", "labor_type"],
];

function normalizeToken(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]/g, "");
}

function isHeaderRow(cells: readonly string[]): boolean {
  if (cells.length !== EXCEL_PASTE_COLUMN_COUNT) return false;
  return cells.every((cell, index) =>
    HEADER_TOKENS[index].some((token) => normalizeToken(token) === normalizeToken(cell)));
}

function normalizeDate(value: string): string | null {
  const trimmed = value.trim();
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(trimmed)) {
    return isRealCalendarDate(trimmed) ? trimmed : null;
  }
  const m = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/.exec(trimmed);
  if (m) {
    const day = String(Number(m[1])).padStart(2, "0");
    const month = String(Number(m[2])).padStart(2, "0");
    const normalized = m[3] + "-" + month + "-" + day;
    return isRealCalendarDate(normalized) ? normalized : null;
  }
  return null;
}

function normalizeLaborType(value: string): "TEMPORARY" | "PERMANENT" | null {
  const lower = value.trim().toLowerCase();
  return LABOR_TYPE_ALIASES[lower] ?? (LABOR_TYPE_ALIASES[normalizeToken(value)] ?? null);
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

export function parseExcelPaste(text: string): ExcelPasteParseResult {
  const lines = splitLines(text);
  const errors = [];
  const rows = [];
  let lineNumber = 0;
  let headerSkipped = false;
  for (const raw of lines) {
    lineNumber += 1;
    if (raw.trim() === "") continue;
    const cells = raw.split("\t").map((cell) => cell.trim());
    if (!headerSkipped && isHeaderRow(cells)) { headerSkipped = true; continue; }
    headerSkipped = true;
    if (cells.length !== EXCEL_PASTE_COLUMN_COUNT) {
      errors.push({ line: lineNumber,
        message: "Dòng phải có đúng 6 cột (mã NLĐ, ngày, họ tên, dự án, người tuyển, loại hình)." });
      continue;
    }
    if (rows.length >= EXCEL_PASTE_MAX_ROWS) {
      errors.push({ line: lineNumber, message: "Mỗi lần dán tối đa 100 dòng." });
      continue;
    }
    const [employeeCode, firstWorkDate, displayName, project, recruiter, laborType] = cells;
    const normalizedCode = employeeCode.trim();
    const normalizedDate = normalizeDate(firstWorkDate);
    const normalizedLabor = normalizeLaborType(laborType);
    if (normalizedCode === "") {
      errors.push({ line: lineNumber, message: "Mã NLĐ không được để trống." });
      continue;
    }
    if (normalizedDate === null) {
      errors.push({ line: lineNumber,
        message: "Ngày đầu tiên đi làm phải là yyyy-mm-dd hoặc dd/mm/yyyy hợp lệ." });
      continue;
    }
    if (normalizedLabor === null) {
      errors.push({ line: lineNumber,
        message: "Loại hình lao động phải là Thời vụ/TEMPORARY hoặc Toàn thời gian/PERMANENT." });
      continue;
    }
    rows.push({
      line: lineNumber,
      employee_code: normalizedCode,
      first_work_date: normalizedDate,
      worker_display_name: displayName,
      project,
      recruiter,
      labor_type: normalizedLabor,
    });
  }
  const seen = new Map();
  for (const row of rows) {
    const previous = seen.get(row.employee_code);
    if (previous !== undefined) {
      errors.push({ line: row.line, message: "Mã NLĐ trùng với dòng " + previous + "." });
    } else {
      seen.set(row.employee_code, row.line);
    }
  }
  if (rows.length === 0 && errors.length === 0) {
    errors.push({ line: 0, message: "Chưa có dòng dữ liệu nào để dán." });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, rows };
}
