/**
 * MBI-DA-2026-01 — Wave 1 (Items 1.1 & 1.2): Pure KPI summary and hiring-day derivations.
 *
 * Derives recruitment summary metrics strictly from the already-scoped and filtered
 * `ReportingData` read-model without extra queries, rounding in the data layer, or
 * reinterpreting recorded recruitment facts as unique people.
 */

import type { ReportingData } from "./p1-reporting";

export const SUMMARY_KPI_LABELS = {
  recruitedTotal: "Lượt tuyển ghi nhận",
  activeRecruiters: "Recruiter có phát sinh tuyển",
  activeProjects: "Dự án có tuyển",
  activeHiringDays: "Số ngày có tuyển",
  avgPerActiveDay: "Trung bình/ngày có tuyển",
  peakDailyHires: "Đỉnh tuyển/ngày",
} as const;

export interface DashboardSummaryMetrics {
  /** Tổng lượt tuyển ghi nhận trong tập kết quả hiện tại (không phải số người duy nhất). */
  recruitedTotal: number;
  /** Số bucket recruiter có recruitedCount > 0 (đếm theo bucket key, không gộp trùng display). */
  activeRecruiterBucketCount: number;
  /** Số bucket dự án có recruitedCount > 0 (đếm theo bucket key). */
  activeProjectBucketCount: number;
  /** Số ngày có phát sinh tuyển (byDate[date] > 0). */
  activeHiringDays: number;
  /** Trung bình lượt tuyển trên mỗi ngày có phát sinh (chưa làm tròn; 0 khi activeHiringDays = 0). */
  avgPerActiveDay: number;
  /** Lượt tuyển cao nhất trong một ngày (null khi không có ngày phát sinh). */
  peakDailyCount: number | null;
  /** Tất cả các ngày đạt đỉnh, sắp xếp tăng dần YYYY-MM-DD. */
  peakDates: string[];
  /** Ngày đạt đỉnh sớm nhất (null khi không có ngày phát sinh). */
  primaryPeakDate: string | null;
  /** Các ngày đồng đỉnh còn lại (sắp xếp tăng dần YYYY-MM-DD). */
  tiedPeakDates: string[];
}

/**
 * Tính toán các chỉ số tóm tắt Wave 1 từ `ReportingData` đã lọc.
 * Giữ nguyên độ chính xác số thực cho `avgPerActiveDay` (chỉ format khi hiển thị).
 */
export function computeDashboardSummary(
  data: Pick<ReportingData, "recruitedTotal" | "byDate" | "byRecruiter" | "byProject" | "empty">,
): DashboardSummaryMetrics {
  const isEmpty =
    data.empty.noSources ||
    data.empty.noFacts ||
    data.empty.noMatches;

  if (isEmpty) {
    return {
      recruitedTotal: 0,
      activeRecruiterBucketCount: 0,
      activeProjectBucketCount: 0,
      activeHiringDays: 0,
      avgPerActiveDay: 0,
      peakDailyCount: null,
      peakDates: [],
      primaryPeakDate: null,
      tiedPeakDates: [],
    };
  }

  let activeRecruiterBucketCount = 0;
  for (const bucket of Object.values(data.byRecruiter)) {
    if (bucket && bucket.recruitedCount > 0) {
      activeRecruiterBucketCount += 1;
    }
  }

  let activeProjectBucketCount = 0;
  for (const bucket of Object.values(data.byProject)) {
    if (bucket && bucket.recruitedCount > 0) {
      activeProjectBucketCount += 1;
    }
  }

  const activeDateEntries: Array<[string, number]> = [];
  for (const [date, count] of Object.entries(data.byDate)) {
    if (typeof count === "number" && count > 0) {
      activeDateEntries.push([date, count]);
    }
  }

  const activeHiringDays = activeDateEntries.length;
  const avgPerActiveDay = activeHiringDays > 0 ? data.recruitedTotal / activeHiringDays : 0;

  if (activeHiringDays === 0 || data.recruitedTotal <= 0) {
    return {
      recruitedTotal: data.recruitedTotal,
      activeRecruiterBucketCount,
      activeProjectBucketCount,
      activeHiringDays: 0,
      avgPerActiveDay: 0,
      peakDailyCount: null,
      peakDates: [],
      primaryPeakDate: null,
      tiedPeakDates: [],
    };
  }

  let peakDailyCount = 0;
  for (const [, count] of activeDateEntries) {
    if (count > peakDailyCount) {
      peakDailyCount = count;
    }
  }

  const peakDates = activeDateEntries
    .filter(([, count]) => count === peakDailyCount)
    .map(([date]) => date)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    recruitedTotal: data.recruitedTotal,
    activeRecruiterBucketCount,
    activeProjectBucketCount,
    activeHiringDays,
    avgPerActiveDay,
    peakDailyCount,
    peakDates,
    primaryPeakDate: peakDates[0] ?? null,
    tiedPeakDates: peakDates.slice(1),
  };
}

/**
 * Format trung bình/ngày có tuyển sang 1 chữ số thập phân tại thời điểm hiển thị.
 */
export function formatAvgPerActiveDay(avgPerActiveDay: number | null): string {
  if (avgPerActiveDay === null || !Number.isFinite(avgPerActiveDay)) {
    return "—";
  }
  return (Math.round(avgPerActiveDay * 10) / 10).toFixed(1);
}

/**
 * Format chú thích ngày đạt đỉnh: hiển thị ngày sớm nhất trước, kèm số ngày đồng đỉnh và các ngày tương ứng.
 */
export function formatPeakDayHint(
  summary: Pick<
    DashboardSummaryMetrics,
    "peakDailyCount" | "primaryPeakDate" | "tiedPeakDates"
  > & { peakDates?: string[] },
): string {
  if (summary.peakDailyCount === null || summary.primaryPeakDate === null) {
    return "chưa có ngày phát sinh";
  }
  if (summary.tiedPeakDates.length === 0) {
    return "ngày " + summary.primaryPeakDate;
  }
  const allDates =
    Array.isArray(summary.peakDates) && summary.peakDates.length > 0
      ? summary.peakDates
      : [summary.primaryPeakDate, ...summary.tiedPeakDates];
  return (
    "ngày " +
    summary.primaryPeakDate +
    " (" +
    allDates.length +
    " ngày đồng đỉnh: " +
    allDates.join(", ") +
    ")"
  );
}
