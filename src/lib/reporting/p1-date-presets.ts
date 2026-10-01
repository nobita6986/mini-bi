/**
 * P1-T1-W04-R3 — Quick date presets (thuần, testable, timezone cố định Asia/Ho_Chi_Minh).
 *
 * Không dùng timezone máy người dùng để xác định "hôm nay". Date arithmetic dùng
 * Date.UTC + getUTC* (naive calendar, an toàn DST). Không import value module khác.
 */

export const ALL_TIME_KEY = "all-time";

export interface DatePreset {
  key: string;
  label: string;
  from: string;
  to: string;
}

interface YMD {
  y: number;
  m: number;
  d: number;
}

const GMT7 = "Asia/Ho_Chi_Minh";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtYmd(d: YMD): string {
  return d.y + "-" + pad(d.m) + "-" + pad(d.d);
}

function toUtc(d: YMD): Date {
  return new Date(Date.UTC(d.y, d.m - 1, d.d));
}

function fromUtc(dt: Date): YMD {
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function addDays(d: YMD, n: number): YMD {
  return fromUtc(new Date(toUtc(d).getTime() + n * 86_400_000));
}

/** "Hôm nay" (y/m/d) theo Asia/Ho_Chi_Minh từ một instant UTC bất kỳ. */
export function todayInHoChiMinh(instant: Date): YMD {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: GMT7,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")) };
}

/** Thứ Hai của tuần chứa d (tuần bắt đầu Thứ Hai, kết thúc Chủ Nhật). */
function startOfWeek(d: YMD): YMD {
  const jsDay = toUtc(d).getUTCDay(); // 0 = Chủ Nhật, 1 = Thứ Hai ...
  const sinceMonday = jsDay === 0 ? 6 : jsDay - 1;
  return addDays(d, -sinceMonday);
}

function startOfMonth(d: YMD): YMD {
  return { y: d.y, m: d.m, d: 1 };
}

/** Tháng đầu tiên của quý (Q1=1..3, Q2=4..6, Q3=7..9, Q4=10..12). */
function startOfQuarter(d: YMD): YMD {
  const q = Math.floor((d.m - 1) / 3);
  return { y: d.y, m: q * 3 + 1, d: 1 };
}

/** Ngày 01 của tháng dương lịch liền trước. */
function startOfPrevMonth(d: YMD): YMD {
  return d.m === 1 ? { y: d.y - 1, m: 12, d: 1 } : { y: d.y, m: d.m - 1, d: 1 };
}

/** Ngày đầu của quý dương lịch liền trước. */
function startOfPrevQuarter(d: YMD): YMD {
  const q = Math.floor((d.m - 1) / 3);
  if (q === 0) return { y: d.y - 1, m: 10, d: 1 };
  return { y: d.y, m: (q - 1) * 3 + 1, d: 1 };
}

/**
 * Tính 7 preset khoảng ngày từ một instant tham chiếu (theo Asia/Ho_Chi_Minh).
 * "Tất cả thời gian" không phải preset có khoảng — xử lý ở component (clear from/to).
 */
export function computeDatePresets(referenceDate: Date): DatePreset[] {
  const today = todayInHoChiMinh(referenceDate);
  const todayStr = fmtYmd(today);
  const monday = startOfWeek(today);
  return [
    { key: "last-7-days", label: "7 ngày qua", from: fmtYmd(addDays(today, -6)), to: todayStr },
    { key: "this-week", label: "Tuần này", from: fmtYmd(monday), to: todayStr },
    { key: "last-week", label: "Tuần trước", from: fmtYmd(addDays(monday, -7)), to: fmtYmd(addDays(monday, -1)) },
    { key: "this-month", label: "Tháng này", from: fmtYmd(startOfMonth(today)), to: todayStr },
    { key: "last-month", label: "Tháng trước", from: fmtYmd(startOfPrevMonth(today)), to: fmtYmd(addDays(startOfMonth(today), -1)) },
    { key: "this-quarter", label: "Quý này", from: fmtYmd(startOfQuarter(today)), to: todayStr },
    { key: "last-quarter", label: "Quý trước", from: fmtYmd(startOfPrevQuarter(today)), to: fmtYmd(addDays(startOfQuarter(today), -1)) },
  ];
}

export interface FilterCriteriaInput {
  from?: string | null;
  to?: string | null;
  project?: string | null;
  recruiter?: string | null;
  provider?: string | null;
  employment?: string | null;
  source?: string | null;
}

/** Đếm tiêu chí đang áp dụng: date range (from/to) tính là MỘT tiêu chí. */
export function countActiveFilterCriteria(f: FilterCriteriaInput): number {
  const dimensions = [f.project, f.recruiter, f.provider, f.employment, f.source].filter(Boolean).length;
  return (f.from || f.to ? 1 : 0) + dimensions;
}

/** Trả key preset nếu from/to khớp chính xác một preset; ngược lại null. */
export function matchDatePreset(
  from: string | null | undefined,
  to: string | null | undefined,
  referenceDate: Date
): string | null {
  if (!from && !to) return null;
  const preset = computeDatePresets(referenceDate).find((p) => p.from === (from ?? null) && p.to === (to ?? null));
  return preset ? preset.key : null;
}
