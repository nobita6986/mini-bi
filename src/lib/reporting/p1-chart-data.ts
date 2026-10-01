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

export interface BarDatum {
  key: string;
  name: string;
  value: number;
  color: string;
  [k: string]: unknown;
}

export const PROJECT_DONUT_MAX_SLICES = 8;
export const OTHER_KEY = "__other__";
export const OTHER_COLOR = "#94a3b8"; // slate — nhóm "Khác"

export interface ProjectDonutSlice {
  key: string;
  display: string;
  value: number;
  color: string;
  percent: number;
  isOther?: boolean;
}

/** Đảm bảo hai lát LIỀN KỀ không trùng màu (deterministic; không đổi màu sentinel/other). */
function resolveAdjacentColors(base: string[]): string[] {
  const out = [...base];
  for (let i = 0; i < out.length; i++) {
    const prev = i > 0 ? out[i - 1] : null;
    const next = i < out.length - 1 ? out[i + 1] : null;
    if (out[i] !== prev && out[i] !== next) continue;
    const start = Math.max(0, (CATEGORY_PALETTE as readonly string[]).indexOf(out[i]));
    for (let step = 1; step <= CATEGORY_PALETTE.length; step++) {
      const cand = CATEGORY_PALETTE[(start + step) % CATEGORY_PALETTE.length];
      if (cand !== prev && cand !== next) { out[i] = cand; break; }
    }
  }
  return out;
}

/**
 * Donut "theo dự án": tối đa 8 dự án thường + "Khác" (gộp phần còn lại) + sentinel riêng.
 * Tổng value của mọi lát (kể cả "Khác") = tổng recruitedCount đầu vào.
 */
export function buildProjectDonutData(buckets: Record<string, ReportingBucket>): ProjectDonutSlice[] {
  const list = Object.values(buckets);
  const total = list.reduce((a, b) => a + b.recruitedCount, 0);
  const sorted = sortByValueDesc(list);
  const sentinels = sorted.filter((b) => b.key === "__unknown__" || b.key === "__invalid__");
  const regular = sorted.filter((b) => b.key !== "__unknown__" && b.key !== "__invalid__");

  const slices: ReportingBucket[] = [
    ...regular.slice(0, PROJECT_DONUT_MAX_SLICES),
    ...(regular.length > PROJECT_DONUT_MAX_SLICES
      ? [{ key: OTHER_KEY, display: "Khác", recruitedCount: regular.slice(PROJECT_DONUT_MAX_SLICES).reduce((a, b) => a + b.recruitedCount, 0) }]
      : []),
    ...sentinels,
  ];
  slices.sort((a, b) =>
    a.recruitedCount !== b.recruitedCount ? b.recruitedCount - a.recruitedCount : a.display.localeCompare(b.display, "vi")
  );

  const baseColors = slices.map((s) => (s.key === OTHER_KEY ? OTHER_COLOR : stableColorForKey(s.key)));
  const colors = resolveAdjacentColors(baseColors);

  return slices.map((s, i) => ({
    key: s.key,
    display: s.display,
    value: s.recruitedCount,
    color: colors[i],
    percent: percentageOfTotal(s.recruitedCount, total),
    isOther: s.key === OTHER_KEY,
  }));
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
