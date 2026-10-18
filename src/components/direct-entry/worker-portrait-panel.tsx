"use client";

/**
 * W2S1 - Panel anh ho so (WORKER_PORTRAIT) cho chi tiet NLĐ.
 *
 * Chi dung pipeline tai lieu hien co: reserve (`POST .../documents`) -> PUT presigned
 * -> finalize (`.../finalize`). Doc lai qua projection `worker_portrait` do server tra ve;
 * bytes xem qua private preview route (same-origin, session cookie), khong signed URL,
 * khong storage key.
 *
 * Khong bao gio bao thanh cong truoc khi finalize tra ok; loi/conflict giu nguyen bytes
 * de retry cung idempotency key. Manifest origin/current do server quyet dinh.
 */

import { useRef, useState } from "react";

import {
  PORTRAIT_HIDDEN_MESSAGE,
  WORKER_PORTRAIT_STATUS_LABELS,
  checkWorkerPortraitFile,
  workerPortraitOriginLabel,
  workerPortraitPreviewUrl,
  workerPortraitUploadPolicy,
  workerPortraitUploadPolicyMessage,
  workerPortraitUploadUrl,
  type WorkerPortraitProjection,
} from "@/lib/direct-entry/worker-detail-projection";
import styles from "./direct-entry-shell.module.css";

const REASON_MAX_LENGTH = 4000;

type UploadState = "idle" | "uploading" | "conflict" | "error" | "saved";
type PreviewState = "loading" | "ready" | "error";

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  DOCUMENT_STORAGE_UNAVAILABLE: "Kho lưu trữ chưa sẵn sàng. Tệp vẫn ở trên thiết bị; bạn có thể thử lại.",
  DOCUMENT_VERSION_CONFLICT: "Dữ liệu đã thay đổi trên máy chủ. Hãy tải lại trạng thái rồi thử lại.",
  DOCUMENT_DENIED: "Bạn không có quyền tải ảnh hồ sơ cho dòng này.",
  DOCUMENT_FILE_REQUIRED: "Hãy chọn một tệp ảnh trước khi tải lên.",
  DOCUMENT_SIZE_INVALID: "Ảnh phải lớn hơn 0 và không vượt quá 10 MiB.",
  DOCUMENT_MIME_INVALID: "Chỉ chấp nhận ảnh JPEG hoặc PNG.",
  DOCUMENT_CONTENT_INVALID: "Nội dung tệp không khớp định dạng ảnh đã chọn.",
  DOCUMENT_UPLOAD_MISSING: "Chưa nhận được tệp trên kho lưu trữ. Hãy thử lại.",
  DOCUMENT_FINALIZE_UNAVAILABLE: "Chưa hoàn tất ghi nhận ảnh hồ sơ. Hãy thử lại.",
  DOCUMENT_RESPONSE_INVALID: "Máy chủ trả về kết quả không đọc được. Hãy thử lại.",
});

function friendlyError(code: string | null): string {
  if (code === null) return "Không tải được ảnh hồ sơ. Hãy thử lại.";
  return ERROR_MESSAGES[code] ?? "Không thể xử lý ảnh hồ sơ. Hãy thử lại.";
}

function formatSize(size: number): string {
  return (size / (1024 * 1024)).toFixed(2) + " MiB";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export type WorkerPortraitPanelProps = {
  entryId: string;
  entryVersion: number;
  /** null khi actor thieu `document_view` (server khong tra portrait). */
  portrait: WorkerPortraitProjection | null;
  /** Capability `document_upload` do server-resolved actor truyen xuong. */
  canUpload: boolean;
  /** Entry SUBMITTED: thay anh phai co ly do (giong luong CCCD/contract hien co). */
  requireReason: boolean;
  onEntryVersionChange(entryVersion: number): void;
  /** Goi sau khi server da ghi nhan; parent tai lai projection. */
  onPortraitChanged(): void;
};

export function WorkerPortraitPanel({
  entryId,
  entryVersion,
  portrait,
  canUpload,
  requireReason,
  onEntryVersionChange,
  onPortraitChanged,
}: WorkerPortraitPanelProps) {
  const [previewState, setPreviewState] = useState<PreviewState>("loading");
  const [previewRetry, setPreviewRetry] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<UploadState>("idle");
  const [message, setMessage] = useState("");
  const pendingKey = useRef<{
    file: File;
    reason: string;
    key: string;
    expectedEntryVersion: number;
  } | null>(null);

  const current = portrait?.current ?? null;
  const policy = workerPortraitUploadPolicy(portrait);
  const uploadAllowed = canUpload && policy.allow;
  const uploadLockedMessage = policy.allow ? null : workerPortraitUploadPolicyMessage(policy.reason);
  const selectedFileCheck = checkWorkerPortraitFile(file);
  const busy = state === "uploading";

  function selectFile(nextFile: File | null): void {
    pendingKey.current = null;
    setMessage("");
    setState("idle");
    const check = checkWorkerPortraitFile(nextFile);
    if (!check.ok) {
      setFile(null);
      if (nextFile !== null) {
        setState("error");
        setMessage(friendlyError(check.code));
      }
      return;
    }
    setFile(nextFile);
  }

  async function upload(): Promise<void> {
    if (!uploadAllowed || busy || entryVersion < 1) return;
    if (file === null) {
      setState("error");
      setMessage(friendlyError("DOCUMENT_FILE_REQUIRED"));
      return;
    }
    // Validate lai ngay trong ham upload, khong chi dua vao trang thai cua control.
    const check = checkWorkerPortraitFile(file);
    if (!check.ok) {
      setFile(null);
      setState("error");
      setMessage(friendlyError(check.code));
      return;
    }
    const trimmedReason = requireReason ? reason.trim() : null;
    if (requireReason && (trimmedReason === null || trimmedReason.length < 1 ||
        trimmedReason.length > REASON_MAX_LENGTH)) {
      setState("error");
      setMessage("Lý do tải ảnh hồ sơ là bắt buộc và tối đa 4000 ký tự.");
      return;
    }
    if (!pendingKey.current || pendingKey.current.file !== file ||
        pendingKey.current.expectedEntryVersion !== entryVersion ||
        (requireReason && pendingKey.current.reason !== trimmedReason)) {
      pendingKey.current = {
        file,
        reason: trimmedReason ?? "",
        key: crypto.randomUUID(),
        expectedEntryVersion: entryVersion,
      };
    }
    const pending = pendingKey.current;
    setState("uploading");
    setMessage("");
    const base = workerPortraitUploadUrl(entryId);
    const post = async (url: string, key: string, body: unknown) => {
      const response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
      });
      return { response, payload: await readJson(response) };
    };
    try {
      const reserved = await post(base, pending.key, {
        document_type: "WORKER_PORTRAIT",
        expected_entry_version: pending.expectedEntryVersion,
        size_bytes: file.size,
        mime_type: check.mimeType,
        ...(requireReason && pending.reason ? { reason: pending.reason } : {}),
      });
      if (reserved.response.status === 409) {
        setState("conflict");
        setMessage(friendlyError("DOCUMENT_VERSION_CONFLICT"));
        return;
      }
      if (!reserved.response.ok || !isRecord(reserved.payload) || reserved.payload.ok !== true ||
          typeof reserved.payload.document_id !== "string" ||
          typeof reserved.payload.entry_version !== "number") {
        const code = isRecord(reserved.payload) && typeof reserved.payload.code === "string"
          ? reserved.payload.code
          : "DOCUMENT_RESPONSE_INVALID";
        throw new Error(code);
      }
      const documentId = reserved.payload.document_id;
      let nextVersion = reserved.payload.entry_version;
      const uploadInfo = reserved.payload.upload;
      if (isRecord(uploadInfo) && uploadInfo.method === "PUT" &&
          typeof uploadInfo.url === "string" && isRecord(uploadInfo.headers)) {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(uploadInfo.headers)) {
          if (typeof value === "string") headers[name] = value;
        }
        const put = await fetch(uploadInfo.url, { method: "PUT", headers, body: file });
        if (!put.ok) throw new Error("DOCUMENT_STORAGE_UNAVAILABLE");
      }
      const finalized = await post(
        workerPortraitUploadUrl(entryId, documentId),
        `${pending.key}:finalize`,
        { expected_entry_version: nextVersion },
      );
      if (finalized.response.status === 409) {
        setState("conflict");
        setMessage(friendlyError(isRecord(finalized.payload) &&
          typeof finalized.payload.code === "string"
          ? finalized.payload.code
          : "DOCUMENT_VERSION_CONFLICT"));
        return;
      }
      if (!finalized.response.ok || !isRecord(finalized.payload) || finalized.payload.ok !== true) {
        const code = isRecord(finalized.payload) && typeof finalized.payload.code === "string"
          ? finalized.payload.code
          : "DOCUMENT_FINALIZE_UNAVAILABLE";
        throw new Error(code);
      }
      if (typeof finalized.payload.entry_version === "number") nextVersion = finalized.payload.entry_version;
      pendingKey.current = null;
      setFile(null);
      setReason("");
      setState("saved");
      setMessage("Máy chủ đã ghi nhận ảnh hồ sơ. Đang tải lại trạng thái mới…");
      onEntryVersionChange(nextVersion);
      onPortraitChanged();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "DOCUMENT_RESPONSE_INVALID";
      setState("error");
      setMessage(friendlyError(code));
    }
  }

  if (portrait === null) {
    return (
      <section className={styles.documentSection} data-testid="worker-portrait-panel"
        aria-labelledby={`portrait-title-${entryId}`}>
        <h3 className={styles.documentTitle} id={`portrait-title-${entryId}`}>Ảnh hồ sơ</h3>
        <p className={styles.documentStatus} role="status">
          {PORTRAIT_HIDDEN_MESSAGE}
        </p>
      </section>
    );
  }

  return (
    <section className={styles.documentSection} data-testid="worker-portrait-panel"
      aria-labelledby={`portrait-title-${entryId}`}>
      <h3 className={styles.documentTitle} id={`portrait-title-${entryId}`}>Ảnh hồ sơ</h3>
      <dl className={styles.submissionMeta}>
        <dt>Trạng thái</dt>
        <dd>{WORKER_PORTRAIT_STATUS_LABELS[portrait.status]}</dd>
        <dt>Nguồn ảnh</dt>
        <dd>{workerPortraitOriginLabel(portrait.origin, portrait.added_at)}</dd>
        {current ? (
          <>
            <dt>Phiên bản hiện hành</dt>
            <dd>v{current.version} · {formatSize(current.size_bytes)}</dd>
          </>
        ) : null}
      </dl>

      {current ? (
        <figure className={styles.portraitFigure}>
          {/* eslint-disable-next-line @next/next/no-img-element -- route preview riêng tư cần session cookie; next/image optimizer chạy server-side nên không có cookie của phiên */}
          <img
            key={`${current.document_id}:${previewRetry}`}
            src={workerPortraitPreviewUrl(entryId, current.document_id)}
            alt="Ảnh hồ sơ của người lao động"
            className={styles.portraitImage}
            onLoad={() => setPreviewState("ready")}
            onError={() => setPreviewState("error")}
          />
          <figcaption className={styles.documentStatus}>
            {previewState === "loading" ? "Đang tải ảnh hồ sơ…" : null}
            {previewState === "ready" ? "Ảnh hồ sơ hiện hành." : null}
            {previewState === "error" ? "Không tải được ảnh hồ sơ." : null}
          </figcaption>
          {previewState === "error" ? (
            <button type="button" className={styles.secondaryButton}
              onClick={() => { setPreviewState("loading"); setPreviewRetry((value) => value + 1); }}>
              Thử tải lại ảnh
            </button>
          ) : null}
        </figure>
      ) : (
        <p className={styles.documentStatus} role="status">Chưa có ảnh hồ sơ được chấp nhận.</p>
      )}

      {uploadAllowed ? (
        <div className={styles.drawerFields}>
          {requireReason ? (
            <label className={styles.field}>
              <span>Lý do tải ảnh hồ sơ</span>
              <textarea aria-label="Lý do tải ảnh hồ sơ" rows={3} maxLength={REASON_MAX_LENGTH}
                disabled={busy} value={reason}
                onChange={(event) => { setReason(event.currentTarget.value); pendingKey.current = null; }} />
            </label>
          ) : null}
          <label className={styles.field}>
            <span>Ảnh hồ sơ (JPEG/PNG · tối đa 10 MiB)</span>
            <span className={styles.filePickerControl}>
              <input
                id={`portrait-file-${entryId}`}
                className={styles.filePickerInput}
                type="file"
                aria-label="Chọn ảnh hồ sơ"
                accept="image/jpeg,image/png"
                disabled={busy}
                onChange={(event) => {
                  selectFile(event.currentTarget.files?.[0] ?? null);
                  event.currentTarget.value = "";
                }}
              />
              <span className={styles.filePickerButton} aria-hidden="true">
                {file ? "Chọn lại ảnh" : "Chọn ảnh"}
              </span>
            </span>
          </label>
          {file ? (
            <p className={styles.documentStatus}>
              Đã chọn ảnh · {formatSize(file.size)} · {file.type || "không rõ định dạng"}
            </p>
          ) : null}
          {busy ? <progress aria-label="Đang gửi ảnh hồ sơ" /> : null}
          {message !== "" ? (
            <p className={state === "error" || state === "conflict" || state === "saved"
              ? styles.documentError : styles.documentStatus}
              role={state === "error" || state === "conflict" ? "alert" : "status"}>
              {message}
            </p>
          ) : null}
          {state === "conflict" ? (
            <button type="button" className={styles.secondaryButton} disabled={busy}
              onClick={() => { pendingKey.current = null; setState("idle"); onPortraitChanged(); }}>
              Tải lại trạng thái
            </button>
          ) : null}
          <button type="button" className={styles.secondaryButton}
            disabled={busy || !selectedFileCheck.ok || state === "conflict"}
            onClick={() => void upload()}>
            {busy ? "Đang tải ảnh…" : state === "error" ? "Thử lại" : "Tải ảnh hồ sơ"}
          </button>
        </div>
      ) : canUpload && uploadLockedMessage !== null ? (
        <p className={styles.documentStatus} role="status"
          data-testid="worker-portrait-upload-locked">
          {uploadLockedMessage}
        </p>
      ) : null}
    </section>
  );
}
