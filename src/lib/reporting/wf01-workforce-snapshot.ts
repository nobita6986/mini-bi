/**
 * MBI-DA-2026-01 — Chặng 2 / WF-01 (Items 2.1 & 2.2):
 *   2.1 Workforce Snapshot as-of date D (business-effective on non-superseded status events).
 *   2.2 Workforce Status Transitions in period [from, to] (initial vs state transitions).
 *
 * Semantic rules locked by Master Plan §8, §9 (2.1 & 2.2), §10.1, §10.2:
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

export const WORKFORCE_UNIT_METADATA_NOTE =
  "Đơn vị: hồ sơ lao động (entry_id) / sự kiện trạng thái (event_id) — không đồng nhất với người duy nhất. Tái tuyển dụng (rehire) tạo hồ sơ mới (entry_id riêng); chuyển tiếp Đã nghỉ → Đang làm trong cùng một entry_id không phải rehire. Khác với khối tuyển dụng Chặng 1 (lọc theo ngày báo cáo business_date), khối biến động nhân sự tính theo ngày bắt đầu làm việc (first_work_date) và ngày hiệu lực trạng thái (effective_date).";

export type WorkforceAsOfSource = "filter_to" | "current_hcm_date" | "explicit_as_of";

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

export type WorkforceReportingResult =
  | {
      status: "ready";
      snapshot: WorkforceAsOfSnapshot;
      transitions: WorkforcePeriodTransitions;
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

/**
 * Hàm thuần tính toán Workforce Snapshot `as-of` (2.1) và Status Transitions trong kỳ `[from, to]` (2.2)
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
  let eligibleEpisodeTotal = 0;
  let onCount = 0;
  let unconfirmedCount = 0;
  let offCount = 0;
  let unknownCount = 0;
  let futureEpisodeCount = 0;

  for (const ep of eligibleEpisodes.values()) {
    if (ep.first_work_date > asOfDate) {
      futureEpisodeCount += 1;
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
    if (!chosen) {
      unknownCount += 1;
    } else if (chosen.status === "ON") {
      onCount += 1;
    } else if (chosen.status === "UNCONFIRMED") {
      unconfirmedCount += 1;
    } else if (chosen.status === "OFF") {
      offCount += 1;
    } else {
      unknownCount += 1;
    }
  }

  const snapshot: WorkforceAsOfSnapshot = {
    asOfDate,
    asOfSource,
    eligibleEpisodeTotal,
    onCount,
    unconfirmedCount,
    offCount,
    unknownCount,
    futureEpisodeCount,
  };

  // 4. Tính 2.2 Biến động trạng thái trong kỳ [from, to]:
  const rawFrom = input.filters.from?.trim() || "";
  const rawTo = input.filters.to?.trim() || "";

  if (!rawFrom && !rawTo) {
    return {
      snapshot,
      transitions: {
        applicable: false,
        reason: "all_time",
        fromDate: null,
        toDate: null,
        windowLabel: formatWorkforceTransitionsNotApplicableLabel("all_time"),
      },
    };
  }

  if (!rawFrom || !rawTo) {
    return {
      snapshot,
      transitions: {
        applicable: false,
        reason: "one_sided",
        fromDate: rawFrom || null,
        toDate: rawTo || null,
        windowLabel: formatWorkforceTransitionsNotApplicableLabel("one_sided"),
      },
    };
  }

  if (!isRealCalendarDate(rawFrom) || !isRealCalendarDate(rawTo) || rawFrom > rawTo) {
    return {
      snapshot,
      transitions: {
        applicable: false,
        reason: "invalid_range",
        fromDate: rawFrom,
        toDate: rawTo,
        windowLabel: formatWorkforceTransitionsNotApplicableLabel("invalid_range"),
      },
    };
  }

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
  };
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
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

/**
 * Parse và kiểm tra toàn vẹn payload trả về từ RPC `direct_entry_workforce_reporting_scoped`.
 * Fail-closed (`status: "unavailable"`) nếu thiếu trường hoặc vi phạm bất biến tổng snapshot.
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
    return { status: "unavailable", reason: "invalid_snapshot_fields" };
  }

  if (onCount + unconfirmedCount + offCount + unknownCount !== eligibleEpisodeTotal) {
    return { status: "unavailable", reason: "snapshot_sum_invariant_violated" };
  }

  const snapshot: WorkforceAsOfSnapshot = {
    asOfDate,
    asOfSource,
    eligibleEpisodeTotal,
    onCount,
    unconfirmedCount,
    offCount,
    unknownCount,
    futureEpisodeCount,
  };

  const t = transRaw as Record<string, unknown>;
  if (t.applicable === false) {
    const reasonRaw = t.reason;
    const reason: WorkforceTransitionsNotApplicableReason =
      reasonRaw === "all_time" || reasonRaw === "one_sided" || reasonRaw === "invalid_range"
        ? reasonRaw
        : "all_time";
    const fromDate = typeof t.from_date === "string" && isRealCalendarDate(t.from_date) ? t.from_date : null;
    const toDate = typeof t.to_date === "string" && isRealCalendarDate(t.to_date) ? t.to_date : null;
    return {
      status: "ready",
      snapshot,
      transitions: {
        applicable: false,
        reason,
        fromDate,
        toDate,
        windowLabel: formatWorkforceTransitionsNotApplicableLabel(reason),
      },
    };
  }

  if (t.applicable !== true) {
    return { status: "unavailable", reason: "invalid_transitions_applicable" };
  }

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

  return {
    status: "ready",
    snapshot,
    transitions: {
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
    },
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
 * Truy vấn WF-01 Workforce Snapshot & Status Transitions cho actor hiện hành qua RPC
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
