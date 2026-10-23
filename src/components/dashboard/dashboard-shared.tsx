"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { useNotify } from "@/components/ui/notify-provider";
import { formatTimestamp } from "@/lib/format";
import { sortBuckets } from "@/lib/reporting/p1-dashboard";
import {
  formatPeriodComparisonSummary,
  type PeriodComparisonResult,
} from "@/lib/reporting/p1-period-comparison";
import {
  WORKFORCE_BALANCE_COLUMN_LABELS,
  WORKFORCE_DIMENSION_ATTRIBUTION_NOTE,
  WORKFORCE_DIMENSION_KIND_LABELS,
  WORKFORCE_DURATION_BUCKET_LABELS,
  WORKFORCE_DURATION_SAMPLE_LABELS,
  WORKFORCE_INITIAL_STATUS_LABELS,
  WORKFORCE_LEAVE_REASON_STANDARDIZATION_NOTE,
  WORKFORCE_NON_ATTENDANCE_NOTE,
  WORKFORCE_PROJECT_DEFAULT_PAGE_SIZE,
  WORKFORCE_RETENTION_CHECKPOINT_LABELS,
  WORKFORCE_SNAPSHOT_STATUS_LABELS,
  WORKFORCE_TRANSITION_PAIR_LABELS,
  WORKFORCE_UNIT_METADATA_NOTE,
  WORKFORCE_WAITING_SAMPLE_LABELS,
  type WorkforceDimensionBucketMetrics,
  type WorkforceDimensionKind,
  type WorkforceOverviewResult,
  type WorkforceProjectPageResult,
  type WorkforceReportingResult,
} from "@/lib/reporting/wf01-workforce-snapshot";
import {
  formatPlacementRatePercent,
  formatSignedBalanceDelta,
  formatWaitingDaysAverage,
} from "@/lib/reporting/wf02-workforce-balance-waiting";
import {
  formatDurationDaysAverage,
  formatRetentionRatePercent,
} from "@/lib/reporting/wf03-workforce-tenure-retention";
import {
  deriveWorkforceAttentionInsights,
  formatCoverageRatePercent,
  formatShareRatePercent,
  WORKFORCE_HIGHLIGHT_MIN_SAMPLE_SIZE,
} from "@/lib/reporting/wf04-workforce-dimensions-leave-reasons";
import type { ReportingBucket, ReportingData } from "@/lib/reporting/p1-reporting";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";

import {
  BiClearHighlightButton,
  isBucketRowHighlighted,
  useBiHighlight,
} from "./bi-cross-highlight";
import { DashboardFilters } from "./dashboard-filters";

export type { WorkforceOverviewResult, WorkforceReportingResult };

/**
 * P3-W06C - shared dashboard pieces reused by the BoD / Team / Own views.
 * No audience decision lives here: callers pass only the scoped options they
 * already received from the DB-authoritative W05A read path.
 */

export function FiltersOrError({
  optionsResult,
  showRecruiter = true,
}: {
  optionsResult: ReportingOptionsResult;
  showRecruiter?: boolean;
}) {
  if (optionsResult.ok) {
    return <DashboardFilters options={optionsResult.options} showRecruiter={showRecruiter} />;
  }
  return (
    <Alert tone="error" title="Không tải được danh mục bộ lọc">
      <p>{optionsResult.code} · {optionsResult.message}</p>
      <p>Dữ liệu bên dưới vẫn đúng cho URL hiện tại, nhưng không thể chọn bộ lọc. Hãy thử tải lại trang.</p>
    </Alert>
  );
}

export function NoMatchesBlock({ detail }: { detail?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/10 px-6 py-12 text-center">
      <p className="text-sm font-medium text-foreground">Không có dữ liệu khớp bộ lọc hiện tại</p>
      <p className="mt-1 text-sm text-muted">
        {detail ?? "Không có ngày/dự án/người tuyển/nhóm nào khớp bộ lọc đang chọn."}
      </p>
      <p className="mt-4">
        <Link href="/dashboard" className="inline-flex min-h-11 h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary/90">
          Xóa bộ lọc
        </Link>
      </p>
    </div>
  );
}

/**
 * Scope banner: makes the DB-authoritative audience visible on the page.
 */
export function ScopeNote({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p role="note" aria-label={label} className="rounded-2xl border border-border bg-muted/10 px-4 py-2 text-sm text-muted">
      {children}
    </p>
  );
}

/**
 * MBI-DA-2026-01 Wave 3 (Item 1.5) — Equivalent prior-period comparison strip.
 * Keeps current KPI values intact while showing increase/decrease/equal state,
 * absolute + percentage delta, and the exact comparison window.
 */
export function PeriodComparisonBanner({
  comparison,
}: {
  comparison?: PeriodComparisonResult;
}) {
  if (!comparison) return null;
  const formatted = formatPeriodComparisonSummary(comparison);
  return (
    <section
      aria-label="So sánh với kỳ trước tương đương"
      className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-surface px-4 py-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={formatted.badgeTone} dot>
          {formatted.badgeLabel}
        </StatusBadge>
        <span className="font-semibold tabular-nums text-foreground">
          {formatted.deltaText}
        </span>
      </div>
      <p className="text-xs text-muted">{formatted.detailText}</p>
    </section>
  );
}

/**
 * WF-04 Post-Merge Hotfix — Khu vực Workforce trên tab `Báo cáo tổng quát`:
 * Chỉ hiển thị phần đầu:
 * - Header `Hiện trạng & biến động trạng thái lao động`
 * - Dòng chú thích nghiệp vụ ở hàng riêng chiếm toàn bộ chiều rộng card (`w-full`)
 * - `Trạng thái lao động tại ngày chốt` (2.1)
 * - `Biến động trạng thái trong kỳ` (2.2)
 * Toàn bộ các phần chuyên sâu (2.3–2.8 & Điểm cần chú ý) được tách sang tab `Báo cáo chuyên sâu`.
 */
export function WorkforceSnapshotSection({
  workforce,
}: {
  workforce?: WorkforceOverviewResult | WorkforceReportingResult | null;
}) {
  if (!workforce) return null;

  if (workforce.status === "unavailable") {
    return (
      <section
        aria-label="Hiện trạng và biến động trạng thái lao động"
        className="rounded-2xl border border-status-warning-border bg-status-warning-bg px-4 py-3 text-sm text-status-warning-text"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-semibold">Hiện trạng &amp; biến động trạng thái lao động</p>
          <StatusBadge tone="warning" dot>
            Tạm thời chưa khả dụng
          </StatusBadge>
        </div>
        <p className="mt-1 text-xs">
          Không tải được dữ liệu trạng thái lao động tại ngày chốt và biến động trạng thái trong kỳ. Các chỉ số tuyển dụng theo ngày ghi nhận tuyển dụng vẫn giữ nguyên.
        </p>
      </section>
    );
  }

  const { snapshot, transitions } = workforce;

  const asOfSourceLabel =
    snapshot.asOfSource === "filter_to"
      ? "Theo ngày kết thúc bộ lọc"
      : snapshot.asOfSource === "explicit_as_of"
        ? "Theo ngày mốc chỉ định"
        : "Theo ngày hiện hành (GMT+7)";

  const snapshotShare = (count: number) =>
    snapshot.eligibleEpisodeTotal > 0 ? count / snapshot.eligibleEpisodeTotal : null;

  const snapshotPctWidth = (count: number) =>
    snapshot.eligibleEpisodeTotal > 0
      ? Math.max(0, Math.min(100, (count / snapshot.eligibleEpisodeTotal) * 100))
      : 0;

  const transitionRows = transitions.applicable
    ? [
        {
          key: "unconfirmed_to_on",
          label: WORKFORCE_TRANSITION_PAIR_LABELS.UNCONFIRMED_TO_ON,
          pair: transitions.pairs.unconfirmedToOn,
          barColor: "bg-emerald-500",
        },
        {
          key: "unconfirmed_to_off",
          label: WORKFORCE_TRANSITION_PAIR_LABELS.UNCONFIRMED_TO_OFF,
          pair: transitions.pairs.unconfirmedToOff,
          barColor: "bg-amber-500",
        },
        {
          key: "on_to_off",
          label: WORKFORCE_TRANSITION_PAIR_LABELS.ON_TO_OFF,
          pair: transitions.pairs.onToOff,
          barColor: "bg-rose-500",
        },
        {
          key: "off_to_on",
          label: WORKFORCE_TRANSITION_PAIR_LABELS.OFF_TO_ON,
          pair: transitions.pairs.offToOn,
          barColor: "bg-sky-500",
        },
        ...(transitions.pairs.other.eventCount > 0
          ? [
              {
                key: "other",
                label: WORKFORCE_TRANSITION_PAIR_LABELS.OTHER,
                pair: transitions.pairs.other,
                barColor: "bg-slate-400",
              },
            ]
          : []),
      ]
    : [];

  const maxTransitionEvents = transitionRows.reduce(
    (acc, r) => Math.max(acc, r.pair.eventCount),
    0,
  );

  return (
    <section aria-label="Hiện trạng và biến động trạng thái lao động">
      <Card className="p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardHeader title="Hiện trạng & biến động trạng thái lao động" />
          <div className="shrink-0">
            <StatusBadge tone="neutral" dot>
              Tính đến ngày {snapshot.asOfDate} ({asOfSourceLabel})
            </StatusBadge>
          </div>
        </div>

        {/* Dòng chú thích nghiệp vụ nằm ở hàng riêng và chiếm toàn bộ chiều rộng card */}
        <div className="mt-2 w-full rounded-lg border border-border bg-muted/10 px-3 py-2 text-xs text-muted">
          {WORKFORCE_UNIT_METADATA_NOTE}
        </div>

        {/* WF-01 (2.1 & 2.2): Trạng thái lao động tại ngày chốt & Biến động trạng thái trong kỳ */}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="rounded-xl border border-border bg-muted/5 p-3 lg:col-span-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                Trạng thái lao động tại ngày chốt
              </h3>
              <span className="text-xs tabular-nums text-muted">
                Tính đến ngày {snapshot.asOfDate}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted">
              Các đợt làm việc hợp lệ trong phạm vi có ngày bắt đầu làm việc ≤ {snapshot.asOfDate} (tính theo ngày trạng thái có hiệu lực).
            </p>

            {/* Thanh cơ cấu 100% trạng thái tại ngày mốc */}
            <div className="mt-3 rounded-lg border border-border bg-surface p-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground">
                  Cơ cấu 100% trạng thái tại ngày mốc
                </span>
                <span className="font-semibold tabular-nums text-foreground">
                  {snapshot.eligibleEpisodeTotal}{" "}
                  <span className="font-normal text-muted">đợt đủ điều kiện</span>
                </span>
              </div>
              <div
                aria-label="Thanh cơ cấu tỷ trọng trạng thái tại ngày mốc"
                className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-muted/20"
              >
                {snapshot.onCount > 0 ? (
                  <div
                    className="bg-emerald-500 transition-all"
                    style={{ width: `${snapshotPctWidth(snapshot.onCount)}%` }}
                    title={`${WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}: ${snapshot.onCount} đợt (${formatShareRatePercent(snapshotShare(snapshot.onCount))})`}
                  />
                ) : null}
                {snapshot.unconfirmedCount > 0 ? (
                  <div
                    className="bg-amber-500 transition-all"
                    style={{ width: `${snapshotPctWidth(snapshot.unconfirmedCount)}%` }}
                    title={`${WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED}: ${snapshot.unconfirmedCount} đợt (${formatShareRatePercent(snapshotShare(snapshot.unconfirmedCount))})`}
                  />
                ) : null}
                {snapshot.offCount > 0 ? (
                  <div
                    className="bg-rose-500 transition-all"
                    style={{ width: `${snapshotPctWidth(snapshot.offCount)}%` }}
                    title={`${WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF}: ${snapshot.offCount} đợt (${formatShareRatePercent(snapshotShare(snapshot.offCount))})`}
                  />
                ) : null}
                {snapshot.unknownCount > 0 ? (
                  <div
                    className="bg-slate-400 transition-all"
                    style={{ width: `${snapshotPctWidth(snapshot.unknownCount)}%` }}
                    title={`${WORKFORCE_SNAPSHOT_STATUS_LABELS.UNKNOWN}: ${snapshot.unknownCount} đợt (${formatShareRatePercent(snapshotShare(snapshot.unknownCount))})`}
                  />
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON} ({formatShareRatePercent(snapshotShare(snapshot.onCount))})
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  {WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED} ({formatShareRatePercent(snapshotShare(snapshot.unconfirmedCount))})
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-rose-500" />
                  {WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF} ({formatShareRatePercent(snapshotShare(snapshot.offCount))})
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-slate-400" />
                  {WORKFORCE_SNAPSHOT_STATUS_LABELS.UNKNOWN} ({formatShareRatePercent(snapshotShare(snapshot.unknownCount))})
                </span>
              </div>
            </div>

            <dl className="mt-2.5 grid grid-cols-2 gap-2">
              <div className="col-span-2 flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs font-medium text-muted">Tổng đợt làm việc đủ điều kiện tại ngày mốc</dt>
                <dd className="text-base font-semibold tabular-nums text-foreground">
                  {snapshot.eligibleEpisodeTotal} <span className="text-xs font-normal text-muted">đợt làm việc (100%)</span>
                </dd>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <div className="flex items-center justify-between gap-1">
                  <dt className="text-xs text-muted">{WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}</dt>
                  <span className="text-[11px] font-medium tabular-nums text-emerald-700 dark:text-emerald-300">
                    {formatShareRatePercent(snapshotShare(snapshot.onCount))}
                  </span>
                </div>
                <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {snapshot.onCount} <span className="text-xs font-normal text-muted">đợt làm việc</span>
                </dd>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <div className="flex items-center justify-between gap-1">
                  <dt className="text-xs text-muted">{WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED}</dt>
                  <span className="text-[11px] font-medium tabular-nums text-amber-700 dark:text-amber-300">
                    {formatShareRatePercent(snapshotShare(snapshot.unconfirmedCount))}
                  </span>
                </div>
                <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {snapshot.unconfirmedCount} <span className="text-xs font-normal text-muted">đợt làm việc</span>
                </dd>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <div className="flex items-center justify-between gap-1">
                  <dt className="text-xs text-muted">{WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF}</dt>
                  <span className="text-[11px] font-medium tabular-nums text-rose-700 dark:text-rose-300">
                    {formatShareRatePercent(snapshotShare(snapshot.offCount))}
                  </span>
                </div>
                <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {snapshot.offCount} <span className="text-xs font-normal text-muted">đợt làm việc</span>
                </dd>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <div className="flex items-center justify-between gap-1">
                  <dt className="text-xs text-muted">{WORKFORCE_SNAPSHOT_STATUS_LABELS.UNKNOWN}</dt>
                  <span className="text-[11px] font-medium tabular-nums text-muted">
                    {formatShareRatePercent(snapshotShare(snapshot.unknownCount))}
                  </span>
                </div>
                <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {snapshot.unknownCount} <span className="text-xs font-normal text-muted">đợt làm việc</span>
                </dd>
              </div>
            </dl>

            {snapshot.futureEpisodeCount > 0 ? (
              <p className="mt-2 text-xs text-muted">
                Chưa bắt đầu làm việc tại ngày {snapshot.asOfDate} (ngày bắt đầu làm việc sau {snapshot.asOfDate}):{" "}
                <span className="font-medium tabular-nums text-foreground">{snapshot.futureEpisodeCount}</span> đợt làm việc (tách riêng, không cộng vào snapshot).
              </p>
            ) : null}
          </div>

          <div className="rounded-xl border border-border bg-muted/5 p-3 lg:col-span-7">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                Biến động trạng thái trong kỳ
              </h3>
              {transitions.applicable ? (
                <span className="text-xs tabular-nums text-muted">
                  Kỳ {transitions.fromDate} → {transitions.toDate}
                </span>
              ) : null}
            </div>

            {!transitions.applicable ? (
              <p className="mt-2 rounded-lg border border-dashed border-border bg-surface px-3 py-4 text-xs text-muted">
                {transitions.windowLabel}
              </p>
            ) : (
              <div className="mt-2 space-y-3">
                <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-foreground">
                      Khởi tạo đợt làm việc mới trong kỳ (lần thay đổi trạng thái đầu tiên)
                    </span>
                    <span className="tabular-nums text-muted">
                      Tổng: <strong className="text-foreground">{transitions.initial.total.eventCount}</strong> lần /{" "}
                      <strong className="text-foreground">{transitions.initial.total.episodeCount}</strong> đợt làm việc
                    </span>
                  </div>
                  <p className="mt-1 text-muted">
                    {WORKFORCE_INITIAL_STATUS_LABELS.INITIAL_ON}:{" "}
                    <span className="font-medium tabular-nums text-foreground">{transitions.initial.on.eventCount}</span> lần (
                    <span className="tabular-nums">{transitions.initial.on.episodeCount}</span> đợt làm việc)
                    {" · "}
                    {WORKFORCE_INITIAL_STATUS_LABELS.INITIAL_UNCONFIRMED}:{" "}
                    <span className="font-medium tabular-nums text-foreground">{transitions.initial.unconfirmed.eventCount}</span> lần (
                    <span className="tabular-nums">{transitions.initial.unconfirmed.episodeCount}</span> đợt làm việc)
                  </p>
                </div>

                {/* Biểu đồ thanh ngang so sánh các luồng chuyển tiếp trạng thái */}
                <div className="rounded-lg border border-border bg-surface p-2.5">
                  <p className="text-xs font-medium text-foreground">
                    So sánh trực quan các luồng chuyển trạng thái trong kỳ
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {transitionRows.map((row) => {
                      const barPct =
                        maxTransitionEvents > 0
                          ? Math.max(2, Math.round((row.pair.eventCount / maxTransitionEvents) * 100))
                          : 0;
                      const shareRate =
                        transitions.totals.transitionEventCount > 0
                          ? row.pair.eventCount / transitions.totals.transitionEventCount
                          : null;
                      return (
                        <div key={`bar-${row.key}`} className="text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-muted">{row.label}</span>
                            <span className="tabular-nums text-foreground">
                              <strong>{row.pair.eventCount}</strong> lần ({row.pair.episodeCount} đợt · {formatShareRatePercent(shareRate)})
                            </span>
                          </div>
                          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted/20">
                            {row.pair.eventCount > 0 ? (
                              <div
                                className={`h-full rounded-full ${row.barColor}`}
                                style={{ width: `${barPct}%` }}
                              />
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="overflow-x-auto rounded-lg border border-border bg-surface">
                  <table className="r22-report-table w-full text-left text-xs">
                    <caption className="sr-only">
                      Bảng chuyển tiếp trạng thái lao động trong kỳ {transitions.fromDate} đến {transitions.toDate}
                    </caption>
                    <thead className="bg-surface-muted uppercase tracking-wide text-muted">
                      <tr className="border-b border-border">
                        <th scope="col" className="px-3 py-1.5 font-medium">
                          Chuyển tiếp trạng thái (không tính khởi tạo)
                        </th>
                        <th scope="col" className="px-3 py-1.5 text-right font-medium">
                          Số sự kiện
                        </th>
                        <th scope="col" className="px-3 py-1.5 text-right font-medium">
                          Số hồ sơ
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {transitionRows.map((row) => (
                        <tr key={row.key} className="text-foreground hover:bg-surface-hover">
                          <td className="px-3 py-1.5">{row.label}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                            {row.pair.eventCount}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                            {row.pair.episodeCount}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t border-border bg-muted/10 font-medium text-foreground">
                      <tr>
                        <td className="px-3 py-1.5">Tổng biến động chuyển trạng thái trong kỳ</td>
                        <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                          {transitions.totals.transitionEventCount}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                          {transitions.totals.transitionEpisodeCount}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}

export const WorkforceStatusSection = WorkforceSnapshotSection;

export function buildWorkforceDeepFilterSignature(data: ReportingData): string {
  const a = data.applied;
  return [
    a.from ?? "",
    a.to ?? "",
    a.project ?? "",
    a.recruiter ?? "",
    a.provider ?? "",
    a.employment ?? "",
  ].join("|");
}

export function buildWorkforceDeepUrl(
  data: ReportingData,
  options?: { mode?: "deep" | "project_page"; cursor?: string | null },
): string {
  const query = new URLSearchParams();
  const a = data.applied;
  if (a.from) query.set("from", a.from);
  else if (!a.to) query.set("range", "all");
  if (a.to) query.set("to", a.to);
  if (a.project) query.set("project", a.project);
  if (a.recruiter) query.set("recruiter", a.recruiter);
  if (a.provider) query.set("provider", a.provider);
  if (a.employment) query.set("employment", a.employment);
  if (options?.mode && options.mode !== "deep") {
    query.set("mode", options.mode);
  }
  if (options?.cursor) {
    query.set("cursor", options.cursor);
  }
  return "/api/reporting/workforce-deep?" + query.toString();
}

function isReadyWorkforceDeepEnvelope(value: unknown): value is {
  ok: true;
  mode: "deep";
  workforce: Extract<WorkforceReportingResult, { status: "ready" }>;
} {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (r.ok !== true || r.mode !== "deep") return false;
  const wf = r.workforce as Record<string, unknown> | null | undefined;
  return Boolean(wf && typeof wf === "object" && wf.status === "ready");
}

function isReadyWorkforceProjectPageEnvelope(value: unknown): value is {
  ok: true;
  mode: "project_page";
  projectPage: Extract<WorkforceProjectPageResult, { status: "ready" }>;
} {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (r.ok !== true || r.mode !== "project_page") return false;
  const pp = r.projectPage as Record<string, unknown> | null | undefined;
  return Boolean(pp && typeof pp === "object" && pp.status === "ready" && Array.isArray(pp.rows));
}

/**
 * WF-04 Post-Merge Hotfix — Nội dung hiển thị trong tab `Báo cáo chuyên sâu`:
 * Bao gồm:
 * - Điểm cần chú ý tại ngày mốc
 * - Đối soát cân bằng đầu kỳ / cuối kỳ (2.3)
 * - Thời gian chờ việc & tỷ lệ bố trí việc (2.4)
 * - Thâm niên làm việc & ngày hiện diện theo trạng thái (2.5)
 * - Nghỉ sớm & giữ chân theo mốc D7 / D30 / D90 (2.6)
 * - Chất lượng lực lượng theo chiều phân tích (2.7) kèm phân trang server-side 5 dự án/lần ("Tải thêm")
 * - Phân tích lý do nghỉ việc & độ phủ dữ liệu (2.8)
 */
export function WorkforceDeepSection({
  workforce,
  extraProjectBuckets = [],
  projectPaginationOverride,
  isLoadingMoreProjects = false,
  loadMoreProjectsError = false,
  onLoadMoreProjects,
}: {
  workforce: Extract<WorkforceReportingResult, { status: "ready" }>;
  extraProjectBuckets?: readonly WorkforceDimensionBucketMetrics[];
  projectPaginationOverride?: {
    totalCount: number;
    pageSize: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
  isLoadingMoreProjects?: boolean;
  loadMoreProjectsError?: boolean;
  onLoadMoreProjects?: () => void;
}) {
  const [activeDimensionKind, setActiveDimensionKind] =
    useState<WorkforceDimensionKind>("project");

  const {
    snapshot,
    balance,
    waiting,
    duration,
    retention,
    dimensions,
    leaveReasons,
  } = workforce;

  const asOfSourceLabel =
    snapshot.asOfSource === "filter_to"
      ? "Theo ngày kết thúc bộ lọc"
      : snapshot.asOfSource === "explicit_as_of"
        ? "Theo ngày mốc chỉ định"
        : "Theo ngày hiện hành (GMT+7)";

  const attentionInsights = deriveWorkforceAttentionInsights(workforce);

  // Gộp các trang dự án đã tải từ server mà không bao giờ trùng lặp khóa (dim_key)
  const mergedProjectBuckets: WorkforceDimensionBucketMetrics[] = [];
  const seenProjectKeys = new Set<string>();
  for (const b of [...dimensions.byProject.buckets, ...extraProjectBuckets]) {
    if (!seenProjectKeys.has(b.key)) {
      seenProjectKeys.add(b.key);
      mergedProjectBuckets.push(b);
    }
  }

  const effectiveProjectPagination = projectPaginationOverride ??
    dimensions.byProject.pagination ?? {
      totalCount: mergedProjectBuckets.length,
      pageSize: WORKFORCE_PROJECT_DEFAULT_PAGE_SIZE,
      hasMore: false,
      nextCursor: null,
    };

  const pagedProjectGroup = {
    ...dimensions.byProject,
    buckets: mergedProjectBuckets,
  };

  const balanceRows = balance.applicable
    ? [
        {
          key: "on",
          label: WORKFORCE_SNAPSHOT_STATUS_LABELS.ON,
          row: balance.byStatus.on,
          dotClass: "bg-emerald-500",
        },
        {
          key: "unconfirmed",
          label: WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED,
          row: balance.byStatus.unconfirmed,
          dotClass: "bg-amber-500",
        },
        {
          key: "off",
          label: WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF,
          row: balance.byStatus.off,
          dotClass: "bg-rose-500",
        },
        {
          key: "unknown",
          label: WORKFORCE_SNAPSHOT_STATUS_LABELS.UNKNOWN,
          row: balance.byStatus.unknown,
          dotClass: "bg-slate-400",
        },
      ]
    : [];

  const waitingSampleRows = [
    {
      key: "all_waiting",
      label: WORKFORCE_WAITING_SAMPLE_LABELS.ALL_WAITING,
      sample: waiting.allWaiting,
    },
    {
      key: "completed_waiting",
      label: WORKFORCE_WAITING_SAMPLE_LABELS.COMPLETED_WAITING,
      sample: waiting.completedWaiting,
    },
    {
      key: "placed_to_on",
      label: WORKFORCE_WAITING_SAMPLE_LABELS.PLACED_TO_ON,
      sample: waiting.placedToOn,
    },
    {
      key: "exited_without_on",
      label: WORKFORCE_WAITING_SAMPLE_LABELS.EXITED_WITHOUT_ON,
      sample: waiting.exitedWithoutOn,
    },
    {
      key: "currently_waiting",
      label: WORKFORCE_WAITING_SAMPLE_LABELS.CURRENTLY_WAITING,
      sample: waiting.currentlyWaiting,
    },
  ];

  const durationSampleRows = [
    {
      key: "all_ever_on",
      label: WORKFORCE_DURATION_SAMPLE_LABELS.ALL_EVER_ON,
      sample: duration.allEverOn,
    },
    {
      key: "currently_on",
      label: WORKFORCE_DURATION_SAMPLE_LABELS.CURRENTLY_ON,
      sample: duration.currentlyOn,
    },
    {
      key: "exited_after_on",
      label: WORKFORCE_DURATION_SAMPLE_LABELS.EXITED_AFTER_ON,
      sample: duration.exitedAfterOn,
    },
  ];

  const durationBucketRows = [
    {
      key: "days_0_to_7",
      label: WORKFORCE_DURATION_BUCKET_LABELS.DAYS_0_TO_7,
      count: duration.distribution.days0To7Count,
      barColor: "bg-sky-500",
    },
    {
      key: "days_8_to_30",
      label: WORKFORCE_DURATION_BUCKET_LABELS.DAYS_8_TO_30,
      count: duration.distribution.days8To30Count,
      barColor: "bg-emerald-500",
    },
    {
      key: "days_31_to_90",
      label: WORKFORCE_DURATION_BUCKET_LABELS.DAYS_31_TO_90,
      count: duration.distribution.days31To90Count,
      barColor: "bg-indigo-500",
    },
    {
      key: "days_91_plus",
      label: WORKFORCE_DURATION_BUCKET_LABELS.DAYS_91_PLUS,
      count: duration.distribution.days91PlusCount,
      barColor: "bg-violet-500",
    },
  ];

  const retentionCheckpointRows = [
    {
      key: "d7",
      label: WORKFORCE_RETENTION_CHECKPOINT_LABELS.D7,
      checkpoint: retention.checkpoints.d7,
    },
    {
      key: "d30",
      label: WORKFORCE_RETENTION_CHECKPOINT_LABELS.D30,
      checkpoint: retention.checkpoints.d30,
    },
    {
      key: "d90",
      label: WORKFORCE_RETENTION_CHECKPOINT_LABELS.D90,
      checkpoint: retention.checkpoints.d90,
    },
  ];

  const dimensionTabs: Array<{
    kind: WorkforceDimensionKind;
    label: string;
    totalUnits: number;
    group: typeof dimensions.byProject;
  }> = [
    {
      kind: "project",
      label: WORKFORCE_DIMENSION_KIND_LABELS.PROJECT,
      totalUnits: effectiveProjectPagination.totalCount,
      group: pagedProjectGroup,
    },
    {
      kind: "team",
      label: WORKFORCE_DIMENSION_KIND_LABELS.TEAM,
      totalUnits: dimensions.byTeam.buckets.length,
      group: dimensions.byTeam,
    },
    {
      kind: "recruiter",
      label: WORKFORCE_DIMENSION_KIND_LABELS.RECRUITER,
      totalUnits: dimensions.byRecruiter.buckets.length,
      group: dimensions.byRecruiter,
    },
    {
      kind: "provider",
      label: WORKFORCE_DIMENSION_KIND_LABELS.PROVIDER,
      totalUnits: dimensions.byProvider.buckets.length,
      group: dimensions.byProvider,
    },
  ];

  const activeDimensionTab =
    dimensionTabs.find((tab) => tab.kind === activeDimensionKind) ?? dimensionTabs[0];
  const activeDimensionGroup = activeDimensionTab.group;
  const topVisualBuckets = activeDimensionGroup.buckets.slice(0, 6);
  const maxDimensionBucketEligible = topVisualBuckets.reduce(
    (acc, b) => Math.max(acc, b.eligibleEpisodeCount),
    0,
  );

  const periodLeaveCategoryByKey = new Map(
    leaveReasons.periodLeaveReasons.applicable
      ? leaveReasons.periodLeaveReasons.byCategory.map((row) => [row.key, row])
      : [],
  );

  const maxLeaveReasonCategoryCount = leaveReasons.byCategory.reduce(
    (acc, row) => Math.max(acc, row.episodeCount),
    0,
  );

  return (
    <section aria-label="Báo cáo chuyên sâu lực lượng lao động" className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardHeader title="Phân tích chuyên sâu vòng đời & chất lượng lao động" />
          <div className="shrink-0">
            <StatusBadge tone="neutral" dot>
              Tính đến ngày {snapshot.asOfDate} ({asOfSourceLabel})
            </StatusBadge>
          </div>
        </div>

        {/* Dòng chú thích nghiệp vụ nằm ở hàng riêng và chiếm toàn bộ chiều rộng card */}
        <div className="mt-2 w-full rounded-lg border border-border bg-muted/10 px-3 py-2 text-xs text-muted">
          {WORKFORCE_UNIT_METADATA_NOTE}
        </div>

        {/* Khối tóm tắt tất định: Điểm cần chú ý */}
        <div
          aria-label="Điểm cần chú ý về nhân sự"
          className="mt-4 rounded-xl border border-border bg-muted/5 p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Điểm cần chú ý tại ngày mốc {snapshot.asOfDate}
              </h3>
              <p className="mt-0.5 text-xs text-muted">
                Tổng hợp tự động theo quy tắc tất định từ số liệu đang hiển thị (ngưỡng mẫu tối thiểu ≥ {WORKFORCE_HIGHLIGHT_MIN_SAMPLE_SIZE} đợt làm việc khi xếp hạng dự án/nhóm).
              </p>
            </div>
            <span className="text-xs tabular-nums text-muted">
              Tổng mẫu: {snapshot.eligibleEpisodeTotal} đợt làm việc đủ điều kiện
            </span>
          </div>

          <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            {attentionInsights.map((insight) => {
              const borderClass =
                insight.tone === "emerald"
                  ? "border-l-4 border-l-emerald-500"
                  : insight.tone === "amber"
                    ? "border-l-4 border-l-amber-500"
                    : insight.tone === "sky"
                      ? "border-l-4 border-l-sky-500"
                      : "border-l-4 border-l-slate-400";
              return (
                <div
                  key={insight.id}
                  className={`rounded-lg border border-border bg-surface px-3 py-2.5 ${borderClass}`}
                >
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                    {insight.badgeLabel}
                  </p>
                  <p className="mt-1 text-xs font-semibold text-foreground">
                    {insight.title}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">
                    {insight.detail}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* WF-02 (2.3 & 2.4): Đối soát cân bằng đầu kỳ / cuối kỳ & Thời gian chờ việc / Tỷ lệ bố trí việc */}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="rounded-xl border border-border bg-muted/5 p-3 lg:col-span-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Đối soát cân bằng đầu kỳ / cuối kỳ
                </h3>
                <p className="mt-0.5 text-xs text-muted">
                  Công thức bảo toàn mỗi trạng thái: Đầu kỳ + Mở mới + Chuyển vào − Chuyển ra = Cuối kỳ.
                </p>
              </div>
              {balance.applicable ? (
                <StatusBadge tone="success" dot>
                  Đã đối soát cân bằng
                </StatusBadge>
              ) : null}
            </div>

            {!balance.applicable ? (
              <p className="mt-2 rounded-lg border border-dashed border-border bg-surface px-3 py-4 text-xs text-muted">
                {balance.windowLabel}
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted">
                  <span>
                    Mốc đầu kỳ:{" "}
                    <strong className="tabular-nums text-foreground">{balance.openingAsOfDate}</strong> (trước kỳ 1 ngày)
                  </span>
                  <span>
                    Mốc cuối kỳ:{" "}
                    <strong className="tabular-nums text-foreground">{balance.closingAsOfDate}</strong>
                  </span>
                </div>

                {/* Tóm tắt trực quan biến động ròng Đầu kỳ -> Cuối kỳ */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {balanceRows.map((item) => (
                    <div
                      key={`net-${item.key}`}
                      className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className={`h-2 w-2 rounded-full ${item.dotClass}`} />
                        <span className="truncate font-medium text-muted">{item.label}</span>
                      </div>
                      <div className="mt-1 flex items-baseline justify-between gap-1 tabular-nums">
                        <span className="text-muted">
                          {item.row.openingCount} → <strong className="text-foreground">{item.row.closingCount}</strong>
                        </span>
                        <span className="font-semibold text-foreground">
                          {formatSignedBalanceDelta(item.row.netChange)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="overflow-x-auto rounded-lg border border-border bg-surface">
                  <table className="r22-report-table w-full text-left text-xs">
                    <caption className="sr-only">
                      Bảng đối soát cân bằng biến động trạng thái đầu kỳ {balance.openingAsOfDate} và cuối kỳ {balance.closingAsOfDate}
                    </caption>
                    <thead className="bg-surface-muted uppercase tracking-wide text-muted">
                      <tr className="border-b border-border">
                        <th scope="col" className="px-2.5 py-1.5 font-medium">
                          Trạng thái
                        </th>
                        <th scope="col" className="px-2 py-1.5 text-right font-medium">
                          {WORKFORCE_BALANCE_COLUMN_LABELS.OPENING}
                        </th>
                        <th scope="col" className="px-2 py-1.5 text-right font-medium">
                          {WORKFORCE_BALANCE_COLUMN_LABELS.NEW_INFLOW}
                        </th>
                        <th scope="col" className="px-2 py-1.5 text-right font-medium">
                          {WORKFORCE_BALANCE_COLUMN_LABELS.TRANSITION_INFLOW}
                        </th>
                        <th scope="col" className="px-2 py-1.5 text-right font-medium">
                          {WORKFORCE_BALANCE_COLUMN_LABELS.OUTFLOW}
                        </th>
                        <th scope="col" className="px-2 py-1.5 text-right font-medium">
                          {WORKFORCE_BALANCE_COLUMN_LABELS.NET_CHANGE}
                        </th>
                        <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                          {WORKFORCE_BALANCE_COLUMN_LABELS.CLOSING}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {balanceRows.map((item) => (
                        <tr key={item.key} className="text-foreground hover:bg-surface-hover">
                          <td className="px-2.5 py-1.5 font-medium">{item.label}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                            {item.row.openingCount}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                            +{item.row.newEpisodeInflowCount}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                            +{item.row.transitionInflowCount}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                            −{item.row.outflowCount}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                            {formatSignedBalanceDelta(item.row.netChange)}
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-semibold tabular-nums whitespace-nowrap">
                            {item.row.closingCount}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t border-border bg-muted/10 font-medium text-foreground">
                      <tr>
                        <td className="px-2.5 py-1.5">Tổng hồ sơ đủ điều kiện</td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                          {balance.totals.openingEligibleTotal}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                          +{balance.totals.newEpisodeTotal}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                          +{balance.totals.transitionInflowTotal}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                          −{balance.totals.transitionOutflowTotal}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                          {formatSignedBalanceDelta(balance.totals.netEligibleChange)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right font-semibold tabular-nums whitespace-nowrap">
                          {balance.totals.closingEligibleTotal}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border bg-muted/5 p-3 lg:col-span-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Thời gian chờ việc &amp; tỷ lệ bố trí việc
                </h3>
                <p className="mt-0.5 text-xs text-muted">
                  Đo trên các khoảng {WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED} liên tiếp đã khử hiệu chỉnh tính đến {waiting.asOfDate}.
                </p>
              </div>
              <span className="text-xs tabular-nums text-muted">
                Vào thẳng {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}: {waiting.directOnEpisodeCount} hồ sơ
              </span>
            </div>

            {/* Thanh phân bổ kết quả của tập từng chờ việc */}
            <div className="mt-2 rounded-lg border border-border bg-surface p-2.5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">
                  Phân rã kết quả trên tổng mẫu từng chờ việc ({waiting.waitingEpisodeTotal} đợt)
                </span>
                <span className="tabular-nums text-muted">
                  Đã kết thúc chờ: <strong className="text-foreground">{waiting.completedWaiting.episodeCount}</strong> · Đang còn chờ:{" "}
                  <strong className="text-foreground">{waiting.currentlyWaiting.episodeCount}</strong>
                </span>
              </div>
              <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-muted/20">
                {waiting.waitingEpisodeTotal > 0 && waiting.placedToOn.episodeCount > 0 ? (
                  <div
                    className="bg-emerald-500"
                    style={{
                      width: `${(waiting.placedToOn.episodeCount / waiting.waitingEpisodeTotal) * 100}%`,
                    }}
                  />
                ) : null}
                {waiting.waitingEpisodeTotal > 0 && waiting.exitedWithoutOn.episodeCount > 0 ? (
                  <div
                    className="bg-rose-500"
                    style={{
                      width: `${(waiting.exitedWithoutOn.episodeCount / waiting.waitingEpisodeTotal) * 100}%`,
                    }}
                  />
                ) : null}
                {waiting.waitingEpisodeTotal > 0 && waiting.currentlyWaiting.episodeCount > 0 ? (
                  <div
                    className="bg-amber-500"
                    style={{
                      width: `${(waiting.currentlyWaiting.episodeCount / waiting.waitingEpisodeTotal) * 100}%`,
                    }}
                  />
                ) : null}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  Đã bố trí vào {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}: {waiting.placedToOn.episodeCount}
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-rose-500" />
                  Nghỉ khi đang chờ: {waiting.exitedWithoutOn.episodeCount}
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  Đang còn chờ tại ngày mốc: {waiting.currentlyWaiting.episodeCount}
                </span>
              </div>
            </div>

            <dl className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">Tỷ lệ bố trí việc (trên tổng có chờ việc)</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {formatPlacementRatePercent(waiting.placementRateOfWaiting)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted">
                  Mẫu: {waiting.placedToOn.episodeCount} / {waiting.waitingEpisodeTotal} hồ sơ qua {WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">Tỷ lệ bố trí việc (trên hồ sơ đã kết thúc chờ)</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {formatPlacementRatePercent(waiting.placementRateOfCompletedWaiting)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted">
                  Mẫu: {waiting.placedToOn.episodeCount} / {waiting.completedWaiting.episodeCount} hồ sơ đã kết thúc chờ
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">Chờ việc TB (hồ sơ đã bố trí sang {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON})</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {formatWaitingDaysAverage(waiting.placedToOn.avgWaitingDaysPerEpisode)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted">
                  Mẫu: {waiting.placedToOn.episodeCount} hồ sơ ({waiting.placedToOn.totalWaitingDays} ngày chờ)
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">Chờ việc TB (hồ sơ đang còn chờ việc)</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {formatWaitingDaysAverage(waiting.currentlyWaiting.avgWaitingDaysPerEpisode)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted">
                  Mẫu: {waiting.currentlyWaiting.episodeCount} hồ sơ ({waiting.currentlyWaiting.totalWaitingDays} ngày chờ)
                </p>
              </div>
            </dl>

            <div className="mt-2 overflow-x-auto rounded-lg border border-border bg-surface">
              <table className="r22-report-table w-full text-left text-xs">
                <caption className="sr-only">
                  Bảng phân rã thời gian chờ việc theo từng nhóm mẫu tại ngày {waiting.asOfDate}
                </caption>
                <thead className="bg-surface-muted uppercase tracking-wide text-muted">
                  <tr className="border-b border-border">
                    <th scope="col" className="px-2.5 py-1.5 font-medium">
                      Nhóm mẫu (mẫu số tính trung bình)
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">
                      Số hồ sơ
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">
                      Tổng ngày chờ
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">
                      TB / hồ sơ
                    </th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                      Tối đa
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {waitingSampleRows.map((item) => (
                    <tr key={item.key} className="text-foreground hover:bg-surface-hover">
                      <td className="px-2.5 py-1.5">{item.label}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {item.sample.episodeCount}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {item.sample.totalWaitingDays}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {formatWaitingDaysAverage(item.sample.avgWaitingDaysPerEpisode)}
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {item.sample.maxWaitingDays === null ? "—" : `${item.sample.maxWaitingDays} ngày`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {waiting.periodWaiting.applicable ? (
              <p className="mt-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted">
                Trong kỳ lọc ({waiting.periodWaiting.fromDate} → {waiting.periodWaiting.toDate}):{" "}
                <strong className="tabular-nums text-foreground">{waiting.periodWaiting.activeWaitingEpisodeCount}</strong> hồ sơ có ngày chờ (
                <strong className="tabular-nums text-foreground">{waiting.periodWaiting.inPeriodWaitingDays}</strong> ngày chờ trong kỳ, TB{" "}
                <strong className="tabular-nums text-foreground">
                  {formatWaitingDaysAverage(waiting.periodWaiting.avgInPeriodWaitingDaysPerActiveEpisode)}
                </strong>
                /hồ sơ) · Bố trí sang {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON} trong kỳ:{" "}
                <strong className="tabular-nums text-foreground">{waiting.periodWaiting.placedInPeriod.eventCount}</strong> lần (
                <span className="tabular-nums">{waiting.periodWaiting.placedInPeriod.episodeCount}</span> hồ sơ, TB{" "}
                <span className="tabular-nums">
                  {formatWaitingDaysAverage(waiting.periodWaiting.placedInPeriod.avgWaitingDaysPerEvent)}
                </span>
                /lần).
              </p>
            ) : null}

            <p className="mt-2 text-[11px] text-muted">
              {WORKFORCE_NON_ATTENDANCE_NOTE}
            </p>
          </div>
        </div>

        {/* WF-03 (2.5 & 2.6): Thâm niên & ngày hiện diện theo trạng thái + Nghỉ sớm & giữ chân theo mốc D7 / D30 / D90 */}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="rounded-xl border border-border bg-muted/5 p-3 lg:col-span-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Thâm niên làm việc &amp; ngày hiện diện theo trạng thái
                </h3>
                <p className="mt-0.5 text-xs text-muted">
                  Tính trên các khoảng {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON} liên tiếp (đã loại các bản ghi bị thay thế hoặc điều chỉnh) đến ngày {duration.asOfDate}.
                </p>
              </div>
              <span className="text-xs tabular-nums text-muted">
                Từng vào {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}: {duration.everOnEpisodeCount} / {duration.eligibleEpisodeTotal} đợt làm việc
              </span>
            </div>

            <dl className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">Thâm niên TB (tất cả đợt từng vào {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON})</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {formatDurationDaysAverage(duration.allEverOn.avgOnDaysPerEpisode)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted">
                  Mẫu: {duration.allEverOn.episodeCount} đợt làm việc ({duration.allEverOn.totalOnDays} ngày hiện diện theo trạng thái)
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">Thâm niên TB (đang làm việc tại ngày mốc)</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {formatDurationDaysAverage(duration.currentlyOn.avgOnDaysPerEpisode)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted">
                  Mẫu: {duration.currentlyOn.episodeCount} đợt làm việc ({duration.currentlyOn.totalOnDays} ngày hiện diện theo trạng thái)
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">Thâm niên TB (đã rời {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON} sau khi vào làm)</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {formatDurationDaysAverage(duration.exitedAfterOn.avgOnDaysPerEpisode)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted">
                  Mẫu: {duration.exitedAfterOn.episodeCount} đợt làm việc ({duration.exitedAfterOn.totalOnDays} ngày hiện diện theo trạng thái)
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">Chưa từng vào {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON} / Chưa xác định</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {duration.neverOnEpisodeCount} / {duration.unknownStatusEpisodeCount}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted">
                  Tách riêng khỏi mẫu số thâm niên ({duration.neverOnEpisodeCount} chưa vào làm, {duration.unknownStatusEpisodeCount} chưa xác định)
                </p>
              </div>
            </dl>

            <div className="mt-2 overflow-x-auto rounded-lg border border-border bg-surface">
              <table className="r22-report-table w-full text-left text-xs">
                <caption className="sr-only">
                  Bảng phân rã thâm niên làm việc theo nhóm mẫu tại ngày {duration.asOfDate}
                </caption>
                <thead className="bg-surface-muted uppercase tracking-wide text-muted">
                  <tr className="border-b border-border">
                    <th scope="col" className="px-2.5 py-1.5 font-medium">
                      Nhóm mẫu thâm niên
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">
                      Số đợt làm việc
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">
                      Tổng ngày {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">
                      TB / đợt làm việc
                    </th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                      Tối đa
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {durationSampleRows.map((item) => (
                    <tr key={item.key} className="text-foreground hover:bg-surface-hover">
                      <td className="px-2.5 py-1.5">{item.label}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {item.sample.episodeCount}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {item.sample.totalOnDays}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {formatDurationDaysAverage(item.sample.avgOnDaysPerEpisode)}
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {item.sample.maxOnDays === null ? "—" : `${item.sample.maxOnDays} ngày`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {durationBucketRows.map((bucket) => {
                const bucketRate =
                  duration.everOnEpisodeCount > 0
                    ? bucket.count / duration.everOnEpisodeCount
                    : null;
                const bucketWidth =
                  duration.everOnEpisodeCount > 0
                    ? Math.round((bucket.count / duration.everOnEpisodeCount) * 100)
                    : 0;
                return (
                  <div key={bucket.key} className="rounded-lg border border-border bg-surface px-2.5 py-1.5">
                    <div className="flex items-center justify-between gap-1">
                      <p className="text-[11px] text-muted">{bucket.label}</p>
                      <span className="text-[10px] tabular-nums text-muted">
                        {formatShareRatePercent(bucketRate)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
                      {bucket.count} <span className="text-[11px] font-normal text-muted">đợt</span>
                    </p>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted/20">
                      {bucket.count > 0 ? (
                        <div
                          className={`h-full rounded-full ${bucket.barColor}`}
                          style={{ width: `${bucketWidth}%` }}
                        />
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            {duration.periodPresence.applicable ? (
              <p className="mt-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted">
                Ngày hiện diện theo trạng thái trong kỳ ({duration.periodPresence.fromDate} → {duration.periodPresence.toDate}):{" "}
                <strong className="tabular-nums text-foreground">{duration.periodPresence.activeOnEpisodeCount}</strong> đợt làm việc có mặt ở {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON} (
                <strong className="tabular-nums text-foreground">{duration.periodPresence.inPeriodOnDays}</strong> ngày hiện diện theo trạng thái trong kỳ, TB{" "}
                <strong className="tabular-nums text-foreground">
                  {formatDurationDaysAverage(duration.periodPresence.avgInPeriodOnDaysPerActiveEpisode)}
                </strong>
                /đợt làm việc).
              </p>
            ) : (
              <p className="mt-2 rounded-lg border border-dashed border-border bg-surface px-3 py-1.5 text-xs text-muted">
                {duration.periodPresence.windowLabel}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-border bg-muted/5 p-3 lg:col-span-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Nghỉ sớm &amp; giữ chân theo mốc D7 / D30 / D90
                </h3>
                <p className="mt-0.5 text-xs text-muted">
                  Đoàn hệ tính theo duy trì liên tục ở trạng thái {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON} từ lần đầu vào làm của từng đợt làm việc (tính đến {retention.asOfDate}).
                </p>
              </div>
              <span className="text-xs tabular-nums text-muted">
                Đoàn hệ {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}: {retention.cohortEpisodeTotal} đợt làm việc
              </span>
            </div>

            <dl className="mt-2 grid grid-cols-3 gap-2">
              {retentionCheckpointRows.map((item) => {
                const cp = item.checkpoint;
                const cohortTotal = retention.cohortEpisodeTotal;
                const retainedPct = cohortTotal > 0 ? (cp.retainedCount / cohortTotal) * 100 : 0;
                const exitedPct = cohortTotal > 0 ? (cp.exitedCount / cohortTotal) * 100 : 0;
                const immaturePct = cohortTotal > 0 ? (cp.immatureCount / cohortTotal) * 100 : 0;
                return (
                  <div key={`card-${item.key}`} className="rounded-lg border border-border bg-surface px-3 py-2">
                    <dt className="text-xs text-muted">{item.label}</dt>
                    <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                      {formatRetentionRatePercent(cp.retentionRate)}
                    </dd>
                    <div className="mt-1.5 flex h-2 w-full overflow-hidden rounded-full bg-muted/20">
                      {cp.retainedCount > 0 ? (
                        <div
                          className="bg-emerald-500"
                          style={{ width: `${retainedPct}%` }}
                          title={`Duy trì liên tục: ${cp.retainedCount}`}
                        />
                      ) : null}
                      {cp.exitedCount > 0 ? (
                        <div
                          className="bg-rose-500"
                          style={{ width: `${exitedPct}%` }}
                          title={`Nghỉ trước mốc: ${cp.exitedCount}`}
                        />
                      ) : null}
                      {cp.immatureCount > 0 ? (
                        <div
                          className="bg-slate-300"
                          style={{ width: `${immaturePct}%` }}
                          title={`Chưa đủ tuổi: ${cp.immatureCount}`}
                        />
                      ) : null}
                    </div>
                    <p className="mt-1 text-[11px] text-muted">
                      Duy trì liên tục: {cp.retainedCount} / {cp.maturedCount} đã đủ tuổi ({cp.immatureCount} chưa đủ tuổi)
                    </p>
                  </div>
                );
              })}
            </dl>

            <div className="mt-2 overflow-x-auto rounded-lg border border-border bg-surface">
              <table className="r22-report-table w-full text-left text-xs">
                <caption className="sr-only">
                  Bảng giữ chân liên tục và nghỉ sớm theo mốc D7, D30, D90 tính đến ngày {retention.asOfDate}
                </caption>
                <thead className="bg-surface-muted uppercase tracking-wide text-muted">
                  <tr className="border-b border-border">
                    <th scope="col" className="px-2.5 py-1.5 font-medium">
                      Mốc đánh giá
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">
                      Đã đủ tuổi
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">
                      Duy trì liên tục
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">
                      Nghỉ trước mốc
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">
                      Chưa đủ tuổi
                    </th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                      Tỷ lệ giữ chân
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {retentionCheckpointRows.map((item) => (
                    <tr key={item.key} className="text-foreground hover:bg-surface-hover">
                      <td className="px-2.5 py-1.5 font-medium">{item.label}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {item.checkpoint.maturedCount}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {item.checkpoint.retainedCount}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {item.checkpoint.exitedCount}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {item.checkpoint.immatureCount}
                      </td>
                      <td className="px-2.5 py-1.5 text-right font-semibold tabular-nums whitespace-nowrap">
                        {formatRetentionRatePercent(item.checkpoint.retentionRate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted">
              <span>
                Loại khỏi đoàn hệ {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}:{" "}
                <strong className="tabular-nums text-foreground">{retention.neverEnteredOnCount}</strong> đợt chưa từng vào {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON} ·{" "}
                <strong className="tabular-nums text-foreground">{retention.unknownStatusEpisodeCount}</strong> đợt chưa xác định trạng thái.
              </span>
              {retention.periodCohort.applicable ? (
                <span className="mt-1 block">
                  Đoàn hệ bắt đầu vào {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON} trong kỳ ({retention.periodCohort.fromDate} → {retention.periodCohort.toDate}):{" "}
                  <strong className="tabular-nums text-foreground">{retention.periodCohort.enteredOnCount}</strong> đợt làm việc (duy trì liên tục đến cuối kỳ:{" "}
                  <strong className="tabular-nums text-foreground">{retention.periodCohort.retainedAtToCount}</strong>, đã rời trước cuối kỳ:{" "}
                  <strong className="tabular-nums text-foreground">{retention.periodCohort.exitedByToCount}</strong>, tỷ lệ duy trì liên tục cuối kỳ:{" "}
                  <strong className="tabular-nums text-foreground">
                    {formatRetentionRatePercent(retention.periodCohort.inPeriodRetentionRate)}
                  </strong>
                  ).
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* WF-04 (2.7): Chất lượng lực lượng theo chiều Dự án / Nhóm / Người tuyển / HRP-Vendor */}
        <div className="mt-4 rounded-xl border border-border bg-muted/5 p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Chất lượng lực lượng theo chiều phân tích (Dự án / Nhóm / Người tuyển / HRP-Vendor)
              </h3>
              <p className="mt-0.5 text-xs text-muted">
                Đối soát đồng nhất hiện trạng tại ngày {dimensions.asOfDate}, tỷ lệ bố trí việc từ chờ việc, thâm niên {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON} và giữ chân liên tục D7 / D30 / D90 theo từng chiều.
              </p>
            </div>

            <div
              role="tablist"
              aria-label="Chọn chiều phân tích chất lượng nhân sự"
              className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1"
            >
              {dimensionTabs.map((tab) => {
                const isSelected = tab.kind === activeDimensionTab.kind;
                return (
                  <button
                    key={tab.kind}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => setActiveDimensionKind(tab.kind)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      isSelected
                        ? "bg-primary text-on-primary shadow-xs"
                        : "text-muted hover:bg-surface-hover hover:text-foreground"
                    }`}
                  >
                    {tab.label} ({tab.totalUnits})
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted">
            <span>
              Chiều đang xem:{" "}
              <strong className="text-foreground">{activeDimensionTab.label}</strong> (
              {activeDimensionTab.kind === "project"
                ? `hiển thị ${activeDimensionGroup.buckets.length} / ${effectiveProjectPagination.totalCount} dự án`
                : `${activeDimensionGroup.buckets.length} đơn vị/nhóm`}
              )
            </span>
            <span>
              Tổng đợt đối soát:{" "}
              <strong className="tabular-nums text-foreground">{activeDimensionGroup.eligibleEpisodeTotal}</strong> đợt (Đã gán chiều:{" "}
              <strong className="tabular-nums text-foreground">{activeDimensionGroup.knownEpisodeCount}</strong> · Không xác định:{" "}
              <strong className="tabular-nums text-foreground">{activeDimensionGroup.unknownEpisodeCount}</strong>)
            </span>
          </div>

          {activeDimensionGroup.buckets.length === 0 ? (
            <p className="mt-2 rounded-lg border border-dashed border-border bg-surface px-3 py-4 text-xs text-muted">
              Chưa có đợt làm việc đủ điều kiện tại ngày mốc {dimensions.asOfDate} cho chiều phân tích này.
            </p>
          ) : (
            <div className="mt-2.5 space-y-3">
              {/* Biểu đồ thanh ngang so sánh trực quan các đơn vị/nhóm hàng đầu */}
              <div className="rounded-lg border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-foreground">
                    So sánh cơ cấu trạng thái &amp; tỷ lệ giữ chân D30 ({activeDimensionTab.label})
                  </span>
                  <span className="text-[11px] text-muted">
                    Màu thanh: Xanh ({WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}) · Vàng ({WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED}) · Đỏ ({WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF}) · Xám ({WORKFORCE_SNAPSHOT_STATUS_LABELS.UNKNOWN})
                  </span>
                </div>

                <div className="mt-2.5 space-y-2">
                  {topVisualBuckets.map((bucket) => {
                    const widthScale =
                      maxDimensionBucketEligible > 0
                        ? (bucket.eligibleEpisodeCount / maxDimensionBucketEligible) * 100
                        : 0;
                    const onSeg =
                      bucket.eligibleEpisodeCount > 0
                        ? (bucket.onCount / bucket.eligibleEpisodeCount) * widthScale
                        : 0;
                    const waitSeg =
                      bucket.eligibleEpisodeCount > 0
                        ? (bucket.unconfirmedCount / bucket.eligibleEpisodeCount) * widthScale
                        : 0;
                    const offSeg =
                      bucket.eligibleEpisodeCount > 0
                        ? (bucket.offCount / bucket.eligibleEpisodeCount) * widthScale
                        : 0;
                    const unkSeg =
                      bucket.eligibleEpisodeCount > 0
                        ? (bucket.unknownCount / bucket.eligibleEpisodeCount) * widthScale
                        : 0;

                    return (
                      <div key={`viz-${bucket.key}`} className="text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-foreground">{bucket.display}</span>
                            {bucket.active === false ? (
                              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200">
                                Ngừng hoạt động
                              </span>
                            ) : null}
                            {bucket.isUnknown ? (
                              <span className="rounded bg-slate-500/15 px-1.5 py-0.5 text-[10px] font-medium text-muted">
                                Thiếu quy thuộc
                              </span>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-3 text-[11px] tabular-nums text-muted">
                            <span>
                              Tổng: <strong className="text-foreground">{bucket.eligibleEpisodeCount}</strong> đợt
                            </span>
                            <span>
                              Bố trí việc: <strong className="text-foreground">{formatPlacementRatePercent(bucket.placementRateOfWaiting)}</strong>
                            </span>
                            <span>
                              Giữ chân D30: <strong className="text-foreground">{formatRetentionRatePercent(bucket.checkpoints.d30.retentionRate)}</strong> ({bucket.checkpoints.d30.retainedCount}/{bucket.checkpoints.d30.maturedCount})
                            </span>
                          </div>
                        </div>
                        <div className="mt-1 flex h-2.5 w-full overflow-hidden rounded-full bg-muted/20">
                          {onSeg > 0 ? (
                            <div
                              className="bg-emerald-500"
                              style={{ width: `${onSeg}%` }}
                              title={`${WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}: ${bucket.onCount}`}
                            />
                          ) : null}
                          {waitSeg > 0 ? (
                            <div
                              className="bg-amber-500"
                              style={{ width: `${waitSeg}%` }}
                              title={`${WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED}: ${bucket.unconfirmedCount}`}
                            />
                          ) : null}
                          {offSeg > 0 ? (
                            <div
                              className="bg-rose-500"
                              style={{ width: `${offSeg}%` }}
                              title={`${WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF}: ${bucket.offCount}`}
                            />
                          ) : null}
                          {unkSeg > 0 ? (
                            <div
                              className="bg-slate-400"
                              style={{ width: `${unkSeg}%` }}
                              title={`${WORKFORCE_SNAPSHOT_STATUS_LABELS.UNKNOWN}: ${bucket.unknownCount}`}
                            />
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Bảng đối soát chi tiết theo chiều */}
              <div className="overflow-x-auto rounded-lg border border-border bg-surface">
                <table className="r22-report-table w-full text-left text-xs">
                  <caption className="sr-only">
                    Bảng chất lượng lực lượng lao động {activeDimensionTab.label} tính đến ngày {dimensions.asOfDate}
                  </caption>
                  <thead className="bg-surface-muted uppercase tracking-wide text-muted">
                    <tr className="border-b border-border">
                      <th scope="col" className="px-2.5 py-2 font-medium">
                        {activeDimensionTab.label}
                      </th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">
                        Tổng đợt
                      </th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">
                        {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}
                      </th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">
                        {WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED}
                      </th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">
                        {WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF}
                      </th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">
                        Bố trí từ chờ việc
                      </th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">
                        TB ngày chờ
                      </th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">
                        TB ngày {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}
                      </th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">
                        Giữ chân D7
                      </th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">
                        Giữ chân D30
                      </th>
                      <th scope="col" className="px-2.5 py-2 text-right font-medium">
                        Giữ chân D90
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {activeDimensionGroup.buckets.map((bucket) => (
                      <tr key={bucket.key} className="text-foreground hover:bg-surface-hover">
                        <td className="px-2.5 py-1.5 font-medium">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span>{bucket.display}</span>
                            {bucket.unknownCount > 0 ? (
                              <span className="text-[10px] font-normal tabular-nums text-muted">
                                ({bucket.unknownCount} chưa rõ trạng thái)
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-right font-semibold tabular-nums whitespace-nowrap">
                          {bucket.eligibleEpisodeCount}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap text-emerald-700 dark:text-emerald-300">
                          {bucket.onCount}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap text-amber-700 dark:text-amber-300">
                          {bucket.unconfirmedCount}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap text-rose-700 dark:text-rose-300">
                          {bucket.offCount}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                          <span className="font-semibold">
                            {formatPlacementRatePercent(bucket.placementRateOfWaiting)}
                          </span>{" "}
                          <span className="text-[11px] text-muted">
                            ({bucket.placedToOnEpisodeCount}/{bucket.waitingEpisodeCount})
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                          {formatWaitingDaysAverage(bucket.avgWaitingDaysPerEpisode)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                          {formatDurationDaysAverage(bucket.avgOnDaysPerEpisode)}{" "}
                          <span className="text-[11px] text-muted">({bucket.everOnEpisodeCount} đợt)</span>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                          <span className="font-semibold">
                            {formatRetentionRatePercent(bucket.checkpoints.d7.retentionRate)}
                          </span>{" "}
                          <span className="text-[11px] text-muted">
                            ({bucket.checkpoints.d7.retainedCount}/{bucket.checkpoints.d7.maturedCount})
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                          <span className="font-semibold">
                            {formatRetentionRatePercent(bucket.checkpoints.d30.retentionRate)}
                          </span>{" "}
                          <span className="text-[11px] text-muted">
                            ({bucket.checkpoints.d30.retainedCount}/{bucket.checkpoints.d30.maturedCount})
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">
                          <span className="font-semibold">
                            {formatRetentionRatePercent(bucket.checkpoints.d90.retentionRate)}
                          </span>{" "}
                          <span className="text-[11px] text-muted">
                            ({bucket.checkpoints.d90.retainedCount}/{bucket.checkpoints.d90.maturedCount})
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-border bg-muted/10 font-medium text-foreground">
                    <tr>
                      <td className="px-2.5 py-1.5">Tổng đối soát toàn chiều (khớp 100% Snapshot)</td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {snapshot.eligibleEpisodeTotal}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {snapshot.onCount}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {snapshot.unconfirmedCount}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {snapshot.offCount}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {formatPlacementRatePercent(waiting.placementRateOfWaiting)}{" "}
                        <span className="text-[11px] font-normal text-muted">
                          ({waiting.placedToOn.episodeCount}/{waiting.waitingEpisodeTotal})
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {formatWaitingDaysAverage(waiting.allWaiting.avgWaitingDaysPerEpisode)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {formatDurationDaysAverage(duration.allEverOn.avgOnDaysPerEpisode)}{" "}
                        <span className="text-[11px] font-normal text-muted">
                          ({duration.everOnEpisodeCount} đợt)
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {formatRetentionRatePercent(retention.checkpoints.d7.retentionRate)}{" "}
                        <span className="text-[11px] font-normal text-muted">
                          ({retention.checkpoints.d7.retainedCount}/{retention.checkpoints.d7.maturedCount})
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {formatRetentionRatePercent(retention.checkpoints.d30.retentionRate)}{" "}
                        <span className="text-[11px] font-normal text-muted">
                          ({retention.checkpoints.d30.retainedCount}/{retention.checkpoints.d30.maturedCount})
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {formatRetentionRatePercent(retention.checkpoints.d90.retentionRate)}{" "}
                        <span className="text-[11px] font-normal text-muted">
                          ({retention.checkpoints.d90.retainedCount}/{retention.checkpoints.d90.maturedCount})
                        </span>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Phân trang server-side cho bảng Theo dự án (5 dòng/trang) */}
              {activeDimensionTab.kind === "project" &&
              (effectiveProjectPagination.hasMore ||
                effectiveProjectPagination.totalCount > WORKFORCE_PROJECT_DEFAULT_PAGE_SIZE) ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs">
                  <span className="tabular-nums text-muted">
                    Đang hiển thị <strong className="text-foreground">{mergedProjectBuckets.length}</strong> /{" "}
                    <strong className="text-foreground">{effectiveProjectPagination.totalCount}</strong> dự án
                    {loadMoreProjectsError ? (
                      <span className="ml-2 text-status-danger-text">
                        · Không tải được trang dự án tiếp theo, vui lòng thử lại.
                      </span>
                    ) : null}
                  </span>
                  {effectiveProjectPagination.hasMore && onLoadMoreProjects ? (
                    <button
                      type="button"
                      onClick={onLoadMoreProjects}
                      disabled={isLoadingMoreProjects}
                      className="inline-flex min-h-9 items-center rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
                    >
                      {isLoadingMoreProjects ? "Đang tải thêm…" : "Tải thêm"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}

          <p className="mt-2 text-[11px] text-muted">
            {WORKFORCE_DIMENSION_ATTRIBUTION_NOTE}
          </p>
        </div>

        {/* WF-04 (2.8): Phân tích lý do nghỉ việc & độ phủ chuẩn hóa */}
        <div className="mt-4 rounded-xl border border-border bg-muted/5 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Phân tích lý do nghỉ việc &amp; độ phủ dữ liệu
              </h3>
              <p className="mt-0.5 text-xs text-muted">
                Tổng hợp từ các đợt làm việc đang ở trạng thái {WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF} tại ngày mốc {leaveReasons.asOfDate} và các lần chuyển sang {WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF} trong kỳ lọc.
              </p>
            </div>
            <span className="text-xs tabular-nums text-muted">
              Tổng {WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF} tại ngày mốc: {leaveReasons.offEpisodeTotal} đợt làm việc
            </span>
          </div>

          <dl className="mt-2.5 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <div className="rounded-lg border border-border bg-surface px-3 py-2">
              <dt className="text-xs text-muted">Tổng đợt {WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF} tại ngày mốc</dt>
              <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                {leaveReasons.offEpisodeTotal} <span className="text-xs font-normal text-muted">đợt làm việc</span>
              </dd>
              <p className="mt-0.5 text-[11px] text-muted">
                Khớp 100% với số lượng {WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF} trên Snapshot
              </p>
            </div>

            <div className="rounded-lg border border-border bg-surface px-3 py-2">
              <dt className="text-xs text-muted">Độ phủ có ghi nhận lý do nghỉ</dt>
              <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                {formatCoverageRatePercent(leaveReasons.reasonCoverageRate)}
              </dd>
              <p className="mt-0.5 text-[11px] text-muted">
                Có lý do: {leaveReasons.withReasonEpisodeCount} / {leaveReasons.offEpisodeTotal} đợt {WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF}
              </p>
            </div>

            <div className="rounded-lg border border-border bg-surface px-3 py-2">
              <dt className="text-xs text-muted">Tỷ lệ khớp danh mục chuẩn hóa</dt>
              <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                {formatCoverageRatePercent(leaveReasons.standardizationRate)}
              </dd>
              <p className="mt-0.5 text-[11px] text-muted">
                Chuẩn hóa: {leaveReasons.standardizedEpisodeCount} · Tự do khác: {leaveReasons.unclassifiedFreeTextEpisodeCount}
              </p>
            </div>

            <div className="rounded-lg border border-border bg-surface px-3 py-2">
              <dt className="text-xs text-muted">Thiếu hoặc chưa xác định lý do</dt>
              <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                {leaveReasons.missingReasonEpisodeCount} <span className="text-xs font-normal text-muted">đợt làm việc</span>
              </dd>
              <p className="mt-0.5 text-[11px] text-muted">
                Tỷ trọng thiếu lý do:{" "}
                {formatShareRatePercent(
                  leaveReasons.offEpisodeTotal > 0
                    ? leaveReasons.missingReasonEpisodeCount / leaveReasons.offEpisodeTotal
                    : null,
                )}
              </p>
            </div>
          </dl>

          {/* Biểu đồ thanh ngang phân bổ theo nhóm lý do nghỉ việc */}
          {leaveReasons.offEpisodeTotal > 0 ? (
            <div className="mt-2.5 rounded-lg border border-border bg-surface p-3">
              <p className="text-xs font-medium text-foreground">
                Phân bổ tỷ trọng các nhóm lý do nghỉ việc tại ngày mốc ({leaveReasons.asOfDate})
              </p>
              <div className="mt-2 space-y-1.5">
                {leaveReasons.byCategory
                  .filter((row) => row.episodeCount > 0)
                  .map((row) => {
                    const barWidth =
                      maxLeaveReasonCategoryCount > 0
                        ? Math.max(3, Math.round((row.episodeCount / maxLeaveReasonCategoryCount) * 100))
                        : 0;
                    const barColor =
                      row.kind === "standardized"
                        ? "bg-sky-500"
                        : row.kind === "unclassified_free_text"
                          ? "bg-amber-500"
                          : "bg-slate-400";
                    return (
                      <div key={`lr-bar-${row.key}`} className="text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-foreground">{row.label}</span>
                          <span className="tabular-nums text-muted">
                            <strong className="text-foreground">{row.episodeCount}</strong> đợt ({formatShareRatePercent(row.shareOfOffRate)})
                          </span>
                        </div>
                        <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted/20">
                          <div
                            className={`h-full rounded-full ${barColor}`}
                            style={{ width: `${barWidth}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : null}

          <div className="mt-2.5 overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="r22-report-table w-full text-left text-xs">
              <caption className="sr-only">
                Bảng phân tích lý do nghỉ việc theo 10 nhóm chuẩn hóa tại ngày {leaveReasons.asOfDate}
              </caption>
              <thead className="bg-surface-muted uppercase tracking-wide text-muted">
                <tr className="border-b border-border">
                  <th scope="col" className="px-2.5 py-2 font-medium">
                    Nhóm lý do nghỉ việc
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Mức độ chuẩn hóa
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Đợt {WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF} tại ngày mốc
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Nghỉ sau khi vào {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Nghỉ từ {WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED}
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Tỷ trọng / {WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF}
                  </th>
                  {leaveReasons.periodLeaveReasons.applicable ? (
                    <th scope="col" className="px-2.5 py-2 text-right font-medium">
                      Lần chuyển sang {WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF} trong kỳ
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {leaveReasons.byCategory.map((row) => {
                  const periodRow = periodLeaveCategoryByKey.get(row.key);
                  const kindLabel =
                    row.kind === "standardized"
                      ? "Nhóm chuẩn hóa"
                      : row.kind === "unclassified_free_text"
                        ? "Tự do chưa chuẩn hóa"
                        : "Thiếu dữ liệu";
                  return (
                    <tr key={row.key} className="text-foreground hover:bg-surface-hover">
                      <td className="px-2.5 py-1.5 font-medium">{row.label}</td>
                      <td className="px-2 py-1.5 text-muted">{kindLabel}</td>
                      <td className="px-2 py-1.5 text-right font-semibold tabular-nums whitespace-nowrap">
                        {row.episodeCount}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {row.fromOnCount}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {row.fromUnconfirmedWithoutOnCount}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {formatShareRatePercent(row.shareOfOffRate)}
                      </td>
                      {leaveReasons.periodLeaveReasons.applicable ? (
                        <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">
                          {periodRow ? `${periodRow.eventCount} lần (${periodRow.episodeCount} đợt)` : "0 lần"}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t border-border bg-muted/10 font-medium text-foreground">
                <tr>
                  <td className="px-2.5 py-1.5" colSpan={2}>
                    Tổng cộng đối soát lý do nghỉ việc
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {leaveReasons.offEpisodeTotal}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {leaveReasons.byCategory.reduce((acc, r) => acc + r.fromOnCount, 0)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {leaveReasons.byCategory.reduce(
                      (acc, r) => acc + r.fromUnconfirmedWithoutOnCount,
                      0,
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {leaveReasons.offEpisodeTotal > 0 ? "100%" : "—"}
                  </td>
                  {leaveReasons.periodLeaveReasons.applicable ? (
                    <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">
                      {leaveReasons.periodLeaveReasons.offTransitionEventTotal} lần ({leaveReasons.periodLeaveReasons.offTransitionEpisodeTotal} đợt)
                    </td>
                  ) : null}
                </tr>
              </tfoot>
            </table>
          </div>

          {leaveReasons.periodLeaveReasons.applicable ? (
            <p className="mt-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted">
              Biến động chuyển sang {WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF} trong kỳ ({leaveReasons.periodLeaveReasons.fromDate} → {leaveReasons.periodLeaveReasons.toDate}):{" "}
              <strong className="tabular-nums text-foreground">{leaveReasons.periodLeaveReasons.offTransitionEventTotal}</strong> lần chuyển trên{" "}
              <strong className="tabular-nums text-foreground">{leaveReasons.periodLeaveReasons.offTransitionEpisodeTotal}</strong> đợt làm việc ({WORKFORCE_TRANSITION_PAIR_LABELS.ON_TO_OFF}:{" "}
              <strong className="tabular-nums text-foreground">{leaveReasons.periodLeaveReasons.onToOffEventTotal}</strong> lần · {WORKFORCE_TRANSITION_PAIR_LABELS.UNCONFIRMED_TO_OFF}:{" "}
              <strong className="tabular-nums text-foreground">{leaveReasons.periodLeaveReasons.unconfirmedToOffEventTotal}</strong> lần) · Độ phủ có lý do trong kỳ:{" "}
              <strong className="tabular-nums text-foreground">
                {formatCoverageRatePercent(leaveReasons.periodLeaveReasons.reasonCoverageRate)}
              </strong>{" "}
              ({leaveReasons.periodLeaveReasons.withReasonEventCount}/{leaveReasons.periodLeaveReasons.offTransitionEventTotal} lần).
            </p>
          ) : (
            <p className="mt-2 rounded-lg border border-dashed border-border bg-surface px-3 py-1.5 text-xs text-muted">
              {leaveReasons.periodLeaveReasons.windowLabel}
            </p>
          )}

          <p className="mt-2 text-[11px] text-muted">
            {WORKFORCE_LEAVE_REASON_STANDARDIZATION_NOTE}
          </p>
        </div>
      </Card>
    </section>
  );
}

type CachedDeepFilterState = {
  workforce: Extract<WorkforceReportingResult, { status: "ready" }>;
  extraProjects: WorkforceDimensionBucketMetrics[];
  projectPagination: {
    totalCount: number;
    pageSize: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

/**
 * WF-04 Post-Merge Hotfix — Panel lazy-loading cho tab `Báo cáo chuyên sâu`.
 * Chỉ mount và gọi `GET /api/reporting/workforce-deep` khi người dùng mở tab `Báo cáo chuyên sâu`.
 * Có session cache theo `filterSignature`, `AbortController` + request sequence guard chống ghi đè
 * dữ liệu cũ khi đổi bộ lọc nhanh, và hỗ trợ tải thêm từng trang 5 dự án từ server.
 */
export function WorkforceDeepReportPanel({
  data,
  generatedAt,
  optionsResult,
}: {
  data: ReportingData;
  generatedAt?: string;
  optionsResult: ReportingOptionsResult;
}) {
  const filterSignature = buildWorkforceDeepFilterSignature(data);
  const cacheRef = useRef<Map<string, CachedDeepFilterState>>(new Map());
  const requestSeqRef = useRef(0);
  const pageAbortRef = useRef<AbortController | null>(null);
  const userRetryRef = useRef(false);
  const notify = useNotify();

  const [state, setState] = useState<{
    signature: string;
    status: "loading" | "ready" | "error";
    payload: CachedDeepFilterState | null;
  }>({
    signature: filterSignature,
    status: "loading",
    payload: null,
  });
  const [reloadToken, setReloadToken] = useState(0);
  const [loadingMoreState, setLoadingMoreState] = useState<{
    signature: string;
    loading: boolean;
    error: boolean;
  }>({ signature: filterSignature, loading: false, error: false });

  useEffect(() => {
    if (pageAbortRef.current) {
      pageAbortRef.current.abort();
      pageAbortRef.current = null;
    }

    const cached = reloadToken === 0 ? cacheRef.current.get(filterSignature) : undefined;
    if (cached) {
      userRetryRef.current = false;
      setState({
        signature: filterSignature,
        status: "ready",
        payload: cached,
      });
      return;
    }

    const seq = ++requestSeqRef.current;
    const controller = new AbortController();
    const isUserRetry = userRetryRef.current;
    setState({ signature: filterSignature, status: "loading", payload: null });

    fetch(buildWorkforceDeepUrl(data, { mode: "deep" }), {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        const json: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted || seq !== requestSeqRef.current) return;
        if (!response.ok || !isReadyWorkforceDeepEnvelope(json)) {
          userRetryRef.current = false;
          setState({ signature: filterSignature, status: "error", payload: null });
          if (isUserRetry) {
            notify.error({
              title: "Không tải được dữ liệu báo cáo chuyên sâu cho bộ lọc hiện tại. Vui lòng thử lại.",
            });
          }
          return;
        }
        const wf = json.workforce;
        const pageMeta = wf.dimensions.byProject.pagination ?? {
          totalCount: wf.dimensions.byProject.buckets.length,
          pageSize: WORKFORCE_PROJECT_DEFAULT_PAGE_SIZE,
          hasMore: false,
          nextCursor: null,
        };
        const entry: CachedDeepFilterState = {
          workforce: wf,
          extraProjects: [],
          projectPagination: {
            totalCount: pageMeta.totalCount,
            pageSize: pageMeta.pageSize,
            hasMore: pageMeta.hasMore,
            nextCursor: pageMeta.nextCursor,
          },
        };
        userRetryRef.current = false;
        cacheRef.current.set(filterSignature, entry);
        setState({ signature: filterSignature, status: "ready", payload: entry });
      })
      .catch(() => {
        if (!controller.signal.aborted && seq === requestSeqRef.current) {
          userRetryRef.current = false;
          setState({ signature: filterSignature, status: "error", payload: null });
          if (isUserRetry) {
            notify.error({
              title: "Không tải được dữ liệu báo cáo chuyên sâu cho bộ lọc hiện tại. Vui lòng thử lại.",
            });
          }
        }
      });

    return () => controller.abort();
  }, [data, filterSignature, notify, reloadToken]);

  function handleRetry(): void {
    userRetryRef.current = true;
    cacheRef.current.delete(filterSignature);
    setReloadToken((n) => n + 1);
  }

  function handleLoadMoreProjects(): void {
    const current =
      state.signature === filterSignature && state.status === "ready" ? state.payload : null;
    if (!current) return;
    const cursor = current.projectPagination.nextCursor;
    if (!current.projectPagination.hasMore || !cursor) return;
    if (loadingMoreState.signature === filterSignature && loadingMoreState.loading) return;

    if (pageAbortRef.current) {
      pageAbortRef.current.abort();
    }
    const controller = new AbortController();
    pageAbortRef.current = controller;
    const activeSignature = filterSignature;

    setLoadingMoreState({ signature: activeSignature, loading: true, error: false });

    fetch(buildWorkforceDeepUrl(data, { mode: "project_page", cursor }), {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        const json: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!response.ok || !isReadyWorkforceProjectPageEnvelope(json)) {
          setLoadingMoreState({ signature: activeSignature, loading: false, error: true });
          notify.error({
            title: "Không tải được trang dự án tiếp theo, vui lòng thử lại.",
          });
          return;
        }
        const page = json.projectPage;
        const latestCached = cacheRef.current.get(activeSignature);
        if (!latestCached) return;

        const existingKeys = new Set<string>([
          ...latestCached.workforce.dimensions.byProject.buckets.map((b) => b.key),
          ...latestCached.extraProjects.map((b) => b.key),
        ]);
        const appended = [...latestCached.extraProjects];
        for (const row of page.rows) {
          if (!existingKeys.has(row.key)) {
            existingKeys.add(row.key);
            appended.push(row);
          }
        }

        const updated: CachedDeepFilterState = {
          workforce: latestCached.workforce,
          extraProjects: appended,
          projectPagination: {
            totalCount: page.totalCount,
            pageSize: page.pageSize,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
          },
        };
        cacheRef.current.set(activeSignature, updated);
        setLoadingMoreState({ signature: activeSignature, loading: false, error: false });
        setState((prev) =>
          prev.signature === activeSignature
            ? { signature: activeSignature, status: "ready", payload: updated }
            : prev,
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadingMoreState({ signature: activeSignature, loading: false, error: true });
          notify.error({
            title: "Không tải được trang dự án tiếp theo, vui lòng thử lại.",
          });
        }
      });
  }

  const isCurrentSignature = state.signature === filterSignature;
  const effectiveStatus = isCurrentSignature ? state.status : "loading";
  const effectivePayload = isCurrentSignature ? state.payload : null;
  const isMoreLoading =
    loadingMoreState.signature === filterSignature && loadingMoreState.loading;
  const isMoreError =
    loadingMoreState.signature === filterSignature && loadingMoreState.error;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4 sm:px-6">
      <header className="rounded-2xl border border-border bg-gradient-to-r from-primary/10 via-surface to-secondary/10 px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-primary">
            BoD · Báo cáo chuyên sâu
          </p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-foreground">
            Báo cáo chuyên sâu lực lượng lao động
          </h1>
          <p className="mt-0.5 max-w-2xl text-sm text-muted">
            Đối soát cân bằng đầu kỳ/cuối kỳ, thời gian chờ việc, thâm niên hiện diện, tỷ lệ giữ chân D7/D30/D90, chất lượng theo chiều và lý do nghỉ việc.
          </p>
          {generatedAt ? (
            <p className="mt-1 text-xs text-muted">
              Báo cáo tạo lúc: <time>{formatTimestamp(generatedAt)}</time>
            </p>
          ) : null}
        </div>
      </header>

      <div className="mt-4 space-y-4">
        <FiltersOrError optionsResult={optionsResult} />

        {effectiveStatus === "loading" ? (
          <div
            role="status"
            className="rounded-2xl border border-border bg-surface px-6 py-10 text-center text-sm text-muted"
          >
            Đang tải báo cáo chuyên sâu…
          </div>
        ) : effectiveStatus === "error" || !effectivePayload ? (
          <Alert tone="error" role="alert" title="Không tải được báo cáo chuyên sâu">
            <p>Không tải được dữ liệu báo cáo chuyên sâu cho bộ lọc hiện tại. Vui lòng thử lại.</p>
            <button
              type="button"
              onClick={handleRetry}
              className="mt-2 min-h-10 rounded-md border border-current px-3 text-xs font-medium"
            >
              Thử tải lại
            </button>
          </Alert>
        ) : (
          <WorkforceDeepSection
            workforce={effectivePayload.workforce}
            extraProjectBuckets={effectivePayload.extraProjects}
            projectPaginationOverride={effectivePayload.projectPagination}
            isLoadingMoreProjects={isMoreLoading}
            loadMoreProjectsError={isMoreError}
            onLoadMoreProjects={handleLoadMoreProjects}
          />
        )}
      </div>
    </main>
  );
}

/**
 * Collapsible full bucket list (shared by the scoped dashboards).
 */
export function BucketList({ buckets, label = "Xem danh sách đầy đủ" }: { buckets: Record<string, ReportingBucket>; label?: string }) {
  const sorted = sortBuckets(buckets);
  const bucketKeys = sorted.map((b) => b.key);
  const highlight = useBiHighlight(bucketKeys);
  if (sorted.length === 0) return <p className="mt-2 text-sm text-muted">Chưa có dữ liệu cho mục này.</p>;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm font-medium text-primary">
        {label} ({sorted.length})
      </summary>
      <div className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface">
        <table className="r22-report-table w-full text-sm">
          <tbody className="divide-y divide-border">
            {sorted.map((b) => {
              const isHighlighted = isBucketRowHighlighted(
                b.key,
                highlight.activeKey,
                highlight.topSliceKeys,
              );
              return (
                <tr
                  key={b.key}
                  tabIndex={0}
                  data-bi-highlighted={isHighlighted ? "true" : undefined}
                  onMouseEnter={() => highlight.onHover(b.key)}
                  onMouseLeave={() => highlight.onHover(null)}
                  onFocus={() => highlight.onFocus(b.key)}
                  onBlur={() => highlight.onFocus(null)}
                  onClick={() => highlight.onTogglePin(b.key)}
                  onKeyDown={(event) => highlight.handleKeyDown(event, b.key)}
                  className={`cursor-pointer text-foreground transition-colors duration-[var(--ui-motion-hover,160ms)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 ${
                    isHighlighted
                      ? "bg-primary/10 font-medium"
                      : "hover:bg-surface-hover"
                  }`}
                >
                  <td className="px-3 py-1.5">{b.display}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{b.recruitedCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <BiClearHighlightButton
        visible={highlight.pinnedKey !== null}
        onClear={highlight.onClear}
      />
    </details>
  );
}
