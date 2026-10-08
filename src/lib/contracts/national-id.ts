/**
 * P2.5-HF-R2 - quy tac canonical CMT/CCCD dung chung cho moi API/RPC ghi CCCD.
 *
 * - Chi ASCII digits, dung do dai nghiep vu 9 hoac 12.
 * - Gia tri luu la text: so 0 dau duoc giu nguyen, khong bao gio parse thanh so.
 * - Khong tu sua du lieu: chuoi co ky tu dinh dang bi TU CHOI, khong duoc cat bo
 *   hay chuan hoa ngam o duong ghi. (Duong doc/tim kiem - lookup - moi doi chieu
 *   bang dang digits de khong bo sot du lieu lich su; xem #59/#60.)
 */
export const NATIONAL_ID_DIGIT_LENGTHS: readonly number[] = Object.freeze([9, 12]);
export const NATIONAL_ID_RULE_MESSAGE = "CMT/CCCD phải gồm đúng 9 hoặc 12 chữ số.";

const ASCII_DIGITS = /^[0-9]+$/;

/** True khi chuoi da o dung dang canonical de ghi vao DB. */
export function isCanonicalNationalId(value: unknown): boolean {
  return typeof value === "string" &&
    ASCII_DIGITS.test(value) &&
    NATIONAL_ID_DIGIT_LENGTHS.includes(value.length);
}

/**
 * Dang digits cua mot gia tri da luu (bo moi ky tu khong phai chu so).
 * Dung de doi chieu du lieu lich su co ky tu dinh dang voi gia tri canonical.
 * Tra ve null khi gia tri khong con chu so nao.
 */
export function canonicalNationalIdDigits(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[^0-9]/g, "");
  return digits.length === 0 ? null : digits;
}
