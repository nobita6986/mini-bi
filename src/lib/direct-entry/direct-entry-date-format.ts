/**
 * P3-W07C - Pure helpers for date-shaped text and ISO date-only fields.
 *
 * `date_of_birth` and `national_id_issued_at` are ordinary strings: keep the
 * exact value the user typed. Other date fields such as `first_work_date`
 * and `leave_date` retain their ISO contract and may use the converters below.
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

/**
 * Return DOB/CCCD issue-date text unchanged for closed-cell display and input
 * echo. Do not parse or normalize `/`, `-`, ISO-looking, or other text.
 */
export function formatFreeDateText(value: string): string {
  return value;
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

/**
 * Parse "DD/MM/YYYY" thanh ISO "YYYY-MM-DD". Tra ve "" neu input rong
 * hoac khong hop le (parse that bai). Khong mutate format goc.
 *
 * Chap nhan cac separator "/" hoac "-". Validate ngay theo lich.
 *
 * P3-W07C-R2: use only for fields that retain a real date contract, never
 * for `date_of_birth` or `national_id_issued_at`.
 */
export function parseDDMMToIso(value: string): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed === "") return "";
  const match = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(trimmed);
  if (!match) return "";
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return "";
  if (month < 1 || month > 12) return "";
  if (day < 1 || day > 31) return "";
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1
      || probe.getUTCDate() !== day) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * P3-W07C-R6: quyet dinh commit cho editor ngay dang text DD/MM/YYYY.
 *
 * Chi commit khi chuoi nguoi dung nhap parse duoc thanh ngay hop le. Chuoi sai
 * KHONG duoc bien thanh rong va KHONG duoc ghi de gia tri cu.
 */
export type DdmmCommitDecision =
  | { ok: true; iso: string }
  | { ok: false; reason: "empty" | "invalid" };

export function decideDdmmCommit(text: string, previousIso: string): DdmmCommitDecision {
  const trimmed = text.trim();
  if (trimmed === "") {
    // O trong san (chua tung co ngay) thi commit rong la vo hai; con neu dang co
    // ngay cu thi giu nguyen, khong xoa.
    return previousIso === "" ? { ok: true, iso: "" } : { ok: false, reason: "empty" };
  }
  const iso = parseDDMMToIso(trimmed);
  if (iso === "") return { ok: false, reason: "invalid" };
  return { ok: true, iso };
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
