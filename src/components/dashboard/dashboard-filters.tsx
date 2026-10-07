"use client";

import { useState, type ReactNode } from "react";
import { parseAsString, useQueryStates } from "nuqs";

import { EMPLOYMENT_OPTIONS, PROVIDER_OPTIONS } from "@/lib/reporting/p1-dashboard";
import type { ReportingOptionsCatalog } from "@/lib/reporting/p1-dashboard";
import { computeDatePresets, countActiveFilterCriteria, isAllTimeActive, matchDatePreset } from "@/lib/reporting/p1-date-presets";
import { cn } from "@/lib/utils";

const parsers = {
  from: parseAsString,
  to: parseAsString,
  project: parseAsString,
  recruiter: parseAsString,
  provider: parseAsString,
  employment: parseAsString,
  source: parseAsString,
};

const inputClass =
  "h-11 w-full rounded-lg border border-border bg-surface px-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30";

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

export function DashboardFilters({
  options,
  showRecruiter = true,
}: {
  options: ReportingOptionsCatalog;
  /** The own-scope dashboard hides the recruiter filter (scope is one person). */
  showRecruiter?: boolean;
}) {
  const [filters, setFilters] = useQueryStates(parsers, { shallow: false, scroll: false });
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const now = new Date();
  const presets = computeDatePresets(now);
  const activePresetKey = matchDatePreset(filters.from, filters.to, now);
  const allTime = isAllTimeActive(filters.from, filters.to);
  const activeCount = countActiveFilterCriteria(filters);
  const countLabel = activeCount === 1 ? "1 tiêu chí đang áp dụng" : activeCount + " tiêu chí đang áp dụng";

  const chip = (active: boolean) =>
    cn(
      "inline-flex h-11 shrink-0 items-center rounded-full border px-3 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
      active
        ? "border-primary bg-primary text-on-primary"
        : "border-border bg-surface text-foreground hover:bg-muted/10"
    );

  return (
    <>
      <section aria-label="Bộ lọc báo cáo" className="rounded-2xl border border-border bg-surface/90 p-3.5 shadow-sm md:sticky md:top-2 md:z-20 md:backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Bộ lọc</h2>
            <span className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">{countLabel}</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" aria-expanded={advancedOpen} aria-controls="advanced-filters" onClick={() => setAdvancedOpen((o) => !o)} className="inline-flex h-11 items-center rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
              <span aria-hidden className="mr-1">{advancedOpen ? "▾" : "▸"}</span>
              Bộ lọc nâng cao
            </button>
            {activeCount > 0 ? (
              <button type="button" onClick={() => setFilters(null)} className="inline-flex h-11 items-center rounded-lg bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring/40">
                Xóa bộ lọc
              </button>
            ) : null}
          </div>
        </div>

        <div role="group" aria-label="Khoảng thời gian nhanh" className="mt-2.5 flex gap-1.5 overflow-x-auto pb-1">
          {presets.map((p) => (
            <button key={p.key} type="button" aria-pressed={activePresetKey === p.key} onClick={() => setFilters({ from: p.from, to: p.to })} className={chip(activePresetKey === p.key)}>
              {p.label}
            </button>
          ))}
          <button type="button" aria-pressed={allTime} onClick={() => setFilters({ from: null, to: null })} className={chip(allTime)}>
            Tất cả thời gian
          </button>
        </div>
      </section>

      <div id="advanced-filters" hidden={!advancedOpen} className="mt-2 rounded-2xl border border-border bg-surface p-3.5 shadow-sm">
        <div className="grid max-h-[70vh] grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2 lg:grid-cols-4">
          <Field id="f-from" label="Từ ngày">
            <input id="f-from" type="date" className={inputClass} value={filters.from ?? ""} onChange={(e) => setFilters({ from: e.target.value || null })} />
          </Field>
          <Field id="f-to" label="Đến ngày">
            <input id="f-to" type="date" className={inputClass} value={filters.to ?? ""} onChange={(e) => setFilters({ to: e.target.value || null })} />
          </Field>
          <Field id="f-project" label="Dự án">
            <select id="f-project" className={inputClass} value={filters.project ?? ""} onChange={(e) => setFilters({ project: e.target.value || null })}>
              <option value="">Tất cả dự án</option>
              {options.dimensions.projects.map((o) => <option key={o.key} value={o.key}>{o.display}</option>)}
            </select>
          </Field>
          {showRecruiter ? (
            <Field id="f-recruiter" label="Người tuyển">
              <select id="f-recruiter" className={inputClass} value={filters.recruiter ?? ""} onChange={(e) => setFilters({ recruiter: e.target.value || null })}>
                <option value="">Tất cả người tuyển</option>
                {options.dimensions.recruiters.map((o) => <option key={o.key} value={o.key}>{o.display}</option>)}
              </select>
            </Field>
          ) : null}
          <Field id="f-provider" label="HRP/Vendor">
            <select id="f-provider" className={inputClass} value={filters.provider ?? ""} onChange={(e) => setFilters({ provider: e.target.value || null })}>
              <option value="">Tất cả</option>
              {PROVIDER_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.display}</option>)}
            </select>
          </Field>
          <Field id="f-employment" label="Loại hình làm việc">
            <select id="f-employment" className={inputClass} value={filters.employment ?? ""} onChange={(e) => setFilters({ employment: e.target.value || null })}>
              <option value="">Tất cả</option>
              {EMPLOYMENT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.display}</option>)}
            </select>
          </Field>
        </div>
      </div>
    </>
  );
}
