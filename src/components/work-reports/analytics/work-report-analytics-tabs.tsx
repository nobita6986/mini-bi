"use client";

import { useState } from "react";
import { ReadableSubmissions } from "../reader/readable-submissions";
import { WorkReportAnalytics } from "./work-report-analytics";

const tabClass =
  "inline-flex min-h-11 items-center rounded-t-lg px-3.5 text-sm font-medium whitespace-nowrap " +
  "transition-[color,background-color,transform] duration-[var(--ui-motion-hover,160ms)] " +
  "ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring/40 active:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none";

export function WorkReportAnalyticsTabs({ canViewSubmissions }: { canViewSubmissions: boolean }) {
  const [tab, setTab] = useState<"submissions" | "summary">(canViewSubmissions ? "submissions" : "summary");
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Tổng hợp báo cáo" className="flex flex-wrap gap-1 border-b border-border">
        {canViewSubmissions ? (
          <button
            type="button"
            role="tab"
            id="analytics-tab-submissions"
            aria-selected={tab === "submissions"}
            aria-controls="analytics-panel-submissions"
            className={tabClass + (tab === "submissions"
              ? " border-b-2 border-primary bg-primary/5 text-foreground"
              : " text-muted hover:text-foreground")}
            onClick={() => setTab("submissions")}
          >
            Bài nộp
          </button>
        ) : null}
        <button
          type="button"
          role="tab"
          id="analytics-tab-summary"
          aria-selected={tab === "summary"}
          aria-controls="analytics-panel-summary"
          className={tabClass + (tab === "summary"
            ? " border-b-2 border-primary bg-primary/5 text-foreground"
            : " text-muted hover:text-foreground")}
          onClick={() => setTab("summary")}
        >
          Tổng hợp
        </button>
      </div>
      <div
        role="tabpanel"
        id={tab === "submissions" ? "analytics-panel-submissions" : "analytics-panel-summary"}
        aria-labelledby={tab === "submissions" ? "analytics-tab-submissions" : "analytics-tab-summary"}
      >
        {tab === "submissions" ? <ReadableSubmissions /> : <WorkReportAnalytics canViewSubmissions={canViewSubmissions} />}
      </div>
    </div>
  );
}
