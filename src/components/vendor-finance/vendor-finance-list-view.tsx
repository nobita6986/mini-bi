"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  FileSpreadsheet,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { OffsetPager } from "@/components/ui/offset-pager";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import type {
  VendorFinanceActiveFilter,
  VendorFinanceActorContextOptionsResponse,
  VendorFinanceBalanceFilter,
  VendorFinanceLedgerScopeFilter,
  VendorFinanceListSubLedgerItem,
  VendorFinanceVendorListResponse,
} from "@/lib/vendor-finance/vendor-finance-contract";
import {
  ACTIVE_FILTER_LABELS_VI,
  BALANCE_FILTER_LABELS_VI,
  buildVendorFinanceContextUrl,
  buildVendorListUrl,
  classifyVendorFinanceError,
  formatSignedVndDelta,
  formatVendorBalancePresentation,
  formatVietnamDateLabel,
  formatVndMinor,
  LEDGER_SCOPE_FILTER_LABELS_VI,
  parseVendorFinanceContextEnvelope,
  parseVendorListEnvelope,
  validateUiSearchInput,
  VFIN_UI_ACTIVE_FILTERS,
  VFIN_UI_BALANCE_FILTERS,
  VFIN_UI_LEDGER_SCOPE_FILTERS,
  VFIN_UI_MAX_SEARCH_LENGTH,
} from "@/lib/vendor-finance/ui-model";

const PAGE_SIZE = 25;

function buildSubLedgerHref(vendorId: string, sub: VendorFinanceListSubLedgerItem): string {
  const sp = new URLSearchParams();
  sp.set("ledgerScope", sub.ledger_scope);
  if (sub.project_id) {
    sp.set("projectId", sub.project_id);
  }
  if (sub.accountant_ref) {
    sp.set("accountantRef", sub.accountant_ref);
  }
  return `/finance/vendors/${encodeURIComponent(vendorId)}?${sp.toString()}`;
}

export function VendorFinanceListView({
  initialCanRecord = false,
  initialCanReconcile = false,
  initialCanManageProjectAssignments = false,
}: {
  initialCanRecord?: boolean;
  initialCanReconcile?: boolean;
  initialCanManageProjectAssignments?: boolean;
}) {
  const searchInputId = useId();
  const projectSelectId = useId();
  const accountantSelectId = useId();
  const scopeSelectId = useId();
  const activeSelectId = useId();
  const balanceSelectId = useId();

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [accountantFilter, setAccountantFilter] = useState("");
  const [ledgerScopeFilter, setLedgerScopeFilter] =
    useState<VendorFinanceLedgerScopeFilter>("all");
  const [activeFilter, setActiveFilter] = useState<VendorFinanceActiveFilter>("all");
  const [balanceFilter, setBalanceFilter] = useState<VendorFinanceBalanceFilter>("all");
  const [page, setPage] = useState(1);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [contextData, setContextData] =
    useState<VendorFinanceActorContextOptionsResponse | null>(null);
  const [data, setData] = useState<VendorFinanceVendorListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchInput);
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

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
        if (!res.ok || cancelled) return;
        const json: unknown = await res.json().catch(() => null);
        if (cancelled) return;
        const parsed = parseVendorFinanceContextEnvelope(json);
        if (parsed) {
          setContextData(parsed);
        }
      } catch {
        // Context filter options are supplementary; primary list fetch handles errors.
      }
    }

    void loadContext();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadNonce]);

  useEffect(() => {
    const searchCheck = validateUiSearchInput(debouncedSearch);
    let cancelled = false;
    const controller = new AbortController();

    async function fetchList() {
      await Promise.resolve();
      if (cancelled) return;

      if (!searchCheck.ok) {
        setErrorMsg(searchCheck.message);
        setLoading(false);
        return;
      }

      setLoading(true);
      setErrorMsg(null);

      try {
        const url = buildVendorListUrl({
          search: searchCheck.search,
          project_id: projectFilter || null,
          accountant_ref: accountantFilter || null,
          ledger_scope: ledgerScopeFilter,
          active: activeFilter,
          balance_filter: balanceFilter,
          page,
          page_size: PAGE_SIZE,
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

        const parsed = parseVendorListEnvelope(json);
        if (!parsed) {
          setErrorMsg("Dữ liệu danh sách tài chính Vendor từ máy chủ không đúng chuẩn hợp đồng.");
          setLoading(false);
          return;
        }

        setData(parsed);
        setLoading(false);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setErrorMsg("Không thể tải danh sách tài chính Vendor do lỗi kết nối mạng.");
        setLoading(false);
      }
    }

    void fetchList();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    debouncedSearch,
    projectFilter,
    accountantFilter,
    ledgerScopeFilter,
    activeFilter,
    balanceFilter,
    page,
    reloadNonce,
  ]);

  const canRecord = data ? data.allowed_actions.can_record : initialCanRecord;
  const canReconcile = data ? data.allowed_actions.can_reconcile : initialCanReconcile;
  const canManageProjectAssignments = data
    ? data.allowed_actions.can_manage_project_assignments
    : initialCanManageProjectAssignments;
  const visibilityScope = data?.allowed_actions.visibility_scope ?? "PROJECT_SCOPED";
  const activeAssignedProjectCount = data?.allowed_actions.active_assigned_project_count ?? 0;

  const summary = data?.summary ?? null;
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const hasActiveFilters =
    searchInput.trim().length > 0 ||
    projectFilter !== "" ||
    accountantFilter !== "" ||
    ledgerScopeFilter !== "all" ||
    activeFilter !== "all" ||
    balanceFilter !== "all";

  const handleResetFilters = () => {
    setSearchInput("");
    setDebouncedSearch("");
    setProjectFilter("");
    setAccountantFilter("");
    setLedgerScopeFilter("all");
    setActiveFilter("all");
    setBalanceFilter("all");
    setPage(1);
  };

  return (
    <PageShell dataTestId="vfin-vendor-list-page">
      <PageHeader
        eyebrow="Tài chính Vendor theo Dự án & Kế toán phụ trách"
        title="Công nợ & Tạm ứng Vendor"
        badge={
          <div className="flex flex-wrap items-center gap-2">
            {visibilityScope === "PROJECT_SCOPED" ? (
              <StatusBadge tone="primary" dataTestId="vfin-project-scoped-badge">
                Phạm vi sổ dự án phụ trách ({activeAssignedProjectCount} dự án đang nhận)
              </StatusBadge>
            ) : (
              <StatusBadge tone="info" dataTestId="vfin-global-scope-badge">
                Phạm vi toàn cục (Không bù trừ chéo sổ)
              </StatusBadge>
            )}
            {!canRecord ? (
              <StatusBadge tone="info" dataTestId="vfin-view-only-badge">
                {canReconcile ? "Xem & Đối soát (Không ghi sổ)" : "Chế độ chỉ xem"}
              </StatusBadge>
            ) : null}
          </div>
        }
        description="Mỗi dự án có một kế toán phụ trách sổ thu/chi riêng theo chuỗi Công ty → Kế toán phụ trách → Dự án → Vendor. Tuyệt đối không gộp hoặc bù trừ số dư giữa các dự án hay kế toán khác nhau."
        actions={
          <>
            <Button
              variant="secondary"
              disabled={loading}
              onClick={() => setReloadNonce((n) => n + 1)}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Làm mới
            </Button>
            <Link
              href="/finance/reports"
              data-testid="vfin-monthly-report-cta"
              className={buttonClasses({ variant: "secondary", size: "md" })}
            >
              <BarChart3 className="h-4 w-4" aria-hidden />
              Báo cáo công nợ tháng
            </Link>
            {canManageProjectAssignments ? (
              <Link
                href="/finance/project-assignments"
                data-testid="vfin-governance-cta"
                className={buttonClasses({ variant: "secondary", size: "md" })}
              >
                <Settings2 className="h-4 w-4" aria-hidden />
                Phân công & vai trò
              </Link>
            ) : null}
            {canRecord ? (
              <Link
                href="/finance/opening-balance"
                data-testid="vfin-opening-balance-cta"
                className={buttonClasses({ variant: "primary", size: "md" })}
              >
                <FileSpreadsheet className="h-4 w-4" aria-hidden />
                Khởi tạo công nợ đầu kỳ
              </Link>
            ) : null}
          </>
        }
      />

      {data && visibilityScope === "PROJECT_SCOPED" && activeAssignedProjectCount === 0 ? (
        <Alert tone="info" title="Bạn chưa được phân công dự án đang hiệu lực">
          <p>
            Kế toán phụ trách dự án chỉ nhìn thấy và ghi nhận trên các dự án được giao (cùng các sổ
            lịch sử của chính bạn nếu từng bàn giao dự án). Vui lòng liên hệ Quản trị viên (Full
            Admin) để phân công kế toán dự án và khai báo liên kết Dự án – Vendor.
          </p>
        </Alert>
      ) : null}

      {/* Non-Netted Sub-Ledger KPI Summary */}
      <section
        aria-label="Chỉ số tổng hợp công nợ Vendor (tách riêng phải trả và dư ứng từng sổ)"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
        data-testid="vfin-company-kpis"
      >
        <Card className="p-4">
          <p className="text-xs font-medium text-muted">Tổng phải trả (cộng các sổ dương)</p>
          <p
            data-testid="vfin-kpi-payable"
            className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground"
          >
            {summary ? formatVndMinor(summary.total_payable_minor) : "—"}
          </p>
          <p className="mt-1 text-xs text-muted">
            {summary
              ? `${summary.vendors_with_payable_count} Vendor có sổ đang phải trả (không bù trừ chéo)`
              : "Đang tải dữ liệu…"}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium text-muted">Tổng dư ứng (cộng các sổ âm)</p>
          <p
            data-testid="vfin-kpi-advance"
            className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground"
          >
            {summary ? formatVndMinor(summary.total_advance_minor) : "—"}
          </p>
          <p className="mt-1 text-xs text-muted">
            {summary
              ? `${summary.vendors_with_advance_count} Vendor có sổ đang dư ứng (không bù trừ chéo)`
              : "Đang tải dữ liệu…"}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium text-muted">Số Vendor & Sổ dự án trong phạm vi</p>
          <p
            data-testid="vfin-kpi-nonzero-count"
            className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground"
          >
            {summary
              ? `${summary.vendors_with_nonzero_balance_count} / ${summary.total_vendor_count}`
              : "—"}
          </p>
          <p className="mt-1 text-xs text-muted">
            {summary
              ? `${summary.sub_ledger_count} sổ chi tiết · ${summary.uninitialized_vendor_count} sổ chưa mở đầu kỳ`
              : "Đang tải dữ liệu…"}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium text-muted">Chênh lệch tham chiếu phạm vi lọc</p>
          <p
            data-testid="vfin-kpi-net"
            className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground"
          >
            {summary ? formatSignedVndDelta(summary.net_balance_minor) : "—"}
          </p>
          <p className="mt-1 text-xs text-muted">
            Chỉ tham chiếu tổng hợp — không thay thế số dư riêng từng kế toán/dự án
          </p>
        </Card>
      </section>

      {/* Search & Multi-Dimension Filter Toolbar */}
      <FilterToolbar
        dataTestId="vfin-vendor-filter-toolbar"
        summary={
          <>
            <span aria-live="polite" className="font-mono tabular-nums">
              {loading
                ? "Đang tra cứu danh sách Vendor & sổ dự án…"
                : data
                  ? `Hiển thị ${data.vendors.length} / ${data.total} Vendor phù hợp`
                  : "Chưa có dữ liệu"}
            </span>
            {data ? (
              <span>Ngày nghiệp vụ máy chủ: {formatVietnamDateLabel(data.authorization_date)}</span>
            ) : null}
          </>
        }
        actions={
          hasActiveFilters ? (
            <Button variant="ghost" size="sm" onClick={handleResetFilters}>
              <X className="h-3.5 w-3.5" aria-hidden />
              Xóa bộ lọc
            </Button>
          ) : null
        }
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
          <div className="md:col-span-4 space-y-1">
            <label htmlFor={searchInputId} className="block text-xs font-medium text-muted">
              Tìm Vendor gần đúng (tên hoặc mã Vendor)
            </label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
                aria-hidden
              />
              <input
                id={searchInputId}
                type="search"
                maxLength={VFIN_UI_MAX_SEARCH_LENGTH}
                placeholder="Nhập tên Vendor cần tra cứu…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface pl-9 pr-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>
          </div>

          <div className="md:col-span-3 space-y-1">
            <label htmlFor={projectSelectId} className="block text-xs font-medium text-muted">
              Dự án
            </label>
            <select
              id={projectSelectId}
              value={projectFilter}
              onChange={(e) => {
                setProjectFilter(e.target.value);
                setPage(1);
              }}
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <option value="">Tất cả dự án được phép xem</option>
              {(contextData?.projects ?? []).map((proj) => (
                <option key={proj.project_id} value={proj.project_id}>
                  {proj.display_name} ({proj.project_id})
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3 space-y-1">
            <label htmlFor={accountantSelectId} className="block text-xs font-medium text-muted">
              Kế toán phụ trách sổ
            </label>
            <select
              id={accountantSelectId}
              value={accountantFilter}
              onChange={(e) => {
                setAccountantFilter(e.target.value);
                setPage(1);
              }}
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <option value="">Tất cả kế toán trong phạm vi</option>
              {(contextData?.accountants ?? []).map((acc) => (
                <option key={acc.accountant_ref} value={acc.accountant_ref}>
                  {acc.display_name}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2 space-y-1">
            <label htmlFor={balanceSelectId} className="block text-xs font-medium text-muted">
              Nhóm số dư sổ
            </label>
            <select
              id={balanceSelectId}
              value={balanceFilter}
              onChange={(e) => {
                setBalanceFilter(e.target.value as VendorFinanceBalanceFilter);
                setPage(1);
              }}
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {VFIN_UI_BALANCE_FILTERS.map((opt) => (
                <option key={opt} value={opt}>
                  {BALANCE_FILTER_LABELS_VI[opt]}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3 space-y-1">
            <label htmlFor={activeSelectId} className="block text-xs font-medium text-muted">
              Trạng thái Vendor
            </label>
            <select
              id={activeSelectId}
              value={activeFilter}
              onChange={(e) => {
                setActiveFilter(e.target.value as VendorFinanceActiveFilter);
                setPage(1);
              }}
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {VFIN_UI_ACTIVE_FILTERS.map((opt) => (
                <option key={opt} value={opt}>
                  {ACTIVE_FILTER_LABELS_VI[opt]}
                </option>
              ))}
            </select>
          </div>

          {contextData?.has_legacy_unallocated || ledgerScopeFilter !== "all" ? (
            <div className="md:col-span-4 space-y-1">
              <label htmlFor={scopeSelectId} className="block text-xs font-medium text-muted">
                Phạm vi sổ kế toán
              </label>
              <select
                id={scopeSelectId}
                value={ledgerScopeFilter}
                onChange={(e) => {
                  setLedgerScopeFilter(e.target.value as VendorFinanceLedgerScopeFilter);
                  setPage(1);
                }}
                className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {VFIN_UI_LEDGER_SCOPE_FILTERS.map((scope) => (
                  <option key={scope} value={scope}>
                    {LEDGER_SCOPE_FILTER_LABELS_VI[scope]}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      </FilterToolbar>

      {/* Error / Loading / Empty / Table States */}
      {errorMsg ? (
        <div className="space-y-3">
          <Alert tone="error" role="alert" title="Không thể tải danh sách tài chính Vendor">
            <p>{errorMsg}</p>
          </Alert>
          <div>
            <Button variant="primary" onClick={() => setReloadNonce((n) => n + 1)}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Thử lại
            </Button>
          </div>
        </div>
      ) : loading && !data ? (
        <Card className="p-8 text-center">
          <p role="status" aria-live="polite" className="text-sm text-muted">
            Đang tải bảng tổng hợp công nợ Vendor…
          </p>
        </Card>
      ) : data && data.vendors.length === 0 ? (
        <Card className="p-8 text-center space-y-3">
          <p className="text-sm font-medium text-foreground">
            Không tìm thấy Vendor hoặc sổ dự án nào khớp với điều kiện lọc hiện tại.
          </p>
          <p className="text-xs text-muted">
            Thử điều chỉnh từ khóa tìm kiếm, chọn lại Dự án / Kế toán hoặc đặt bộ lọc về mặc định.
          </p>
          {hasActiveFilters ? (
            <div className="flex justify-center pt-1">
              <Button variant="secondary" onClick={handleResetFilters}>
                Đặt lại bộ lọc
              </Button>
            </div>
          ) : null}
        </Card>
      ) : data ? (
        <DataTableContainer
          dataTestId="vfin-vendor-table"
          footer={
            <OffsetPager
              page={data.page}
              pageCount={pageCount}
              total={data.total}
              ariaLabel="Phân trang danh sách Vendor"
              disabled={loading}
              nextDisabled={loading || (!data.has_more && data.page >= pageCount)}
              onPageChange={(nextPage) => setPage(nextPage)}
              className="mt-0 border-t-0 pt-0"
            />
          }
        >
          <table className={DATA_TABLE_CLASS}>
            <thead className={DATA_TABLE_HEAD_CLASS}>
              <tr>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Vendor
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Sổ theo Dự án × Kế toán phụ trách (Không bù trừ)
                </th>
                <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                  Số dư theo sổ
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Trạng thái công nợ
                </th>
                <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                  Bút toán
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Giao dịch / Đối soát gần nhất
                </th>
                <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                  Thao tác
                </th>
              </tr>
            </thead>
            <tbody>
              {data.vendors.map((vendor) => {
                const balanceInfo = formatVendorBalancePresentation({
                  current_balance_minor: vendor.current_balance_minor,
                  balance_direction: vendor.balance_direction,
                  entry_count: vendor.entry_count,
                  has_opening_entry: vendor.has_opening_entry,
                  sub_ledger_count: vendor.sub_ledger_count,
                });
                const defaultSub = vendor.sub_ledgers.length === 1 ? vendor.sub_ledgers[0]! : null;
                const detailHref = defaultSub
                  ? buildSubLedgerHref(vendor.vendor_id, defaultSub)
                  : `/finance/vendors/${encodeURIComponent(vendor.vendor_id)}`;

                return (
                  <tr key={vendor.vendor_id} className={DATA_TABLE_ROW_CLASS}>
                    <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Link
                            href={detailHref}
                            className="font-semibold text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
                          >
                            {vendor.display_name}
                          </Link>
                          <StatusBadge tone={vendor.active ? "success" : "neutral"}>
                            {vendor.active ? "Đang hoạt động" : "Ngừng HĐ"}
                          </StatusBadge>
                        </div>
                        <p className="font-mono text-xs text-muted">{vendor.vendor_id}</p>
                      </div>
                    </td>

                    <td data-label="Sổ dự án × Kế toán" className={DATA_TABLE_TD_CLASS}>
                      {vendor.sub_ledgers.length === 0 ? (
                        <span className="text-xs text-muted">Chưa liên kết sổ dự án</span>
                      ) : (
                        <div className="space-y-1.5" data-testid="vfin-vendor-subledger-list">
                          {vendor.sub_ledgers.map((sub, idx) => {
                            const subBal = formatVendorBalancePresentation({
                              current_balance_minor: sub.current_balance_minor,
                              balance_direction: sub.balance_direction,
                              entry_count: sub.entry_count,
                              has_opening_entry: sub.has_opening_entry,
                            });
                            const subKey = `${sub.ledger_scope}:${sub.project_id ?? "legacy"}:${sub.accountant_ref ?? idx}`;
                            return (
                              <Link
                                key={subKey}
                                href={buildSubLedgerHref(vendor.vendor_id, sub)}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-muted/40 px-2.5 py-1.5 text-xs hover:border-primary/40 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                              >
                                <span className="space-x-1">
                                  {sub.ledger_scope === "LEGACY_UNALLOCATED" ? (
                                    <strong className="text-foreground">
                                      Sổ lịch sử VFIN-01 (chưa gắn dự án)
                                    </strong>
                                  ) : (
                                    <>
                                      <strong className="text-foreground">
                                        {sub.project_display_name ?? sub.project_id}
                                      </strong>
                                      <span className="text-muted">· KT:</span>
                                      <span className="font-medium text-foreground">
                                        {sub.responsible_accountant_display_name ?? "—"}
                                      </span>
                                    </>
                                  )}
                                </span>
                                <span className="font-mono font-semibold tabular-nums text-foreground">
                                  {subBal.signedText}
                                </span>
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </td>

                    <td
                      data-label="Số dư theo sổ"
                      className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                    >
                      {vendor.balance_direction === "MULTI_LEDGER" ? (
                        <div className="space-y-0.5 text-xs">
                          <p className="font-semibold text-foreground">
                            Phải trả: {formatVndMinor(vendor.payable_total_minor)}
                          </p>
                          <p className="text-muted">
                            Dư ứng: {formatVndMinor(vendor.advance_total_minor)}
                          </p>
                        </div>
                      ) : (
                        <span className="font-semibold">{balanceInfo.signedText}</span>
                      )}
                    </td>

                    <td data-label="Trạng thái công nợ" className={DATA_TABLE_TD_CLASS}>
                      <StatusBadge tone={balanceInfo.tone}>{balanceInfo.statusLabel}</StatusBadge>
                    </td>

                    <td
                      data-label="Số bút toán"
                      className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                    >
                      {vendor.entry_count}
                    </td>

                    <td data-label="GD / Đối soát gần nhất" className={DATA_TABLE_TD_CLASS}>
                      <div className="text-xs space-y-0.5">
                        <p>
                          <span className="text-muted">GD: </span>
                          <span className="font-mono text-foreground">
                            {formatVietnamDateLabel(vendor.last_effective_date)}
                          </span>
                        </p>
                        <p>
                          <span className="text-muted">Đối soát: </span>
                          <span className="font-mono text-foreground">
                            {formatVietnamDateLabel(vendor.last_reconciled_as_of_date)}
                          </span>
                        </p>
                      </div>
                    </td>

                    <td
                      data-card-actions="true"
                      className={`${DATA_TABLE_TD_CLASS} text-right`}
                    >
                      <RowActionCluster>
                        <Link
                          href={detailHref}
                          aria-label={`Xem sổ cái của ${vendor.display_name}`}
                          className={buttonClasses({ variant: "secondary", size: "sm" })}
                        >
                          Sổ cái & Đối soát
                          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                        </Link>
                      </RowActionCluster>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTableContainer>
      ) : null}
    </PageShell>
  );
}
