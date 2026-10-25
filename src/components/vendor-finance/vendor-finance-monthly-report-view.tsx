"use client";

import { Fragment, useEffect, useId, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Printer,
  RefreshCw,
  Settings2,
  X,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CursorLoadMore } from "@/components/ui/cursor-load-more";
import {
  DATA_TABLE_CLASS,
  DATA_TABLE_HEAD_CLASS,
  DATA_TABLE_ROW_CLASS,
  DATA_TABLE_TD_CLASS,
  DATA_TABLE_TH_CLASS,
  DataTableContainer,
  RowActionCluster,
} from "@/components/ui/data-table";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import type {
  VendorFinanceActorContextOptionsResponse,
  VendorFinanceEntryProjection,
  VendorFinanceMonthlyReportResponse,
  VendorFinanceMonthlyReportRow,
} from "@/lib/vendor-finance/vendor-finance-contract";
import {
  buildMonthlyReportUrl,
  buildVendorEntriesUrl,
  buildVendorFinanceContextUrl,
  classifyVendorFinanceError,
  ENTRY_TYPE_LABELS_VI,
  formatSignedVndDelta,
  formatVendorBalancePresentation,
  formatVietnamDateLabel,
  formatVndMinor,
  isCanonicalUiProjectId,
  isCanonicalUiVendorId,
  isUuidString,
  parseMonthlyReportEnvelope,
  parseVendorEntriesPageEnvelope,
  parseVendorFinanceContextEnvelope,
  PROJECT_REVENUE_MISSING_SOURCE_LABEL_VI,
  PROJECT_REVENUE_MISSING_SOURCE_NOTE_VI,
  validateUiCalendarMonth,
} from "@/lib/vendor-finance/ui-model";

type DrilldownState = {
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  entries: VendorFinanceEntryProjection[];
  nextCursor: string | null;
  hasMore: boolean;
};

function currentFallbackYearMonth(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function rowDrillKey(row: VendorFinanceMonthlyReportRow): string {
  return `${row.project_id}:${row.accountant_ref}:${row.vendor_id}`;
}

export function VendorFinanceMonthlyReportView({
  initialCanRecord = false,
  initialCanReconcile = false,
  initialCanManageProjectAssignments = false,
}: {
  initialCanRecord?: boolean;
  initialCanReconcile?: boolean;
  initialCanManageProjectAssignments?: boolean;
}) {
  const searchParams = useSearchParams();
  const monthInputId = useId();
  const projectSelectId = useId();
  const accountantSelectId = useId();
  const vendorSelectId = useId();

  const initialMonthParam = searchParams.get("month") ?? "";
  const initialProjectParam = searchParams.get("projectId") ?? "";
  const initialAccountantParam = searchParams.get("accountantRef") ?? "";
  const initialVendorParam = searchParams.get("vendorId") ?? "";

  const [month, setMonth] = useState<string>(() => {
    const check = validateUiCalendarMonth(initialMonthParam);
    return check.ok ? check.month : "";
  });
  const [projectFilter, setProjectFilter] = useState<string>(() =>
    isCanonicalUiProjectId(initialProjectParam) ? initialProjectParam : "",
  );
  const [accountantFilter, setAccountantFilter] = useState<string>(() =>
    isUuidString(initialAccountantParam) ? initialAccountantParam.toLowerCase() : "",
  );
  const [vendorFilter, setVendorFilter] = useState<string>(() =>
    isCanonicalUiVendorId(initialVendorParam) ? initialVendorParam : "",
  );
  const [reloadNonce, setReloadNonce] = useState(0);

  const [contextData, setContextData] =
    useState<VendorFinanceActorContextOptionsResponse | null>(null);
  const [reportData, setReportData] = useState<VendorFinanceMonthlyReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [drilldowns, setDrilldowns] = useState<Record<string, DrilldownState>>({});

  // 1. Load context options & resolve authoritative default month
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadContext() {
      await Promise.resolve();
      if (cancelled) return;
      try {
        const res = await fetch(buildVendorFinanceContextUrl(), {
          method: "GET",
          signal: controller.signal,
          cache: "no-store",
        });
        const json: unknown = await res.json().catch(() => null);
        if (cancelled) return;
        const parsed = parseVendorFinanceContextEnvelope(json);
        if (parsed) {
          setContextData(parsed);
          setMonth((prev) => prev || parsed.authorization_date.slice(0, 7));
          return;
        }
      } catch {
        if (cancelled) return;
      }
      setMonth((prev) => prev || currentFallbackYearMonth());
    }

    void loadContext();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadNonce]);

  // 2. Load Monthly Debt Report
  useEffect(() => {
    if (!month) return;
    const monthCheck = validateUiCalendarMonth(month);
    let cancelled = false;
    const controller = new AbortController();

    async function fetchReport() {
      await Promise.resolve();
      if (cancelled) return;

      if (!monthCheck.ok) {
        setErrorMsg(monthCheck.message);
        setLoading(false);
        return;
      }

      setLoading(true);
      setErrorMsg(null);
      setExpandedKey(null);
      setDrilldowns({});

      try {
        const url = buildMonthlyReportUrl({
          month: monthCheck.month,
          project_id: projectFilter || null,
          accountant_ref: accountantFilter || null,
          vendor_id: vendorFilter || null,
        });
        const res = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          cache: "no-store",
        });
        const json: unknown = await res.json().catch(() => null);
        if (cancelled) return;

        if (!res.ok) {
          const classified = classifyVendorFinanceError(json, res.status);
          setErrorMsg(classified.message);
          setLoading(false);
          return;
        }

        const parsed = parseMonthlyReportEnvelope(json);
        if (!parsed) {
          setErrorMsg("Dữ liệu báo cáo công nợ tháng từ máy chủ không đúng chuẩn hợp đồng.");
          setLoading(false);
          return;
        }

        setReportData(parsed);
        setLoading(false);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setErrorMsg("Không thể tải báo cáo công nợ tháng do lỗi kết nối mạng.");
        setLoading(false);
      }
    }

    void fetchReport();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [month, projectFilter, accountantFilter, vendorFilter, reloadNonce]);

  const toggleRowDrilldown = async (row: VendorFinanceMonthlyReportRow) => {
    if (!reportData) return;
    const key = rowDrillKey(row);
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    if (drilldowns[key] && !drilldowns[key]!.error) {
      return;
    }

    setDrilldowns((prev) => ({
      ...prev,
      [key]: {
        loading: true,
        loadingMore: false,
        error: null,
        entries: [],
        nextCursor: null,
        hasMore: false,
      },
    }));

    try {
      const url = buildVendorEntriesUrl(row.vendor_id, {
        ledger_scope: "PROJECT_ACCOUNTANT",
        project_id: row.project_id,
        accountant_ref: row.accountant_ref,
        month: reportData.filters.month,
        page_size: 20,
      });
      const res = await fetch(url, { method: "GET", cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const classified = classifyVendorFinanceError(json, res.status);
        setDrilldowns((prev) => ({
          ...prev,
          [key]: {
            loading: false,
            loadingMore: false,
            error: classified.message,
            entries: [],
            nextCursor: null,
            hasMore: false,
          },
        }));
        return;
      }

      const parsed = parseVendorEntriesPageEnvelope(json);
      if (!parsed) {
        setDrilldowns((prev) => ({
          ...prev,
          [key]: {
            loading: false,
            loadingMore: false,
            error: "Dữ liệu chi tiết giao dịch trong tháng không hợp lệ.",
            entries: [],
            nextCursor: null,
            hasMore: false,
          },
        }));
        return;
      }

      setDrilldowns((prev) => ({
        ...prev,
        [key]: {
          loading: false,
          loadingMore: false,
          error: null,
          entries: [...parsed.entries],
          nextCursor: parsed.next_cursor,
          hasMore: parsed.has_more,
        },
      }));
    } catch {
      setDrilldowns((prev) => ({
        ...prev,
        [key]: {
          loading: false,
          loadingMore: false,
          error: "Không thể tải lịch sử giao dịch trong tháng do lỗi kết nối mạng.",
          entries: [],
          nextCursor: null,
          hasMore: false,
        },
      }));
    }
  };

  const loadMoreDrilldown = async (row: VendorFinanceMonthlyReportRow) => {
    if (!reportData) return;
    const key = rowDrillKey(row);
    const current = drilldowns[key];
    if (!current || !current.nextCursor || current.loadingMore) return;

    setDrilldowns((prev) => ({
      ...prev,
      [key]: { ...current, loadingMore: true, error: null },
    }));

    try {
      const url = buildVendorEntriesUrl(row.vendor_id, {
        cursor: current.nextCursor,
        ledger_scope: "PROJECT_ACCOUNTANT",
        project_id: row.project_id,
        accountant_ref: row.accountant_ref,
        month: reportData.filters.month,
        page_size: 20,
      });
      const res = await fetch(url, { method: "GET", cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const classified = classifyVendorFinanceError(json, res.status);
        setDrilldowns((prev) => ({
          ...prev,
          [key]: { ...current, loadingMore: false, error: classified.message },
        }));
        return;
      }
      const parsed = parseVendorEntriesPageEnvelope(json);
      if (!parsed) {
        setDrilldowns((prev) => ({
          ...prev,
          [key]: {
            ...current,
            loadingMore: false,
            error: "Phản hồi tải thêm giao dịch trong tháng không hợp lệ.",
          },
        }));
        return;
      }
      setDrilldowns((prev) => {
        const seen = new Set(current.entries.map((e) => e.entry_id));
        const merged = [...current.entries];
        for (const e of parsed.entries) {
          if (!seen.has(e.entry_id)) merged.push(e);
        }
        return {
          ...prev,
          [key]: {
            loading: false,
            loadingMore: false,
            error: null,
            entries: merged,
            nextCursor: parsed.next_cursor,
            hasMore: parsed.has_more,
          },
        };
      });
    } catch {
      setDrilldowns((prev) => ({
        ...prev,
        [key]: {
          ...current,
          loadingMore: false,
          error: "Mất kết nối mạng khi tải thêm giao dịch.",
        },
      }));
    }
  };

  // Vendor options come from the visible authority scope, not a manual project mapping.
  const vendorOptions = (() => {
    const map = new Map<string, string>();
    for (const vendor of contextData?.vendors ?? []) {
      if (!map.has(vendor.vendor_id)) {
        map.set(vendor.vendor_id, vendor.display_name);
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1], "vi"));
  })();

  const canRecord = reportData ? reportData.allowed_actions.can_record : initialCanRecord;
  const canReconcile = reportData ? reportData.allowed_actions.can_reconcile : initialCanReconcile;
  const canManage = reportData
    ? reportData.allowed_actions.can_manage_project_assignments
    : initialCanManageProjectAssignments;
  const totals = reportData?.totals ?? null;

  const hasSecondaryFilters =
    projectFilter !== "" || accountantFilter !== "" || vendorFilter !== "";

  return (
    <PageShell dataTestId="vfin-monthly-report-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/finance/vendors"
          className="inline-flex min-h-11 sm:min-h-8 items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Quay về danh sách Công nợ & Tạm ứng Vendor
        </Link>
        {canManage ? (
          <Link
            href="/finance/project-assignments"
            className={buttonClasses({ variant: "ghost", size: "sm" })}
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden />
            Phân công kế toán dự án & vai trò
          </Link>
        ) : null}
      </div>

      <PageHeader
        eyebrow="Báo cáo quản trị tài chính dự án"
        title="Báo cáo công nợ Vendor theo Dự án & Tháng"
        badge={
          <div className="flex flex-wrap items-center gap-2">
            {reportData?.allowed_actions.visibility_scope === "PROJECT_SCOPED" ? (
              <StatusBadge tone="primary">Phạm vi dự án phụ trách</StatusBadge>
            ) : (
              <StatusBadge tone="info">Phạm vi toàn cục</StatusBadge>
            )}
            {!canRecord ? (
              <StatusBadge tone="info">
                {canReconcile ? "Xem & Đối soát" : "Chế độ chỉ xem"}
              </StatusBadge>
            ) : null}
          </div>
        }
        description="Đối chiếu phát sinh nghĩa vụ phải trả, thanh toán/tạm ứng trong tháng và công nợ còn lại cuối tháng theo từng sổ Kế toán phụ trách × Dự án × Vendor (không bù trừ chéo)."
        actions={
          <Button
            variant="secondary"
            disabled={loading}
            onClick={() => setReloadNonce((n) => n + 1)}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Làm mới báo cáo
          </Button>
        }
      />

      {/* Explicit Canonical Project Revenue Disclosure */}
      <Alert
        tone="info"
        title={`Doanh thu dự án: ${PROJECT_REVENUE_MISSING_SOURCE_LABEL_VI}`}
      >
        <p data-testid="vfin-project-revenue-missing-note">
          {PROJECT_REVENUE_MISSING_SOURCE_NOTE_VI}
        </p>
      </Alert>

      {/* Non-Netted Monthly KPI Summary */}
      <section
        aria-label="Chỉ số tổng hợp công nợ tháng theo phạm vi lọc"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
        data-testid="vfin-monthly-kpis"
      >
        <Card className="p-4">
          <p className="text-xs font-medium text-muted">Doanh thu dự án trong tháng</p>
          <div className="mt-2">
            <StatusBadge tone="neutral" dataTestId="vfin-kpi-revenue-missing">
              {PROJECT_REVENUE_MISSING_SOURCE_LABEL_VI}
            </StatusBadge>
          </div>
          <p className="mt-1.5 text-xs text-muted">
            {totals
              ? `${totals.project_accountant_book_count} sổ dự án · ${totals.sub_ledger_count} dòng Vendor`
              : "Đang tải…"}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium text-muted">Tổng phải trả phát sinh trong tháng</p>
          <p
            data-testid="vfin-monthly-kpi-obligations"
            className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground"
          >
            {totals ? formatVndMinor(totals.obligations_in_month_minor) : "—"}
          </p>
          <p className="mt-1 text-xs text-muted">Công nợ, lương & điều chỉnh tăng trong tháng</p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium text-muted">Đã thanh toán & tạm ứng trong tháng</p>
          <p
            data-testid="vfin-monthly-kpi-paid-advanced"
            className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground"
          >
            {totals ? formatVndMinor(totals.paid_and_advanced_in_month_minor) : "—"}
          </p>
          <p className="mt-1 text-xs text-muted">
            {totals
              ? `TT: ${formatVndMinor(totals.paid_in_month_minor)} · Ứng: ${formatVndMinor(totals.advanced_in_month_minor)}`
              : "Đang tải…"}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium text-muted">
            Số dư cuối tháng (Tách riêng — không bù trừ)
          </p>
          <p
            data-testid="vfin-monthly-kpi-closing-payable"
            className="mt-1 font-mono text-base font-semibold tabular-nums text-foreground"
          >
            Còn nợ: {totals ? formatVndMinor(totals.closing_payable_minor) : "—"}
          </p>
          <p
            data-testid="vfin-monthly-kpi-closing-advance"
            className="mt-0.5 font-mono text-xs tabular-nums text-muted"
          >
            Dư ứng: {totals ? formatVndMinor(totals.closing_advance_minor) : "—"}
          </p>
        </Card>
      </section>

      {/* Filter Toolbar */}
      <FilterToolbar
        dataTestId="vfin-monthly-filter-toolbar"
        summary={
          <>
            <span aria-live="polite" className="font-mono tabular-nums">
              {loading
                ? "Đang tổng hợp báo cáo tháng…"
                : reportData
                  ? `Kỳ tháng ${reportData.filters.month}: ${reportData.project_accountant_summaries.length} sổ dự án · ${reportData.rows.length} dòng Vendor`
                  : "Chưa có dữ liệu"}
            </span>
            {reportData ? (
              <span>
                Ngày nghiệp vụ máy chủ: {formatVietnamDateLabel(reportData.authorization_date)}
              </span>
            ) : null}
          </>
        }
        actions={
          hasSecondaryFilters ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setProjectFilter("");
                setAccountantFilter("");
                setVendorFilter("");
              }}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Xóa lọc Dự án / Kế toán / Vendor
            </Button>
          ) : null
        }
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
          <div className="md:col-span-3 space-y-1">
            <label htmlFor={monthInputId} className="block text-xs font-medium text-muted">
              Tháng báo cáo (YYYY-MM)
            </label>
            <input
              id={monthInputId}
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>

          <div className="md:col-span-3 space-y-1">
            <label htmlFor={projectSelectId} className="block text-xs font-medium text-muted">
              Lọc theo Dự án
            </label>
            <select
              id={projectSelectId}
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <option value="">Tất cả dự án trong phạm vi</option>
              {(contextData?.projects ?? []).map((proj) => (
                <option key={proj.project_id} value={proj.project_id}>
                  {proj.display_name} ({proj.project_id})
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3 space-y-1">
            <label htmlFor={accountantSelectId} className="block text-xs font-medium text-muted">
              Lọc theo Kế toán phụ trách sổ
            </label>
            <select
              id={accountantSelectId}
              value={accountantFilter}
              onChange={(e) => setAccountantFilter(e.target.value)}
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <option value="">Tất cả kế toán phụ trách</option>
              {(contextData?.accountants ?? []).map((acc) => (
                <option key={acc.accountant_ref} value={acc.accountant_ref}>
                  {acc.display_name}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3 space-y-1">
            <label htmlFor={vendorSelectId} className="block text-xs font-medium text-muted">
              Lọc theo Vendor
            </label>
            <select
              id={vendorSelectId}
              value={vendorFilter}
              onChange={(e) => setVendorFilter(e.target.value)}
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <option value="">Tất cả Vendor</option>
              {vendorOptions.map(([vId, vName]) => (
                <option key={vId} value={vId}>
                  {vName} ({vId})
                </option>
              ))}
            </select>
          </div>
        </div>
      </FilterToolbar>

      {/* Main Content */}
      {errorMsg ? (
        <div className="space-y-3">
          <Alert tone="error" role="alert" title="Không thể tải báo cáo công nợ tháng">
            <p>{errorMsg}</p>
          </Alert>
          <Button variant="primary" onClick={() => setReloadNonce((n) => n + 1)}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Thử lại
          </Button>
        </div>
      ) : loading && !reportData ? (
        <Card className="p-8 text-center">
          <p role="status" aria-live="polite" className="text-sm text-muted">
            Đang tổng hợp số liệu sổ dự án trong tháng…
          </p>
        </Card>
      ) : reportData ? (
        <div className="space-y-6">
          {/* =================================================================
              SECTION 1: SUMMARY BY (ACCOUNTANT x PROJECT) BOOK
             ================================================================= */}
          <section className="space-y-2.5" aria-label="Tổng hợp theo sổ Kế toán phụ trách × Dự án">
            <h2 className="text-base font-semibold text-foreground">
              1. Tổng hợp theo sổ Kế toán phụ trách × Dự án
            </h2>

            {reportData.project_accountant_summaries.length === 0 ? (
              <Card className="p-6 text-center text-sm text-muted">
                Chưa có sổ dự án nào phát sinh hoặc liên kết khớp với bộ lọc hiện tại.
              </Card>
            ) : (
              <DataTableContainer dataTestId="vfin-monthly-book-summary-table">
                <table className={DATA_TABLE_CLASS}>
                  <thead className={DATA_TABLE_HEAD_CLASS}>
                    <tr>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Dự án
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Kế toán phụ trách sổ
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Doanh thu dự án
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Phát sinh trong tháng
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Đã TT & tạm ứng trong tháng
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Còn phải trả cuối tháng
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Dư ứng cuối tháng
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportData.project_accountant_summaries.map((sum) => (
                      <tr
                        key={`${sum.project_id}:${sum.accountant_ref}`}
                        className={DATA_TABLE_ROW_CLASS}
                      >
                        <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                          <div className="space-y-0.5">
                            <p className="font-semibold text-foreground">
                              {sum.project_display_name}
                            </p>
                            <p className="font-mono text-xs text-muted">
                              {sum.project_id} · {sum.vendor_count} Vendor
                            </p>
                          </div>
                        </td>
                        <td data-label="Kế toán phụ trách" className={DATA_TABLE_TD_CLASS}>
                          <div className="space-y-0.5">
                            <p className="font-medium text-foreground">
                              {sum.responsible_accountant_display_name}
                            </p>
                            <StatusBadge tone={sum.is_currently_assigned ? "success" : "neutral"}>
                              {sum.is_currently_assigned ? "Đang phụ trách" : "Sổ kỳ trước"}
                            </StatusBadge>
                          </div>
                        </td>
                        <td data-label="Doanh thu dự án" className={DATA_TABLE_TD_CLASS}>
                          <StatusBadge tone="neutral">
                            {PROJECT_REVENUE_MISSING_SOURCE_LABEL_VI}
                          </StatusBadge>
                        </td>
                        <td
                          data-label="Phát sinh tháng"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                        >
                          {formatVndMinor(sum.obligations_in_month_minor)}
                        </td>
                        <td
                          data-label="Đã TT & Ứng"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                        >
                          {formatVndMinor(sum.paid_and_advanced_in_month_minor)}
                        </td>
                        <td
                          data-label="Còn phải trả"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono font-semibold tabular-nums`}
                        >
                          {formatVndMinor(sum.closing_payable_minor)}
                        </td>
                        <td
                          data-label="Dư ứng"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                        >
                          {formatVndMinor(sum.closing_advance_minor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTableContainer>
            )}
          </section>

          {/* =================================================================
              SECTION 2: DETAIL BY (PROJECT x ACCOUNTANT x VENDOR) WITH DRILL-DOWN
             ================================================================= */}
          <section
            className="space-y-2.5"
            aria-label="Chi tiết theo từng Vendor trong từng dự án và kế toán phụ trách"
          >
            <h2 className="text-base font-semibold text-foreground">
              2. Chi tiết công nợ theo Dự án × Kế toán phụ trách × Vendor
            </h2>

            {reportData.rows.length === 0 ? (
              <Card className="p-6 text-center text-sm text-muted">
                Chưa có dòng sổ chi tiết Vendor nào trong kỳ tháng này.
              </Card>
            ) : (
              <DataTableContainer dataTestId="vfin-monthly-vendor-breakdown-table">
                <table className={DATA_TABLE_CLASS}>
                  <thead className={DATA_TABLE_HEAD_CLASS}>
                    <tr>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Dự án & Kế toán sổ
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Vendor
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Đầu tháng
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Phát sinh tháng (+)
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        TT & Tạm ứng tháng (-)
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Cuối tháng (Không bù trừ)
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Lịch sử GD
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportData.rows.map((row) => {
                      const dKey = rowDrillKey(row);
                      const isExpanded = expandedKey === dKey;
                      const drill = drilldowns[dKey];
                      const closingInfo = formatVendorBalancePresentation({
                        current_balance_minor: row.closing_balance_minor,
                        balance_direction: row.closing_direction,
                        entry_count: row.total_entry_count,
                        has_opening_entry: row.opening_payable_in_month_minor !== "0" || row.opening_advance_in_month_minor !== "0",
                      });
                      const subLedgerDetailHref = `/finance/vendors/${encodeURIComponent(row.vendor_id)}?ledgerScope=PROJECT_ACCOUNTANT&projectId=${encodeURIComponent(row.project_id)}&accountantRef=${encodeURIComponent(row.accountant_ref)}`;

                      return (
                        <Fragment key={dKey}>
                          <tr className={DATA_TABLE_ROW_CLASS}>
                            <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                              <div className="space-y-0.5">
                                <p className="font-semibold text-foreground">
                                  {row.project_display_name}
                                </p>
                                <p className="text-xs text-muted">
                                  KT: <strong className="text-foreground">{row.responsible_accountant_display_name}</strong>
                                </p>
                              </div>
                            </td>

                            <td data-label="Vendor" className={DATA_TABLE_TD_CLASS}>
                              <div className="space-y-0.5">
                                <Link
                                  href={subLedgerDetailHref}
                                  className="font-semibold text-primary hover:underline"
                                >
                                  {row.vendor_display_name}
                                </Link>
                                <p className="font-mono text-xs text-muted">{row.vendor_id}</p>
                              </div>
                            </td>

                            <td
                              data-label="Đầu tháng"
                              className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                            >
                              {formatSignedVndDelta(row.balance_before_month_minor)}
                            </td>

                            <td
                              data-label="Phát sinh tháng"
                              className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                            >
                              {formatVndMinor(row.obligations_in_month_minor)}
                            </td>

                            <td
                              data-label="TT & Tạm ứng tháng"
                              className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                            >
                              <div className="space-y-0.5">
                                <p>{formatVndMinor(row.paid_and_advanced_in_month_minor)}</p>
                                <p className="text-[11px] text-muted">
                                  TT: {formatVndMinor(row.paid_in_month_minor)} · Ứng:{" "}
                                  {formatVndMinor(row.advanced_in_month_minor)}
                                </p>
                              </div>
                            </td>

                            <td
                              data-label="Cuối tháng"
                              className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                            >
                              <div className="inline-flex flex-col items-end gap-1">
                                <span className="font-semibold text-foreground">
                                  {closingInfo.signedText}
                                </span>
                                <StatusBadge tone={closingInfo.tone}>
                                  {row.closing_direction === "PAYABLE"
                                    ? "Còn phải trả"
                                    : row.closing_direction === "ADVANCE"
                                      ? "Đang dư ứng"
                                      : "Cân bằng (0 ₫)"}
                                </StatusBadge>
                              </div>
                            </td>

                            <td
                              data-card-actions="true"
                              className={`${DATA_TABLE_TD_CLASS} text-right`}
                            >
                              <RowActionCluster>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  aria-expanded={isExpanded}
                                  data-testid="vfin-monthly-drilldown-btn"
                                  onClick={() => void toggleRowDrilldown(row)}
                                >
                                  {isExpanded ? (
                                    <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                                  ) : (
                                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                                  )}
                                  GD tháng ({row.in_month_entry_count})
                                </Button>
                                <Link
                                  href={subLedgerDetailHref}
                                  className={buttonClasses({ variant: "ghost", size: "sm" })}
                                >
                                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                                  Mở sổ
                                </Link>
                              </RowActionCluster>
                            </td>
                          </tr>

                          {isExpanded ? (
                            <tr className="bg-surface-muted/40">
                              <td colSpan={7} className="px-4 py-4">
                                <div
                                  className="rounded-xl border border-border bg-surface p-4 space-y-3"
                                  data-testid="vfin-monthly-drilldown-panel"
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <p className="text-xs font-semibold text-foreground">
                                      Lịch sử bút toán tháng {reportData.filters.month} —{" "}
                                      {row.project_display_name} · KT:{" "}
                                      {row.responsible_accountant_display_name} ·{" "}
                                      {row.vendor_display_name}
                                    </p>
                                    <Link
                                      href={subLedgerDetailHref}
                                      className="text-xs font-medium text-primary hover:underline"
                                    >
                                      Xem toàn bộ sổ cái & đối soát →
                                    </Link>
                                  </div>

                                  {drill?.loading ? (
                                    <p className="text-xs text-muted">
                                      Đang tải lịch sử giao dịch trong tháng…
                                    </p>
                                  ) : drill?.error ? (
                                    <Alert tone="error" title="Không thể tải giao dịch chi tiết">
                                      <p>{drill.error}</p>
                                    </Alert>
                                  ) : !drill || drill.entries.length === 0 ? (
                                    <p className="text-xs text-muted">
                                      Không phát sinh bút toán nào trong tháng{" "}
                                      {reportData.filters.month} trên sổ chi tiết này.
                                    </p>
                                  ) : (
                                    <div className="space-y-2">
                                      <div className="overflow-x-auto">
                                        <table className="w-full text-xs border-collapse">
                                          <thead>
                                            <tr className="border-b border-border text-left text-muted">
                                              <th className="py-2 pr-3">Chứng từ</th>
                                              <th className="py-2 pr-3">Ngày HL</th>
                                              <th className="py-2 pr-3">Loại bút toán</th>
                                              <th className="py-2 pr-3">Diễn giải & Người nhập</th>
                                              <th className="py-2 pr-3 text-right">Biến động</th>
                                              <th className="py-2 pr-3 text-right">Số dư sau GD</th>
                                              <th className="py-2 text-right">In</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {drill.entries.map((entry) => (
                                              <tr
                                                key={entry.entry_id}
                                                className="border-b border-border/60 last:border-b-0"
                                              >
                                                <td className="py-2 pr-3 font-mono font-semibold">
                                                  <Link
                                                    href={`/finance/documents/${encodeURIComponent(entry.entry_id)}`}
                                                    className="text-primary hover:underline"
                                                  >
                                                    {entry.document_no}
                                                  </Link>
                                                </td>
                                                <td className="py-2 pr-3 font-mono">
                                                  {formatVietnamDateLabel(entry.effective_date)}
                                                </td>
                                                <td className="py-2 pr-3">
                                                  {ENTRY_TYPE_LABELS_VI[entry.entry_type]}
                                                </td>
                                                <td className="py-2 pr-3 max-w-xs">
                                                  <p className="truncate text-foreground">
                                                    {entry.reason}
                                                  </p>
                                                  <p className="text-[11px] text-muted">
                                                    Người nhập: {entry.created_by_display_name}
                                                  </p>
                                                </td>
                                                <td className="py-2 pr-3 text-right font-mono font-semibold">
                                                  {formatSignedVndDelta(entry.balance_delta_minor)}
                                                </td>
                                                <td className="py-2 pr-3 text-right font-mono">
                                                  {formatVndMinor(entry.balance_after_minor)}
                                                </td>
                                                <td className="py-2 text-right">
                                                  <Link
                                                    href={`/finance/documents/${encodeURIComponent(entry.entry_id)}`}
                                                    className="inline-flex items-center gap-1 text-primary hover:underline"
                                                  >
                                                    <Printer className="h-3 w-3" aria-hidden />
                                                    Phiếu
                                                  </Link>
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>

                                      {drill.hasMore ? (
                                        <div className="flex justify-center pt-1">
                                          <CursorLoadMore
                                            hasMore={drill.hasMore}
                                            loading={drill.loadingMore}
                                            onLoadMore={() => void loadMoreDrilldown(row)}
                                            label="Tải thêm giao dịch trong tháng"
                                          />
                                        </div>
                                      ) : null}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </DataTableContainer>
            )}
          </section>

          {/* =================================================================
              SECTION 3: LEGACY VFIN-01 UNALLOCATED ROWS (IF ANY)
             ================================================================= */}
          {reportData.legacy_unallocated_rows.length > 0 ? (
            <section
              className="space-y-2.5"
              aria-label="Sổ lịch sử VFIN-01 chưa gắn dự án"
              data-testid="vfin-monthly-legacy-section"
            >
              <h2 className="text-base font-semibold text-foreground">
                3. Sổ lịch sử VFIN-01 (Trước khi tách theo dự án — không cộng lẫn vào sổ dự án)
              </h2>
              <DataTableContainer>
                <table className={DATA_TABLE_CLASS}>
                  <thead className={DATA_TABLE_HEAD_CLASS}>
                    <tr>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Vendor
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Đầu tháng
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Phát sinh tháng
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        TT & Tạm ứng tháng
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Số dư cuối tháng
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportData.legacy_unallocated_rows.map((leg) => (
                      <tr key={leg.vendor_id} className={DATA_TABLE_ROW_CLASS}>
                        <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                          <Link
                            href={`/finance/vendors/${encodeURIComponent(leg.vendor_id)}?ledgerScope=LEGACY_UNALLOCATED`}
                            className="font-semibold text-primary hover:underline"
                          >
                            {leg.vendor_display_name}
                          </Link>
                        </td>
                        <td
                          data-label="Đầu tháng"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                        >
                          {formatSignedVndDelta(leg.balance_before_month_minor)}
                        </td>
                        <td
                          data-label="Phát sinh tháng"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                        >
                          {formatVndMinor(leg.obligations_in_month_minor)}
                        </td>
                        <td
                          data-label="TT & Tạm ứng"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                        >
                          {formatVndMinor(leg.paid_and_advanced_in_month_minor)}
                        </td>
                        <td
                          data-label="Cuối tháng"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono font-semibold tabular-nums`}
                        >
                          {formatSignedVndDelta(leg.closing_balance_minor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTableContainer>
            </section>
          ) : null}
        </div>
      ) : null}
    </PageShell>
  );
}
