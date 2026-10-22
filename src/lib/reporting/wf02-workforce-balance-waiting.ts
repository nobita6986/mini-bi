/**
 * MBI-DA-2026-01 — Chặng 2 / WF-02 (Items 2.3 & 2.4):
 *   2.3 Workforce Period Balance & Opening/Closing Snapshot Reconciliation.
 *   2.4 Waiting Time in UNCONFIRMED ("Đang chờ việc") Intervals & Placement Rate (UNCONFIRMED -> ON).
 *
 * Re-exports WF-02 types, constants, pure evaluator, and formatting helpers.
 */

export {
  diffYmdDays,
  evaluateWorkforceSnapshotAndTransitions,
  formatWorkforceBalanceNotApplicableLabel,
  formatWorkforceTransitionsNotApplicableLabel,
  parseWorkforceReportingPayload,
  resolveWorkforceAsOfDate,
  resolveWorkforceReportingForActor,
  shiftYmdDays,
  WORKER_STATUS_FROZEN_LABELS,
  WORKFORCE_BALANCE_COLUMN_LABELS,
  WORKFORCE_INITIAL_STATUS_LABELS,
  WORKFORCE_NON_ATTENDANCE_NOTE,
  WORKFORCE_SNAPSHOT_STATUS_LABELS,
  WORKFORCE_TRANSITION_PAIR_LABELS,
  WORKFORCE_UNIT_METADATA_NOTE,
  WORKFORCE_WAITING_SAMPLE_LABELS,
  type WorkforceAsOfSnapshot,
  type WorkforceAsOfSource,
  type WorkforceCountPair,
  type WorkforceEpisodeRecord,
  type WorkforcePeriodBalance,
  type WorkforcePeriodTransitions,
  type WorkforcePeriodWaitingMetrics,
  type WorkforcePeriodWaitingTransitionSummary,
  type WorkforceReportingResult,
  type WorkforceScopedRpcArgs,
  type WorkforceScopedRpcResult,
  type WorkforceStatusBalanceRow,
  type WorkforceStatusBucket,
  type WorkforceStatusEventRecord,
  type WorkforceTransitionsNotApplicableReason,
  type WorkforceWaitingMetrics,
  type WorkforceWaitingSampleMetrics,
} from "./wf01-workforce-snapshot.ts";

const VI_NUMBER_FORMATTER = new Intl.NumberFormat("vi-VN");
const VI_ONE_DECIMAL_FORMATTER = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

/**
 * Định dạng biến động ròng có dấu (`+N`, `−N`, hoặc `0`) cho bảng đối soát cân bằng 2.3.
 */
export function formatSignedBalanceDelta(delta: number): string {
  if (!Number.isFinite(delta) || delta === 0) return "0";
  if (delta > 0) return `+${VI_NUMBER_FORMATTER.format(delta)}`;
  return `−${VI_NUMBER_FORMATTER.format(Math.abs(delta))}`;
}

/**
 * Định dạng số ngày chờ việc trung bình (`X,Y ngày` hoặc `—` khi mẫu rỗng).
 */
export function formatWaitingDaysAverage(avgDays: number | null | undefined): string {
  if (avgDays === null || avgDays === undefined || !Number.isFinite(avgDays)) {
    return "—";
  }
  return `${VI_ONE_DECIMAL_FORMATTER.format(avgDays)} ngày`;
}

/**
 * Định dạng tỷ lệ bố trí việc (`XX,X%` hoặc `—` khi mẫu số bằng 0).
 */
export function formatPlacementRatePercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return "—";
  }
  return `${VI_ONE_DECIMAL_FORMATTER.format(rate * 100)}%`;
}
