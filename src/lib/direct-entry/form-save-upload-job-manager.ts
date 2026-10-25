import {
  getDefaultNotifyStore,
  type NotifyApi,
} from "../../components/ui/notify-store.ts";

function shouldClearUploadJobOnPathname(pathname: string | null | undefined): boolean {
  if (typeof pathname !== "string") return false;
  const normalized = pathname.trim().toLowerCase();
  return normalized === "/login" || normalized.startsWith("/login/");
}

export const FORM_DOCUMENT_TYPES = [
  "WORKER_PORTRAIT",
  "CCCD_FRONT",
  "CCCD_BACK",
  "EMPLOYMENT_CONTRACT",
] as const;

export type FormDocumentType = (typeof FORM_DOCUMENT_TYPES)[number];

export const FORM_DOCUMENT_LABELS: Readonly<Record<FormDocumentType, string>> = {
  WORKER_PORTRAIT: "Ảnh NLĐ",
  CCCD_FRONT: "CCCD mặt trước",
  CCCD_BACK: "CCCD mặt sau",
  EMPLOYMENT_CONTRACT: "Hợp đồng",
};

export const FORM_DOCUMENT_HINTS: Readonly<Record<FormDocumentType, string>> = {
  WORKER_PORTRAIT: "JPEG/PNG, tối đa 10 MiB",
  CCCD_FRONT: "Ảnh JPEG/PNG hoặc PDF, tối đa 10 MiB",
  CCCD_BACK: "Ảnh JPEG/PNG hoặc PDF, tối đa 10 MiB",
  EMPLOYMENT_CONTRACT: "Ảnh JPEG/PNG hoặc PDF, tối đa 10 MiB",
};

export const MAX_FORM_DOCUMENT_BYTES = 10 * 1024 * 1024;

export type FormUploadSlotStatus =
  | "idle"
  | "selected"
  | "uploading"
  | "uploaded"
  | "error";

export type FormUploadSlotState = {
  readonly documentType: FormDocumentType;
  readonly status: FormUploadSlotStatus;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly file: File | null;
  readonly errorMessage: string | null;
  readonly retryable: boolean;
  readonly entryId: string | null;
  readonly documentId: string | null;
  readonly reserveIdempotencyKey: string | null;
};

export type FormPostSaveEntryUploadState = {
  readonly jobId: string;
  readonly clientRowId: string;
  readonly entryId: string;
  readonly workerOrder: number;
  readonly entryVersion: number;
  readonly slots: Readonly<Record<FormDocumentType, FormUploadSlotState>>;
};

export type FormPostSaveUploadJobState = {
  readonly jobId: string;
  readonly toastId: string | null;
  readonly status: "uploading" | "completed" | "error";
  readonly totalFiles: number;
  readonly uploadedFiles: number;
  readonly failedFiles: number;
  readonly entries: readonly FormPostSaveEntryUploadState[];
};

export type FormSaveUploadSnapshot = {
  readonly preSaveByRowId: Readonly<
    Record<string, Readonly<Record<FormDocumentType, FormUploadSlotState>>>
  >;
  readonly jobs: readonly FormPostSaveUploadJobState[];
};

export function formUploadCompletionForEntries(
  snapshot: FormSaveUploadSnapshot,
  entryIds: readonly string[],
): "complete" | "pending" | "error" {
  const ids = new Set(entryIds);
  const jobs = snapshot.jobs.filter((job) =>
    job.entries.some((entry) => ids.has(entry.entryId)));
  if (jobs.some((job) => job.status === "error")) return "error";
  return jobs.some((job) => job.status === "uploading") ? "pending" : "complete";
}

export function createIdleFormUploadSlot(
  documentType: FormDocumentType,
): FormUploadSlotState {
  return {
    documentType,
    status: "idle",
    fileName: "",
    sizeBytes: 0,
    mimeType: "",
    file: null,
    errorMessage: null,
    retryable: false,
    entryId: null,
    documentId: null,
    reserveIdempotencyKey: null,
  };
}

export function createIdleFormRowUploadSlots(): Readonly<
  Record<FormDocumentType, FormUploadSlotState>
> {
  return {
    WORKER_PORTRAIT: createIdleFormUploadSlot("WORKER_PORTRAIT"),
    CCCD_FRONT: createIdleFormUploadSlot("CCCD_FRONT"),
    CCCD_BACK: createIdleFormUploadSlot("CCCD_BACK"),
    EMPLOYMENT_CONTRACT: createIdleFormUploadSlot("EMPLOYMENT_CONTRACT"),
  };
}

function normalizeMimeType(file: File): string {
  const raw = (file.type || "").trim().toLowerCase();
  if (raw === "image/jpg") return "image/jpeg";
  if (raw !== "") return raw;
  const lowerName = (file.name || "").trim().toLowerCase();
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg";
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".pdf")) return "application/pdf";
  return "";
}

export function validateFormDocumentFile(
  documentType: FormDocumentType,
  file: File,
): { ok: true; mimeType: string; sizeBytes: number } | { ok: false; message: string } {
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FORM_DOCUMENT_BYTES) {
    return {
      ok: false,
      message: "Tệp phải lớn hơn 0 và không vượt quá 10 MiB.",
    };
  }
  const mimeType = normalizeMimeType(file);
  if (documentType === "WORKER_PORTRAIT") {
    if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
      return {
        ok: false,
        message: "Ảnh NLĐ chỉ chấp nhận định dạng JPEG hoặc PNG.",
      };
    }
    return { ok: true, mimeType, sizeBytes: file.size };
  }
  if (
    mimeType !== "image/jpeg" &&
    mimeType !== "image/png" &&
    mimeType !== "application/pdf"
  ) {
    return {
      ok: false,
      message: "Chỉ chấp nhận định dạng JPEG, PNG hoặc PDF.",
    };
  }
  return { ok: true, mimeType, sizeBytes: file.size };
}

export function formUploadSlotStatusLabel(slot: FormUploadSlotState): string {
  switch (slot.status) {
    case "idle":
      return "Chưa chọn tệp";
    case "selected":
      return "Đã chọn · chờ tải lên";
    case "uploading":
      return "Đang tải lên…";
    case "uploaded":
      return "Tải thành công";
    case "error":
      return slot.retryable ? "Tải lỗi · có thể thử lại" : "Tệp không hợp lệ";
  }
}

export function formatFormFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

type ReserveResponse = {
  ok?: boolean;
  code?: string;
  document_id?: string;
  entry_version?: number;
  upload?: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
  };
};

type FinalizeResponse = {
  ok?: boolean;
  code?: string;
  entry_version?: number;
};

type EntryDetailResponse = {
  ok?: boolean;
  entry?: {
    version?: number;
  };
};

async function fetchLatestEntryVersion(
  entryId: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<number | null> {
  try {
    const response = await fetchImpl(
      `/api/direct-entry/entries/${encodeURIComponent(entryId)}`,
      { method: "GET", cache: "no-store", signal },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as EntryDetailResponse;
    const version = payload.entry?.version;
    return typeof version === "number" && Number.isSafeInteger(version) && version >= 1
      ? version
      : null;
  } catch {
    return null;
  }
}

function mapUploadErrorMessage(code: string | undefined, status: number): string {
  if (code === "DOCUMENT_SIZE_INVALID") {
    return "Tệp phải lớn hơn 0 và không vượt quá 10 MiB.";
  }
  if (code === "DOCUMENT_MIME_INVALID") {
    return "Định dạng tệp không hợp lệ.";
  }
  if (code === "DOCUMENT_CONTENT_INVALID") {
    return "Nội dung tệp không khớp định dạng đã chọn.";
  }
  if (code === "DOCUMENT_DENIED" || status === 401 || status === 403) {
    return "Bạn không có quyền tải tệp cho hồ sơ này.";
  }
  if (code === "ENTRY_LOCKED") {
    return "Hồ sơ đã khóa chỉnh sửa, không thể tải thêm tệp.";
  }
  return "Tải tệp chưa thành công. Hồ sơ đã lưu; bạn có thể bấm Thử tải lại.";
}

export type FormSaveUploadJobManagerOptions = {
  fetchImpl?: typeof fetch;
  notify?: NotifyApi;
  uuidFactory?: () => string;
  onJobSettled?: (job: FormPostSaveUploadJobState) => void;
};

export type FormSaveUploadJobManager = {
  getSnapshot(): FormSaveUploadSnapshot;
  subscribe(listener: () => void): () => void;
  waitForEntriesUploadCompletion(entryIds: readonly string[]): Promise<boolean>;
  getRowSlots(clientRowId: string): Readonly<Record<FormDocumentType, FormUploadSlotState>>;
  selectPreSaveFile(
    clientRowId: string,
    documentType: FormDocumentType,
    file: File,
  ): FormUploadSlotState;
  cancelPreSaveFile(clientRowId: string, documentType: FormDocumentType): void;
  clearRowFiles(clientRowId: string): void;
  hasInvalidSelectedFiles(clientRowIds: readonly string[]): boolean;
  beginSaveProgress(): string;
  completeSaveWithoutUploads(toastId: string | null, savedWorkerCount: number): void;
  failSaveProgress(
    toastId: string | null,
    message: string,
    tone?: "error" | "warning",
  ): void;
  startPostSaveUploadJob(input: {
    toastId: string | null;
    savedEntries: readonly {
      clientRowId: string;
      entryId: string;
      initialEntryVersion?: number;
    }[];
    onEntryUploaded?: (entryId: string, latestEntryVersion: number) => void;
    onJobCompleted?: (job: FormPostSaveUploadJobState) => void;
  }): FormPostSaveUploadJobState | null;
  retryPostSaveSlot(
    jobId: string,
    entryId: string,
    documentType: FormDocumentType,
  ): Promise<void>;
  replacePostSaveSlotFile(
    jobId: string,
    entryId: string,
    documentType: FormDocumentType,
    file: File,
  ): Promise<void>;
  cancelPostSaveSlot(
    jobId: string,
    entryId: string,
    documentType: FormDocumentType,
  ): void;
  retryFailedJobUploads(jobId: string): Promise<void>;
  syncSessionPathname(pathname: string | null | undefined): void;
  resetForSessionChange(): void;
};

export function createFormSaveUploadJobManager(
  options: FormSaveUploadJobManagerOptions = {},
): FormSaveUploadJobManager {
  const getFetch = (): typeof fetch => options.fetchImpl ?? fetch;
  const getNotify = (): NotifyApi => options.notify ?? getDefaultNotifyStore().api;
  const createUuid = (): string => options.uuidFactory?.() ?? crypto.randomUUID();

  let preSaveByRowId: Record<
    string,
    Record<FormDocumentType, FormUploadSlotState>
  > = {};
  let jobs: FormPostSaveUploadJobState[] = [];
  let sessionAbortController = new AbortController();
  const inFlightJobIds = new Set<string>();
  const listeners = new Set<() => void>();

  let cachedSnapshot: FormSaveUploadSnapshot = {
    preSaveByRowId: {},
    jobs: [],
  };

  function rebuildSnapshot(): void {
    const frozenPreSave: Record<
      string,
      Readonly<Record<FormDocumentType, FormUploadSlotState>>
    > = {};
    for (const [rowId, slots] of Object.entries(preSaveByRowId)) {
      frozenPreSave[rowId] = { ...slots };
    }
    cachedSnapshot = {
      preSaveByRowId: frozenPreSave,
      jobs: [...jobs],
    };
  }

  function emit(): void {
    rebuildSnapshot();
    for (const listener of listeners) {
      listener();
    }
  }

  function ensureRowRecord(
    clientRowId: string,
  ): Record<FormDocumentType, FormUploadSlotState> {
    const existing = preSaveByRowId[clientRowId];
    if (existing) return existing;
    const created: Record<FormDocumentType, FormUploadSlotState> = {
      WORKER_PORTRAIT: createIdleFormUploadSlot("WORKER_PORTRAIT"),
      CCCD_FRONT: createIdleFormUploadSlot("CCCD_FRONT"),
      CCCD_BACK: createIdleFormUploadSlot("CCCD_BACK"),
      EMPLOYMENT_CONTRACT: createIdleFormUploadSlot("EMPLOYMENT_CONTRACT"),
    };
    preSaveByRowId = {
      ...preSaveByRowId,
      [clientRowId]: created,
    };
    return created;
  }

  function recomputeJobCounts(
    entries: readonly FormPostSaveEntryUploadState[],
  ): {
    totalFiles: number;
    uploadedFiles: number;
    failedFiles: number;
    uploadingOrSelectedFiles: number;
  } {
    let totalFiles = 0;
    let uploadedFiles = 0;
    let failedFiles = 0;
    let uploadingOrSelectedFiles = 0;
    for (const entry of entries) {
      for (const docType of FORM_DOCUMENT_TYPES) {
        const slot = entry.slots[docType];
        if (slot.status === "idle") continue;
        totalFiles += 1;
        if (slot.status === "uploaded") uploadedFiles += 1;
        else if (slot.status === "error") failedFiles += 1;
        else uploadingOrSelectedFiles += 1;
      }
    }
    return { totalFiles, uploadedFiles, failedFiles, uploadingOrSelectedFiles };
  }

  function updateJobState(
    jobId: string,
    updater: (current: FormPostSaveUploadJobState) => FormPostSaveUploadJobState,
  ): FormPostSaveUploadJobState | null {
    let updated: FormPostSaveUploadJobState | null = null;
    jobs = jobs.map((job) => {
      if (job.jobId !== jobId) return job;
      updated = updater(job);
      return updated;
    });
    if (updated !== null) {
      emit();
    }
    return updated;
  }

  function syncJobToast(job: FormPostSaveUploadJobState): void {
    const notify = getNotify();
    const { totalFiles, uploadedFiles, failedFiles } = job;
    if (totalFiles === 0) {
      if (job.toastId) {
        notify.update(job.toastId, {
          tone: "success",
          pending: false,
          title: "Đã lưu hồ sơ và tải xong tài liệu",
          description: "Hồ sơ người lao động đã được lưu thành công.",
          action: null,
        });
      }
      return;
    }

    if (job.status === "uploading") {
      const title = `Đã lưu hồ sơ; đang tải ảnh và tài liệu (${uploadedFiles}/${totalFiles} tệp)…`;
      const description =
        "Bạn có thể tiếp tục làm việc hoặc chuyển màn hình trong khi tệp đang tải lên.";
      if (job.toastId) {
        notify.update(job.toastId, {
          tone: "info",
          pending: true,
          durationMs: null,
          title,
          description,
          action: null,
        });
      }
      return;
    }

    if (job.status === "completed" && failedFiles === 0 && uploadedFiles === totalFiles) {
      const title = "Đã lưu hồ sơ và tải xong tài liệu";
      const description = `Đã tải và gắn thành công ${uploadedFiles}/${totalFiles} tệp đính kèm.`;
      if (job.toastId) {
        notify.update(job.toastId, {
          tone: "success",
          pending: false,
          title,
          description,
          action: null,
        });
      }
      return;
    }

    if (job.status === "error" || failedFiles > 0) {
      const title = `Đã lưu hồ sơ; tải tài liệu chưa hoàn tất (${uploadedFiles}/${totalFiles} tệp)`;
      const description = `Có ${failedFiles} tệp tải lỗi. Hồ sơ đã được lưu; hãy bấm Thử lại tệp lỗi.`;
      if (job.toastId) {
        notify.update(job.toastId, {
          tone: "error",
          pending: false,
          durationMs: null,
          title,
          description,
          action: {
            kind: "retry",
            safeToRetry: true,
            label: "Thử lại tệp lỗi",
            onClick: () => {
              void retryFailedJobUploads(job.jobId);
            },
          },
        });
      }
    }
  }

  async function uploadSingleSlotForEntry(input: {
    jobId: string;
    entryId: string;
    documentType: FormDocumentType;
    signal: AbortSignal;
    onEntryUploaded?: (entryId: string, latestEntryVersion: number) => void;
  }): Promise<void> {
    const fetchImpl = getFetch();
    const currentJob = jobs.find((item) => item.jobId === input.jobId);
    const currentEntry = currentJob?.entries.find((item) => item.entryId === input.entryId);
    const currentSlot = currentEntry?.slots[input.documentType];
    if (!currentJob || !currentEntry || !currentSlot || !currentSlot.file) {
      return;
    }

    const file = currentSlot.file;
    const validation = validateFormDocumentFile(input.documentType, file);
    if (!validation.ok) {
      updateJobState(input.jobId, (job) => {
        const entries = job.entries.map((entry) => {
          if (entry.entryId !== input.entryId) return entry;
          const nextSlot: FormUploadSlotState = {
            ...entry.slots[input.documentType],
            status: "error",
            errorMessage: validation.message,
            retryable: false,
          };
          return {
            ...entry,
            slots: {
              ...entry.slots,
              [input.documentType]: nextSlot,
            },
          };
        });
        const counts = recomputeJobCounts(entries);
        return {
          ...job,
          entries,
          totalFiles: counts.totalFiles,
          uploadedFiles: counts.uploadedFiles,
          failedFiles: counts.failedFiles,
        };
      });
      return;
    }

    const reserveKey = currentSlot.reserveIdempotencyKey ?? createUuid();

    // Mark slot as uploading
    const uploadingJob = updateJobState(input.jobId, (job) => {
      const entries = job.entries.map((entry) => {
        if (entry.entryId !== input.entryId) return entry;
        const nextSlot: FormUploadSlotState = {
          ...entry.slots[input.documentType],
          status: "uploading",
          errorMessage: null,
          retryable: false,
          reserveIdempotencyKey: reserveKey,
        };
        return {
          ...entry,
          slots: {
            ...entry.slots,
            [input.documentType]: nextSlot,
          },
        };
      });
      const counts = recomputeJobCounts(entries);
      return {
        ...job,
        status: "uploading",
        entries,
        totalFiles: counts.totalFiles,
        uploadedFiles: counts.uploadedFiles,
        failedFiles: counts.failedFiles,
      };
    });
    if (uploadingJob) {
      syncJobToast(uploadingJob);
    }

    let expectedVersion = currentEntry.entryVersion;

    const performReserve = async (
      versionToUse: number,
      idempotencyKey: string,
    ): Promise<{ ok: true; documentId: string; nextVersion: number; uploadUrl: string; uploadHeaders: Record<string, string> } | { ok: false; status: number; code?: string; retryable: boolean }> => {
      const response = await fetchImpl(
        `/api/direct-entry/entries/${encodeURIComponent(input.entryId)}/documents`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            document_type: input.documentType,
            expected_entry_version: versionToUse,
            size_bytes: validation.sizeBytes,
            mime_type: validation.mimeType,
          }),
          signal: input.signal,
        },
      );
      let body: ReserveResponse = {};
      try {
        body = (await response.json()) as ReserveResponse;
      } catch {
        body = {};
      }
      if (
        !response.ok ||
        body.ok !== true ||
        typeof body.document_id !== "string" ||
        typeof body.entry_version !== "number" ||
        typeof body.upload?.url !== "string"
      ) {
        const retryable =
          response.status >= 500 ||
          response.status === 408 ||
          response.status === 409 ||
          response.status === 429;
        return {
          ok: false,
          status: response.status,
          code: body.code,
          retryable,
        };
      }
      return {
        ok: true,
        documentId: body.document_id,
        nextVersion: body.entry_version,
        uploadUrl: body.upload.url,
        uploadHeaders: body.upload.headers ?? {
          "Content-Type": validation.mimeType,
        },
      };
    };

    try {
      let reserved = await performReserve(expectedVersion, reserveKey);
      if (!reserved.ok && reserved.status === 409) {
        const refreshedVersion = await fetchLatestEntryVersion(
          input.entryId,
          fetchImpl,
          input.signal,
        );
        if (refreshedVersion !== null) {
          expectedVersion = refreshedVersion;
          reserved = await performReserve(expectedVersion, createUuid());
        }
      }

      if (!reserved.ok) {
        const message = mapUploadErrorMessage(reserved.code, reserved.status);
        updateJobState(input.jobId, (job) => {
          const entries = job.entries.map((entry) => {
            if (entry.entryId !== input.entryId) return entry;
            const nextSlot: FormUploadSlotState = {
              ...entry.slots[input.documentType],
              status: "error",
              errorMessage: message,
              retryable: true,
              reserveIdempotencyKey: createUuid(),
            };
            return {
              ...entry,
              entryVersion: expectedVersion,
              slots: {
                ...entry.slots,
                [input.documentType]: nextSlot,
              },
            };
          });
          const counts = recomputeJobCounts(entries);
          return {
            ...job,
            entries,
            totalFiles: counts.totalFiles,
            uploadedFiles: counts.uploadedFiles,
            failedFiles: counts.failedFiles,
          };
        });
        return;
      }

      // Step 2: Upload bytes to signed URL
      const putResponse = await fetchImpl(reserved.uploadUrl, {
        method: "PUT",
        headers: reserved.uploadHeaders,
        body: file,
        signal: input.signal,
      });
      if (!putResponse.ok) {
        updateJobState(input.jobId, (job) => {
          const entries = job.entries.map((entry) => {
            if (entry.entryId !== input.entryId) return entry;
            const nextSlot: FormUploadSlotState = {
              ...entry.slots[input.documentType],
              status: "error",
              errorMessage: "Không tải được tệp lên kho lưu trữ. Hồ sơ đã lưu; hãy bấm Thử tải lại.",
              retryable: true,
              documentId: reserved.documentId,
              reserveIdempotencyKey: createUuid(),
            };
            return {
              ...entry,
              entryVersion: reserved.nextVersion,
              slots: {
                ...entry.slots,
                [input.documentType]: nextSlot,
              },
            };
          });
          const counts = recomputeJobCounts(entries);
          return {
            ...job,
            entries,
            totalFiles: counts.totalFiles,
            uploadedFiles: counts.uploadedFiles,
            failedFiles: counts.failedFiles,
          };
        });
        return;
      }

      // Step 3: Finalize document
      let finalizeExpectedVersion = reserved.nextVersion;
      const finalizeKey = `${reserveKey}:finalize`;
      let finalizeResponse = await fetchImpl(
        `/api/direct-entry/entries/${encodeURIComponent(input.entryId)}/documents/${encodeURIComponent(reserved.documentId)}/finalize`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": finalizeKey,
          },
          body: JSON.stringify({
            expected_entry_version: finalizeExpectedVersion,
          }),
          signal: input.signal,
        },
      );
      let finalizeBody: FinalizeResponse = {};
      try {
        finalizeBody = (await finalizeResponse.json()) as FinalizeResponse;
      } catch {
        finalizeBody = {};
      }

      if (!finalizeResponse.ok && finalizeResponse.status === 409) {
        const refreshedVersion = await fetchLatestEntryVersion(
          input.entryId,
          fetchImpl,
          input.signal,
        );
        if (refreshedVersion !== null) {
          finalizeExpectedVersion = refreshedVersion;
          finalizeResponse = await fetchImpl(
            `/api/direct-entry/entries/${encodeURIComponent(input.entryId)}/documents/${encodeURIComponent(reserved.documentId)}/finalize`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": `${createUuid()}:finalize`,
              },
              body: JSON.stringify({
                expected_entry_version: finalizeExpectedVersion,
              }),
              signal: input.signal,
            },
          );
          try {
            finalizeBody = (await finalizeResponse.json()) as FinalizeResponse;
          } catch {
            finalizeBody = {};
          }
        }
      }

      if (!finalizeResponse.ok || finalizeBody.ok !== true) {
        const message = mapUploadErrorMessage(finalizeBody.code, finalizeResponse.status);
        updateJobState(input.jobId, (job) => {
          const entries = job.entries.map((entry) => {
            if (entry.entryId !== input.entryId) return entry;
            const nextSlot: FormUploadSlotState = {
              ...entry.slots[input.documentType],
              status: "error",
              errorMessage: message,
              retryable: true,
              documentId: reserved.documentId,
              reserveIdempotencyKey: createUuid(),
            };
            return {
              ...entry,
              entryVersion: finalizeExpectedVersion,
              slots: {
                ...entry.slots,
                [input.documentType]: nextSlot,
              },
            };
          });
          const counts = recomputeJobCounts(entries);
          return {
            ...job,
            entries,
            totalFiles: counts.totalFiles,
            uploadedFiles: counts.uploadedFiles,
            failedFiles: counts.failedFiles,
          };
        });
        return;
      }

      const committedVersion =
        typeof finalizeBody.entry_version === "number"
          ? finalizeBody.entry_version
          : finalizeExpectedVersion + 1;

      const afterSuccessJob = updateJobState(input.jobId, (job) => {
        const entries = job.entries.map((entry) => {
          if (entry.entryId !== input.entryId) return entry;
          const nextSlot: FormUploadSlotState = {
            ...entry.slots[input.documentType],
            status: "uploaded",
            errorMessage: null,
            retryable: false,
            file: null,
            documentId: reserved.documentId,
            reserveIdempotencyKey: null,
          };
          return {
            ...entry,
            entryVersion: committedVersion,
            slots: {
              ...entry.slots,
              [input.documentType]: nextSlot,
            },
          };
        });
        const counts = recomputeJobCounts(entries);
        return {
          ...job,
          entries,
          totalFiles: counts.totalFiles,
          uploadedFiles: counts.uploadedFiles,
          failedFiles: counts.failedFiles,
        };
      });

      input.onEntryUploaded?.(input.entryId, committedVersion);
      if (afterSuccessJob && afterSuccessJob.status === "uploading") {
        syncJobToast(afterSuccessJob);
      }
    } catch {
      if (input.signal.aborted) return;
      updateJobState(input.jobId, (job) => {
        const entries = job.entries.map((entry) => {
          if (entry.entryId !== input.entryId) return entry;
          const nextSlot: FormUploadSlotState = {
            ...entry.slots[input.documentType],
            status: "error",
            errorMessage: "Mất kết nối khi tải tệp. Hồ sơ đã lưu; bạn có thể bấm Thử tải lại.",
            retryable: true,
            reserveIdempotencyKey: createUuid(),
          };
          return {
            ...entry,
            slots: {
              ...entry.slots,
              [input.documentType]: nextSlot,
            },
          };
        });
        const counts = recomputeJobCounts(entries);
        return {
          ...job,
          entries,
          totalFiles: counts.totalFiles,
          uploadedFiles: counts.uploadedFiles,
          failedFiles: counts.failedFiles,
        };
      });
    }
  }

  async function runJobUploads(
    jobId: string,
    targetFilter?: { entryId: string; documentType: FormDocumentType },
    onEntryUploaded?: (entryId: string, latestEntryVersion: number) => void,
    onJobCompleted?: (job: FormPostSaveUploadJobState) => void,
  ): Promise<void> {
    if (inFlightJobIds.has(jobId) && !targetFilter) return;
    inFlightJobIds.add(jobId);
    const signal = sessionAbortController.signal;

    try {
      const initialJob = jobs.find((item) => item.jobId === jobId);
      if (!initialJob) return;

      for (const entry of initialJob.entries) {
        if (signal.aborted) return;
        if (targetFilter && entry.entryId !== targetFilter.entryId) continue;

        for (const docType of FORM_DOCUMENT_TYPES) {
          if (signal.aborted) return;
          if (targetFilter && docType !== targetFilter.documentType) continue;

          const latestJob = jobs.find((item) => item.jobId === jobId);
          const latestEntry = latestJob?.entries.find(
            (item) => item.entryId === entry.entryId,
          );
          const slot = latestEntry?.slots[docType];
          if (!slot || slot.file === null) continue;
          if (slot.status !== "selected" && slot.status !== "error") continue;

          await uploadSingleSlotForEntry({
            jobId,
            entryId: entry.entryId,
            documentType: docType,
            signal,
            onEntryUploaded,
          });
        }
      }

      if (signal.aborted) return;

      const settledJob = updateJobState(jobId, (job) => {
        const counts = recomputeJobCounts(job.entries);
        const status: FormPostSaveUploadJobState["status"] =
          counts.uploadingOrSelectedFiles > 0
            ? "uploading"
            : counts.failedFiles > 0
              ? "error"
              : "completed";
        return {
          ...job,
          status,
          totalFiles: counts.totalFiles,
          uploadedFiles: counts.uploadedFiles,
          failedFiles: counts.failedFiles,
        };
      });

      if (settledJob) {
        syncJobToast(settledJob);
        options.onJobSettled?.(settledJob);
        onJobCompleted?.(settledJob);
      }
    } finally {
      inFlightJobIds.delete(jobId);
    }
  }

  function getRowSlots(
    clientRowId: string,
  ): Readonly<Record<FormDocumentType, FormUploadSlotState>> {
    return preSaveByRowId[clientRowId] ?? createIdleFormRowUploadSlots();
  }

  function selectPreSaveFile(
    clientRowId: string,
    documentType: FormDocumentType,
    file: File,
  ): FormUploadSlotState {
    const rowRecord = ensureRowRecord(clientRowId);
    const check = validateFormDocumentFile(documentType, file);
    const nextSlot: FormUploadSlotState = check.ok
      ? {
          documentType,
          status: "selected",
          fileName: file.name,
          sizeBytes: check.sizeBytes,
          mimeType: check.mimeType,
          file,
          errorMessage: null,
          retryable: false,
          entryId: null,
          documentId: null,
          reserveIdempotencyKey: createUuid(),
        }
      : {
          documentType,
          status: "error",
          fileName: file.name,
          sizeBytes: file.size,
          mimeType: file.type || "",
          file: null,
          errorMessage: check.message,
          retryable: false,
          entryId: null,
          documentId: null,
          reserveIdempotencyKey: null,
        };
    preSaveByRowId = {
      ...preSaveByRowId,
      [clientRowId]: {
        ...rowRecord,
        [documentType]: nextSlot,
      },
    };
    emit();
    return nextSlot;
  }

  function cancelPreSaveFile(
    clientRowId: string,
    documentType: FormDocumentType,
  ): void {
    const existing = preSaveByRowId[clientRowId];
    if (!existing) return;
    preSaveByRowId = {
      ...preSaveByRowId,
      [clientRowId]: {
        ...existing,
        [documentType]: createIdleFormUploadSlot(documentType),
      },
    };
    emit();
  }

  function clearRowFiles(clientRowId: string): void {
    if (!(clientRowId in preSaveByRowId)) return;
    const next = { ...preSaveByRowId };
    delete next[clientRowId];
    preSaveByRowId = next;
    emit();
  }

  function hasInvalidSelectedFiles(clientRowIds: readonly string[]): boolean {
    for (const rowId of clientRowIds) {
      const slots = preSaveByRowId[rowId];
      if (!slots) continue;
      for (const docType of FORM_DOCUMENT_TYPES) {
        if (slots[docType].status === "error") return true;
      }
    }
    return false;
  }

  function beginSaveProgress(): string {
    const notify = getNotify();
    return notify.pending({
      title: "Đang lưu hồ sơ…",
      description: "Hệ thống đang lưu thông tin người lao động trước khi tải tệp đính kèm.",
      dedupeKey: `form-save-upload:${createUuid()}`,
      dataTestId: "form-save-upload-toast",
    });
  }

  function completeSaveWithoutUploads(
    toastId: string | null,
    savedWorkerCount: number,
  ): void {
    if (!toastId) return;
    const notify = getNotify();
    notify.update(toastId, {
      tone: "success",
      pending: false,
      title: "Đã lưu hồ sơ người lao động",
      description: `Đã lưu thành công ${savedWorkerCount} hồ sơ.`,
      action: null,
    });
  }

  function failSaveProgress(
    toastId: string | null,
    message: string,
    tone: "error" | "warning" = "error",
  ): void {
    if (!toastId) return;
    const notify = getNotify();
    notify.update(toastId, {
      tone,
      pending: false,
      title:
        tone === "warning"
          ? "Chưa xác nhận được trạng thái hoàn tất"
          : "Không lưu được hồ sơ người lao động",
      description: message,
      action: null,
    });
  }

  function startPostSaveUploadJob(input: {
    toastId: string | null;
    savedEntries: readonly {
      clientRowId: string;
      entryId: string;
      initialEntryVersion?: number;
    }[];
    onEntryUploaded?: (entryId: string, latestEntryVersion: number) => void;
    onJobCompleted?: (job: FormPostSaveUploadJobState) => void;
  }): FormPostSaveUploadJobState | null {
    const entriesWithFiles: FormPostSaveEntryUploadState[] = [];
    const jobId = createUuid();

    input.savedEntries.forEach((saved, index) => {
      const preSaveSlots = preSaveByRowId[saved.clientRowId];
      // Clear pre-save slots for this saved row so they are never re-used by another row
      if (preSaveSlots) {
        const nextPreSave = { ...preSaveByRowId };
        delete nextPreSave[saved.clientRowId];
        preSaveByRowId = nextPreSave;
      }

      if (!preSaveSlots) return;
      const boundSlots: Record<FormDocumentType, FormUploadSlotState> = {
        WORKER_PORTRAIT: createIdleFormUploadSlot("WORKER_PORTRAIT"),
        CCCD_FRONT: createIdleFormUploadSlot("CCCD_FRONT"),
        CCCD_BACK: createIdleFormUploadSlot("CCCD_BACK"),
        EMPLOYMENT_CONTRACT: createIdleFormUploadSlot("EMPLOYMENT_CONTRACT"),
      };
      let hasSelectedFile = false;
      for (const docType of FORM_DOCUMENT_TYPES) {
        const slot = preSaveSlots[docType];
        if (slot && slot.status === "selected" && slot.file !== null) {
          hasSelectedFile = true;
          boundSlots[docType] = {
            ...slot,
            entryId: saved.entryId,
            reserveIdempotencyKey: slot.reserveIdempotencyKey ?? createUuid(),
          };
        }
      }
      if (hasSelectedFile) {
        entriesWithFiles.push({
          jobId,
          clientRowId: saved.clientRowId,
          entryId: saved.entryId,
          workerOrder: index + 1,
          entryVersion: saved.initialEntryVersion ?? 1,
          slots: boundSlots,
        });
      }
    });

    if (entriesWithFiles.length === 0) {
      completeSaveWithoutUploads(input.toastId, input.savedEntries.length);
      emit();
      return null;
    }

    const counts = recomputeJobCounts(entriesWithFiles);
    const toastId =
      input.toastId ??
      getNotify().pending({
        title: `Đã lưu hồ sơ; đang tải ảnh và tài liệu (0/${counts.totalFiles} tệp)…`,
        description:
          "Bạn có thể tiếp tục làm việc hoặc chuyển màn hình trong khi tệp đang tải lên.",
        dedupeKey: `form-save-upload:${jobId}`,
        dataTestId: "form-save-upload-toast",
      });

    const newJob: FormPostSaveUploadJobState = {
      jobId,
      toastId,
      status: "uploading",
      totalFiles: counts.totalFiles,
      uploadedFiles: 0,
      failedFiles: 0,
      entries: entriesWithFiles,
    };

    jobs = [newJob, ...jobs];
    emit();
    syncJobToast(newJob);

    void runJobUploads(
      jobId,
      undefined,
      input.onEntryUploaded,
      input.onJobCompleted,
    );
    return newJob;
  }

  async function retryPostSaveSlot(
    jobId: string,
    entryId: string,
    documentType: FormDocumentType,
  ): Promise<void> {
    await runJobUploads(jobId, { entryId, documentType });
  }

  async function replacePostSaveSlotFile(
    jobId: string,
    entryId: string,
    documentType: FormDocumentType,
    file: File,
  ): Promise<void> {
    const check = validateFormDocumentFile(documentType, file);
    const updatedJob = updateJobState(jobId, (job) => {
      const entries = job.entries.map((entry) => {
        if (entry.entryId !== entryId) return entry;
        const nextSlot: FormUploadSlotState = check.ok
          ? {
              documentType,
              status: "selected",
              fileName: file.name,
              sizeBytes: check.sizeBytes,
              mimeType: check.mimeType,
              file,
              errorMessage: null,
              retryable: false,
              entryId,
              documentId: null,
              reserveIdempotencyKey: createUuid(),
            }
          : {
              documentType,
              status: "error",
              fileName: file.name,
              sizeBytes: file.size,
              mimeType: file.type || "",
              file: null,
              errorMessage: check.message,
              retryable: false,
              entryId,
              documentId: null,
              reserveIdempotencyKey: null,
            };
        return {
          ...entry,
          slots: {
            ...entry.slots,
            [documentType]: nextSlot,
          },
        };
      });
      const counts = recomputeJobCounts(entries);
      return {
        ...job,
        status: check.ok ? "uploading" : "error",
        entries,
        totalFiles: counts.totalFiles,
        uploadedFiles: counts.uploadedFiles,
        failedFiles: counts.failedFiles,
      };
    });

    if (!check.ok) {
      if (updatedJob) syncJobToast(updatedJob);
      return;
    }

    await runJobUploads(jobId, { entryId, documentType });
  }

  function cancelPostSaveSlot(
    jobId: string,
    entryId: string,
    documentType: FormDocumentType,
  ): void {
    const updatedJob = updateJobState(jobId, (job) => {
      const entries = job.entries.map((entry) => {
        if (entry.entryId !== entryId) return entry;
        const currentSlot = entry.slots[documentType];
        if (currentSlot.status === "uploading" || currentSlot.status === "uploaded") {
          return entry;
        }
        return {
          ...entry,
          slots: {
            ...entry.slots,
            [documentType]: createIdleFormUploadSlot(documentType),
          },
        };
      });
      const counts = recomputeJobCounts(entries);
      const status: FormPostSaveUploadJobState["status"] =
        counts.uploadingOrSelectedFiles > 0
          ? "uploading"
          : counts.failedFiles > 0
            ? "error"
            : "completed";
      return {
        ...job,
        status,
        entries,
        totalFiles: counts.totalFiles,
        uploadedFiles: counts.uploadedFiles,
        failedFiles: counts.failedFiles,
      };
    });
    if (updatedJob) {
      syncJobToast(updatedJob);
    }
  }

  async function retryFailedJobUploads(jobId: string): Promise<void> {
    await runJobUploads(jobId);
  }

  function resetForSessionChange(): void {
    sessionAbortController.abort();
    sessionAbortController = new AbortController();
    inFlightJobIds.clear();
    preSaveByRowId = {};
    jobs = [];
    emit();
  }

  function syncSessionPathname(pathname: string | null | undefined): void {
    if (shouldClearUploadJobOnPathname(pathname)) {
      resetForSessionChange();
    }
  }

  return {
    getSnapshot() {
      return cachedSnapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    waitForEntriesUploadCompletion(entryIds) {
      return new Promise((resolve) => {
        let active = true;
        const check = () => {
          if (!active) return;
          const status = formUploadCompletionForEntries(cachedSnapshot, entryIds);
          if (status === "pending") return;
          active = false;
          listeners.delete(check);
          resolve(status === "complete");
        };
        listeners.add(check);
        check();
      });
    },
    getRowSlots,
    selectPreSaveFile,
    cancelPreSaveFile,
    clearRowFiles,
    hasInvalidSelectedFiles,
    beginSaveProgress,
    completeSaveWithoutUploads,
    failSaveProgress,
    startPostSaveUploadJob,
    retryPostSaveSlot,
    replacePostSaveSlotFile,
    cancelPostSaveSlot,
    retryFailedJobUploads,
    syncSessionPathname,
    resetForSessionChange,
  };
}

let defaultFormSaveUploadJobManager: FormSaveUploadJobManager | null = null;

export function getDefaultFormSaveUploadJobManager(): FormSaveUploadJobManager {
  if (!defaultFormSaveUploadJobManager) {
    defaultFormSaveUploadJobManager = createFormSaveUploadJobManager();
  }
  return defaultFormSaveUploadJobManager;
}
