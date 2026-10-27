"use client";

import { useMemo, useState, type ReactNode } from "react";
import { parseAsString, useQueryStates } from "nuqs";

import { CatalogFilterCombobox } from "@/components/ui/catalog-filter-combobox";
import { buildCompanyDisplayNames } from "@/lib/display/company-display-name";
import { EMPLOYMENT_OPTIONS, PROVIDER_OPTIONS, WORK_STATUS_OPTIONS } from "@/lib/reporting/p1-dashboard";
import type { ReportingOptionsCatalog } from "@/lib/reporting/p1-dashboard";
import {
  computeDatePresets,
  countActiveFilterCriteria,
  EXPLICIT_ALL_TIME_RANGE_PARAM,
  isAllTimeActive,
  matchDatePreset,
  resolveDashboardDateRange,
} from "@/lib/reporting/p1-date-presets";
import { cn } from "@/lib/utils";

const parsers = {
  from: parseAsString,
  to: parseAsString,
  range: parseAsString,
  project: parseAsString,
  recruiter: parseAsString,
  provider: parseAsString,
  employment: parseAsString,
  status: parseAsString,
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
  // P3-UI-COMPANY-DISPLAY-NAMES: danh sach chon hien thi ten gon; gia tri value
  // van la project key nen khong doi khoa lien ket hay ket qua loc.
  const projectDisplayNames = useMemo(
    () => buildCompanyDisplayNames(options.dimensions.projects.map((o) => ({ key: o.key, fullName: o.display }))),
    [options.dimensions.projects],
  );
  const projectFilterOptions = useMemo(
    () => options.dimensions.projects.map((o) => ({
      id: o.key,
      label: projectDisplayNames.get(o.key) ?? o.display,
      keywords: o.display,
    })),
    [options.dimensions.projects, projectDisplayNames],
  );
  const recruiterFilterOptions = useMemo(
    () => options.dimensions.recruiters.map((o) => ({ id: o.key, label: o.display, keywords: o.key })),
    [options.dimensions.recruiters],
  );
  const [filters, setFilters] = useQueryStates(parsers, { shallow: false, scroll: false });
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const now = new Date();
  const presets = computeDatePresets(now);
  const resolvedDate = resolveDashboardDateRange(
    { from: filters.from, to: filters.to, range: filters.range },
    now,
  );
  const effectiveFrom = resolvedDate.from;
  const effectiveTo = resolvedDate.to;
  const activePresetKey = matchDatePreset(effectiveFrom, effectiveTo, now);
  const allTime = isAllTimeActive(effectiveFrom, effectiveTo);
  const activeCount = countActiveFilterCriteria({
    ...filters,
    from: effectiveFrom,
    to: effectiveTo,
  });
  const countLabel = activeCount === 1 ? "1 tiêu chí đang áp dụng" : activeCount + " tiêu chí đang áp dụng";

  const chip = (active: boolean) =>
    cn(
      "inline-flex h-11 shrink-0 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-[180ms] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
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
            <button type="button" aria-expanded={advancedOpen} aria-controls="advanced-filters" onClick={() => setAdvancedOpen((o) => !o)} className="inline-flex h-11 items-center rounded-lg border border-border px-3 text-sm font-medium text-foreground transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none hover:bg-muted/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
              <span aria-hidden className="mr-1">{advancedOpen ? "▾" : "▸"}</span>
              Bộ lọc nâng cao
            </button>
            {activeCount > 0 || allTime ? (
              <button type="button" onClick={() => setFilters(null)} className="inline-flex h-11 items-center rounded-lg bg-primary px-3 text-sm font-medium text-on-primary transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring/40">
                Xóa bộ lọc
              </button>
            ) : null}
          </div>
        </div>

        <div role="group" aria-label="Khoảng thời gian nhanh" className="mt-2.5 flex gap-1.5 overflow-x-auto pb-1">
          {presets.map((p) => (
            <button key={p.key} type="button" aria-pressed={activePresetKey === p.key} onClick={() => setFilters({ from: p.from, to: p.to, range: null })} className={chip(activePresetKey === p.key)}>
              {p.label}
            </button>
          ))}
          <button type="button" aria-pressed={allTime} onClick={() => setFilters({ from: null, to: null, range: EXPLICIT_ALL_TIME_RANGE_PARAM })} className={chip(allTime)}>
            Tất cả thời gian
          </button>
        </div>
      </section>

      <div id="advanced-filters" hidden={!advancedOpen} data-ui-panel-motion="true" className="mt-2 rounded-2xl border border-border bg-surface p-3.5 shadow-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="f-from" label="Từ ngày">
            <input
              id="f-from"
              type="date"
              className={inputClass}
              value={effectiveFrom ?? ""}
              onChange={(e) => {
                const nextFrom = e.target.value || null;
                const nextTo = effectiveTo;
                setFilters({
                  from: nextFrom,
                  to: nextTo,
                  range: nextFrom === null && nextTo === null ? EXPLICIT_ALL_TIME_RANGE_PARAM : null,
                });
              }}
            />
          </Field>
          <Field id="f-to" label="Đến ngày">
            <input
              id="f-to"
              type="date"
              className={inputClass}
              value={effectiveTo ?? ""}
              onChange={(e) => {
                const nextFrom = effectiveFrom;
                const nextTo = e.target.value || null;
                setFilters({
                  from: nextFrom,
                  to: nextTo,
                  range: nextFrom === null && nextTo === null ? EXPLICIT_ALL_TIME_RANGE_PARAM : null,
                });
              }}
            />
          </Field>
          <CatalogFilterCombobox
            id="f-project"
            label="Dự án"
            allLabel="Tất cả dự án"
            placeholder="Gõ tên dự án để tìm"
            options={projectFilterOptions}
            value={filters.project ?? ""}
            onChange={(value) => setFilters({ project: value || null })}
          />
          {showRecruiter ? (
            <CatalogFilterCombobox
              id="f-recruiter"
              label="Người tuyển"
              allLabel="Tất cả người tuyển"
              placeholder="Gõ tên người tuyển để tìm"
              options={recruiterFilterOptions}
              value={filters.recruiter ?? ""}
              onChange={(value) => setFilters({ recruiter: value || null })}
            />
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
          <Field id="f-status" label="Trạng thái làm việc (tính đến ngày cuối kỳ)">
            <select id="f-status" className={inputClass} value={filters.status ?? ""} onChange={(e) => setFilters({ status: e.target.value || null })}>
              <option value="">Tất cả trạng thái</option>
              {WORK_STATUS_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.display}</option>)}
            </select>
          </Field>
        </div>
      </div>
    </>
  );
}
