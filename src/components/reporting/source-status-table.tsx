import { formatTimestamp, shortenId } from "@/lib/format";
import type { SourceStatus } from "@/lib/reporting/pipeline-check";

import { StatusBadge } from "./status-badge";

export function SourceStatusTable({ sources }: { sources: SourceStatus[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full min-w-[980px] text-left text-sm">
        <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
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
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {sources.map((s) => {
            const run = s.latestRun;
            return (
              <tr key={s.id} className="align-top text-zinc-700 dark:text-zinc-200">
                <td className="px-3 py-2">
                  <div className="font-medium text-zinc-900 dark:text-zinc-50">{s.fileName}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">{s.sheetName}</div>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-500 dark:text-zinc-400" title={s.driveFileId}>
                  {shortenId(s.driveFileId)}
                </td>
                <td className="px-3 py-2">
                  {s.active ? (
                    <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                      active
                    </span>
                  ) : (
                    <span className="inline-flex rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      inactive
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {run ? <StatusBadge status={run.status} /> : <span className="text-xs text-zinc-400">chưa có run</span>}
                </td>
                <td className="px-3 py-2 text-xs">{formatTimestamp(run?.startedAt)}</td>
                <td className="px-3 py-2 text-xs">{formatTimestamp(run?.finishedAt)}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {run ? run.rowsRead + " / " + run.rowsValid + " / " + run.rowsRejected : "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {run ? run.rowsWarned + " / " + run.warningIssues : "—"}
                </td>
                <td className="px-3 py-2 text-xs">{formatTimestamp(s.lastSuccessfulSyncAt)}</td>
                <td className="px-3 py-2 text-xs">{formatTimestamp(s.lastSeenAt)}</td>
                <td className="px-3 py-2">
                  {run?.errorCode ? (
                    <span className="font-mono text-xs text-red-600 dark:text-red-400">{run.errorCode}</span>
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
