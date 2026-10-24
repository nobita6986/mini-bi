"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Eye,
  FileSpreadsheet,
  ImagePlus,
  Layers,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  Scale,
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
import { OffsetPager } from "@/components/ui/offset-pager";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import type {
  NormalVendorFinanceEntryType,
  VendorFinanceActorContextOptionsResponse,
  VendorFinanceDetailSubLedger,
  VendorFinanceEntryProjection,
  VendorFinanceEntryType,
  VendorFinanceEvidenceSummary,
  VendorFinanceEvidenceTargetKind,
  VendorFinanceLedgerScope,
  VendorFinanceReconciliationProjection,
  VendorFinanceReconciliationsPageResponse,
  VendorFinanceVendorDetailResponse,
} from "@/lib/vendor-finance/vendor-finance-contract";
import {
  buildVendorDetailUrl,
  buildVendorEntriesUrl,
  buildVendorFinanceContextUrl,
  buildVendorReconciliationsUrl,
  classifyVendorFinanceError,
  ENTRY_TYPE_LABELS_VI,
  formatSignedVndDelta,
  formatTimestampVi,
  formatVendorBalancePresentation,
  formatVietnamDateLabel,
  formatVndMinor,
  isCanonicalUiProjectId,
  isUuidString,
  parseVendorDetailEnvelope,
  parseVendorEntriesPageEnvelope,
  parseVendorFinanceContextEnvelope,
  parseVendorReconciliationsPageEnvelope,
  VFIN_UI_ENTRY_TYPES,
} from "@/lib/vendor-finance/ui-model";

import {
  CreateVendorReconciliationDialog,
  RecordVendorEntryDialog,
  ReverseVendorEntryDialog,
} from "./vendor-finance-entry-dialogs";
import {
  VendorEvidenceAttachDialog,
  VendorEvidenceViewerDialog,
} from "./vendor-finance-evidence-dialog";

const ENTRIES_PAGE_SIZE = 25;
const RECONCILIATIONS_PAGE_SIZE = 15;

type DetailTab = "ledger" | "reconciliations";

type SelectedScopeFilter = {
  ledgerScope: VendorFinanceLedgerScope | null;
  projectId: string | null;
  accountantRef: string | null;
};

function parseInitialScopeFilter(searchParams: URLSearchParams): SelectedScopeFilter {
  const rawScope = searchParams.get("ledgerScope");
  const rawProject = searchParams.get("projectId");
  const rawAccountant = searchParams.get("accountantRef");

  if (rawScope === "LEGACY_UNALLOCATED") {
    return { ledgerScope: "LEGACY_UNALLOCATED", projectId: null, accountantRef: null };
  }
  const projectId = rawProject && isCanonicalUiProjectId(rawProject) ? rawProject : null;
  const accountantRef =
    rawAccountant && isUuidString(rawAccountant) ? rawAccountant.toLowerCase() : null;
  if (rawScope === "PROJECT_ACCOUNTANT" || projectId || accountantRef) {
    return {
      ledgerScope: "PROJECT_ACCOUNTANT",
      projectId,
      accountantRef,
    };
  }
  return { ledgerScope: null, projectId: null, accountantRef: null };
}

function subLedgerKey(sub: VendorFinanceDetailSubLedger): string {
  return `${sub.ledger_scope}:${sub.project_id ?? "legacy"}:${sub.accountant_ref ?? "none"}`;
}

export function VendorFinanceDetailView({
  vendorId,
  initialCanRecord = false,
  initialCanReconcile = false,
  initialCanManageProjectAssignments = false,
}: {
  vendorId: string;
  initialCanRecord?: boolean;
  initialCanReconcile?: boolean;
  initialCanManageProjectAssignments?: boolean;
}) {
  const searchParams = useSearchParams();
  const entryTypeFilterId = useId();
  const ledgerTabId = useId();
  const recTabId = useId();
  const ledgerPanelId = useId();
  const recPanelId = useId();
  const ledgerTabRef = useRef<HTMLButtonElement | null>(null);
  const recTabRef = useRef<HTMLButtonElement | null>(null);

  const [scopeFilter, setScopeFilter] = useState<SelectedScopeFilter>(() =>
    parseInitialScopeFilter(searchParams),
  );
  const [activeTab, setActiveTab] = useState<DetailTab>("ledger");
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Context options (recordable projects + linked vendors)
  const [contextData, setContextData] =
    useState<VendorFinanceActorContextOptionsResponse | null>(null);

  // Vendor detail summary state
  const [detail, setDetail] = useState<VendorFinanceVendorDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Keyset-paginated ledger state
  const [entryTypeFilter, setEntryTypeFilter] = useState<VendorFinanceEntryType | "">("");
  const [entries, setEntries] = useState<VendorFinanceEntryProjection[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMoreEntries, setHasMoreEntries] = useState(false);
  const [entriesLoading, setEntriesLoading] = useState(true);
  const [loadingMoreEntries, setLoadingMoreEntries] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);

  // Offset-paginated reconciliations state
  const [recPage, setRecPage] = useState(1);
  const [recData, setRecData] = useState<VendorFinanceReconciliationsPageResponse | null>(null);
  const [recLoading, setRecLoading] = useState(true);
  const [recError, setRecError] = useState<string | null>(null);

  // Dialog states
  const [recordDialogOpen, setRecordDialogOpen] = useState(false);
  const [recordInitialType, setRecordInitialType] =
    useState<NormalVendorFinanceEntryType | undefined>(undefined);
  const [reversingEntry, setReversingEntry] = useState<VendorFinanceEntryProjection | null>(null);
  const [reconcileDialogOpen, setReconcileDialogOpen] = useState(false);

  const [viewingEvidence, setViewingEvidence] = useState<{
    evidence: VendorFinanceEvidenceSummary;
    label: string;
  } | null>(null);
  const [attachingEvidence, setAttachingEvidence] = useState<{
    targetKind: VendorFinanceEvidenceTargetKind;
    targetId: string;
    label: string;
  } | null>(null);

  const triggerReloadAll = () => setRefreshNonce((n) => n + 1);

  // 0. Load Actor Context Options
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
        // Supplementary context
      }
    }

    void loadContext();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [refreshNonce]);

  // 1. Load Vendor Detail Summary (with sub-ledger scope)
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadDetail() {
      await Promise.resolve();
      if (cancelled) return;
      setDetailLoading(true);
      setDetailError(null);

      try {
        const res = await fetch(
          buildVendorDetailUrl(vendorId, {
            ledger_scope: scopeFilter.ledgerScope,
            project_id: scopeFilter.projectId,
            accountant_ref: scopeFilter.accountantRef,
          }),
          {
            method: "GET",
            signal: controller.signal,
            cache: "no-store",
          },
        );
        const json: unknown = await res.json().catch(() => null);
        if (cancelled) return;

        if (!res.ok) {
          const classified = classifyVendorFinanceError(json, res.status);
          setDetailError(classified.message);
          setDetailLoading(false);
          return;
        }

        const parsed = parseVendorDetailEnvelope(json);
        if (!parsed) {
          setDetailError("Dữ liệu chi tiết Vendor từ máy chủ không đúng chuẩn hợp đồng.");
          setDetailLoading(false);
          return;
        }
        setDetail(parsed);
        setDetailLoading(false);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setDetailError("Không thể tải thông tin Vendor do lỗi kết nối mạng.");
        setDetailLoading(false);
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [vendorId, scopeFilter, refreshNonce]);

  // 2. Load First Page of Ledger Entries (strictly bound to current scopeFilter)
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadFirstEntriesPage() {
      await Promise.resolve();
      if (cancelled) return;
      setEntriesLoading(true);
      setEntriesError(null);

      try {
        const url = buildVendorEntriesUrl(vendorId, {
          entry_type: entryTypeFilter || null,
          page_size: ENTRIES_PAGE_SIZE,
          ledger_scope: scopeFilter.ledgerScope,
          project_id: scopeFilter.projectId,
          accountant_ref: scopeFilter.accountantRef,
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
          setEntriesError(classified.message);
          setEntriesLoading(false);
          return;
        }

        const parsed = parseVendorEntriesPageEnvelope(json);
        if (!parsed) {
          setEntriesError("Dữ liệu sổ cái giao dịch từ máy chủ không hợp lệ.");
          setEntriesLoading(false);
          return;
        }

        setEntries([...parsed.entries]);
        setNextCursor(parsed.next_cursor);
        setHasMoreEntries(parsed.has_more);
        setEntriesLoading(false);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setEntriesError("Không thể tải sổ cái giao dịch do lỗi kết nối mạng.");
        setEntriesLoading(false);
      }
    }

    void loadFirstEntriesPage();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [vendorId, scopeFilter, entryTypeFilter, refreshNonce]);

  // 3. Load Reconciliations Page (strictly bound to current scopeFilter)
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadReconciliations() {
      await Promise.resolve();
      if (cancelled) return;
      setRecLoading(true);
      setRecError(null);

      try {
        const url = buildVendorReconciliationsUrl(vendorId, {
          page: recPage,
          page_size: RECONCILIATIONS_PAGE_SIZE,
          ledger_scope: scopeFilter.ledgerScope,
          project_id: scopeFilter.projectId,
          accountant_ref: scopeFilter.accountantRef,
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
          setRecError(classified.message);
          setRecLoading(false);
          return;
        }

        const parsed = parseVendorReconciliationsPageEnvelope(json);
        if (!parsed) {
          setRecError("Dữ liệu lịch sử đối soát từ máy chủ không hợp lệ.");
          setRecLoading(false);
          return;
        }

        setRecData(parsed);
        setRecLoading(false);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setRecError("Không thể tải lịch sử đối soát do lỗi kết nối mạng.");
        setRecLoading(false);
      }
    }

    void loadReconciliations();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [vendorId, scopeFilter, recPage, refreshNonce]);

  const handleLoadMoreEntries = async () => {
    if (!nextCursor || loadingMoreEntries) return;
    setLoadingMoreEntries(true);
    setEntriesError(null);

    try {
      const url = buildVendorEntriesUrl(vendorId, {
        cursor: nextCursor,
        entry_type: entryTypeFilter || null,
        page_size: ENTRIES_PAGE_SIZE,
        ledger_scope: scopeFilter.ledgerScope,
        project_id: scopeFilter.projectId,
        accountant_ref: scopeFilter.accountantRef,
      });
      const res = await fetch(url, { method: "GET", cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const classified = classifyVendorFinanceError(json, res.status);
        setEntriesError(classified.message);
        setLoadingMoreEntries(false);
        return;
      }

      const parsed = parseVendorEntriesPageEnvelope(json);
      if (!parsed) {
        setEntriesError("Phản hồi phân trang sổ cái từ máy chủ không hợp lệ.");
        setLoadingMoreEntries(false);
        return;
      }

      setEntries((prev) => {
        const existingIds = new Set(prev.map((item) => item.entry_id));
        const merged = [...prev];
        for (const item of parsed.entries) {
          if (!existingIds.has(item.entry_id)) {
            merged.push(item);
          }
        }
        return merged;
      });
      setNextCursor(parsed.next_cursor);
      setHasMoreEntries(parsed.has_more);
      setLoadingMoreEntries(false);
    } catch {
      setEntriesError("Mất kết nối mạng khi tải thêm bút toán sổ cái.");
      setLoadingMoreEntries(false);
    }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const next: DetailTab = activeTab === "ledger" ? "reconciliations" : "ledger";
      setActiveTab(next);
      if (next === "ledger") {
        ledgerTabRef.current?.focus();
      } else {
        recTabRef.current?.focus();
      }
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveTab("ledger");
      ledgerTabRef.current?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveTab("reconciliations");
      recTabRef.current?.focus();
    }
  };

  const handleSelectSubLedger = (sub: VendorFinanceDetailSubLedger | null) => {
    setRecPage(1);
    if (!sub) {
      setScopeFilter({ ledgerScope: null, projectId: null, accountantRef: null });
      return;
    }
    setScopeFilter({
      ledgerScope: sub.ledger_scope,
      projectId: sub.project_id,
      accountantRef: sub.accountant_ref,
    });
  };

  const vendor = detail?.vendor ?? null;
  const subLedgers = detail?.sub_ledgers ?? [];
  const selectedSubLedger = detail?.selected_sub_ledger ?? null;
  const allowedActions = detail?.allowed_actions ?? null;
  const canRecord = allowedActions ? allowedActions.can_record : initialCanRecord;
  const canReconcile = allowedActions ? allowedActions.can_reconcile : initialCanReconcile;
  const canManageProjectAssignments = allowedActions
    ? allowedActions.can_manage_project_assignments
    : initialCanManageProjectAssignments;
  const allowedEntryTypes = allowedActions?.allowed_entry_types ?? [];

  // Projects where current actor can record for this specific vendor
  const recordableProjectsForVendor = (contextData?.projects ?? []).filter(
    (p) =>
      p.can_record_for_project &&
      p.has_active_accountant &&
      p.linked_vendors.some((lv) => lv.vendor_id === vendorId),
  );

  // Sub-ledgers where current actor can reconcile
  const reconcilableSubLedgers = subLedgers.filter(
    (s) => s.ledger_scope === "PROJECT_ACCOUNTANT" && s.can_reconcile && s.project_id !== null,
  );

  const openingTargetProjectId =
    selectedSubLedger?.eligible_for_opening && selectedSubLedger.project_id
      ? selectedSubLedger.project_id
      : subLedgers.find((s) => s.eligible_for_opening && s.project_id)?.project_id ?? null;

  const balancePresentation = vendor
    ? formatVendorBalancePresentation({
        current_balance_minor: vendor.current_balance_minor,
        balance_direction: vendor.balance_direction,
        entry_count: vendor.entry_count,
        has_opening_entry: vendor.has_opening_entry,
        sub_ledger_count: subLedgers.length,
      })
    : null;

  const recPageCount = recData ? Math.max(1, Math.ceil(recData.total / recData.page_size)) : 1;

  return (
    <PageShell dataTestId="vfin-vendor-detail-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/finance/vendors"
          className="inline-flex min-h-11 sm:min-h-8 items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Danh sách tài chính Vendor
        </Link>
        {canManageProjectAssignments ? (
          <Link
            href="/finance/project-assignments"
            className="text-xs font-medium text-primary hover:underline"
          >
            Quản lý phân công dự án & liên kết Vendor →
          </Link>
        ) : null}
      </div>

      <PageHeader
        eyebrow={`Mã Vendor: ${vendorId}`}
        title={vendor ? vendor.display_name : "Chi tiết tài chính Vendor"}
        badge={
          <div className="flex flex-wrap items-center gap-2">
            {vendor ? (
              <StatusBadge tone={vendor.active ? "success" : "neutral"} dot>
                {vendor.active ? "Đang hoạt động" : "Ngừng hoạt động"}
              </StatusBadge>
            ) : null}
            {balancePresentation ? (
              <StatusBadge tone={balancePresentation.tone}>
                {balancePresentation.statusLabel}
              </StatusBadge>
            ) : null}
            {!canRecord ? (
              <StatusBadge tone="info" dataTestId="vfin-detail-view-only-badge">
                {canReconcile ? "Xem & Đối soát (Không ghi sổ)" : "Chế độ chỉ xem"}
              </StatusBadge>
            ) : null}
          </div>
        }
        description="Sổ cái bất biến (append-only) tách riêng theo từng cặp Dự án × Kế toán phụ trách; không bù trừ số dư giữa các dự án hoặc kế toán khác nhau."
        actions={
          <>
            <Button
              variant="secondary"
              disabled={detailLoading || entriesLoading || recLoading}
              onClick={triggerReloadAll}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Làm mới
            </Button>

            {vendor && vendor.eligible_for_opening && canRecord ? (
              <Link
                href={
                  openingTargetProjectId
                    ? `/finance/opening-balance?projectId=${encodeURIComponent(openingTargetProjectId)}&vendorId=${encodeURIComponent(vendor.vendor_id)}`
                    : `/finance/opening-balance?vendorId=${encodeURIComponent(vendor.vendor_id)}`
                }
                className={buttonClasses({ variant: "soft", size: "md" })}
              >
                <FileSpreadsheet className="h-4 w-4" aria-hidden />
                Khởi tạo đầu kỳ
              </Link>
            ) : null}

            {vendor && canReconcile ? (
              <Button
                variant="secondary"
                disabled={reconcilableSubLedgers.length === 0}
                data-testid="vfin-open-reconcile-btn"
                onClick={() => setReconcileDialogOpen(true)}
              >
                <Scale className="h-4 w-4" aria-hidden />
                Đối soát theo ngày
              </Button>
            ) : null}

            {vendor && canRecord && allowedEntryTypes.length > 0 ? (
              <Button
                variant="primary"
                data-testid="vfin-open-record-entry-btn"
                onClick={() => {
                  setRecordInitialType(allowedEntryTypes[0]);
                  setRecordDialogOpen(true);
                }}
              >
                <Plus className="h-4 w-4" aria-hidden />
                Ghi nhận khoản tiền
              </Button>
            ) : null}
          </>
        }
      />

      {detailError ? (
        <div className="space-y-3">
          <Alert tone="error" role="alert" title="Không thể tải chi tiết tài chính Vendor">
            <p>{detailError}</p>
          </Alert>
          <div>
            <Button variant="primary" onClick={triggerReloadAll}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Thử lại
            </Button>
          </div>
        </div>
      ) : null}

      {vendor && !vendor.active ? (
        <Alert tone="warning" title="Vendor đang ở trạng thái Ngừng hoạt động">
          <p>
            Không phát sinh mới công nợ hoặc lương trên Vendor ngừng hoạt động; hệ thống chỉ mở các
            bút toán tất toán / điều chỉnh theo danh sách loại bút toán được máy chủ cấp phép.
          </p>
        </Alert>
      ) : null}

      {/* =====================================================================
          SUB-LEDGER SWITCHER (Dự án × Kế toán phụ trách — Không bù trừ chéo)
         ===================================================================== */}
      {subLedgers.length > 0 ? (
        <Card className="p-4">
          <div data-testid="vfin-subledger-switcher" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-primary" aria-hidden />
              <h2 className="text-sm font-semibold text-foreground">
                Sổ chi tiết theo Dự án × Kế toán phụ trách ({subLedgers.length} sổ độc lập)
              </h2>
            </div>
            <p className="text-xs text-muted">
              Chọn từng sổ để xem đúng số dư, lịch sử chứng từ và đối soát riêng của kế toán phụ
              trách.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {subLedgers.length > 1 ? (
              <button
                type="button"
                onClick={() => handleSelectSubLedger(null)}
                className={`rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                  selectedSubLedger === null
                    ? "border-primary bg-primary/10"
                    : "border-border bg-surface hover:border-primary/40"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-foreground">
                    Tất cả sổ trong phạm vi xem
                  </span>
                  <StatusBadge tone="info">{subLedgers.length} sổ riêng</StatusBadge>
                </div>
                <p className="mt-1 text-xs text-muted">
                  Xem dòng thời gian chung — không gộp số dư giữa các kế toán/dự án
                </p>
              </button>
            ) : null}

            {subLedgers.map((sub) => {
              const isSelected =
                selectedSubLedger !== null &&
                subLedgerKey(selectedSubLedger) === subLedgerKey(sub);
              const subPresentation = formatVendorBalancePresentation({
                current_balance_minor: sub.current_balance_minor,
                balance_direction: sub.balance_direction,
                entry_count: sub.entry_count,
                has_opening_entry: sub.has_opening_entry,
              });
              return (
                <button
                  key={subLedgerKey(sub)}
                  type="button"
                  onClick={() => handleSelectSubLedger(sub)}
                  className={`rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                    isSelected
                      ? "border-primary bg-primary/10"
                      : "border-border bg-surface hover:border-primary/40"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-semibold text-foreground">
                        {sub.ledger_scope === "LEGACY_UNALLOCATED"
                          ? "Sổ lịch sử VFIN-01 (Chỉ đọc)"
                          : `${sub.project_display_name ?? sub.project_id}`}
                      </p>
                      <p className="text-[11px] text-muted">
                        {sub.ledger_scope === "LEGACY_UNALLOCATED"
                          ? "Bút toán trước khi phân tách dự án"
                          : `Kế toán sổ: ${sub.responsible_accountant_display_name ?? "—"}${
                              sub.is_active_assignment ? "" : " (Sổ bàn giao cũ)"
                            }`}
                      </p>
                    </div>
                    <StatusBadge tone={subPresentation.tone}>
                      {subPresentation.statusLabel}
                    </StatusBadge>
                  </div>
                  <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border/60 pt-1.5">
                    <span className="font-mono text-sm font-bold tabular-nums text-foreground">
                      {subPresentation.signedText}
                    </span>
                    <span className="font-mono text-[11px] text-muted">
                      {sub.entry_count} bút toán
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
          </div>
        </Card>
      ) : null}

      {/* Summary KPI Cards */}
      <section
        aria-label="Tổng hợp số dư và lũy kế theo nhóm giao dịch"
        className="space-y-3"
        data-testid="vfin-vendor-detail-kpis"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Card className="p-4 border-primary/25 bg-surface">
            <p className="text-xs font-medium text-muted">
              {selectedSubLedger
                ? selectedSubLedger.ledger_scope === "LEGACY_UNALLOCATED"
                  ? "Số dư sổ lịch sử VFIN-01"
                  : `Số dư sổ ${selectedSubLedger.project_display_name ?? selectedSubLedger.project_id}`
                : "Trạng thái số dư các sổ"}
            </p>
            <p
              data-testid="vfin-detail-current-balance"
              className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground"
            >
              {balancePresentation ? balancePresentation.signedText : "—"}
            </p>
            <p className="mt-1 text-xs text-muted">
              {selectedSubLedger && selectedSubLedger.responsible_accountant_display_name
                ? `KT phụ trách: ${selectedSubLedger.responsible_accountant_display_name}`
                : vendor
                  ? `${vendor.entry_count} bút toán trong phạm vi đang xem`
                  : "Đang tải…"}
            </p>
          </Card>

          <Card className="p-4">
            <p className="text-xs font-medium text-muted">Tổng phát sinh công nợ</p>
            <p className="mt-1.5 font-mono text-lg font-semibold tabular-nums text-foreground">
              {vendor ? formatVndMinor(vendor.totals.debt_recorded_minor) : "—"}
            </p>
            <p className="mt-1 text-xs text-muted">Ghi nhận phát sinh (+)</p>
          </Card>

          <Card className="p-4">
            <p className="text-xs font-medium text-muted">Lương đã ghi nhận</p>
            <p className="mt-1.5 font-mono text-lg font-semibold tabular-nums text-foreground">
              {vendor ? formatVndMinor(vendor.totals.payroll_recorded_minor) : "—"}
            </p>
            <p className="mt-1 text-xs text-muted">Bảng lương phải trả (+)</p>
          </Card>

          <Card className="p-4">
            <p className="text-xs font-medium text-muted">Đã thanh toán</p>
            <p className="mt-1.5 font-mono text-lg font-semibold tabular-nums text-foreground">
              {vendor ? formatVndMinor(vendor.totals.payment_recorded_minor) : "—"}
            </p>
            <p className="mt-1 text-xs text-muted">Thanh toán cho Vendor (-)</p>
          </Card>

          <Card className="p-4">
            <p className="text-xs font-medium text-muted">Đã tạm ứng</p>
            <p className="mt-1.5 font-mono text-lg font-semibold tabular-nums text-foreground">
              {vendor ? formatVndMinor(vendor.totals.advance_recorded_minor) : "—"}
            </p>
            <p className="mt-1 text-xs text-muted">Chi tạm ứng (-)</p>
          </Card>
        </div>

        {vendor ? (
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-xs sm:grid-cols-5">
            <div>
              <span className="text-muted">Đầu kỳ phải trả: </span>
              <strong className="font-mono tabular-nums text-foreground">
                {formatVndMinor(vendor.totals.opening_payable_minor)}
              </strong>
            </div>
            <div>
              <span className="text-muted">Đầu kỳ dư ứng: </span>
              <strong className="font-mono tabular-nums text-foreground">
                {formatVndMinor(vendor.totals.opening_advance_minor)}
              </strong>
            </div>
            <div>
              <span className="text-muted">Điều chỉnh tăng: </span>
              <strong className="font-mono tabular-nums text-foreground">
                {formatVndMinor(vendor.totals.adjustment_increase_minor)}
              </strong>
            </div>
            <div>
              <span className="text-muted">Điều chỉnh giảm: </span>
              <strong className="font-mono tabular-nums text-foreground">
                {formatVndMinor(vendor.totals.adjustment_decrease_minor)}
              </strong>
            </div>
            <div>
              <span className="text-muted">Đã hoàn tác: </span>
              <strong className="font-mono tabular-nums text-foreground">
                {vendor.totals.reversed_entry_count} bút toán
              </strong>
            </div>
          </div>
        ) : null}
      </section>

      {/* Accessible Tab Switcher: Ledger vs Reconciliations */}
      <div
        role="tablist"
        aria-label="Chế độ xem chi tiết tài chính Vendor"
        className="flex flex-wrap items-center gap-2 border-b border-border pb-2"
      >
        <button
          ref={ledgerTabRef}
          id={ledgerTabId}
          type="button"
          role="tab"
          aria-selected={activeTab === "ledger"}
          aria-controls={ledgerPanelId}
          tabIndex={activeTab === "ledger" ? 0 : -1}
          onKeyDown={handleTabKeyDown}
          onClick={() => setActiveTab("ledger")}
          className={buttonClasses({
            variant: activeTab === "ledger" ? "soft" : "ghost",
            size: "md",
          })}
        >
          Sổ cái giao dịch {vendor ? `(${vendor.entry_count})` : ""}
        </button>

        <button
          ref={recTabRef}
          id={recTabId}
          type="button"
          role="tab"
          aria-selected={activeTab === "reconciliations"}
          aria-controls={recPanelId}
          tabIndex={activeTab === "reconciliations" ? 0 : -1}
          onKeyDown={handleTabKeyDown}
          onClick={() => setActiveTab("reconciliations")}
          className={buttonClasses({
            variant: activeTab === "reconciliations" ? "soft" : "ghost",
            size: "md",
          })}
        >
          Đối soát theo ngày {recData ? `(${recData.total})` : ""}
        </button>
      </div>

      {/* =====================================================================
          TAB 1: LEDGER ENTRIES (Keyset Paginated)
         ===================================================================== */}
      <section
        id={ledgerPanelId}
        role="tabpanel"
        aria-labelledby={ledgerTabId}
        hidden={activeTab !== "ledger"}
        data-ui-panel-motion="true"
        className="space-y-4"
      >
        <FilterToolbar
          summary={
            <span aria-live="polite" className="font-mono tabular-nums">
              {entriesLoading
                ? "Đang tải sổ cái giao dịch…"
                : `Đang hiển thị ${entries.length} bút toán${hasMoreEntries ? " (còn trang tiếp)" : ""}`}
            </span>
          }
          actions={
            canRecord && allowedEntryTypes.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {allowedEntryTypes.includes("PAYMENT_RECORDED") ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setRecordInitialType("PAYMENT_RECORDED");
                      setRecordDialogOpen(true);
                    }}
                  >
                    + Thanh toán
                  </Button>
                ) : null}
                {allowedEntryTypes.includes("ADVANCE_RECORDED") ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setRecordInitialType("ADVANCE_RECORDED");
                      setRecordDialogOpen(true);
                    }}
                  >
                    + Tạm ứng
                  </Button>
                ) : null}
                {allowedEntryTypes.includes("PAYROLL_RECORDED") ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setRecordInitialType("PAYROLL_RECORDED");
                      setRecordDialogOpen(true);
                    }}
                  >
                    + Lương
                  </Button>
                ) : null}
              </div>
            ) : null
          }
        >
          <div className="max-w-xs space-y-1">
            <label htmlFor={entryTypeFilterId} className="block text-xs font-medium text-muted">
              Lọc theo loại bút toán
            </label>
            <select
              id={entryTypeFilterId}
              value={entryTypeFilter}
              onChange={(e) => setEntryTypeFilter(e.target.value as VendorFinanceEntryType | "")}
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <option value="">Tất cả loại bút toán</option>
              {VFIN_UI_ENTRY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ENTRY_TYPE_LABELS_VI[type]}
                </option>
              ))}
            </select>
          </div>
        </FilterToolbar>

        {entriesError ? (
          <div className="space-y-3">
            <Alert tone="error" role="alert" title="Không thể tải sổ cái giao dịch">
              <p>{entriesError}</p>
            </Alert>
            <Button variant="secondary" onClick={triggerReloadAll}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Thử lại
            </Button>
          </div>
        ) : entriesLoading && entries.length === 0 ? (
          <Card className="p-8 text-center">
            <p role="status" aria-live="polite" className="text-sm text-muted">
              Đang tải sổ cái giao dịch…
            </p>
          </Card>
        ) : entries.length === 0 ? (
          <Card className="p-8 text-center space-y-2">
            <p className="text-sm font-medium text-foreground">
              Chưa có bút toán nào phù hợp trong sổ đang chọn.
            </p>
            <p className="text-xs text-muted">
              {canRecord
                ? "Bạn có thể khởi tạo số dư đầu kỳ cho sổ dự án (nếu chưa mở kỳ) hoặc ghi nhận khoản tiền mới."
                : "Khi kế toán ghi nhận giao dịch vào sổ dự án, lịch sử sổ cái sẽ hiển thị tại đây."}
            </p>
          </Card>
        ) : (
          <DataTableContainer
            dataTestId="vfin-ledger-table"
            footer={
              hasMoreEntries ? (
                <div className="flex justify-center">
                  <CursorLoadMore
                    hasMore={hasMoreEntries}
                    loading={loadingMoreEntries}
                    onLoadMore={() => void handleLoadMoreEntries()}
                    label="Tải thêm bút toán cũ hơn"
                  />
                </div>
              ) : null
            }
          >
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Chứng từ / Sổ dự án
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Ngày hiệu lực
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Loại bút toán & Lý do
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Biến động (VND)
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Số dư sổ sau GD
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Bằng chứng
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const isReversed = entry.reversed_by_entry_id !== null;
                  const isReversal = entry.entry_type === "REVERSAL";
                  const recordedOnBehalf =
                    entry.responsible_accountant_display_name !== null &&
                    entry.created_by_display_name !== entry.responsible_accountant_display_name;

                  return (
                    <tr key={entry.entry_id} className={DATA_TABLE_ROW_CLASS}>
                      <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5">
                          <Link
                            href={`/finance/documents/${encodeURIComponent(entry.entry_id)}`}
                            className="font-mono text-xs sm:text-sm font-semibold text-primary hover:underline"
                          >
                            {entry.document_no}
                          </Link>
                          <p className="text-xs font-medium text-foreground">
                            {entry.ledger_scope === "LEGACY_UNALLOCATED"
                              ? "Sổ lịch sử VFIN-01"
                              : `${entry.project_display_name_snapshot ?? entry.project_id} · KT: ${entry.responsible_accountant_display_name ?? "—"}`}
                          </p>
                          <p className="font-mono text-[11px] text-muted">
                            #{entry.vendor_sequence} · Người nhập: {entry.created_by_display_name}
                            {recordedOnBehalf ? " (Ghi hộ)" : ""}
                          </p>
                        </div>
                      </td>

                      <td data-label="Ngày hiệu lực" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5 text-xs">
                          <p className="font-mono font-medium text-foreground">
                            {formatVietnamDateLabel(entry.effective_date)}
                          </p>
                          <p className="text-muted">{formatTimestampVi(entry.created_at)}</p>
                        </div>
                      </td>

                      <td data-label="Loại & Lý do" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-1 max-w-md">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusBadge tone={isReversal ? "danger" : "primary"}>
                              {ENTRY_TYPE_LABELS_VI[entry.entry_type]}
                            </StatusBadge>
                            {isReversed ? (
                              <StatusBadge tone="warning">
                                Đã hoàn tác bởi {entry.reversed_by_document_no}
                              </StatusBadge>
                            ) : null}
                            {entry.reverses_document_no ? (
                              <StatusBadge tone="neutral">
                                Đảo cho {entry.reverses_document_no}
                              </StatusBadge>
                            ) : null}
                          </div>
                          <p className="text-xs text-foreground break-words">{entry.reason}</p>
                        </div>
                      </td>

                      <td
                        data-label="Biến động (VND)"
                        className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                      >
                        <div className="space-y-0.5">
                          <p className="font-semibold text-foreground">
                            {formatSignedVndDelta(entry.balance_delta_minor)}
                          </p>
                          <p className="text-xs text-muted">
                            Gốc: {formatVndMinor(entry.amount_minor)}
                          </p>
                        </div>
                      </td>

                      <td
                        data-label="Số dư sổ sau GD"
                        className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                      >
                        <div className="space-y-0.5">
                          <p className="font-semibold text-foreground">
                            {formatVndMinor(entry.balance_after_minor)}
                          </p>
                          <p className="text-xs text-muted">
                            Trước: {formatVndMinor(entry.balance_before_minor)}
                          </p>
                        </div>
                      </td>

                      <td data-label="Bằng chứng" className={DATA_TABLE_TD_CLASS}>
                        {entry.evidence ? (
                          <StatusBadge tone="success" dot>
                            Có ảnh
                          </StatusBadge>
                        ) : (
                          <span className="text-xs text-muted">Chưa có</span>
                        )}
                      </td>

                      <td
                        data-card-actions="true"
                        className={`${DATA_TABLE_TD_CLASS} text-right`}
                      >
                        <RowActionCluster>
                          <Link
                            href={`/finance/documents/${encodeURIComponent(entry.entry_id)}`}
                            className={buttonClasses({ variant: "secondary", size: "sm" })}
                          >
                            <Printer className="h-3.5 w-3.5" aria-hidden />
                            Chứng từ
                          </Link>

                          {entry.evidence ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                setViewingEvidence({
                                  evidence: entry.evidence!,
                                  label: `Chứng từ ${entry.document_no} (${vendor?.display_name ?? vendorId})`,
                                })
                              }
                            >
                              <Eye className="h-3.5 w-3.5" aria-hidden />
                              Xem ảnh
                            </Button>
                          ) : canRecord && entry.can_attach_evidence ? (
                            <Button
                              variant="soft"
                              size="sm"
                              onClick={() =>
                                setAttachingEvidence({
                                  targetKind: "ENTRY",
                                  targetId: entry.entry_id,
                                  label: `Chứng từ ${entry.document_no}`,
                                })
                              }
                            >
                              <ImagePlus className="h-3.5 w-3.5" aria-hidden />
                              Đính kèm ảnh
                            </Button>
                          ) : null}

                          {canRecord && entry.can_reverse ? (
                            <Button
                              variant="danger-outline"
                              size="sm"
                              onClick={() => setReversingEntry(entry)}
                            >
                              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                              Hoàn tác
                            </Button>
                          ) : null}
                        </RowActionCluster>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTableContainer>
        )}
      </section>

      {/* =====================================================================
          TAB 2: DAILY RECONCILIATIONS (Offset Paginated)
         ===================================================================== */}
      <section
        id={recPanelId}
        role="tabpanel"
        aria-labelledby={recTabId}
        hidden={activeTab !== "reconciliations"}
        data-ui-panel-motion="true"
        className="space-y-4"
      >
        <Alert tone="info" title="Nguyên tắc đối soát công nợ theo sổ dự án">
          <p>
            Biên bản đối soát lưu lại <strong>Số dư hệ thống của đúng sổ Dự án × Kế toán</strong>,{" "}
            <strong>Số dư Vendor xác nhận</strong> và <strong>Chênh lệch</strong> tại ngày chốt; hệ
            thống không tự động tạo bút toán điều chỉnh vào sổ cái.
          </p>
        </Alert>

        {vendor?.latest_reconciliation ? (
          <Card className="p-4 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">
                Kỳ đối soát gần nhất:{" "}
                <span className="font-mono">
                  {formatVietnamDateLabel(vendor.latest_reconciliation.as_of_date)}
                </span>
                {vendor.latest_reconciliation.project_display_name_snapshot ? (
                  <span className="ml-2 text-xs font-normal text-muted">
                    ({vendor.latest_reconciliation.project_display_name_snapshot} · KT:{" "}
                    {vendor.latest_reconciliation.responsible_accountant_display_name ?? "—"})
                  </span>
                ) : null}
              </p>
              <StatusBadge
                tone={vendor.latest_reconciliation.difference_minor === "0" ? "success" : "warning"}
              >
                {vendor.latest_reconciliation.difference_minor === "0"
                  ? "Khớp số dư"
                  : `Lệch ${formatSignedVndDelta(vendor.latest_reconciliation.difference_minor)}`}
              </StatusBadge>
            </div>
            <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
              <div>
                <span className="text-muted">Số hệ thống: </span>
                <strong className="font-mono text-foreground">
                  {formatVndMinor(vendor.latest_reconciliation.system_balance_minor)}
                </strong>
              </div>
              <div>
                <span className="text-muted">Số xác nhận: </span>
                <strong className="font-mono text-foreground">
                  {formatVndMinor(vendor.latest_reconciliation.confirmed_balance_minor)}
                </strong>
              </div>
              <div>
                <span className="text-muted">Chênh lệch: </span>
                <strong className="font-mono text-foreground">
                  {formatSignedVndDelta(vendor.latest_reconciliation.difference_minor)}
                </strong>
              </div>
            </div>
          </Card>
        ) : null}

        {recError ? (
          <div className="space-y-3">
            <Alert tone="error" role="alert" title="Không thể tải lịch sử đối soát">
              <p>{recError}</p>
            </Alert>
            <Button variant="secondary" onClick={triggerReloadAll}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Thử lại
            </Button>
          </div>
        ) : recLoading && !recData ? (
          <Card className="p-8 text-center">
            <p role="status" aria-live="polite" className="text-sm text-muted">
              Đang tải lịch sử đối soát…
            </p>
          </Card>
        ) : recData && recData.reconciliations.length === 0 ? (
          <Card className="p-8 text-center space-y-3">
            <p className="text-sm font-medium text-foreground">
              Chưa có biên bản đối soát nào trong phạm vi sổ đang xem.
            </p>
            {canReconcile && reconcilableSubLedgers.length > 0 ? (
              <div className="flex justify-center">
                <Button variant="primary" onClick={() => setReconcileDialogOpen(true)}>
                  <Scale className="h-4 w-4" aria-hidden />
                  Tạo đối soát đầu tiên
                </Button>
              </div>
            ) : null}
          </Card>
        ) : recData ? (
          <DataTableContainer
            dataTestId="vfin-reconciliations-table"
            footer={
              <OffsetPager
                page={recData.page}
                pageCount={recPageCount}
                total={recData.total}
                ariaLabel="Phân trang lịch sử đối soát"
                disabled={recLoading}
                nextDisabled={recLoading || (!recData.has_more && recData.page >= recPageCount)}
                onPageChange={(next) => setRecPage(next)}
                className="mt-0 border-t-0 pt-0"
              />
            }
          >
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Ngày đối soát & Sổ dự án
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Số dư hệ thống
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Số dư xác nhận
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Chênh lệch
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Ghi chú & Người chốt
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Bằng chứng
                  </th>
                </tr>
              </thead>
              <tbody>
                {recData.reconciliations.map((rec: VendorFinanceReconciliationProjection) => {
                  const isMatched = rec.difference_minor === "0";
                  return (
                    <tr key={rec.reconciliation_id} className={DATA_TABLE_ROW_CLASS}>
                      <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5">
                          <p className="font-mono font-semibold text-foreground">
                            {formatVietnamDateLabel(rec.as_of_date)}
                          </p>
                          <p className="text-xs font-medium text-foreground">
                            {rec.ledger_scope === "LEGACY_UNALLOCATED"
                              ? "Sổ lịch sử VFIN-01"
                              : `${rec.project_display_name_snapshot ?? rec.project_id} · KT: ${rec.responsible_accountant_display_name ?? "—"}`}
                          </p>
                          <p className="font-mono text-[11px] text-muted">
                            Đến bút toán #{rec.ledger_sequence_at_reconciliation}
                          </p>
                        </div>
                      </td>

                      <td
                        data-label="Số dư hệ thống"
                        className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                      >
                        {formatVndMinor(rec.system_balance_minor)}
                      </td>

                      <td
                        data-label="Số dư xác nhận"
                        className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                      >
                        {formatVndMinor(rec.confirmed_balance_minor)}
                      </td>

                      <td
                        data-label="Chênh lệch"
                        className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                      >
                        <div className="inline-flex flex-col items-end gap-1">
                          <span className="font-semibold">
                            {formatSignedVndDelta(rec.difference_minor)}
                          </span>
                          <StatusBadge tone={isMatched ? "success" : "warning"}>
                            {isMatched ? "Khớp" : "Có chênh lệch"}
                          </StatusBadge>
                        </div>
                      </td>

                      <td data-label="Ghi chú" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5 max-w-md text-xs">
                          <p className="text-foreground break-words">{rec.reason}</p>
                          <p className="text-muted">
                            Người đối soát: {rec.created_by_display_name} ·{" "}
                            {formatTimestampVi(rec.created_at)}
                          </p>
                        </div>
                      </td>

                      <td
                        data-card-actions="true"
                        className={`${DATA_TABLE_TD_CLASS} text-right`}
                      >
                        <RowActionCluster>
                          {rec.evidence ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                setViewingEvidence({
                                  evidence: rec.evidence!,
                                  label: `Đối soát ngày ${formatVietnamDateLabel(rec.as_of_date)} (${vendor?.display_name ?? vendorId})`,
                                })
                              }
                            >
                              <Eye className="h-3.5 w-3.5" aria-hidden />
                              Xem ảnh
                            </Button>
                          ) : canReconcile && rec.can_attach_evidence ? (
                            <Button
                              variant="soft"
                              size="sm"
                              onClick={() =>
                                setAttachingEvidence({
                                  targetKind: "RECONCILIATION",
                                  targetId: rec.reconciliation_id,
                                  label: `Đối soát ngày ${formatVietnamDateLabel(rec.as_of_date)}`,
                                })
                              }
                            >
                              <ImagePlus className="h-3.5 w-3.5" aria-hidden />
                              Đính kèm ảnh
                            </Button>
                          ) : (
                            <span className="text-xs text-muted">Chưa có ảnh</span>
                          )}
                        </RowActionCluster>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTableContainer>
        ) : null}
      </section>

      {/* Modals (mounted conditionally so defaults always reflect fresh server state) */}
      {vendor && recordDialogOpen ? (
        <RecordVendorEntryDialog
          open={recordDialogOpen}
          onOpenChange={setRecordDialogOpen}
          vendorId={vendor.vendor_id}
          vendorDisplayName={vendor.display_name}
          vendorActive={vendor.active}
          recordableProjects={recordableProjectsForVendor}
          initialProjectId={selectedSubLedger?.project_id ?? scopeFilter.projectId}
          defaultDate={detail?.authorization_date ?? ""}
          allowedEntryTypes={allowedEntryTypes}
          initialEntryType={recordInitialType}
          onDataChanged={triggerReloadAll}
        />
      ) : null}

      {reversingEntry ? (
        <ReverseVendorEntryDialog
          open={Boolean(reversingEntry)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setReversingEntry(null);
          }}
          entry={reversingEntry}
          defaultDate={detail?.authorization_date ?? ""}
          onReversed={triggerReloadAll}
        />
      ) : null}

      {vendor && reconcileDialogOpen ? (
        <CreateVendorReconciliationDialog
          open={reconcileDialogOpen}
          onOpenChange={setReconcileDialogOpen}
          vendorId={vendor.vendor_id}
          vendorDisplayName={vendor.display_name}
          reconcilableSubLedgers={reconcilableSubLedgers}
          initialSubLedgerKey={
            selectedSubLedger && selectedSubLedger.project_id
              ? `${selectedSubLedger.project_id}:${selectedSubLedger.accountant_ref ?? ""}`
              : null
          }
          defaultAsOfDate={detail?.authorization_date ?? ""}
          onDataChanged={triggerReloadAll}
        />
      ) : null}

      <VendorEvidenceViewerDialog
        open={Boolean(viewingEvidence)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setViewingEvidence(null);
        }}
        evidence={viewingEvidence?.evidence ?? null}
        contextLabel={viewingEvidence?.label ?? ""}
      />

      {attachingEvidence ? (
        <VendorEvidenceAttachDialog
          open={Boolean(attachingEvidence)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setAttachingEvidence(null);
          }}
          targetKind={attachingEvidence.targetKind}
          targetId={attachingEvidence.targetId}
          contextLabel={attachingEvidence.label}
          onUploaded={() => triggerReloadAll()}
        />
      ) : null}
    </PageShell>
  );
}
