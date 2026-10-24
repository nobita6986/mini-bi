"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  Printer,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
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
} from "@/components/ui/data-table";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { useNotify } from "@/components/ui/notify-provider";
import { OffsetPager } from "@/components/ui/offset-pager";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import type {
  OpeningVendorFinanceEntryType,
  VendorFinanceListItem,
  VendorFinanceOpeningApplyResponse,
  VendorFinanceOpeningPreviewResponse,
  VendorFinanceVendorListResponse,
} from "@/lib/vendor-finance/vendor-finance-contract";
import {
  buildOpeningApplyRequest,
  buildOpeningApplyUrl,
  buildOpeningPreviewRequest,
  buildOpeningPreviewUrl,
  buildVendorListUrl,
  classifyVendorFinanceError,
  createClientIdempotencyKey,
  ENTRY_TYPE_LABELS_VI,
  formatSignedVndDelta,
  formatTimestampVi,
  formatVietnamDateLabel,
  formatVndMinor,
  isCanonicalUiVendorId,
  normalizeNonNegativeVndInput,
  parseOpeningApplyEnvelope,
  parseOpeningPreviewEnvelope,
  parseVendorListEnvelope,
  validateUiSearchInput,
  VFIN_UI_MAX_OPENING_BATCH_ITEMS,
  VFIN_UI_MAX_REASON_LENGTH,
  VFIN_UI_MAX_SEARCH_LENGTH,
  VFIN_UI_OPENING_ENTRY_TYPES,
  type OpeningDraftRowInput,
} from "@/lib/vendor-finance/ui-model";

const PAGE_SIZE = 25;

type WizardStep = "input" | "preview" | "confirm" | "applied";

type OpeningDraftRowState = {
  vendor_id: string;
  display_name: string;
  active: boolean;
  entry_type: OpeningVendorFinanceEntryType;
  amount_input: string;
};

export function OpeningBalanceWizard() {
  const searchParams = useSearchParams();
  const initialVendorParam = searchParams.get("vendorId") ?? "";
  const safeInitialSearch = isCanonicalUiVendorId(initialVendorParam) ? initialVendorParam : "";

  const cutoffInputId = useId();
  const searchInputId = useId();
  const reasonInputId = useId();
  const notify = useNotify();

  const [step, setStep] = useState<WizardStep>("input");
  const [cutoffDate, setCutoffDate] = useState("");
  const [cutoffInitialized, setCutoffInitialized] = useState(false);

  // Eligible vendor directory state (`balance_filter=uninitialized`)
  const [searchInput, setSearchInput] = useState(safeInitialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(safeInitialSearch);
  const [page, setPage] = useState(1);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [listData, setListData] = useState<VendorFinanceVendorListResponse | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // Persistent draft rows across search/pagination (keyed by vendor_id)
  const [draftMap, setDraftMap] = useState<Record<string, OpeningDraftRowState>>({});

  // Preview & Confirm state
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<VendorFinanceOpeningPreviewResponse | null>(null);
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => createClientIdempotencyKey());
  const [applyLoading, setApplyLoading] = useState(false);
  const [appliedData, setAppliedData] = useState<VendorFinanceOpeningApplyResponse | null>(null);

  // Single error channel for wizard mutations / validation
  const [wizardError, setWizardError] = useState<{
    title: string;
    message: string;
    isWholeBatchRollback: boolean;
  } | null>(null);

  const rotateKey = () => setIdempotencyKey(createClientIdempotencyKey());

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

    async function loadUninitializedVendors() {
      await Promise.resolve();
      if (cancelled) return;

      if (!searchCheck.ok) {
        setListError(searchCheck.message);
        setListLoading(false);
        return;
      }

      setListLoading(true);
      setListError(null);

      try {
        const url = buildVendorListUrl({
          search: searchCheck.search,
          active: "all",
          balance_filter: "uninitialized",
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
          setListError(classified.message);
          setListLoading(false);
          return;
        }

        const parsed = parseVendorListEnvelope(json);
        if (!parsed) {
          setListError("Dữ liệu danh sách Vendor chưa khởi tạo từ máy chủ không hợp lệ.");
          setListLoading(false);
          return;
        }

        setListData(parsed);
        if (!cutoffInitialized) {
          setCutoffDate(parsed.authorization_date);
          setCutoffInitialized(true);
        }
        setListLoading(false);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setListError("Không thể tải danh sách Vendor chưa khởi tạo do lỗi kết nối mạng.");
        setListLoading(false);
      }
    }

    void loadUninitializedVendors();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [debouncedSearch, page, reloadNonce, cutoffInitialized]);

  const draftEntries = Object.values(draftMap);

  const upsertDraftRow = (
    vendor: Pick<VendorFinanceListItem, "vendor_id" | "display_name" | "active">,
    patch: Partial<Pick<OpeningDraftRowState, "entry_type" | "amount_input">>,
  ) => {
    setWizardError(null);
    rotateKey();
    setDraftMap((prev) => {
      const existing = prev[vendor.vendor_id];
      const nextAmount = patch.amount_input ?? existing?.amount_input ?? "";
      const nextType = patch.entry_type ?? existing?.entry_type ?? "OPENING_PAYABLE";

      if (nextAmount.trim() === "" && !patch.entry_type) {
        const clone = { ...prev };
        delete clone[vendor.vendor_id];
        return clone;
      }

      if (!existing && Object.keys(prev).length >= VFIN_UI_MAX_OPENING_BATCH_ITEMS) {
        setWizardError({
          title: "Đã đạt giới hạn kích thước lô",
          message: `Mỗi lô khởi tạo tối đa ${VFIN_UI_MAX_OPENING_BATCH_ITEMS} Vendor. Vui lòng xác nhận lô hiện tại trước khi thêm tiếp.`,
          isWholeBatchRollback: false,
        });
        return prev;
      }

      return {
        ...prev,
        [vendor.vendor_id]: {
          vendor_id: vendor.vendor_id,
          display_name: vendor.display_name,
          active: vendor.active,
          entry_type: nextType,
          amount_input: nextAmount,
        },
      };
    });
  };

  const removeDraftRow = (vendorId: string) => {
    setWizardError(null);
    rotateKey();
    setDraftMap((prev) => {
      const clone = { ...prev };
      delete clone[vendorId];
      return clone;
    });
  };

  const buildRowsForSubmission = (): OpeningDraftRowInput[] =>
    draftEntries
      .filter((row) => row.amount_input.trim().length > 0)
      .map((row) => ({
        vendor_id: row.vendor_id,
        entry_type: row.entry_type,
        amount_input: row.amount_input,
      }));

  const handleRunPreview = async () => {
    setWizardError(null);
    const rows = buildRowsForSubmission();
    const built = buildOpeningPreviewRequest({
      cutoff_date: cutoffDate,
      rows,
    });
    if (!built.ok) {
      setWizardError({
        title: "Dữ liệu lô đầu kỳ chưa hợp lệ",
        message: built.message,
        isWholeBatchRollback: false,
      });
      return;
    }

    setPreviewLoading(true);
    try {
      const res = await fetch(buildOpeningPreviewUrl(), {
        method: "POST",
        headers: built.request.headers,
        body: JSON.stringify(built.request.body),
      });
      const json: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const classified = classifyVendorFinanceError(json, res.status);
        setWizardError({
          title: classified.isWholeBatchRollback
            ? "Toàn bộ lô đầu kỳ bị từ chối khi kiểm tra (Preview)"
            : "Không thể xem trước lô đầu kỳ",
          message: classified.message,
          isWholeBatchRollback: classified.isWholeBatchRollback,
        });
        setPreviewLoading(false);
        return;
      }

      const parsed = parseOpeningPreviewEnvelope(json);
      if (!parsed) {
        setWizardError({
          title: "Phản hồi xem trước không hợp lệ",
          message: "Máy chủ trả về dữ liệu xem trước không đúng chuẩn hợp đồng.",
          isWholeBatchRollback: false,
        });
        setPreviewLoading(false);
        return;
      }

      setPreviewData(parsed);
      setStep("preview");
      setPreviewLoading(false);
    } catch {
      setWizardError({
        title: "Lỗi kết nối mạng",
        message: "Không thể kết nối máy chủ để xem trước lô số dư đầu kỳ. Vui lòng thử lại.",
        isWholeBatchRollback: false,
      });
      setPreviewLoading(false);
    }
  };

  const handleConfirmApply = async () => {
    setWizardError(null);
    const rows = buildRowsForSubmission();
    const built = buildOpeningApplyRequest({
      cutoff_date: cutoffDate,
      rows,
      reason,
      idempotency_key: idempotencyKey,
    });
    if (!built.ok) {
      setWizardError({
        title: "Thông tin xác nhận chưa hợp lệ",
        message: built.message,
        isWholeBatchRollback: false,
      });
      return;
    }

    setApplyLoading(true);
    try {
      const res = await fetch(buildOpeningApplyUrl(), {
        method: "POST",
        headers: built.request.headers,
        body: JSON.stringify(built.request.body),
      });
      const json: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const classified = classifyVendorFinanceError(json, res.status);
        if (classified.shouldRotateIdempotencyKey) {
          rotateKey();
        }
        setWizardError({
          title: classified.isWholeBatchRollback
            ? "Toàn bộ lô đầu kỳ đã hủy nguyên vẹn (Atomic Rollback)"
            : "Không thể áp dụng lô số dư đầu kỳ",
          message: classified.message,
          isWholeBatchRollback: classified.isWholeBatchRollback,
        });
        setApplyLoading(false);
        return;
      }

      const parsed = parseOpeningApplyEnvelope(json);
      if (!parsed) {
        setWizardError({
          title: "Phản hồi xác nhận không hợp lệ",
          message:
            "Phản hồi từ máy chủ không đúng chuẩn hợp đồng. Vui lòng kiểm tra lại danh sách Vendor trước khi thao tác tiếp.",
          isWholeBatchRollback: false,
        });
        setApplyLoading(false);
        return;
      }

      setAppliedData(parsed);
      setDraftMap({});
      setStep("applied");
      setApplyLoading(false);
      notify.success({
        title: `Đã khởi tạo thành công ${parsed.batch.vendor_count} Vendor`,
        description: `Ngày chốt đầu kỳ: ${formatVietnamDateLabel(parsed.batch.cutoff_date)}`,
      });
    } catch {
      setWizardError({
        title: "Mất kết nối mạng khi áp dụng lô đầu kỳ",
        message:
          "Bạn có thể bấm Xác nhận khởi tạo lại an toàn (hệ thống giữ nguyên Idempotency-Key chống ghi trùng lô).",
        isWholeBatchRollback: false,
      });
      setApplyLoading(false);
    }
  };

  const pageCount = listData ? Math.max(1, Math.ceil(listData.total / listData.page_size)) : 1;
  const filledDraftCount = draftEntries.filter((r) => r.amount_input.trim().length > 0).length;

  const stepsMeta: ReadonlyArray<{ id: WizardStep; num: number; label: string }> = [
    { id: "input", num: 1, label: "Nhập lô đầu kỳ" },
    { id: "preview", num: 2, label: "Xem trước nguyên lô" },
    { id: "confirm", num: 3, label: "Xác nhận áp dụng" },
  ];

  return (
    <PageShell dataTestId="vfin-opening-balance-wizard">
      <div>
        <Link
          href="/finance/vendors"
          className="inline-flex min-h-11 sm:min-h-8 items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Quay về danh sách tài chính Vendor
        </Link>
      </div>

      <PageHeader
        eyebrow="Khởi tạo một lần theo lô nguyên tử"
        title="Khởi tạo công nợ & dư ứng đầu kỳ Vendor"
        description="Áp dụng cho các Vendor chưa phát sinh bút toán nào trên sổ cái. Nếu bất kỳ dòng nào trong lô không hợp lệ, toàn bộ lô sẽ bị từ chối nguyên vẹn."
      />

      {/* Step Indicator */}
      {step !== "applied" ? (
        <nav
          aria-label="Tiến trình khởi tạo số dư đầu kỳ"
          className="grid grid-cols-1 gap-2 rounded-xl border border-border bg-surface p-3 sm:grid-cols-3"
        >
          {stepsMeta.map((item) => {
            const isCurrent = step === item.id;
            const isDone =
              (item.id === "input" && (step === "preview" || step === "confirm")) ||
              (item.id === "preview" && step === "confirm");
            return (
              <div
                key={item.id}
                aria-current={isCurrent ? "step" : undefined}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs sm:text-sm font-medium ${
                  isCurrent
                    ? "bg-primary/10 text-primary border border-primary/25"
                    : isDone
                      ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                      : "text-muted"
                }`}
              >
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current font-mono text-xs">
                  {item.num}
                </span>
                <span>{item.label}</span>
              </div>
            );
          })}
        </nav>
      ) : null}

      {/* Wizard Error Banner (Single Error Channel) */}
      {wizardError ? (
        <Alert tone="error" role="alert" title={wizardError.title}>
          <p>{wizardError.message}</p>
          {wizardError.isWholeBatchRollback ? (
            <p className="font-medium">
              Đảm bảo nguyên tử (Atomic Batch): Chưa có bất kỳ bút toán đầu kỳ nào được ghi vào cơ
              sở dữ liệu. Bạn có thể quay lại Bước 1 để kiểm tra và loại bỏ dòng không hợp lệ.
            </p>
          ) : null}
        </Alert>
      ) : null}

      {/* =====================================================================
          STEP 1: INPUT BATCH
         ===================================================================== */}
      {step === "input" ? (
        <div className="space-y-4" data-testid="vfin-opening-step-input">
          <Card className="p-4 space-y-3">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 items-end">
              <div className="space-y-1.5">
                <label
                  htmlFor={cutoffInputId}
                  className="block text-sm font-medium text-foreground"
                >
                  Ngày chốt số dư đầu kỳ chung (Cutoff date){" "}
                  <span className="text-rose-600">*</span>
                </label>
                <input
                  id={cutoffInputId}
                  type="date"
                  value={cutoffDate}
                  onChange={(e) => {
                    setCutoffDate(e.target.value);
                    setWizardError(null);
                    rotateKey();
                  }}
                  className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </div>

              <div className="sm:col-span-1 lg:col-span-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-muted/50 px-3.5 py-2.5 text-xs">
                <div>
                  <p className="font-medium text-foreground">
                    Đã nhập trong lô hiện tại:{" "}
                    <span className="font-mono">
                      {filledDraftCount} / {VFIN_UI_MAX_OPENING_BATCH_ITEMS}
                    </span>{" "}
                    Vendor
                  </p>
                  <p className="text-muted">
                    Nhập số tiền VND nguyên dương (dòng nhập <code className="font-mono">0</code>{" "}
                    sẽ được hệ thống tự động bỏ qua khi tạo chứng từ).
                  </p>
                </div>
                <Button
                  variant="primary"
                  loading={previewLoading}
                  disabled={filledDraftCount === 0 || previewLoading}
                  data-testid="vfin-opening-preview-btn"
                  onClick={() => void handleRunPreview()}
                >
                  <Eye className="h-4 w-4" aria-hidden />
                  Xem trước nguyên lô ({filledDraftCount})
                </Button>
              </div>
            </div>
          </Card>

          {/* Selected Batch Rows Summary (if user entered rows across pages) */}
          {filledDraftCount > 0 ? (
            <Card className="p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-foreground">
                  Danh sách Vendor đã đưa vào lô nháp ({filledDraftCount})
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraftMap({});
                    setWizardError(null);
                    rotateKey();
                  }}
                >
                  Xóa toàn bộ lô nháp
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {draftEntries
                  .filter((r) => r.amount_input.trim().length > 0)
                  .map((r) => {
                    const parsedAmt = normalizeNonNegativeVndInput(r.amount_input);
                    return (
                      <div
                        key={r.vendor_id}
                        className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-muted/60 px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-medium text-foreground">{r.display_name}</span>
                        <StatusBadge
                          tone={r.entry_type === "OPENING_PAYABLE" ? "warning" : "info"}
                        >
                          {r.entry_type === "OPENING_PAYABLE" ? "Phải trả" : "Dư ứng"}
                        </StatusBadge>
                        <span className="font-mono text-foreground">
                          {parsedAmt.ok ? formatVndMinor(parsedAmt.canonical) : r.amount_input}
                        </span>
                        <button
                          type="button"
                          aria-label={`Xóa ${r.display_name} khỏi lô đầu kỳ`}
                          onClick={() => removeDraftRow(r.vendor_id)}
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </div>
                    );
                  })}
              </div>
            </Card>
          ) : null}

          <FilterToolbar
            summary={
              <span aria-live="polite" className="font-mono tabular-nums">
                {listLoading
                  ? "Đang tải danh sách Vendor đủ điều kiện khởi tạo…"
                  : listData
                    ? `Có ${listData.total} Vendor chưa khởi tạo đầu kỳ`
                    : "Chưa có dữ liệu"}
              </span>
            }
            actions={
              <Button
                variant="secondary"
                size="sm"
                disabled={listLoading}
                onClick={() => setReloadNonce((n) => n + 1)}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                Làm mới danh sách
              </Button>
            }
          >
            <div className="max-w-md space-y-1">
              <label htmlFor={searchInputId} className="block text-xs font-medium text-muted">
                Tìm Vendor chưa khởi tạo
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
                  placeholder="Tìm theo tên hoặc mã Vendor…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface pl-9 pr-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </div>
            </div>
          </FilterToolbar>

          {listError ? (
            <Alert tone="error" role="alert" title="Không thể tải danh sách Vendor">
              <p>{listError}</p>
            </Alert>
          ) : listLoading && !listData ? (
            <Card className="p-8 text-center">
              <p role="status" aria-live="polite" className="text-sm text-muted">
                Đang tải danh sách Vendor đủ điều kiện mở số dư đầu kỳ…
              </p>
            </Card>
          ) : listData && listData.vendors.length === 0 ? (
            <Card className="p-8 text-center space-y-2">
              <p className="text-sm font-medium text-foreground">
                Không có Vendor chưa khởi tạo nào khớp điều kiện tìm kiếm.
              </p>
              <p className="text-xs text-muted">
                Các Vendor đã có bút toán đầu kỳ hoặc đã phát sinh giao dịch sẽ không xuất hiện
                trong danh sách khởi tạo một lần.
              </p>
            </Card>
          ) : listData ? (
            <DataTableContainer
              dataTestId="vfin-opening-eligible-table"
              footer={
                <OffsetPager
                  page={listData.page}
                  pageCount={pageCount}
                  total={listData.total}
                  ariaLabel="Phân trang Vendor chưa khởi tạo"
                  disabled={listLoading}
                  nextDisabled={
                    listLoading || (!listData.has_more && listData.page >= pageCount)
                  }
                  onPageChange={(next) => setPage(next)}
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
                      Trạng thái
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Loại số dư đầu kỳ
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Số tiền đầu kỳ (VND)
                    </th>
                    <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                      Xem trước hiển thị
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {listData.vendors.map((vendor) => {
                    const rowState = draftMap[vendor.vendor_id];
                    const selectedType = rowState?.entry_type ?? "OPENING_PAYABLE";
                    const amountText = rowState?.amount_input ?? "";
                    const parsedAmt =
                      amountText.trim().length > 0
                        ? normalizeNonNegativeVndInput(amountText)
                        : null;

                    return (
                      <tr key={vendor.vendor_id} className={DATA_TABLE_ROW_CLASS}>
                        <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                          <div className="space-y-0.5">
                            <p className="font-semibold text-foreground">{vendor.display_name}</p>
                            <p className="font-mono text-xs text-muted">{vendor.vendor_id}</p>
                          </div>
                        </td>

                        <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                          <StatusBadge tone={vendor.active ? "success" : "neutral"} dot>
                            {vendor.active ? "Đang hoạt động" : "Ngừng hoạt động"}
                          </StatusBadge>
                        </td>

                        <td data-label="Loại đầu kỳ" className={DATA_TABLE_TD_CLASS}>
                          <select
                            aria-label={`Loại số dư đầu kỳ của ${vendor.display_name}`}
                            value={selectedType}
                            disabled={!vendor.eligible_for_opening}
                            onChange={(e) =>
                              upsertDraftRow(vendor, {
                                entry_type: e.target.value as OpeningVendorFinanceEntryType,
                              })
                            }
                            className="min-h-11 sm:min-h-9 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                          >
                            {VFIN_UI_OPENING_ENTRY_TYPES.map((type) => (
                              <option key={type} value={type}>
                                {ENTRY_TYPE_LABELS_VI[type]}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td data-label="Số tiền (VND)" className={DATA_TABLE_TD_CLASS}>
                          <input
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            aria-label={`Số tiền đầu kỳ của ${vendor.display_name}`}
                            placeholder="Để trống hoặc nhập VND"
                            value={amountText}
                            disabled={!vendor.eligible_for_opening}
                            onChange={(e) =>
                              upsertDraftRow(vendor, { amount_input: e.target.value })
                            }
                            className="min-h-11 sm:min-h-9 w-full max-w-56 rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-xs sm:text-sm tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                          />
                        </td>

                        <td
                          data-label="Hiển thị"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono text-xs sm:text-sm tabular-nums`}
                        >
                          {!parsedAmt ? (
                            <span className="text-muted">Chưa chọn</span>
                          ) : !parsedAmt.ok ? (
                            <span className="text-rose-600 dark:text-rose-300">Không hợp lệ</span>
                          ) : parsedAmt.canonical === "0" ? (
                            <span className="text-muted">0 ₫ (Bỏ qua)</span>
                          ) : (
                            <span className="font-semibold text-foreground">
                              {selectedType === "OPENING_PAYABLE" ? "+" : "-"}
                              {formatVndMinor(parsedAmt.canonical)}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </DataTableContainer>
          ) : null}
        </div>
      ) : null}

      {/* =====================================================================
          STEP 2: SERVER PREVIEW
         ===================================================================== */}
      {step === "preview" && previewData ? (
        <div className="space-y-4" data-testid="vfin-opening-step-preview">
          <Alert tone="info" title="Kết quả kiểm tra xem trước từ máy chủ">
            <p>
              Máy chủ đã xác thực tính hợp lệ của toàn bộ lô tại ngày chốt{" "}
              <strong className="font-mono">
                {formatVietnamDateLabel(previewData.cutoff_date)}
              </strong>
              . Vui lòng rà soát kỹ từng dòng trước khi chuyển sang bước xác nhận.
            </p>
          </Alert>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-4">
              <p className="text-xs text-muted">Số Vendor sẽ tạo bút toán</p>
              <p className="mt-1 font-mono text-xl font-semibold text-foreground">
                {previewData.vendor_count}
              </p>
              <p className="mt-1 text-xs text-muted">
                Đã bỏ qua {previewData.skipped_zero_count} dòng 0 ₫
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted">Tổng đầu kỳ phải trả</p>
              <p className="mt-1 font-mono text-xl font-semibold text-foreground">
                {formatVndMinor(previewData.total_payable_minor)}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted">Tổng đầu kỳ dư ứng</p>
              <p className="mt-1 font-mono text-xl font-semibold text-foreground">
                {formatVndMinor(previewData.total_advance_minor)}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted">Số dư ròng của lô</p>
              <p className="mt-1 font-mono text-xl font-semibold text-foreground">
                {formatSignedVndDelta(previewData.net_balance_minor)}
              </p>
            </Card>
          </div>

          <DataTableContainer dataTestId="vfin-opening-preview-table">
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Vendor
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Trạng thái Vendor
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Loại bút toán đầu kỳ
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Số tiền gốc
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Tác động sổ cái
                  </th>
                </tr>
              </thead>
              <tbody>
                {previewData.items.map((item) => (
                  <tr key={item.vendor_id} className={DATA_TABLE_ROW_CLASS}>
                    <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                      <div className="space-y-0.5">
                        <p className="font-semibold text-foreground">{item.display_name}</p>
                        <p className="font-mono text-xs text-muted">{item.vendor_id}</p>
                      </div>
                    </td>
                    <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                      <StatusBadge tone={item.active ? "success" : "neutral"}>
                        {item.active ? "Đang hoạt động" : "Ngừng hoạt động"}
                      </StatusBadge>
                    </td>
                    <td data-label="Loại đầu kỳ" className={DATA_TABLE_TD_CLASS}>
                      <StatusBadge
                        tone={item.entry_type === "OPENING_PAYABLE" ? "warning" : "info"}
                      >
                        {ENTRY_TYPE_LABELS_VI[item.entry_type]}
                      </StatusBadge>
                    </td>
                    <td
                      data-label="Số tiền gốc"
                      className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                    >
                      {formatVndMinor(item.amount_minor)}
                    </td>
                    <td
                      data-label="Tác động sổ cái"
                      className={`${DATA_TABLE_TD_CLASS} text-right font-mono font-semibold tabular-nums`}
                    >
                      {formatSignedVndDelta(item.balance_delta_minor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTableContainer>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setWizardError(null);
                setStep("input");
              }}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Quay lại chỉnh sửa
            </Button>
            <Button
              variant="primary"
              data-testid="vfin-opening-to-confirm-btn"
              onClick={() => {
                setWizardError(null);
                setStep("confirm");
              }}
            >
              Tiếp tục bước xác nhận
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}

      {/* =====================================================================
          STEP 3: CONFIRM & APPLY ATOMIC BATCH
         ===================================================================== */}
      {step === "confirm" && previewData ? (
        <div className="space-y-4" data-testid="vfin-opening-step-confirm">
          <Alert tone="warning" title="Lưu ý quan trọng trước khi ghi sổ đầu kỳ">
            <p className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                Mỗi Vendor chỉ được khởi tạo số dư đầu kỳ một lần duy nhất. Lô sẽ được thực thi
                nguyên tử (atomic): nếu bất kỳ Vendor nào phát sinh giao dịch song song, toàn bộ lô
                sẽ tự động hủy để bảo toàn tính toàn vẹn sổ cái.
              </span>
            </p>
          </Alert>

          <Card className="p-5 space-y-4">
            <div className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-surface-muted/50 p-3.5 text-xs sm:grid-cols-4">
              <div>
                <p className="text-muted">Ngày chốt đầu kỳ</p>
                <p className="mt-0.5 font-mono text-sm font-semibold text-foreground">
                  {formatVietnamDateLabel(previewData.cutoff_date)}
                </p>
              </div>
              <div>
                <p className="text-muted">Số chứng từ đầu kỳ sẽ tạo</p>
                <p className="mt-0.5 font-mono text-sm font-semibold text-foreground">
                  {previewData.vendor_count} chứng từ
                </p>
              </div>
              <div>
                <p className="text-muted">Tổng phải trả / Tổng dư ứng</p>
                <p className="mt-0.5 font-mono text-sm font-semibold text-foreground">
                  {formatVndMinor(previewData.total_payable_minor)} /{" "}
                  {formatVndMinor(previewData.total_advance_minor)}
                </p>
              </div>
              <div>
                <p className="text-muted">Số dư ròng toàn lô</p>
                <p className="mt-0.5 font-mono text-sm font-semibold text-foreground">
                  {formatSignedVndDelta(previewData.net_balance_minor)}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor={reasonInputId} className="block text-sm font-medium text-foreground">
                Lý do / Căn cứ chốt số dư đầu kỳ <span className="text-rose-600">*</span>
              </label>
              <textarea
                id={reasonInputId}
                rows={3}
                maxLength={VFIN_UI_MAX_REASON_LENGTH}
                disabled={applyLoading}
                placeholder="Ví dụ: Chốt công nợ và tạm ứng tồn đầu kỳ theo biên bản bàn giao kế toán ngày…"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setWizardError(null);
                  rotateKey();
                }}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  disabled={applyLoading}
                  onClick={() => {
                    setWizardError(null);
                    setStep("preview");
                  }}
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                  Quay lại xem trước
                </Button>
                <Button
                  variant="ghost"
                  disabled={applyLoading}
                  onClick={() => {
                    setWizardError(null);
                    setStep("input");
                  }}
                >
                  Sửa danh sách dòng
                </Button>
              </div>

              <Button
                variant="primary"
                loading={applyLoading}
                disabled={applyLoading}
                data-testid="vfin-opening-apply-btn"
                onClick={() => void handleConfirmApply()}
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                Xác nhận khởi tạo nguyên lô
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {/* =====================================================================
          POST-APPLY RESULT SUMMARY & VOUCHER LINKS
         ===================================================================== */}
      {step === "applied" && appliedData ? (
        <div className="space-y-4" data-testid="vfin-opening-step-applied">
          <div className="rounded-2xl border border-emerald-500/35 bg-emerald-500/10 p-5 space-y-2">
            <div className="flex items-center gap-2 text-base font-semibold text-foreground">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden />
              <span>Đã khởi tạo thành công lô số dư đầu kỳ</span>
            </div>
            <p className="text-xs sm:text-sm text-muted">
              Mã lô: <span className="font-mono text-foreground">{appliedData.batch.batch_id}</span>{" "}
              · Ngày chốt:{" "}
              <span className="font-mono text-foreground">
                {formatVietnamDateLabel(appliedData.batch.cutoff_date)}
              </span>{" "}
              · Người lập: <strong className="text-foreground">{appliedData.batch.created_by_display_name}</strong>{" "}
              ({formatTimestampVi(appliedData.batch.created_at)})
            </p>
          </div>

          <DataTableContainer dataTestId="vfin-opening-applied-entries-table">
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Số chứng từ
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Vendor
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Loại đầu kỳ
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Số dư sau khởi tạo
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody>
                {appliedData.entries.map((entry) => (
                  <tr key={entry.entry_id} className={DATA_TABLE_ROW_CLASS}>
                    <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                      <span className="font-mono font-semibold text-foreground">
                        {entry.document_no}
                      </span>
                    </td>
                    <td data-label="Vendor" className={DATA_TABLE_TD_CLASS}>
                      <Link
                        href={`/finance/vendors/${encodeURIComponent(entry.vendor_id)}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {entry.vendor_display_name_snapshot}
                      </Link>
                    </td>
                    <td data-label="Loại đầu kỳ" className={DATA_TABLE_TD_CLASS}>
                      <StatusBadge
                        tone={entry.entry_type === "OPENING_PAYABLE" ? "warning" : "info"}
                      >
                        {ENTRY_TYPE_LABELS_VI[entry.entry_type]}
                      </StatusBadge>
                    </td>
                    <td
                      data-label="Số dư sau khởi tạo"
                      className={`${DATA_TABLE_TD_CLASS} text-right font-mono font-semibold tabular-nums`}
                    >
                      {formatSignedVndDelta(entry.balance_after_minor)}
                    </td>
                    <td
                      data-card-actions="true"
                      className={`${DATA_TABLE_TD_CLASS} text-right`}
                    >
                      <Link
                        href={`/finance/documents/${encodeURIComponent(entry.entry_id)}`}
                        className={buttonClasses({ variant: "secondary", size: "sm" })}
                      >
                        <Printer className="h-3.5 w-3.5" aria-hidden />
                        In chứng từ
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTableContainer>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setAppliedData(null);
                setPreviewData(null);
                setReason("");
                rotateKey();
                setReloadNonce((n) => n + 1);
                setStep("input");
              }}
            >
              Khởi tạo tiếp lô Vendor khác
            </Button>
            <Link
              href="/finance/vendors"
              className={buttonClasses({ variant: "primary", size: "md" })}
            >
              Về danh sách tài chính Vendor
            </Link>
          </div>
        </div>
      ) : null}
    </PageShell>
  );
}
