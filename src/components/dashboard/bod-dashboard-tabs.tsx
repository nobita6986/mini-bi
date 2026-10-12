"use client";

import { useRef, useTransition, type KeyboardEvent, type ReactNode } from "react";
import { parseAsString, useQueryStates } from "nuqs";

import type { ReportingData } from "@/lib/reporting/p1-reporting";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";
import { DuplicateCccdReportPanel } from "@/components/reporting/duplicate-cccd-report-panel";
import { TeamReportingPanel } from "./team-reporting-panel";

const queryParsers = {
  tab: parseAsString,
  source: parseAsString,
};

type TabKey = "general" | "team" | "duplicate-cccd";

type TabDef = { key: TabKey; label: string; panelId: string };

/**
 * P3.1-HF-R3-R1: "Báo cáo CCCD trùng" is a sibling tab right after "Báo cáo theo nhóm".
 * It is only rendered when the server-derived `canViewDuplicateCccd` is true; the CCCD API/RPC
 * remains the real authority.
 */
const tabs: readonly TabDef[] = [
  { key: "general", label: "Báo cáo tổng quát", panelId: "bod-panel-general" },
  { key: "team", label: "Báo cáo theo nhóm", panelId: "bod-panel-team" },
  { key: "duplicate-cccd", label: "Báo cáo CCCD trùng", panelId: "bod-panel-duplicate-cccd" },
];

export function BodDashboardTabs({
  general,
  data,
  optionsResult,
  canViewDuplicateCccd,
}: {
  general: ReactNode;
  data: ReportingData;
  optionsResult: ReportingOptionsResult;
  canViewDuplicateCccd: boolean;
}) {
  const [{ tab: rawTab, source }, setQuery] = useQueryStates(queryParsers, {
    history: "push",
    shallow: true,
    scroll: false,
  });
  const [isPending, startTransition] = useTransition();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visibleTabs = tabs.filter(
    (tab) => tab.key !== "duplicate-cccd" || canViewDuplicateCccd,
  );
  const activeTab: TabKey =
    rawTab === "team"
      ? "team"
      : rawTab === "duplicate-cccd" && canViewDuplicateCccd
        ? "duplicate-cccd"
        : "general";

  function selectTab(next: TabKey): void {
    const needsAuthoritativeReload = next === "team" && source !== null;
    startTransition(() => {
      void setQuery(
        { tab: next, source: next === "general" ? source : null },
        { history: "push", shallow: !needsAuthoritativeReload, scroll: false },
      );
    });
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % visibleTabs.length;
    else if (event.key === "ArrowLeft") next = (index + visibleTabs.length - 1) % visibleTabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = visibleTabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    selectTab(visibleTabs[next].key);
    requestAnimationFrame(() => tabRefs.current[next]?.focus());
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-4 sm:px-6" aria-busy={isPending}>
      <div role="tablist" aria-label="Báo cáo BoD" className="flex flex-wrap gap-2 border-b border-border">
        {visibleTabs.map((tab, index) => (
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
      ) : activeTab === "team" ? (
        <div id="bod-panel-team" role="tabpanel" aria-labelledby="bod-tab-team" tabIndex={0} className="pt-4">
          <TeamReportingPanel data={data} optionsResult={optionsResult} />
        </div>
      ) : (
        <div id="bod-panel-duplicate-cccd" role="tabpanel" aria-labelledby="bod-tab-duplicate-cccd" tabIndex={0} className="pt-4">
          <DuplicateCccdReportPanel />
        </div>
      )}
    </div>
  );
}
