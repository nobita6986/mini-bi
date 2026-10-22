/**
 * MBI-DA-2026-01 — Chặng 2 / WF-01 & WF-02 (Items 2.1, 2.2, 2.3 & 2.4):
 *   2.1 Workforce Snapshot as-of date D (business-effective on non-superseded status events).
 *   2.2 Workforce Status Transitions in period [from, to] (initial vs state transitions).
 *   2.3 Workforce Period Balance & Opening/Closing Snapshot Reconciliation:
 *       opening(from - 1 day) + new_episode_inflow + transition_inflow - outflow = closing(to)
 *       for every status (ON, UNCONFIRMED, OFF, UNKNOWN).
 *   2.4 Waiting Time in UNCONFIRMED ("Đang chờ việc") Intervals & Placement Rate (UNCONFIRMED -> ON):
 *       evaluates contiguous UNCONFIRMED intervals on non-superseded events (never simple as_of - first_work_date
 *       when status changed), grouped by explicit sample populations (allWaiting, completedWaiting,
 *       placedToOn, exitedWithoutOn, currentlyWaiting) and period waiting window.
 *
 * Semantic rules locked by Master Plan §8, §9 (2.1–2.4), §10.1, §10.2:
 *   - Episode identity is `entry_id` (`direct_entries.entry_id`), NEVER unique worker/CCCD/name.
 *   - Frozen status vocabulary:
 *       ON          -> "Đang làm"
 *       UNCONFIRMED -> "Đang chờ việc" (never "Chưa xác nhận", never merged into ON or OFF)
 *       OFF         -> "Đã nghỉ"
 *       UNKNOWN     -> "Chưa xác định trạng thái" (episodes with first_work_date <= D but no active status event <= D)
 *   - Business-effective `as-of D`:
 *       Evaluates non-superseded events (`NOT EXISTS (SELECT 1 FROM ... r WHERE r.supersedes_event_id = ev.event_id)`)
 *       with `effective_date <= D`, ordered deterministically by
 *       `(effective_date DESC, version DESC)`.
 *       Note: This is business-effective as-of by `effective_date` (correction/supersession recomputes historical
 *       as-of by `effective_date`), NOT as-recorded time-travel by `applied_at`.
 *   - Pre-start episodes (`first_work_date > D`):
 *       Excluded from the workforce snapshot at D (`eligibleEpisodeTotal`) and tracked separately in `futureEpisodeCount`.
 *   - Period transitions in `[from, to]`:
 *       Walks each episode's non-superseded event chain ordered strictly by
 *       `(effective_date ASC, version ASC)` using `LAG(status)`:
 *       - `prev_status IS NULL` in `[from, to]` -> episode initial status (`INITIAL_ON`, `INITIAL_UNCONFIRMED`),
 *         kept strictly separate from state transitions. (`INITIAL_OFF` is not part of the creation flow and is not exposed as a KPI.)
 *       - `prev_status IS NOT NULL AND prev_status = status` -> no-op repeat status, NOT counted as a transition.
 *       - `prev_status IS NOT NULL AND prev_status <> status` in `[from, to]` -> true state transition (`prev_status -> status`),
 *         reporting both `eventCount` (transition events) and `episodeCount` (distinct `entry_id` episodes).
 *       - Rehire is a new episode (`entry_id`); `OFF -> ON` within the same episode is a legacy/in-episode transition, never labeled as rehire.
 *   - Non-attendance disclaimer (2.4):
 *       Days in `UNCONFIRMED` or `ON` reflect status duration on ledger events (`effective_date`), NEVER physical attendance / timesheet days.
 */

import { isRealCalendarDate, type ReportingFilters } from "./p1-filter.ts";
import { todayInHoChiMinh } from "./p1-date-presets.ts";
import { WORKER_STATUS_FROZEN_LABELS } from "./p1-period-comparison.ts";
import {
  resolveReportingAudienceProjection,
  type ReportingAudienceKind,
} from "./p3-w05a-audience.ts";

export { WORKER_STATUS_FROZEN_LABELS };

export const WORKFORCE_SNAPSHOT_STATUS_LABELS = Object.freeze({
  ON: WORKER_STATUS_FROZEN_LABELS.ON,
  UNCONFIRMED: WORKER_STATUS_FROZEN_LABELS.UNCONFIRMED,
  OFF: WORKER_STATUS_FROZEN_LABELS.OFF,
  UNKNOWN: "Chưa xác định trạng thái",
} as const);

export const WORKFORCE_TRANSITION_PAIR_LABELS = Object.freeze({
  UNCONFIRMED_TO_ON: "Đang chờ việc → Đang làm",
  UNCONFIRMED_TO_OFF: "Đang chờ việc → Đã nghỉ",
  ON_TO_OFF: "Đang làm → Đã nghỉ",
  OFF_TO_ON: "Đã nghỉ → Đang làm",
  OTHER: "Chuyển tiếp khác",
} as const);

export const WORKFORCE_INITIAL_STATUS_LABELS = Object.freeze({
  INITIAL_ON: "Khởi tạo mới: Đang làm",
  INITIAL_UNCONFIRMED: "Khởi tạo mới: Đang chờ việc",
} as const);

export const WORKFORCE_BALANCE_COLUMN_LABELS = Object.freeze({
  OPENING: "Đầu kỳ",
  NEW_INFLOW: "+ Mở mới",
  TRANSITION_INFLOW: "+ Chuyển vào",
  OUTFLOW: "− Chuyển ra",
  NET_CHANGE: "Biến động ròng",
  CLOSING: "Cuối kỳ",
} as const);

export const WORKFORCE_WAITING_SAMPLE_LABELS = Object.freeze({
  ALL_WAITING: "Tất cả hồ sơ có qua Đang chờ việc",
  COMPLETED_WAITING: "Đã kết thúc chờ việc (Đang làm + Đã nghỉ)",
  PLACED_TO_ON: "Đã kết thúc chờ — Bố trí sang Đang làm",
  EXITED_WITHOUT_ON: "Đã kết thúc chờ — Chuyển sang Đã nghỉ",
  CURRENTLY_WAITING: "Đang còn chờ việc tại ngày mốc",
} as const);

export const WORKFORCE_UNIT_METADATA_NOTE =
  "Đơn vị: hồ sơ lao động (entry_id) / sự kiện trạng thái (event_id) — không đồng nhất với người duy nhất. Tái tuyển dụng (rehire) tạo hồ sơ mới (entry_id riêng); chuyển tiếp Đã nghỉ → Đang làm trong cùng một entry_id không phải rehire. Khác với khối tuyển dụng Chặng 1 (lọc theo ngày báo cáo business_date), khối biến động nhân sự tính theo ngày bắt đầu làm việc (first_work_date) và ngày hiệu lực trạng thái (effective_date).";

export const WORKFORCE_NON_ATTENDANCE_NOTE =
  "Lưu ý nghiệp vụ: Số ngày chờ việc và thời gian duy trì trạng thái được tính từ khoảng cách ngày hiệu lực sự kiện (effective_date) trên chuỗi trạng thái Đang chờ việc / Đang làm đã khử hiệu chỉnh (non-superseded), hoàn toàn không phải dữ liệu chấm công hay ngày đi làm thực tế.";

export type WorkforceAsOfSource = "filter_to" | "current_hcm_date" | "explicit_as_of";

export type WorkforceStatusBucket = "ON" | "UNCONFIRMED" | "OFF" | "UNKNOWN";

export interface WorkforceAsOfSnapshot {
  /** Ngày mốc tính snapshot YYYY-MM-DD (theo Asia/Ho_Chi_Minh). */
  asOfDate: string;
  /** Nguồn xác định ngày asOfDate: từ bộ lọc `to` hoặc ngày hiện hành Asia/Ho_Chi_Minh. */
  asOfSource: WorkforceAsOfSource;
  /** Tổng số hồ sơ lao động (entry_id) hợp lệ trong scope có first_work_date <= asOfDate. */
  eligibleEpisodeTotal: number;
  /** Số hồ sơ có trạng thái hiệu lực tại asOfDate là ON ("Đang làm"). */
  onCount: number;
  /** Số hồ sơ có trạng thái hiệu lực tại asOfDate là UNCONFIRMED ("Đang chờ việc"). */
  unconfirmedCount: number;
  /** Số hồ sơ có trạng thái hiệu lực tại asOfDate là OFF ("Đã nghỉ"). */
  offCount: number;
  /** Số hồ sơ có first_work_date <= asOfDate nhưng thiếu/không xác định sự kiện trạng thái <= asOfDate. */
  unknownCount: number;
  /** Số hồ sơ hợp lệ trong scope có first_work_date > asOfDate (chưa bắt đầu làm việc tại ngày mốc). */
  futureEpisodeCount: number;
}

export interface WorkforceCountPair {
  /** Số sự kiện (event_id) ghi nhận trong kỳ. */
  eventCount: number;
  /** Số hồ sơ lao động (entry_id) phân biệt có sự kiện loại này trong kỳ. */
  episodeCount: number;
}

export type WorkforceTransitionsNotApplicableReason =
  | "all_time"
  | "one_sided"
  | "invalid_range";

export type WorkforcePeriodTransitions =
  | {
      applicable: true;
      fromDate: string;
      toDate: string;
      /** Sự kiện khởi tạo episode mới (prev_status IS NULL, status in ON/UNCONFIRMED) có effective_date trong [fromDate, toDate]. */
      initial: {
        total: WorkforceCountPair;
        on: WorkforceCountPair;
        unconfirmed: WorkforceCountPair;
      };
      /** Sự kiện chuyển trạng thái thực sự (prev_status IS NOT NULL AND prev_status <> status) trong [fromDate, toDate]. */
      pairs: {
        unconfirmedToOn: WorkforceCountPair;
        unconfirmedToOff: WorkforceCountPair;
        onToOff: WorkforceCountPair;
        offToOn: WorkforceCountPair;
        other: WorkforceCountPair;
      };
      /** Tổng hợp toàn bộ biến động chuyển trạng thái trong kỳ [fromDate, toDate]. */
      totals: {
        transitionEventCount: number;
        transitionEpisodeCount: number;
        noopRepeatEventCount: number;
        noopRepeatEpisodeCount: number;
      };
    }
  | {
      applicable: false;
      reason: WorkforceTransitionsNotApplicableReason;
      fromDate: string | null;
      toDate: string | null;
      windowLabel: string;
    };

/**
 * WF-02 (2.3): Dòng cân bằng biến động cho từng trạng thái S in {ON, UNCONFIRMED, OFF, UNKNOWN}.
 * Bảo toàn tuyệt đối phương trình:
 *   openingCount + newEpisodeInflowCount + transitionInflowCount - outflowCount === closingCount
 */
export interface WorkforceStatusBalanceRow {
  openingCount: number;
  newEpisodeInflowCount: number;
  transitionInflowCount: number;
  transitionInflowBySource: {
    fromOn: number;
    fromUnconfirmed: number;
    fromOff: number;
    fromUnknown: number;
  };
  totalInflowCount: number;
  outflowCount: number;
  outflowByTarget: {
    toOn: number;
    toUnconfirmed: number;
    toOff: number;
  };
  netChange: number;
  closingCount: number;
}

export type WorkforcePeriodBalance =
  | {
      applicable: true;
      fromDate: string;
      toDate: string;
      /** Ngày mốc đầu kỳ = fromDate - 1 ngày. */
      openingAsOfDate: string;
      /** Ngày mốc cuối kỳ = toDate. */
      closingAsOfDate: string;
      openingSnapshot: WorkforceAsOfSnapshot;
      closingSnapshot: WorkforceAsOfSnapshot;
      /** Hồ sơ mới bắt đầu trong kỳ (fromDate <= first_work_date <= toDate), phân theo trạng thái khởi điểm trong kỳ. */
      newEpisodesInPeriod: {
        total: number;
        initialOn: number;
        initialUnconfirmed: number;
        initialOff: number;
        initialUnknown: number;
      };
      byStatus: {
        on: WorkforceStatusBalanceRow;
        unconfirmed: WorkforceStatusBalanceRow;
        off: WorkforceStatusBalanceRow;
        unknown: WorkforceStatusBalanceRow;
      };
      totals: {
        openingEligibleTotal: number;
        newEpisodeTotal: number;
        transitionInflowTotal: number;
        transitionOutflowTotal: number;
        netEligibleChange: number;
        closingEligibleTotal: number;
      };
    }
  | {
      applicable: false;
      reason: WorkforceTransitionsNotApplicableReason;
      fromDate: string | null;
      toDate: string | null;
      windowLabel: string;
    };

/**
 * WF-02 (2.4): Chỉ số thời gian chờ việc (UNCONFIRMED) cho một tập mẫu (sample denominator) xác định.
 */
export interface WorkforceWaitingSampleMetrics {
  /** Mẫu số hồ sơ (entry_id) thuộc nhóm mẫu này. */
  episodeCount: number;
  /** Tổng số khoảng UNCONFIRMED liên tiếp (đã gộp no-op repeat) của các hồ sơ trong nhóm mẫu. */
  intervalCount: number;
  /** Tổng số ngày chờ việc (UNCONFIRMED) tích lũy của nhóm mẫu tính đến ngày mốc. */
  totalWaitingDays: number;
  /** Trung bình ngày chờ việc / hồ sơ trong nhóm mẫu (null nếu episodeCount === 0). */
  avgWaitingDaysPerEpisode: number | null;
  /** Trung bình ngày chờ việc / khoảng chờ trong nhóm mẫu (null nếu intervalCount === 0). */
  avgWaitingDaysPerInterval: number | null;
  /** Số ngày chờ việc lớn nhất của một hồ sơ trong nhóm mẫu (null nếu episodeCount === 0). */
  maxWaitingDays: number | null;
}

export interface WorkforcePeriodWaitingTransitionSummary {
  /** Số sự kiện kết thúc khoảng chờ (UNCONFIRMED -> ON hoặc OFF) có effective_date trong [fromDate, toDate]. */
  eventCount: number;
  /** Số hồ sơ (entry_id) phân biệt có sự kiện kết thúc khoảng chờ trong [fromDate, toDate]. */
  episodeCount: number;
  /** Tổng số ngày chờ của các khoảng UNCONFIRMED kết thúc trong [fromDate, toDate]. */
  totalWaitingDays: number;
  /** Trung bình ngày chờ / lần chuyển tiếp kết thúc trong kỳ (null nếu eventCount === 0). */
  avgWaitingDaysPerEvent: number | null;
  /** Trung bình ngày chờ / hồ sơ chuyển tiếp kết thúc trong kỳ (null nếu episodeCount === 0). */
  avgWaitingDaysPerEpisode: number | null;
}

export type WorkforcePeriodWaitingMetrics =
  | {
      applicable: true;
      fromDate: string;
      toDate: string;
      /** Số hồ sơ có khoảng UNCONFIRMED giao với kỳ [fromDate, toDate]. */
      activeWaitingEpisodeCount: number;
      /** Tổng số ngày ở trạng thái UNCONFIRMED bị cắt trong cửa sổ [fromDate, toDate]. */
      inPeriodWaitingDays: number;
      /** Trung bình số ngày chờ trong kỳ / hồ sơ có chờ việc trong kỳ (null nếu activeWaitingEpisodeCount === 0). */
      avgInPeriodWaitingDaysPerActiveEpisode: number | null;
      /** Các khoảng UNCONFIRMED được bố trí việc (chuyển sang ON) ngay trong kỳ [fromDate, toDate]. */
      placedInPeriod: WorkforcePeriodWaitingTransitionSummary;
      /** Các khoảng UNCONFIRMED nghỉ ngang (chuyển sang OFF) ngay trong kỳ [fromDate, toDate]. */
      exitedInPeriod: WorkforcePeriodWaitingTransitionSummary;
    }
  | {
      applicable: false;
      reason: WorkforceTransitionsNotApplicableReason;
      fromDate: string | null;
      toDate: string | null;
      windowLabel: string;
    };

export interface WorkforceWaitingMetrics {
  asOfDate: string;
  asOfSource: WorkforceAsOfSource;
  /** Tổng số hồ sơ hợp lệ tại asOfDate (bằng snapshot.eligibleEpisodeTotal). */
  eligibleEpisodeTotal: number;
  /** Tổng số hồ sơ hợp lệ tại asOfDate từng có ít nhất 1 khoảng UNCONFIRMED <= asOfDate. */
  waitingEpisodeTotal: number;
  /** Số hồ sơ hợp lệ vào thẳng trạng thái Đang làm (ON) mà không qua Đang chờ việc (UNCONFIRMED). */
  directOnEpisodeCount: number;
  /** Số hồ sơ hợp lệ có trạng thái đầu tiên là OFF và không qua UNCONFIRMED (legacy). */
  directOffEpisodeCount: number;
  /** Số hồ sơ hợp lệ chưa có sự kiện trạng thái <= asOfDate (bằng snapshot.unknownCount). */
  unknownEpisodeCount: number;
  /**
   * Tỷ lệ bố trí được việc trên tổng hồ sơ có chờ việc:
   * placedToOn.episodeCount / waitingEpisodeTotal (null nếu waitingEpisodeTotal === 0).
   */
  placementRateOfWaiting: number | null;
  /**
   * Tỷ lệ bố trí được việc trên tổng hồ sơ đã kết thúc chờ việc:
   * placedToOn.episodeCount / completedWaiting.episodeCount (null nếu completedWaiting.episodeCount === 0).
   */
  placementRateOfCompletedWaiting: number | null;
  /** Mẫu 1: Tất cả hồ sơ có qua Đang chờ việc (episodeCount === waitingEpisodeTotal). */
  allWaiting: WorkforceWaitingSampleMetrics;
  /** Mẫu 2: Hồ sơ đã kết thúc chờ việc tại asOfDate (placedToOn + exitedWithoutOn). */
  completedWaiting: WorkforceWaitingSampleMetrics;
  /** Mẫu 3: Hồ sơ đã kết thúc chờ và được bố trí sang Đang làm (UNCONFIRMED -> ON). */
  placedToOn: WorkforceWaitingSampleMetrics;
  /** Mẫu 4: Hồ sơ đã kết thúc chờ nhưng chuyển sang Đã nghỉ mà chưa từng lên ON. */
  exitedWithoutOn: WorkforceWaitingSampleMetrics;
  /** Mẫu 5: Hồ sơ hiện vẫn đang ở trạng thái Đang chờ việc tại asOfDate (episodeCount === snapshot.unconfirmedCount). */
  currentlyWaiting: WorkforceWaitingSampleMetrics;
  /** Thống kê thời gian chờ việc và bố trí việc cắt theo kỳ lọc [from, to]. */
  periodWaiting: WorkforcePeriodWaitingMetrics;
}

export type WorkforceReportingResult =
  | {
      status: "ready";
      snapshot: WorkforceAsOfSnapshot;
      transitions: WorkforcePeriodTransitions;
      balance: WorkforcePeriodBalance;
      waiting: WorkforceWaitingMetrics;
    }
  | {
      status: "unavailable";
      reason?: string;
    };

export interface WorkforceEpisodeRecord {
  entry_id: string;
  first_work_date: string;
  submission_state?: string | null;
  deleted_at?: string | null;
  voided_at?: string | null;
  scope_allowed?: boolean;
}

export interface WorkforceStatusEventRecord {
  event_id: string;
  entry_id: string;
  status: string;
  effective_date: string;
  version: number;
  supersedes_event_id?: string | null;
  applied_at?: string | null;
}

/**
 * Cộng/trừ số ngày trên chuỗi YYYY-MM-DD theo lịch dương thuần (UTC calendar arithmetic).
 */
export function shiftYmdDays(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Khoảng cách ngày lịch dương `endYmd - startYmd` (trả về số nguyên ngày).
 */
export function diffYmdDays(startYmd: string, endYmd: string): number {
  const [sy, sm, sd] = startYmd.split("-").map(Number);
  const [ey, em, ed] = endYmd.split("-").map(Number);
  const sMs = Date.UTC(sy, sm - 1, sd);
  const eMs = Date.UTC(ey, em - 1, ed);
  return Math.round((eMs - sMs) / 86_400_000);
}

/**
 * Xác định ngày mốc `asOfDate` cho Workforce Snapshot:
 * - Nếu có `asOfOverride` hợp lệ -> dùng `asOfOverride` (`explicit_as_of`).
 * - Nếu bộ lọc có `to` hợp lệ -> `asOfDate = to` (`filter_to`).
 * - Ngược lại -> dùng ngày hiện hành theo chuẩn `Asia/Ho_Chi_Minh` (`current_hcm_date`).
 */
export function resolveWorkforceAsOfDate(
  filters: Pick<ReportingFilters, "from" | "to">,
  options?: { asOfOverride?: string; referenceDate?: Date },
): { asOfDate: string; asOfSource: WorkforceAsOfSource } {
  const override = options?.asOfOverride?.trim() || "";
  if (override && isRealCalendarDate(override)) {
    return { asOfDate: override, asOfSource: "explicit_as_of" };
  }
  const rawTo = filters.to?.trim() || "";
  if (rawTo && isRealCalendarDate(rawTo)) {
    return { asOfDate: rawTo, asOfSource: "filter_to" };
  }
  const hcm = todayInHoChiMinh(options?.referenceDate ?? new Date());
  const ymd =
    typeof hcm === "string"
      ? hcm
      : `${hcm.y}-${String(hcm.m).padStart(2, "0")}-${String(hcm.d).padStart(2, "0")}`;
  return {
    asOfDate: ymd,
    asOfSource: "current_hcm_date",
  };
}

export function formatWorkforceTransitionsNotApplicableLabel(
  reason: WorkforceTransitionsNotApplicableReason,
): string {
  switch (reason) {
    case "all_time":
      return "Đang xem chế độ Tất cả thời gian — chọn đủ Từ ngày và Đến ngày để xem bảng biến động trạng thái theo kỳ.";
    case "one_sided":
      return "Bộ lọc chỉ có một mốc ngày — cần chọn đủ Từ ngày và Đến ngày để tổng hợp biến động trạng thái trong kỳ.";
    case "invalid_range":
      return "Khoảng ngày không hợp lệ để tổng hợp biến động trạng thái.";
  }
}

export function formatWorkforceBalanceNotApplicableLabel(
  reason: WorkforceTransitionsNotApplicableReason,
): string {
  switch (reason) {
    case "all_time":
      return "Đang xem chế độ Tất cả thời gian — chọn đủ Từ ngày và Đến ngày để đối soát cân bằng đầu kỳ / cuối kỳ.";
    case "one_sided":
      return "Bộ lọc chỉ có một mốc ngày — cần chọn đủ Từ ngày và Đến ngày để đối soát cân bằng đầu kỳ / cuối kỳ.";
    case "invalid_range":
      return "Khoảng ngày không hợp lệ để đối soát cân bằng đầu kỳ / cuối kỳ.";
  }
}

function compareEventsAsc(
  a: WorkforceStatusEventRecord,
  b: WorkforceStatusEventRecord,
): number {
  if (a.effective_date !== b.effective_date) {
    return a.effective_date < b.effective_date ? -1 : 1;
  }
  return a.version - b.version;
}

class CountAccumulator {
  eventCount = 0;
  readonly episodes = new Set<string>();

  add(entryId: string): void {
    this.eventCount += 1;
    this.episodes.add(entryId);
  }

  toPair(): WorkforceCountPair {
    return {
      eventCount: this.eventCount,
      episodeCount: this.episodes.size,
    };
  }
}

function normalizeStatusBucket(status: string | null | undefined): WorkforceStatusBucket {
  if (status === "ON" || status === "UNCONFIRMED" || status === "OFF") {
    return status;
  }
  return "UNKNOWN";
}

function computeSnapshotAtDate(
  eligibleEpisodes: ReadonlyMap<string, WorkforceEpisodeRecord>,
  eventsByEntry: ReadonlyMap<string, readonly WorkforceStatusEventRecord[]>,
  asOfDate: string,
  asOfSource: WorkforceAsOfSource,
): {
  snapshot: WorkforceAsOfSnapshot;
  statusByEntry: Map<string, WorkforceStatusBucket | "FUTURE">;
} {
  let eligibleEpisodeTotal = 0;
  let onCount = 0;
  let unconfirmedCount = 0;
  let offCount = 0;
  let unknownCount = 0;
  let futureEpisodeCount = 0;
  const statusByEntry = new Map<string, WorkforceStatusBucket | "FUTURE">();

  for (const ep of eligibleEpisodes.values()) {
    if (ep.first_work_date > asOfDate) {
      futureEpisodeCount += 1;
      statusByEntry.set(ep.entry_id, "FUTURE");
      continue;
    }
    eligibleEpisodeTotal += 1;
    const chain = eventsByEntry.get(ep.entry_id) ?? [];
    let chosen: WorkforceStatusEventRecord | null = null;
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      if (chain[i].effective_date <= asOfDate) {
        chosen = chain[i];
        break;
      }
    }
    const bucket = chosen ? normalizeStatusBucket(chosen.status) : "UNKNOWN";
    statusByEntry.set(ep.entry_id, bucket);
    if (bucket === "ON") {
      onCount += 1;
    } else if (bucket === "UNCONFIRMED") {
      unconfirmedCount += 1;
    } else if (bucket === "OFF") {
      offCount += 1;
    } else {
      unknownCount += 1;
    }
  }

  return {
    snapshot: {
      asOfDate,
      asOfSource,
      eligibleEpisodeTotal,
      onCount,
      unconfirmedCount,
      offCount,
      unknownCount,
      futureEpisodeCount,
    },
    statusByEntry,
  };
}

function buildWaitingSampleMetrics(
  episodeCount: number,
  intervalCount: number,
  totalWaitingDays: number,
  maxWaitingDays: number | null,
): WorkforceWaitingSampleMetrics {
  if (episodeCount <= 0) {
    return {
      episodeCount: 0,
      intervalCount: 0,
      totalWaitingDays: 0,
      avgWaitingDaysPerEpisode: null,
      avgWaitingDaysPerInterval: null,
      maxWaitingDays: null,
    };
  }
  return {
    episodeCount,
    intervalCount,
    totalWaitingDays,
    avgWaitingDaysPerEpisode: totalWaitingDays / episodeCount,
    avgWaitingDaysPerInterval: intervalCount > 0 ? totalWaitingDays / intervalCount : null,
    maxWaitingDays: maxWaitingDays ?? 0,
  };
}

function buildPeriodWaitingTransitionSummary(
  eventCount: number,
  episodeCount: number,
  totalWaitingDays: number,
): WorkforcePeriodWaitingTransitionSummary {
  return {
    eventCount,
    episodeCount,
    totalWaitingDays,
    avgWaitingDaysPerEvent: eventCount > 0 ? totalWaitingDays / eventCount : null,
    avgWaitingDaysPerEpisode: episodeCount > 0 ? totalWaitingDays / episodeCount : null,
  };
}

function computeWaitingMetricsAtAsOf(input: {
  eligibleEpisodes: ReadonlyMap<string, WorkforceEpisodeRecord>;
  eventsByEntry: ReadonlyMap<string, readonly WorkforceStatusEventRecord[]>;
  snapshot: WorkforceAsOfSnapshot;
  statusByEntryAtAsOf: ReadonlyMap<string, WorkforceStatusBucket | "FUTURE">;
  periodWindow:
    | { applicable: true; fromDate: string; toDate: string }
    | {
        applicable: false;
        reason: WorkforceTransitionsNotApplicableReason;
        fromDate: string | null;
        toDate: string | null;
      };
}): WorkforceWaitingMetrics {
  const { eligibleEpisodes, eventsByEntry, snapshot, statusByEntryAtAsOf, periodWindow } = input;
  const asOfDate = snapshot.asOfDate;

  let waitingEpisodeTotal = 0;
  let directOnEpisodeCount = 0;
  let directOffEpisodeCount = 0;
  let unknownEpisodeCount = 0;

  let allIntervalCount = 0;
  let allWaitingDays = 0;
  let allMaxWaitingDays: number | null = null;

  let completedEpCount = 0;
  let completedIntervalCount = 0;
  let completedWaitingDays = 0;
  let completedMaxWaitingDays: number | null = null;

  let placedEpCount = 0;
  let placedIntervalCount = 0;
  let placedWaitingDays = 0;
  let placedMaxWaitingDays: number | null = null;

  let exitedEpCount = 0;
  let exitedIntervalCount = 0;
  let exitedWaitingDays = 0;
  let exitedMaxWaitingDays: number | null = null;

  let currentEpCount = 0;
  let currentIntervalCount = 0;
  let currentWaitingDays = 0;
  let currentMaxWaitingDays: number | null = null;

  for (const ep of eligibleEpisodes.values()) {
    const asOfStatus = statusByEntryAtAsOf.get(ep.entry_id) ?? "FUTURE";
    if (asOfStatus === "FUTURE") continue;

    const fullChain = eventsByEntry.get(ep.entry_id) ?? [];
    // Khử các sự kiện no-op repeat (prev_status === status) và giới hạn effective_date <= asOfDate
    const distinctEvents: WorkforceStatusEventRecord[] = [];
    for (let i = 0; i < fullChain.length; i += 1) {
      const ev = fullChain[i];
      if (ev.effective_date > asOfDate) continue;
      const prevStatus = i === 0 ? null : fullChain[i - 1].status;
      if (prevStatus === null || prevStatus !== ev.status) {
        distinctEvents.push(ev);
      }
    }

    let intervalCount = 0;
    let totalEpisodeWaitingDays = 0;
    let placedToOn = false;

    for (let i = 0; i < distinctEvents.length; i += 1) {
      const ev = distinctEvents[i];
      if (ev.status !== "UNCONFIRMED") continue;
      const nextEv = i + 1 < distinctEvents.length ? distinctEvents[i + 1] : null;
      const endDate = nextEv ? nextEv.effective_date : asOfDate;
      const days = Math.max(0, diffYmdDays(ev.effective_date, endDate));
      intervalCount += 1;
      totalEpisodeWaitingDays += days;
      if (nextEv && nextEv.status === "ON") {
        placedToOn = true;
      }
    }

    if (intervalCount > 0) {
      waitingEpisodeTotal += 1;
      allIntervalCount += intervalCount;
      allWaitingDays += totalEpisodeWaitingDays;
      allMaxWaitingDays =
        allMaxWaitingDays === null
          ? totalEpisodeWaitingDays
          : Math.max(allMaxWaitingDays, totalEpisodeWaitingDays);

      if (asOfStatus === "UNCONFIRMED") {
        currentEpCount += 1;
        currentIntervalCount += intervalCount;
        currentWaitingDays += totalEpisodeWaitingDays;
        currentMaxWaitingDays =
          currentMaxWaitingDays === null
            ? totalEpisodeWaitingDays
            : Math.max(currentMaxWaitingDays, totalEpisodeWaitingDays);
      } else {
        completedEpCount += 1;
        completedIntervalCount += intervalCount;
        completedWaitingDays += totalEpisodeWaitingDays;
        completedMaxWaitingDays =
          completedMaxWaitingDays === null
            ? totalEpisodeWaitingDays
            : Math.max(completedMaxWaitingDays, totalEpisodeWaitingDays);

        if (placedToOn) {
          placedEpCount += 1;
          placedIntervalCount += intervalCount;
          placedWaitingDays += totalEpisodeWaitingDays;
          placedMaxWaitingDays =
            placedMaxWaitingDays === null
              ? totalEpisodeWaitingDays
              : Math.max(placedMaxWaitingDays, totalEpisodeWaitingDays);
        } else {
          exitedEpCount += 1;
          exitedIntervalCount += intervalCount;
          exitedWaitingDays += totalEpisodeWaitingDays;
          exitedMaxWaitingDays =
            exitedMaxWaitingDays === null
              ? totalEpisodeWaitingDays
              : Math.max(exitedMaxWaitingDays, totalEpisodeWaitingDays);
        }
      }
    } else if (asOfStatus === "UNKNOWN" || distinctEvents.length === 0) {
      unknownEpisodeCount += 1;
    } else if (distinctEvents[0].status === "ON") {
      directOnEpisodeCount += 1;
    } else if (distinctEvents[0].status === "OFF") {
      directOffEpisodeCount += 1;
    } else {
      unknownEpisodeCount += 1;
    }
  }

  let periodWaiting: WorkforcePeriodWaitingMetrics;
  if (!periodWindow.applicable) {
    periodWaiting = {
      applicable: false,
      reason: periodWindow.reason,
      fromDate: periodWindow.fromDate,
      toDate: periodWindow.toDate,
      windowLabel: formatWorkforceTransitionsNotApplicableLabel(periodWindow.reason),
    };
  } else {
    const { fromDate, toDate } = periodWindow;
    const activeWaitingEpisodes = new Set<string>();
    let inPeriodWaitingDays = 0;
    let placedEventCount = 0;
    const placedEpisodes = new Set<string>();
    let placedPeriodWaitingDays = 0;
    let exitedEventCount = 0;
    const exitedEpisodes = new Set<string>();
    let exitedPeriodWaitingDays = 0;

    for (const ep of eligibleEpisodes.values()) {
      if (ep.first_work_date > toDate) continue;
      const fullChain = eventsByEntry.get(ep.entry_id) ?? [];
      const distinctEvents: WorkforceStatusEventRecord[] = [];
      for (let i = 0; i < fullChain.length; i += 1) {
        const ev = fullChain[i];
        if (ev.effective_date > toDate) continue;
        const prevStatus = i === 0 ? null : fullChain[i - 1].status;
        if (prevStatus === null || prevStatus !== ev.status) {
          distinctEvents.push(ev);
        }
      }

      for (let i = 0; i < distinctEvents.length; i += 1) {
        const ev = distinctEvents[i];
        if (ev.status !== "UNCONFIRMED") continue;
        const nextEv = i + 1 < distinctEvents.length ? distinctEvents[i + 1] : null;
        const endDate = nextEv ? nextEv.effective_date : toDate;
        const fullDays = Math.max(0, diffYmdDays(ev.effective_date, endDate));
        const clippedStart = ev.effective_date > fromDate ? ev.effective_date : fromDate;
        const clippedEnd = endDate < toDate ? endDate : toDate;
        const clippedDays = Math.max(0, diffYmdDays(clippedStart, clippedEnd));

        if (ev.effective_date <= toDate && endDate >= fromDate) {
          activeWaitingEpisodes.add(ep.entry_id);
          inPeriodWaitingDays += clippedDays;
        }

        if (nextEv && nextEv.effective_date >= fromDate && nextEv.effective_date <= toDate) {
          if (nextEv.status === "ON") {
            placedEventCount += 1;
            placedEpisodes.add(ep.entry_id);
            placedPeriodWaitingDays += fullDays;
          } else if (nextEv.status === "OFF") {
            exitedEventCount += 1;
            exitedEpisodes.add(ep.entry_id);
            exitedPeriodWaitingDays += fullDays;
          }
        }
      }
    }

    const activeWaitingEpisodeCount = activeWaitingEpisodes.size;
    periodWaiting = {
      applicable: true,
      fromDate,
      toDate,
      activeWaitingEpisodeCount,
      inPeriodWaitingDays,
      avgInPeriodWaitingDaysPerActiveEpisode:
        activeWaitingEpisodeCount > 0 ? inPeriodWaitingDays / activeWaitingEpisodeCount : null,
      placedInPeriod: buildPeriodWaitingTransitionSummary(
        placedEventCount,
        placedEpisodes.size,
        placedPeriodWaitingDays,
      ),
      exitedInPeriod: buildPeriodWaitingTransitionSummary(
        exitedEventCount,
        exitedEpisodes.size,
        exitedPeriodWaitingDays,
      ),
    };
  }

  return {
    asOfDate,
    asOfSource: snapshot.asOfSource,
    eligibleEpisodeTotal: snapshot.eligibleEpisodeTotal,
    waitingEpisodeTotal,
    directOnEpisodeCount,
    directOffEpisodeCount,
    unknownEpisodeCount,
    placementRateOfWaiting:
      waitingEpisodeTotal > 0 ? placedEpCount / waitingEpisodeTotal : null,
    placementRateOfCompletedWaiting:
      completedEpCount > 0 ? placedEpCount / completedEpCount : null,
    allWaiting: buildWaitingSampleMetrics(
      waitingEpisodeTotal,
      allIntervalCount,
      allWaitingDays,
      allMaxWaitingDays,
    ),
    completedWaiting: buildWaitingSampleMetrics(
      completedEpCount,
      completedIntervalCount,
      completedWaitingDays,
      completedMaxWaitingDays,
    ),
    placedToOn: buildWaitingSampleMetrics(
      placedEpCount,
      placedIntervalCount,
      placedWaitingDays,
      placedMaxWaitingDays,
    ),
    exitedWithoutOn: buildWaitingSampleMetrics(
      exitedEpCount,
      exitedIntervalCount,
      exitedWaitingDays,
      exitedMaxWaitingDays,
    ),
    currentlyWaiting: buildWaitingSampleMetrics(
      currentEpCount,
      currentIntervalCount,
      currentWaitingDays,
      currentMaxWaitingDays,
    ),
    periodWaiting,
  };
}

/**
 * Hàm thuần tính toán:
 * - 2.1 Workforce Snapshot `as-of`
 * - 2.2 Status Transitions trong kỳ `[from, to]`
 * - 2.3 Cân bằng biến động đầu kỳ (`from - 1`) / cuối kỳ (`to`)
 * - 2.4 Thời gian chờ việc (`UNCONFIRMED`) và tỷ lệ bố trí được việc (`UNCONFIRMED -> ON`)
 * theo đúng hợp đồng business-effective `effective_date <= asOfDate` trên chuỗi sự kiện đã khử `superseded`.
 */
export function evaluateWorkforceSnapshotAndTransitions(input: {
  episodes: readonly WorkforceEpisodeRecord[];
  events: readonly WorkforceStatusEventRecord[];
  filters: Pick<ReportingFilters, "from" | "to">;
  asOfOverride?: string;
  referenceDate?: Date;
}): {
  snapshot: WorkforceAsOfSnapshot;
  transitions: WorkforcePeriodTransitions;
  balance: WorkforcePeriodBalance;
  waiting: WorkforceWaitingMetrics;
} {
  const { asOfDate, asOfSource } = resolveWorkforceAsOfDate(input.filters, {
    asOfOverride: input.asOfOverride,
    referenceDate: input.referenceDate,
  });

  // 1. Lọc các hồ sơ lao động (episodes) hợp lệ trong scope:
  //    submission_state === 'SUBMITTED', deleted_at IS NULL, voided_at IS NULL, scope_allowed !== false.
  const eligibleEpisodes = new Map<string, WorkforceEpisodeRecord>();
  for (const ep of input.episodes) {
    if (!ep || typeof ep.entry_id !== "string" || ep.entry_id.trim() === "") continue;
    if (ep.scope_allowed === false) continue;
    if (ep.submission_state !== undefined && ep.submission_state !== "SUBMITTED") continue;
    if (ep.deleted_at !== undefined && ep.deleted_at !== null) continue;
    if (ep.voided_at !== undefined && ep.voided_at !== null) continue;
    if (!isRealCalendarDate(ep.first_work_date)) continue;
    eligibleEpisodes.set(ep.entry_id, ep);
  }

  // 2. Khử các sự kiện đã bị superseded (NOT EXISTS r WHERE r.supersedes_event_id = ev.event_id).
  const supersededEventIds = new Set<string>();
  for (const ev of input.events) {
    if (ev && typeof ev.supersedes_event_id === "string" && ev.supersedes_event_id.trim() !== "") {
      supersededEventIds.add(ev.supersedes_event_id);
    }
  }

  // Gom chuỗi sự kiện hiệu lực theo từng entry_id và sắp xếp tất định tăng dần.
  const eventsByEntry = new Map<string, WorkforceStatusEventRecord[]>();
  for (const ev of input.events) {
    if (!ev || typeof ev.event_id !== "string" || ev.event_id.trim() === "") continue;
    if (!eligibleEpisodes.has(ev.entry_id)) continue;
    if (supersededEventIds.has(ev.event_id)) continue;
    if (!isRealCalendarDate(ev.effective_date)) continue;
    const list = eventsByEntry.get(ev.entry_id);
    if (list) {
      list.push(ev);
    } else {
      eventsByEntry.set(ev.entry_id, [ev]);
    }
  }
  for (const list of eventsByEntry.values()) {
    list.sort(compareEventsAsc);
  }

  // 3. Tính 2.1 Snapshot as-of tại asOfDate:
  const { snapshot, statusByEntry: statusByEntryAtAsOf } = computeSnapshotAtDate(
    eligibleEpisodes,
    eventsByEntry,
    asOfDate,
    asOfSource,
  );

  // 4. Kiểm tra tính hợp lệ của kỳ [from, to] cho 2.2, 2.3 và 2.4:
  const rawFrom = input.filters.from?.trim() || "";
  const rawTo = input.filters.to?.trim() || "";

  if (!rawFrom && !rawTo) {
    const waiting = computeWaitingMetricsAtAsOf({
      eligibleEpisodes,
      eventsByEntry,
      snapshot,
      statusByEntryAtAsOf,
      periodWindow: { applicable: false, reason: "all_time", fromDate: null, toDate: null },
    });
    return {
      snapshot,
      transitions: {
        applicable: false,
        reason: "all_time",
        fromDate: null,
        toDate: null,
        windowLabel: formatWorkforceTransitionsNotApplicableLabel("all_time"),
      },
      balance: {
        applicable: false,
        reason: "all_time",
        fromDate: null,
        toDate: null,
        windowLabel: formatWorkforceBalanceNotApplicableLabel("all_time"),
      },
      waiting,
    };
  }

  if (!rawFrom || !rawTo) {
    const waiting = computeWaitingMetricsAtAsOf({
      eligibleEpisodes,
      eventsByEntry,
      snapshot,
      statusByEntryAtAsOf,
      periodWindow: {
        applicable: false,
        reason: "one_sided",
        fromDate: rawFrom || null,
        toDate: rawTo || null,
      },
    });
    return {
      snapshot,
      transitions: {
        applicable: false,
        reason: "one_sided",
        fromDate: rawFrom || null,
        toDate: rawTo || null,
        windowLabel: formatWorkforceTransitionsNotApplicableLabel("one_sided"),
      },
      balance: {
        applicable: false,
        reason: "one_sided",
        fromDate: rawFrom || null,
        toDate: rawTo || null,
        windowLabel: formatWorkforceBalanceNotApplicableLabel("one_sided"),
      },
      waiting,
    };
  }

  if (!isRealCalendarDate(rawFrom) || !isRealCalendarDate(rawTo) || rawFrom > rawTo) {
    const waiting = computeWaitingMetricsAtAsOf({
      eligibleEpisodes,
      eventsByEntry,
      snapshot,
      statusByEntryAtAsOf,
      periodWindow: {
        applicable: false,
        reason: "invalid_range",
        fromDate: rawFrom,
        toDate: rawTo,
      },
    });
    return {
      snapshot,
      transitions: {
        applicable: false,
        reason: "invalid_range",
        fromDate: rawFrom,
        toDate: rawTo,
        windowLabel: formatWorkforceTransitionsNotApplicableLabel("invalid_range"),
      },
      balance: {
        applicable: false,
        reason: "invalid_range",
        fromDate: rawFrom,
        toDate: rawTo,
        windowLabel: formatWorkforceBalanceNotApplicableLabel("invalid_range"),
      },
      waiting,
    };
  }

  // 5. Tính 2.2 Biến động trạng thái trong kỳ [rawFrom, rawTo]:
  const initialTotal = new CountAccumulator();
  const initialOn = new CountAccumulator();
  const initialUnconfirmed = new CountAccumulator();

  const unconfirmedToOn = new CountAccumulator();
  const unconfirmedToOff = new CountAccumulator();
  const onToOff = new CountAccumulator();
  const offToOn = new CountAccumulator();
  const otherPair = new CountAccumulator();
  const allTransitions = new CountAccumulator();
  const noopRepeats = new CountAccumulator();

  for (const ep of eligibleEpisodes.values()) {
    if (ep.first_work_date > rawTo) continue;
    const chain = eventsByEntry.get(ep.entry_id) ?? [];
    for (let i = 0; i < chain.length; i += 1) {
      const ev = chain[i];
      const prevStatus = i === 0 ? null : chain[i - 1].status;
      if (ev.effective_date < rawFrom || ev.effective_date > rawTo) {
        continue;
      }
      if (prevStatus === null) {
        if (ev.status === "ON") {
          initialTotal.add(ep.entry_id);
          initialOn.add(ep.entry_id);
        } else if (ev.status === "UNCONFIRMED") {
          initialTotal.add(ep.entry_id);
          initialUnconfirmed.add(ep.entry_id);
        }
      } else if (prevStatus === ev.status) {
        noopRepeats.add(ep.entry_id);
      } else {
        allTransitions.add(ep.entry_id);
        if (prevStatus === "UNCONFIRMED" && ev.status === "ON") {
          unconfirmedToOn.add(ep.entry_id);
        } else if (prevStatus === "UNCONFIRMED" && ev.status === "OFF") {
          unconfirmedToOff.add(ep.entry_id);
        } else if (prevStatus === "ON" && ev.status === "OFF") {
          onToOff.add(ep.entry_id);
        } else if (prevStatus === "OFF" && ev.status === "ON") {
          offToOn.add(ep.entry_id);
        } else {
          otherPair.add(ep.entry_id);
        }
      }
    }
  }

  // 6. Tính 2.3 Cân bằng biến động đầu kỳ (rawFrom - 1 ngày) / cuối kỳ (rawTo):
  const openingAsOfDate = shiftYmdDays(rawFrom, -1);
  const closingAsOfDate = rawTo;
  const { snapshot: openingSnapshot } = computeSnapshotAtDate(
    eligibleEpisodes,
    eventsByEntry,
    openingAsOfDate,
    "explicit_as_of",
  );
  const { snapshot: closingSnapshot } = computeSnapshotAtDate(
    eligibleEpisodes,
    eventsByEntry,
    closingAsOfDate,
    "filter_to",
  );

  let newTotalCount = 0;
  let newOnCount = 0;
  let newUnconfirmedCount = 0;
  let newOffCount = 0;
  let newUnknownCount = 0;

  let onTransIn = 0;
  let onInFromUnconfirmed = 0;
  let onInFromOff = 0;
  let onInFromUnknown = 0;
  let onTransOut = 0;
  let onOutToOff = 0;
  let onOutToUnconfirmed = 0;

  let unconfirmedTransIn = 0;
  let unconfirmedInFromOn = 0;
  let unconfirmedInFromOff = 0;
  let unconfirmedInFromUnknown = 0;
  let unconfirmedTransOut = 0;
  let unconfirmedOutToOn = 0;
  let unconfirmedOutToOff = 0;

  let offTransIn = 0;
  let offInFromOn = 0;
  let offInFromUnconfirmed = 0;
  let offInFromUnknown = 0;
  let offTransOut = 0;
  let offOutToOn = 0;
  let offOutToUnconfirmed = 0;

  let unknownTransIn = 0;
  let unknownTransOut = 0;
  let unknownOutToOn = 0;
  let unknownOutToUnconfirmed = 0;
  let unknownOutToOff = 0;

  for (const ep of eligibleEpisodes.values()) {
    if (ep.first_work_date > rawTo) continue;
    const chain = eventsByEntry.get(ep.entry_id) ?? [];
    const isNewInPeriod = ep.first_work_date >= rawFrom;

    let preEv: WorkforceStatusEventRecord | null = null;
    let firstInPeriodEv: WorkforceStatusEventRecord | null = null;
    for (let i = 0; i < chain.length; i += 1) {
      const ev = chain[i];
      if (ev.effective_date < rawFrom) {
        preEv = ev;
      } else if (ev.effective_date <= rawTo && firstInPeriodEv === null) {
        firstInPeriodEv = ev;
      }
    }

    let consumedInitialEventId: string | null = null;
    if (isNewInPeriod) {
      newTotalCount += 1;
      let newEntryStatus: WorkforceStatusBucket = "UNKNOWN";
      if (preEv) {
        newEntryStatus = normalizeStatusBucket(preEv.status);
      } else if (firstInPeriodEv) {
        newEntryStatus = normalizeStatusBucket(firstInPeriodEv.status);
        consumedInitialEventId = firstInPeriodEv.event_id;
      }
      if (newEntryStatus === "ON") newOnCount += 1;
      else if (newEntryStatus === "UNCONFIRMED") newUnconfirmedCount += 1;
      else if (newEntryStatus === "OFF") newOffCount += 1;
      else newUnknownCount += 1;
    }

    for (let i = 0; i < chain.length; i += 1) {
      const ev = chain[i];
      if (ev.effective_date < rawFrom || ev.effective_date > rawTo) continue;
      if (consumedInitialEventId !== null && ev.event_id === consumedInitialEventId) continue;

      const prevRaw = i === 0 ? null : chain[i - 1].status;
      const fromStatus = normalizeStatusBucket(prevRaw);
      const toStatus = normalizeStatusBucket(ev.status);
      if (fromStatus === toStatus) continue;

      if (toStatus === "ON") {
        onTransIn += 1;
        if (fromStatus === "UNCONFIRMED") onInFromUnconfirmed += 1;
        else if (fromStatus === "OFF") onInFromOff += 1;
        else if (fromStatus === "UNKNOWN") onInFromUnknown += 1;
      } else if (toStatus === "UNCONFIRMED") {
        unconfirmedTransIn += 1;
        if (fromStatus === "ON") unconfirmedInFromOn += 1;
        else if (fromStatus === "OFF") unconfirmedInFromOff += 1;
        else if (fromStatus === "UNKNOWN") unconfirmedInFromUnknown += 1;
      } else if (toStatus === "OFF") {
        offTransIn += 1;
        if (fromStatus === "ON") offInFromOn += 1;
        else if (fromStatus === "UNCONFIRMED") offInFromUnconfirmed += 1;
        else if (fromStatus === "UNKNOWN") offInFromUnknown += 1;
      } else {
        unknownTransIn += 1;
      }

      if (fromStatus === "ON") {
        onTransOut += 1;
        if (toStatus === "OFF") onOutToOff += 1;
        else if (toStatus === "UNCONFIRMED") onOutToUnconfirmed += 1;
      } else if (fromStatus === "UNCONFIRMED") {
        unconfirmedTransOut += 1;
        if (toStatus === "ON") unconfirmedOutToOn += 1;
        else if (toStatus === "OFF") unconfirmedOutToOff += 1;
      } else if (fromStatus === "OFF") {
        offTransOut += 1;
        if (toStatus === "ON") offOutToOn += 1;
        else if (toStatus === "UNCONFIRMED") offOutToUnconfirmed += 1;
      } else {
        unknownTransOut += 1;
        if (toStatus === "ON") unknownOutToOn += 1;
        else if (toStatus === "UNCONFIRMED") unknownOutToUnconfirmed += 1;
        else if (toStatus === "OFF") unknownOutToOff += 1;
      }
    }
  }

  const balance: WorkforcePeriodBalance = {
    applicable: true,
    fromDate: rawFrom,
    toDate: rawTo,
    openingAsOfDate,
    closingAsOfDate,
    openingSnapshot,
    closingSnapshot,
    newEpisodesInPeriod: {
      total: newTotalCount,
      initialOn: newOnCount,
      initialUnconfirmed: newUnconfirmedCount,
      initialOff: newOffCount,
      initialUnknown: newUnknownCount,
    },
    byStatus: {
      on: {
        openingCount: openingSnapshot.onCount,
        newEpisodeInflowCount: newOnCount,
        transitionInflowCount: onTransIn,
        transitionInflowBySource: {
          fromOn: 0,
          fromUnconfirmed: onInFromUnconfirmed,
          fromOff: onInFromOff,
          fromUnknown: onInFromUnknown,
        },
        totalInflowCount: newOnCount + onTransIn,
        outflowCount: onTransOut,
        outflowByTarget: {
          toOn: 0,
          toUnconfirmed: onOutToUnconfirmed,
          toOff: onOutToOff,
        },
        netChange: newOnCount + onTransIn - onTransOut,
        closingCount: closingSnapshot.onCount,
      },
      unconfirmed: {
        openingCount: openingSnapshot.unconfirmedCount,
        newEpisodeInflowCount: newUnconfirmedCount,
        transitionInflowCount: unconfirmedTransIn,
        transitionInflowBySource: {
          fromOn: unconfirmedInFromOn,
          fromUnconfirmed: 0,
          fromOff: unconfirmedInFromOff,
          fromUnknown: unconfirmedInFromUnknown,
        },
        totalInflowCount: newUnconfirmedCount + unconfirmedTransIn,
        outflowCount: unconfirmedTransOut,
        outflowByTarget: {
          toOn: unconfirmedOutToOn,
          toUnconfirmed: 0,
          toOff: unconfirmedOutToOff,
        },
        netChange: newUnconfirmedCount + unconfirmedTransIn - unconfirmedTransOut,
        closingCount: closingSnapshot.unconfirmedCount,
      },
      off: {
        openingCount: openingSnapshot.offCount,
        newEpisodeInflowCount: newOffCount,
        transitionInflowCount: offTransIn,
        transitionInflowBySource: {
          fromOn: offInFromOn,
          fromUnconfirmed: offInFromUnconfirmed,
          fromOff: 0,
          fromUnknown: offInFromUnknown,
        },
        totalInflowCount: newOffCount + offTransIn,
        outflowCount: offTransOut,
        outflowByTarget: {
          toOn: offOutToOn,
          toUnconfirmed: offOutToUnconfirmed,
          toOff: 0,
        },
        netChange: newOffCount + offTransIn - offTransOut,
        closingCount: closingSnapshot.offCount,
      },
      unknown: {
        openingCount: openingSnapshot.unknownCount,
        newEpisodeInflowCount: newUnknownCount,
        transitionInflowCount: unknownTransIn,
        transitionInflowBySource: {
          fromOn: 0,
          fromUnconfirmed: 0,
          fromOff: 0,
          fromUnknown: 0,
        },
        totalInflowCount: newUnknownCount + unknownTransIn,
        outflowCount: unknownTransOut,
        outflowByTarget: {
          toOn: unknownOutToOn,
          toUnconfirmed: unknownOutToUnconfirmed,
          toOff: unknownOutToOff,
        },
        netChange: newUnknownCount + unknownTransIn - unknownTransOut,
        closingCount: closingSnapshot.unknownCount,
      },
    },
    totals: {
      openingEligibleTotal: openingSnapshot.eligibleEpisodeTotal,
      newEpisodeTotal: newTotalCount,
      transitionInflowTotal: onTransIn + unconfirmedTransIn + offTransIn + unknownTransIn,
      transitionOutflowTotal: onTransOut + unconfirmedTransOut + offTransOut + unknownTransOut,
      netEligibleChange: newTotalCount,
      closingEligibleTotal: closingSnapshot.eligibleEpisodeTotal,
    },
  };

  // 7. Tính 2.4 Thời gian chờ việc và tỷ lệ bố trí được việc:
  const waiting = computeWaitingMetricsAtAsOf({
    eligibleEpisodes,
    eventsByEntry,
    snapshot,
    statusByEntryAtAsOf,
    periodWindow: { applicable: true, fromDate: rawFrom, toDate: rawTo },
  });

  return {
    snapshot,
    transitions: {
      applicable: true,
      fromDate: rawFrom,
      toDate: rawTo,
      initial: {
        total: initialTotal.toPair(),
        on: initialOn.toPair(),
        unconfirmed: initialUnconfirmed.toPair(),
      },
      pairs: {
        unconfirmedToOn: unconfirmedToOn.toPair(),
        unconfirmedToOff: unconfirmedToOff.toPair(),
        onToOff: onToOff.toPair(),
        offToOn: offToOn.toPair(),
        other: otherPair.toPair(),
      },
      totals: {
        transitionEventCount: allTransitions.eventCount,
        transitionEpisodeCount: allTransitions.episodes.size,
        noopRepeatEventCount: noopRepeats.eventCount,
        noopRepeatEpisodeCount: noopRepeats.episodes.size,
      },
    },
    balance,
    waiting,
  };
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function finiteInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function parseCountPair(raw: unknown): WorkforceCountPair | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const eventCount = nonNegativeInt(r.event_count);
  const episodeCount = nonNegativeInt(r.episode_count);
  if (eventCount === null || episodeCount === null) return null;
  if (episodeCount > eventCount) return null;
  return { eventCount, episodeCount };
}

function parseSnapshotSection(
  snapRaw: unknown,
): { ok: true; snapshot: WorkforceAsOfSnapshot } | { ok: false; reason: string } {
  if (typeof snapRaw !== "object" || snapRaw === null) {
    return { ok: false, reason: "invalid_snapshot_fields" };
  }
  const s = snapRaw as Record<string, unknown>;
  const asOfDate = typeof s.as_of_date === "string" ? s.as_of_date : "";
  const asOfSourceRaw = s.as_of_source;
  const asOfSource: WorkforceAsOfSource | null =
    asOfSourceRaw === "filter_to" ||
    asOfSourceRaw === "current_hcm_date" ||
    asOfSourceRaw === "explicit_as_of"
      ? asOfSourceRaw
      : null;

  const eligibleEpisodeTotal = nonNegativeInt(s.eligible_episode_total);
  const onCount = nonNegativeInt(s.on_count);
  const unconfirmedCount = nonNegativeInt(s.unconfirmed_count);
  const offCount = nonNegativeInt(s.off_count);
  const unknownCount = nonNegativeInt(s.unknown_count);
  const futureEpisodeCount = nonNegativeInt(s.future_episode_count);

  if (
    !isRealCalendarDate(asOfDate) ||
    asOfSource === null ||
    eligibleEpisodeTotal === null ||
    onCount === null ||
    unconfirmedCount === null ||
    offCount === null ||
    unknownCount === null ||
    futureEpisodeCount === null
  ) {
    return { ok: false, reason: "invalid_snapshot_fields" };
  }

  if (onCount + unconfirmedCount + offCount + unknownCount !== eligibleEpisodeTotal) {
    return { ok: false, reason: "snapshot_sum_invariant_violated" };
  }

  return {
    ok: true,
    snapshot: {
      asOfDate,
      asOfSource,
      eligibleEpisodeTotal,
      onCount,
      unconfirmedCount,
      offCount,
      unknownCount,
      futureEpisodeCount,
    },
  };
}

function parseStatusBalanceRow(
  raw: unknown,
  statusKey: "on" | "unconfirmed" | "off" | "unknown",
  expectedOpening: number,
  expectedNewInflow: number,
  expectedClosing: number,
): { ok: true; row: WorkforceStatusBalanceRow } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "invalid_balance_status_row" };
  }
  const r = raw as Record<string, unknown>;
  const openingCount = nonNegativeInt(r.opening_count);
  const newEpisodeInflowCount = nonNegativeInt(r.new_episode_inflow_count);
  const transitionInflowCount = nonNegativeInt(r.transition_inflow_count);
  const totalInflowCount = nonNegativeInt(r.total_inflow_count);
  const outflowCount = nonNegativeInt(r.outflow_count);
  const netChange = finiteInt(r.net_change);
  const closingCount = nonNegativeInt(r.closing_count);

  const inBySourceRaw =
    typeof r.transition_inflow_by_source === "object" && r.transition_inflow_by_source !== null
      ? (r.transition_inflow_by_source as Record<string, unknown>)
      : null;
  const outByTargetRaw =
    typeof r.outflow_by_target === "object" && r.outflow_by_target !== null
      ? (r.outflow_by_target as Record<string, unknown>)
      : null;

  if (
    openingCount === null ||
    newEpisodeInflowCount === null ||
    transitionInflowCount === null ||
    totalInflowCount === null ||
    outflowCount === null ||
    netChange === null ||
    closingCount === null ||
    !inBySourceRaw ||
    !outByTargetRaw
  ) {
    return { ok: false, reason: "invalid_balance_status_row" };
  }

  const fromOn = nonNegativeInt(inBySourceRaw.from_on);
  const fromUnconfirmed = nonNegativeInt(inBySourceRaw.from_unconfirmed);
  const fromOff = nonNegativeInt(inBySourceRaw.from_off);
  const fromUnknown = nonNegativeInt(inBySourceRaw.from_unknown);

  const toOn = nonNegativeInt(outByTargetRaw.to_on);
  const toUnconfirmed = nonNegativeInt(outByTargetRaw.to_unconfirmed);
  const toOff = nonNegativeInt(outByTargetRaw.to_off);

  if (
    fromOn === null ||
    fromUnconfirmed === null ||
    fromOff === null ||
    fromUnknown === null ||
    toOn === null ||
    toUnconfirmed === null ||
    toOff === null
  ) {
    return { ok: false, reason: "invalid_balance_status_row" };
  }

  if (
    openingCount !== expectedOpening ||
    newEpisodeInflowCount !== expectedNewInflow ||
    closingCount !== expectedClosing
  ) {
    return { ok: false, reason: "balance_snapshot_alignment_violated" };
  }

  if (
    (statusKey === "on" && (fromOn !== 0 || toOn !== 0)) ||
    (statusKey === "unconfirmed" && (fromUnconfirmed !== 0 || toUnconfirmed !== 0)) ||
    (statusKey === "off" && (fromOff !== 0 || toOff !== 0)) ||
    (statusKey === "unknown" && fromUnknown !== 0)
  ) {
    return { ok: false, reason: "balance_self_transition_violated" };
  }

  if (fromOn + fromUnconfirmed + fromOff + fromUnknown !== transitionInflowCount) {
    return { ok: false, reason: "balance_inflow_source_sum_violated" };
  }

  if (toOn + toUnconfirmed + toOff !== outflowCount) {
    return { ok: false, reason: "balance_outflow_target_sum_violated" };
  }

  if (newEpisodeInflowCount + transitionInflowCount !== totalInflowCount) {
    return { ok: false, reason: "balance_total_inflow_invariant_violated" };
  }

  if (totalInflowCount - outflowCount !== netChange) {
    return { ok: false, reason: "balance_net_change_invariant_violated" };
  }

  if (openingCount + newEpisodeInflowCount + transitionInflowCount - outflowCount !== closingCount) {
    return { ok: false, reason: "balance_conservation_invariant_violated" };
  }

  return {
    ok: true,
    row: {
      openingCount,
      newEpisodeInflowCount,
      transitionInflowCount,
      transitionInflowBySource: {
        fromOn,
        fromUnconfirmed,
        fromOff,
        fromUnknown,
      },
      totalInflowCount,
      outflowCount,
      outflowByTarget: {
        toOn,
        toUnconfirmed,
        toOff,
      },
      netChange,
      closingCount,
    },
  };
}

function parseBalanceSection(
  balRaw: unknown,
  transitions: WorkforcePeriodTransitions,
): { ok: true; balance: WorkforcePeriodBalance } | { ok: false; reason: string } {
  if (typeof balRaw !== "object" || balRaw === null) {
    return { ok: false, reason: "missing_balance_section" };
  }
  const b = balRaw as Record<string, unknown>;
  if (b.applicable === false) {
    if (transitions.applicable) {
      return { ok: false, reason: "balance_applicability_mismatch" };
    }
    const reasonRaw = b.reason;
    const reason: WorkforceTransitionsNotApplicableReason =
      reasonRaw === "all_time" || reasonRaw === "one_sided" || reasonRaw === "invalid_range"
        ? reasonRaw
        : transitions.reason;
    const fromDate =
      typeof b.from_date === "string" && isRealCalendarDate(b.from_date) ? b.from_date : null;
    const toDate =
      typeof b.to_date === "string" && isRealCalendarDate(b.to_date) ? b.to_date : null;
    return {
      ok: true,
      balance: {
        applicable: false,
        reason,
        fromDate,
        toDate,
        windowLabel: formatWorkforceBalanceNotApplicableLabel(reason),
      },
    };
  }

  if (b.applicable !== true || !transitions.applicable) {
    return { ok: false, reason: "balance_applicability_mismatch" };
  }

  const fromDate = typeof b.from_date === "string" ? b.from_date : "";
  const toDate = typeof b.to_date === "string" ? b.to_date : "";
  const openingAsOfDate = typeof b.opening_as_of_date === "string" ? b.opening_as_of_date : "";
  const closingAsOfDate = typeof b.closing_as_of_date === "string" ? b.closing_as_of_date : "";

  if (
    fromDate !== transitions.fromDate ||
    toDate !== transitions.toDate ||
    openingAsOfDate !== shiftYmdDays(fromDate, -1) ||
    closingAsOfDate !== toDate
  ) {
    return { ok: false, reason: "invalid_balance_dates" };
  }

  const openSnapParsed = parseSnapshotSection(b.opening_snapshot);
  if (!openSnapParsed.ok) return { ok: false, reason: "invalid_balance_opening_snapshot" };
  const closeSnapParsed = parseSnapshotSection(b.closing_snapshot);
  if (!closeSnapParsed.ok) return { ok: false, reason: "invalid_balance_closing_snapshot" };

  const openingSnapshot = openSnapParsed.snapshot;
  const closingSnapshot = closeSnapParsed.snapshot;
  if (
    openingSnapshot.asOfDate !== openingAsOfDate ||
    closingSnapshot.asOfDate !== closingAsOfDate
  ) {
    return { ok: false, reason: "invalid_balance_snapshot_dates" };
  }

  const newRaw =
    typeof b.new_episodes_in_period === "object" && b.new_episodes_in_period !== null
      ? (b.new_episodes_in_period as Record<string, unknown>)
      : null;
  const byStatusRaw =
    typeof b.by_status === "object" && b.by_status !== null
      ? (b.by_status as Record<string, unknown>)
      : null;
  const totalsRaw =
    typeof b.totals === "object" && b.totals !== null
      ? (b.totals as Record<string, unknown>)
      : null;
  if (!newRaw || !byStatusRaw || !totalsRaw) {
    return { ok: false, reason: "missing_balance_nested" };
  }

  const newTotal = nonNegativeInt(newRaw.total);
  const initialOn = nonNegativeInt(newRaw.initial_on);
  const initialUnconfirmed = nonNegativeInt(newRaw.initial_unconfirmed);
  const initialOff = nonNegativeInt(newRaw.initial_off);
  const initialUnknown = nonNegativeInt(newRaw.initial_unknown);
  if (
    newTotal === null ||
    initialOn === null ||
    initialUnconfirmed === null ||
    initialOff === null ||
    initialUnknown === null
  ) {
    return { ok: false, reason: "invalid_balance_new_episodes" };
  }
  if (initialOn + initialUnconfirmed + initialOff + initialUnknown !== newTotal) {
    return { ok: false, reason: "balance_new_episode_sum_invariant_violated" };
  }

  const onRow = parseStatusBalanceRow(
    byStatusRaw.on,
    "on",
    openingSnapshot.onCount,
    initialOn,
    closingSnapshot.onCount,
  );
  if (!onRow.ok) return onRow;

  const unconfirmedRow = parseStatusBalanceRow(
    byStatusRaw.unconfirmed,
    "unconfirmed",
    openingSnapshot.unconfirmedCount,
    initialUnconfirmed,
    closingSnapshot.unconfirmedCount,
  );
  if (!unconfirmedRow.ok) return unconfirmedRow;

  const offRow = parseStatusBalanceRow(
    byStatusRaw.off,
    "off",
    openingSnapshot.offCount,
    initialOff,
    closingSnapshot.offCount,
  );
  if (!offRow.ok) return offRow;

  const unknownRow = parseStatusBalanceRow(
    byStatusRaw.unknown,
    "unknown",
    openingSnapshot.unknownCount,
    initialUnknown,
    closingSnapshot.unknownCount,
  );
  if (!unknownRow.ok) return unknownRow;

  const openingEligibleTotal = nonNegativeInt(totalsRaw.opening_eligible_total);
  const newEpisodeTotal = nonNegativeInt(totalsRaw.new_episode_total);
  const transitionInflowTotal = nonNegativeInt(totalsRaw.transition_inflow_total);
  const transitionOutflowTotal = nonNegativeInt(totalsRaw.transition_outflow_total);
  const netEligibleChange = finiteInt(totalsRaw.net_eligible_change);
  const closingEligibleTotal = nonNegativeInt(totalsRaw.closing_eligible_total);

  if (
    openingEligibleTotal === null ||
    newEpisodeTotal === null ||
    transitionInflowTotal === null ||
    transitionOutflowTotal === null ||
    netEligibleChange === null ||
    closingEligibleTotal === null
  ) {
    return { ok: false, reason: "invalid_balance_totals" };
  }

  const sumTransIn =
    onRow.row.transitionInflowCount +
    unconfirmedRow.row.transitionInflowCount +
    offRow.row.transitionInflowCount +
    unknownRow.row.transitionInflowCount;
  const sumTransOut =
    onRow.row.outflowCount +
    unconfirmedRow.row.outflowCount +
    offRow.row.outflowCount +
    unknownRow.row.outflowCount;

  if (
    openingEligibleTotal !== openingSnapshot.eligibleEpisodeTotal ||
    closingEligibleTotal !== closingSnapshot.eligibleEpisodeTotal ||
    newEpisodeTotal !== newTotal ||
    transitionInflowTotal !== sumTransIn ||
    transitionOutflowTotal !== sumTransOut ||
    transitionInflowTotal !== transitionOutflowTotal ||
    netEligibleChange !== newEpisodeTotal ||
    openingEligibleTotal + newEpisodeTotal !== closingEligibleTotal
  ) {
    return { ok: false, reason: "balance_totals_invariant_violated" };
  }

  return {
    ok: true,
    balance: {
      applicable: true,
      fromDate,
      toDate,
      openingAsOfDate,
      closingAsOfDate,
      openingSnapshot,
      closingSnapshot,
      newEpisodesInPeriod: {
        total: newTotal,
        initialOn,
        initialUnconfirmed,
        initialOff,
        initialUnknown,
      },
      byStatus: {
        on: onRow.row,
        unconfirmed: unconfirmedRow.row,
        off: offRow.row,
        unknown: unknownRow.row,
      },
      totals: {
        openingEligibleTotal,
        newEpisodeTotal,
        transitionInflowTotal,
        transitionOutflowTotal,
        netEligibleChange,
        closingEligibleTotal,
      },
    },
  };
}

function parseWaitingSample(raw: unknown): WorkforceWaitingSampleMetrics | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const episodeCount = nonNegativeInt(r.episode_count);
  const intervalCount = nonNegativeInt(r.interval_count);
  const totalWaitingDays = nonNegativeInt(r.total_waiting_days);
  const maxRaw = r.max_waiting_days;
  const maxWaitingDays = maxRaw === null || maxRaw === undefined ? null : nonNegativeInt(maxRaw);

  if (episodeCount === null || intervalCount === null || totalWaitingDays === null) {
    return null;
  }
  if (maxRaw !== null && maxRaw !== undefined && maxWaitingDays === null) {
    return null;
  }

  if (episodeCount === 0) {
    if (intervalCount !== 0 || totalWaitingDays !== 0 || maxWaitingDays !== null) {
      return null;
    }
    return buildWaitingSampleMetrics(0, 0, 0, null);
  }

  if (intervalCount < episodeCount || maxWaitingDays === null || maxWaitingDays > totalWaitingDays) {
    return null;
  }

  return buildWaitingSampleMetrics(episodeCount, intervalCount, totalWaitingDays, maxWaitingDays);
}

function parsePeriodWaitingTransitionSummary(
  raw: unknown,
): WorkforcePeriodWaitingTransitionSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const eventCount = nonNegativeInt(r.event_count);
  const episodeCount = nonNegativeInt(r.episode_count);
  const totalWaitingDays = nonNegativeInt(r.total_waiting_days);
  if (eventCount === null || episodeCount === null || totalWaitingDays === null) {
    return null;
  }
  if (episodeCount > eventCount) return null;
  if (eventCount === 0 && totalWaitingDays !== 0) return null;
  return buildPeriodWaitingTransitionSummary(eventCount, episodeCount, totalWaitingDays);
}

function parseWaitingSection(
  waitRaw: unknown,
  snapshot: WorkforceAsOfSnapshot,
  transitions: WorkforcePeriodTransitions,
): { ok: true; waiting: WorkforceWaitingMetrics } | { ok: false; reason: string } {
  if (typeof waitRaw !== "object" || waitRaw === null) {
    return { ok: false, reason: "missing_waiting_section" };
  }
  const w = waitRaw as Record<string, unknown>;
  const asOfDate = typeof w.as_of_date === "string" ? w.as_of_date : "";
  const asOfSourceRaw = w.as_of_source;
  const asOfSource: WorkforceAsOfSource | null =
    asOfSourceRaw === "filter_to" ||
    asOfSourceRaw === "current_hcm_date" ||
    asOfSourceRaw === "explicit_as_of"
      ? asOfSourceRaw
      : null;

  const eligibleEpisodeTotal = nonNegativeInt(w.eligible_episode_total);
  const waitingEpisodeTotal = nonNegativeInt(w.waiting_episode_total);
  const directOnEpisodeCount = nonNegativeInt(w.direct_on_episode_count);
  const directOffEpisodeCount = nonNegativeInt(w.direct_off_episode_count);
  const unknownEpisodeCount = nonNegativeInt(w.unknown_episode_count);

  if (
    asOfDate !== snapshot.asOfDate ||
    asOfSource !== snapshot.asOfSource ||
    eligibleEpisodeTotal === null ||
    eligibleEpisodeTotal !== snapshot.eligibleEpisodeTotal ||
    waitingEpisodeTotal === null ||
    directOnEpisodeCount === null ||
    directOffEpisodeCount === null ||
    unknownEpisodeCount === null
  ) {
    return { ok: false, reason: "invalid_waiting_header_fields" };
  }

  if (
    waitingEpisodeTotal +
      directOnEpisodeCount +
      directOffEpisodeCount +
      unknownEpisodeCount !==
    eligibleEpisodeTotal
  ) {
    return { ok: false, reason: "waiting_entry_mode_sum_invariant_violated" };
  }

  const allWaiting = parseWaitingSample(w.all_waiting);
  const completedWaiting = parseWaitingSample(w.completed_waiting);
  const placedToOn = parseWaitingSample(w.placed_to_on);
  const exitedWithoutOn = parseWaitingSample(w.exited_without_on);
  const currentlyWaiting = parseWaitingSample(w.currently_waiting);

  if (!allWaiting || !completedWaiting || !placedToOn || !exitedWithoutOn || !currentlyWaiting) {
    return { ok: false, reason: "invalid_waiting_sample_metrics" };
  }

  if (
    allWaiting.episodeCount !== waitingEpisodeTotal ||
    completedWaiting.episodeCount + currentlyWaiting.episodeCount !== allWaiting.episodeCount ||
    placedToOn.episodeCount + exitedWithoutOn.episodeCount !== completedWaiting.episodeCount ||
    currentlyWaiting.episodeCount !== snapshot.unconfirmedCount ||
    completedWaiting.intervalCount + currentlyWaiting.intervalCount !== allWaiting.intervalCount ||
    placedToOn.intervalCount + exitedWithoutOn.intervalCount !== completedWaiting.intervalCount ||
    completedWaiting.totalWaitingDays + currentlyWaiting.totalWaitingDays !==
      allWaiting.totalWaitingDays ||
    placedToOn.totalWaitingDays + exitedWithoutOn.totalWaitingDays !==
      completedWaiting.totalWaitingDays
  ) {
    return { ok: false, reason: "waiting_sample_partition_invariant_violated" };
  }

  const pwRaw =
    typeof w.period_waiting === "object" && w.period_waiting !== null
      ? (w.period_waiting as Record<string, unknown>)
      : null;
  if (!pwRaw) {
    return { ok: false, reason: "missing_period_waiting" };
  }

  let periodWaiting: WorkforcePeriodWaitingMetrics;
  if (pwRaw.applicable === false) {
    if (transitions.applicable) {
      return { ok: false, reason: "period_waiting_applicability_mismatch" };
    }
    const reasonRaw = pwRaw.reason;
    const reason: WorkforceTransitionsNotApplicableReason =
      reasonRaw === "all_time" || reasonRaw === "one_sided" || reasonRaw === "invalid_range"
        ? reasonRaw
        : transitions.reason;
    const fromDate =
      typeof pwRaw.from_date === "string" && isRealCalendarDate(pwRaw.from_date)
        ? pwRaw.from_date
        : null;
    const toDate =
      typeof pwRaw.to_date === "string" && isRealCalendarDate(pwRaw.to_date)
        ? pwRaw.to_date
        : null;
    periodWaiting = {
      applicable: false,
      reason,
      fromDate,
      toDate,
      windowLabel: formatWorkforceTransitionsNotApplicableLabel(reason),
    };
  } else if (pwRaw.applicable === true) {
    if (!transitions.applicable) {
      return { ok: false, reason: "period_waiting_applicability_mismatch" };
    }
    const fromDate = typeof pwRaw.from_date === "string" ? pwRaw.from_date : "";
    const toDate = typeof pwRaw.to_date === "string" ? pwRaw.to_date : "";
    const activeWaitingEpisodeCount = nonNegativeInt(pwRaw.active_waiting_episode_count);
    const inPeriodWaitingDays = nonNegativeInt(pwRaw.in_period_waiting_days);
    const placedInPeriod = parsePeriodWaitingTransitionSummary(pwRaw.placed_in_period);
    const exitedInPeriod = parsePeriodWaitingTransitionSummary(pwRaw.exited_in_period);

    if (
      fromDate !== transitions.fromDate ||
      toDate !== transitions.toDate ||
      activeWaitingEpisodeCount === null ||
      inPeriodWaitingDays === null ||
      !placedInPeriod ||
      !exitedInPeriod
    ) {
      return { ok: false, reason: "invalid_period_waiting_fields" };
    }
    if (activeWaitingEpisodeCount === 0 && inPeriodWaitingDays !== 0) {
      return { ok: false, reason: "invalid_period_waiting_fields" };
    }

    periodWaiting = {
      applicable: true,
      fromDate,
      toDate,
      activeWaitingEpisodeCount,
      inPeriodWaitingDays,
      avgInPeriodWaitingDaysPerActiveEpisode:
        activeWaitingEpisodeCount > 0 ? inPeriodWaitingDays / activeWaitingEpisodeCount : null,
      placedInPeriod,
      exitedInPeriod,
    };
  } else {
    return { ok: false, reason: "invalid_period_waiting_applicable" };
  }

  return {
    ok: true,
    waiting: {
      asOfDate,
      asOfSource,
      eligibleEpisodeTotal,
      waitingEpisodeTotal,
      directOnEpisodeCount,
      directOffEpisodeCount,
      unknownEpisodeCount,
      placementRateOfWaiting:
        waitingEpisodeTotal > 0 ? placedToOn.episodeCount / waitingEpisodeTotal : null,
      placementRateOfCompletedWaiting:
        completedWaiting.episodeCount > 0
          ? placedToOn.episodeCount / completedWaiting.episodeCount
          : null,
      allWaiting,
      completedWaiting,
      placedToOn,
      exitedWithoutOn,
      currentlyWaiting,
      periodWaiting,
    },
  };
}

/**
 * Parse và kiểm tra toàn vẹn payload trả về từ RPC `direct_entry_workforce_reporting_scoped`.
 * Fail-closed (`status: "unavailable"`) nếu thiếu trường hoặc vi phạm bất biến tổng snapshot,
 * bất biến bảo toàn cân bằng đầu/cuối kỳ (2.3) hoặc phân hoạch mẫu chờ việc (2.4).
 */
export function parseWorkforceReportingPayload(raw: unknown): WorkforceReportingResult {
  if (typeof raw !== "object" || raw === null) {
    return { status: "unavailable", reason: "empty_payload" };
  }
  const root = raw as Record<string, unknown>;
  const snapRaw = root.snapshot;
  const transRaw = root.transitions;
  if (typeof snapRaw !== "object" || snapRaw === null || typeof transRaw !== "object" || transRaw === null) {
    return { status: "unavailable", reason: "missing_sections" };
  }

  const snapParsed = parseSnapshotSection(snapRaw);
  if (!snapParsed.ok) {
    return { status: "unavailable", reason: snapParsed.reason };
  }
  const snapshot = snapParsed.snapshot;

  const t = transRaw as Record<string, unknown>;
  let transitions: WorkforcePeriodTransitions;
  if (t.applicable === false) {
    const reasonRaw = t.reason;
    const reason: WorkforceTransitionsNotApplicableReason =
      reasonRaw === "all_time" || reasonRaw === "one_sided" || reasonRaw === "invalid_range"
        ? reasonRaw
        : "all_time";
    const fromDate = typeof t.from_date === "string" && isRealCalendarDate(t.from_date) ? t.from_date : null;
    const toDate = typeof t.to_date === "string" && isRealCalendarDate(t.to_date) ? t.to_date : null;
    transitions = {
      applicable: false,
      reason,
      fromDate,
      toDate,
      windowLabel: formatWorkforceTransitionsNotApplicableLabel(reason),
    };
  } else if (t.applicable === true) {
    const fromDate = typeof t.from_date === "string" ? t.from_date : "";
    const toDate = typeof t.to_date === "string" ? t.to_date : "";
    if (!isRealCalendarDate(fromDate) || !isRealCalendarDate(toDate) || fromDate > toDate) {
      return { status: "unavailable", reason: "invalid_transitions_dates" };
    }

    const initRaw = typeof t.initial === "object" && t.initial !== null ? (t.initial as Record<string, unknown>) : null;
    const pairsRaw = typeof t.pairs === "object" && t.pairs !== null ? (t.pairs as Record<string, unknown>) : null;
    const totalsRaw = typeof t.totals === "object" && t.totals !== null ? (t.totals as Record<string, unknown>) : null;
    if (!initRaw || !pairsRaw || !totalsRaw) {
      return { status: "unavailable", reason: "missing_transitions_nested" };
    }

    const initTotal = parseCountPair(initRaw.total);
    const initOn = parseCountPair(initRaw.on);
    const initUnconfirmed = parseCountPair(initRaw.unconfirmed);

    const unconfirmedToOn = parseCountPair(pairsRaw.unconfirmed_to_on);
    const unconfirmedToOff = parseCountPair(pairsRaw.unconfirmed_to_off);
    const onToOff = parseCountPair(pairsRaw.on_to_off);
    const offToOn = parseCountPair(pairsRaw.off_to_on);
    const otherPair = parseCountPair(pairsRaw.other);

    const transitionEventCount = nonNegativeInt(totalsRaw.transition_event_count);
    const transitionEpisodeCount = nonNegativeInt(totalsRaw.transition_episode_count);
    const noopRepeatEventCount = nonNegativeInt(totalsRaw.noop_repeat_event_count);
    const noopRepeatEpisodeCount = nonNegativeInt(totalsRaw.noop_repeat_episode_count);

    if (
      !initTotal ||
      !initOn ||
      !initUnconfirmed ||
      !unconfirmedToOn ||
      !unconfirmedToOff ||
      !onToOff ||
      !offToOn ||
      !otherPair ||
      transitionEventCount === null ||
      transitionEpisodeCount === null ||
      noopRepeatEventCount === null ||
      noopRepeatEpisodeCount === null
    ) {
      return { status: "unavailable", reason: "invalid_transitions_counts" };
    }

    if (initOn.eventCount + initUnconfirmed.eventCount !== initTotal.eventCount) {
      return { status: "unavailable", reason: "initial_event_sum_invariant_violated" };
    }

    const pairEventSum =
      unconfirmedToOn.eventCount +
      unconfirmedToOff.eventCount +
      onToOff.eventCount +
      offToOn.eventCount +
      otherPair.eventCount;
    if (pairEventSum !== transitionEventCount) {
      return { status: "unavailable", reason: "transition_event_sum_invariant_violated" };
    }

    transitions = {
      applicable: true,
      fromDate,
      toDate,
      initial: {
        total: initTotal,
        on: initOn,
        unconfirmed: initUnconfirmed,
      },
      pairs: {
        unconfirmedToOn,
        unconfirmedToOff,
        onToOff,
        offToOn,
        other: otherPair,
      },
      totals: {
        transitionEventCount,
        transitionEpisodeCount,
        noopRepeatEventCount,
        noopRepeatEpisodeCount,
      },
    };
  } else {
    return { status: "unavailable", reason: "invalid_transitions_applicable" };
  }

  const balanceParsed = parseBalanceSection(root.balance, transitions);
  if (!balanceParsed.ok) {
    return { status: "unavailable", reason: balanceParsed.reason };
  }

  const waitingParsed = parseWaitingSection(root.waiting, snapshot, transitions);
  if (!waitingParsed.ok) {
    return { status: "unavailable", reason: waitingParsed.reason };
  }

  return {
    status: "ready",
    snapshot,
    transitions,
    balance: balanceParsed.balance,
    waiting: waitingParsed.waiting,
  };
}

export interface WorkforceScopedRpcArgs {
  p_auth_subject: string;
  p_app_user_id: string;
  p_filters: Record<string, string | undefined>;
}

export interface WorkforceScopedRpcResult {
  data?: unknown;
  error?: unknown;
}

/**
 * Truy vấn WF-01 & WF-02 Workforce Analytics cho actor hiện hành qua RPC
 * `direct_entry_workforce_reporting_scoped`.
 * Cô lập lỗi (`status: "unavailable"`) để không bao giờ bịa số 0 và không làm gãy báo cáo tuyển dụng Chặng 1.
 */
export async function resolveWorkforceReportingForActor(input: {
  actor: { auth_subject: string; app_user_id: string };
  filters: ReportingFilters;
  teamBucketKey?: string;
  expectedAudienceKind?: ReportingAudienceKind;
  callWorkforceRpc: (args: WorkforceScopedRpcArgs) => PromiseLike<WorkforceScopedRpcResult>;
}): Promise<WorkforceReportingResult> {
  const rpcFilters: Record<string, string | undefined> = {};
  if (input.filters.from) rpcFilters.from = input.filters.from;
  if (input.filters.to) rpcFilters.to = input.filters.to;
  if (input.filters.project) rpcFilters.project = input.filters.project;
  if (input.filters.recruiter) rpcFilters.recruiter = input.filters.recruiter;
  if (input.filters.provider) rpcFilters.provider = input.filters.provider;
  if (input.filters.employment) rpcFilters.employment = input.filters.employment;
  if (input.teamBucketKey) rpcFilters.team_bucket = input.teamBucketKey;

  try {
    const res = await input.callWorkforceRpc({
      p_auth_subject: input.actor.auth_subject,
      p_app_user_id: input.actor.app_user_id,
      p_filters: rpcFilters,
    });
    if (!res || typeof res !== "object" || res.error) {
      return { status: "unavailable", reason: "rpc_error" };
    }
    const payload = (res.data ?? null) as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") {
      return { status: "unavailable", reason: "empty_data" };
    }
    const audience = resolveReportingAudienceProjection(payload.audience);
    if (
      audience === null ||
      (input.expectedAudienceKind !== undefined && audience.kind !== input.expectedAudienceKind)
    ) {
      return { status: "unavailable", reason: "audience_mismatch" };
    }
    return parseWorkforceReportingPayload(payload);
  } catch {
    return { status: "unavailable", reason: "exception" };
  }
}
