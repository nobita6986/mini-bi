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

/**
 * Loi chi tiet cho preview: `column` la so thu tu cot 1..6 trong khoi dan,
 * null khi loi o muc ca dong. `parseExcelPaste` giu nguyen shape cu (chi line/message).
 */
export type ExcelPasteReportError = { line: number; column: number | null; message: string };

/** Ket qua day du: dong hop le VA loi cua tung dong (khong dung lai buoc preview). */
export type ExcelPasteReport = { rows: ExcelPasteParsedRow[]; errors: ExcelPasteReportError[] };

const HEADER_TOKENS = [
  ["ma nld", "employee code", "employee_code", "manv"],
  ["ngay dau tien di lam", "ngay bat dau lam viec", "first work date", "first_work_date", "ngaybd"],
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

/** Cac chi so cot 1..6 cua khoi dan (dung cho preview va thong bao loi). */
export const EXCEL_PASTE_COLUMN_CODES = {
  employeeCode: 1,
  firstWorkDate: 2,
  workerName: 3,
  project: 4,
  recruiter: 5,
  laborType: 6,
} as const;

/**
 * Parse day du: tra ve ca dong hop le lan loi tung dong de UI hien preview mot lan.
 * Khong nem loi, khong evaluate formula, khong goi API.
 */
export function parseExcelPasteReport(text: string): ExcelPasteReport {
  const lines = splitLines(text);
  const errors: ExcelPasteReportError[] = [];
  const rows: ExcelPasteParsedRow[] = [];
  let lineNumber = 0;
  let headerSkipped = false;
  for (const raw of lines) {
    lineNumber += 1;
    if (raw.trim() === "") continue;
    const cells = raw.split("\t").map((cell) => cell.trim());
    if (!headerSkipped && isHeaderRow(cells)) { headerSkipped = true; continue; }
    headerSkipped = true;
    if (cells.length !== EXCEL_PASTE_COLUMN_COUNT) {
      errors.push({ line: lineNumber, column: null,
        message: "Dòng phải có đúng 6 cột (mã NLĐ, ngày, họ tên, dự án, người tuyển, loại hình)." });
      continue;
    }
    if (rows.length >= EXCEL_PASTE_MAX_ROWS) {
      errors.push({ line: lineNumber, column: null, message: "Mỗi lần dán tối đa 100 dòng." });
      continue;
    }
    const [employeeCode, firstWorkDate, displayName, project, recruiter, laborType] = cells;
    const normalizedCode = employeeCode.trim();
    const normalizedDate = normalizeDate(firstWorkDate);
    const normalizedLabor = normalizeLaborType(laborType);
    if (normalizedCode === "") {
      errors.push({ line: lineNumber, column: EXCEL_PASTE_COLUMN_CODES.employeeCode,
        message: "Mã NLĐ không được để trống." });
      continue;
    }
    if (normalizedDate === null) {
      errors.push({ line: lineNumber, column: EXCEL_PASTE_COLUMN_CODES.firstWorkDate,
        message: "Ngày đầu tiên đi làm phải là yyyy-mm-dd hoặc dd/mm/yyyy hợp lệ." });
      continue;
    }
    if (normalizedLabor === null) {
      errors.push({ line: lineNumber, column: EXCEL_PASTE_COLUMN_CODES.laborType,
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
  const seen = new Map<string, number>();
  for (const row of rows) {
    const previous = seen.get(row.employee_code);
    if (previous !== undefined) {
      errors.push({ line: row.line, column: EXCEL_PASTE_COLUMN_CODES.employeeCode,
        message: "Mã NLĐ trùng với dòng " + previous + "." });
    } else {
      seen.set(row.employee_code, row.line);
    }
  }
  if (rows.length === 0 && errors.length === 0) {
    errors.push({ line: 0, column: null, message: "Chưa có dòng dữ liệu nào để dán." });
  }
  return { rows, errors };
}

export function parseExcelPaste(text: string): ExcelPasteParseResult {
  const report = parseExcelPasteReport(text);
  return report.errors.length > 0
    ? { ok: false, errors: report.errors.map(({ line, message }) => ({ line, message })) }
    : { ok: true, rows: report.rows };
}
