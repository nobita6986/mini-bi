"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentType } from "@/lib/contracts/direct-entry-v1";
import styles from "./direct-entry-shell.module.css";

type DocumentSummary = {
  document_id: string;
  document_type: DocumentType;
  version: number;
  size_bytes: number;
  mime_type: string;
  upload_status: string;
  scan_status: string;
  validation_status: string;
};

type Props = {
  entryId: string | null;
  entryVersion: number | null;
  rowId: string;
  canEdit: boolean;
  canView: boolean;
  onEntryVersionChange(rowId: string, version: number): void;
};

const DOCUMENT_TYPES: readonly { value: DocumentType; label: string }[] = [
  { value: "CCCD_FRONT", label: "CCCD mặt trước" },
  { value: "CCCD_BACK", label: "CCCD mặt sau" },
  { value: "EMPLOYMENT_CONTRACT", label: "Hợp đồng" },
];
const MIME_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);
const MAX_BYTES = 10 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSize(size: number): string {
  return `${(size / (1024 * 1024)).toFixed(2)} MiB`;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    QUEUED: "Đang chờ xử lý",
    UPLOADING: "Đang tải lên",
    QUARANTINED: "Đang cách ly",
    SCANNING: "Đang xử lý",
    READY: "Sẵn sàng",
    FAILED: "Tải lên thất bại",
    SUPERSEDED: "Đã thay thế",
    PENDING: "Chờ kiểm tra",
    CLEAN: "Đã kiểm tra",
    NOT_REQUIRED: "Không yêu cầu quét",
    VALIDATED: "Đã kiểm tra định dạng",
    REJECTED: "Bị từ chối",
  };
  return labels[status] ?? "Không xác định";
}

function parseDocuments(value: unknown): { documents: DocumentSummary[]; entryVersion: number } | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.entry) ||
      !Array.isArray(value.entry.documents) ||
      typeof value.entry.version !== "number" || !Number.isSafeInteger(value.entry.version)) return null;
  const documents: DocumentSummary[] = [];
  for (const document of value.entry.documents) {
    if (!isRecord(document) || typeof document.document_id !== "string" ||
        !DOCUMENT_TYPES.some(({ value: type }) => type === document.document_type) ||
        typeof document.version !== "number" || !Number.isSafeInteger(document.version) ||
        typeof document.size_bytes !== "number" || !Number.isSafeInteger(document.size_bytes) ||
        typeof document.mime_type !== "string" || typeof document.upload_status !== "string" ||
        typeof document.scan_status !== "string" ||
        typeof document.validation_status !== "string") return null;
    const documentType = DOCUMENT_TYPES.find(({ value: type }) => type === document.document_type);
    if (!documentType) return null;
    documents.push({
      document_id: document.document_id,
      document_type: documentType.value,
      version: document.version,
      size_bytes: document.size_bytes,
      mime_type: document.mime_type,
      upload_status: document.upload_status,
      scan_status: document.scan_status,
      validation_status: document.validation_status,
    });
  }
  return { documents, entryVersion: value.entry.version };
}

async function fetchDocuments(entryId: string) {
  try {
    const response = await fetch(`/api/direct-entry/entries/${encodeURIComponent(entryId)}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return response.ok ? parseDocuments(payload) : null;
  } catch {
    return null;
  }
}

function friendlyError(code: string): string {
  const errors: Record<string, string> = {
    DOCUMENT_STORAGE_UNAVAILABLE: "Kho lưu trữ chưa sẵn sàng. Tệp vẫn ở trên thiết bị; bạn có thể thử lại.",
    DOCUMENT_VERSION_CONFLICT: "Dữ liệu đã thay đổi trên máy chủ. Tải trạng thái mới trước khi tiếp tục.",
    DOCUMENT_DENIED: "Bạn không có quyền tải tài liệu cho dòng này.",
    DOCUMENT_SIZE_INVALID: "Tệp phải lớn hơn 0 và không vượt quá 10 MiB.",
    DOCUMENT_MIME_INVALID: "Chỉ chấp nhận JPEG, PNG hoặc PDF.",
    DOCUMENT_CONTENT_INVALID: "Nội dung tệp không khớp với định dạng đã chọn.",
    DOCUMENT_UPLOAD_MISSING: "Chưa nhận được tệp trên kho lưu trữ. Hãy thử lại.",
    DOCUMENT_FINALIZE_UNAVAILABLE: "Chưa hoàn tất ghi nhận tài liệu. Hãy thử lại.",
  };
  return errors[code] ?? "Không thể tải tài liệu. Hãy thử lại.";
}

export function DirectEntryDocumentEditor({
  entryId,
  entryVersion,
  rowId,
  canEdit,
  canView,
  onEntryVersionChange,
}: Props) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [documentType, setDocumentType] = useState<DocumentType>("CCCD_FRONT");
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<"idle" | "uploading" | "queued" | "error" | "conflict">("idle");
  const [message, setMessage] = useState("");
  const pendingKey = useRef<{
    file: File;
    documentType: DocumentType;
    key: string;
    expectedEntryVersion: number;
  } | null>(null);

  const loadDocuments = useCallback(async () => {
    if (!entryId || !canView) return;
    const parsed = await fetchDocuments(entryId);
    if (!parsed) {
      setLoadError(true);
      return;
    }
    setDocuments(parsed.documents);
    onEntryVersionChange(rowId, parsed.entryVersion);
    setLoadError(false);
  }, [canView, entryId, onEntryVersionChange, rowId]);

  useEffect(() => {
    if (!entryId || !canView) return;
    let cancelled = false;
    void fetchDocuments(entryId).then((parsed) => {
      if (cancelled) return;
      if (!parsed) {
        setLoadError(true);
        return;
      }
      setDocuments(parsed.documents);
      onEntryVersionChange(rowId, parsed.entryVersion);
      setLoadError(false);
    });
    return () => { cancelled = true; };
  }, [canView, entryId, onEntryVersionChange, rowId]);

  const selectFile = (nextFile: File | null) => {
    setFile(nextFile);
    pendingKey.current = null;
    setMessage("");
    setState("idle");
    if (nextFile && (nextFile.size < 1 || nextFile.size > MAX_BYTES)) {
      setState("error");
      setMessage(friendlyError("DOCUMENT_SIZE_INVALID"));
    } else if (nextFile && !MIME_TYPES.has(nextFile.type)) {
      setState("error");
      setMessage(friendlyError("DOCUMENT_MIME_INVALID"));
    }
  };

  const upload = async () => {
    if (!entryId || !entryVersion || !file || !canEdit ||
        file.size < 1 || file.size > MAX_BYTES || !MIME_TYPES.has(file.type) ||
        state === "uploading") return;
    if (!pendingKey.current || pendingKey.current.file !== file ||
        pendingKey.current.documentType !== documentType) {
      pendingKey.current = {
        file,
        documentType,
        key: crypto.randomUUID(),
        expectedEntryVersion: entryVersion,
      };
    }
    const pending = pendingKey.current;
    setState("uploading");
    setMessage("");
    const base = `/api/direct-entry/entries/${encodeURIComponent(entryId)}/documents`;
    const post = async (url: string, key: string, body: unknown) => {
      const response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Idempotency-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      return { response, payload };
    };
    try {
      const reserved = await post(base, pending.key, {
        document_type: pending.documentType,
        expected_entry_version: pending.expectedEntryVersion,
        size_bytes: file.size,
        mime_type: file.type,
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
          : "DOCUMENT_UPLOAD_FAILED";
        throw new Error(code);
      }
      const documentId = reserved.payload.document_id;
      let nextVersion = reserved.payload.entry_version;
      const upload = reserved.payload.upload;
      if (isRecord(upload) && upload.method === "PUT" && typeof upload.url === "string" &&
          isRecord(upload.headers)) {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(upload.headers)) {
          if (typeof value === "string") headers[name] = value;
        }
        const put = await fetch(upload.url, { method: "PUT", headers, body: file });
        if (!put.ok) throw new Error("DOCUMENT_STORAGE_UNAVAILABLE");
      }
      const finalized = await post(
        `${base}/${encodeURIComponent(documentId)}/finalize`,
        `${pending.key}:finalize`,
        { expected_entry_version: nextVersion },
      );
      if (finalized.response.status === 409) {
        setState("conflict");
        setMessage(friendlyError(isRecord(finalized.payload) && typeof finalized.payload.code === "string"
          ? finalized.payload.code
          : "DOCUMENT_VERSION_CONFLICT"));
        return;
      }
      if (!finalized.response.ok || !isRecord(finalized.payload) || finalized.payload.ok !== true) {
        const code = isRecord(finalized.payload) && typeof finalized.payload.code === "string"
          ? finalized.payload.code
          : "DOCUMENT_UPLOAD_FAILED";
        throw new Error(code);
      }
      if (typeof finalized.payload.entry_version === "number") nextVersion = finalized.payload.entry_version;
      onEntryVersionChange(rowId, nextVersion);
      setState("queued");
      setMessage("Đã kiểm tra định dạng và ghi nhận phiên bản tài liệu.");
      await loadDocuments();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "DOCUMENT_UPLOAD_FAILED";
      setState("error");
      setMessage(friendlyError(code));
    }
  };

  const versions = (type: DocumentType) =>
    documents.filter((document) => document.document_type === type);

  return (
    <section className={styles.documentSection} aria-labelledby={`documents-${rowId}`}>
      <h3 className={styles.documentTitle} id={`documents-${rowId}`}>Hồ sơ</h3>
      {!entryId
        ? <p className={styles.documentStatus}>Lưu bản nháp trước khi thêm tài liệu.</p>
        : !canView
          ? <p className={styles.documentStatus}>Trạng thái hồ sơ được ẩn theo quyền truy cập.</p>
          : loadError
            ? <div className={styles.documentError} role="alert">
              Không tải được trạng thái hồ sơ.
              <button type="button" className={styles.secondaryButton} onClick={() => void loadDocuments()}>
                Tải lại
              </button>
            </div>
            : <ul className={styles.documentList}>
              {DOCUMENT_TYPES.map(({ value, label }) => {
                const versionsForType = versions(value);
                const complete = versionsForType.some((document) =>
                  document.upload_status === "READY" && document.validation_status === "VALIDATED" &&
                  (document.scan_status === "NOT_REQUIRED" || document.scan_status === "CLEAN"));
                return (
                  <li key={value}>
                    <strong>{label}:</strong> {complete ? "Đã hoàn tất" : "Chưa hoàn tất"}
                    {versionsForType.map((document) => (
                      <span className={styles.documentVersion} key={document.document_id}>
                        Phiên bản {document.version} · {formatSize(document.size_bytes)} ·{" "}
                        {statusLabel(document.upload_status)} / {statusLabel(document.validation_status)}
                        {document.upload_status === "READY" && document.validation_status === "VALIDATED" && (
                          <>
                            {" · "}
                            <a
                              href={`/api/direct-entry/entries/${encodeURIComponent(entryId)}/documents/${encodeURIComponent(document.document_id)}/download`}
                              download
                            >
                              Tải xuống
                            </a>
                          </>
                        )}
                      </span>
                    ))}
                  </li>
                );
              })}
            </ul>}
      <div className={styles.documentControls}>
        <label className={styles.field}>
          <span>Loại tài liệu</span>
          <select
            value={documentType}
            disabled={!canEdit || !entryId || state === "uploading"}
            onChange={(event) => {
              const next = event.currentTarget.value;
              const selected = DOCUMENT_TYPES.find(({ value }) => value === next);
              if (selected) {
                setDocumentType(selected.value);
                pendingKey.current = null;
              }
            }}
          >
            {DOCUMENT_TYPES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span>Chọn hoặc thay tệp (JPEG, PNG, PDF · tối đa 10 MiB)</span>
          <input
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            disabled={!canEdit || !entryId || state === "uploading"}
            onChange={(event) => selectFile(event.currentTarget.files?.[0] ?? null)}
          />
        </label>
        {file && <p className={styles.documentStatus}>
          Đã chọn tệp · {formatSize(file.size)} · {file.type || "không rõ loại"}
        </p>}
        {state === "uploading" && <progress aria-label="Đang gửi tệp" />}
        {message && <p className={state === "error" || state === "conflict"
          ? styles.documentError : styles.documentStatus} role={state === "error" || state === "conflict" ? "alert" : "status"}>
          {message}
        </p>}
        {state === "conflict" && (
          <button type="button" className={styles.secondaryButton} onClick={() => {
            pendingKey.current = null;
            setState("idle");
            setMessage("Đã tải trạng thái mới. Kiểm tra tệp rồi lưu lại nếu vẫn cần thay thế.");
            void loadDocuments();
          }}>
            Tải trạng thái mới
          </button>
        )}
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={!canEdit || !entryId || !file || state === "uploading" ||
            state === "conflict" || state === "queued"}
          onClick={() => void upload()}
        >
          {state === "uploading" ? "Đang tải…" : state === "error" ? "Thử lại" : "Tải lên"}
        </button>
      </div>
    </section>
  );
}
