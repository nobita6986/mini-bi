import { slotToCssVar } from "@/lib/theme/theme-registry";
import { buildProjectMixRows, mixMajorityLabel, PROJECT_MIX_TOP } from "@/lib/reporting/p1-chart-data";
import type { ProjectMixRow } from "@/lib/reporting/p1-chart-data";
import type { ProjectProviderMix } from "@/lib/reporting/p1-reporting";

function pctText(share: number | null): string {
  return share === null ? "—" : Math.round(share * 100) + "%";
}

function MixBar({ row }: { row: ProjectMixRow }) {
  const visible = row.segments.filter((s) => s.value > 0);
  const label = row.display + ": " + visible.map((s) => s.label + " " + s.value + " người").join(", ");
  return (
    <div role="img" aria-label={label} className="flex h-5 w-full overflow-hidden rounded-full border border-border bg-muted/15">
      {visible.map((s) => (
        <div
          key={s.label}
          style={{ width: s.percent + "%", background: slotToCssVar(s.slot) }}
          className="h-full"
          title={s.label + ": " + s.value + " người (" + Math.round(s.percent) + "%)"}
        />
      ))}
    </div>
  );
}

function Legend({ slots }: { slots: { slot: ProjectMixRow["segments"][number]["slot"]; label: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {slots.map((s) => (
        <li key={s.label} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10" style={{ background: slotToCssVar(s.slot) }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

export function ProjectProviderMixCard({ mix, providerFilterActive }: { mix: ProjectProviderMix[]; providerFilterActive: boolean }) {
  const rows = buildProjectMixRows(mix);
  const top = rows.slice(0, PROJECT_MIX_TOP);
  const rest = rows.slice(PROJECT_MIX_TOP);
  const unclassifiedTotal = rows.reduce((a, r) => a + r.unclassified, 0);
  const projectTotalSum = rows.reduce((a, r) => a + r.projectTotal, 0);
  const knownTotalSum = rows.reduce((a, r) => a + r.knownTotal, 0);

  if (rows.length === 0) {
    return <p className="text-sm text-muted">Chưa có dự án nào trong bộ lọc hiện tại.</p>;
  }

  const legend = rows[0].segments.map((s) => ({ slot: s.slot, label: s.label }));

  return (
    <div className="space-y-3">
      <Legend slots={legend} />

      {providerFilterActive ? (
        <p className="rounded-lg border border-border bg-muted/10 px-3 py-2 text-xs text-muted">
          Cơ cấu này đang phản ánh bộ lọc HRP/Vendor hiện tại. Bỏ bộ lọc HRP/Vendor để so sánh đầy đủ.
        </p>
      ) : null}

      {unclassifiedTotal > 0 ? (
        <p className="rounded-lg border border-border bg-muted/10 px-3 py-2 text-xs text-foreground">
          {unclassifiedTotal} người chưa được phân loại HRP/Vendor (đã tách khỏi mẫu số tỷ lệ).
        </p>
      ) : null}

      <p className="text-xs text-muted">
        Tổng {projectTotalSum} người · đã phân loại HRP/Vendor {knownTotalSum} người ({pctText(projectTotalSum > 0 ? knownTotalSum / projectTotalSum : null)}).
      </p>

      <ul className="space-y-2">
        {top.map((r) => (
          <li key={r.key} className="grid grid-cols-1 gap-1 md:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,14rem)] md:items-center md:gap-3">
            <div className="min-w-0 truncate text-sm text-foreground" title={r.display}>
              {r.display}
            </div>
            <MixBar row={r} />
            <div className="text-xs md:text-right">
              <p className="font-medium text-foreground">
                {r.knownTotal === 0
                  ? "Không đủ dữ liệu phân loại"
                  : "Vendor " + pctText(r.vendorShare) + " · " + r.vendorCount + "/" + r.knownTotal + " người"}
              </p>
              <p className="text-muted">
                tổng {r.projectTotal} người · phân loại {pctText(r.knownCoverage)}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {rest.length > 0 ? (
        <p className="text-xs text-muted">Còn {rest.length} dự án khác trong “Xem chi tiết tất cả”.</p>
      ) : null}

      <details className="mt-1">
        <summary className="cursor-pointer text-sm font-medium text-primary">
          Xem chi tiết tất cả ({rows.length})
        </summary>
        <div className="mt-2 max-h-80 overflow-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">Tỷ lệ HRP/Vendor theo từng dự án (đầy đủ)</caption>
            <thead className="sticky top-0 bg-surface text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-border">
                <th className="py-1.5 pr-3 font-medium">Dự án</th>
                <th className="py-1.5 pr-3 text-right font-medium">Tổng</th>
                <th className="py-1.5 pr-3 text-right font-medium">HRP</th>
                <th className="py-1.5 pr-3 text-right font-medium">Vendor</th>
                <th className="py-1.5 pr-3 text-right font-medium">Không xác định</th>
                <th className="py-1.5 pr-3 text-right font-medium">Không hợp lệ</th>
                <th className="py-1.5 pr-3 text-right font-medium">Đã phân loại</th>
                <th className="py-1.5 font-medium">Nhận xét</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.key} className="text-foreground">
                  <td className="py-1.5 pr-3">
                    <span className="block max-w-[16rem] truncate" title={r.display}>{r.display}</span>
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono">{r.projectTotal}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{r.hrpCount} · {pctText(r.hrpShare)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{r.vendorCount} · {pctText(r.vendorShare)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{r.unknownCount}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{r.invalidCount}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{pctText(r.knownCoverage)}</td>
                  <td className="py-1.5 text-xs text-muted">{mixMajorityLabel(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
