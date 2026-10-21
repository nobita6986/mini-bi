/**
 * MBI-DA-2026-01 — Wave 2 (Items 1.3 & 1.4): Composition insights and Day/Week/Month trend resolution.
 *
 * Pure TypeScript derivations operating strictly on the already-filtered `ReportingData`
 * and daily trend points. Zero extra database queries or scope changes.
 */

import { buildDailyTrend, MAX_TREND_DAYS, type TrendPoint } from "./p1-dashboard.ts";
import type { ReportingBucket, ReportingData } from "./p1-reporting.ts";

export type TrendResolution = "day" | "week" | "month";

export interface TrendResolutionOption {
  key: TrendResolution;
  label: string;
  ariaLabel: string;
}

export const TREND_RESOLUTION_OPTIONS: readonly TrendResolutionOption[] = [
  { key: "day", label: "Ngày", ariaLabel: "Biểu đồ xu hướng tuyển dụng theo ngày" },
  { key: "week", label: "Tuần", ariaLabel: "Biểu đồ xu hướng tuyển dụng theo tuần" },
  { key: "month", label: "Tháng", ariaLabel: "Biểu đồ xu hướng tuyển dụng theo tháng" },
] as const;

export interface TrendBucketPoint {
  /** Khóa định danh của bucket (YYYY-MM-DD cho ngày, ngày đầu tuần cho tuần, YYYY-MM cho tháng). */
  key: string;
  /** Nhãn hiển thị trên trục X / tooltip của TrendChart. */
  date: string;
  /** Ngày bắt đầu thực tế của bucket sau khi đã clip theo khoảng lọc from/to. */
  startDate: string;
  /** Ngày kết thúc thực tế của bucket sau khi đã clip theo khoảng lọc from/to. */
  endDate: string;
  /** Tổng lượt tuyển trong bucket. */
  count: number;
}

export interface LeadingProjectInsight {
  key: string;
  display: string;
  count: number;
  /** Tỷ trọng (%) trên tổng tập kết quả đang lọc (chưa làm tròn). */
  shareOfFilteredPct: number;
  /** Số dự án khác có cùng số lượt tuyển cao nhất. */
  tiedOtherCount: number;
}

export interface ProviderCompositionInsight {
  total: number;
  hrpCount: number;
  vendorCount: number;
  unknownCount: number;
  invalidCount: number;
  classifiedTotal: number;
  unclassifiedTotal: number;
  /** Tỷ trọng (%) trên tổng tập kết quả đang lọc (null khi total = 0). */
  hrpShareOfTotalPct: number | null;
  vendorShareOfTotalPct: number | null;
  unknownShareOfTotalPct: number | null;
  invalidShareOfTotalPct: number | null;
  /** Tỷ trọng (%) trong phần đã phân loại HRP + Vendor (null khi classifiedTotal = 0). */
  hrpShareOfClassifiedPct: number | null;
  vendorShareOfClassifiedPct: number | null;
  /** Độ phủ phân loại (%) = classifiedTotal / total * 100 (null khi total = 0). */
  classifiedCoveragePct: number | null;
  /** Cờ cho biết bộ lọc provider đang bật (không được mô tả là cơ cấu toàn công ty). */
  providerFilterActive: boolean;
}

export interface EmploymentCompositionInsight {
  total: number;
  seasonalCount: number;
  permanentCount: number;
  unknownCount: number;
  invalidCount: number;
  classifiedTotal: number;
  unclassifiedTotal: number;
  /** Tỷ trọng (%) trên tổng tập kết quả đang lọc (null khi total = 0). */
  seasonalSharePct: number | null;
  permanentSharePct: number | null;
  unknownSharePct: number | null;
  invalidSharePct: number | null;
  /** Độ phủ phân loại (%) = classifiedTotal / total * 100 (null khi total = 0). */
  classifiedCoveragePct: number | null;
  employmentFilterActive: boolean;
}

export interface DashboardCompositionInsights {
  filteredTotal: number;
  hasFilterActive: boolean;
  leadingProject: LeadingProjectInsight | null;
  provider: ProviderCompositionInsight;
  employment: EmploymentCompositionInsight;
}

const ISO_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidYmd(value: string | undefined): value is string {
  if (!value || !ISO_YMD_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function parseYmdToUtcMs(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatUtcMsToYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Thứ Hai của tuần chứa `ymd` (tuần bắt đầu Thứ Hai theo lịch nghiệp vụ Asia/Ho_Chi_Minh).
 */
export function startOfMondayWeekYmd(ymd: string): string {
  const ms = parseYmdToUtcMs(ymd);
  const jsDay = new Date(ms).getUTCDay(); // 0 = Chủ Nhật, 1 = Thứ Hai ... 6 = Thứ Bảy
  const sinceMonday = jsDay === 0 ? 6 : jsDay - 1;
  return formatUtcMsToYmd(ms - sinceMonday * 86_400_000);
}

export function endOfMondayWeekYmd(mondayYmd: string): string {
  const ms = parseYmdToUtcMs(mondayYmd);
  return formatUtcMsToYmd(ms + 6 * 86_400_000);
}

/**
 * Ngày đầu và ngày cuối của tháng dương lịch chứa `ymd`.
 */
export function monthBoundsYmd(ymd: string): { monthKey: string; startDate: string; endDate: string } {
  const [y, m] = ymd.split("-").map(Number);
  const monthKey = ymd.slice(0, 7);
  const startDate = `${monthKey}-01`;
  // Ngày 0 của tháng kế tiếp trong UTC chính là ngày cuối cùng của tháng hiện tại (kể cả năm nhuận).
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const endDate = `${monthKey}-${String(lastDay).padStart(2, "0")}`;
  return { monthKey, startDate, endDate };
}

/**
 * Gộp chuỗi daily trend sang độ phân giải `day | week | month`.
 *
 * - Giữ nguyên tổng lượt tuyển: SUM(day) = SUM(week) = SUM(month).
 * - Tuần bắt đầu Thứ Hai; tháng theo tháng dương lịch Gregorian.
 * - Mọi bucket đều được clip biên `startDate`/`endDate` vào khoảng `[from, to]` (hoặc biên của dữ liệu)
 *   để không bao giờ vượt ra ngoài bộ lọc ngày đang chọn.
 */
export function aggregateDailyTrendPoints(
  dailyPoints: readonly TrendPoint[],
  resolution: TrendResolution,
  bounds?: { from?: string; to?: string },
): TrendBucketPoint[] {
  if (dailyPoints.length === 0) return [];

  const sorted = [...dailyPoints].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const firstDate = sorted[0].date;
  const lastDate = sorted[sorted.length - 1].date;

  const clipMin = bounds?.from && isValidYmd(bounds.from) ? bounds.from : firstDate;
  const clipMax = bounds?.to && isValidYmd(bounds.to) ? bounds.to : lastDate;

  if (resolution === "day") {
    return sorted.map((p) => ({
      key: p.date,
      date: p.date,
      startDate: p.date,
      endDate: p.date,
      count: p.count,
    }));
  }

  if (resolution === "week") {
    const groups = new Map<string, { startDate: string; endDate: string; count: number }>();
    for (const point of sorted) {
      const monday = startOfMondayWeekYmd(point.date);
      const sunday = endOfMondayWeekYmd(monday);
      const startDate = monday < clipMin ? clipMin : monday;
      const endDate = sunday > clipMax ? clipMax : sunday;
      const existing = groups.get(monday);
      if (existing) {
        existing.count += point.count;
      } else {
        groups.set(monday, { startDate, endDate, count: point.count });
      }
    }
    return [...groups.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([monday, g]) => ({
        key: monday,
        date: g.startDate === g.endDate ? g.startDate : `${g.startDate} → ${g.endDate}`,
        startDate: g.startDate,
        endDate: g.endDate,
        count: g.count,
      }));
  }

  // resolution === "month"
  const groups = new Map<string, { startDate: string; endDate: string; count: number }>();
  for (const point of sorted) {
    const { monthKey, startDate: rawStart, endDate: rawEnd } = monthBoundsYmd(point.date);
    const startDate = rawStart < clipMin ? clipMin : rawStart;
    const endDate = rawEnd > clipMax ? clipMax : rawEnd;
    const existing = groups.get(monthKey);
    if (existing) {
      existing.count += point.count;
    } else {
      groups.set(monthKey, { startDate, endDate, count: point.count });
    }
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([monthKey, g]) => ({
      key: monthKey,
      date: monthKey,
      startDate: g.startDate,
      endDate: g.endDate,
      count: g.count,
    }));
}

/**
 * Dựng chuỗi xu hướng theo độ phân giải `day | week | month` trực tiếp từ `byDate` và `from/to`.
 * Tái sử dụng `buildDailyTrend` nên bảo toàn ngưỡng `MAX_TREND_DAYS` chống khoảng ngày bệnh lý.
 */
export function buildTrendByResolution(
  byDate: Record<string, number>,
  resolution: TrendResolution,
  from?: string,
  to?: string,
): TrendBucketPoint[] {
  const daily = buildDailyTrend(byDate, from, to);
  return aggregateDailyTrendPoints(daily, resolution, { from, to });
}

function sortProjectBucketsForLead(buckets: Record<string, ReportingBucket>): ReportingBucket[] {
  return Object.values(buckets)
    .filter((b) => b && b.recruitedCount > 0)
    .sort((a, b) => {
      const aSentinel = a.key === "__unknown__" || a.key === "__invalid__";
      const bSentinel = b.key === "__unknown__" || b.key === "__invalid__";
      if (aSentinel !== bSentinel) return aSentinel ? 1 : -1;
      if (a.recruitedCount !== b.recruitedCount) return b.recruitedCount - a.recruitedCount;
      return a.display.localeCompare(b.display, "vi");
    });
}

function pctOrNull(part: number, total: number): number | null {
  if (total <= 0) return null;
  return (part / total) * 100;
}

/**
 * Tính toán Composition Insights (Mục 1.3) từ `ReportingData` đã lọc.
 *
 * - Giữ nguyên `unknown` (`__unknown__`) và `invalid` (`__invalid__`) tách biệt hoàn toàn,
 *   không bao giờ gộp ngầm vào HRP/Vendor hoặc Thời vụ/Chính thức.
 * - Mọi tỷ trọng phản ánh tập dữ liệu đang lọc (`filteredTotal`).
 */
export function computeCompositionInsights(
  data: Pick<
    ReportingData,
    "recruitedTotal" | "byProject" | "byProvider" | "byEmployment" | "applied" | "empty"
  >,
): DashboardCompositionInsights {
  const isEmpty =
    data.empty.noSources ||
    data.empty.noFacts ||
    data.empty.noMatches ||
    data.recruitedTotal <= 0;

  const filteredTotal = isEmpty ? 0 : data.recruitedTotal;
  const hasFilterActive = Boolean(
    data.applied.from ||
      data.applied.to ||
      data.applied.project ||
      data.applied.recruiter ||
      data.applied.provider ||
      data.applied.employment ||
      data.applied.source,
  );

  // 1. Leading project
  let leadingProject: LeadingProjectInsight | null = null;
  if (filteredTotal > 0) {
    const sortedProjects = sortProjectBucketsForLead(data.byProject);
    if (sortedProjects.length > 0) {
      const top = sortedProjects[0];
      const topIsSentinel = top.key === "__unknown__" || top.key === "__invalid__";
      const tiedOtherCount = sortedProjects
        .slice(1)
        .filter(
          (b) =>
            b.recruitedCount === top.recruitedCount &&
            (b.key === "__unknown__" || b.key === "__invalid__") === topIsSentinel,
        ).length;
      leadingProject = {
        key: top.key,
        display: top.display,
        count: top.recruitedCount,
        shareOfFilteredPct: (top.recruitedCount / filteredTotal) * 100,
        tiedOtherCount,
      };
    }
  }

  // 2. HRP / Vendor summary (preserve unknown & invalid separately)
  let hrpCount = 0;
  let vendorCount = 0;
  let providerUnknownCount = 0;
  let providerInvalidCount = 0;
  if (filteredTotal > 0) {
    for (const bucket of Object.values(data.byProvider)) {
      if (!bucket || bucket.recruitedCount <= 0) continue;
      if (bucket.key === "hrp") hrpCount += bucket.recruitedCount;
      else if (bucket.key === "vendor") vendorCount += bucket.recruitedCount;
      else if (bucket.key === "__unknown__") providerUnknownCount += bucket.recruitedCount;
      else providerInvalidCount += bucket.recruitedCount;
    }
  }
  const providerClassifiedTotal = hrpCount + vendorCount;
  const providerUnclassifiedTotal = providerUnknownCount + providerInvalidCount;

  const provider: ProviderCompositionInsight = {
    total: filteredTotal,
    hrpCount,
    vendorCount,
    unknownCount: providerUnknownCount,
    invalidCount: providerInvalidCount,
    classifiedTotal: providerClassifiedTotal,
    unclassifiedTotal: providerUnclassifiedTotal,
    hrpShareOfTotalPct: pctOrNull(hrpCount, filteredTotal),
    vendorShareOfTotalPct: pctOrNull(vendorCount, filteredTotal),
    unknownShareOfTotalPct: pctOrNull(providerUnknownCount, filteredTotal),
    invalidShareOfTotalPct: pctOrNull(providerInvalidCount, filteredTotal),
    hrpShareOfClassifiedPct: pctOrNull(hrpCount, providerClassifiedTotal),
    vendorShareOfClassifiedPct: pctOrNull(vendorCount, providerClassifiedTotal),
    classifiedCoveragePct: pctOrNull(providerClassifiedTotal, filteredTotal),
    providerFilterActive: Boolean(data.applied.provider),
  };

  // 3. Seasonal / Permanent employment summary (preserve unknown & invalid separately)
  let seasonalCount = 0;
  let permanentCount = 0;
  let employmentUnknownCount = 0;
  let employmentInvalidCount = 0;
  if (filteredTotal > 0) {
    for (const bucket of Object.values(data.byEmployment)) {
      if (!bucket || bucket.recruitedCount <= 0) continue;
      if (bucket.key === "thời vụ") seasonalCount += bucket.recruitedCount;
      else if (bucket.key === "chính thức") permanentCount += bucket.recruitedCount;
      else if (bucket.key === "__unknown__") employmentUnknownCount += bucket.recruitedCount;
      else employmentInvalidCount += bucket.recruitedCount;
    }
  }
  const employmentClassifiedTotal = seasonalCount + permanentCount;
  const employmentUnclassifiedTotal = employmentUnknownCount + employmentInvalidCount;

  const employment: EmploymentCompositionInsight = {
    total: filteredTotal,
    seasonalCount,
    permanentCount,
    unknownCount: employmentUnknownCount,
    invalidCount: employmentInvalidCount,
    classifiedTotal: employmentClassifiedTotal,
    unclassifiedTotal: employmentUnclassifiedTotal,
    seasonalSharePct: pctOrNull(seasonalCount, filteredTotal),
    permanentSharePct: pctOrNull(permanentCount, filteredTotal),
    unknownSharePct: pctOrNull(employmentUnknownCount, filteredTotal),
    invalidSharePct: pctOrNull(employmentInvalidCount, filteredTotal),
    classifiedCoveragePct: pctOrNull(employmentClassifiedTotal, filteredTotal),
    employmentFilterActive: Boolean(data.applied.employment),
  };

  return {
    filteredTotal,
    hasFilterActive,
    leadingProject,
    provider,
    employment,
  };
}

/**
 * Format phần trăm sang chuỗi hiển thị gọn (mặc định làm tròn 1 chữ số thập phân khi lẻ, hoặc số nguyên).
 */
export function formatSharePct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  const rounded = Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

export { MAX_TREND_DAYS };
