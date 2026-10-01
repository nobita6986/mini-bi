import Link from "next/link";

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
import { DashboardFilters } from "./dashboard-filters";
import { EmploymentComposition } from "./employment-composition";
import { KpiCard } from "./kpi-card";
import { ProjectDonut } from "./project-donut";
import { ProviderDonut } from "./provider-donut";
import { RecruiterBarChart } from "./recruiter-bar-chart";
import { SourceStatusBar } from "./source-status-bar";
import { SourceStatusTable } from "./source-status-table";
import { TrendChart } from "./trend-chart";

function FullList({ buckets }: { buckets: Record<string, ReportingBucket> }) {
  const sorted = sortBuckets(buckets);
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm font-medium text-indigo-600 dark:text-indigo-400">
        Xem danh sách đầy đủ ({sorted.length})
      </summary>
      <div className="mt-2 max-h-72 overflow-y-auto">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {sorted.map((b) => (
              <tr key={b.key} className="text-slate-700 dark:text-slate-200">
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

export function DashboardView({ report, optionsResult }: { report: ReportingFetchResult; optionsResult: ReportingOptionsResult }) {
  const generatedAt = report.ok ? report.generatedAt : undefined;
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4 sm:px-6">
      <header className="rounded-2xl border border-slate-200 bg-gradient-to-r from-indigo-50 via-white to-sky-50 px-5 py-5 dark:border-slate-800 dark:from-indigo-950/40 dark:via-slate-900 dark:to-sky-950/40">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">Tổng quan tuyển dụng</h1>
        <p className="mt-0.5 max-w-2xl text-sm text-slate-600 dark:text-slate-300">Số người tuyển theo ngày, dự án, người tuyển, HRP/Vendor và loại hình.</p>
        {generatedAt ? (
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">Báo cáo tạo lúc: <time>{formatTimestamp(generatedAt)}</time></p>
        ) : null}
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
      <div role="alert" className="rounded-2xl border border-rose-300 bg-rose-50 px-6 py-10 dark:border-rose-900 dark:bg-rose-950">
        <p className="text-sm font-semibold text-rose-800 dark:text-rose-200">Bộ lọc không hợp lệ</p>
        <p className="mt-2 text-sm text-rose-700 dark:text-rose-300">{report.message}</p>
        <p className="mt-4">
          <Link href="/dashboard" className="inline-flex h-9 items-center rounded-lg bg-rose-700 px-3 text-sm font-medium text-white hover:bg-rose-600">
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
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center dark:border-slate-700 dark:bg-slate-900">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Không có dữ liệu khớp bộ lọc hiện tại</p>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Không có ngày/dự án/người tuyển/nhóm nào khớp bộ lọc đang chọn.</p>
      <p className="mt-4">
        <Link href="/dashboard" className="inline-flex h-9 items-center rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-500">
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
            <KpiCard label="Tổng tuyển mới" value={data.recruitedTotal} hint="số người tuyển trong kết quả" accent="#6366f1" />
            <KpiCard label="Số ngày có tuyển" value={dataDays.length} hint="trong khoảng hiển thị" accent="#0ea5e9" />
            <KpiCard label="Nguồn báo cáo" value={data.coverage.expected} hint={data.coverage.succeeded + " đã đồng bộ"} accent="#8b5cf6" />
            <KpiCard label="Độ phủ dữ liệu" value={everSnapshotted + "/" + data.coverage.expected} hint={(ratio === null ? "—" : Math.round(ratio * 100) + "% nguồn từng có snapshot")} accent="#10b981" />
          </section>

          <section aria-label="Xu hướng tuyển dụng">
            <Card className="p-4">
              <CardHeader title="Xu hướng tuyển dụng" description="Số người tuyển theo ngày; những ngày không có record thể hiện là 0 trên biểu đồ." />
              <TrendChart data={trend} />
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-indigo-600 dark:text-indigo-400">
                  Xem chi tiết {dataDays.length} ngày
                </summary>
                <div className="mt-2 max-h-72 overflow-y-auto">
                  <table className="w-full min-w-[300px] text-left text-sm">
                    <caption className="sr-only">Bảng số người tuyển theo ngày (chỉ các ngày có tuyển dụng)</caption>
                    <thead className="sticky top-0 bg-white text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                      <tr className="border-b border-slate-100 dark:border-slate-800">
                        <th className="py-1.5 font-medium">Ngày</th>
                        <th className="py-1.5 text-right font-medium">Số người</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {dataDays.map((p) => (
                        <tr key={p.date} className="text-slate-700 dark:text-slate-200">
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
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Chưa tự đặt ngưỡng “cũ” theo giờ — chỉ hiển thị freshness thực tế.</p>
        </Card>
      </section>
    </div>
  );
}
