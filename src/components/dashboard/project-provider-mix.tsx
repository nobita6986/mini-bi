"use client";

import { useMemo } from "react";

import { slotToCssVar } from "@/lib/theme/theme-registry";
import { buildProjectMixRows, mixMajorityLabel, PROJECT_MIX_TOP } from "@/lib/reporting/p1-chart-data";
import type { ProjectMixRow } from "@/lib/reporting/p1-chart-data";
import type { ProjectProviderMix } from "@/lib/reporting/p1-reporting";
import { BiClearHighlightButton, useBiHighlight } from "./bi-cross-highlight";

function pctText(share: number | null): string {
  return share === null ? "—" : Math.round(share * 100) + "%";
}

function MixBar({
  row,
  activeSlotLabel,
}: {
  row: ProjectMixRow;
  activeSlotLabel: string | null;
}) {
  const visible = row.segments.filter((s) => s.value > 0);
  const label = row.display + ": " + visible.map((s) => s.label + " " + s.value + " người").join(", ");
  return (
    <div role="img" aria-label={label} className="flex h-5 w-full overflow-hidden rounded-full border border-border bg-muted/15">
      {visible.map((s) => {
        const isSlotDimmed = activeSlotLabel !== null && activeSlotLabel !== s.label;
        return (
          <div
            key={s.label}
            style={{
              width: s.percent + "%",
              background: slotToCssVar(s.slot),
              opacity: isSlotDimmed ? 0.28 : 1,
            }}
            className="h-full transition-opacity duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none"
            title={s.label + ": " + s.value + " người (" + Math.round(s.percent) + "%)"}
          />
        );
      })}
    </div>
  );
}

function Legend({
  slots,
  activeLabel,
  pinnedLabel,
  onHover,
  onFocus,
  onTogglePin,
  onClear,
}: {
  slots: { slot: ProjectMixRow["segments"][number]["slot"]; label: string }[];
  activeLabel: string | null;
  pinnedLabel: string | null;
  onHover: (label: string | null) => void;
  onFocus: (label: string | null) => void;
  onTogglePin: (label: string) => void;
  onClear: () => void;
}) {
  return (
    <ul className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted">
      {slots.map((s) => {
        const isHighlighted = activeLabel === s.label;
        const isPinned = pinnedLabel === s.label;
        return (
          <li key={s.label}>
            <button
              type="button"
              aria-pressed={isPinned}
              onMouseEnter={() => onHover(s.label)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onFocus(s.label)}
              onBlur={() => onFocus(null)}
              onClick={() => onTogglePin(s.label)}
              onKeyDown={(event) => {
                if (event.key === "Escape") onClear();
              }}
              className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                isHighlighted
                  ? "border-primary/40 bg-primary/10 font-medium text-foreground"
                  : "border-transparent text-muted hover:bg-surface-hover hover:text-foreground"
              }`}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10" style={{ background: slotToCssVar(s.slot) }} />
              {s.label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ProjectProviderMixCard({ mix, providerFilterActive }: { mix: ProjectProviderMix[]; providerFilterActive: boolean }) {
  const rows = useMemo(() => buildProjectMixRows(mix), [mix]);
  const rowKeys = useMemo(() => rows.map((r) => r.key), [rows]);
  const slotLabels = useMemo(
    () => (rows[0] ? rows[0].segments.map((s) => s.label) : []),
    [rows],
  );
  const slotHighlight = useBiHighlight(slotLabels);
  const rowHighlight = useBiHighlight(rowKeys);

  const top = rows.slice(0, PROJECT_MIX_TOP);
  const rest = rows.slice(PROJECT_MIX_TOP);
  const unclassifiedTotal = rows.reduce((a, r) => a + r.unclassified, 0);
  const projectTotalSum = rows.reduce((a, r) => a + r.projectTotal, 0);
  const knownTotalSum = rows.reduce((a, r) => a + r.knownTotal, 0);

  if (rows.length === 0) {
    return <p className="text-sm text-muted">Chưa có dự án nào trong bộ lọc hiện tại.</p>;
  }

  const legend = rows[0].segments.map((s) => ({ slot: s.slot, label: s.label }));
  const hasPinned = slotHighlight.pinnedKey !== null || rowHighlight.pinnedKey !== null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Legend
          slots={legend}
          activeLabel={slotHighlight.activeKey}
          pinnedLabel={slotHighlight.pinnedKey}
          onHover={slotHighlight.onHover}
          onFocus={slotHighlight.onFocus}
          onTogglePin={slotHighlight.onTogglePin}
          onClear={slotHighlight.onClear}
        />
        <BiClearHighlightButton
          visible={hasPinned}
          onClear={() => {
            slotHighlight.onClear();
            rowHighlight.onClear();
          }}
        />
      </div>

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
        {top.map((r) => {
          const isRowHighlighted = rowHighlight.activeKey === r.key;
          return (
            <li
              key={r.key}
              tabIndex={0}
              data-bi-highlighted={isRowHighlighted ? "true" : undefined}
              onMouseEnter={() => rowHighlight.onHover(r.key)}
              onMouseLeave={() => rowHighlight.onHover(null)}
              onFocus={() => rowHighlight.onFocus(r.key)}
              onBlur={() => rowHighlight.onFocus(null)}
              onClick={() => rowHighlight.onTogglePin(r.key)}
              onKeyDown={(event) => rowHighlight.handleKeyDown(event, r.key)}
              className={`grid cursor-pointer grid-cols-1 gap-1 rounded-lg px-2 py-1.5 transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,14rem)] md:items-center md:gap-3 ${
                isRowHighlighted
                  ? "bg-primary/10 ring-1 ring-primary/30"
                  : "hover:bg-surface-hover"
              }`}
            >
              <div className="min-w-0 truncate text-sm text-foreground" title={r.display}>
                {r.display}
              </div>
              <MixBar row={r} activeSlotLabel={slotHighlight.activeKey} />
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
          );
        })}
      </ul>

      {rest.length > 0 ? (
        <p className="text-xs text-muted">Còn {rest.length} dự án khác trong “Xem chi tiết tất cả”.</p>
      ) : null}

      <details className="mt-1">
        <summary className="cursor-pointer text-sm font-medium text-primary">
          Xem chi tiết tất cả ({rows.length})
        </summary>
        <div className="mt-2 max-h-80 overflow-auto rounded-xl border border-border bg-surface">
          <table className="r22-report-table w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">Tỷ lệ HRP/Vendor theo từng dự án (đầy đủ)</caption>
            <thead className="sticky top-0 bg-surface-muted text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-border">
                <th className="px-3 py-1.5 font-medium">Dự án</th>
                <th className="px-3 py-1.5 text-right font-medium">Tổng</th>
                <th className="px-3 py-1.5 text-right font-medium">HRP</th>
                <th className="px-3 py-1.5 text-right font-medium">Vendor</th>
                <th className="px-3 py-1.5 text-right font-medium">Không xác định</th>
                <th className="px-3 py-1.5 text-right font-medium">Không hợp lệ</th>
                <th className="px-3 py-1.5 text-right font-medium">Đã phân loại</th>
                <th className="px-3 py-1.5 font-medium">Nhận xét</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => {
                const isRowHighlighted = rowHighlight.activeKey === r.key;
                return (
                  <tr
                    key={r.key}
                    tabIndex={0}
                    data-bi-highlighted={isRowHighlighted ? "true" : undefined}
                    onMouseEnter={() => rowHighlight.onHover(r.key)}
                    onMouseLeave={() => rowHighlight.onHover(null)}
                    onFocus={() => rowHighlight.onFocus(r.key)}
                    onBlur={() => rowHighlight.onFocus(null)}
                    onClick={() => rowHighlight.onTogglePin(r.key)}
                    onKeyDown={(event) => rowHighlight.handleKeyDown(event, r.key)}
                    className={`cursor-pointer text-foreground transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 ${
                      isRowHighlighted
                        ? "bg-primary/10 font-medium"
                        : "hover:bg-surface-hover"
                    }`}
                  >
                    <td className="px-3 py-1.5">
                      <span className="block max-w-[16rem] truncate" title={r.display}>{r.display}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">{r.projectTotal}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">{r.hrpCount} · {pctText(r.hrpShare)}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">{r.vendorCount} · {pctText(r.vendorShare)}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">{r.unknownCount}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">{r.invalidCount}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">{pctText(r.knownCoverage)}</td>
                    <td className="px-3 py-1.5 text-xs text-muted">{mixMajorityLabel(r)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
