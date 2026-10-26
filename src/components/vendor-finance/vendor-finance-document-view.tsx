"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Eye, Printer, RefreshCw } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageShell } from "@/components/ui/page-shell";
import type { VendorFinanceSingleEntryResponse } from "@/lib/vendor-finance/vendor-finance-contract";
import {
  buildSingleEntryUrl,
  classifyVendorFinanceError,
  CONTRACT_TYPE_BADGE_TONES,
  CONTRACT_TYPE_LABELS_VI,
  ENTRY_TYPE_LABELS_VI,
  formatFileSizeVi,
  formatSignedVndDelta,
  formatTimestampVi,
  formatVietnamDateLabel,
  formatVndMinor,
  parseSingleEntryEnvelope,
  VFIN_UI_INTERNAL_DISCLAIMER_VI,
} from "@/lib/vendor-finance/ui-model";

import styles from "./vendor-finance-document.module.css";
import { VendorEvidenceViewerDialog } from "./vendor-finance-evidence-dialog";

export function VendorFinanceDocumentView({ entryId }: { entryId: string }) {
  const [reloadNonce, setReloadNonce] = useState(0);
  const [data, setData] = useState<VendorFinanceSingleEntryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadDocument() {
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      setErrorMsg(null);

      try {
        const res = await fetch(buildSingleEntryUrl(entryId), {
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

        const parsed = parseSingleEntryEnvelope(json);
        if (!parsed) {
          setErrorMsg("Dữ liệu chứng từ tài chính từ máy chủ không đúng chuẩn hợp đồng.");
          setLoading(false);
          return;
        }

        setData(parsed);
        setLoading(false);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setErrorMsg("Không thể tải chứng từ tài chính do lỗi kết nối mạng.");
        setLoading(false);
      }
    }

    void loadDocument();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [entryId, reloadNonce]);

  const entry = data?.entry ?? null;

  const backHref = (() => {
    if (!entry) return "/finance/vendors";
    const sp = new URLSearchParams();
    sp.set("ledgerScope", entry.ledger_scope);
    if (entry.project_id) sp.set("projectId", entry.project_id);
    if (entry.accountant_ref) sp.set("accountantRef", entry.accountant_ref);
    sp.set("contractType", entry.contract_type);
    return `/finance/vendors/${encodeURIComponent(entry.vendor_id)}?${sp.toString()}`;
  })();

  const handlePrint = () => {
    if (typeof window !== "undefined") {
      window.print();
    }
  };

  return (
    <PageShell
      dataTestId="vfin-document-page"
      className={`max-w-4xl ${styles.printContainer}`}
    >
      {/* Screen-only Action Bar */}
      <div
        className={`flex flex-wrap items-center justify-between gap-2 print:hidden ${styles.screenOnly}`}
      >
        <Link
          href={backHref}
          className="inline-flex min-h-11 sm:min-h-9 items-center gap-1.5 text-xs sm:text-sm font-medium text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {entry ? `Sổ cái ${entry.vendor_display_name_snapshot}` : "Danh sách Vendor"}
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            disabled={loading}
            onClick={() => setReloadNonce((n) => n + 1)}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Tải lại
          </Button>
          {entry?.evidence ? (
            <Button variant="secondary" onClick={() => setViewerOpen(true)}>
              <Eye className="h-4 w-4" aria-hidden />
              Xem ảnh bằng chứng
            </Button>
          ) : null}
          {entry ? (
            <Button
              variant="primary"
              data-testid="vfin-print-voucher-btn"
              onClick={handlePrint}
            >
              <Printer className="h-4 w-4" aria-hidden />
              In / In lại chứng từ
            </Button>
          ) : null}
        </div>
      </div>

      {errorMsg ? (
        <div className="space-y-3">
          <Alert tone="error" role="alert" title="Không thể tải chứng từ tài chính">
            <p>{errorMsg}</p>
          </Alert>
          <Button variant="primary" onClick={() => setReloadNonce((n) => n + 1)}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Thử lại
          </Button>
        </div>
      ) : loading && !entry ? (
        <Card className="p-8 text-center">
          <p role="status" aria-live="polite" className="text-sm text-muted">
            Đang tải dữ liệu bản chụp (snapshot) chứng từ…
          </p>
        </Card>
      ) : entry ? (
        <article
          aria-label={`${entry.document_title_vi} — ${entry.document_no}`}
          data-testid="vfin-semantic-voucher"
          className={`${styles.voucherSheet} space-y-6`}
        >
          {/* Company & Document Header */}
          <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-center gap-3">
              <Image
                src="/brand/hrpartner-logo.png"
                alt="HR Partner"
                width={2166}
                height={1706}
                className="h-11 w-auto object-contain"
              />
              <div>
                <p className="text-sm font-bold uppercase tracking-wide text-foreground">
                  HR Partner — Hệ thống Quản trị Nội bộ BI
                </p>
                <p className="text-xs text-muted">
                  Phân hệ Quản lý Tài chính & Công nợ Đối tác (Vendor)
                </p>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:text-right">
              <dt className="text-muted">Số chứng từ:</dt>
              <dd className="font-mono font-bold text-foreground">{entry.document_no}</dd>
              <dt className="text-muted">Thứ tự sổ chi tiết:</dt>
              <dd className="font-mono text-foreground">#{entry.vendor_sequence}</dd>
              <dt className="text-muted">Ngày hiệu lực:</dt>
              <dd className="font-mono font-medium text-foreground">
                {formatVietnamDateLabel(entry.effective_date)}
              </dd>
              <dt className="text-muted">Thời điểm ghi sổ:</dt>
              <dd className="font-mono text-foreground">{formatTimestampVi(entry.created_at)}</dd>
            </dl>
          </header>

          {/* Voucher Title & Status */}
          <section className={`text-center space-y-2 ${styles.avoidBreak}`}>
            <h1 className="text-xl sm:text-2xl font-bold uppercase tracking-tight text-foreground">
              {entry.document_title_vi}
            </h1>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <StatusBadge tone="primary">{ENTRY_TYPE_LABELS_VI[entry.entry_type]}</StatusBadge>
              <StatusBadge tone={CONTRACT_TYPE_BADGE_TONES[entry.contract_type]}>
                {CONTRACT_TYPE_LABELS_VI[entry.contract_type]}
              </StatusBadge>
              {entry.reversed_by_document_no ? (
                <StatusBadge tone="warning">
                  Đã được hoàn tác bởi chứng từ {entry.reversed_by_document_no}
                </StatusBadge>
              ) : null}
              {entry.reverses_document_no ? (
                <StatusBadge tone="danger">
                  Chứng từ hoàn tác cho {entry.reverses_document_no}
                </StatusBadge>
              ) : null}
            </div>
          </section>

          {/* Counterparty, Project & Responsible Accountant Snapshot */}
          <section
            aria-label="Thông tin sổ dự án, kế toán phụ trách và đối tác tại thời điểm lập chứng từ"
            className={`rounded-xl border border-border bg-surface-muted/40 p-4 ${styles.avoidBreak}`}
          >
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-muted">
                  Tên đối tác / Vendor (Snapshot bất biến trên chứng từ)
                </dt>
                <dd
                  data-testid="vfin-voucher-vendor-snapshot"
                  className="mt-0.5 font-semibold text-foreground"
                >
                  {entry.vendor_display_name_snapshot}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Mã đối tác (Vendor ID)</dt>
                <dd className="mt-0.5 font-mono text-foreground">{entry.vendor_id}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Dự án thuộc sổ hạch toán</dt>
                <dd
                  data-testid="vfin-voucher-project-snapshot"
                  className="mt-0.5 font-semibold text-foreground"
                >
                  {entry.ledger_scope === "LEGACY_UNALLOCATED"
                    ? "Sổ lịch sử VFIN-01 (chưa gắn dự án)"
                    : `${entry.project_display_name_snapshot ?? entry.project_id} (${entry.project_id})`}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Kế toán phụ trách sổ dự án</dt>
                <dd
                  data-testid="vfin-voucher-responsible-accountant"
                  className="mt-0.5 font-semibold text-foreground"
                >
                  {entry.responsible_accountant_display_name ?? "Chưa gắn kế toán dự án (VFIN-01)"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Loại hợp đồng thuộc sổ (Không bù trừ chéo)</dt>
                <dd
                  data-testid="vfin-voucher-contract-type"
                  className="mt-0.5 font-semibold text-foreground"
                >
                  {CONTRACT_TYPE_LABELS_VI[entry.contract_type]}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Người nhập giao dịch trên hệ thống</dt>
                <dd className="mt-0.5 font-medium text-foreground">
                  {entry.created_by_display_name}
                  {entry.responsible_accountant_display_name &&
                  entry.created_by_display_name !== entry.responsible_accountant_display_name
                    ? " (Ghi nhận hộ — chứng từ vẫn thuộc sổ kế toán dự án)"
                    : ""}
                </dd>
              </div>
              {entry.opening_batch_id ? (
                <div>
                  <dt className="text-xs font-medium text-muted">Thuộc lô khởi tạo đầu kỳ</dt>
                  <dd className="mt-0.5 font-mono text-xs text-foreground">
                    {entry.opening_batch_id}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>

          {/* Monetary & Running Balance Table */}
          <section
            aria-label="Chi tiết số tiền và biến động công nợ trên sổ dự án"
            className={styles.avoidBreak}
          >
            <table className="w-full border-collapse rounded-xl border border-border text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-muted text-xs uppercase text-muted">
                  <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                    Chỉ tiêu tài chính (Sổ riêng Dự án × Kế toán × Vendor)
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                    Giá trị (VND)
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border">
                  <td className="px-4 py-2.5 font-medium text-foreground">
                    Số tiền ghi nhận trên chứng từ
                  </td>
                  <td
                    data-testid="vfin-voucher-amount"
                    className="px-4 py-2.5 text-right font-mono text-base font-bold tabular-nums text-foreground"
                  >
                    {formatVndMinor(entry.amount_minor)}
                  </td>
                </tr>
                <tr className="border-b border-border">
                  <td className="px-4 py-2.5 text-muted">Số dư sổ chi tiết trước bút toán</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-foreground">
                    {formatVndMinor(entry.balance_before_minor)}
                  </td>
                </tr>
                <tr className="border-b border-border">
                  <td className="px-4 py-2.5 text-muted">
                    Tác động lên công nợ phải trả (+ tăng phải trả / - giảm phải trả)
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums text-foreground">
                    {formatSignedVndDelta(entry.balance_delta_minor)}
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 font-semibold text-foreground">
                    Số dư sổ chi tiết sau bút toán (không bù trừ với dự án khác)
                  </td>
                  <td
                    data-testid="vfin-voucher-balance-after"
                    className="px-4 py-2.5 text-right font-mono text-base font-bold tabular-nums text-foreground"
                  >
                    {formatVndMinor(entry.balance_after_minor)}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          {/* Reason / Narrative */}
          <section
            aria-label="Lý do và diễn giải chứng từ"
            className={`space-y-1.5 rounded-xl border border-border p-4 ${styles.avoidBreak}`}
          >
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Lý do / Diễn giải nghiệp vụ
            </h2>
            <p className="whitespace-pre-wrap break-words text-sm text-foreground">
              {entry.reason}
            </p>
            {(entry.reverses_entry_id || entry.reversed_by_entry_id) ? (
              <div className="mt-2 border-t border-border pt-2 text-xs text-muted space-y-1">
                {entry.reverses_entry_id ? (
                  <p>
                    Tham chiếu chứng từ gốc bị đảo:{" "}
                    <Link
                      href={`/finance/documents/${encodeURIComponent(entry.reverses_entry_id)}`}
                      className="font-mono font-semibold text-primary hover:underline"
                    >
                      {entry.reverses_document_no ?? entry.reverses_entry_id}
                    </Link>
                  </p>
                ) : null}
                {entry.reversed_by_entry_id ? (
                  <p>
                    Tham chiếu chứng từ hoàn tác:{" "}
                    <Link
                      href={`/finance/documents/${encodeURIComponent(entry.reversed_by_entry_id)}`}
                      className="font-mono font-semibold text-primary hover:underline"
                    >
                      {entry.reversed_by_document_no ?? entry.reversed_by_entry_id}
                    </Link>
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>

          {/* Evidence Reference */}
          <section
            aria-label="Tham chiếu ảnh bằng chứng đính kèm"
            className={`rounded-xl border border-border p-4 text-xs space-y-1 ${styles.avoidBreak}`}
          >
            <h2 className="font-semibold uppercase tracking-wide text-muted">
              Tham chiếu bằng chứng đính kèm
            </h2>
            {entry.evidence ? (
              <div className="space-y-1 text-foreground">
                <p>
                  Trạng thái: <strong>Đã xác nhận (READY)</strong> · Định dạng:{" "}
                  <span className="font-mono">{entry.evidence.mime_type}</span> · Dung lượng:{" "}
                  <span>{formatFileSizeVi(entry.evidence.size_bytes)}</span> · Thời điểm xác nhận:{" "}
                  <span>{formatTimestampVi(entry.evidence.finalized_at)}</span>
                </p>
                <p className="break-all font-mono text-muted">
                  Mã bằng chứng: {entry.evidence.evidence_id} · SHA-256:{" "}
                  {entry.evidence.checksum_sha256}
                </p>
              </div>
            ) : (
              <p className="text-muted">Chứng từ này không có tệp ảnh bằng chứng đính kèm.</p>
            )}
          </section>

          {/* Mandatory Internal Non-Bank-Proof Warning */}
          <section
            role="note"
            aria-label="Lưu ý pháp lý và phạm vi chứng từ nội bộ"
            data-testid="vfin-voucher-disclaimer"
            className={styles.disclaimerBox}
          >
            <div className="flex items-start gap-2.5 text-xs sm:text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
              <p className="font-semibold">
                {entry.internal_disclaimer || VFIN_UI_INTERNAL_DISCLAIMER_VI}
              </p>
            </div>
          </section>

          {/* Signature Blocks */}
          <footer aria-label="Khối chữ ký xác nhận" className={`pt-2 ${styles.signatureGrid}`}>
            <div className="rounded-lg border border-dashed border-border p-3 text-center">
              <p className="text-xs font-semibold uppercase text-foreground">Người nhập hệ thống</p>
              <p className="text-[11px] text-muted">(Ký, ghi rõ họ tên)</p>
              <div className="h-16" />
              <p className="text-xs font-medium text-foreground">{entry.created_by_display_name}</p>
            </div>

            <div className="rounded-lg border border-dashed border-border p-3 text-center">
              <p className="text-xs font-semibold uppercase text-foreground">
                Kế toán phụ trách sổ dự án
              </p>
              <p className="text-[11px] text-muted">(Ký, ghi rõ họ tên)</p>
              <div className="h-16" />
              <p className="text-xs font-medium text-foreground">
                {entry.responsible_accountant_display_name ?? "……………………………………"}
              </p>
            </div>

            <div className="rounded-lg border border-dashed border-border p-3 text-center">
              <p className="text-xs font-semibold uppercase text-foreground">Đại diện Vendor</p>
              <p className="text-[11px] text-muted">(Ký, xác nhận đối chiếu)</p>
              <div className="h-16" />
              <p className="text-xs text-muted">……………………………………</p>
            </div>
          </footer>
        </article>
      ) : null}

      <VendorEvidenceViewerDialog
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        evidence={entry?.evidence ?? null}
        contextLabel={entry ? `Chứng từ ${entry.document_no}` : ""}
      />
    </PageShell>
  );
}
