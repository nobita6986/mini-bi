"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { ArrowRight, FileSpreadsheet, RefreshCw, Search, X } from "lucide-react";

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
  VendorFinanceBalanceFilter,
  VendorFinanceVendorListResponse,
} from "@/lib/vendor-finance/vendor-finance-contract";
import {
  ACTIVE_FILTER_LABELS_VI,
  BALANCE_FILTER_LABELS_VI,
  buildVendorListUrl,
  classifyVendorFinanceError,
  formatSignedVndDelta,
  formatVendorBalancePresentation,
  formatVietnamDateLabel,
  formatVndMinor,
  parseVendorListEnvelope,
  validateUiSearchInput,
  VFIN_UI_ACTIVE_FILTERS,
  VFIN_UI_BALANCE_FILTERS,
  VFIN_UI_MAX_SEARCH_LENGTH,
} from "@/lib/vendor-finance/ui-model";

const PAGE_SIZE = 25;

export function VendorFinanceListView({
  initialCanRecord = false,
}: {
  initialCanRecord?: boolean;
}) {
  const searchInputId = useId();
  const activeSelectId = useId();
  const balanceSelectId = useId();

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<VendorFinanceActiveFilter>("all");
  const [balanceFilter, setBalanceFilter] = useState<VendorFinanceBalanceFilter>("all");
  const [page, setPage] = useState(1);
  const [reloadNonce, setReloadNonce] = useState(0);

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
  }, [debouncedSearch, activeFilter, balanceFilter, page, reloadNonce]);

  const canRecord = data ? data.allowed_actions.can_record : initialCanRecord;
  const summary = data?.summary ?? null;
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const hasActiveFilters =
    searchInput.trim().length > 0 || activeFilter !== "all" || balanceFilter !== "all";

  const handleResetFilters = () => {
    setSearchInput("");
    setDebouncedSearch("");
    setActiveFilter("all");
    setBalanceFilter("all");
    setPage(1);
  };

  return (
    <PageShell dataTestId="vfin-vendor-list-page">
      <PageHeader
        eyebrow="Tài chính Vendor"
        title="Công nợ & Tạm ứng Vendor"
        badge={
          !canRecord ? (
            <StatusBadge tone="info" dataTestId="vfin-view-only-badge">
              Chế độ chỉ xem
            </StatusBadge>
          ) : null
        }
        description="Theo dõi tổng công nợ phải trả, dư ứng, trạng thái đối soát và sổ cái chi tiết từng đối tác cung ứng nhân sự."
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

      {/* Company-wide KPI Summary */}
      <section
        aria-label="Chỉ số tổng hợp công nợ Vendor"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
        data-testid="vfin-company-kpis"
      >
        <Card className="p-4">
          <p className="text-xs font-medium text-muted">Tổng phải trả Vendor</p>
          <p
            data-testid="vfin-kpi-payable"
            className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground"
          >
            {summary ? formatVndMinor(summary.total_payable_minor) : "—"}
          </p>
          <p className="mt-1 text-xs text-muted">
            {summary
              ? `${summary.vendors_with_payable_count} Vendor đang có công nợ phải trả`
              : "Đang tải dữ liệu…"}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium text-muted">Tổng dư ứng tại Vendor</p>
          <p
            data-testid="vfin-kpi-advance"
            className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground"
          >
            {summary ? formatVndMinor(summary.total_advance_minor) : "—"}
          </p>
          <p className="mt-1 text-xs text-muted">
            {summary
              ? `${summary.vendors_with_advance_count} Vendor đang giữ tiền dư ứng`
              : "Đang tải dữ liệu…"}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium text-muted">Số Vendor còn công nợ / dư ứng</p>
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
              ? `${summary.uninitialized_vendor_count} Vendor chưa khởi tạo đầu kỳ`
              : "Đang tải dữ liệu…"}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium text-muted">Số dư ròng toàn hệ thống</p>
          <p
            data-testid="vfin-kpi-net"
            className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground"
          >
            {summary ? formatSignedVndDelta(summary.net_balance_minor) : "—"}
          </p>
          <p className="mt-1 text-xs text-muted">
            (+) Công ty còn phải trả · (-) Vendor đang dư ứng
          </p>
        </Card>
      </section>

      {/* Search & Filter Toolbar */}
      <FilterToolbar
        dataTestId="vfin-vendor-filter-toolbar"
        summary={
          <>
            <span aria-live="polite" className="font-mono tabular-nums">
              {loading
                ? "Đang tra cứu danh sách Vendor…"
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
          <div className="md:col-span-6 space-y-1">
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
            <label htmlFor={activeSelectId} className="block text-xs font-medium text-muted">
              Trạng thái hoạt động
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

          <div className="md:col-span-3 space-y-1">
            <label htmlFor={balanceSelectId} className="block text-xs font-medium text-muted">
              Nhóm số dư công nợ
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
            Không tìm thấy Vendor nào khớp với điều kiện lọc hiện tại.
          </p>
          <p className="text-xs text-muted">
            Thử điều chỉnh từ khóa tìm kiếm hoặc chuyển bộ lọc trạng thái / số dư về mặc định.
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
                  Hoạt động
                </th>
                <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                  Số dư hiện tại
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
                });
                const detailHref = `/finance/vendors/${encodeURIComponent(vendor.vendor_id)}`;
                return (
                  <tr key={vendor.vendor_id} className={DATA_TABLE_ROW_CLASS}>
                    <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                      <div className="space-y-0.5">
                        <Link
                          href={detailHref}
                          className="font-semibold text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
                        >
                          {vendor.display_name}
                        </Link>
                        <p className="font-mono text-xs text-muted">{vendor.vendor_id}</p>
                      </div>
                    </td>

                    <td data-label="Hoạt động" className={DATA_TABLE_TD_CLASS}>
                      <StatusBadge tone={vendor.active ? "success" : "neutral"} dot>
                        {vendor.active ? "Đang hoạt động" : "Ngừng hoạt động"}
                      </StatusBadge>
                    </td>

                    <td
                      data-label="Số dư hiện tại"
                      className={`${DATA_TABLE_TD_CLASS} text-right font-mono font-semibold tabular-nums`}
                    >
                      <span>{balanceInfo.signedText}</span>
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
