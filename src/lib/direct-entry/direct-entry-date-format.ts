/**
 * P3-W07C - Pure helpers chuyen doi ngay giua cac format.
 *
 * Source of truth luon la ISO `YYYY-MM-DD` (contract, request payload, DB).
 * UI closed-cell render `DD/MM/YYYY` theo format Viet Nam.
 *
 * Tuyet doi KHONG dung `new Date("YYYY-MM-DD")` de format/parse: khi may
 * chay o GMT- (vd America), constructor se phan tich chuoi ISO nhu UTC va
 * co the dich sang ngay truoc do khi in theo local time.
 *
 * Pure string-manipulation helpers duoi day chi dung cac thanh phan chuoi
 * (year, month, day) va validate theo lich (so ngay hop le voi thang/nam).
 */

/** Parse "YYYY-MM-DD" thanh {year, month, day} numbers. Tra ve null neu sai format. */
export function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  // Validate ngay theo lich (khong nhay ngay).
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1
      || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Format {year, month, day} hoac ISO "YYYY-MM-DD" thanh "DD/MM/YYYY". Tra ve "" neu sai. */
export function formatDateToDDMM(value: string): string {
  const parts = parseIsoDate(value);
  if (parts === null) return "";
  return `${String(parts.day).padStart(2, "0")}/${String(parts.month).padStart(2, "0")}/${parts.year}`;
}

/** Tra ve "DD/MM/YYYY" neu parse duoc; neu rong, tra ve "" nguyen ban. */
export function formatDateToDDMMRaw(value: string): string {
  if (value === "") return "";
  const formatted = formatDateToDDMM(value);
  return formatted;
}

/** Ngay hom nay theo Asia/Ho_Chi_Minh, dang "DD/MM/YYYY". */
export function todayInHoChiMinhAsDDMM(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.day}/${values.month}/${values.year}`;
}
