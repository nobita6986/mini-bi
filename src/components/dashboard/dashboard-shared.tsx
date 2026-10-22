import Link from "next/link";
import type { ReactNode } from "react";

import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { sortBuckets } from "@/lib/reporting/p1-dashboard";
import {
  formatPeriodComparisonSummary,
  type PeriodComparisonResult,
} from "@/lib/reporting/p1-period-comparison";
import {
  WORKFORCE_BALANCE_COLUMN_LABELS,
  WORKFORCE_INITIAL_STATUS_LABELS,
  WORKFORCE_NON_ATTENDANCE_NOTE,
  WORKFORCE_SNAPSHOT_STATUS_LABELS,
  WORKFORCE_TRANSITION_PAIR_LABELS,
  WORKFORCE_UNIT_METADATA_NOTE,
  WORKFORCE_WAITING_SAMPLE_LABELS,
  type WorkforceReportingResult,
} from "@/lib/reporting/wf01-workforce-snapshot";
import {
  formatPlacementRatePercent,
  formatSignedBalanceDelta,
  formatWaitingDaysAverage,
} from "@/lib/reporting/wf02-workforce-balance-waiting";
import type { ReportingBucket } from "@/lib/reporting/p1-reporting";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";

import { DashboardFilters } from "./dashboard-filters";

export type { WorkforceReportingResult };

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
        <span className="font-mono font-semibold tabular-nums text-foreground">
          {formatted.deltaText}
        </span>
      </div>
      <p className="text-xs text-muted">{formatted.detailText}</p>
    </section>
  );
}

/**
 * MBI-DA-2026-01 Chặng 2 / WF-01 & WF-02 (Items 2.1, 2.2, 2.3 & 2.4):
 * Workforce snapshot as-of date D, period status transitions [from, to],
 * opening/closing balance reconciliation, and UNCONFIRMED waiting duration & placement rate.
 */
export function WorkforceSnapshotSection({
  workforce,
}: {
  workforce?: WorkforceReportingResult | null;
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
          Không tải được dữ liệu snapshot trạng thái lao động (as-of), cân bằng đầu/cuối kỳ và thời gian chờ việc. Các chỉ số tuyển dụng theo ngày báo cáo bên dưới vẫn giữ nguyên.
        </p>
      </section>
    );
  }

  const { snapshot, transitions, balance, waiting } = workforce;
  const asOfSourceLabel =
    snapshot.asOfSource === "filter_to"
      ? "Theo ngày kết thúc bộ lọc"
      : snapshot.asOfSource === "explicit_as_of"
        ? "Theo ngày mốc chỉ định"
        : "Theo ngày hiện hành (GMT+7)";

  const transitionRows = transitions.applicable
    ? [
        {
          key: "unconfirmed_to_on",
          label: WORKFORCE_TRANSITION_PAIR_LABELS.UNCONFIRMED_TO_ON,
          pair: transitions.pairs.unconfirmedToOn,
        },
        {
          key: "unconfirmed_to_off",
          label: WORKFORCE_TRANSITION_PAIR_LABELS.UNCONFIRMED_TO_OFF,
          pair: transitions.pairs.unconfirmedToOff,
        },
        {
          key: "on_to_off",
          label: WORKFORCE_TRANSITION_PAIR_LABELS.ON_TO_OFF,
          pair: transitions.pairs.onToOff,
        },
        {
          key: "off_to_on",
          label: WORKFORCE_TRANSITION_PAIR_LABELS.OFF_TO_ON,
          pair: transitions.pairs.offToOn,
        },
        ...(transitions.pairs.other.eventCount > 0
          ? [
              {
                key: "other",
                label: WORKFORCE_TRANSITION_PAIR_LABELS.OTHER,
                pair: transitions.pairs.other,
              },
            ]
          : []),
      ]
    : [];

  const balanceRows = balance.applicable
    ? [
        {
          key: "on",
          label: WORKFORCE_SNAPSHOT_STATUS_LABELS.ON,
          row: balance.byStatus.on,
        },
        {
          key: "unconfirmed",
          label: WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED,
          row: balance.byStatus.unconfirmed,
        },
        {
          key: "off",
          label: WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF,
          row: balance.byStatus.off,
        },
        {
          key: "unknown",
          label: WORKFORCE_SNAPSHOT_STATUS_LABELS.UNKNOWN,
          row: balance.byStatus.unknown,
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

  return (
    <section aria-label="Hiện trạng và biến động trạng thái lao động">
      <Card className="p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <CardHeader
            title="Hiện trạng & biến động trạng thái lao động"
            description={WORKFORCE_UNIT_METADATA_NOTE}
          />
          <div className="shrink-0">
            <StatusBadge tone="neutral" dot>
              Tính đến ngày {snapshot.asOfDate} ({asOfSourceLabel})
            </StatusBadge>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="rounded-xl border border-border bg-muted/5 p-3 lg:col-span-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                Snapshot trạng thái lao động
              </h3>
              <span className="font-mono text-xs text-muted">
                Tính đến ngày {snapshot.asOfDate}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted">
              Hồ sơ hợp lệ trong phạm vi có ngày bắt đầu làm việc ≤ {snapshot.asOfDate} (business-effective as-of).
            </p>

            <dl className="mt-3 grid grid-cols-2 gap-2">
              <div className="col-span-2 flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs font-medium text-muted">Tổng hồ sơ đủ điều kiện tại ngày mốc</dt>
                <dd className="font-mono text-base font-semibold tabular-nums text-foreground">
                  {snapshot.eligibleEpisodeTotal} <span className="text-xs font-normal text-muted">hồ sơ</span>
                </dd>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">{WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}</dt>
                <dd className="mt-0.5 font-mono text-base font-semibold tabular-nums text-foreground">
                  {snapshot.onCount} <span className="text-xs font-normal text-muted">hồ sơ</span>
                </dd>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">{WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED}</dt>
                <dd className="mt-0.5 font-mono text-base font-semibold tabular-nums text-foreground">
                  {snapshot.unconfirmedCount} <span className="text-xs font-normal text-muted">hồ sơ</span>
                </dd>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">{WORKFORCE_SNAPSHOT_STATUS_LABELS.OFF}</dt>
                <dd className="mt-0.5 font-mono text-base font-semibold tabular-nums text-foreground">
                  {snapshot.offCount} <span className="text-xs font-normal text-muted">hồ sơ</span>
                </dd>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">{WORKFORCE_SNAPSHOT_STATUS_LABELS.UNKNOWN}</dt>
                <dd className="mt-0.5 font-mono text-base font-semibold tabular-nums text-foreground">
                  {snapshot.unknownCount} <span className="text-xs font-normal text-muted">hồ sơ</span>
                </dd>
              </div>
            </dl>

            {snapshot.futureEpisodeCount > 0 ? (
              <p className="mt-2 text-xs text-muted">
                Chưa bắt đầu làm việc tại ngày {snapshot.asOfDate} (first_work_date &gt; {snapshot.asOfDate}):{" "}
                <span className="font-mono font-medium text-foreground">{snapshot.futureEpisodeCount}</span> hồ sơ (tách riêng, không cộng vào snapshot).
              </p>
            ) : null}
          </div>

          <div className="rounded-xl border border-border bg-muted/5 p-3 lg:col-span-7">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                Biến động trạng thái trong kỳ
              </h3>
              {transitions.applicable ? (
                <span className="font-mono text-xs text-muted">
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
                      Khởi tạo hồ sơ mới trong kỳ (sự kiện đầu tiên của episode)
                    </span>
                    <span className="font-mono tabular-nums text-muted">
                      Tổng: <strong className="text-foreground">{transitions.initial.total.eventCount}</strong> sự kiện /{" "}
                      <strong className="text-foreground">{transitions.initial.total.episodeCount}</strong> hồ sơ
                    </span>
                  </div>
                  <p className="mt-1 text-muted">
                    {WORKFORCE_INITIAL_STATUS_LABELS.INITIAL_ON}:{" "}
                    <span className="font-mono font-medium text-foreground">{transitions.initial.on.eventCount}</span> sự kiện (
                    <span className="font-mono">{transitions.initial.on.episodeCount}</span> hồ sơ)
                    {" · "}
                    {WORKFORCE_INITIAL_STATUS_LABELS.INITIAL_UNCONFIRMED}:{" "}
                    <span className="font-mono font-medium text-foreground">{transitions.initial.unconfirmed.eventCount}</span> sự kiện (
                    <span className="font-mono">{transitions.initial.unconfirmed.episodeCount}</span> hồ sơ)
                  </p>
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
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                            {row.pair.eventCount}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                            {row.pair.episodeCount}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t border-border bg-muted/10 font-medium text-foreground">
                      <tr>
                        <td className="px-3 py-1.5">Tổng biến động chuyển trạng thái trong kỳ</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                          {transitions.totals.transitionEventCount}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
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

        {/* WF-02 (2.3 & 2.4): Cân bằng biến động đầu/cuối kỳ & Thời gian chờ việc / Tỷ lệ bố trí được việc */}
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
                    <strong className="font-mono text-foreground">{balance.openingAsOfDate}</strong> (trước kỳ 1 ngày)
                  </span>
                  <span>
                    Mốc cuối kỳ:{" "}
                    <strong className="font-mono text-foreground">{balance.closingAsOfDate}</strong>
                  </span>
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
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                            {item.row.openingCount}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                            +{item.row.newEpisodeInflowCount}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                            +{item.row.transitionInflowCount}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                            −{item.row.outflowCount}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                            {formatSignedBalanceDelta(item.row.netChange)}
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono font-semibold tabular-nums whitespace-nowrap">
                            {item.row.closingCount}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t border-border bg-muted/10 font-medium text-foreground">
                      <tr>
                        <td className="px-2.5 py-1.5">Tổng hồ sơ đủ điều kiện</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                          {balance.totals.openingEligibleTotal}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                          +{balance.totals.newEpisodeTotal}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                          +{balance.totals.transitionInflowTotal}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                          −{balance.totals.transitionOutflowTotal}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatSignedBalanceDelta(balance.totals.netEligibleChange)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right font-mono font-semibold tabular-nums whitespace-nowrap">
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
              <span className="font-mono text-xs text-muted">
                Vào thẳng {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON}: {waiting.directOnEpisodeCount} hồ sơ
              </span>
            </div>

            <dl className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">Tỷ lệ bố trí việc (trên tổng có chờ việc)</dt>
                <dd className="mt-0.5 font-mono text-base font-semibold tabular-nums text-foreground">
                  {formatPlacementRatePercent(waiting.placementRateOfWaiting)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted">
                  Mẫu: {waiting.placedToOn.episodeCount} / {waiting.waitingEpisodeTotal} hồ sơ qua {WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">Tỷ lệ bố trí việc (trên hồ sơ đã kết thúc chờ)</dt>
                <dd className="mt-0.5 font-mono text-base font-semibold tabular-nums text-foreground">
                  {formatPlacementRatePercent(waiting.placementRateOfCompletedWaiting)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted">
                  Mẫu: {waiting.placedToOn.episodeCount} / {waiting.completedWaiting.episodeCount} hồ sơ đã kết thúc chờ
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">Chờ việc TB (hồ sơ đã bố trí sang {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON})</dt>
                <dd className="mt-0.5 font-mono text-base font-semibold tabular-nums text-foreground">
                  {formatWaitingDaysAverage(waiting.placedToOn.avgWaitingDaysPerEpisode)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted">
                  Mẫu: {waiting.placedToOn.episodeCount} hồ sơ ({waiting.placedToOn.totalWaitingDays} ngày chờ)
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <dt className="text-xs text-muted">Chờ việc TB (hồ sơ đang còn chờ việc)</dt>
                <dd className="mt-0.5 font-mono text-base font-semibold tabular-nums text-foreground">
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
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                        {item.sample.episodeCount}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                        {item.sample.totalWaitingDays}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                        {formatWaitingDaysAverage(item.sample.avgWaitingDaysPerEpisode)}
                      </td>
                      <td className="px-2.5 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
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
                <strong className="font-mono text-foreground">{waiting.periodWaiting.activeWaitingEpisodeCount}</strong> hồ sơ có ngày chờ (
                <strong className="font-mono text-foreground">{waiting.periodWaiting.inPeriodWaitingDays}</strong> ngày chờ trong kỳ, TB{" "}
                <strong className="font-mono text-foreground">
                  {formatWaitingDaysAverage(waiting.periodWaiting.avgInPeriodWaitingDaysPerActiveEpisode)}
                </strong>
                /hồ sơ) · Bố trí sang {WORKFORCE_SNAPSHOT_STATUS_LABELS.ON} trong kỳ:{" "}
                <strong className="font-mono text-foreground">{waiting.periodWaiting.placedInPeriod.eventCount}</strong> lần (
                <span className="font-mono">{waiting.periodWaiting.placedInPeriod.episodeCount}</span> hồ sơ, TB{" "}
                <span className="font-mono">
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
      </Card>
    </section>
  );
}

export const WorkforceStatusSection = WorkforceSnapshotSection;

/**
 * Collapsible full bucket list (shared by the scoped dashboards).
 */
export function BucketList({ buckets, label = "Xem danh sách đầy đủ" }: { buckets: Record<string, ReportingBucket>; label?: string }) {
  const sorted = sortBuckets(buckets);
  if (sorted.length === 0) return <p className="mt-2 text-sm text-muted">Chưa có dữ liệu cho mục này.</p>;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm font-medium text-primary">
        {label} ({sorted.length})
      </summary>
      <div className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface">
        <table className="r22-report-table w-full text-sm">
          <tbody className="divide-y divide-border">
            {sorted.map((b) => (
              <tr key={b.key} className="text-foreground hover:bg-surface-hover">
                <td className="px-3 py-1.5">{b.display}</td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">{b.recruitedCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
