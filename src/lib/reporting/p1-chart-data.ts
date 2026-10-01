/**
 * P1-T1-W04-R2 — Chart data helpers (thuần, không import value từ module khác để Node test chạy được).
 *
 * Màu category ổn định theo normalized key (hash deterministic), sentinel cố định,
 * status cố định. KHÔNG tạo index-based random color.
 */

import type { ReportingBucket, ReportingSourceStatusRow } from "./p1-reporting";

/** Bảng màu category ổn định (không đổi theo thứ tự/sort/filter). */
export const CATEGORY_PALETTE = [
  "#6366f1", // indigo
  "#0ea5e9", // sky
  "#10b981", // emerald
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#14b8a6", // teal
  "#f97316", // orange
  "#ec4899", // pink
  "#84cc16", // lime
  "#22d3ee", // cyan
] as const;

export const UNKNOWN_COLOR = "#f59e0b"; // amber — Không xác định
export const INVALID_COLOR = "#f43f5e"; // rose — Không hợp lệ

/** Màu semantic cố định cho provider (HRP/Vendor) và employment (Thời vụ/Chính thức). */
const FIXED_COLORS: Record<string, string> = {
  hrp: "#0ea5e9",
  vendor: "#8b5cf6",
  "thời vụ": "#10b981",
  "chính thức": "#6366f1",
  __unknown__: UNKNOWN_COLOR,
  __invalid__: INVALID_COLOR,
};

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Màu ổn định theo normalized key; sentinel + catalog luôn dùng màu cố định. */
export function stableColorForKey(key: string): string {
  if (FIXED_COLORS[key]) return FIXED_COLORS[key];
  return CATEGORY_PALETTE[hashString(key) % CATEGORY_PALETTE.length];
}

export const STATUS_COLORS = {
  succeeded: "#10b981", // emerald
  partial: "#f59e0b", // amber
  failed: "#f43f5e", // rose
  running: "#0ea5e9", // sky
  noRun: "#a1a1aa", // zinc
} as const;

/** Tỷ lệ phần trăm an toàn: total <= 0 trả 0 (không NaN/Infinity). */
export function percentageOfTotal(count: number, total: number): number {
  if (total <= 0) return 0;
  return (count / total) * 100;
}

export interface ChartSegment {
  key: string;
  display: string;
  value: number;
  color: string;
  percent: number;
  [k: string]: unknown;
}

function sortByValueDesc(buckets: ReportingBucket[]): ReportingBucket[] {
  return [...buckets].sort((a, b) =>
    a.recruitedCount !== b.recruitedCount ? b.recruitedCount - a.recruitedCount : a.display.localeCompare(b.display, "vi")
  );
}

/**
 * Segments cho donut (provider) và composition (employment).
 * Tổng value của mọi segment luôn bằng tổng recruitedCount của buckets đầu vào.
 */
export function buildCategorySegments(buckets: Record<string, ReportingBucket>): ChartSegment[] {
  const list = Object.values(buckets);
  const total = list.reduce((a, b) => a + b.recruitedCount, 0);
  return sortByValueDesc(list).map((b) => ({
    key: b.key,
    display: b.display,
    value: b.recruitedCount,
    color: stableColorForKey(b.key),
    percent: percentageOfTotal(b.recruitedCount, total),
  }));
}

export interface TreemapDatum {
  key: string;
  name: string;
  size: number;
  color: string;
  [k: string]: unknown;
}

export interface BarDatum {
  key: string;
  name: string;
  value: number;
  color: string;
  [k: string]: unknown;
}

/** Top-N cho treemap (dự án); full list vẫn giữ ở bảng thu gọn (không mất). */
export function buildTreemapData(buckets: Record<string, ReportingBucket>, top: number): TreemapDatum[] {
  return sortByValueDesc(Object.values(buckets))
    .slice(0, top)
    .map((b) => ({ key: b.key, name: b.display, size: b.recruitedCount, color: stableColorForKey(b.key) }));
}

/** Top-N cho horizontal bar (người tuyển). */
export function buildBarData(buckets: Record<string, ReportingBucket>, top: number): BarDatum[] {
  return sortByValueDesc(Object.values(buckets))
    .slice(0, top)
    .map((b) => ({ key: b.key, name: b.display, value: b.recruitedCount, color: stableColorForKey(b.key) }));
}

export interface StatusSegment {
  label: string;
  count: number;
  color: string;
}

/**
 * Segmented bar trạng thái nguồn: succeeded/partial/failed/running/no-run.
 * Tổng count = số nguồn đang xét (mỗi nguồn rơi đúng một bucket).
 */
export function buildSourceStatusSegments(sources: ReportingSourceStatusRow[]): StatusSegment[] {
  const count = (statuses: ReportingSourceStatusRow["status"][]) =>
    sources.filter((s) => statuses.includes(s.status)).length;
  return [
    { label: "Đã đồng bộ", count: count(["covered"]), color: STATUS_COLORS.succeeded },
    { label: "Chưa đầy đủ", count: count(["incomplete"]), color: STATUS_COLORS.partial },
    { label: "Lỗi", count: count(["stale_snapshot", "never_succeeded"]), color: STATUS_COLORS.failed },
    { label: "Đang đồng bộ", count: count(["running"]), color: STATUS_COLORS.running },
    { label: "Chưa chạy", count: count(["no_run"]), color: STATUS_COLORS.noRun },
  ];
}
