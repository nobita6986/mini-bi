"use client";

import type { ReactNode } from "react";
import { parseAsString, useQueryStates } from "nuqs";

import { EMPLOYMENT_OPTIONS, PROVIDER_OPTIONS } from "@/lib/reporting/p1-dashboard";
import type { ReportingOptionsCatalog } from "@/lib/reporting/p1-dashboard";

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
  "h-9 w-full rounded-md border border-zinc-300 bg-white px-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-400";

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

export function DashboardFilters({ options }: { options: ReportingOptionsCatalog }) {
  const [filters, setFilters] = useQueryStates(parsers, { shallow: false });

  const hasFilters = Boolean(
    filters.from || filters.to || filters.project || filters.recruiter || filters.provider || filters.employment || filters.source
  );

  return (
    <section aria-label="Bộ lọc báo cáo" className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
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
      {hasFilters ? (
        <div className="mt-3 flex justify-end">
          <button type="button" onClick={() => setFilters(null)} className="inline-flex h-9 items-center rounded-md border border-zinc-300 px-3 text-sm text-zinc-700 hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
            Xóa bộ lọc
          </button>
        </div>
      ) : null}
    </section>
  );
}
