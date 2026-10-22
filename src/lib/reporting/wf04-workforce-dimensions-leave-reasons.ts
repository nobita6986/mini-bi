/**
 * MBI-DA-2026-01 — Chặng 2 / WF-04 (Items 2.7, 2.8 & Visual Clarity):
 *   2.7 Chất lượng theo chiều Người tuyển / Nhóm / HRP-Vendor / Dự án.
 *   2.8 Phân tích lý do nghỉ việc & độ phủ chuẩn hóa.
 *   Quy tắc tất định cho khối "Điểm cần chú ý" (Attention Insights) có ngưỡng mẫu tối thiểu.
 */

export {
  CANONICAL_LEAVE_REASON_CATALOG,
  classifyLeaveReasonCategory,
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
  WORKFORCE_DIMENSION_ATTRIBUTION_NOTE,
  WORKFORCE_DIMENSION_KIND_LABELS,
  WORKFORCE_DURATION_BUCKET_LABELS,
  WORKFORCE_DURATION_SAMPLE_LABELS,
  WORKFORCE_INITIAL_STATUS_LABELS,
  WORKFORCE_LEAVE_REASON_CATEGORY_LABELS,
  WORKFORCE_LEAVE_REASON_STANDARDIZATION_NOTE,
  WORKFORCE_NON_ATTENDANCE_NOTE,
  WORKFORCE_RETENTION_CHECKPOINT_LABELS,
  WORKFORCE_SNAPSHOT_STATUS_LABELS,
  WORKFORCE_TRANSITION_PAIR_LABELS,
  WORKFORCE_UNIT_METADATA_NOTE,
  WORKFORCE_WAITING_SAMPLE_LABELS,
  type WorkforceAsOfLeaveReasonCategoryRow,
  type WorkforceAsOfSnapshot,
  type WorkforceAsOfSource,
  type WorkforceCountPair,
  type WorkforceDimensionBucketMetrics,
  type WorkforceDimensionGroupSummary,
  type WorkforceDimensionKind,
  type WorkforceDimensionsMetrics,
  type WorkforceDurationDistribution,
  type WorkforceDurationMetrics,
  type WorkforceDurationSampleMetrics,
  type WorkforceEpisodeRecord,
  type WorkforceLeaveReasonCategoryKey,
  type WorkforceLeaveReasonKind,
  type WorkforceLeaveReasonsMetrics,
  type WorkforcePeriodBalance,
  type WorkforcePeriodCohortMetrics,
  type WorkforcePeriodLeaveReasonCategoryRow,
  type WorkforcePeriodLeaveReasonsMetrics,
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

export {
  formatDurationDaysAverage,
  formatRetentionRatePercent,
} from "./wf03-workforce-tenure-retention.ts";

import type {
  WorkforceDimensionBucketMetrics,
  WorkforceReportingResult,
} from "./wf01-workforce-snapshot.ts";
import { formatWaitingDaysAverage } from "./wf02-workforce-balance-waiting.ts";
import { formatRetentionRatePercent } from "./wf03-workforce-tenure-retention.ts";

const VI_INT_FORMATTER = new Intl.NumberFormat("vi-VN");
const VI_ONE_DECIMAL_FORMATTER = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

/**
 * Ngưỡng mẫu tối thiểu để kết luận xếp hạng cao nhất / thấp nhất trong khối "Điểm cần chú ý",
 * tránh kết luận sai lệch từ các chiều chỉ có 1–2 đợt làm việc.
 */
export const WORKFORCE_HIGHLIGHT_MIN_SAMPLE_SIZE = 3;

/**
 * Định dạng tỷ trọng phần trăm (`XX,X%` hoặc `—` khi mẫu số bằng 0).
 */
export function formatShareRatePercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return "—";
  }
  return `${VI_ONE_DECIMAL_FORMATTER.format(rate * 100)}%`;
}

/**
 * Định dạng tỷ lệ độ phủ / chuẩn hóa lý do nghỉ việc (`XX,X%` hoặc `—` khi mẫu số bằng 0).
 */
export function formatCoverageRatePercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return "—";
  }
  return `${VI_ONE_DECIMAL_FORMATTER.format(rate * 100)}%`;
}

export interface WorkforceAttentionInsight {
  id: string;
  tone: "emerald" | "amber" | "sky" | "slate";
  badgeLabel: string;
  title: string;
  detail: string;
}

function compareLowestD30RetentionBuckets(
  a: WorkforceDimensionBucketMetrics,
  b: WorkforceDimensionBucketMetrics,
): number {
  const rateA = a.checkpoints.d30.retentionRate ?? 1;
  const rateB = b.checkpoints.d30.retentionRate ?? 1;
  if (rateA !== rateB) return rateA - rateB;
  if (b.checkpoints.d30.exitedCount !== a.checkpoints.d30.exitedCount) {
    return b.checkpoints.d30.exitedCount - a.checkpoints.d30.exitedCount;
  }
  if (b.checkpoints.d30.maturedCount !== a.checkpoints.d30.maturedCount) {
    return b.checkpoints.d30.maturedCount - a.checkpoints.d30.maturedCount;
  }
  return a.key.localeCompare(b.key);
}

function pickLowestD30RetentionBucket(
  buckets: WorkforceDimensionBucketMetrics[],
  minSample: number,
): WorkforceDimensionBucketMetrics | null {
  const qualified = buckets.filter(
    (b) => b.checkpoints.d30.maturedCount >= minSample && b.checkpoints.d30.retentionRate !== null,
  );
  if (qualified.length === 0) return null;
  qualified.sort(compareLowestD30RetentionBuckets);
  return qualified[0] ?? null;
}

function compareHighestWaitingBuckets(
  a: WorkforceDimensionBucketMetrics,
  b: WorkforceDimensionBucketMetrics,
): number {
  const avgA = a.avgWaitingDaysPerEpisode ?? 0;
  const avgB = b.avgWaitingDaysPerEpisode ?? 0;
  if (avgB !== avgA) return avgB - avgA;
  if (b.totalWaitingDays !== a.totalWaitingDays) return b.totalWaitingDays - a.totalWaitingDays;
  if (b.currentlyWaitingEpisodeCount !== a.currentlyWaitingEpisodeCount) {
    return b.currentlyWaitingEpisodeCount - a.currentlyWaitingEpisodeCount;
  }
  return a.key.localeCompare(b.key);
}

function pickHighestWaitingBucket(
  buckets: WorkforceDimensionBucketMetrics[],
  minSample: number,
): WorkforceDimensionBucketMetrics | null {
  const qualified = buckets.filter(
    (b) => b.waitingEpisodeCount >= minSample && b.avgWaitingDaysPerEpisode !== null,
  );
  if (qualified.length === 0) return null;
  qualified.sort(compareHighestWaitingBuckets);
  return qualified[0] ?? null;
}

/**
 * Sinh danh sách "Điểm cần chú ý" hoàn toàn tất định (rule-based) từ đúng các con số đang hiển thị.
 * Luôn kiểm tra ngưỡng mẫu tối thiểu (`WORKFORCE_HIGHLIGHT_MIN_SAMPLE_SIZE = 3`) trước khi xếp hạng
 * dự án/nhóm có giữ chân D30 thấp nhất hoặc chờ việc lâu nhất.
 */
export function deriveWorkforceAttentionInsights(
  workforce: Extract<WorkforceReportingResult, { status: "ready" }>,
  minSampleSize: number = WORKFORCE_HIGHLIGHT_MIN_SAMPLE_SIZE,
): WorkforceAttentionInsight[] {
  const { snapshot, waiting, retention, dimensions, leaveReasons } = workforce;
  const total = snapshot.eligibleEpisodeTotal;

  if (total === 0) {
    return [
      {
        id: "empty-scope",
        tone: "slate",
        badgeLabel: "Cơ cấu lực lượng",
        title: "Chưa có đợt làm việc đủ điều kiện tại ngày mốc",
        detail: `Tại ngày mốc ${snapshot.asOfDate}, phạm vi lọc hiện hành có 0 đợt làm việc bắt đầu từ ngày mốc trở về trước.`,
      },
    ];
  }

  const insights: WorkforceAttentionInsight[] = [];

  // 1. Cơ cấu lực lượng hiện hành tại ngày mốc
  const onShare = formatShareRatePercent(snapshot.onCount / total);
  const waitingShare = formatShareRatePercent(snapshot.unconfirmedCount / total);
  const offShare = formatShareRatePercent(snapshot.offCount / total);
  insights.push({
    id: "snapshot-composition",
    tone: snapshot.onCount >= snapshot.offCount ? "emerald" : "amber",
    badgeLabel: "Phân bổ tại ngày mốc",
    title: `Đang làm chiếm ${onShare} (${VI_INT_FORMATTER.format(snapshot.onCount)}/${VI_INT_FORMATTER.format(total)} đợt)`,
    detail: `Đang chờ việc: ${VI_INT_FORMATTER.format(snapshot.unconfirmedCount)} đợt (${waitingShare}) · Đã nghỉ: ${VI_INT_FORMATTER.format(snapshot.offCount)} đợt (${offShare})${snapshot.unknownCount > 0 ? ` · Chưa có trạng thái đến ngày mốc: ${VI_INT_FORMATTER.format(snapshot.unknownCount)} đợt` : ""}.`,
  });

  // 2. Giữ chân mốc 30 ngày (D30) theo Dự án / Nhóm (có ngưỡng mẫu tối thiểu)
  const lowestProjectD30 = pickLowestD30RetentionBucket(
    dimensions.byProject.buckets,
    minSampleSize,
  );
  const lowestTeamD30 = pickLowestD30RetentionBucket(dimensions.byTeam.buckets, minSampleSize);
  const pickTeamForD30 =
    lowestTeamD30 !== null &&
    (lowestProjectD30 === null ||
      compareLowestD30RetentionBuckets(lowestTeamD30, lowestProjectD30) < 0);
  const targetD30 = pickTeamForD30 ? lowestTeamD30 : lowestProjectD30;
  const targetD30DimLabel = pickTeamForD30 ? "Nhóm" : "Dự án";

  if (targetD30) {
    const cp = targetD30.checkpoints.d30;
    const rateText = formatRetentionRatePercent(cp.retentionRate);
    insights.push({
      id: "d30-retention-focus",
      tone: (cp.retentionRate ?? 1) < 0.7 ? "amber" : "emerald",
      badgeLabel: "Giữ chân mốc 30 ngày (D30)",
      title: `${targetD30DimLabel} có tỷ lệ duy trì D30 thấp nhất: ${targetD30.display} (${rateText})`,
      detail: `Duy trì liên tục ${VI_INT_FORMATTER.format(cp.retainedCount)}/${VI_INT_FORMATTER.format(cp.maturedCount)} đợt đã đủ tuổi D30 (rời sớm ${VI_INT_FORMATTER.format(cp.exitedCount)} đợt; xét các chiều có mẫu ≥ ${minSampleSize} đợt đủ tuổi D30).`,
    });
  } else {
    const overallD30 = retention.checkpoints.d30;
    insights.push({
      id: "d30-retention-sample-guard",
      tone: "slate",
      badgeLabel: "Giữ chân mốc 30 ngày (D30)",
      title:
        overallD30.maturedCount > 0
          ? `Toàn phạm vi duy trì D30 đạt ${formatRetentionRatePercent(overallD30.retentionRate)} (${VI_INT_FORMATTER.format(overallD30.retainedCount)}/${VI_INT_FORMATTER.format(overallD30.maturedCount)} đợt)`
          : "Chưa có đợt làm việc đủ tuổi mốc 30 ngày (D30)",
      detail: `Chưa xếp hạng dự án/nhóm có tỷ lệ giữ chân D30 thấp nhất do chưa có chiều nào đạt ngưỡng mẫu tối thiểu ≥ ${minSampleSize} đợt đủ tuổi D30.`,
    });
  }

  // 3. Thời gian chờ việc theo Nhóm / Dự án (có ngưỡng mẫu tối thiểu)
  const highestTeamWaiting = pickHighestWaitingBucket(dimensions.byTeam.buckets, minSampleSize);
  const highestProjectWaiting = pickHighestWaitingBucket(
    dimensions.byProject.buckets,
    minSampleSize,
  );
  const pickProjectForWaiting =
    highestProjectWaiting !== null &&
    (highestTeamWaiting === null ||
      compareHighestWaitingBuckets(highestProjectWaiting, highestTeamWaiting) < 0);
  const targetWaiting = pickProjectForWaiting ? highestProjectWaiting : highestTeamWaiting;
  const targetWaitingDimLabel = pickProjectForWaiting ? "Dự án" : "Nhóm";

  if (targetWaiting) {
    insights.push({
      id: "waiting-duration-focus",
      tone: "sky",
      badgeLabel: "Thời gian chờ việc",
      title: `${targetWaitingDimLabel} có thời gian chờ trung bình cao nhất: ${targetWaiting.display} (${formatWaitingDaysAverage(targetWaiting.avgWaitingDaysPerEpisode)})`,
      detail: `Tổng ${VI_INT_FORMATTER.format(targetWaiting.totalWaitingDays)} ngày chờ trên ${VI_INT_FORMATTER.format(targetWaiting.waitingEpisodeCount)} đợt từng chờ việc (hiện còn chờ ${VI_INT_FORMATTER.format(targetWaiting.currentlyWaitingEpisodeCount)} đợt; ngưỡng mẫu ≥ ${minSampleSize} đợt).`,
    });
  } else {
    insights.push({
      id: "waiting-duration-sample-guard",
      tone: "slate",
      badgeLabel: "Thời gian chờ việc",
      title:
        waiting.waitingEpisodeTotal > 0
          ? `Trung bình toàn phạm vi: ${formatWaitingDaysAverage(waiting.allWaiting.avgWaitingDaysPerEpisode)} (${VI_INT_FORMATTER.format(waiting.waitingEpisodeTotal)} đợt từng chờ)`
          : "Không phát sinh đợt chờ việc tại ngày mốc",
      detail:
        waiting.waitingEpisodeTotal > 0
          ? `Chưa xếp hạng nhóm/dự án chờ việc lâu nhất do chưa có chiều nào đạt ngưỡng mẫu ≥ ${minSampleSize} đợt từng chờ việc.`
          : "Tất cả các đợt đã xác định trạng thái đều vào thẳng Đang làm.",
    });
  }

  // 4. Lý do nghỉ việc chiếm tỷ trọng lớn nhất & độ phủ lý do
  if (leaveReasons.offEpisodeTotal >= minSampleSize) {
    const sortedCategories = [...leaveReasons.byCategory]
      .filter((c) => c.episodeCount > 0)
      .sort((a, b) => b.episodeCount - a.episodeCount);
    const topCategory = sortedCategories[0];
    if (topCategory) {
      insights.push({
        id: "leave-reason-top",
        tone: topCategory.kind === "missing_or_unknown" ? "amber" : "slate",
        badgeLabel: "Lý do nghỉ việc",
        title: `Nhóm chiếm tỷ trọng cao nhất: ${topCategory.label} (${formatShareRatePercent(topCategory.shareOfOffRate)})`,
        detail: `Ghi nhận ${VI_INT_FORMATTER.format(topCategory.episodeCount)}/${VI_INT_FORMATTER.format(leaveReasons.offEpisodeTotal)} đợt Đã nghỉ tại ngày mốc · Độ phủ có lý do đạt ${formatCoverageRatePercent(leaveReasons.reasonCoverageRate)} (${VI_INT_FORMATTER.format(leaveReasons.withReasonEpisodeCount)}/${VI_INT_FORMATTER.format(leaveReasons.offEpisodeTotal)} đợt).`,
      });
    }
  } else if (leaveReasons.offEpisodeTotal > 0) {
    insights.push({
      id: "leave-reason-small-sample",
      tone: "slate",
      badgeLabel: "Lý do nghỉ việc",
      title: `Có ${VI_INT_FORMATTER.format(leaveReasons.offEpisodeTotal)} đợt Đã nghỉ tại ngày mốc (dưới ngưỡng xếp hạng ≥ ${minSampleSize} đợt)`,
      detail: `Đã ghi nhận lý do cho ${VI_INT_FORMATTER.format(leaveReasons.withReasonEpisodeCount)}/${VI_INT_FORMATTER.format(leaveReasons.offEpisodeTotal)} đợt (${formatCoverageRatePercent(leaveReasons.reasonCoverageRate)}); thiếu hoặc chưa rõ lý do: ${VI_INT_FORMATTER.format(leaveReasons.missingReasonEpisodeCount)} đợt.`,
    });
  } else {
    insights.push({
      id: "leave-reason-zero",
      tone: "emerald",
      badgeLabel: "Lý do nghỉ việc",
      title: "Chưa phát sinh đợt Đã nghỉ tại ngày mốc",
      detail: `Tại ngày mốc ${snapshot.asOfDate}, có 0 đợt làm việc ở trạng thái Đã nghỉ.`,
    });
  }

  return insights;
}
