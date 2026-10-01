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
  "h-9 w-full rounded-lg border border-slate-300 bg-white px-2.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-50 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30";

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="font-medium text-slate-600 dark:text-slate-400">{label}</span>
      {children}
    </label>
  );
}

export function DashboardFilters({ options }: { options: ReportingOptionsCatalog }) {
  const [filters, setFilters] = useQueryStates(parsers, { shallow: false });
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const now = new Date();
  const presets = computeDatePresets(now);
  const activePresetKey = matchDatePreset(filters.from, filters.to, now);
  const allTime = isAllTimeActive(filters.from, filters.to);
  const activeCount = countActiveFilterCriteria(filters);
  const countLabel = activeCount === 1 ? "1 tiêu chí đang áp dụng" : activeCount + " tiêu chí đang áp dụng";

  const chip = (active: boolean) =>
    cn(
      "inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40",
      active
        ? "border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500"
        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800"
    );

  return (
    <section aria-label="Bộ lọc báo cáo" className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Bộ lọc</h2>
          <span className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200">{countLabel}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" aria-expanded={advancedOpen} aria-controls="advanced-filters" onClick={() => setAdvancedOpen((o) => !o)} className="inline-flex h-8 items-center rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
            <span aria-hidden className="mr-1">{advancedOpen ? "▾" : "▸"}</span>
            Bộ lọc nâng cao
          </button>
          {activeCount > 0 ? (
            <button type="button" onClick={() => setFilters(null)} className="inline-flex h-8 items-center rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
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

      <div id="advanced-filters" hidden={!advancedOpen} className="mt-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          <Field id="f-recruiter" label="Người tuyển">
            <select id="f-recruiter" className={inputClass} value={filters.recruiter ?? ""} onChange={(e) => setFilters({ recruiter: e.target.value || null })}>
              <option value="">Tất cả người tuyển</option>
              {options.dimensions.recruiters.map((o) => <option key={o.key} value={o.key}>{o.display}</option>)}
            </select>
          </Field>
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
          <Field id="f-source" label="Nguồn">
            <select id="f-source" className={inputClass} value={filters.source ?? ""} onChange={(e) => setFilters({ source: e.target.value || null })}>
              <option value="">Tất cả nguồn</option>
              {options.sources.map((o) => <option key={o.id} value={o.id}>{o.fileName}</option>)}
            </select>
          </Field>
        </div>
      </div>
    </section>
  );
}
