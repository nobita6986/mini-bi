"use client";

import { useEffect, useId, useState } from "react";
import { ExternalLink, FileCheck2, ImagePlus, RefreshCw } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import type {
  VendorFinanceEvidenceDownloadResponse,
  VendorFinanceEvidenceSummary,
  VendorFinanceEvidenceTargetKind,
} from "@/lib/vendor-finance/vendor-finance-contract";
import {
  buildDownloadEvidenceUrl,
  classifyVendorFinanceError,
  formatFileSizeVi,
  formatTimestampVi,
  parseEvidenceDownloadEnvelope,
  uploadEvidenceForCommittedTarget,
  validateEvidenceFilePreflight,
  type EvidenceUploadResumeState,
} from "@/lib/vendor-finance/ui-model";

export function VendorEvidenceViewerDialog({
  open,
  onOpenChange,
  evidence,
  contextLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  evidence: VendorFinanceEvidenceSummary | null;
  contextLabel: string;
}) {
  const descriptionId = useId();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [downloadData, setDownloadData] = useState<VendorFinanceEvidenceDownloadResponse | null>(
    null,
  );

  useEffect(() => {
    if (!open || !evidence) {
      return;
    }
    let cancelled = false;
    const controller = new AbortController();

    async function loadSignedUrl(evidenceId: string) {
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      setErrorMsg(null);
      setDownloadData(null);

      try {
        const res = await fetch(buildDownloadEvidenceUrl(evidenceId), {
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

        const parsed = parseEvidenceDownloadEnvelope(json);
        if (!parsed) {
          setErrorMsg("Phản hồi đường dẫn xem ảnh bằng chứng từ máy chủ không hợp lệ.");
          setLoading(false);
          return;
        }
        setDownloadData(parsed);
        setLoading(false);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setErrorMsg("Không thể tải ảnh bằng chứng do lỗi kết nối mạng. Vui lòng thử lại.");
        setLoading(false);
      }
    }

    void loadSignedUrl(evidence.evidence_id);
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, evidence, reloadNonce]);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Ảnh bằng chứng đã xác nhận"
      description={contextLabel}
      descriptionId={descriptionId}
      contentClassName="sm:w-[min(46rem,calc(100vw-2rem))]"
      dataTestId="vfin-evidence-viewer-dialog"
    >
      {!evidence ? (
        <p className="text-sm text-muted">Chưa có ảnh bằng chứng được đính kèm.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-muted/60 px-3.5 py-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="success" dot>
                Đã xác nhận (READY)
              </StatusBadge>
              <span className="font-mono text-foreground">{evidence.mime_type}</span>
              <span className="text-muted">· {formatFileSizeVi(evidence.size_bytes)}</span>
            </div>
            <span className="text-muted">
              Xác nhận lúc: {formatTimestampVi(evidence.finalized_at)}
            </span>
          </div>

          {loading ? (
            <div
              role="status"
              aria-live="polite"
              className="flex min-h-56 items-center justify-center rounded-xl border border-border bg-surface-muted/40 p-6 text-sm text-muted"
            >
              Đang cấp đường dẫn bảo mật để hiển thị ảnh bằng chứng…
            </div>
          ) : errorMsg ? (
            <div className="space-y-3">
              <Alert tone="error" role="alert" title="Không thể hiển thị ảnh bằng chứng">
                <p>{errorMsg}</p>
              </Alert>
              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  onClick={() => setReloadNonce((n) => n + 1)}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Thử tải lại ảnh
                </Button>
              </div>
            </div>
          ) : downloadData ? (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-xl border border-border bg-surface-muted/30 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={downloadData.download.url}
                  alt={`Ảnh bằng chứng cho ${contextLabel}`}
                  className="mx-auto max-h-[60dvh] w-auto rounded-lg object-contain"
                />
              </div>
              <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">
                <span className="font-medium text-foreground">SHA-256: </span>
                <span className="break-all font-mono">{evidence.checksum_sha256}</span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setReloadNonce((n) => n + 1)}
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  Cấp lại đường dẫn xem
                </Button>
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={downloadData.download.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonClasses({ variant: "secondary", size: "md" })}
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden />
                    Mở ảnh kích thước gốc
                  </a>
                  <Button variant="primary" onClick={() => onOpenChange(false)}>
                    Đóng
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </FormDialog>
  );
}

export function VendorEvidenceAttachDialog({
  open,
  onOpenChange,
  targetKind,
  targetId,
  contextLabel,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetKind: VendorFinanceEvidenceTargetKind;
  targetId: string;
  contextLabel: string;
  onUploaded: (evidence: VendorFinanceEvidenceSummary) => void;
}) {
  const descriptionId = useId();
  const fileInputId = useId();
  const notify = useNotify();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [resumeState, setResumeState] = useState<EvidenceUploadResumeState | null>(null);
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleClose = (nextOpen: boolean) => {
    if (uploading) return;
    if (!nextOpen) {
      setSelectedFile(null);
      setResumeState(null);
      setErrorMsg(null);
    }
    onOpenChange(nextOpen);
  };

  const handleFileChange = (file: File | null) => {
    setErrorMsg(null);
    setResumeState(null);
    if (!file) {
      setSelectedFile(null);
      return;
    }
    const check = validateEvidenceFilePreflight(file);
    if (!check.ok) {
      setSelectedFile(null);
      setErrorMsg(check.message);
      return;
    }
    setSelectedFile(file);
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setErrorMsg("Vui lòng chọn tệp ảnh bằng chứng JPEG hoặc PNG (tối đa 10 MB).");
      return;
    }
    setUploading(true);
    setErrorMsg(null);

    const result = await uploadEvidenceForCommittedTarget({
      target_kind: targetKind,
      target_id: targetId,
      file: selectedFile,
      resumeState,
    });

    setUploading(false);

    if (!result.ok) {
      setResumeState(result.resumeState);
      setErrorMsg(result.message);
      return;
    }

    setSelectedFile(null);
    setResumeState(null);
    notify.success({
      title: "Đã đính kèm ảnh bằng chứng",
      description: contextLabel,
    });
    onUploaded(result.evidence);
    onOpenChange(false);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={handleClose}
      closeDisabled={uploading}
      title="Đính kèm ảnh bằng chứng"
      description={`${contextLabel} — Thao tác này chỉ tải ảnh bằng chứng (reserve → PUT → finalize), không tạo lại bút toán tiền.`}
      descriptionId={descriptionId}
      dataTestId="vfin-evidence-attach-dialog"
    >
      <div className="space-y-4">
        {errorMsg ? (
          <Alert tone="error" role="alert" title="Tải ảnh bằng chứng chưa hoàn tất">
            <p>{errorMsg}</p>
          </Alert>
        ) : null}

        <div className="space-y-1.5">
          <label htmlFor={fileInputId} className="block text-sm font-medium text-foreground">
            Tệp ảnh bằng chứng (JPEG / PNG, tối đa 10 MB)
          </label>
          <input
            id={fileInputId}
            type="file"
            accept="image/jpeg,image/png"
            disabled={uploading}
            onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
            className="block min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
          />
          {selectedFile ? (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <FileCheck2 className="h-3.5 w-3.5 text-primary" aria-hidden />
              <span>
                Đã chọn: <strong className="text-foreground">{selectedFile.name}</strong> (
                {formatFileSizeVi(selectedFile.size)})
              </span>
            </p>
          ) : (
            <p className="text-xs text-muted">
              Mỗi bút toán hoặc biên bản đối soát chỉ gắn tối đa 1 ảnh bằng chứng đã xác nhận.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          <Button
            variant="secondary"
            disabled={uploading}
            onClick={() => handleClose(false)}
          >
            Hủy
          </Button>
          <Button
            variant="primary"
            loading={uploading}
            disabled={!selectedFile || uploading}
            onClick={() => void handleUpload()}
          >
            <ImagePlus className="h-4 w-4" aria-hidden />
            {resumeState ? "Thử tải lại ảnh" : "Tải lên & xác nhận ảnh"}
          </Button>
        </div>
      </div>
    </FormDialog>
  );
}
