/**
 * P1.6-I04C3-R3A - Primitive dung chung cho moi parser "dan tu Excel".
 *
 * Khong I/O, khong framework, khong evaluate cong thuc. Cac ham o day duoc ca parser toi thieu
 * (excel-paste.ts) va parser ho so day du (worker-profile-paste.ts) dung lai.
 */
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";

/** Tran so dong du lieu moi lan dan (khong tinh dong header). */
export const PASTE_MAX_ROWS = 100;

/** Tach dong: chuan hoa CRLF truoc khi split LF. */
export function splitPasteLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** Tach o theo tab; trim outer whitespace tung o. */
export function splitPasteCells(line: string): string[] {
  return line.split("\t").map((cell) => cell.trim());
}

/**
 * Chuan hoa ngay ve YYYY-MM-DD. Nhan YYYY-MM-DD hoac DD/MM/YYYY (ngay/thang 1-2 chu so).
 * Tra null neu khong phai ngay lich that.
 */
export function normalizePasteDate(value: string): string | null {
  const trimmed = value.trim();
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(trimmed)) {
    return isRealCalendarDate(trimmed) ? trimmed : null;
  }
  const match = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/.exec(trimmed);
  if (!match) return null;
  const day = String(Number(match[1])).padStart(2, "0");
  const month = String(Number(match[2])).padStart(2, "0");
  const normalized = match[3] + "-" + month + "-" + day;
  return isRealCalendarDate(normalized) ? normalized : null;
}

/**
 * O giong cong thuc Excel (=, +, -, @). Parser KHONG BAO GIO evaluate; ham nay chi de quyet dinh
 * o do co duoc chap nhan nhu text tu do hay khong.
 */
export function isFormulaLikeCell(value: string): boolean {
  return /^[=+\-@]/.test(value.trim());
}

/** Chuan hoa header/alias: NFC, trim, gop khoang trang, ha case. Khong bo dau. */
export function normalizePasteHeader(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Bo dau + ha case + bo ky tu khong phai chu/so: dung cho alias gia tri (Thoi vu, Da nghi...). */
export function foldPasteToken(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]/g, "");
}

/** Chuoi chi gom chu so va co do dai nam trong danh sach cho truoc (giu nguyen so 0 dau). */
export function isDigitStringOfLength(value: string, lengths: readonly number[]): boolean {
  return lengths.includes(value.length) && /^[0-9]+$/.test(value);
}

/** So sanh ngay ISO: tra true khi left <= right. */
export function isOnOrBefore(left: string, right: string): boolean {
  return left <= right;
}

/** Nam (YYYY) cua mot ngay ISO hop le. */
export function isoYear(value: string): string {
  return value.slice(0, 4);
}

/** Thang (YYYY-MM) cua mot ngay ISO hop le. */
export function isoMonth(value: string): string {
  return value.slice(0, 7);
}
