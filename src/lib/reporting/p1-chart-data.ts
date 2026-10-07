/**
 * P1-T1-W04-R6 — Chart data helpers (thuần, không import VALUE từ module khác để Node test chạy được).
 *
 * Trả về COLOR SLOT ổn định (không phải hex) theo normalized key (hash deterministic).
 * Hex thật do theme registry resolve (chart-1..8 theo theme; semantic cố định).
 * Không tạo index-based random color.
 */

import { buildCompanyDisplayNames } from "../display/company-display-name.ts";
import type { ColorSlot, ChartSlot } from "../theme/theme-registry";

import type { ProjectProviderMix, ReportingBucket, ReportingSourceStatusRow } from "./p1-reporting";

export const CHART_SLOT_COUNT = 8; // mirror theme-registry (Node-test isolation)

/** Semantic slot cố định (amber/rose/slate) — sentinel + "Khác". */
export const UNKNOWN_SLOT: ColorSlot = "warning"; // amber — Không xác định
export const INVALID_SLOT: ColorSlot = "error"; // rose — Không hợp lệ
export const OTHER_SLOT: ColorSlot = "slate"; // slate — nhóm "Khác"

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function chartSlotForIndex(i: number): ChartSlot {
  return ("chart-" + (i + 1)) as ChartSlot;
}

/** Slot ổn định theo normalized key; sentinel luôn dùng slot semantic cố định. */
export function stableColorForKey(key: string): ColorSlot {
  if (key === "__unknown__") return UNKNOWN_SLOT;
  if (key === "__invalid__") return INVALID_SLOT;
  return chartSlotForIndex(hashString(key) % CHART_SLOT_COUNT);
}

export const STATUS_COLORS: Record<string, ColorSlot> = {
  succeeded: "success", // emerald
  partial: "warning", // amber
  failed: "error", // rose
  running: "running", // sky
  noRun: "slate", // slate
};

/** Tỷ lệ phần trăm an toàn: total <= 0 trả 0 (không NaN/Infinity). */
export function percentageOfTotal(count: number, total: number): number {
  if (total <= 0) return 0;
  return (count / total) * 100;
}

export interface ChartSegment {
  key: string;
  display: string;
  value: number;
  color: ColorSlot;
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
  color: ColorSlot;
  [k: string]: unknown;
}

export const PROJECT_DONUT_MAX_SLICES = 8;
export const OTHER_KEY = "__other__";

export interface ProjectDonutSlice {
  key: string;
  display: string;
  value: number;
  color: ColorSlot;
  percent: number;
  isOther?: boolean;
}

function isChartSlot(slot: ColorSlot): slot is ChartSlot {
  return slot.startsWith("chart-");
}

function chartSlotIndex(slot: ChartSlot): number {
  return Number(slot.slice("chart-".length)) - 1;
}

/** Đảm bảo hai lát chart LIỀN KỀ không trùng slot (deterministic; không đổi semantic). */
function resolveAdjacentSlots(base: ColorSlot[]): ColorSlot[] {
  const out = [...base];
  for (let i = 0; i < out.length; i++) {
    const slot = out[i];
    if (!isChartSlot(slot)) continue;
    const prev = i > 0 ? out[i - 1] : null;
    const next = i < out.length - 1 ? out[i + 1] : null;
    if (slot !== prev && slot !== next) continue;
    const start = chartSlotIndex(slot);
    for (let step = 1; step <= CHART_SLOT_COUNT; step++) {
      const cand = chartSlotForIndex((start + step) % CHART_SLOT_COUNT);
      if (cand !== prev && cand !== next) {
        out[i] = cand;
        break;
      }
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

  const baseColors: ColorSlot[] = slices.map((s) => (s.key === OTHER_KEY ? OTHER_SLOT : stableColorForKey(s.key)));
  const colors = resolveAdjacentSlots(baseColors);

  // P3-UI-COMPANY-DISPLAY-NAMES: nhan bieu do dung ten hien thi gon; ten phap ly
  // van la du lieu chuan cua read-model. Trung ten => fallback ten day du.
  const displayNames = buildCompanyDisplayNames(
    slices.map((s) => ({ key: s.key, fullName: s.display })));

  return slices.map((s, i) => ({
    key: s.key,
    display: displayNames.get(s.key) ?? s.display,
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
  color: ColorSlot;
}

/**
 * Segmented bar trạng thái nguồn: succeeded/partial/failed/running/no-run.
 * Tổng count = số nguồn đang xét (mỗi nguồn rơi đúng một bucket).
 */
// ---------------------------------------------------------------------------
// P1-T1-W04-R7 — view-model cho card "Tỷ lệ HRP/Vendor theo dự án"
// ---------------------------------------------------------------------------

/** Số dự án hiển thị mặc định trên biểu đồ (phần còn lại nằm trong "Xem chi tiết tất cả"). */
export const PROJECT_MIX_TOP = 10;

export interface ProjectMixSegment {
  slot: ColorSlot;
  label: string;
  value: number;
  /** % của projectTotal (4 segment cộng lại = 100 khi projectTotal > 0). */
  percent: number;
}

export interface ProjectMixRow {
  key: string;
  display: string;
  projectTotal: number;
  knownTotal: number;
  hrpCount: number;
  vendorCount: number;
  unknownCount: number;
  invalidCount: number;
  unclassified: number;
  hrpShare: number | null;
  vendorShare: number | null;
  knownCoverage: number | null;
  isSentinel: boolean;
  segments: ProjectMixSegment[];
}

/** Đảm bảo HRP và Vendor không trùng slot (hai phần chính phải phân biệt được). */
function distinctChartSlots(a: ColorSlot, b: ColorSlot): [ColorSlot, ColorSlot] {
  if (a !== b || !isChartSlot(a)) return [a, b];
  return [a, chartSlotForIndex((chartSlotIndex(a) + 1) % CHART_SLOT_COUNT)];
}

/**
 * Map ProjectProviderMix (read-model) -> row hiển thị: slot màu theo theme + % của projectTotal.
 * Không đổi giá trị/tổng; chỉ thêm màu và tỷ lệ phần trăm để render.
 */
export function buildProjectMixRows(mix: ProjectProviderMix[]): ProjectMixRow[] {
  const hrpBase = stableColorForKey("hrp");
  const vendorBase = stableColorForKey("vendor");
  const [hrpSlot, vendorSlot] = distinctChartSlots(hrpBase, vendorBase);
  // P3-UI-COMPANY-DISPLAY-NAMES: nhan cot/legend dung ten hien thi gon.
  const displayNames = buildCompanyDisplayNames(
    mix.map((m) => ({ key: m.projectKey, fullName: m.projectDisplay })));

  return mix.map((m) => ({
    key: m.projectKey,
    display: displayNames.get(m.projectKey) ?? m.projectDisplay,
    projectTotal: m.projectTotal,
    knownTotal: m.knownTotal,
    hrpCount: m.hrpCount,
    vendorCount: m.vendorCount,
    unknownCount: m.unknownCount,
    invalidCount: m.invalidCount,
    unclassified: m.unknownCount + m.invalidCount,
    hrpShare: m.hrpShare,
    vendorShare: m.vendorShare,
    knownCoverage: m.knownCoverage,
    isSentinel: m.projectKey === "__unknown__" || m.projectKey === "__invalid__",
    segments: [
      { slot: hrpSlot, label: "HRP", value: m.hrpCount, percent: percentageOfTotal(m.hrpCount, m.projectTotal) },
      { slot: vendorSlot, label: "Vendor", value: m.vendorCount, percent: percentageOfTotal(m.vendorCount, m.projectTotal) },
      { slot: UNKNOWN_SLOT, label: "Không xác định", value: m.unknownCount, percent: percentageOfTotal(m.unknownCount, m.projectTotal) },
      { slot: INVALID_SLOT, label: "Không hợp lệ", value: m.invalidCount, percent: percentageOfTotal(m.invalidCount, m.projectTotal) },
    ],
  }));
}

/**
 * Nhận xét toán học (không phải ngưỡng nghiệp vụ): bên nào chiếm > 50% trong phần đã phân loại.
 */
export function mixMajorityLabel(row: ProjectMixRow): string {
  if (row.knownTotal === 0) return "Không đủ dữ liệu phân loại";
  if (row.vendorShare !== null && row.vendorShare > 0.5) return "Vendor chiếm đa số";
  if (row.hrpShare !== null && row.hrpShare > 0.5) return "HRP chiếm đa số";
  return "Chia đều";
}

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
