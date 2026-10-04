/**
 * P1.6-I04C3-R2 - Pipeline tai len cap CCCD hai mat (khong I/O truc tiep).
 *
 * Thu tu bat buoc:
 *   1. Reserve TUAN TU theo FRONT -> BACK, moi reserve dung entry version moi nhat.
 *   2. PUT signed URL chay SONG SONG cho cac mat da reserve thanh cong.
 *   3. Finalize TUAN TU theo thu tu plan, dung entry version moi nhat.
 *   4. Reload detail dung mot lan (khong optimistic READY).
 *
 * Partial failure: mat thanh cong duoc giu; chi mat loi can retry. Cung fingerprint (entryId +
 * entryVersion + mat + sha256) dung lai idempotency key; doi version/file/mat => key moi.
 * Transport khong nhan filename, ho ten, ma NLĐ hay so CCCD: fingerprint chi gom
 * entryId + version + documentType + sha256.
 */
import {
  buildCccdUploadPlan,
  cccdIntentFingerprint,
  cccdSlotComplete,
  CCCD_DOCUMENT_TYPES,
  type CccdDocumentSummary,
  type CccdDocumentType,
  type CccdPlanError,
  type CccdUploadFile,
} from "./cccd-document-pair.ts";
import {
  EMPTY_INTENT_KEY,
  resolveIntentKey,
  type TransitionIntentKeyState,
} from "./submission-lifecycle.ts";

/** Key theo fingerprint; khong bao gio chua filename/duong dan/PII. */
export type CccdKeyState = Readonly<Record<string, TransitionIntentKeyState>>;

export const EMPTY_CCCD_KEY_STATE: CccdKeyState = Object.freeze({});

export function resolveCccdKey(
  state: CccdKeyState,
  fingerprint: string,
  generate: () => string,
): { key: string; reused: boolean; state: CccdKeyState } {
  const resolved = resolveIntentKey(state[fingerprint] ?? EMPTY_INTENT_KEY, fingerprint, generate);
  return {
    key: resolved.key,
    reused: resolved.reused,
    state: { ...state, [fingerprint]: resolved.state },
  };
}

export function clearCccdKey(state: CccdKeyState, fingerprint: string): CccdKeyState {
  if (!(fingerprint in state)) return state;
  const next: Record<string, TransitionIntentKeyState> = { ...state };
  delete next[fingerprint];
  return next;
}

export type CccdReserveOutcome =
  | {
      kind: "reserved";
      documentId: string;
      /** Entry version sau khi reserve (version moi nhat de dung cho buoc sau). */
      entryVersion: number;
      /** null khi server khong tra signed URL (vi du tai lieu da o trang thai cu). */
      upload: { url: string; headers: Readonly<Record<string, string>> } | null;
    }
  | { kind: "conflict"; code: string }
  | { kind: "retryable"; code: string }
  | { kind: "rejected"; code: string };

export type CccdFinalizeOutcome =
  | { kind: "finalized"; entryVersion: number; document: CccdDocumentSummary }
  | { kind: "conflict"; code: string }
  | { kind: "retryable"; code: string }
  | { kind: "rejected"; code: string };

export type CccdTransport = {
  reserve(input: {
    documentType: CccdDocumentType;
    entryVersion: number;
    sizeBytes: number;
    mimeType: string;
    idempotencyKey: string;
  }): Promise<CccdReserveOutcome>;
  put(input: {
    documentType: CccdDocumentType;
    url: string;
    headers: Readonly<Record<string, string>>;
  }): Promise<{ ok: true } | { ok: false; code: string }>;
  finalize(input: {
    documentType: CccdDocumentType;
    documentId: string;
    entryVersion: number;
    idempotencyKey: string;
  }): Promise<CccdFinalizeOutcome>;
  reloadDetail(): Promise<
    { entryVersion: number; documents: readonly CccdDocumentSummary[] } | null
  >;
};

export type CccdSlotStatus = "complete" | "pending" | "failed";

export type CccdSlotResult = {
  documentType: CccdDocumentType;
  status: CccdSlotStatus;
  code: string | null;
  /** true => giu nguyen key de thu lai cung intent. */
  retryable: boolean;
  /** true => 409: khong tu retry, phai reload/reconcile. */
  conflict: boolean;
};

export type CccdRunResult = {
  slots: CccdSlotResult[];
  /** Version moi nhat sau khi chay (co the da tang do reserve/finalize). */
  entryVersion: number;
  detail: { entryVersion: number; documents: readonly CccdDocumentSummary[] } | null;
  planErrors: readonly CccdPlanError[];
};

export const CCCD_VALIDATION_PENDING_CODE = "DOCUMENT_VALIDATION_PENDING";

function tail(value: string): string {
  return value + ":finalize";
}

/**
 * Chay pipeline cho 1 hoac 2 mat. Khong tu retry; khong danh dau READY khi server chua xac nhan.
 */
export async function runCccdUpload(input: {
  entryId: string;
  entryVersion: number;
  files: readonly CccdUploadFile[];
  keyState: CccdKeyState;
  transport: CccdTransport;
  generateKey: () => string;
}): Promise<{ result: CccdRunResult; keyState: CccdKeyState }> {
  const plan = buildCccdUploadPlan({
    entryId: input.entryId,
    entryVersion: input.entryVersion,
    files: input.files,
  });
  if (!plan.ok) {
    return {
      result: { slots: [], entryVersion: input.entryVersion, detail: null, planErrors: plan.errors },
      keyState: input.keyState,
    };
  }

  let keyState = input.keyState;
  let version = input.entryVersion;
  const fileByType = new Map(input.files.map((file) => [file.documentType, file]));
  const results = new Map<CccdDocumentType, CccdSlotResult>();
  const reserved: {
    documentType: CccdDocumentType;
    documentId: string;
    upload: { url: string; headers: Readonly<Record<string, string>> } | null;
    fingerprint: string;
    idempotencyKey: string;
  }[] = [];

  const fail = (
    documentType: CccdDocumentType,
    outcome: { kind: "conflict" | "retryable" | "rejected"; code: string },
    fingerprint: string,
  ) => {
    results.set(documentType, {
      documentType,
      status: "failed",
      code: outcome.code,
      retryable: outcome.kind === "retryable",
      conflict: outcome.kind === "conflict",
    });
    if (outcome.kind === "retryable") return;
    keyState = clearCccdKey(keyState, fingerprint);
  };

  // 1. Reserve tuan tu FRONT -> BACK, luon dung version moi nhat.
  for (const documentType of plan.order) {
    const file = fileByType.get(documentType);
    if (!file) continue;
    const fingerprint = cccdIntentFingerprint({
      entryId: input.entryId,
      entryVersion: version,
      documentType,
      sha256: file.sha256,
    });
    const resolved = resolveCccdKey(keyState, fingerprint, input.generateKey);
    keyState = resolved.state;
    let outcome: CccdReserveOutcome;
    try {
      outcome = await input.transport.reserve({
        documentType,
        entryVersion: version,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
        idempotencyKey: resolved.key,
      });
    } catch {
      outcome = { kind: "retryable", code: "DOCUMENT_STORAGE_UNAVAILABLE" };
    }
    if (outcome.kind === "reserved") {
      version = outcome.entryVersion;
      reserved.push({
        documentType,
        documentId: outcome.documentId,
        upload: outcome.upload,
        fingerprint,
        idempotencyKey: resolved.key,
      });
      continue;
    }
    fail(documentType, outcome, fingerprint);
  }

  // 2. PUT song song cho cac mat da reserve thanh cong.
  const putResults = await Promise.all(reserved.map(async (item) => {
    if (!item.upload) return { item, ok: true as const, code: null };
    try {
      const outcome = await input.transport.put({
        documentType: item.documentType,
        url: item.upload.url,
        headers: item.upload.headers,
      });
      return { item, ok: outcome.ok, code: outcome.ok ? null : outcome.code };
    } catch {
      return { item, ok: false as const, code: "DOCUMENT_STORAGE_UNAVAILABLE" };
    }
  }));
  const putOk = new Set<CccdDocumentType>();
  for (const entry of putResults) {
    if (entry.ok) {
      putOk.add(entry.item.documentType);
      continue;
    }
    fail(entry.item.documentType, { kind: "retryable", code: entry.code ?? "DOCUMENT_STORAGE_UNAVAILABLE" },
      entry.item.fingerprint);
  }

  // 3. Finalize tuan tu theo thu tu plan, dung version moi nhat.
  let reloadNeeded = false;
  for (const item of reserved) {
    if (!putOk.has(item.documentType)) continue;
    let outcome: CccdFinalizeOutcome;
    try {
      outcome = await input.transport.finalize({
        documentType: item.documentType,
        documentId: item.documentId,
        entryVersion: version,
        idempotencyKey: tail(item.idempotencyKey),
      });
    } catch {
      outcome = { kind: "retryable", code: "DOCUMENT_FINALIZE_UNAVAILABLE" };
    }
    if (outcome.kind !== "finalized") {
      fail(item.documentType, outcome, item.fingerprint);
      continue;
    }
    version = outcome.entryVersion;
    // Khong optimistic READY: chi "complete" khi projection cua server da thoa dieu kien.
    const complete = cccdSlotComplete([outcome.document])[item.documentType];
    results.set(item.documentType, {
      documentType: item.documentType,
      status: complete ? "complete" : "pending",
      code: complete ? null : CCCD_VALIDATION_PENDING_CODE,
      retryable: false,
      conflict: false,
    });
    keyState = clearCccdKey(keyState, item.fingerprint);
    reloadNeeded = true;
  }

  // 4. Reload detail dung mot lan sau khi co ghi nhan thanh cong.
  let detail: CccdRunResult["detail"] = null;
  if (reloadNeeded) {
    try {
      detail = await input.transport.reloadDetail();
    } catch {
      detail = null;
    }
  }

  const slots = CCCD_DOCUMENT_TYPES
    .filter((documentType) => results.has(documentType))
    .map((documentType) => results.get(documentType) as CccdSlotResult);

  return {
    result: { slots, entryVersion: version, detail, planErrors: [] },
    keyState,
  };
}

/** SHA-256 lowercase hex tu BYTES (Web Crypto). Khong dung filename/duong dan. */
export async function sha256HexFromBytes(
  bytes: ArrayBuffer | Uint8Array,
): Promise<string | null> {
  try {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Copy sang ArrayBuffer rieng: tranh union ArrayBufferLike cua view goc.
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}
