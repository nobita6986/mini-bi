import { DIRECT_ENTRY_GRID_COLUMNS } from "./direct-entry-grid-columns.ts";
import { normalizePasteHeader } from "./paste-primitives.ts";
import { WORKER_PROFILE_FIELDS } from "./worker-profile-import-contract.ts";

export const WORKER_PROFILE_XLSX_CONTRACT = "worker-profile-xlsx/1";
export const WORKER_PROFILE_XLSX_MAX_BYTES = 4 * 1024 * 1024;
export const WORKER_PROFILE_XLSX_MAX_ROWS = 100;

/**
 * P1.7-H05: 16 data header cho XLSX template va import. Thu tu khoa theo yeu cau
 * production UI; cot STT/Mã NLĐ/Tuổi/status/team/system/UUID deu KHONG xuat hien.
 * Truong STK duoc luu text de giu so 0 dau. Cot `provider_type` HRP/Vendor duoc
 * them vao XLSX (16 headers) de nguoi dung khai ro provider khi can, dong thoi
 * recruiter_id van duoc server resolve theo catalog.
 *
 * P3-W07C-R3: header / thứ tự cột đồng bộ chính xác với parser/importer.
 * Cột `Nơi cấp` (`national_id_issued_place`) đã được bỏ khỏi template mới
 * vì giá trị do server-authoritative migration #46 ghi ("Bộ Công An") tại
 * RPC create-batch; client không cần nhập. KHÔNG còn tương thích ngược với
 * file Excel mẫu cũ (còn cột `Nơi cấp` hoặc cột `Mã NLĐ` ở đầu). Nếu
 * upload file không khớp 16 header theo đúng thứ tự, hệ thống trả lỗi
 * `XLSX_INVALID` rõ ràng.
 */
const XLSX_TEMPLATE_KEYS: readonly string[] = Object.freeze([
  "project_id",
  "provider_type",
  "recruiter_id",
  "labor_type",
  "first_work_date",
  "display_name",
  "gender",
  "date_of_birth",
  "national_id",
  "national_id_issued_at",
  "address",
  "phone",
  "account_number",
  "bank_name",
  "account_holder_name",
  "general_note",
]);

/**
 * P1.7-H05: legacy alias "Toàn thời gian" duoc XLSX import chap nhan (map sang
 * canonical UI value "Chính thức" -> "PERMANENT" server).
 */
const LABOR_TYPE_KEY_BY_HEADER: Readonly<Record<string, "TEMPORARY" | "PERMANENT">> = Object.freeze({
  "Thời vụ": "TEMPORARY",
  "Chính thức": "PERMANENT",
  "Toàn thời gian": "PERMANENT",
});

const TEXT_IDENTIFIER_KEYS = new Set(["employee_code", "national_id", "phone", "account_number"]);
const FIELD_BY_HEADER = new Map<string, string>();
for (const field of WORKER_PROFILE_FIELDS) {
  for (const header of [field.canonicalHeader, ...field.aliases]) {
    FIELD_BY_HEADER.set(normalizePasteHeader(header), field.key);
  }
}
// P1.7-H05: HRP/Vendor là UI-only field trong XLSX; map header "HRP/Vendor" vào
// `provider_type` để import có thể đọc column từ template.
FIELD_BY_HEADER.set(normalizePasteHeader("HRP/Vendor"), "provider_type");

function canonicalHeaderForField(key: string): string | null {
  const field = WORKER_PROFILE_FIELDS.find((candidate) => candidate.key === key);
  return field?.canonicalHeader ?? null;
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
    // P3-W07C-R3: đồng bộ chính xác header với mẫu mới. Không còn tương
    // thích ngược với file Excel mẫu cũ (cột `Nơi cấp` / cột `Mã NLĐ`
    // thừa). Bất kỳ header nào không khớp bộ khóa canonical của template
    // — đặc biệt là `national_id_issued_place` — đều trả lỗi rõ ràng để
    // người dùng tải lại mẫu mới.
    const templateKeys = XLSX_TEMPLATE_KEYS;
    const expectedHeaders = xlsxTemplateHeaders();
    const templateHeaderSet = new Set(expectedHeaders);
    const unknownHeaders = headers.filter((header) =>
      !templateHeaderSet.has(header) && !FIELD_BY_HEADER.has(normalizePasteHeader(header)));
    if (unknownHeaders.length > 0 || headers.length !== templateKeys.length
        || headers.some((header, index) => header !== expectedHeaders[index])) {
      return { ok: false, code: "XLSX_INVALID" };
    }
    const sourceHeaders = [...headers];
    const outputHeaders = [...sourceHeaders];
    const matrix = [outputHeaders];
    let dataRows = 0;
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const source: string[] = [];
      let hasValue = false;
      for (let column = 1; column <= sourceHeaders.length; column += 1) {
        const header = sourceHeaders[column - 1] ?? "";
        const key = FIELD_BY_HEADER.get(normalizePasteHeader(header)) ?? "";
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
      matrix.push(source);
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
  // P1.7-H05: 17 header theo dung thu tu production UI; STK text format de giu so 0.
  const headers = XLSX_TEMPLATE_KEYS.map((key) => {
    if (key === "labor_type") return canonicalHeaderForField(key) ?? key;
    if (key === "gender") return "Giới tính";
    if (key === "recruiter_id") return "Người tuyển / Vendor";
    if (key === "provider_type") return "HRP/Vendor";
    if (key === "address") return "Địa chỉ";
    return canonicalHeaderForField(key) ?? key;
  });
  sheet.addRow(headers);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (let index = 1; index <= headers.length; index += 1) {
    sheet.getColumn(index).width = 22;
    sheet.getRow(1).getCell(index).font = { bold: true };
  }
  // P1.7-H05: STK phai co text format de giu so 0 dau.
  const accountNumberColumn = headers.indexOf("STK") + 1;
  if (accountNumberColumn > 0) {
    sheet.getColumn(accountNumberColumn).numFmt = "@";
  }
  const nationalIdColumn = headers.indexOf("CMT/CCCD") + 1;
  if (nationalIdColumn > 0) {
    sheet.getColumn(nationalIdColumn).numFmt = "@";
  }
  // Data validation cho Gioi tinh, HRP/Vendor va Loai hinh LĐ (dat tren dong vi du
  // de Excel luu).
  const genderColumn = headers.indexOf("Giới tính") + 1;
  if (genderColumn > 0) {
    sheet.getCell(2, genderColumn).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"Nam,Nữ"'],
    };
  }
  const providerColumn = headers.indexOf("HRP/Vendor") + 1;
  if (providerColumn > 0) {
    sheet.getCell(2, providerColumn).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"HRP,Vendor"'],
    };
  }
  const laborTypeColumn = headers.indexOf("Loại hình LĐ") + 1;
  if (laborTypeColumn > 0) {
    sheet.getCell(2, laborTypeColumn).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"Thời vụ,Chính thức"'],
    };
  }
  // Guide sheet ghi ro field bat buoc.
  const guide = workbook.addWorksheet("Hướng dẫn");
  guide.addRow(["Field bắt buộc", "Mô tả"]);
  guide.addRow(["Dự án", "Phải khớp danh mục đang hoạt động cho ngày bắt đầu làm việc"]);
  guide.addRow(["Ngày bắt đầu làm việc", "Định dạng YYYY-MM-DD"]);
  guide.addRow(["Họ và tên", "Bắt buộc"]);
  guide.addRow(["HRP/Vendor (Người tuyển / Vendor)", "Phải là stable ID ứng với recruiter trong danh mục"]);
  guide.addRow(["Loại hình LĐ", "Chính thức (PERMANENT) hoặc Thời vụ (TEMPORARY); alias cũ 'Toàn thời gian' vẫn được chấp nhận khi nhập."]);
  guide.addRow(["STK", "Nhập dạng Text để giữ số 0 đầu; không resolve ngân hàng."]);
  const metadata = workbook.addWorksheet("_meta");
  metadata.state = "veryHidden";
  metadata.addRow(["contract_version", WORKER_PROFILE_XLSX_CONTRACT]);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

export function xlsxTemplateHeaderKeys(): readonly string[] {
  return XLSX_TEMPLATE_KEYS;
}

export function xlsxTemplateHeaders(): readonly string[] {
  return XLSX_TEMPLATE_KEYS.map((key) => {
    if (key === "labor_type") return canonicalHeaderForField(key) ?? key;
    if (key === "gender") return "Giới tính";
    if (key === "recruiter_id") return "Người tuyển / Vendor";
    if (key === "provider_type") return "HRP/Vendor";
    if (key === "address") return "Địa chỉ";
    return canonicalHeaderForField(key) ?? key;
  });
}

export function normalizeLaborTypeHeader(value: string): "TEMPORARY" | "PERMANENT" | null {
  const trimmed = value.trim();
  return LABOR_TYPE_KEY_BY_HEADER[trimmed] ?? null;
}
