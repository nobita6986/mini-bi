import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import type { WorkReportFrequency, WorkReportPeriod } from "./contracts.ts";

export const WORK_REPORT_TIMEZONE = "Asia/Ho_Chi_Minh" as const;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

function dateAtUtc(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const value = dateAtUtc(date);
  value.setUTCDate(value.getUTCDate() + days);
  return dateOnly(value);
}

function isoWeek(date: string): { year: number; week: number; monday: string; sunday: string } {
  const value = dateAtUtc(date);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const year = value.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((value.getTime() - first.getTime()) / 86400000) + 1) / 7);
  const monday = addDays(date, 1 - day);
  return { year, week, monday, sunday: addDays(monday, 6) };
}

export function workReportPeriodForDate(frequency: WorkReportFrequency, businessDate: string): WorkReportPeriod {
  if (!isRealCalendarDate(businessDate)) throw new Error("WORK_REPORT_DATE_INVALID");
  if (frequency === "DAILY") {
    return { period_type: frequency, period_key: businessDate, period_start_date: businessDate, period_end_date: businessDate };
  }
  if (frequency === "WEEKLY") {
    const value = isoWeek(businessDate);
    return {
      period_type: frequency,
      period_key: `${value.year}-W${String(value.week).padStart(2, "0")}`,
      period_start_date: value.monday,
      period_end_date: value.sunday,
    };
  }
  if (frequency === "MONTHLY") {
    const [year, month] = businessDate.split("-").map(Number);
    const end = dateOnly(new Date(Date.UTC(year, month, 0)));
    return {
      period_type: frequency,
      period_key: businessDate.slice(0, 7),
      period_start_date: `${businessDate.slice(0, 7)}-01`,
      period_end_date: end,
    };
  }
  return {
    period_type: "ONCE",
    period_key: `ONCE-${businessDate}`,
    period_start_date: businessDate,
    period_end_date: businessDate,
  };
}

export function workReportDueAt(
  periodEndDate: string,
  dueDayOffset: number,
  dueTimeLocal = "23:59:59",
): string {
  if (!isRealCalendarDate(periodEndDate) || !Number.isInteger(dueDayOffset) ||
      dueDayOffset < 0 || dueDayOffset > 31 || !LOCAL_TIME.test(dueTimeLocal)) {
    throw new Error("WORK_REPORT_DUE_AT_INVALID");
  }
  const time = dueTimeLocal.length === 5 ? `${dueTimeLocal}:00` : dueTimeLocal;
  return new Date(`${addDays(periodEndDate, dueDayOffset)}T${time}+07:00`).toISOString();
}
