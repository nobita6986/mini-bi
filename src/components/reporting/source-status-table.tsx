import { formatTimestamp, shortenId } from "@/lib/format";
import type { SourceStatus } from "@/lib/reporting/pipeline-check";

import { StatusBadge } from "./status-badge";

export function SourceStatusTable({ sources }: { sources: SourceStatus[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="r22-report-table w-full min-w-[980px] text-left text-sm">
        <thead className="bg-surface-muted text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Nguồn</th>
            <th className="px-3 py-2 font-medium">Drive ID</th>
            <th className="px-3 py-2 font-medium">Active</th>
            <th className="px-3 py-2 font-medium">Run gần nhất</th>
            <th className="px-3 py-2 font-medium">Bắt đầu</th>
            <th className="px-3 py-2 font-medium">Kết thúc</th>
            <th className="px-3 py-2 text-right font-medium">read / valid / rejected</th>
            <th className="px-3 py-2 text-right font-medium">warned / issues</th>
            <th className="px-3 py-2 font-medium">Thành công gần nhất</th>
            <th className="px-3 py-2 font-medium">last_seen</th>
            <th className="px-3 py-2 font-medium">error_code</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sources.map((s) => {
            const run = s.latestRun;
            return (
              <tr key={s.id} className="align-top text-foreground hover:bg-surface-hover">
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{s.fileName}</div>
                  <div className="text-xs text-muted">{s.sheetName}</div>
                </td>
                <td className="px-3 py-2 font-mono tabular-nums whitespace-nowrap text-xs text-muted" title={s.driveFileId}>
                  {shortenId(s.driveFileId)}
                </td>
                <td className="px-3 py-2">
                  {s.active ? (
                    <span className="inline-flex whitespace-nowrap rounded-full border border-status-success-border bg-status-success-bg px-2 py-0.5 text-xs font-medium text-status-success-text">
                      active
                    </span>
                  ) : (
                    <span className="inline-flex whitespace-nowrap rounded-full border border-border bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted">
                      inactive
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {run ? <StatusBadge status={run.status} /> : <span className="text-xs text-muted">chưa có run</span>}
                </td>
                <td className="px-3 py-2 font-mono tabular-nums whitespace-nowrap text-xs">{formatTimestamp(run?.startedAt)}</td>
                <td className="px-3 py-2 font-mono tabular-nums whitespace-nowrap text-xs">{formatTimestamp(run?.finishedAt)}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap text-xs">
                  {run ? run.rowsRead + " / " + run.rowsValid + " / " + run.rowsRejected : "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap text-xs">
                  {run ? run.rowsWarned + " / " + run.warningIssues : "—"}
                </td>
                <td className="px-3 py-2 font-mono tabular-nums whitespace-nowrap text-xs">{formatTimestamp(s.lastSuccessfulSyncAt)}</td>
                <td className="px-3 py-2 font-mono tabular-nums whitespace-nowrap text-xs">{formatTimestamp(s.lastSeenAt)}</td>
                <td className="px-3 py-2">
                  {run?.errorCode ? (
                    <span className="font-mono text-xs text-status-danger-text">{run.errorCode}</span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
