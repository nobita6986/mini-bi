/**
 * P1.5-W04-R1 — Cửa sổ dữ liệu sự kiện theo W03 AUTHORITY (không tự viết lại period math).
 *
 * - Dùng `buildPeriodPlan` + hằng số baseline của W03 để tính ngày sớm nhất thực sự cần.
 * - Ngày kết thúc = `plan.effective_end` (min(end, as_of)) ⇒ KHÔNG lấy fact sau as_of.
 * - Vượt trần policy ⇒ AI_ANALYSIS_WINDOW_TOO_LARGE (không tự rút ngắn lịch sử).
 */

import {
  MAX_BASELINE_MONTHS,
  MAX_BASELINE_QUARTERS,
  MAX_DAY_OF_WEEK_WEEKS,
  MAX_STABILITY_POINTS,
  addDays,
  buildPeriodPlan,
  previousPeriodWindow,
} from "../engine-shared.mjs";

export const DEFAULT_MAX_LOOKBACK_DAYS = 1500;

function earlier(a, b) {
  return a < b ? a : b;
}

/**
 * Ngày sớm nhất engine W03 thực sự cần cho period này:
 * - 52 tuần hoàn tất (day_of_week, trần MAX_DAY_OF_WEEK_WEEKS);
 * - MAX_BASELINE_MONTHS kỳ tháng liền trước;
 * - MAX_BASELINE_QUARTERS kỳ quý liền trước;
 * - custom: MAX_STABILITY_POINTS cửa sổ dài bằng nhau (equal-length stability windows).
 */
export function earliestRequiredDate(plan) {
  let earliest = plan.start;
  earliest = earlier(earliest, addDays(plan.start, -(MAX_DAY_OF_WEEK_WEEKS * 7)));

  let cursor = plan.start;
  for (let i = 0; i < MAX_BASELINE_MONTHS; i++) {
    const prev = previousPeriodWindow("month", cursor);
    if (!prev) break;
    cursor = prev.start;
  }
  earliest = earlier(earliest, cursor);

  cursor = plan.start;
  for (let i = 0; i < MAX_BASELINE_QUARTERS; i++) {
    const prev = previousPeriodWindow("quarter", cursor);
    if (!prev) break;
    cursor = prev.start;
  }
  earliest = earlier(earliest, cursor);

  if (plan.type === "custom") {
    let customCursor = plan.start;
    const length = Math.max(1, plan.elapsed_days);
    for (let i = 0; i < MAX_STABILITY_POINTS; i++) {
      const end = addDays(customCursor, -1);
      customCursor = addDays(end, -(length - 1));
    }
    earliest = earlier(earliest, customCursor);
  }

  return earliest;
}

function inclusiveDays(start, end) {
  const parts1 = start.split("-").map(Number);
  const parts2 = end.split("-").map(Number);
  return Math.round((Date.UTC(parts2[0], parts2[1] - 1, parts2[2]) - Date.UTC(parts1[0], parts1[1] - 1, parts1[2])) / 86400000) + 1;
}

/**
 * Khoảng đọc dữ liệu cho loader.
 * @returns {{ ok:true, from:string, to:string, lookback_days:number, plan:object } | { ok:false, code:string, message:string }}
 */
export function computeFactWindow(period, options = {}) {
  if (!period || typeof period !== "object") {
    return { ok: false, code: "AI_INPUT_INVALID", message: "period không hợp lệ" };
  }
  let plan;
  try {
    plan = buildPeriodPlan(period);
  } catch {
    return { ok: false, code: "AI_INPUT_INVALID", message: "không dựng được period plan" };
  }
  if (!plan || typeof plan.start !== "string" || typeof plan.effective_end !== "string") {
    return { ok: false, code: "AI_INPUT_INVALID", message: "period plan thiếu start/effective_end" };
  }
  const maxLookbackDays = Number.isInteger(options.max_lookback_days) && options.max_lookback_days > 0
    ? options.max_lookback_days
    : DEFAULT_MAX_LOOKBACK_DAYS;

  const from = earliestRequiredDate(plan);
  const to = plan.effective_end; // KHÔNG lấy fact sau as_of
  const lookbackDays = inclusiveDays(from, to);
  if (lookbackDays > maxLookbackDays) {
    return {
      ok: false,
      code: "AI_ANALYSIS_WINDOW_TOO_LARGE",
      message: "cửa sổ phân tích vượt trần policy (" + lookbackDays + " > " + maxLookbackDays + " ngày)",
    };
  }
  return { ok: true, from, to, lookback_days: lookbackDays, plan };
}
