import { formatTimestamp } from "@/lib/format";
import { sourceStatusLabel } from "@/lib/reporting/p1-dashboard";
import type { ReportingSourceStatus, ReportingSourceStatusRow } from "@/lib/reporting/p1-reporting";

const TONES: Record<ReportingSourceStatus, string> = {
  covered: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  incomplete: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  stale_snapshot: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  never_succeeded: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  running: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  no_run: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

export function SourceStatusTable({ sources }: { sources: ReportingSourceStatusRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-muted/10 text-xs uppercase tracking-wide text-muted">
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
            <tr key={s.id} className="text-foreground">
              <td className="px-3 py-2 font-medium text-foreground">{s.fileName}</td>
              <td className="px-3 py-2">
                <span className={"inline-flex rounded-full px-2 py-0.5 text-xs font-medium " + TONES[s.status]}>
                  {sourceStatusLabel(s.status)}
                </span>
              </td>
              <td className="px-3 py-2 text-xs">{formatTimestamp(s.lastSuccessfulSyncAt)}</td>
              <td className="px-3 py-2 text-xs">{formatTimestamp(s.lastSeenAt)}</td>
              <td className="px-3 py-2">{s.contributes ? "Có" : "Không"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
