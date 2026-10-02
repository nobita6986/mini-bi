import Link from "next/link";
import Image from "next/image";

import { buildDailyTrend, sortBuckets } from "@/lib/reporting/p1-dashboard";
import { buildBarData, buildCategorySegments, buildProjectDonutData, buildSourceStatusSegments } from "@/lib/reporting/p1-chart-data";
import { formatTimestamp } from "@/lib/format";
import type { ReportingData, ReportingBucket } from "@/lib/reporting/p1-reporting";
import type { ReportingFetchResult } from "@/lib/reporting/p1-reporting-server";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";

import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { AiReportPanel } from "@/components/ai-report/ai-report-panel";
import { AiSettingsPanel } from "./ai-settings-panel";
import { DashboardFilters } from "./dashboard-filters";
import { EmploymentComposition } from "./employment-composition";
import { KpiCard } from "./kpi-card";
import { ProjectDonut } from "./project-donut";
import { ProjectProviderMixCard } from "./project-provider-mix";
import { ProviderDonut } from "./provider-donut";
import { RecruiterBarChart } from "./recruiter-bar-chart";
import { SourceStatusBar } from "./source-status-bar";
import { SourceStatusTable } from "./source-status-table";
import { ThemeSelector } from "./theme-selector";
import { TrendChart } from "./trend-chart";

function FullList({ buckets }: { buckets: Record<string, ReportingBucket> }) {
  const sorted = sortBuckets(buckets);
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm font-medium text-primary">
        Xem danh sách đầy đủ ({sorted.length})
      </summary>
      <div className="mt-2 max-h-72 overflow-y-auto">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border">
            {sorted.map((b) => (
              <tr key={b.key} className="text-foreground">
                <td className="py-1.5">{b.display}</td>
                <td className="py-1.5 text-right font-mono">{b.recruitedCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function DashboardView({
  report,
  optionsResult,
  aiSettingsEnabled = false,
}: {
  report: ReportingFetchResult;
  optionsResult: ReportingOptionsResult;
  /** W04A — chỉ render panel cấu hình AI khi server đã xác nhận AI_SETTINGS_ENABLED=true. */
  aiSettingsEnabled?: boolean;
}) {
  const generatedAt = report.ok ? report.generatedAt : undefined;
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4 sm:px-6">
      <header className="rounded-2xl border border-border bg-gradient-to-r from-primary/10 via-surface to-secondary/10 px-5 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:gap-4">
            <div className="flex h-16 shrink-0 items-center justify-center rounded-lg bg-white p-1 shadow-sm ring-1 ring-border sm:h-20">
              <Image src="/brand/hrpartner-logo.png" alt="HR Partner" width={2166} height={1706} priority className="h-full w-auto" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-primary">BoD · Báo cáo điều hành</p>
              <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-foreground">Tổng quan tuyển dụng</h1>
              <p className="mt-0.5 max-w-2xl text-sm text-muted">Số người tuyển theo ngày, dự án, người tuyển, HRP/Vendor và loại hình.</p>
              {generatedAt ? (
                <p className="mt-1 text-xs text-muted">Báo cáo tạo lúc: <time>{formatTimestamp(generatedAt)}</time></p>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-start justify-end gap-2">
            <AiReportPanel />
            <ThemeSelector />
            {aiSettingsEnabled ? <AiSettingsPanel /> : null}
          </div>
        </div>
      </header>

      <div className="mt-4">
        {report.ok === false ? (
          <ReportError report={report} />
        ) : (
          <DashboardBody data={report.data} optionsResult={optionsResult} />
        )}
      </div>
    </main>
  );
}

function ReportError({ report }: { report: Extract<ReportingFetchResult, { ok: false }> }) {
  if (report.code === "INVALID_FILTER") {
    return (
      <div role="alert" className="rounded-2xl border border-red-300 bg-red-50 px-6 py-10 dark:border-red-900 dark:bg-red-950">
        <p className="text-sm font-semibold text-red-800 dark:text-red-200">Bộ lọc không hợp lệ</p>
        <p className="mt-2 text-sm text-red-700 dark:text-red-300">{report.message}</p>
        <p className="mt-4">
          <Link href="/dashboard" className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary/90">
            Xóa bộ lọc
          </Link>
        </p>
      </div>
    );
  }
  return <ErrorState title="Không tải được báo cáo" detail={report.code + " · " + report.message} />;
}

function FiltersOrError({ optionsResult }: { optionsResult: ReportingOptionsResult }) {
  if (optionsResult.ok) return <DashboardFilters options={optionsResult.options} />;
  return (
    <Alert tone="error" title="Không tải được danh mục bộ lọc">
      <p>{optionsResult.code} · {optionsResult.message}</p>
      <p>Dữ liệu bên dưới vẫn đúng cho URL hiện tại, nhưng không thể chọn bộ lọc. Hãy thử tải lại trang.</p>
    </Alert>
  );
}

function NoMatchesBlock() {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/10 px-6 py-12 text-center">
      <p className="text-sm font-medium text-foreground">Không có dữ liệu khớp bộ lọc hiện tại</p>
      <p className="mt-1 text-sm text-muted">Không có ngày/dự án/người tuyển/nhóm nào khớp bộ lọc đang chọn.</p>
      <p className="mt-4">
        <Link href="/dashboard" className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary/90">
          Xóa bộ lọc
        </Link>
      </p>
    </div>
  );
}

function DashboardBody({ data, optionsResult }: { data: ReportingData; optionsResult: ReportingOptionsResult }) {
  const trend = buildDailyTrend(data.byDate, data.applied.from, data.applied.to);
  const dataDays = trend.filter((p) => p.count > 0);
  const everSnapshotted = data.coverage.expected - data.coverage.neverSucceeded;
  const ratio = data.coverage.coverageRatio;
  const nonCovered = data.sources.filter((s) => s.status !== "covered").length;
  const statusSegments = buildSourceStatusSegments(data.sources);

  if (data.empty.noSources) {
    return (
      <div className="space-y-4">
        <FiltersOrError optionsResult={optionsResult} />
        <EmptyState title="Chưa có nguồn dữ liệu" description="Chưa có nguồn báo cáo nào. Khi n8n chạy workflow lần đầu, nguồn sẽ xuất hiện ở đây." />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <FiltersOrError optionsResult={optionsResult} />

      {nonCovered > 0 ? (
        <Alert tone="warning" title="Trạng thái dữ liệu cần lưu ý">
          <p>{nonCovered} nguồn chưa ở trạng thái “Đã đồng bộ”. Xem mục “Trạng thái dữ liệu” bên dưới.</p>
        </Alert>
      ) : null}

      {data.empty.noFacts ? (
        <EmptyState title="Có nguồn nhưng chưa có dữ liệu tuyển dụng" description="Các nguồn trong scope chưa có snapshot nào trong daily_recruitment_breakdown." />
      ) : data.empty.noMatches ? (
        <NoMatchesBlock />
      ) : (
        <>
          <section aria-label="Chỉ số chính" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label="Tổng tuyển mới" value={data.recruitedTotal} hint="số người tuyển trong kết quả" accent="var(--primary)" />
            <KpiCard label="Số ngày có tuyển" value={dataDays.length} hint="trong khoảng hiển thị" accent="var(--secondary)" />
            <KpiCard label="Nguồn báo cáo" value={data.coverage.expected} hint={data.coverage.succeeded + " đã đồng bộ"} accent="var(--accent)" />
            <KpiCard label="Độ phủ dữ liệu" value={everSnapshotted + "/" + data.coverage.expected} hint={(ratio === null ? "—" : Math.round(ratio * 100) + "% nguồn từng có snapshot")} accent="var(--semantic-success)" />
          </section>

          <section aria-label="Xu hướng tuyển dụng">
            <Card className="p-4">
              <CardHeader title="Xu hướng tuyển dụng" description="Số người tuyển theo ngày; những ngày không có record thể hiện là 0 trên biểu đồ." />
              <TrendChart data={trend} />
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-primary">
                  Xem chi tiết {dataDays.length} ngày
                </summary>
                <div className="mt-2 max-h-72 overflow-y-auto">
                  <table className="w-full min-w-[300px] text-left text-sm">
                    <caption className="sr-only">Bảng số người tuyển theo ngày (chỉ các ngày có tuyển dụng)</caption>
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

          <section aria-label="Phân bổ tuyển dụng" className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            <Card className="p-4 lg:col-span-7">
              <CardHeader title="Theo dự án" description="Phân bổ tuyển dụng theo dự án." />
              <ProjectDonut slices={buildProjectDonutData(data.byProject)} title="Biểu đồ theo dự án" />
              <FullList buckets={data.byProject} />
            </Card>
            <Card className="p-4 lg:col-span-5">
              <CardHeader title="Theo HRP/Vendor" />
              <ProviderDonut segments={buildCategorySegments(data.byProvider)} title="Biểu đồ HRP/Vendor" />
            </Card>
            <Card className="p-4 lg:col-span-12">
              <CardHeader
                title="Tỷ lệ HRP/Vendor theo dự án"
                description="Tỷ trọng Vendor/HRP trong phần đã phân loại của từng dự án; “Không xác định” và “Không hợp lệ” không nằm trong mẫu số."
              />
              <ProjectProviderMixCard mix={data.projectProviderMix} providerFilterActive={Boolean(data.applied.provider)} />
            </Card>
            <Card className="p-4 lg:col-span-7">
              <CardHeader title="Theo người tuyển" description="Top 10 người tuyển theo số người tuyển." />
              <RecruiterBarChart data={buildBarData(data.byRecruiter, 10)} title="Biểu đồ theo người tuyển" />
              <FullList buckets={data.byRecruiter} />
            </Card>
            <Card className="p-4 lg:col-span-5">
              <CardHeader title="Theo loại hình làm việc" />
              <EmploymentComposition segments={buildCategorySegments(data.byEmployment)} title="Biểu đồ loại hình làm việc" />
            </Card>
          </section>
        </>
      )}

      <section aria-label="Trạng thái dữ liệu">
        <Card className="p-4">
          <CardHeader title="Trạng thái nguồn dữ liệu" description="Phân bố trạng thái đồng bộ của các nguồn báo cáo." />
          <SourceStatusBar segments={statusSegments} total={data.sources.length} />
          <div className="mt-4">
            <SourceStatusTable sources={data.sources} />
          </div>
          <p className="mt-2 text-xs text-muted">Chưa tự đặt ngưỡng “cũ” theo giờ — chỉ hiển thị freshness thực tế.</p>
        </Card>
      </section>
    </div>
  );
}
