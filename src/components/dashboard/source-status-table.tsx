import { formatTimestamp } from "@/lib/format";
import { sourceStatusLabel } from "@/lib/reporting/p1-dashboard";
import type { ReportingSourceStatus, ReportingSourceStatusRow } from "@/lib/reporting/p1-reporting";

const TONES: Record<ReportingSourceStatus, string> = {
  covered: "border border-status-success-border bg-status-success-bg text-status-success-text",
  incomplete: "border border-status-warning-border bg-status-warning-bg text-status-warning-text",
  stale_snapshot: "border border-status-warning-border bg-status-warning-bg text-status-warning-text",
  never_succeeded: "border border-status-danger-border bg-status-danger-bg text-status-danger-text",
  running: "border border-status-info-border bg-status-info-bg text-status-info-text",
  no_run: "border border-border bg-surface-muted text-muted",
};

export function SourceStatusTable({ sources }: { sources: ReportingSourceStatusRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="r22-report-table w-full min-w-[640px] text-left text-sm">
        <thead className="bg-surface-muted text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Nguồn</th>
            <th className="px-3 py-2 font-medium">Trạng thái</th>
            <th className="px-3 py-2 font-medium">Đồng bộ thành công gần nhất</th>
            <th className="px-3 py-2 font-medium">Thấy gần nhất</th>
            <th className="px-3 py-2 font-medium">Đóng góp kết quả</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sources.map((s) => (
            <tr key={s.id} className="text-foreground hover:bg-surface-hover">
              <td className="px-3 py-2 font-medium text-foreground">{s.fileName}</td>
              <td className="px-3 py-2">
                <span className={"inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium " + TONES[s.status]}>
                  {sourceStatusLabel(s.status)}
                </span>
              </td>
              <td className="px-3 py-2 font-mono tabular-nums whitespace-nowrap text-xs">{formatTimestamp(s.lastSuccessfulSyncAt)}</td>
              <td className="px-3 py-2 font-mono tabular-nums whitespace-nowrap text-xs">{formatTimestamp(s.lastSeenAt)}</td>
              <td className="px-3 py-2">{s.contributes ? "Có" : "Không"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
