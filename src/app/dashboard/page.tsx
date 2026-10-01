import { connection } from "next/server";
import Link from "next/link";

import { buildDailyTrend, sortBuckets, topBuckets } from "@/lib/reporting/p1-dashboard";
import { fetchReporting } from "@/lib/reporting/p1-reporting-server";
import { fetchReportingOptions } from "@/lib/reporting/p1-options-server";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";
import type { ReportingBucket, ReportingData } from "@/lib/reporting/p1-reporting";
import { formatTimestamp } from "@/lib/format";

import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { SummaryCard } from "@/components/reporting/summary-card";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { SourceStatusTable } from "@/components/dashboard/source-status-table";
import { TopBarChart } from "@/components/dashboard/top-bar-chart";
import { TrendChart } from "@/components/dashboard/trend-chart";

export const dynamic = "force-dynamic";
export const metadata = { title: "Báo cáo tuyển dụng — mini-bi" };

type SearchParams = Record<string, string | string[] | undefined>;

function FiltersOrError({ optionsResult }: { optionsResult: ReportingOptionsResult }) {
  if (optionsResult.ok) {
    return <DashboardFilters options={optionsResult.options} />;
  }
  return (
    <Alert tone="error" title="Không tải được danh mục bộ lọc">
      <p>{optionsResult.code} · {optionsResult.message}</p>
      <p>Dữ liệu bên dưới vẫn đúng cho URL hiện tại, nhưng không thể chọn bộ lọc. Hãy thử tải lại trang.</p>
    </Alert>
  );
}

function NoMatchesBlock() {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-6 py-12 text-center dark:border-zinc-700 dark:bg-zinc-900">
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Không có dữ liệu khớp bộ lọc hiện tại</p>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Không có ngày/dự án/người tuyển/nhóm nào khớp bộ lọc đang chọn.</p>
      <p className="mt-4">
        <Link href="/dashboard" className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
          Xóa bộ lọc
        </Link>
      </p>
    </div>
  );
}

function BreakdownBlock({ title, buckets, top }: { title: string; buckets: Record<string, ReportingBucket>; top?: boolean }) {
  const sorted = sortBuckets(buckets);
  return (
    <Card>
      <CardHeader title={title} description={"Tổng: " + sorted.reduce((a, b) => a + b.recruitedCount, 0) + " người"} />
      {top ? (
        <div className="mb-3">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Top 10</p>
          <TopBarChart data={topBuckets(buckets, 10)} title={title} />
        </div>
      ) : null}
      {sorted.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Không có dữ liệu cho bộ lọc hiện tại.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            <tr className="border-b border-zinc-100 dark:border-zinc-900">
              <th className="py-1.5 text-left font-medium">{top ? "Tên (đầy đủ)" : "Nhóm"}</th>
              <th className="py-1.5 text-right font-medium">Số người</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {sorted.map((b) => (
              <tr key={b.key} className="text-zinc-700 dark:text-zinc-200">
                <td className="py-1.5">{b.display}</td>
                <td className="py-1.5 text-right font-mono">{b.recruitedCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await connection();
  const params = await searchParams;
  const [report, options] = await Promise.all([fetchReporting(params), fetchReportingOptions()]);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Báo cáo tuyển dụng</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Số người tuyển theo ngày — theo dự án, người tuyển, HRP/Vendor và loại hình làm việc.</p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Tạo lúc: {formatTimestamp(report.ok ? report.generatedAt : undefined)}</p>
      </header>

      {report.ok === false ? (
        <div className="space-y-4">
          {report.code === "INVALID_FILTER" ? (
            <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-6 py-10 dark:border-red-900 dark:bg-red-950">
              <p className="text-sm font-semibold text-red-800 dark:text-red-200">Bộ lọc không hợp lệ</p>
              <p className="mt-2 text-sm text-red-700 dark:text-red-300">{report.message}</p>
              <p className="mt-4">
                <Link href="/dashboard" className="inline-flex h-9 items-center rounded-md bg-red-700 px-3 text-sm font-medium text-white hover:bg-red-800 dark:bg-red-600 dark:hover:bg-red-700">
                  Xóa bộ lọc
                </Link>
              </p>
            </div>
          ) : (
            <ErrorState title="Không tải được báo cáo" detail={report.code + " · " + report.message} />
          )}
        </div>
      ) : (
        <DashboardBody data={report.data} optionsResult={options} />
      )}
    </main>
  );
}

function DashboardBody({ data, optionsResult }: { data: ReportingData; optionsResult: ReportingOptionsResult }) {
  const trend = buildDailyTrend(data.byDate, data.applied.from, data.applied.to);
  const dataDays = trend.filter((p) => p.count > 0);
  const everSnapshotted = data.coverage.expected - data.coverage.neverSucceeded;
  const ratio = data.coverage.coverageRatio;
  const nonCovered = data.sources.filter((s) => s.status !== "covered").length;

  if (data.empty.noSources) {
    return (
      <div className="space-y-4">
        <FiltersOrError optionsResult={optionsResult} />
        <EmptyState title="Chưa có nguồn dữ liệu" description="Chưa có reporting source nào (active và không phải test). Khi n8n chạy workflow lần đầu, nguồn sẽ xuất hiện." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
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
          <section aria-label="Tổng quan">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <SummaryCard label="Tổng người tuyển" value={data.recruitedTotal} hint="sum(recruited_count)" />
              <SummaryCard label="Số ngày có tuyển" value={dataDays.length} hint="trong kết quả hiện tại" />
              <SummaryCard label="Nguồn trong scope" value={data.coverage.expected} hint={data.coverage.succeeded + " đã đồng bộ"} />
              <SummaryCard label="Nguồn từng có snapshot" value={everSnapshotted} hint={"tỷ lệ " + (ratio === null ? "—" : Math.round(ratio * 100) + "%")} />
            </div>
            {ratio !== null ? (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                Tỷ lệ nguồn từng có snapshot: <span className="font-mono">{Math.round(ratio * 100)}%</span> — đây là tỷ lệ nguồn đã từng có snapshot thành công, không phải trạng thái “khỏe mạnh”.
              </p>
            ) : null}
          </section>

          <section aria-label="Xu hướng theo ngày">
            <Card>
              <CardHeader title="Xu hướng theo ngày" description="Zero-fill những ngày không có record trong khoảng hiển thị." />
              <TrendChart data={trend} />
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[320px] text-left text-sm">
                  <caption className="sr-only">Bảng số người tuyển theo ngày (chỉ các ngày có tuyển dụng)</caption>
                  <thead className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    <tr className="border-b border-zinc-100 dark:border-zinc-900">
                      <th className="py-1.5 font-medium">Ngày</th>
                      <th className="py-1.5 text-right font-medium">Số người</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                    {dataDays.map((p) => (
                      <tr key={p.date} className="text-zinc-700 dark:text-zinc-200">
                        <td className="py-1.5 font-mono text-xs">{p.date}</td>
                        <td className="py-1.5 text-right font-mono">{p.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Biểu đồ zero-fill các ngày không có record (thể hiện là 0). Bảng chỉ liệt kê {dataDays.length} ngày thực sự có tuyển dụng.</p>
            </Card>
          </section>

          <section aria-label="Chi tiết theo chiều">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <BreakdownBlock title="Theo dự án" buckets={data.byProject} top />
              <BreakdownBlock title="Theo người tuyển" buckets={data.byRecruiter} top />
              <BreakdownBlock title="Theo HRP/Vendor" buckets={data.byProvider} />
              <BreakdownBlock title="Theo loại hình làm việc" buckets={data.byEmployment} />
            </div>
          </section>
        </>
      )}

      <section aria-label="Trạng thái dữ liệu">
        <Card>
          <CardHeader
            title="Trạng thái dữ liệu"
            description={
              data.coverage.expected + " nguồn · " + data.coverage.succeeded + " đã đồng bộ · " + data.coverage.partial + " chưa đầy đủ · " + data.coverage.failed + " lỗi · " + data.coverage.neverSucceeded + " chưa từng succeeded"
            }
          />
          <SourceStatusTable sources={data.sources} />
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Chưa tự đặt ngưỡng stale theo giờ — chỉ hiển thị freshness thực tế.</p>
        </Card>
      </section>
    </div>
  );
}
