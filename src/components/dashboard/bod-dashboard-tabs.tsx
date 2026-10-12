"use client";

import { useEffect, useRef, useTransition, type KeyboardEvent, type ReactNode } from "react";
import { parseAsString, useQueryStates } from "nuqs";

import type { ReportingData } from "@/lib/reporting/p1-reporting";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";
import { TeamReportingPanel } from "./team-reporting-panel";

const queryParsers = {
  tab: parseAsString,
  source: parseAsString,
};

const tabs = [
  { key: "general", label: "Báo cáo tổng quát", panelId: "bod-panel-general" },
  { key: "team", label: "Báo cáo theo nhóm", panelId: "bod-panel-team" },
] as const;

type TabKey = (typeof tabs)[number]["key"];

export function BodDashboardTabs({
  general,
  data,
  optionsResult,
}: {
  general: ReactNode;
  data: ReportingData;
  optionsResult: ReportingOptionsResult;
}) {
  const [{ tab: rawTab, source }, setQuery] = useQueryStates(queryParsers, {
    history: "push",
    shallow: false,
    scroll: false,
  });
  const [isPending, startTransition] = useTransition();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeTab: TabKey = rawTab === "team" ? "team" : "general";

  useEffect(() => {
    if (rawTab !== null && rawTab !== "general" && rawTab !== "team") {
      void setQuery({ tab: "general" });
    }
  }, [rawTab, setQuery]);

  function selectTab(next: TabKey): void {
    startTransition(() => {
      void setQuery({ tab: next, source: next === "team" ? null : source });
    });
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    selectTab(tabs[next].key);
    requestAnimationFrame(() => tabRefs.current[next]?.focus());
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-4 sm:px-6" aria-busy={isPending}>
      <div role="tablist" aria-label="Báo cáo BoD" className="flex flex-wrap gap-2 border-b border-border">
        {tabs.map((tab, index) => (
          <button
            key={tab.key}
            ref={(element) => { tabRefs.current[index] = element; }}
            type="button"
            role="tab"
            id={`bod-tab-${tab.key}`}
            aria-selected={activeTab === tab.key}
            aria-controls={tab.panelId}
            tabIndex={activeTab === tab.key ? 0 : -1}
            onClick={() => selectTab(tab.key)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            className={`min-h-11 border-b-2 px-3 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${activeTab === tab.key
              ? "border-primary text-primary"
              : "border-transparent text-muted hover:text-foreground"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "general" ? (
        <div id="bod-panel-general" role="tabpanel" aria-labelledby="bod-tab-general" tabIndex={0} className="pt-4">
          {general}
        </div>
      ) : (
        <div id="bod-panel-team" role="tabpanel" aria-labelledby="bod-tab-team" tabIndex={0} className="pt-4">
          <TeamReportingPanel data={data} optionsResult={optionsResult} />
        </div>
      )}
    </div>
  );
}
