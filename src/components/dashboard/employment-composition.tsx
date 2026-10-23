"use client";

import { useMemo } from "react";

import { slotToCssVar } from "@/lib/theme/theme-registry";
import type { ChartSegment } from "@/lib/reporting/p1-chart-data";
import { BiClearHighlightButton, useBiHighlight } from "./bi-cross-highlight";

export function EmploymentComposition({ segments, title }: { segments: ChartSegment[]; title: string }) {
  const segmentKeys = useMemo(() => segments.map((s) => s.key), [segments]);
  const highlight = useBiHighlight(segmentKeys);

  return (
    <div>
      <div role="img" aria-label={title} className="flex h-7 w-full overflow-hidden rounded-full border border-border">
        {segments.filter((s) => s.value > 0).map((s) => {
          const isHighlighted = highlight.activeKey === s.key;
          const isDimmed = highlight.activeKey !== null && !isHighlighted;
          return (
            <div
              key={s.key}
              onMouseEnter={() => highlight.onHover(s.key)}
              onMouseLeave={() => highlight.onHover(null)}
              onClick={() => highlight.onTogglePin(s.key)}
              style={{
                width: s.percent + "%",
                background: slotToCssVar(s.color),
                opacity: isDimmed ? 0.32 : 1,
              }}
              className="h-full cursor-pointer transition-opacity duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none"
              title={s.display + ": " + s.value + " người (" + Math.round(s.percent) + "%)"}
            />
          );
        })}
      </div>
      <ul className="mt-3 space-y-1">
        {segments.map((s) => {
          const isHighlighted = highlight.activeKey === s.key;
          const isPinned = highlight.pinnedKey === s.key;
          return (
            <li key={s.key} data-bi-highlighted={isHighlighted ? "true" : undefined}>
              <button
                type="button"
                aria-pressed={isPinned}
                onMouseEnter={() => highlight.onHover(s.key)}
                onMouseLeave={() => highlight.onHover(null)}
                onFocus={() => highlight.onFocus(s.key)}
                onBlur={() => highlight.onFocus(null)}
                onClick={() => highlight.onTogglePin(s.key)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") highlight.onClear();
                }}
                className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                  isHighlighted
                    ? "bg-primary/10 font-medium text-foreground ring-1 ring-primary/30"
                    : "text-foreground hover:bg-surface-hover"
                }`}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: slotToCssVar(s.color) }} />
                <span className="truncate">{s.display}</span>
                <span className="ml-auto font-mono tabular-nums">{s.value}</span>
                <span className="w-12 shrink-0 text-right font-mono tabular-nums text-xs text-muted">
                  {Math.round(s.percent)}%
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <BiClearHighlightButton
        visible={highlight.pinnedKey !== null}
        onClear={highlight.onClear}
      />
    </div>
  );
}
