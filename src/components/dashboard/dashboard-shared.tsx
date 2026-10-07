import Link from "next/link";
import type { ReactNode } from "react";

import { Alert } from "@/components/ui/alert";
import { sortBuckets } from "@/lib/reporting/p1-dashboard";
import type { ReportingBucket } from "@/lib/reporting/p1-reporting";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";

import { DashboardFilters } from "./dashboard-filters";

/**
 * P3-W06C - shared dashboard pieces reused by the BoD / Team / Own views.
 * No audience decision lives here: callers pass only the scoped options they
 * already received from the DB-authoritative W05A read path.
 */

export function FiltersOrError({
  optionsResult,
  showRecruiter = true,
}: {
  optionsResult: ReportingOptionsResult;
  showRecruiter?: boolean;
}) {
  if (optionsResult.ok) {
    return <DashboardFilters options={optionsResult.options} showRecruiter={showRecruiter} />;
  }
  return (
    <Alert tone="error" title="Không tải được danh mục bộ lọc">
      <p>{optionsResult.code} · {optionsResult.message}</p>
      <p>Dữ liệu bên dưới vẫn đúng cho URL hiện tại, nhưng không thể chọn bộ lọc. Hãy thử tải lại trang.</p>
    </Alert>
  );
}

export function NoMatchesBlock({ detail }: { detail?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/10 px-6 py-12 text-center">
      <p className="text-sm font-medium text-foreground">Không có dữ liệu khớp bộ lọc hiện tại</p>
      <p className="mt-1 text-sm text-muted">
        {detail ?? "Không có ngày/dự án/người tuyển/nhóm nào khớp bộ lọc đang chọn."}
      </p>
      <p className="mt-4">
        <Link href="/dashboard" className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary/90">
          Xóa bộ lọc
        </Link>
      </p>
    </div>
  );
}

/**
 * Scope banner: makes the DB-authoritative audience visible on the page.
 */
export function ScopeNote({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p role="note" aria-label={label} className="rounded-2xl border border-border bg-muted/10 px-4 py-2 text-sm text-muted">
      {children}
    </p>
  );
}

/**
 * Collapsible full bucket list (shared by the scoped dashboards).
 */
export function BucketList({ buckets, label = "Xem danh sách đầy đủ" }: { buckets: Record<string, ReportingBucket>; label?: string }) {
  const sorted = sortBuckets(buckets);
  if (sorted.length === 0) return <p className="mt-2 text-sm text-muted">Chưa có dữ liệu cho mục này.</p>;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm font-medium text-primary">
        {label} ({sorted.length})
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
