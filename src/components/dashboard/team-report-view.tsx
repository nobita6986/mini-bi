"use client";

import { buildCategorySegments, buildProjectDonutData } from "@/lib/reporting/p1-chart-data";
import { buildDailyTrend, sortBuckets } from "@/lib/reporting/p1-dashboard";
import { buildMemberContributions } from "@/lib/reporting/p3-w06c-audience-view";
import { formatTimestamp } from "@/lib/format";
import type { ReportingData } from "@/lib/reporting/p1-reporting";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";

import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/reporting/empty-state";
import { EmploymentComposition } from "./employment-composition";
import { KpiCard } from "./kpi-card";
import { ProjectDonut } from "./project-donut";
import { ProjectProviderMixCard } from "./project-provider-mix";
import { TrendChart } from "./trend-chart";
import { BucketList, FiltersOrError, NoMatchesBlock, ScopeNote } from "./dashboard-shared";
import { TeamEntryDetail } from "./team-entry-detail";

/**
 * P3-W06D-R2 - single shared team-report implementation.
 *
 * This is the ONE report body reused by BOTH audiences:
 *   - the Team Leader report (`TeamDashboardView`, DB audience `team`), and
 *   - the BoD "Báo cáo chi tiết nhóm" tab (`BodDashboardTabs`, DB audience `all`).
 *
 * It keeps the audience in the DB: it renders only the scoped `ReportingData`
 * it is handed, performs no client-side team or membership join, does not call
 * the admin catalog and never regroups facts. The per-row entry-level detail
 * list is rendered once, at the END of the report, by the shared
 * `TeamEntryDetail`.
 *
 * The HRP/Vendor breakdown card was removed per P3-W06D-R2 so both audiences
 * see exactly the same sections.
 */

export interface TeamReportViewConfig {
  eyebrow: string;
  title: string;
  description: string;
  scopeNote: string;
  emptyTitle: string;
  emptyDescription: string;
  noMatchesDetail: string;
  showMemberRanking: boolean;
  showProjectProviderMix: boolean;
  showRecruiterFilter: boolean;
  kpiAriaLabel: string;
  kpiPrimaryLabel: string;
  kpiPrimaryHint: string;
  kpiSecondaryLabel: string;
  kpiSecondaryHint: string;
  memberTitle: string;
  memberDescription: string;
  memberAriaLabel: string;
  entryHeading: string;
  entryDescription: string;
  entryPickerTitle: string;
}

export function TeamReportView({
  data,
  generatedAt,
  optionsResult,
  view,
}: {
  data: ReportingData;
  generatedAt?: string;
  optionsResult: ReportingOptionsResult;
  view: TeamReportViewConfig;
}) {
  const trend = buildDailyTrend(data.byDate, data.applied.from, data.applied.to);
  const dataDays = trend.filter((p) => p.count > 0);
  const members = buildMemberContributions(data.byRecruiter);
  const noData = data.empty.noSources || data.empty.noFacts;
  const showData = !noData && !data.empty.noMatches;
  const memberTotal = members.reduce((a, m) => a + m.count, 0);
  const averagePerMember = members.length > 0 ? Math.round((memberTotal / members.length) * 10) / 10 : 0;
  const entryBuckets = sortBuckets(data.byTeam);

  return (
    <>
      <header className="rounded-2xl border border-border bg-gradient-to-r from-primary/10 via-surface to-secondary/10 px-5 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-wide text-primary">{view.eyebrow}</p>
            <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-foreground">{view.title}</h1>
            <p className="mt-0.5 max-w-2xl text-sm text-muted">{view.description}</p>
            {generatedAt ? (
              <p className="mt-1 text-xs text-muted">
                Báo cáo tạo lúc: <time>{formatTimestamp(generatedAt)}</time>
              </p>
            ) : null}
          </div>
          {showData ? (
            <dl aria-label={view.kpiAriaLabel} className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:min-w-80 sm:grid-cols-2">
              <KpiCard variant="compact" label={view.kpiPrimaryLabel} value={data.recruitedTotal} hint={view.kpiPrimaryHint} accent="var(--primary)" />
              <KpiCard variant="compact" label={view.kpiSecondaryLabel} value={members.length} hint={view.kpiSecondaryHint} accent="var(--secondary)" />
            </dl>
          ) : null}
        </div>
      </header>

      <div className="mt-4 space-y-4">
        <ScopeNote label="Phạm vi báo cáo nhóm">{view.scopeNote}</ScopeNote>
        <FiltersOrError optionsResult={optionsResult} showRecruiter={view.showRecruiterFilter} />

        {noData ? (
          <EmptyState title={view.emptyTitle} description={view.emptyDescription} />
        ) : data.empty.noMatches ? (
          <NoMatchesBlock detail={view.noMatchesDetail} />
        ) : (
          <>
            {view.showMemberRanking ? (
              <section aria-label={view.memberAriaLabel}>
                <Card>
                  <CardHeader title={view.memberTitle} description={view.memberDescription} />
                  <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <div className="rounded-xl border border-border bg-muted/10 px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-muted">Tổng nhóm</p>
                      <p className="mt-0.5 font-semibold text-foreground">{memberTotal}</p>
                    </div>
                    <div className="rounded-xl border border-border bg-muted/10 px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-muted">Thành viên có tuyển</p>
                      <p className="mt-0.5 font-semibold text-foreground">{members.length}</p>
                    </div>
                    <div className="rounded-xl border border-border bg-muted/10 px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-muted">Trung bình/người</p>
                      <p className="mt-0.5 font-semibold text-foreground">{averagePerMember}</p>
                    </div>
                  </div>
                  {members.length === 0 ? (
                    <p className="text-sm text-muted">Chưa có thành viên nào có dữ liệu trong bộ lọc hiện tại.</p>
                  ) : (
                    <ul className="space-y-2">
                      {members.map((m) => (
                        <li key={m.key} className="grid grid-cols-1 gap-1 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,7rem)] md:items-center md:gap-3">
                          <span className="min-w-0 truncate text-sm text-foreground" title={m.display}>{m.display}</span>
                          <span
                            role="img"
                            aria-label={m.display + ": " + m.count + " người"}
                            className="flex h-3 w-full overflow-hidden rounded-full border border-border bg-muted/15"
                          >
                            <span className="h-full bg-primary" style={{ width: (m.share === null ? 0 : Math.round(m.share * 100)) + "%" }} />
                          </span>
                          <span className="text-xs md:text-right">
                            <span className="font-medium text-foreground">{m.count} người</span>
                            <span className="block text-muted">{m.share === null ? "—" : Math.round(m.share * 100) + "%"}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </section>
            ) : null}

            <section aria-label="Xu hướng tuyển dụng của nhóm">
              <Card>
                <CardHeader title="Xu hướng tuyển dụng của nhóm" description="Số người tuyển theo ngày; những ngày không có record thể hiện là 0 trên biểu đồ." />
                <TrendChart data={trend} />
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium text-primary">
                    Xem chi tiết {dataDays.length} ngày
                  </summary>
                  <div className="mt-2 max-h-72 overflow-y-auto">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">Bảng số người tuyển theo ngày trong nhóm (chỉ các ngày có tuyển dụng)</caption>
                      <thead className="sticky top-0 bg-surface text-xs uppercase tracking-wide text-muted">
                        <tr className="border-b border-border">
                          <th className="py-1.5 font-medium">Ngày</th>
                          <th className="py-1.5 text-right font-medium">Số người</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {dataDays.map((p) => (
                          <tr key={p.date} className="text-foreground">
                            <td className="py-1.5 font-mono text-xs">{p.date}</td>
                            <td className="py-1.5 text-right font-mono">{p.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </Card>
            </section>

            <section aria-label="Phân bổ tuyển dụng của nhóm" className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <Card className="lg:col-span-7">
                <CardHeader title="Theo dự án trong nhóm" description="Phân bổ tuyển dụng của nhóm theo dự án." />
                <ProjectDonut slices={buildProjectDonutData(data.byProject)} title="Biểu đồ theo dự án của nhóm" />
                <BucketList buckets={data.byProject} />
              </Card>
              <Card className="lg:col-span-5">
                <CardHeader title="Theo loại hình làm việc của nhóm" />
                <EmploymentComposition segments={buildCategorySegments(data.byEmployment)} title="Biểu đồ loại hình làm việc của nhóm" />
              </Card>
              {view.showProjectProviderMix ? (
                <Card className="lg:col-span-12">
                  <CardHeader
                    title="Tỷ lệ HRP/Vendor theo dự án của nhóm"
                    description="Tỷ trọng Vendor/HRP trong phần đã phân loại của từng dự án trong nhóm; “Không xác định” và “Không hợp lệ” không nằm trong mẫu số."
                  />
                  <ProjectProviderMixCard mix={data.projectProviderMix} providerFilterActive={Boolean(data.applied.provider)} />
                </Card>
              ) : null}
            </section>

            <section aria-label="Danh sách chi tiết từng dòng">
              <TeamEntryDetail
                data={data}
                buckets={entryBuckets}
                heading={view.entryHeading}
                description={view.entryDescription}
                pickerTitle={view.entryPickerTitle}
              />
            </section>
          </>
        )}
      </div>
    </>
  );
}
