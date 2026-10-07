import { buildCategorySegments, buildProjectDonutData } from "@/lib/reporting/p1-chart-data";
import { buildDailyTrend, sortBuckets } from "@/lib/reporting/p1-dashboard";
import type { ScopedDashboardView } from "@/lib/reporting/p3-w06c-audience-view";
import { formatTimestamp } from "@/lib/format";
import type { ReportingData } from "@/lib/reporting/p1-reporting";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";

import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/reporting/empty-state";
import { EmploymentComposition } from "./employment-composition";
import { KpiCard } from "./kpi-card";
import { ProjectDonut } from "./project-donut";
import { TrendChart } from "./trend-chart";
import { BucketList, FiltersOrError, NoMatchesBlock, ScopeNote } from "./dashboard-shared";

/**
 * P3-W06C - Own dashboard (audience `own`).
 *
 * Personal view: only what the DB-authoritative W05A read path returned for the
 * signed-in recruiter identity. There is no member roster, no company ranking
 * and no recruiter filter, because the scope is already a single person.
 */

export function OwnDashboardView({
  data,
  generatedAt,
  optionsResult,
  view,
}: {
  data: ReportingData;
  generatedAt: string;
  optionsResult: ReportingOptionsResult;
  view: ScopedDashboardView;
}) {
  const trend = buildDailyTrend(data.byDate, data.applied.from, data.applied.to);
  const dataDays = trend.filter((p) => p.count > 0);
  const projects = sortBuckets(data.byProject);
  const noData = data.empty.noSources || data.empty.noFacts;
  const showData = !noData && !data.empty.noMatches;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4 sm:px-6">
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
            <dl aria-label="Chỉ số cá nhân" className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:min-w-80 sm:grid-cols-2">
              <KpiCard variant="compact" label="Tuyển mới của tôi" value={data.recruitedTotal} hint="số người tuyển" accent="var(--primary)" />
              <KpiCard variant="compact" label="Ngày tôi có tuyển" value={dataDays.length} hint="trong khoảng hiển thị" accent="var(--secondary)" />
            </dl>
          ) : null}
        </div>
      </header>

      <div className="mt-4 space-y-4">
        <ScopeNote label="Phạm vi báo cáo cá nhân">{view.scopeNote}</ScopeNote>
        <FiltersOrError optionsResult={optionsResult} showRecruiter={view.showRecruiterFilter} />

        {noData ? (
          <EmptyState title={view.emptyTitle} description={view.emptyDescription} />
        ) : data.empty.noMatches ? (
          <NoMatchesBlock detail="Không có ngày/dự án nào trong hồ sơ của bạn khớp bộ lọc đang chọn." />
        ) : (
          <>
            <section aria-label="Tóm tắt cá nhân" className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <Card className="lg:col-span-5">
                <CardHeader title="Tóm tắt của tôi" description="Số liệu tổng hợp trong phạm vi hồ sơ tuyển dụng của bạn." />
                <dl className="space-y-2 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted">Tổng người đã tuyển</dt>
                    <dd className="font-semibold text-foreground">{data.recruitedTotal}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted">Ngày có tuyển</dt>
                    <dd className="font-semibold text-foreground">{dataDays.length}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted">Dự án đã tuyển</dt>
                    <dd className="font-semibold text-foreground">{projects.length}</dd>
                  </div>
                </dl>
              </Card>
              <Card className="lg:col-span-7">
                <CardHeader title="Theo dự án của tôi" description="Phân bổ tuyển dụng của bạn theo dự án." />
                <ProjectDonut slices={buildProjectDonutData(data.byProject)} title="Biểu đồ theo dự án của tôi" />
                <BucketList buckets={data.byProject} />
              </Card>
            </section>

            <section aria-label="Xu hướng tuyển dụng của tôi">
              <Card>
                <CardHeader title="Xu hướng tuyển dụng của tôi" description="Số người bạn tuyển theo ngày; những ngày không có record thể hiện là 0 trên biểu đồ." />
                <TrendChart data={trend} />
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium text-primary">
                    Xem chi tiết {dataDays.length} ngày
                  </summary>
                  <div className="mt-2 max-h-72 overflow-y-auto">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">Bảng số người bạn tuyển theo ngày (chỉ các ngày có tuyển dụng)</caption>
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

            <section aria-label="Loại hình làm việc của tôi">
              <Card>
                <CardHeader title="Theo loại hình làm việc của tôi" />
                <EmploymentComposition segments={buildCategorySegments(data.byEmployment)} title="Biểu đồ loại hình làm việc của tôi" />
              </Card>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
