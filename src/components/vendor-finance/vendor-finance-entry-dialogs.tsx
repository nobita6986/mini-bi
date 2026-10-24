"use client";

import { useId, useState, type FormEvent } from "react";
import Link from "next/link";
import { CheckCircle2, FileCheck2, ImagePlus, Printer, RotateCcw, Scale } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import type {
  NormalVendorFinanceEntryType,
  VendorFinanceEntryProjection,
  VendorFinanceReconciliationProjection,
} from "@/lib/vendor-finance/vendor-finance-contract";
import {
  buildCreateReconciliationRequest,
  buildRecordEntryRequest,
  buildReverseEntryRequest,
  buildReverseEntryUrl,
  buildVendorEntriesUrl,
  buildVendorReconciliationsUrl,
  classifyVendorFinanceError,
  computeReconciliationDifferencePreview,
  createClientIdempotencyKey,
  ENTRY_TYPE_DIRECTION_HINTS_VI,
  ENTRY_TYPE_LABELS_VI,
  formatFileSizeVi,
  formatSignedVndDelta,
  formatVietnamDateLabel,
  formatVndMinor,
  normalizePositiveVndInput,
  normalizeSignedVndInput,
  parseCreateReconciliationEnvelope,
  parseRecordEntryEnvelope,
  parseReverseEntryEnvelope,
  uploadEvidenceForCommittedTarget,
  validateEvidenceFilePreflight,
  VFIN_UI_MAX_REASON_LENGTH,
  type EvidenceUploadResumeState,
} from "@/lib/vendor-finance/ui-model";

// =============================================================================
// 1. Record Normal Entry Dialog (Two-Phase Commit + Safe Evidence Retry)
// =============================================================================
export function RecordVendorEntryDialog({
  open,
  onOpenChange,
  vendorId,
  vendorDisplayName,
  vendorActive,
  defaultDate,
  allowedEntryTypes,
  initialEntryType,
  onDataChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendorId: string;
  vendorDisplayName: string;
  vendorActive: boolean;
  defaultDate: string;
  allowedEntryTypes: readonly NormalVendorFinanceEntryType[];
  initialEntryType?: NormalVendorFinanceEntryType;
  onDataChanged: () => void;
}) {
  const descriptionId = useId();
  const typeSelectId = useId();
  const amountInputId = useId();
  const dateInputId = useId();
  const reasonInputId = useId();
  const fileInputId = useId();
  const notify = useNotify();

  const resolvedDefaultType: NormalVendorFinanceEntryType =
    initialEntryType && allowedEntryTypes.includes(initialEntryType)
      ? initialEntryType
      : (allowedEntryTypes[0] ?? "DEBT_RECORDED");

  const [entryType, setEntryType] = useState<NormalVendorFinanceEntryType>(resolvedDefaultType);
  const [amountInput, setAmountInput] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(defaultDate);
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => createClientIdempotencyKey());

  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Locked post-commit state if entry succeeded on server, but optional evidence upload failed.
  // In this state, retrying ONLY uploads evidence to `committedEntry.entry_id` — NEVER re-POSTs the entry!
  const [committedEntry, setCommittedEntry] = useState<VendorFinanceEntryProjection | null>(null);
  const [evidenceResumeState, setEvidenceResumeState] =
    useState<EvidenceUploadResumeState | null>(null);
  const [retryingEvidence, setRetryingEvidence] = useState(false);

  const rotateKey = () => setIdempotencyKey(createClientIdempotencyKey());

  const resetAll = () => {
    setEntryType(resolvedDefaultType);
    setAmountInput("");
    setEffectiveDate(defaultDate);
    setReason("");
    setIdempotencyKey(createClientIdempotencyKey());
    setEvidenceFile(null);
    setSubmitting(false);
    setErrorMsg(null);
    setCommittedEntry(null);
    setEvidenceResumeState(null);
    setRetryingEvidence(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (submitting || retryingEvidence) return;
    if (!nextOpen) {
      resetAll();
    }
    onOpenChange(nextOpen);
  };

  const handleEvidencePick = (file: File | null) => {
    setErrorMsg(null);
    setEvidenceResumeState(null);
    if (!file) {
      setEvidenceFile(null);
      return;
    }
    const check = validateEvidenceFilePreflight(file);
    if (!check.ok) {
      setEvidenceFile(null);
      setErrorMsg(check.message);
      return;
    }
    setEvidenceFile(file);
  };

  const parsedAmountPreview = normalizePositiveVndInput(amountInput);
  const directionHint = ENTRY_TYPE_DIRECTION_HINTS_VI[entryType];

  const handleSubmitEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (committedEntry) {
      return;
    }
    setErrorMsg(null);

    if (evidenceFile) {
      const check = validateEvidenceFilePreflight(evidenceFile);
      if (!check.ok) {
        setErrorMsg(check.message);
        return;
      }
    }

    const built = buildRecordEntryRequest({
      entry_type: entryType,
      amount_input: amountInput,
      effective_date: effectiveDate,
      reason,
      idempotency_key: idempotencyKey,
      allowed_entry_types: allowedEntryTypes,
    });
    if (!built.ok) {
      setErrorMsg(built.message);
      return;
    }

    setSubmitting(true);
    let savedEntry: VendorFinanceEntryProjection;
    try {
      const res = await fetch(buildVendorEntriesUrl(vendorId), {
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
        setErrorMsg(classified.message);
        setSubmitting(false);
        return;
      }

      const parsed = parseRecordEntryEnvelope(json);
      if (!parsed) {
        setErrorMsg(
          "Phản hồi ghi nhận bút toán từ máy chủ không hợp lệ. Vui lòng tải lại sổ cái để kiểm tra trước khi nhập lại.",
        );
        setSubmitting(false);
        return;
      }
      savedEntry = parsed.entry;
    } catch {
      setErrorMsg(
        "Mất kết nối mạng khi ghi nhận bút toán. Bạn có thể bấm Lưu bút toán lại (hệ thống giữ nguyên Idempotency-Key chống tạo trùng).",
      );
      setSubmitting(false);
      return;
    }

    // Server has authoritatively committed the ledger entry -> refresh parent balances & ledger!
    onDataChanged();

    if (!evidenceFile) {
      setSubmitting(false);
      notify.success({
        title: `Đã ghi nhận ${savedEntry.document_no}`,
        description: `${ENTRY_TYPE_LABELS_VI[savedEntry.entry_type]} · ${formatVndMinor(savedEntry.amount_minor)}`,
      });
      resetAll();
      onOpenChange(false);
      return;
    }

    // Phase 2: Upload optional evidence strictly against committed `savedEntry.entry_id`
    const uploadRes = await uploadEvidenceForCommittedTarget({
      target_kind: "ENTRY",
      target_id: savedEntry.entry_id,
      file: evidenceFile,
    });

    setSubmitting(false);

    if (!uploadRes.ok) {
      setCommittedEntry(savedEntry);
      setEvidenceResumeState(uploadRes.resumeState);
      setErrorMsg(uploadRes.message);
      return;
    }

    onDataChanged();
    notify.success({
      title: `Đã ghi nhận ${savedEntry.document_no} kèm ảnh bằng chứng`,
      description: `${ENTRY_TYPE_LABELS_VI[savedEntry.entry_type]} · ${formatVndMinor(savedEntry.amount_minor)}`,
    });
    resetAll();
    onOpenChange(false);
  };

  const handleRetryCommittedEvidence = async () => {
    if (!committedEntry || !evidenceFile) {
      setErrorMsg("Vui lòng chọn tệp ảnh JPEG hoặc PNG hợp lệ để tải lên.");
      return;
    }
    setRetryingEvidence(true);
    setErrorMsg(null);

    const uploadRes = await uploadEvidenceForCommittedTarget({
      target_kind: "ENTRY",
      target_id: committedEntry.entry_id,
      file: evidenceFile,
      resumeState: evidenceResumeState,
    });

    setRetryingEvidence(false);

    if (!uploadRes.ok) {
      setEvidenceResumeState(uploadRes.resumeState);
      setErrorMsg(uploadRes.message);
      return;
    }

    onDataChanged();
    notify.success({
      title: `Đã tải xong ảnh bằng chứng cho ${committedEntry.document_no}`,
    });
    resetAll();
    onOpenChange(false);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={handleOpenChange}
      closeDisabled={submitting || retryingEvidence}
      title={
        committedEntry
          ? `Bút toán ${committedEntry.document_no} đã lưu — Hoàn tất ảnh bằng chứng`
          : `Ghi nhận khoản tiền — ${vendorDisplayName}`
      }
      description={
        committedEntry
          ? "Bút toán tiền đã được ghi nhận vào sổ cái. Thao tác thử lại bên dưới chỉ tải ảnh bằng chứng, không gửi lại bút toán tiền."
          : "Số dư chỉ được cập nhật sau khi máy chủ xác nhận thành công."
      }
      descriptionId={descriptionId}
      dataTestId="vfin-record-entry-dialog"
    >
      {committedEntry ? (
        <div className="space-y-4" data-testid="vfin-record-entry-evidence-recovery">
          <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3.5 text-sm">
            <div className="flex items-center gap-2 font-semibold text-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
              <span>Đã ghi nhận bút toán {committedEntry.document_no} an toàn</span>
            </div>
            <p className="mt-1 text-xs text-muted">
              {ENTRY_TYPE_LABELS_VI[committedEntry.entry_type]} · Số tiền:{" "}
              <strong className="font-mono text-foreground">
                {formatVndMinor(committedEntry.amount_minor)}
              </strong>{" "}
              · Số dư sau GD:{" "}
              <strong className="font-mono text-foreground">
                {formatVndMinor(committedEntry.balance_after_minor)}
              </strong>
            </p>
          </div>

          {errorMsg ? (
            <Alert tone="warning" role="alert" title="Tải ảnh bằng chứng chưa hoàn tất">
              <p>{errorMsg}</p>
            </Alert>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor={fileInputId} className="block text-sm font-medium text-foreground">
              Tệp ảnh bằng chứng cho {committedEntry.document_no} (JPEG / PNG, tối đa 10 MB)
            </label>
            <input
              id={fileInputId}
              type="file"
              accept="image/jpeg,image/png"
              disabled={retryingEvidence}
              onChange={(e) => handleEvidencePick(e.target.files?.[0] ?? null)}
              className="block min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            {evidenceFile ? (
              <p className="text-xs text-muted">
                Đang chọn: <strong className="text-foreground">{evidenceFile.name}</strong> (
                {formatFileSizeVi(evidenceFile.size)})
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <Link
              href={`/finance/documents/${encodeURIComponent(committedEntry.entry_id)}`}
              className={buttonClasses({ variant: "ghost", size: "sm" })}
              onClick={() => handleOpenChange(false)}
            >
              <Printer className="h-3.5 w-3.5" aria-hidden />
              Mở chứng từ in
            </Link>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={retryingEvidence}
                onClick={() => handleOpenChange(false)}
              >
                Đóng (tải ảnh sau ở sổ cái)
              </Button>
              <Button
                variant="primary"
                loading={retryingEvidence}
                disabled={!evidenceFile || retryingEvidence}
                onClick={() => void handleRetryCommittedEvidence()}
              >
                <ImagePlus className="h-4 w-4" aria-hidden />
                Thử tải lại ảnh
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => void handleSubmitEntry(e)} className="space-y-4" noValidate>
          {!vendorActive ? (
            <Alert tone="warning" title="Vendor đang ngừng hoạt động">
              <p>
                Hệ thống chỉ cho phép ghi nhận các loại bút toán tất toán / điều chỉnh được máy chủ
                cho phép.
              </p>
            </Alert>
          ) : null}

          {errorMsg ? (
            <Alert tone="error" role="alert" title="Không thể ghi nhận bút toán">
              <p>{errorMsg}</p>
            </Alert>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor={typeSelectId} className="block text-sm font-medium text-foreground">
              Loại bút toán <span className="text-rose-600">*</span>
            </label>
            <select
              id={typeSelectId}
              value={entryType}
              disabled={submitting}
              onChange={(e) => {
                setEntryType(e.target.value as NormalVendorFinanceEntryType);
                setErrorMsg(null);
                rotateKey();
              }}
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {allowedEntryTypes.map((type) => (
                <option key={type} value={type}>
                  {ENTRY_TYPE_LABELS_VI[type]}
                </option>
              ))}
            </select>
            {directionHint ? (
              <p className="text-xs text-muted">
                Quy ước sổ cái:{" "}
                <strong className="font-mono text-foreground">({directionHint.deltaSign})</strong>{" "}
                {directionHint.description}
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor={amountInputId} className="block text-sm font-medium text-foreground">
                Số tiền (VND nguyên dương) <span className="text-rose-600">*</span>
              </label>
              <input
                id={amountInputId}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="Ví dụ: 15000000"
                value={amountInput}
                disabled={submitting}
                onChange={(e) => {
                  setAmountInput(e.target.value);
                  setErrorMsg(null);
                  rotateKey();
                }}
                className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
              <p aria-live="polite" className="text-xs text-muted">
                {amountInput.trim().length === 0 ? (
                  "Chỉ nhập số nguyên VND (không số thập phân)."
                ) : parsedAmountPreview.ok ? (
                  <>
                    Hiển thị:{" "}
                    <strong className="font-mono text-foreground">
                      {formatVndMinor(parsedAmountPreview.canonical)}
                    </strong>
                  </>
                ) : (
                  <span className="text-rose-600 dark:text-rose-300">
                    {parsedAmountPreview.message}
                  </span>
                )}
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor={dateInputId} className="block text-sm font-medium text-foreground">
                Ngày hiệu lực <span className="text-rose-600">*</span>
              </label>
              <input
                id={dateInputId}
                type="date"
                value={effectiveDate}
                disabled={submitting}
                onChange={(e) => {
                  setEffectiveDate(e.target.value);
                  setErrorMsg(null);
                  rotateKey();
                }}
                className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={reasonInputId} className="block text-sm font-medium text-foreground">
              Lý do / Diễn giải chứng từ <span className="text-rose-600">*</span>
            </label>
            <textarea
              id={reasonInputId}
              rows={3}
              maxLength={VFIN_UI_MAX_REASON_LENGTH}
              placeholder="Ghi rõ căn cứ bảng kê, đợt thanh toán, hợp đồng hoặc lý do điều chỉnh…"
              value={reason}
              disabled={submitting}
              onChange={(e) => {
                setReason(e.target.value);
                setErrorMsg(null);
                rotateKey();
              }}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>

          <div className="space-y-1.5 rounded-xl border border-border bg-surface-muted/40 p-3">
            <label htmlFor={fileInputId} className="block text-sm font-medium text-foreground">
              Ảnh bằng chứng đính kèm (tùy chọn — JPEG / PNG, tối đa 10 MB)
            </label>
            <input
              id={fileInputId}
              type="file"
              accept="image/jpeg,image/png"
              disabled={submitting}
              onChange={(e) => handleEvidencePick(e.target.files?.[0] ?? null)}
              className="block min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            {evidenceFile ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <FileCheck2 className="h-3.5 w-3.5 text-primary" aria-hidden />
                  <strong className="text-foreground">{evidenceFile.name}</strong> (
                  {formatFileSizeVi(evidenceFile.size)})
                </span>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => handleEvidencePick(null)}
                  className="text-xs font-medium text-rose-600 hover:underline"
                >
                  Bỏ chọn ảnh
                </button>
              </div>
            ) : (
              <p className="text-xs text-muted">
                Bút toán tiền luôn được lưu độc lập trước; nếu tải ảnh gặp sự cố mạng, bạn có thể
                thử tải lại ảnh mà không bị mất hay tạo trùng bút toán.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              variant="secondary"
              disabled={submitting}
              onClick={() => handleOpenChange(false)}
            >
              Hủy
            </Button>
            <Button type="submit" variant="primary" loading={submitting} disabled={submitting}>
              Lưu bút toán
            </Button>
          </div>
        </form>
      )}
    </FormDialog>
  );
}

// =============================================================================
// 2. Reverse Entry Dialog (`POST /api/vendor-finance/entries/[entryId]/reverse`)
// =============================================================================
export function ReverseVendorEntryDialog({
  open,
  onOpenChange,
  entry,
  defaultDate,
  onReversed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: VendorFinanceEntryProjection | null;
  defaultDate: string;
  onReversed: () => void;
}) {
  const descriptionId = useId();
  const dateInputId = useId();
  const reasonInputId = useId();
  const notify = useNotify();

  const [effectiveDate, setEffectiveDate] = useState(defaultDate);
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => createClientIdempotencyKey());
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const rotateKey = () => setIdempotencyKey(createClientIdempotencyKey());

  const handleClose = (nextOpen: boolean) => {
    if (submitting) return;
    if (!nextOpen) {
      setEffectiveDate(defaultDate);
      setReason("");
      setIdempotencyKey(createClientIdempotencyKey());
      setErrorMsg(null);
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!entry) return;
    setErrorMsg(null);

    const built = buildReverseEntryRequest({
      effective_date: effectiveDate.trim().length > 0 ? effectiveDate : null,
      reason,
      idempotency_key: idempotencyKey,
    });
    if (!built.ok) {
      setErrorMsg(built.message);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(buildReverseEntryUrl(entry.entry_id), {
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
        setErrorMsg(classified.message);
        setSubmitting(false);
        return;
      }

      const parsed = parseReverseEntryEnvelope(json);
      if (!parsed) {
        setErrorMsg("Phản hồi hoàn tác bút toán từ máy chủ không hợp lệ.");
        setSubmitting(false);
        return;
      }

      setSubmitting(false);
      notify.success({
        title: `Đã tạo bút toán hoàn tác ${parsed.reversal_entry.document_no}`,
        description: `Hoàn tác cho chứng từ ${parsed.reversed_entry.document_no}`,
      });
      onReversed();
      handleClose(false);
    } catch {
      setErrorMsg(
        "Mất kết nối mạng khi gửi yêu cầu hoàn tác. Bạn có thể bấm Xác nhận hoàn tác lại an toàn.",
      );
      setSubmitting(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={handleClose}
      closeDisabled={submitting}
      title={entry ? `Hoàn tác bút toán ${entry.document_no}` : "Hoàn tác bút toán"}
      description="Hệ thống sổ cái bất biến (append-only): thao tác này sẽ tạo một bút toán REVERSAL ngược dấu và khóa hoàn tác vĩnh viễn trên bút toán gốc."
      descriptionId={descriptionId}
      dataTestId="vfin-reverse-entry-dialog"
    >
      {!entry ? null : (
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
          <div className="rounded-xl border border-border bg-surface-muted/60 p-3.5 text-xs space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono font-semibold text-foreground">{entry.document_no}</span>
              <StatusBadge tone="neutral">{ENTRY_TYPE_LABELS_VI[entry.entry_type]}</StatusBadge>
            </div>
            <p className="text-muted">
              Ngày hiệu lực gốc:{" "}
              <strong className="font-mono text-foreground">
                {formatVietnamDateLabel(entry.effective_date)}
              </strong>{" "}
              · Số tiền:{" "}
              <strong className="font-mono text-foreground">
                {formatVndMinor(entry.amount_minor)}
              </strong>{" "}
              (Tác động gốc:{" "}
              <span className="font-mono">{formatSignedVndDelta(entry.balance_delta_minor)}</span>)
            </p>
            <p className="text-muted line-clamp-2">Lý do gốc: {entry.reason}</p>
          </div>

          {errorMsg ? (
            <Alert tone="error" role="alert" title="Không thể hoàn tác bút toán">
              <p>{errorMsg}</p>
            </Alert>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor={dateInputId} className="block text-sm font-medium text-foreground">
              Ngày hiệu lực hoàn tác (để trống để lấy ngày nghiệp vụ hiện tại)
            </label>
            <input
              id={dateInputId}
              type="date"
              value={effectiveDate}
              disabled={submitting}
              onChange={(e) => {
                setEffectiveDate(e.target.value);
                setErrorMsg(null);
                rotateKey();
              }}
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={reasonInputId} className="block text-sm font-medium text-foreground">
              Lý do hoàn tác <span className="text-rose-600">*</span>
            </label>
            <textarea
              id={reasonInputId}
              rows={3}
              maxLength={VFIN_UI_MAX_REASON_LENGTH}
              placeholder="Ghi rõ lý do hủy / đảo bút toán gốc…"
              value={reason}
              disabled={submitting}
              onChange={(e) => {
                setReason(e.target.value);
                setErrorMsg(null);
                rotateKey();
              }}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            <Button variant="secondary" disabled={submitting} onClick={() => handleClose(false)}>
              Hủy
            </Button>
            <Button type="submit" variant="danger" loading={submitting} disabled={submitting}>
              <RotateCcw className="h-4 w-4" aria-hidden />
              Xác nhận hoàn tác
            </Button>
          </div>
        </form>
      )}
    </FormDialog>
  );
}

// =============================================================================
// 3. Daily Reconciliation Dialog (Two-Phase Commit + Never Auto-Adjusts Ledger)
// =============================================================================
export function CreateVendorReconciliationDialog({
  open,
  onOpenChange,
  vendorId,
  vendorDisplayName,
  currentSystemBalanceMinor,
  defaultAsOfDate,
  onDataChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendorId: string;
  vendorDisplayName: string;
  currentSystemBalanceMinor: string;
  defaultAsOfDate: string;
  onDataChanged: () => void;
}) {
  const descriptionId = useId();
  const dateInputId = useId();
  const confirmedInputId = useId();
  const reasonInputId = useId();
  const fileInputId = useId();
  const notify = useNotify();

  const [asOfDate, setAsOfDate] = useState(defaultAsOfDate);
  const [confirmedInput, setConfirmedInput] = useState(currentSystemBalanceMinor);
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => createClientIdempotencyKey());
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [committedRec, setCommittedRec] =
    useState<VendorFinanceReconciliationProjection | null>(null);
  const [evidenceResumeState, setEvidenceResumeState] =
    useState<EvidenceUploadResumeState | null>(null);
  const [retryingEvidence, setRetryingEvidence] = useState(false);

  const rotateKey = () => setIdempotencyKey(createClientIdempotencyKey());

  const resetAll = () => {
    setAsOfDate(defaultAsOfDate);
    setConfirmedInput(currentSystemBalanceMinor);
    setReason("");
    setIdempotencyKey(createClientIdempotencyKey());
    setEvidenceFile(null);
    setSubmitting(false);
    setErrorMsg(null);
    setCommittedRec(null);
    setEvidenceResumeState(null);
    setRetryingEvidence(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (submitting || retryingEvidence) return;
    if (!nextOpen) {
      resetAll();
    }
    onOpenChange(nextOpen);
  };

  const handleEvidencePick = (file: File | null) => {
    setErrorMsg(null);
    setEvidenceResumeState(null);
    if (!file) {
      setEvidenceFile(null);
      return;
    }
    const check = validateEvidenceFilePreflight(file);
    if (!check.ok) {
      setEvidenceFile(null);
      setErrorMsg(check.message);
      return;
    }
    setEvidenceFile(file);
  };

  const parsedConfirmed = normalizeSignedVndInput(confirmedInput);
  const previewDiff = parsedConfirmed.ok
    ? computeReconciliationDifferencePreview(currentSystemBalanceMinor, parsedConfirmed.canonical)
    : null;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (committedRec) return;
    setErrorMsg(null);

    if (evidenceFile) {
      const check = validateEvidenceFilePreflight(evidenceFile);
      if (!check.ok) {
        setErrorMsg(check.message);
        return;
      }
    }

    const built = buildCreateReconciliationRequest({
      as_of_date: asOfDate,
      confirmed_balance_input: confirmedInput,
      reason,
      idempotency_key: idempotencyKey,
    });
    if (!built.ok) {
      setErrorMsg(built.message);
      return;
    }

    setSubmitting(true);
    let savedRec: VendorFinanceReconciliationProjection;
    try {
      const res = await fetch(buildVendorReconciliationsUrl(vendorId), {
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
        setErrorMsg(classified.message);
        setSubmitting(false);
        return;
      }

      const parsed = parseCreateReconciliationEnvelope(json);
      if (!parsed) {
        setErrorMsg("Phản hồi ghi nhận đối soát từ máy chủ không hợp lệ.");
        setSubmitting(false);
        return;
      }
      savedRec = parsed.reconciliation;
    } catch {
      setErrorMsg(
        "Mất kết nối mạng khi lưu biên bản đối soát. Bạn có thể bấm Lưu đối soát lại an toàn.",
      );
      setSubmitting(false);
      return;
    }

    onDataChanged();

    if (!evidenceFile) {
      setSubmitting(false);
      notify.success({
        title: `Đã chốt đối soát ngày ${formatVietnamDateLabel(savedRec.as_of_date)}`,
        description: `Chênh lệch: ${formatSignedVndDelta(savedRec.difference_minor)}`,
      });
      resetAll();
      onOpenChange(false);
      return;
    }

    const uploadRes = await uploadEvidenceForCommittedTarget({
      target_kind: "RECONCILIATION",
      target_id: savedRec.reconciliation_id,
      file: evidenceFile,
    });

    setSubmitting(false);

    if (!uploadRes.ok) {
      setCommittedRec(savedRec);
      setEvidenceResumeState(uploadRes.resumeState);
      setErrorMsg(uploadRes.message);
      return;
    }

    onDataChanged();
    notify.success({
      title: `Đã chốt đối soát ngày ${formatVietnamDateLabel(savedRec.as_of_date)} kèm ảnh bằng chứng`,
    });
    resetAll();
    onOpenChange(false);
  };

  const handleRetryEvidence = async () => {
    if (!committedRec || !evidenceFile) {
      setErrorMsg("Vui lòng chọn tệp ảnh JPEG hoặc PNG hợp lệ để tải lên.");
      return;
    }
    setRetryingEvidence(true);
    setErrorMsg(null);

    const uploadRes = await uploadEvidenceForCommittedTarget({
      target_kind: "RECONCILIATION",
      target_id: committedRec.reconciliation_id,
      file: evidenceFile,
      resumeState: evidenceResumeState,
    });

    setRetryingEvidence(false);

    if (!uploadRes.ok) {
      setEvidenceResumeState(uploadRes.resumeState);
      setErrorMsg(uploadRes.message);
      return;
    }

    onDataChanged();
    notify.success({
      title: `Đã đính kèm ảnh bằng chứng đối soát ngày ${formatVietnamDateLabel(committedRec.as_of_date)}`,
    });
    resetAll();
    onOpenChange(false);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={handleOpenChange}
      closeDisabled={submitting || retryingEvidence}
      title={
        committedRec
          ? `Đối soát ngày ${formatVietnamDateLabel(committedRec.as_of_date)} đã lưu — Hoàn tất ảnh`
          : `Chốt đối soát công nợ — ${vendorDisplayName}`
      }
      description="Ghi nhận số dư hệ thống, số dư Vendor xác nhận và chênh lệch tại ngày chốt. Đối soát KHÔNG tự động tạo bút toán điều chỉnh sổ cái."
      descriptionId={descriptionId}
      dataTestId="vfin-reconciliation-dialog"
    >
      {committedRec ? (
        <div className="space-y-4" data-testid="vfin-reconciliation-evidence-recovery">
          <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3.5 text-sm">
            <div className="flex items-center gap-2 font-semibold text-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
              <span>
                Đã lưu đối soát ngày {formatVietnamDateLabel(committedRec.as_of_date)} an toàn
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              Hệ thống:{" "}
              <strong className="font-mono text-foreground">
                {formatVndMinor(committedRec.system_balance_minor)}
              </strong>{" "}
              · Xác nhận:{" "}
              <strong className="font-mono text-foreground">
                {formatVndMinor(committedRec.confirmed_balance_minor)}
              </strong>{" "}
              · Chênh lệch:{" "}
              <strong className="font-mono text-foreground">
                {formatSignedVndDelta(committedRec.difference_minor)}
              </strong>
            </p>
          </div>

          {errorMsg ? (
            <Alert tone="warning" role="alert" title="Tải ảnh bằng chứng chưa hoàn tất">
              <p>{errorMsg}</p>
            </Alert>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor={fileInputId} className="block text-sm font-medium text-foreground">
              Tệp ảnh biên bản / xác nhận đối soát (JPEG / PNG, tối đa 10 MB)
            </label>
            <input
              id={fileInputId}
              type="file"
              accept="image/jpeg,image/png"
              disabled={retryingEvidence}
              onChange={(e) => handleEvidencePick(e.target.files?.[0] ?? null)}
              className="block min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              variant="secondary"
              disabled={retryingEvidence}
              onClick={() => handleOpenChange(false)}
            >
              Đóng (tải ảnh sau)
            </Button>
            <Button
              variant="primary"
              loading={retryingEvidence}
              disabled={!evidenceFile || retryingEvidence}
              onClick={() => void handleRetryEvidence()}
            >
              <ImagePlus className="h-4 w-4" aria-hidden />
              Thử tải lại ảnh
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
          <Alert tone="info" title="Không tự động sinh điều chỉnh (adjustment)">
            <p>
              Máy chủ sẽ tự động tính số dư hệ thống đến hết ngày đối soát và lưu chênh lệch. Nếu
              cần điều chỉnh công nợ sau khi đối soát, Kế toán lập riêng bút toán Điều chỉnh tăng /
              giảm kèm lý do.
            </p>
          </Alert>

          {errorMsg ? (
            <Alert tone="error" role="alert" title="Không thể lưu đối soát">
              <p>{errorMsg}</p>
            </Alert>
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor={dateInputId} className="block text-sm font-medium text-foreground">
                Ngày chốt đối soát <span className="text-rose-600">*</span>
              </label>
              <input
                id={dateInputId}
                type="date"
                value={asOfDate}
                disabled={submitting}
                onChange={(e) => {
                  setAsOfDate(e.target.value);
                  setErrorMsg(null);
                  rotateKey();
                }}
                className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor={confirmedInputId}
                className="block text-sm font-medium text-foreground"
              >
                Số dư Vendor xác nhận (VND) <span className="text-rose-600">*</span>
              </label>
              <input
                id={confirmedInputId}
                type="text"
                inputMode="text"
                autoComplete="off"
                placeholder="Dương: phải trả, Âm: dư ứng, hoặc 0"
                value={confirmedInput}
                disabled={submitting}
                onChange={(e) => {
                  setConfirmedInput(e.target.value);
                  setErrorMsg(null);
                  rotateKey();
                }}
                className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 rounded-xl border border-border bg-surface-muted/50 p-3 text-xs sm:grid-cols-3">
            <div>
              <p className="text-muted">Số dư sổ cái hiện tại (tham chiếu)</p>
              <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
                {formatVndMinor(currentSystemBalanceMinor)}
              </p>
            </div>
            <div>
              <p className="text-muted">Số dư Vendor xác nhận</p>
              <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
                {parsedConfirmed.ok ? formatVndMinor(parsedConfirmed.canonical) : "—"}
              </p>
            </div>
            <div>
              <p className="text-muted">Ước tính chênh lệch (so với hiện tại)</p>
              <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
                {previewDiff !== null ? formatSignedVndDelta(previewDiff) : "—"}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={reasonInputId} className="block text-sm font-medium text-foreground">
              Ghi chú / Kết luận đối soát <span className="text-rose-600">*</span>
            </label>
            <textarea
              id={reasonInputId}
              rows={3}
              maxLength={VFIN_UI_MAX_REASON_LENGTH}
              placeholder="Ghi rõ người xác nhận phía Vendor, biên bản đối chiếu hoặc nguyên nhân chênh lệch (nếu có)…"
              value={reason}
              disabled={submitting}
              onChange={(e) => {
                setReason(e.target.value);
                setErrorMsg(null);
                rotateKey();
              }}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>

          <div className="space-y-1.5 rounded-xl border border-border bg-surface-muted/40 p-3">
            <label htmlFor={fileInputId} className="block text-sm font-medium text-foreground">
              Ảnh biên bản / tin nhắn xác nhận đối soát (tùy chọn — JPEG / PNG, tối đa 10 MB)
            </label>
            <input
              id={fileInputId}
              type="file"
              accept="image/jpeg,image/png"
              disabled={submitting}
              onChange={(e) => handleEvidencePick(e.target.files?.[0] ?? null)}
              className="block min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              variant="secondary"
              disabled={submitting}
              onClick={() => handleOpenChange(false)}
            >
              Hủy
            </Button>
            <Button type="submit" variant="primary" loading={submitting} disabled={submitting}>
              <Scale className="h-4 w-4" aria-hidden />
              Lưu đối soát
            </Button>
          </div>
        </form>
      )}
    </FormDialog>
  );
}
