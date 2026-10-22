/**
 * MBI-DA-2026-01 — Chặng 2 / WF-03 (Items 2.5 & 2.6):
 *   2.5 Active ON Tenure / Duration & In-Period Status Presence Days.
 *   2.6 Early Attrition & Cohort Retention at D7 / D30 / D90 Checkpoints.
 *
 * Re-exports WF-03 types, constants, pure evaluator, and formatting helpers.
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
  WORKFORCE_DURATION_BUCKET_LABELS,
  WORKFORCE_DURATION_SAMPLE_LABELS,
  WORKFORCE_INITIAL_STATUS_LABELS,
  WORKFORCE_NON_ATTENDANCE_NOTE,
  WORKFORCE_RETENTION_CHECKPOINT_LABELS,
  WORKFORCE_SNAPSHOT_STATUS_LABELS,
  WORKFORCE_TRANSITION_PAIR_LABELS,
  WORKFORCE_UNIT_METADATA_NOTE,
  WORKFORCE_WAITING_SAMPLE_LABELS,
  type WorkforceAsOfSnapshot,
  type WorkforceAsOfSource,
  type WorkforceCountPair,
  type WorkforceDurationDistribution,
  type WorkforceDurationMetrics,
  type WorkforceDurationSampleMetrics,
  type WorkforceEpisodeRecord,
  type WorkforcePeriodBalance,
  type WorkforcePeriodCohortMetrics,
  type WorkforcePeriodPresenceMetrics,
  type WorkforcePeriodTransitions,
  type WorkforcePeriodWaitingMetrics,
  type WorkforcePeriodWaitingTransitionSummary,
  type WorkforceReportingResult,
  type WorkforceRetentionCheckpointMetrics,
  type WorkforceRetentionMetrics,
  type WorkforceScopedRpcArgs,
  type WorkforceScopedRpcResult,
  type WorkforceStatusBalanceRow,
  type WorkforceStatusBucket,
  type WorkforceStatusEventRecord,
  type WorkforceTransitionsNotApplicableReason,
  type WorkforceWaitingMetrics,
  type WorkforceWaitingSampleMetrics,
} from "./wf01-workforce-snapshot.ts";

export {
  formatPlacementRatePercent,
  formatSignedBalanceDelta,
  formatWaitingDaysAverage,
} from "./wf02-workforce-balance-waiting.ts";

const VI_ONE_DECIMAL_FORMATTER = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

/**
 * Định dạng số ngày thâm niên / hiện diện trung bình (`X,Y ngày` hoặc `—` khi mẫu rỗng).
 */
export function formatDurationDaysAverage(avgDays: number | null | undefined): string {
  if (avgDays === null || avgDays === undefined || !Number.isFinite(avgDays)) {
    return "—";
  }
  return `${VI_ONE_DECIMAL_FORMATTER.format(avgDays)} ngày`;
}

/**
 * Định dạng tỷ lệ giữ chân / nghỉ sớm (`XX,X%` hoặc `—` khi mẫu số đã đủ tuổi bằng 0).
 */
export function formatRetentionRatePercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return "—";
  }
  return `${VI_ONE_DECIMAL_FORMATTER.format(rate * 100)}%`;
}
