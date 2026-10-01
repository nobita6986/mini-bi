import { notFound } from "next/navigation";

import { fetchPipelineCheck } from "@/lib/reporting/pipeline-check-server";
import { isPipelineCheckEnabled } from "@/lib/reporting/pipeline-check-safety";
import { formatTimestamp } from "@/lib/format";
import type { DimensionBreakdown } from "@/lib/reporting/pipeline-check";
import { DAILY_RECRUITMENT_BREAKDOWN_CONTRACT_VERSION } from "@/lib/contracts/daily-recruitment-breakdown";

import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { SourceStatusTable } from "@/components/reporting/source-status-table";
import { StatusBadge } from "@/components/reporting/status-badge";
import { SummaryCard } from "@/components/reporting/summary-card";

export const dynamic = "force-dynamic";

export const metadata = { title: "Pipeline check — mini-bi" };

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-base font-semibold text-foreground">{children}</h2>;
}

function DimensionList({ title, items }: { title: string; items: DimensionBreakdown[] }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{title}</p>
      {items.length === 0 ? (
        <p className="text-xs text-muted">—</p>
      ) : (
        <ul className="space-y-1 text-xs text-foreground">
          {items.map((item) => (
            <li key={item.label} className="flex justify-between gap-2">
              <span className="truncate">{item.label}</span>
              <span className="shrink-0 font-mono text-zinc-500">
                {item.groups} nhóm · {item.recruited} người
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default async function PipelineCheckPage() {
  // Deployment safety guard: chạy TRƯỚC mọi DB query / trước khi tạo Supabase client.
  if (!isPipelineCheckEnabled(process.env.NODE_ENV, process.env.PIPELINE_CHECK_ENABLED)) {
    notFound();
  }

  const result = await fetchPipelineCheck();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Pipeline check</h1>
          <p className="mt-1 text-sm text-muted">Trạng thái đường dẫn dữ liệu Google Sheets → n8n → Supabase.</p>
        </header>
        <ErrorState title="Không tải được dữ liệu pipeline" detail={result.code + " · " + result.message} />
      </main>
    );
  }

  const { data, generatedAt } = result;
  const o = data.overview;

  if (o.sourcesTotal === 0) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Pipeline check</h1>
          <p className="mt-1 text-sm text-muted">Trạng thái đường dẫn dữ liệu Google Sheets → n8n → Supabase.</p>
        </header>
        <EmptyState
          title="Chưa có nguồn dữ liệu"
          description="Chưa có data_sources nào. Khi T2 chạy workflow lần đầu, nguồn sẽ xuất hiện ở đây."
        />
      </main>
    );
  }

  const hasRuns = data.sources.some((s) => s.latestRun !== null);
  const hasSnapshot = data.snapshot.breakdownGroups > 0;
  const overall = o.latestRunStatus;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
        Trang vận hành — DEV/local. Production bị tắt mặc định (PIPELINE_CHECK_ENABLED=true để bật). Dữ liệu thật/BoD cần access gate P1-W03. Không hiển thị dữ liệu cá nhân ứng viên.
      </div>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Pipeline check</h1>
        <p className="mt-1 text-sm text-muted">
          Trạng thái đường dẫn dữ liệu Google Sheets → n8n → Supabase · contract{" "}
          <span className="font-mono text-xs">{DAILY_RECRUITMENT_BREAKDOWN_CONTRACT_VERSION}</span>
        </p>
        <p className="mt-1 text-xs text-muted">Tạo lúc: {formatTimestamp(generatedAt)}</p>
      </header>

      {!hasRuns ? (
        <div className="mb-6 rounded-lg border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100">
          Đã phát hiện nguồn nhưng chưa có run nào. Khi T2 chạy workflow, trạng thái sẽ xuất hiện ở đây.
        </div>
      ) : null}

      {overall === "failed" ? (
        <div className="mb-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          Lần chạy gần nhất gặp lỗi (failed). Xem mục “Lỗi và cảnh báo” bên dưới.
        </div>
      ) : overall === "partial" ? (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Lần chạy gần nhất hoàn thành một phần (partial): có hàng bị loại hoặc cảnh báo. Xem mục “Lỗi và cảnh báo”.
        </div>
      ) : null}

      {/* A. Tổng quan */}
      <section className="mb-8">
        <SectionTitle>Tổng quan pipeline</SectionTitle>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          <SummaryCard
            label="Nguồn đã phát hiện"
            value={o.sourcesTotal}
            hint={o.sourcesActive + " active"}
          />
          <SummaryCard
            label="Run gần nhất"
            value={overall ? <StatusBadge status={overall} /> : "—"}
            hint={overall ? "bắt đầu " + formatTimestamp(o.latestRunStartedAt) : "chưa có run"}
          />
          <SummaryCard
            label="Đồng bộ thành công gần nhất"
            value={o.latestSuccessfulSyncAt ? formatTimestamp(o.latestSuccessfulSyncAt).split(" ").slice(0, 2).join(" ") : "—"}
            hint={o.latestSuccessfulSyncAt ? formatTimestamp(o.latestSuccessfulSyncAt) : "chưa có lần succeeded"}
          />
          <SummaryCard label="rows_read" value={o.totals.rowsRead} hint="trên run gần nhất mỗi nguồn" />
          <SummaryCard label="rows_valid" value={o.totals.rowsValid} hint="trên run gần nhất mỗi nguồn" />
          <SummaryCard label="rows_rejected" value={o.totals.rowsRejected} hint="trên run gần nhất mỗi nguồn" />
          <SummaryCard label="rows_warned" value={o.totals.rowsWarned} hint="trên run gần nhất mỗi nguồn" />
          <SummaryCard label="warning_issues" value={o.totals.warningIssues} hint="trên run gần nhất mỗi nguồn" />
          <SummaryCard
            label="Tuyển dụng hiện tại"
            value={data.snapshot.recruitedTotal}
            hint={data.snapshot.breakdownGroups + " nhóm breakdown"}
          />
        </div>
      </section>

      {/* B. Bảng trạng thái nguồn */}
      <section className="mb-8">
        <SectionTitle>Trạng thái nguồn</SectionTitle>
        <SourceStatusTable sources={data.sources} />
      </section>

      {/* C. Snapshot */}
      <section className="mb-8">
        <SectionTitle>Kiểm tra snapshot</SectionTitle>
        {!hasSnapshot ? (
          <EmptyState title="Có nguồn nhưng chưa có snapshot" description="Chưa có dữ liệu trong daily_recruitment_breakdown." />
        ) : (
          <>
            <div className="mb-4 overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[480px] text-left text-sm">
                <thead className="bg-muted/10 text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">business_date</th>
                    <th className="px-3 py-2 font-medium">Nguồn</th>
                    <th className="px-3 py-2 text-right font-medium">Số người tuyển</th>
                    <th className="px-3 py-2 text-right font-medium">Nhóm</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.snapshot.byDateSource.map((row, i) => (
                    <tr key={i} className="text-foreground">
                      <td className="px-3 py-2 font-mono text-xs">{row.businessDate}</td>
                      <td className="px-3 py-2">{row.fileName}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{row.recruitedCount}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{row.groups}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <DimensionList title="Theo HRP/Vendor" items={data.snapshot.byProvider} />
              <DimensionList title="Theo loại hình" items={data.snapshot.byEmployment} />
              <DimensionList title="Theo dự án (top)" items={data.snapshot.byProject} />
              <DimensionList title="Theo người tuyển (top)" items={data.snapshot.byRecruiter} />
            </div>
          </>
        )}
      </section>

      {/* D. Lỗi và cảnh báo */}
      <section className="mb-8">
        <SectionTitle>Lỗi và cảnh báo (gần nhất)</SectionTitle>
        {data.issues.length === 0 ? (
          <EmptyState title="Không có lỗi hoặc cảnh báo" description="Không có sync_errors trong 200 dòng gần nhất." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-muted/10 text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Nguồn</th>
                  <th className="px-3 py-2 font-medium">Hàng</th>
                  <th className="px-3 py-2 font-medium">Mức</th>
                  <th className="px-3 py-2 font-medium">error_code</th>
                  <th className="px-3 py-2 font-medium">Thời điểm</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.issues.map((issue, i) => (
                  <tr key={i} className="text-foreground">
                    <td className="px-3 py-2">{issue.fileName}</td>
                    <td className="px-3 py-2 font-mono text-xs">{issue.sourceRowNumber ?? "—"}</td>
                    <td className="px-3 py-2">
                      {issue.issueLevel === "error" ? (
                        <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-200">
                          error
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                          warning
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{issue.errorCode}</td>
                    <td className="px-3 py-2 text-xs">{formatTimestamp(issue.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="text-xs text-muted">
        Timestamp hiển thị theo Asia/Ho_Chi_Minh (GMT+7). Trang không áp dụng ngưỡng “stale” — chỉ hiển thị freshness thực tế.
      </footer>
    </main>
  );
}
