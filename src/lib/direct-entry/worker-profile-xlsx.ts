import { DIRECT_ENTRY_GRID_COLUMNS } from "./direct-entry-grid-columns.ts";
import { normalizePasteHeader } from "./paste-primitives.ts";
import { WORKER_PROFILE_FIELDS } from "./worker-profile-import-contract.ts";

export const WORKER_PROFILE_XLSX_CONTRACT = "worker-profile-xlsx/1";
export const WORKER_PROFILE_XLSX_MAX_BYTES = 4 * 1024 * 1024;
export const WORKER_PROFILE_XLSX_MAX_ROWS = 100;

const EMPLOYEE_CODE_HEADERS = new Set(
  WORKER_PROFILE_FIELDS.find((field) => field.key === "employee_code")!.aliases
    .concat(WORKER_PROFILE_FIELDS.find((field) => field.key === "employee_code")!.canonicalHeader)
    .map(normalizePasteHeader),
);
const TEXT_IDENTIFIER_KEYS = new Set(["employee_code", "national_id", "phone", "account_number"]);
const FIELD_BY_HEADER = new Map<string, string>();
for (const field of WORKER_PROFILE_FIELDS) {
  for (const header of [field.canonicalHeader, ...field.aliases]) {
    FIELD_BY_HEADER.set(normalizePasteHeader(header), field.key);
  }
}

export type WorkerProfileXlsxResult =
  | { ok: true; text: string; rowCount: number }
  | { ok: false; code: "XLSX_INVALID" | "XLSX_TOO_LARGE" | "XLSX_ROW_LIMIT" | "XLSX_CELL_UNSUPPORTED" };

function encodeCell(value: unknown, sensitive: boolean): string | null {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    return /[\t\r\n]/.test(value) ? null : value;
  }
  if (typeof value === "number") {
    return !sensitive && Number.isFinite(value) ? String(value) : null;
  }
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(
      value.getUTCDate(),
    ).padStart(2, "0")}`;
  }
  return null;
}

export async function workerProfileXlsxToTsv(file: File): Promise<WorkerProfileXlsxResult> {
  if (!file.name.toLowerCase().endsWith(".xlsx")) return { ok: false, code: "XLSX_INVALID" };
  if (file.size > WORKER_PROFILE_XLSX_MAX_BYTES) return { ok: false, code: "XLSX_TOO_LARGE" };
  try {
    const imported = await import("exceljs");
    const excel = imported.default;
    const workbook = new excel.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const metadata = workbook.getWorksheet("_meta");
    if (metadata && (metadata.getCell("A1").value !== "contract_version" ||
        metadata.getCell("B1").value !== WORKER_PROFILE_XLSX_CONTRACT)) {
      return { ok: false, code: "XLSX_INVALID" };
    }
    const sheet = workbook.getWorksheet("Direct Entry") ?? workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 1) return { ok: false, code: "XLSX_INVALID" };
    if (sheet.rowCount - 1 > WORKER_PROFILE_XLSX_MAX_ROWS) {
      return { ok: false, code: "XLSX_ROW_LIMIT" };
    }

    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    for (let column = 1; column <= headerRow.cellCount; column += 1) {
      const header = encodeCell(headerRow.getCell(column).value, false);
      if (header === null) return { ok: false, code: "XLSX_CELL_UNSUPPORTED" };
      headers.push(header);
    }
    if (headers.length === 0 || headers.every((header) => header.trim() === "")) {
      return { ok: false, code: "XLSX_INVALID" };
    }
    const hasEmployeeCode = headers.some((header) =>
      EMPLOYEE_CODE_HEADERS.has(normalizePasteHeader(header)));
    const sourceHeaders = [...headers];
    const outputHeaders = hasEmployeeCode ? sourceHeaders : ["Mã NLĐ", ...sourceHeaders];
    const matrix = [outputHeaders];
    let dataRows = 0;
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const source: string[] = [];
      let hasValue = false;
      for (let column = 1; column <= sourceHeaders.length; column += 1) {
        const key = FIELD_BY_HEADER.get(normalizePasteHeader(sourceHeaders[column - 1] ?? "")) ?? "";
        const cell = row.getCell(column);
        if (cell.type === excel.ValueType.Formula || cell.type === excel.ValueType.Hyperlink ||
            cell.type === excel.ValueType.Error) {
          return { ok: false, code: "XLSX_CELL_UNSUPPORTED" };
        }
        const value = encodeCell(cell.value, TEXT_IDENTIFIER_KEYS.has(key));
        if (value === null) return { ok: false, code: "XLSX_CELL_UNSUPPORTED" };
        if (value.trim() !== "") hasValue = true;
        source.push(value);
      }
      if (!hasValue) continue;
      dataRows += 1;
      if (dataRows > WORKER_PROFILE_XLSX_MAX_ROWS) {
        return { ok: false, code: "XLSX_ROW_LIMIT" };
      }
      matrix.push(hasEmployeeCode ? source : ["", ...source]);
    }
    return { ok: true, text: matrix.map((row) => row.join("\t")).join("\n"), rowCount: dataRows };
  } catch {
    return { ok: false, code: "XLSX_INVALID" };
  }
}

export async function createWorkerProfileTemplate(): Promise<Uint8Array> {
  const imported = await import("exceljs");
  const excel = imported.default;
  const workbook = new excel.Workbook();
  workbook.creator = "Direct Entry";
  const sheet = workbook.addWorksheet("Direct Entry");
  const headers = DIRECT_ENTRY_GRID_COLUMNS
    .filter((column) => column.pasteMode === "write" || column.key === "employee_code")
    .map((column) => column.contractField?.canonicalHeader ?? column.label);
  sheet.addRow(headers);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (let index = 1; index <= headers.length; index += 1) {
    sheet.getColumn(index).width = 22;
    sheet.getRow(1).getCell(index).font = { bold: true };
  }
  const metadata = workbook.addWorksheet("_meta");
  metadata.state = "veryHidden";
  metadata.addRow(["contract_version", WORKER_PROFILE_XLSX_CONTRACT]);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}
