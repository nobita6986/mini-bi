"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";

import { RecruiterTypeahead, type PickerOption } from "@/components/direct-entry/typeahead-picker-smoke";
import { DirectEntryPaymentEditor } from "@/components/direct-entry/direct-entry-payment-editor";
import { DirectEntryDocumentEditor } from "@/components/direct-entry/direct-entry-document-editor";
import { DirectEntryChangeRequestList } from "@/components/direct-entry/direct-entry-change-request-list";
import { DirectEntryChangeRequestProposer } from "@/components/direct-entry/direct-entry-change-request-proposer";
import { DirectEntryChangeRequestReviewer } from "@/components/direct-entry/direct-entry-change-request-reviewer";
import { DirectEntrySubmittedDocumentManager } from "@/components/direct-entry/direct-entry-submitted-document-manager";
import { DirectEntrySubmissionList } from "@/components/direct-entry/direct-entry-submission-list";
import { DirectEntryWorkerDocuments } from "@/components/direct-entry/direct-entry-worker-documents";
import { isRealCalendarDate } from "@/lib/analytics/identity/identity-shared.mjs";
import { validateEmployeeCode } from "@/lib/contracts/direct-entry-v1";
import {
  acceptDraftCreate,
  acceptDraftUpdate,
  changedDraftFields,
  draftRowFromProjection,
  editableFields,
  failDraftWrite,
  keepLocalDraft,
  markDraftConflict,
  applyServerDraft,
  updateLiveDraftRow,
  type ConflictCopy,
  type EditableDraftFields,
  type LiveDraftRow,
  type PendingDraftWrite,
} from "@/lib/direct-entry/live-controller";
import {
  clearIntentKey,
  confirmBlockReason,
  dropSubmissionRows,
  EMPTY_INTENT_KEY,
  isRowEditable,
  mergeReloadedDrafts,
  resolveIntentKey,
  shortRef,
  transitionErrorMessage,
  type SubmissionAction,
  type TransitionIntentKeyState,
} from "@/lib/direct-entry/submission-lifecycle";
import { parseWorkerProfilePaste } from "@/lib/direct-entry/worker-profile-paste";
import {
  createWorkerProfileTemplate,
  workerProfileXlsxToTsv,
} from "@/lib/direct-entry/worker-profile-xlsx";
import {
  EMPTY_CCCD_STATUS_CACHE,
  readCccdStatus,
  writeCccdStatus,
  type CccdStatusCache,
} from "@/lib/direct-entry/cccd-status";
import type { CccdDocumentSummary } from "@/lib/direct-entry/cccd-document-pair";
import { changeRequestErrorMessage } from "@/lib/direct-entry/change-request-proposer";
import { projectChangeRequestStateResult } from "@/lib/direct-entry/change-request-contract";
import {
  projectChangeRequestListPage,
  type ChangeRequestListItem,
} from "@/lib/direct-entry/change-request-read-contract";
import {
  projectSubmissionListPage,
  type SubmissionReadItem,
} from "@/lib/direct-entry/submission-read-contract";
import { projectSubmissionTransitionResult } from "@/lib/direct-entry/submission-transition-contract";
import {
  DRAFT_LIST_PROJECTION_VERSION,
  projectOwnDrafts,
  type OwnDraft,
} from "@/lib/direct-entry/draft-list-contract";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";
import { projectDraftProfileGridCells } from "@/lib/direct-entry/draft-profile-grid";
import {
  DirectEntrySpreadsheetGrid,
  type SpreadsheetGridRow,
  type SpreadsheetPasteRejection,
  type SpreadsheetPasteRequest,
} from "@/components/direct-entry/direct-entry-spreadsheet-grid";
import { buildSpreadsheetValidation } from "@/lib/direct-entry/direct-entry-grid-validation";
import {
  captureClipboardUndoSnapshot,
  restoreClipboardUndoSnapshot,
  type ClipboardUndoSnapshot,
} from "@/lib/direct-entry/direct-entry-grid-clipboard";
import {
  SPREADSHEET_WRITABLE_FIELD_KEYS,
  SPREADSHEET_MAX_DATA_ROWS,
  createSpreadsheetRowModel,
  deleteSpreadsheetRow,
  ensureSpreadsheetRowCount,
  spreadsheetRowIsBlank,
  selectNonEmptySpreadsheetRows,
  updateSpreadsheetRowProviderType,
  updateSpreadsheetRowCells,
  type SpreadsheetRowModel,
} from "@/lib/direct-entry/spreadsheet-row-model";
import {
  buildServerGeneratedFullProfileRequestBody,
  fullProfileErrorMessage,
  fullProfileIntentDigest,
  postFullProfileBatch,
} from "@/lib/direct-entry/full-profile-batch";
import styles from "./direct-entry-shell.module.css";

/** Message tu choi paste, da duoc viet san; khong chua gia tri nguoi dung. */
const PASTE_REJECTION_MESSAGES: Record<SpreadsheetPasteRejection, string> = {
  CLIPBOARD_ROW_OVERFLOW: "Vùng dán vượt quá 100 dòng dữ liệu nên đã bị từ chối toàn bộ.",
  CLIPBOARD_COLUMN_OVERFLOW: "Vùng dán vượt quá cột cuối của bảng nên đã bị từ chối toàn bộ.",
  CLIPBOARD_ANCHOR_INVALID: "Chưa xác định được ô neo để dán.",
  CLIPBOARD_EMPTY: "Clipboard không có dữ liệu văn bản.",
  CLIPBOARD_PERSISTED_ROW: "Để tránh sửa nhầm bản nháp đã lưu, chỉ dán ma trận vào vùng dòng chưa lưu.",
};

const SUBMISSION_PAGE_SIZE = 50;
const CHANGE_REQUEST_PAGE_SIZE = 50;
const CHANGE_REQUEST_LIST_KEYS = ["requests", "page_size", "has_more", "next_cursor"] as const;
const CHANGE_REQUEST_RESULT_KEYS = ["request_id", "state", "version"] as const;
const SUBMISSION_LIST_KEYS = ["items", "page_size", "has_more", "next_cursor"] as const;
const SUBMISSION_TRANSITION_KEYS = ["submission_id", "state", "version"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lay dung cac truong projection tu envelope { ok: true, ... } cua API.
 * Thieu truong hoac ok khac true => null (fail-closed, khong fallback).
 */
function projectionSlice(
  body: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(body) || body.ok !== true) return null;
  const slice: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in body)) return null;
    slice[key] = body[key];
  }
  return slice;
}

function hcmDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseCatalog(value: unknown, expectedDate: string): DraftCatalog | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.catalog) ||
      value.catalog.effective_date !== expectedDate ||
      !Array.isArray(value.catalog.projects) || !Array.isArray(value.catalog.recruiters) ||
      !Array.isArray(value.catalog.banks)) return null;
  if (!value.catalog.projects.every((project) => isRecord(project) &&
      typeof project.project_id === "string" && typeof project.display_name === "string") ||
      !value.catalog.recruiters.every((recruiter) => isRecord(recruiter) &&
        typeof recruiter.recruiter_id === "string" && typeof recruiter.display_name === "string" &&
        (recruiter.provider_type === "hrp" || recruiter.provider_type === "vendor") &&
        typeof recruiter.team_id === "string" && typeof recruiter.team_display_name === "string")) {
    return null;
  }
  if (!value.catalog.banks.every((bank) => isRecord(bank) &&
      typeof bank.bank_id === "string" && typeof bank.display_name === "string")) return null;
  return value.catalog as DraftCatalog;
}

function spreadsheetCatalogOptions(catalog: DraftCatalog | undefined) {
  return {
    projects: (catalog?.projects ?? []).map((project) => ({
      id: project.project_id,
      label: project.display_name,
    })),
    recruiters: (catalog?.recruiters ?? []).map((recruiter) => ({
      id: recruiter.recruiter_id,
      label: recruiter.display_name,
      provider_type: recruiter.provider_type,
    })),
  };
}

function parseOwnDrafts(value: unknown): OwnDraft[] | null {
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.ok !== true ||
      value.projection_version !== DRAFT_LIST_PROJECTION_VERSION) return null;
  return projectOwnDrafts({
    projection_version: value.projection_version,
    drafts: value.drafts,
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function optionalWorker(value: string) {
  return {
    display_name: value,
    date_of_birth: { state: "omitted" },
    national_id: { state: "omitted" },
    address: { state: "omitted" },
    phone: { state: "omitted" },
  };
}

function createPayload(row: LiveDraftRow) {
  return {
    project_id: row.projectId,
    first_work_date: row.firstWorkDate,
    employee_code: row.employeeCode,
    worker: optionalWorker(row.workerName),
    recruiter_id: row.recruiterId,
    labor_type: row.laborType,
  };
}

function updatePayload(fields: EditableDraftFields) {
  return {
    project_id: fields.projectId,
    first_work_date: fields.firstWorkDate,
    employee_code: fields.employeeCode,
    worker_details: { display_name: fields.workerName },
    recruiter_id: fields.recruiterId,
    labor_type: fields.laborType,
  };
}

function optionsFor(catalog: DraftCatalog | undefined): PickerOption[] {
  return catalog?.recruiters.map((recruiter) => ({
    id: recruiter.recruiter_id,
    label: recruiter.display_name,
    groupLabel: `${recruiter.provider_type.toUpperCase()} · ${recruiter.team_display_name}`,
    provider: recruiter.provider_type.toUpperCase(),
    team: recruiter.team_display_name,
  })) ?? [];
}

function displayProject(row: LiveDraftRow, catalog: DraftCatalog | undefined): string {
  return catalog?.projects.find(({ project_id }) => project_id === row.projectId)?.display_name ??
    row.projectDisplayName;
}

function displayRecruiter(row: LiveDraftRow, catalog: DraftCatalog | undefined): string {
  return catalog?.recruiters.find(({ recruiter_id }) => recruiter_id === row.recruiterId)?.display_name ?? "";
}

function rowWithFields(row: LiveDraftRow, fields: EditableDraftFields): LiveDraftRow {
  return { ...row, ...fields };
}

function stateText(state: LiveDraftRow["state"]): string {
  return {
    clean: "Đã lưu",
    dirty: "Có thay đổi chưa lưu",
    saving: "Đang lưu",
    saved: "Đã lưu thành công",
    conflict: "Xung đột phiên bản",
    error: "Lỗi lưu",
  }[state];
}

function Field({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return <label className={styles.field}><span>{label}</span>{children}</label>;
}

export function DirectEntryLive() {
  const [today] = useState(hcmDate);
  const [rows, setRows] = useState<LiveDraftRow[]>([]);
  const rowsRef = useRef(rows);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, DraftCatalog>>({});
  const catalogCache = useRef(new Map<string, DraftCatalog>());
  const catalogLoads = useRef(new Map<string, Promise<DraftCatalog>>());
  const [catalogErrors, setCatalogErrors] = useState<Record<string, string>>({});
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadMessage, setLoadMessage] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const inFlight = useRef(new Set<string>());
  const [submissions, setSubmissions] = useState<SubmissionReadItem[]>([]);
  const submissionsRef = useRef<SubmissionReadItem[]>([]);
  const [submissionListState, setSubmissionListState] = useState<"loading" | "ready" | "error">("loading");
  const [submissionListMessage, setSubmissionListMessage] = useState("");
  const [submissionHasMore, setSubmissionHasMore] = useState(false);
  const [busySubmissionId, setBusySubmissionId] = useState<string | null>(null);
  const [lifecycleMessage, setLifecycleMessage] = useState("");
  const cursorRef = useRef<string | null>(null);
  const intentKeys = useRef(new Map<string, TransitionIntentKeyState>());
  const lifecycleStatusRef = useRef<HTMLParagraphElement | null>(null);
  const [changeRequests, setChangeRequests] = useState<ChangeRequestListItem[]>([]);
  const [changeRequestListState, setChangeRequestListState] =
    useState<"loading" | "ready" | "error">("loading");
  const [changeRequestListMessage, setChangeRequestListMessage] = useState("");
  const [changeRequestHasMore, setChangeRequestHasMore] = useState(false);
  const [busyChangeRequestId, setBusyChangeRequestId] = useState<string | null>(null);
  const [changeRequestNotice, setChangeRequestNotice] = useState("");
  const [proposerSubmission, setProposerSubmission] = useState<SubmissionReadItem | null>(null);
  const [reviewRequest, setReviewRequest] = useState<ChangeRequestListItem | null>(null);
  const [manageDocumentsSubmission, setManageDocumentsSubmission] =
    useState<SubmissionReadItem | null>(null);
  const changeRequestCursorRef = useRef<string | null>(null);
  const changeRequestIntentKeys = useRef(new Map<string, TransitionIntentKeyState>());
  const [cccdCache, setCccdCache] = useState<CccdStatusCache>(EMPTY_CCCD_STATUS_CACHE);
  /**
   * P1.7-H06: selection di theo clientRowId (khong phai row index), dung cho
   * contextual action bar desktop. Luc chua co row nao duoc chon => null.
   * Cap nhat qua `onSelectedClientRowChange` cua DirectEntrySpreadsheetGrid.
   */
  const [selectedClientRowId, setSelectedClientRowId] = useState<string | null>(null);
  /**
   * P1.7-H06: rowId cua NLĐ dang mo hop thoai "Hồ sơ NLĐ" (CCCD + EMPLOYMENT_CONTRACT).
   * CCCD rieng (legacy) khong con mo tren UI nguoi dung; việc xem hồ sơ CCCD
   * đi qua documents dialog.
   */
  const [documentsRowId, setDocumentsRowId] = useState<string | null>(null);
  /**
   * P1.7-H06: CTA xuat hien sau khi server xac nhan save thanh cong de nhac
   * nguoi dung mo "Hồ sơ NLĐ" (khong tu mo file browser, khong tu upload).
   */
  const [savedCtaClientRowId, setSavedCtaClientRowId] = useState<string | null>(null);
  /**
   * P1.7-H06: entry_id de mot doi nen giu selection chuyen sang persisted row
   * tuong ung sau khi reload. Effect ben doc se set
   * `selectedClientRowId = rowId` neu row co entry_id trung khop.
   */
  const [selectionAfterSaveEntryId, setSelectionAfterSaveEntryId] =
    useState<string | null>(null);
  const selectedRow = rows.find(({ rowId }) => rowId === selectedRowId) ?? null;
  /**
   * P1.7-H06: resolved lookup cho contextual action bar. `clientRowId` co the
   * la rowId (persisted) hoac staged id (spreadsheet-row-N). Lookup do selected
   * spreadsheetRows (ghep persisted + staged) de tra ra dung kieu.
   */
  const documentsRow = rows.find(({ rowId }) => rowId === documentsRowId) ?? null;
  const catalogFor = useCallback((date: string) => catalogs[date], [catalogs]);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const ensureCatalog = useCallback((date: string): Promise<DraftCatalog> => {
    const cached = catalogCache.current.get(date);
    if (cached) return Promise.resolve(cached);
    const inProgress = catalogLoads.current.get(date);
    if (inProgress) return inProgress;
    const load = fetch(`/api/direct-entry/catalog?effective_date=${encodeURIComponent(date)}`, {
      cache: "no-store",
      credentials: "same-origin",
    }).then(async (response) => {
      const body = await readJson(response);
      const payload = parseCatalog(body, date);
      if (!response.ok || !payload) {
        const code = isRecord(body) && typeof body.code === "string" ? body.code : "CATALOG_UNAVAILABLE";
        if (response.status === 401 || response.status === 403) throw new Error(code);
        throw new Error("CATALOG_UNAVAILABLE");
      }
      catalogCache.current.set(date, payload);
      setCatalogs((current) => ({ ...current, [date]: payload }));
      setCatalogErrors((current) => {
        const next = { ...current };
        delete next[date];
        return next;
      });
      return payload;
    }).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : "CATALOG_UNAVAILABLE";
      setCatalogErrors((current) => ({ ...current, [date]: message }));
      throw cause;
    }).finally(() => {
      catalogLoads.current.delete(date);
    });
    catalogLoads.current.set(date, load);
    return load;
  }, []);

  useEffect(() => {
    submissionsRef.current = submissions;
  }, [submissions]);

  const loadSubmissions = useCallback(async (mode: "replace" | "append") => {
    setSubmissionListState("loading");
    try {
      const params = new URLSearchParams({ page_size: String(SUBMISSION_PAGE_SIZE) });
      if (mode === "append" && cursorRef.current) params.set("cursor", cursorRef.current);
      const response = await fetch("/api/direct-entry/submissions?" + params.toString(), {
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = await readJson(response);
      const page = projectSubmissionListPage(
        projectionSlice(body, SUBMISSION_LIST_KEYS),
        { page_size: SUBMISSION_PAGE_SIZE },
      );
      if (!response.ok || !page) throw new Error("SUBMISSIONS_UNAVAILABLE");
      setSubmissions((current) => {
        if (mode === "replace") return page.items;
        const seen = new Set(current.map((item) => item.submission_id));
        return [...current, ...page.items.filter((item) => !seen.has(item.submission_id))];
      });
      cursorRef.current = page.next_cursor;
      setSubmissionHasMore(page.has_more);
      setSubmissionListState("ready");
      setSubmissionListMessage("");
    } catch (cause) {
      setSubmissionListState("error");
      setSubmissionListMessage(cause instanceof Error ? cause.message : "SUBMISSIONS_UNAVAILABLE");
    }
  }, []);

  const reloadDrafts = useCallback(async () => {
    const response = await fetch("/api/direct-entry/drafts", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const payload = parseOwnDrafts(await readJson(response));
    if (!response.ok || !payload) throw new Error("DRAFTS_UNAVAILABLE");
    const serverRows = payload.map(draftRowFromProjection);
    setRows((current) => mergeReloadedDrafts(current, serverRows));
  }, []);

  const runTransition = useCallback(async (input: {
    submission: SubmissionReadItem;
    action: SubmissionAction;
  }) => {
    const { submission, action } = input;
    const submissionId = submission.submission_id;
    const intent = submissionId + ":" + action.target_state;
    const resolved = resolveIntentKey(
      intentKeys.current.get(submissionId) ?? EMPTY_INTENT_KEY,
      intent,
      () => crypto.randomUUID(),
    );
    intentKeys.current.set(submissionId, resolved.state);
    setBusySubmissionId(submissionId);
    try {
      const response = await fetch(
        "/api/direct-entry/submissions/" + encodeURIComponent(submissionId) + "/transition",
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": resolved.key,
          },
          body: JSON.stringify({
            expected_version: submission.version,
            target_state: action.target_state,
            idempotency_key: resolved.key,
          }),
        },
      );
      const body = await readJson(response);
      if (response.status === 409) {
        intentKeys.current.set(submissionId, clearIntentKey(resolved.state, intent));
        setLifecycleMessage(transitionErrorMessage(409));
        await loadSubmissions("replace");
        return;
      }
      if (response.ok) {
        const updated = projectSubmissionTransitionResult(
          projectionSlice(body, SUBMISSION_TRANSITION_KEYS),
          { submission_id: submissionId, expected_version: submission.version },
        );
        if (!updated) {
          // 2xx nhung projection khong doc duoc: ket qua khong xac dinh => giu key de thu lai.
          setLifecycleMessage(transitionErrorMessage(500));
          return;
        }
        intentKeys.current.set(submissionId, clearIntentKey(resolved.state, intent));
        setSubmissions((current) => current.map((item) =>
          item.submission_id === updated.submission_id
            ? { ...item, state: updated.state, version: updated.version }
            : item,
        ));
        if (updated.state === "REVIEW") {
          setRows((current) => dropSubmissionRows(current, updated.submission_id));
          setLifecycleMessage(
            "Đã gửi duyệt đợt " + shortRef(updated.submission_id) +
              ". Dòng thuộc đợt này tạm khóa chỉnh sửa cho tới khi được trả về bản nháp.",
          );
        } else if (updated.state === "DRAFT") {
          await reloadDrafts();
          setLifecycleMessage(
            "Đã trả đợt " + shortRef(updated.submission_id) + " về bản nháp và tải lại bản nháp máy chủ.",
          );
        } else {
          setLifecycleMessage(
            "Đã gửi chính thức đợt " + shortRef(updated.submission_id) +
              ". Đợt ở trạng thái cuối; thay đổi sau đó phải đi qua yêu cầu thay đổi.",
          );
        }
        await loadSubmissions("replace");
        lifecycleStatusRef.current?.focus();
        return;
      }
      const status = response.status;
      if (status >= 500) {
        // Loi phia may chu: giu idempotency key de nut thu lai dung cung intent.
        setLifecycleMessage(transitionErrorMessage(status));
        return;
      }
      intentKeys.current.set(submissionId, clearIntentKey(resolved.state, intent));
      setLifecycleMessage(transitionErrorMessage(status));
      if (status === 401 || status === 403 || status === 404) {
        await loadSubmissions("replace");
      }
    } catch {
      // Network uncertainty: giu key de lan thu lai cua CUNG intent khong tao tac dong thu hai.
      setLifecycleMessage(transitionErrorMessage(0));
    } finally {
      setBusySubmissionId(null);
    }
  }, [loadSubmissions, reloadDrafts]);

  const loadChangeRequests = useCallback(async (mode: "replace" | "append") => {
    setChangeRequestListState("loading");
    try {
      const params = new URLSearchParams({ page_size: String(CHANGE_REQUEST_PAGE_SIZE) });
      if (mode === "append" && changeRequestCursorRef.current) {
        params.set("cursor", changeRequestCursorRef.current);
      }
      const response = await fetch("/api/direct-entry/change-requests?" + params.toString(), {
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = await readJson(response);
      const page = projectChangeRequestListPage(
        projectionSlice(body, CHANGE_REQUEST_LIST_KEYS),
        { page_size: CHANGE_REQUEST_PAGE_SIZE },
      );
      if (!response.ok || !page) throw new Error("CHANGE_REQUESTS_UNAVAILABLE");
      setChangeRequests((current) => {
        if (mode === "replace") return page.requests;
        const seen = new Set(current.map((item) => item.request_id));
        return [...current, ...page.requests.filter((item) => !seen.has(item.request_id))];
      });
      changeRequestCursorRef.current = page.next_cursor;
      setChangeRequestHasMore(page.has_more);
      setChangeRequestListState("ready");
      setChangeRequestListMessage("");
    } catch (cause) {
      setChangeRequestListState("error");
      setChangeRequestListMessage(
        cause instanceof Error ? cause.message : "CHANGE_REQUESTS_UNAVAILABLE",
      );
    }
  }, []);

  const withdrawChangeRequest = useCallback(async (request: ChangeRequestListItem) => {
    const intent = "change_request_withdraw:" + request.request_id + ":" + request.version;
    const resolved = resolveIntentKey(
      changeRequestIntentKeys.current.get(request.request_id) ?? EMPTY_INTENT_KEY,
      intent,
      () => crypto.randomUUID(),
    );
    changeRequestIntentKeys.current.set(request.request_id, resolved.state);
    setBusyChangeRequestId(request.request_id);
    try {
      const response = await fetch(
        "/api/direct-entry/change-requests/" + encodeURIComponent(request.request_id) + "/withdraw",
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": resolved.key,
          },
          body: JSON.stringify({
            expected_version: request.version,
            idempotency_key: resolved.key,
          }),
        },
      );
      const body = await readJson(response);
      if (response.ok) {
        const updated = projectChangeRequestStateResult(
          projectionSlice(body, CHANGE_REQUEST_RESULT_KEYS),
          { request_id: request.request_id, expected_version: request.version, state: "WITHDRAWN" },
        );
        if (!updated) {
          setChangeRequestNotice(changeRequestErrorMessage(500));
          return;
        }
        changeRequestIntentKeys.current.set(
          request.request_id,
          clearIntentKey(resolved.state, intent),
        );
        setChangeRequestNotice("Đã rút yêu cầu " + shortRef(updated.request_id) + ".");
        await loadChangeRequests("replace");
        return;
      }
      const status = response.status;
      if (status === 409) {
        changeRequestIntentKeys.current.set(
          request.request_id,
          clearIntentKey(resolved.state, intent),
        );
        setChangeRequestNotice(changeRequestErrorMessage(409));
        await Promise.all([loadSubmissions("replace"), loadChangeRequests("replace")]);
        return;
      }
      if (status >= 500) {
        setChangeRequestNotice(changeRequestErrorMessage(status));
        return;
      }
      changeRequestIntentKeys.current.set(
        request.request_id,
        clearIntentKey(resolved.state, intent),
      );
      setChangeRequestNotice(changeRequestErrorMessage(status));
      if (status === 401 || status === 403) {
        await Promise.all([loadSubmissions("replace"), loadChangeRequests("replace")]);
      }
    } catch {
      setChangeRequestNotice(changeRequestErrorMessage(0));
    } finally {
      setBusyChangeRequestId(null);
    }
  }, [loadChangeRequests, loadSubmissions]);

  const reloadAfterChangeRequestMutation = useCallback(async (message: string) => {
    setChangeRequestNotice(message);
    await Promise.all([loadSubmissions("replace"), loadChangeRequests("replace")]);
  }, [loadChangeRequests, loadSubmissions]);

  const blockedSubmissionIds = useMemo(() => {
    const blocked = new Set<string>();
    for (const submission of submissions) {
      if (confirmBlockReason(rows, submission.submission_id) !== null) {
        blocked.add(submission.submission_id);
      }
    }
    return blocked;
  }, [rows, submissions]);

  const onPaymentEntryVersionChange = useCallback((rowId: string, entryVersion: number) => {
    const next = rowsRef.current.map((row) =>
      row.rowId === rowId ? { ...row, entryVersion } : row,
    );
    rowsRef.current = next;
    setRows(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadState("loading");
      try {
        const sessionResponse = await fetch("/api/direct-entry/session", {
          cache: "no-store",
          credentials: "same-origin",
        });
        const session = await readJson(sessionResponse);
        if (!sessionResponse.ok || !isRecord(session) || session.ok !== true) {
          const code = isRecord(session) && typeof session.code === "string"
            ? session.code
            : "SESSION_UNAVAILABLE";
          throw new Error(code);
        }
        if (!isRecord(session.actor) || !Array.isArray(session.actor.capabilities) ||
            !session.actor.capabilities.every((capability) => typeof capability === "string")) {
          throw new Error("SESSION_UNAVAILABLE");
        }
        setCapabilities(session.actor.capabilities);
        void loadSubmissions("replace");
        void loadChangeRequests("replace");
        const [draftResponse, catalog] = await Promise.all([
          fetch("/api/direct-entry/drafts", { cache: "no-store", credentials: "same-origin" }),
          ensureCatalog(today),
        ]);
        const draftPayload = parseOwnDrafts(await readJson(draftResponse));
        if (!draftResponse.ok || !draftPayload) {
          throw new Error("DRAFTS_UNAVAILABLE");
        }
        const mapped = draftPayload.map(draftRowFromProjection);
        const neededDates = [...new Set(mapped.map(({ firstWorkDate }) => firstWorkDate))]
          .filter((date) => date !== today);
        await Promise.all(neededDates.map(ensureCatalog));
        if (cancelled) return;
        setRows(mapped);
        setCatalogs((current) => ({ ...current, [today]: catalog }));
        setLoadState("ready");
        setLoadMessage("");
      } catch (cause) {
        if (cancelled) return;
        setLoadState("error");
        setLoadMessage(cause instanceof Error ? cause.message : "DIRECT_ENTRY_UNAVAILABLE");
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [ensureCatalog, loadChangeRequests, loadSubmissions, today]);

  useEffect(() => {
    for (const row of rows) {
      if (row.firstWorkDate && !catalogCache.current.has(row.firstWorkDate) &&
          !catalogErrors[row.firstWorkDate]) {
        void ensureCatalog(row.firstWorkDate).then((catalog) => {
          const current = rowsRef.current.find(({ rowId }) => rowId === row.rowId);
          if (current && current.recruiterId &&
              !catalog.recruiters.some(({ recruiter_id }) => recruiter_id === current.recruiterId)) {
            setRows((existing) => updateLiveDraftRow(existing, current.rowId, { recruiterId: "" }));
          }
        }).catch(() => {});
      }
    }
  }, [catalogErrors, ensureCatalog, rows]);

  const updateRow = useCallback((
    rowId: string,
    patch: Partial<EditableDraftFields>,
  ) => {
    setRows((current) => updateLiveDraftRow(current, rowId, patch));
  }, []);

  const fetchConflictCopy = useCallback(async (entryId: string): Promise<ConflictCopy | null> => {
    const projectionResponse = await fetch(
      `/api/direct-entry/entries/${encodeURIComponent(entryId)}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    const projection = await readJson(projectionResponse);
    if (!projectionResponse.ok || !isRecord(projection) || projection.ok !== true ||
        !isRecord(projection.entry) || projection.entry.entry_id !== entryId) return null;
    const draftsResponse = await fetch("/api/direct-entry/drafts", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const drafts = parseOwnDrafts(await readJson(draftsResponse));
    if (!draftsResponse.ok || !drafts) return null;
    const latest = drafts.find(({ entry_id }) => entry_id === entryId);
    if (!latest) return null;
    await ensureCatalog(latest.first_work_date);
    const serverRow = draftRowFromProjection(latest);
    return {
      version: serverRow.entryVersion!,
      submissionVersion: serverRow.submissionVersion!,
      fields: editableFields(serverRow),
    };
  }, [ensureCatalog]);

  const retryConflictLoad = useCallback(async (rowId: string) => {
    const current = rowsRef.current.find((row) => row.rowId === rowId);
    if (!current?.entryId || current.state !== "conflict") return;
    try {
      const conflictCopy = await fetchConflictCopy(current.entryId);
      if (!conflictCopy) throw new Error("DRAFT_CONFLICT_PROJECTION_UNAVAILABLE");
      setRows((existing) => existing.map((row) => row.rowId === rowId
        ? { ...row, conflictCopy, message: null }
        : row));
    } catch {
      setRows((existing) => existing.map((row) => row.rowId === rowId
        ? { ...row, message: "Không tải được bản mới từ máy chủ. Hãy thử lại." }
        : row));
    }
  }, [fetchConflictCopy]);

  const [stagedModel, setStagedModel] = useState<SpreadsheetRowModel>(() => createSpreadsheetRowModel());

  // P1.7-H05 §9.A & §9.B: handlers cho nut "Thêm dòng" / "Thêm nhanh NLĐ" duoc
  // dinh nghia ben duoi sau khi stagedMessage, setStagedMessage, quickEditClientRowId
  // va setQuickEditClientRowId da duoc khai bao (tranh "Cannot access variable
  // before it is declared" do React Compiler).

  const saveRow = useCallback(async (rowId: string) => {
    const current = rowsRef.current.find((row) => row.rowId === rowId);
    if (!current || current.state === "saving" || current.state === "conflict" ||
        inFlight.current.has(rowId)) return;
    if (current.entryId && !isRowEditable(current, submissionsRef.current)) {
      setRows((existing) => existing.map((row) => row.rowId === rowId
        ? { ...row, state: "error", message:
          "Đợt này không còn ở bản nháp nên không lưu trực tiếp được. Hãy tải lại danh sách." }
        : row));
      return;
    }
    const catalog = catalogCache.current.get(current.firstWorkDate);
    if (!catalog) {
      setCatalogErrors((errors) => ({
        ...errors,
        [current.firstWorkDate]: errors[current.firstWorkDate] ?? "CATALOG_UNAVAILABLE",
      }));
      return;
    }
    const validation = validateEmployeeCode(current.employeeCode, current.firstWorkDate);
    const valid = isRealCalendarDate(current.firstWorkDate) &&
      current.workerName.trim().length > 0 &&
      catalog.projects.some(({ project_id }) => project_id === current.projectId) &&
      catalog.recruiters.some(({ recruiter_id }) => recruiter_id === current.recruiterId) &&
      validation.length === 0;
    if (!valid) {
      updateRow(rowId, { recruiterId: catalog.recruiters.some(({ recruiter_id }) =>
        recruiter_id === current.recruiterId) ? current.recruiterId : "",
      });
      setRows((existing) => existing.map((row) => row.rowId === rowId
        ? { ...row, state: "error", message: "Kiểm tra ngày, mã, họ tên, dự án và người tuyển." }
        : row));
      return;
    }
    inFlight.current.add(rowId);
    const pending: PendingDraftWrite = current.pendingWrite ?? {
      key: crypto.randomUUID(),
      fields: editableFields(current),
      expectedVersion: current.entryVersion,
    };
    setRows((existing) => existing.map((row) => row.rowId === rowId
      ? { ...row, state: "saving", pendingWrite: pending, message: null }
      : row));
    try {
      const response = pending.expectedVersion === null
        ? await fetch("/api/direct-entry/batches", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": pending.key,
          },
          body: JSON.stringify({ rows: [createPayload(rowWithFields(current, pending.fields))] }),
        })
        : await fetch(`/api/direct-entry/entries/${encodeURIComponent(current.entryId!)}`, {
          method: "PATCH",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": pending.key,
          },
          body: JSON.stringify({
            expected_version: pending.expectedVersion,
            patch: updatePayload(pending.fields),
          }),
        });
      const payload = await readJson(response);
      if (response.status === 409 && pending.expectedVersion !== null) {
        let conflictCopy: ConflictCopy | null = null;
        try {
          conflictCopy = await fetchConflictCopy(current.entryId!);
        } catch {
          conflictCopy = null;
        }
        setRows((existing) => existing.map((row) => row.rowId === rowId
          ? markDraftConflict(row, pending, conflictCopy)
          : row));
        return;
      }
      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : "SAVE_FAILED";
        throw new Error(code);
      }
      if (pending.expectedVersion === null) {
        if (typeof payload.submission_id !== "string" ||
            typeof payload.submission_version !== "number" ||
            !Array.isArray(payload.entry_ids) || typeof payload.entry_ids[0] !== "string") {
          throw new Error("SAVE_RESPONSE_INVALID");
        }
        const entryId = payload.entry_ids[0];
        const submissionId = payload.submission_id;
        const submissionVersion = payload.submission_version;
        setRows((existing) => existing.map((row) => row.rowId === rowId
          ? acceptDraftCreate(row, pending, {
            entryId,
            submissionId,
            entryVersion: 1,
            submissionVersion,
          })
          : row));
        setSelectedRowId((selected) => selected === rowId ? entryId : selected);
      } else {
        if (typeof payload.entry_version !== "number" ||
            typeof payload.submission_version !== "number") {
          throw new Error("SAVE_RESPONSE_INVALID");
        }
        const entryVersion = payload.entry_version;
        const submissionVersion = payload.submission_version;
        setRows((existing) => existing.map((row) => {
          if (row.rowId !== rowId) return row;
          return acceptDraftUpdate(row, pending, { entryVersion, submissionVersion });
        }));
      }
      window.setTimeout(() => {
        setRows((existing) => existing.map((row) => row.rowId === rowId && row.state === "saved"
          ? { ...row, state: "clean" }
          : row));
      }, 1600);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "SAVE_FAILED";
      setRows((existing) => existing.map((row) => row.rowId === rowId
        ? failDraftWrite(row, pending, code)
        : row));
    } finally {
      inFlight.current.delete(rowId);
    }
  }, [fetchConflictCopy, updateRow]);

  const setCccdStatus = useCallback((
    entryId: string,
    entryVersion: number,
    documents: readonly CccdDocumentSummary[],
  ) => {
    setCccdCache((current) => writeCccdStatus(current, entryId, entryVersion, documents));
  }, []);

  const loadLatest = useCallback((rowId: string) => {
    setRows((current) => current.map((row) => {
      if (row.rowId !== rowId || !row.conflictCopy) return row;
      const catalog = catalogCache.current.get(row.conflictCopy.fields.firstWorkDate);
      const recruiter = catalog?.recruiters.find(
        ({ recruiter_id }) => recruiter_id === row.conflictCopy?.fields.recruiterId,
      );
      const project = catalog?.projects.find(
        ({ project_id }) => project_id === row.conflictCopy?.fields.projectId,
      );
      const resolved = applyServerDraft(row);
      return {
        ...resolved,
        providerType: recruiter?.provider_type ?? null,
        teamId: recruiter?.team_id ?? null,
        teamDisplayName: recruiter?.team_display_name ?? "",
        recruiterDisplayName: recruiter?.display_name ?? "",
        projectDisplayName: project?.display_name ?? "",
      };
    }));
    setSelectedRowId(null);
  }, []);

  const keepLocal = useCallback((rowId: string) => {
    setRows((current) => current.map((row) => {
      if (row.rowId !== rowId || !row.conflictCopy) return row;
      return keepLocalDraft(row);
    }));
    setSelectedRowId(null);
  }, []);

  /* ------------------------------------------------------- P1.7-W02 spreadsheet */
  // Row staging client-only: khong tron clientRowId voi entry_id va khong tao server draft.
  const [stagedNotice, setStagedNotice] = useState("");
  const [stagedMessage, setStagedMessage] = useState("");
  const [stagedRejection, setStagedRejection] = useState("");
  const [stagedBusy, setStagedBusy] = useState(false);
  const [stagedCanUndo, setStagedCanUndo] = useState(false);
  const [xlsxMessage, setXlsxMessage] = useState("");
  // P1.7-H05 §9.B: clientRowId cua row dang mo quick editor (drawer/dialog nhap nhanh).
  const [quickEditClientRowId, setQuickEditClientRowId] = useState<string | null>(null);
  const xlsxInputRef = useRef<HTMLInputElement>(null);
  const stagedIntent = useRef<TransitionIntentKeyState>(EMPTY_INTENT_KEY);
  const stagedUndo = useRef<ClipboardUndoSnapshot | null>(null);
  const stagedInFlight = useRef(false);

  /**
   * P1.7-H05 §9.A: nút "Thêm dòng" — mỗi lần bấm thêm đúng 10 staged rows.
   * Neu khong con du cho 10 row (gioi han 100 data) thi KHONG them mot phan.
   */
  const ADD_STAGED_ROW_BATCH = 10;
  const addStagedRows = useCallback(() => {
    setStagedModel((current) => {
      // R1: check dua tren tong staged rows hien co, khong phai so non-empty.
      // Gioi han 100 row; neu con duoi 10 vi tri thi KHONG them mot phan.
      if (current.rows.length + ADD_STAGED_ROW_BATCH > SPREADSHEET_MAX_DATA_ROWS) {
        setStagedMessage("Đã đạt giới hạn 100 dòng dữ liệu; không thêm được 10 dòng mới.");
        return current;
      }
      return ensureSpreadsheetRowCount(current, current.rows.length + ADD_STAGED_ROW_BATCH);
    });
  }, [setStagedModel, setStagedMessage]);

  const canAddStagedRows = useCallback((model: SpreadsheetRowModel) =>
    model.rows.length + ADD_STAGED_ROW_BATCH <= SPREADSHEET_MAX_DATA_ROWS,
  []);

  /**
   * P1.7-H05 §9.B: nút "Thêm nhanh NLĐ" — chọn một staged row trống và mở editor.
   * Neu khong co row trang thi tao moi (gioi han 100) va mo drawer editor cua row do.
   */
  const openQuickEditor = useCallback((clientRowId: string) => {
    setQuickEditClientRowId(clientRowId);
  }, [setQuickEditClientRowId]);
  const addQuickStagedRow = useCallback(() => {
    setStagedModel((current) => {
      const emptyRow = current.rows.find(spreadsheetRowIsBlank);
      if (emptyRow) {
        setQuickEditClientRowId(emptyRow.clientRowId);
        return current;
      }
      if (current.rows.length + 1 > SPREADSHEET_MAX_DATA_ROWS) {
        setStagedMessage("Đã đạt giới hạn 100 dòng dữ liệu; không mở thêm NLĐ mới.");
        return current;
      }
      const next = ensureSpreadsheetRowCount(current, current.rows.length + 1);
      // Tao row moi (chinh la row cuoi cung sau khi append):
      const newRow = next.rows[next.rows.length - 1];
      if (newRow) setQuickEditClientRowId(newRow.clientRowId);
      return next;
    });
  }, [setStagedModel, setStagedMessage, setQuickEditClientRowId]);


  const stagedCatalogSource = useCallback((date: string) => {
    const catalog = catalogs[date];
    if (!catalog) return null;
    return {
      projects: catalog.projects.map((project) => ({ id: project.project_id, label: project.display_name })),
      recruiters: catalog.recruiters.map((recruiter) => ({
        id: recruiter.recruiter_id,
        label: recruiter.display_name,
        provider_type: recruiter.provider_type,
      })),
    };
  }, [catalogs]);

  const stagedCatalogOptions = useMemo(() => {
    return spreadsheetCatalogOptions(catalogs[today]);
  }, [catalogs, today]);

  // Validation tai cho: chi chay tren staged rows KHONG trong, va tai dung pipeline P1.6.
  const stagedValidation = useMemo(() => buildSpreadsheetValidation({
    rows: stagedModel.rows,
    referenceDate: today,
    catalogFor: stagedCatalogSource,
    existing: rows.map((row) => ({ employeeCode: row.employeeCode })),
  }), [rows, stagedCatalogSource, stagedModel, today]);

  useEffect(() => {
    for (const date of stagedValidation.catalogDates) void ensureCatalog(date).catch(() => undefined);
  }, [ensureCatalog, stagedValidation]);

  const spreadsheetRows = useMemo<readonly SpreadsheetGridRow[]>(() => {
    const persisted: SpreadsheetGridRow[] = rows.map((row) => {
      const editable = row.state !== "saving" && row.state !== "conflict" &&
        isRowEditable(row, submissions);
      const profileCells = projectDraftProfileGridCells(row.profile);
      const employment = row.profile.employment;
      const employmentStatus = employment?.status ?? row.employmentStatus;
      const employmentStatusLabel = employmentStatus === "ON"
        ? "Đang làm"
        : employmentStatus === "OFF"
          ? "Đã nghỉ"
          : employmentStatus === "UNCONFIRMED"
            ? "Chưa xác nhận"
            : "Chưa xác định";
      const cccdStatus = readCccdStatus(cccdCache, row.entryId, row.entryVersion);
      // Chi 6 field da co safe mutation path duoc sua; field full-profile khac read-only (W03).
      return {
        clientRowId: row.rowId,
        persisted: row.entryId !== null,
        clientStaged: false,
        locked: !editable,
        providerType: row.providerType ?? "",
        cccdStatus: cccdStatus.label,
        canManageCccd: cccdStatus.canManage,
        catalogOptions: spreadsheetCatalogOptions(catalogFor(row.firstWorkDate)),
        displayValues: profileCells.displayValues,
        cells: {
          ...profileCells.cells,
          // P1.7-H05-R1: Mã NLĐ chi de hien thi (output), khong sua; cell key
          // van render gia tri hien tai de rail/drawer doc duoc.
          employee_code: row.employeeCode,
          first_work_date: row.firstWorkDate,
          display_name: row.workerName,
          project_id: row.projectId,
          recruiter_id: row.recruiterId,
          provider_hint: row.providerType?.toUpperCase() ?? "",
          team_hint: row.teamDisplayName,
          labor_type: row.laborType === "TEMPORARY" ? "Thời vụ" : "Chính thức",
          initial_status: employment
            ? `${employmentStatusLabel} · hiệu lực ${employment.effective_date}`
            : employmentStatusLabel,
        },
        editableFields: editable
          // P1.7-H05-R1: Mã NLĐ do server cấp; khong sua tren UI. 4 optional
          // field (STK/Bank/AccountHolder/Note) chi editable khi staged; duoc
          // hien thi read-only tren persisted (projection qua profileCells).
          ? ["first_work_date", "display_name", "project_id", "recruiter_id", "labor_type"]
          : [],
        employeeCode: row.employeeCode,
        displayName: row.workerName,
        projectLabel: displayProject(row, catalogFor(row.firstWorkDate)),
        recruiterLabel: displayRecruiter(row, catalogFor(row.firstWorkDate)),
        saveStatus: stateText(row.state),
      };
    });
    const staged: SpreadsheetGridRow[] = stagedModel.rows.map((row) => {
      const catalog = catalogs[row.cells.first_work_date ?? ""];
      const recruiter = catalog?.recruiters.find((option) =>
        option.recruiter_id === row.cells.recruiter_id ||
        option.display_name === row.cells.recruiter_id);
      const providerType = row.providerType || recruiter?.provider_type || "";
      return ({
      clientRowId: row.clientRowId,
      persisted: false,
      clientStaged: true,
      locked: false,
      providerType,
      cccdStatus: "Chưa lưu",
      canManageCccd: false,
      catalogOptions: spreadsheetCatalogOptions(catalog),
      cells: row.cells,
      editableFields: SPREADSHEET_WRITABLE_FIELD_KEYS,
      employeeCode: row.cells.employee_code ?? "",
      displayName: row.cells.display_name ?? "",
      projectLabel: row.cells.project_id ?? "",
      recruiterLabel: recruiter?.display_name ?? row.cells.recruiter_id ?? "",
      saveStatus: spreadsheetRowIsBlank(row) ? "" : "Chưa lưu",
    }); });
    return [...persisted, ...staged];
  }, [catalogFor, catalogs, cccdCache, rows, stagedModel, submissions]);

  /**
   * P1.7-H06: selected spreadsheet row lookup. Tra ra cho contextual action
   * bar de xac dinh loai row (staged/persisted), CCCD status va ten hien thi.
   *
   * Neu `selectedClientRowId` khong con trong `spreadsheetRows` (row da bi
   * xoa, hoac reload lam row bien mat), tra ve `null` de UI khong thao tac
   * nham NLĐ. Viec "clear" `selectedClientRowId` state chi chay khi can
   * (qua setter, KHONG goi setState trong effect).
   */
  const selectedSpreadsheetRow = useMemo(() => {
    if (selectedClientRowId === null) return null;
    for (const row of spreadsheetRows) {
      if (row.clientRowId === selectedClientRowId) return row;
    }
    return null;
  }, [selectedClientRowId, spreadsheetRows]);

  /**
   * P1.7-H06: chuyen selection tu staged sang persisted row tuong ung theo
   * server-returned entry_id sau khi `reloadDrafts` da nap xong. KHONG
   * doan theo row index, ho ten hay CCCD.
   *
   * Thay vi dung useEffect + setState (vi pham
   * `react-hooks/set-state-in-effect`), thuc hien resolve trong render
   * (React cho phep setState de derive state tu state khac trong render body
   * khi dieu kien phu thuoc thay doi). Khi `rows` chua co row voi entry_id
   * khop (dang cho reload), giu nguyen `selectionAfterSaveEntryId` de lan
   * render tiep theo resolve lai.
   */
  if (selectionAfterSaveEntryId !== null) {
    const match = rows.find((row) => row.entryId === selectionAfterSaveEntryId);
    if (match !== undefined) {
      setSelectedClientRowId(match.rowId);
      setSavedCtaClientRowId(match.rowId);
      setSelectionAfterSaveEntryId(null);
    } else if (rows.length > 0) {
      // Rows da duoc load nhung khong co entry_id khop: clear signal de khong
      // giu mot "ghost selection" ngoai grid, va clear selected an toan.
      setSelectedClientRowId(null);
      setSavedCtaClientRowId(null);
      setSelectionAfterSaveEntryId(null);
    }
  }

  const onSpreadsheetCellsChange = useCallback((
    clientRowId: string,
    patch: Readonly<Record<string, string>>,
  ) => {
    // P1.7-H05-R1: Mã NLĐ do server cấp; bo qua patch.employee_code de tranh
    // phat sinh mutation tren UI.
    const safePatch: Readonly<Record<string, string>> = patch.employee_code !== undefined
      ? Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "employee_code"))
      : patch;
    const persistedRow = rows.find((row) => row.rowId === clientRowId);
    if (persistedRow) {
      const draftPatch: Partial<EditableDraftFields> = {};
      if (safePatch.first_work_date !== undefined) draftPatch.firstWorkDate = safePatch.first_work_date;
      if (safePatch.display_name !== undefined) draftPatch.workerName = safePatch.display_name;
      if (safePatch.project_id !== undefined) draftPatch.projectId = safePatch.project_id;
      if (safePatch.recruiter_id !== undefined) draftPatch.recruiterId = safePatch.recruiter_id;
      if (safePatch.labor_type !== undefined) {
        draftPatch.laborType = safePatch.labor_type === "Chính thức" ? "PERMANENT" : "TEMPORARY";
      }
      if (Object.keys(draftPatch).length === 0) return;
      setRows((current) => updateLiveDraftRow(current, clientRowId, draftPatch));
      if (draftPatch.firstWorkDate && isRealCalendarDate(draftPatch.firstWorkDate)) {
        void ensureCatalog(draftPatch.firstWorkDate).catch(() => undefined);
      }
      return;
    }
    setStagedModel((current) => updateSpreadsheetRowCells(current, clientRowId, {
      ...safePatch,
      ...(safePatch.first_work_date !== undefined ? { recruiter_id: "" } : {}),
    }));
  }, [ensureCatalog, rows, setStagedModel]);

  const onStagedProviderTypeChange = useCallback((
    clientRowId: string,
    providerType: "hrp" | "vendor" | "",
  ) => {
    setStagedModel((current) =>
      updateSpreadsheetRowProviderType(current, clientRowId, providerType));
  }, [setStagedModel]);

  const onStagedPasteRejected = useCallback((reason: SpreadsheetPasteRejection) => {
    setStagedRejection(PASTE_REJECTION_MESSAGES[reason]);
    setStagedMessage("");
  }, [setStagedMessage]);

  /** Paste chi doi React state: khong fetch, khong storage, khong log gia tri. */
  const onStagedPaste = useCallback((request: SpreadsheetPasteRequest) => {
    const liveDraftRowCount = rows.length;
    if (request.mapping.cells.some((cell) => cell.rowIndex < liveDraftRowCount)) {
      setStagedRejection(PASTE_REJECTION_MESSAGES.CLIPBOARD_PERSISTED_ROW);
      setStagedMessage("");
      return;
    }
    const rebase = <T extends { rowIndex: number },>(cells: readonly T[]) =>
      cells.map((cell) => ({ ...cell, rowIndex: cell.rowIndex - liveDraftRowCount }));
    const mapping = {
      ...request.mapping,
      cells: rebase(request.mapping.cells),
      writeCells: rebase(request.mapping.writeCells),
      validationCells: rebase(request.mapping.validationCells),
      ignoredCells: rebase(request.mapping.ignoredCells),
    };
    const snapshot = captureClipboardUndoSnapshot({
      mapping,
      currentRowCount: stagedModel.rows.length,
      readCell: (rowIndex, columnKey) => stagedModel.rows[rowIndex]?.cells[columnKey],
    });
    const maxRowIndex = mapping.cells.reduce(
      (maximum, cell) => Math.max(maximum, cell.rowIndex), 0);
    let next = ensureSpreadsheetRowCount(stagedModel, maxRowIndex + 1);
    const patches = new Map<number, Record<string, string>>();
    for (const cell of mapping.writeCells) {
      const bucket = patches.get(cell.rowIndex) ?? {};
      bucket[cell.columnKey] = cell.value;
      patches.set(cell.rowIndex, bucket);
    }
    for (const [rowIndex, patch] of patches) {
      const target = next.rows[rowIndex];
      if (target) next = updateSpreadsheetRowCells(next, target.clientRowId, patch);
    }
    stagedUndo.current = snapshot;
    setStagedCanUndo(true);
    setStagedModel(next);
    setStagedRejection("");
    setStagedNotice(`Đã dán ${request.rowCount} hàng × ${request.columnCount} cột`);
  }, [rows.length, setStagedModel, stagedModel, setStagedMessage, setStagedRejection, setStagedNotice]);

  const onXlsxFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const imported = await workerProfileXlsxToTsv(file);
    if (!imported.ok) {
      setXlsxMessage(imported.code === "XLSX_TOO_LARGE"
        ? "Tệp vượt giới hạn 4 MB."
        : imported.code === "XLSX_ROW_LIMIT"
          ? "Mỗi lần nhập tối đa 100 dòng dữ liệu."
          : imported.code === "XLSX_CELL_UNSUPPORTED"
            ? "Tệp có ô công thức, định dạng hoặc mã định danh không hỗ trợ."
            : "Không đọc được tệp .xlsx. Hãy dùng mẫu Direct Entry.");
      return;
    }
    const parsed = parseWorkerProfilePaste({
      text: imported.text,
      referenceDate: today,
      employeeCodeMode: "server-generated",
    });
    if (parsed.rows.length === 0) {
      setXlsxMessage("Tệp thiếu header hoặc không có dòng dữ liệu hợp lệ.");
      return;
    }
    try {
      setStagedModel((current) => {
        if (selectNonEmptySpreadsheetRows(current).length + parsed.rows.length > 100) {
          throw new RangeError("row limit");
        }
        let next = ensureSpreadsheetRowCount(current, current.rows.length + parsed.rows.length);
        const start = current.rows.length;
        parsed.rows.forEach((row, index) => {
          const target = next.rows[start + index];
          if (!target) return;
          const value = (field: { state: string; value?: string }) =>
            field.state === "provided" ? field.value ?? "" : "";
          const rowCatalog = catalogs[row.first_work_date];
          const recruiter = rowCatalog?.recruiters.find((option) =>
            option.recruiter_id === row.recruiter_label ||
            option.display_name === row.recruiter_label);
          next = updateSpreadsheetRowCells(next, target.clientRowId, {
            project_id: row.project_label,
            first_work_date: row.first_work_date,
            display_name: row.display_name,
            recruiter_id: recruiter?.recruiter_id ?? row.recruiter_label,
            labor_type: row.labor_type === "PERMANENT" ? "Chính thức" : "Thời vụ",
            gender: value(row.worker.gender),
            date_of_birth: value(row.worker.date_of_birth),
            national_id: value(row.worker.national_id),
            national_id_issued_at: value(row.worker.national_id_issued_at),
            national_id_issued_place: value(row.worker.national_id_issued_place),
            address: value(row.worker.address),
            phone: value(row.worker.phone),
            initial_status: value(row.employment.initial_status),
            leave_date: value(row.employment.leave_date),
            leave_reason_text: value(row.employment.leave_reason_text),
            general_note: value(row.general_note),
            account_number: value(row.payment.account_number),
            bank_name: value(row.payment.bank_name),
            account_holder_name: value(row.payment.account_holder_name),
          });
          next = updateSpreadsheetRowProviderType(
            next, target.clientRowId, recruiter?.provider_type ?? "",
          );
        });
        return next;
      });
    } catch {
      setXlsxMessage("Đã đạt giới hạn 100 dòng; chưa nhập tệp.");
      return;
    }
    setStagedCanUndo(false);
    setStagedNotice("");
    setStagedRejection("");
    setXlsxMessage(`Đã nhập ${imported.rowCount} dòng vào bảng. Kiểm tra lỗi trước khi lưu.`);
  }, [catalogs, setStagedModel, today, setStagedMessage, setStagedNotice, setStagedRejection]);

  const downloadXlsxTemplate = useCallback(async () => {
    try {
      const bytes = await createWorkerProfileTemplate();
      const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "direct-entry-template.xlsx";
      anchor.click();
      URL.revokeObjectURL(url);
      setXlsxMessage("Đã tải mẫu .xlsx.");
    } catch {
      setXlsxMessage("Không tạo được mẫu .xlsx trên trình duyệt này.");
    }
  }, []);

  const onStagedUndo = useCallback(() => {
    const snapshot = stagedUndo.current;
    if (snapshot === null) return;
    setStagedModel((current) => ({
      ...current,
      rows: restoreClipboardUndoSnapshot({
        rows: current.rows,
        snapshot,
        writeCell: (cells, rowIndex, columnKey, value) => cells.map((row, index) =>
          index === rowIndex
            ? { ...row, cells: { ...row.cells, [columnKey]: value ?? "" } }
            : row),
      }),
    }));
    stagedUndo.current = null;
    setStagedCanUndo(false);
    setStagedNotice("");
    setStagedRejection("");
  }, [setStagedModel, setStagedCanUndo, setStagedNotice, setStagedRejection]);

  const onStagedDelete = useCallback((clientRowId: string) => {
    setStagedModel((current) => deleteSpreadsheetRow(current, clientRowId));
  }, []);

  const onMobileStagedChange = useCallback((
    clientRowId: string,
    field: string,
    value: string,
  ) => {
    setStagedModel((current) => updateSpreadsheetRowCells(current, clientRowId, {
      [field]: value,
      ...(field === "first_work_date" ? { recruiter_id: "" } : {}),
    }));
    if (field === "first_work_date" && isRealCalendarDate(value)) {
      void ensureCatalog(value).catch(() => undefined);
    }
  }, [ensureCatalog, setStagedModel]);

  // P1.7-H05: capture handler trong bien cuc bo truoc khi render de tranh
  // React Compiler canh bao "Cannot access refs during render" khi closure
  // duoc truyen truc tiep vao onChange cua <select>/<input> trong JSX.
  const handleMobileStagedProjectChange = useCallback(
    (clientRowId: string) => (event: React.ChangeEvent<HTMLSelectElement>) => {
      onMobileStagedChange(clientRowId, "project_id", event.currentTarget.value);
    },
    [onMobileStagedChange],
  );
  const handleMobileStagedFieldChange = useCallback(
    (clientRowId: string, field: string) =>
      (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        onMobileStagedChange(clientRowId, field, event.currentTarget.value);
      },
    [onMobileStagedChange],
  );

  /** Mot request cho ca batch; 409 khong auto-retry; network/5xx giu nguyen intent key. */
  const onStagedSave = useCallback(async () => {
    if (stagedInFlight.current) return;
    const preview = stagedValidation.preview;
    if (preview === null || !stagedValidation.canSave) {
      setStagedMessage("Chưa có dòng hợp lệ để lưu.");
      return;
    }
    const body = buildServerGeneratedFullProfileRequestBody(preview.rows);
    if (body === null) {
      setStagedMessage(fullProfileErrorMessage("BATCH_INVALID"));
      return;
    }
    const digest = await fullProfileIntentDigest(body.rows);
    if (digest === null) {
      setStagedMessage("Không tạo được dấu vết yêu cầu; hãy thử lại.");
      return;
    }
    const intent = "full_profile_batch:" + digest;
    const resolved = resolveIntentKey(stagedIntent.current, intent, () => crypto.randomUUID());
    stagedIntent.current = resolved.state;
    stagedInFlight.current = true;
    setStagedBusy(true);
    setStagedMessage("");
    try {
      const result = await postFullProfileBatch({
        rows: body.rows,
        idempotencyKey: resolved.key,
        fetchImpl: fetch,
      });
      if (result.kind === "saved") {
        stagedIntent.current = clearIntentKey(stagedIntent.current, intent);
        stagedUndo.current = null;
        setStagedCanUndo(false);
        setStagedNotice("");
        setStagedRejection("");
        // P1.7-H06: server cam tra entryIds theo dung thu tu rows gui len; tao
        // anh xa clientRowId (staged) -> entry_id server-returned de giu
        // selection cho persisted row tuong ung (việc mapping xem row index
        // hay tên đều bị hủy bỏ; chi dung entry_id server-issued).
        const savedClientRowIds = stagedValidation.rows.map((row) => row.clientRowId);
        const savedEntryIds = result.entryIds;
        const stagedToEntry = new Map<string, string>();
        for (let index = 0; index < savedClientRowIds.length; index += 1) {
          const cid = savedClientRowIds[index];
          const eid = savedEntryIds[index];
          if (cid !== undefined && eid !== undefined) stagedToEntry.set(cid, eid);
        }
        // Chi clear staged rows sau khi server xac nhan bang projection hop le.
        setStagedModel(createSpreadsheetRowModel());
        setStagedMessage("Đã lưu " + result.entryIds.length + " dòng bằng một yêu cầu atomic duy nhất.");
        await reloadDrafts();
        // Map lai selection: chi giu persisted row co entry_id trung khop;
        // KHONG doan theo row index/ho ten/CCCD.
        if (selectedClientRowId !== null) {
          const expectedEntryId = stagedToEntry.get(selectedClientRowId);
          if (expectedEntryId !== undefined) {
            setSelectionAfterSaveEntryId(expectedEntryId);
            setSavedCtaClientRowId(null);
          } else {
            setSelectedClientRowId(null);
            setSavedCtaClientRowId(null);
          }
        }
        return;
      }
      if (result.kind === "retry") {
        setStagedMessage(fullProfileErrorMessage(result.code));
        return;
      }
      stagedIntent.current = clearIntentKey(stagedIntent.current, intent);
      setStagedMessage(fullProfileErrorMessage(result.code));
    } finally {
      stagedInFlight.current = false;
      setStagedBusy(false);
    }
  }, [reloadDrafts, selectedClientRowId, setStagedModel, stagedValidation]);

  /**
   * P1.7-H05-R1: nut "Lưu NLĐ" trong quick editor chi validate va gui DUNG ROW
   * dang mo (quickEditClientRowId). Khong gui bat ky staged row nao khac.
   * Idempotency digest/key duoc tinh tren selection thuc su gui di; cac row
   * staged con lai giu nguyen cho den khi user luu rieng.
   * - Thanh cong: chi remove row vua luu (con lai giu nguyen), reload persisted
   *   drafts va dong quick editor.
   * - Loi/retry/OCC: giu row va du lieu, khong dong editor, giu dung
   *   retry/idempotency semantics.
   * - Khong ghi nhan thanh cong truoc khi server xac nhan; khong tao endpoint moi.
   */
  const onQuickSaveRow = useCallback(async (clientRowId: string) => {
    if (stagedInFlight.current) return;
    const target = stagedModel.rows.find((row) => row.clientRowId === clientRowId);
    if (!target) {
      setStagedMessage("Dòng đã đóng hoặc không còn tồn tại.");
      return;
    }
    // Loc preview chi giu row dang mo, giu nguyen preview validation logic cua H05.
    const fullPreview = stagedValidation.preview;
    if (fullPreview === null) {
      setStagedMessage("Chưa có dòng hợp lệ để lưu.");
      return;
    }
    // P1.7-H05-R1: mapping clientRowId -> preview row thong qua validation.rows
    // (validation.rows co cung thu tu voi preview.rows nen tao anh xa 1:1).
    const matchingPreviewIndex = stagedValidation.rows.findIndex((row) =>
      row.clientRowId === clientRowId);
    const matchingPreview = matchingPreviewIndex >= 0
      ? fullPreview.rows[matchingPreviewIndex]
      : undefined;
    if (!matchingPreview) {
      setStagedMessage("Dòng đang mở chưa hợp lệ; hãy kiểm tra lại dữ liệu.");
      return;
    }
    const body = buildServerGeneratedFullProfileRequestBody([matchingPreview]);
    if (body === null) {
      setStagedMessage(fullProfileErrorMessage("BATCH_INVALID"));
      return;
    }
    const digest = await fullProfileIntentDigest(body.rows);
    if (digest === null) {
      setStagedMessage("Không tạo được dấu vết yêu cầu; hãy thử lại.");
      return;
    }
    const intent = "quick_full_profile_row:" + clientRowId + ":" + digest;
    const resolved = resolveIntentKey(stagedIntent.current, intent, () => crypto.randomUUID());
    stagedIntent.current = resolved.state;
    stagedInFlight.current = true;
    setStagedBusy(true);
    setStagedMessage("");
    try {
      const result = await postFullProfileBatch({
        rows: body.rows,
        idempotencyKey: resolved.key,
        fetchImpl: fetch,
      });
      if (result.kind === "saved") {
        stagedIntent.current = clearIntentKey(stagedIntent.current, intent);
        // Chi remove row vua luu (goc clientRowId), giu nguyen cac staged row khac.
        setStagedModel((current) => deleteSpreadsheetRow(current, clientRowId));
        setQuickEditClientRowId(null);
        // P1.7-H06: chi giu selection neu server tra entry_id trung khop; neu khong
        // xac dinh duoc, clear selection an toan (khong doan theo row/ten).
        const savedEntryId = result.entryIds[0];
        if (typeof savedEntryId === "string") {
          setSelectionAfterSaveEntryId(savedEntryId);
          // Saved CTA se hien thi khi effect resolver set selection.
        } else {
          setSelectedClientRowId(null);
          setSavedCtaClientRowId(null);
        }
        await reloadDrafts();
        setStagedMessage("Đã lưu NLĐ bằng một yêu cầu atomic. Các dòng còn lại trong bảng giữ nguyên.");
        return;
      }
      if (result.kind === "retry") {
        setStagedMessage(fullProfileErrorMessage(result.code));
        return;
      }
      stagedIntent.current = clearIntentKey(stagedIntent.current, intent);
      setStagedMessage(fullProfileErrorMessage(result.code));
    } finally {
      stagedInFlight.current = false;
      setStagedBusy(false);
    }
  }, [reloadDrafts, setStagedModel, stagedModel, stagedValidation, setQuickEditClientRowId]);

  const updateDate = useCallback((rowId: string, firstWorkDate: string) => {
    updateRow(rowId, { firstWorkDate, recruiterId: "" });
    if (isRealCalendarDate(firstWorkDate)) void ensureCatalog(firstWorkDate).catch(() => {});
  }, [ensureCatalog, updateRow]);

  const selectedRowLocked = selectedRow !== null && !isRowEditable(selectedRow, submissions);
  const currentOptions = selectedRow ? optionsFor(catalogFor(selectedRow.firstWorkDate)) : [];
  const currentRecruiter = selectedRow
    ? catalogFor(selectedRow.firstWorkDate)?.recruiters.find(
      ({ recruiter_id }) => recruiter_id === selectedRow.recruiterId,
    )
    : undefined;
  const catalogMissing = Object.values(catalogs).some(({ projects, recruiters }) =>
    projects.length === 0 || recruiters.length === 0,
  );

  return (
    <main className={styles.page}>
      <p className={styles.serverStatus} role="status">
        Dữ liệu chỉ được lưu sau khi máy chủ xác nhận.
      </p>
      <header className={styles.header}>
        <div>
          <h1>Nhập liệu trực tiếp</h1>
          <p>{rows.length} dòng</p>
        </div>
        <div className={styles.liveHeaderActions}>
          <input
            ref={xlsxInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => void onXlsxFile(event)}
            hidden
            aria-label="Chọn tệp workbook .xlsx"
          />
          <button type="button" className={styles.secondaryButton}
            onClick={() => void downloadXlsxTemplate()}>
            Tải file Excel mẫu
          </button>
          <button type="button" className={styles.secondaryButton}
            onClick={() => xlsxInputRef.current?.click()}>
            Nhập file Excel
          </button>
          <button type="button" className={styles.secondaryButton}
            data-testid="add-rows-batch"
            onClick={addStagedRows}
            disabled={loadState !== "ready" || !canAddStagedRows(stagedModel)}>
            Thêm dòng
          </button>
          <button type="button" className={styles.secondaryButton}
            data-testid="quick-add-row"
            onClick={addQuickStagedRow}
            disabled={loadState !== "ready"}>
            Thêm nhanh NLĐ
          </button>
          <button type="button" className={styles.primaryButton}
            data-testid="spreadsheet-save" onClick={() => void onStagedSave()}
            disabled={loadState !== "ready" || !stagedValidation.canSave || stagedBusy}
            aria-busy={stagedBusy}>
            Lưu các dòng hợp lệ
          </button>
        </div>
      </header>

      {lifecycleMessage !== "" && (
        <p className={styles.lifecycleStatus} role="status" tabIndex={-1} ref={lifecycleStatusRef}>
          {lifecycleMessage}
        </p>
      )}

      <div className={styles.notice} role={loadState === "error" ? "alert" : "status"}
        aria-live="polite">
        {loadState === "loading" && "Đang tải quyền, danh mục và bản nháp…"}
        {loadState === "error" && `Không tải được Direct Entry (${loadMessage}). Không dùng dữ liệu mẫu khi chế độ máy chủ đang bật.`}
        {loadState === "ready" && catalogMissing &&
          "Danh mục dự án hoặc người tuyển chưa được cấu hình; thao tác lưu đang bị khóa."}
        {Object.entries(catalogErrors).map(([date, message]) =>
          <span key={date}>Danh mục ngày {date} không khả dụng ({message}).</span>,
        )}
      </div>

      {loadState === "ready" && (
        <>
          <section className={styles.gridSection} aria-label="Bảng nhập liệu Direct Entry">
            {(() => {
              /**
               * P1.7-H06: contextual action bar (desktop) hien thi dong dang chon
               * hoac nhac chon. Khong render desktop bar tren mobile (do
               * gridSection bi an o breakpoint mobile va phan mobile co card rieng).
               */
              const selected = selectedSpreadsheetRow;
              const selectedIsStaged = selected !== null && !selected.persisted;
              const selectedIsPersisted = !!selected?.persisted;
              const selectedHasEntryId = selectedIsPersisted
                && rows.some((row) => row.rowId === selected.clientRowId &&
                  row.entryId !== null);
              const canViewDocs = capabilities.includes("document_view");
              const canEditDocs = selectedHasEntryId
                && capabilities.includes("entry_own")
                && capabilities.includes("document_upload");
              const canOpenReadOnly = selectedHasEntryId && canViewDocs && !canEditDocs;
              const ctaFor = savedCtaClientRowId !== null
                && selected !== null
                && selected.clientRowId === savedCtaClientRowId;
              return (
                <>
                <div className={styles.contextualActionBar}
                  data-testid="contextual-action-bar"
                  data-selection-state={selected === null
                    ? "none"
                    : selectedIsPersisted
                      ? "persisted"
                      : "staged"}>
                  <p className={styles.contextualActionLabel}
                    data-testid="contextual-action-label">
                    {selected === null
                      ? <span className={styles.contextualActionLabelMuted}>
                          Chọn một dòng để thao tác
                        </span>
                      : <>Đang chọn: <strong>{
                            selected.displayName !== ""
                              ? selected.displayName
                              : "Dòng " + (spreadsheetRows.findIndex((row) =>
                                  row.clientRowId === selected.clientRowId) + 1)
                          }</strong>{selectedIsPersisted && selected.employeeCode !== ""
                              ? ` >  Mã NLĐ ${selected.employeeCode}`
                              : ""}</>}
                  </p>
                  <div className={styles.contextualActionGroup}>
                    <button type="button"
                      data-testid="contextual-documents"
                      className={styles.contextualActionButton}
                      aria-label="Hồ sơ NLĐ"
                      disabled={selected === null
                        || selectedIsStaged
                        || !selectedHasEntryId
                        || (!canEditDocs && !canOpenReadOnly)}
                      title={selected === null
                        ? "Chọn một dòng đã lưu trước"
                        : selectedIsStaged
                          ? "Lưu NLĐ trước khi tải hồ sơ"
                          : !selectedHasEntryId
                            ? "Dòng chưa có mã nhập do máy chủ cấp"
                            : !canViewDocs
                              ? "Bạn không có quyền xem hồ sơ"
                              : undefined}
                      onClick={() => {
                        if (selected === null) return;
                        if (!selectedHasEntryId) return;
                        const persisted = rows.find((entry) =>
                          entry.rowId === selected.clientRowId);
                        if (persisted) setDocumentsRowId(persisted.rowId);
                      }}>
                      Hồ sơ NLĐ
                    </button>
                    <button type="button"
                      data-testid="contextual-delete"
                      className={`${styles.contextualActionButton} ${styles.contextualActionButtonDanger}`}
                      aria-label="Xóa dòng"
                      disabled={selected === null || !selectedIsStaged}
                      title={selected === null
                        ? "Chọn một dòng đang nhập trước"
                        : !selectedIsStaged
                          ? "Chỉ xóa được bản nháp đang nhập"
                          : undefined}
                      onClick={() => {
                        if (selected === null) return;
                        if (!selectedIsStaged) return;
                        onStagedDelete(selected.clientRowId);
                      }}>
                      Xóa dòng
                    </button>
                  </div>
                </div>
                {ctaFor && (
                  <p className={styles.lifecycleStatus} role="status"
                    data-testid="saved-cta">
                    Đã lưu — chọn Hồ sơ NLĐ để tải tài liệu
                  </p>
                )}
                </>
              );
            })()}
            {stagedRejection !== "" && (
              <p role="alert" data-testid="spreadsheet-paste-rejected">{stagedRejection}</p>
            )}
            {stagedValidation.firstError !== null && (
              <button type="button" data-testid="spreadsheet-first-error"
                onClick={() => {
                  const index = stagedValidation.rowOrder.indexOf(
                    stagedValidation.firstError?.clientRowId ?? "");
                  setStagedMessage(
                    "Lỗi đầu tiên ở dòng dữ liệu " + (index + 1) + ", cột " +
                    (stagedValidation.firstError?.columnKey ?? "") + ".");
                }}>
                Đi tới lỗi đầu tiên
              </button>
            )}
            <DirectEntrySpreadsheetGrid
              rows={spreadsheetRows}
              validation={stagedValidation}
              catalogOptions={stagedCatalogOptions}
              onCellsChange={onSpreadsheetCellsChange}
              onProviderTypeChange={onStagedProviderTypeChange}
              onPasteApplied={onStagedPaste}
              onPasteRejected={onStagedPasteRejected}
              onDeleteRow={onStagedDelete}
              notice={stagedNotice}
              canUndo={stagedCanUndo}
              onUndo={onStagedUndo}
              saveMessage={stagedMessage}
              selectedClientRowId={selectedClientRowId}
              onSelectedClientRowChange={setSelectedClientRowId}
            />
          </section>
          {xlsxMessage !== "" && <p className={styles.lifecycleStatus} role="status">{xlsxMessage}</p>}

          <details className={styles.secondaryPanel}>
            <summary>Đợt nhập liệu ({submissions.length})</summary>
            <DirectEntrySubmissionList
              state={submissionListState}
              message={submissionListMessage}
              submissions={submissions}
              hasMore={submissionHasMore}
              busySubmissionId={busySubmissionId}
              blockedSubmissionIds={blockedSubmissionIds}
              onLoadMore={() => void loadSubmissions("append")}
              onTransition={(input) => void runTransition(input)}
              onRequestChange={(submission) => setProposerSubmission(submission)}
              onManageDocuments={(submission) => setManageDocumentsSubmission(submission)}
            />
          </details>
          <details className={styles.secondaryPanel}>
            <summary>Yêu cầu thay đổi ({changeRequests.length})</summary>
            {changeRequestNotice !== "" && <p role="alert">{changeRequestNotice}</p>}
            <DirectEntryChangeRequestList
              state={changeRequestListState}
              message={changeRequestListMessage}
              requests={changeRequests}
              hasMore={changeRequestHasMore}
              busyRequestId={busyChangeRequestId}
              onLoadMore={() => void loadChangeRequests("append")}
              onWithdraw={(request) => void withdrawChangeRequest(request)}
              onReview={(request) => setReviewRequest(request)}
            />
          </details>
          <DirectEntrySubmittedDocumentManager
            submission={manageDocumentsSubmission}
            onOpenChange={(next) => { if (!next) setManageDocumentsSubmission(null); }}
            canUpload={capabilities.includes("document_upload")}
            canView={capabilities.includes("document_view")}
          />
          <DirectEntryChangeRequestReviewer
            request={reviewRequest}
            onOpenChange={(next) => { if (!next) setReviewRequest(null); }}
            catalogFor={catalogFor}
            ensureCatalog={ensureCatalog}
            onDecided={(message) => { void reloadAfterChangeRequestMutation(message); }}
            onConflict={(message) => { void reloadAfterChangeRequestMutation(message); }}
          />
          <DirectEntryChangeRequestProposer
            open={proposerSubmission !== null}
            onOpenChange={(next) => { if (!next) setProposerSubmission(null); }}
            submission={proposerSubmission}
            catalogFor={catalogFor}
            ensureCatalog={ensureCatalog}
            onCreated={(created) => {
              void reloadAfterChangeRequestMutation(
                "Đã tạo yêu cầu thay đổi " + shortRef(created.request_id) + " cho " +
                  created.items + " dòng.",
              );
            }}
            onConflict={() => {
              void reloadAfterChangeRequestMutation(changeRequestErrorMessage(409));
            }}
            onUnauthorized={() => {
              void reloadAfterChangeRequestMutation(changeRequestErrorMessage(401));
            }}
          />
          <section className={styles.mobileSection} aria-label="Danh sách bản nháp">
            {rows.length === 0 && <p>Chưa có bản nháp. Chọn “Thêm dòng” để bắt đầu.</p>}
            <ul className={styles.mobileList}>
              {rows.map((row) => (
                <li key={row.rowId}>
                  <button
                    type="button"
                    className={`${styles.rowCard} ${row.state !== "clean" ? styles.rowCardDirty : ""}`}
                    onClick={() => setSelectedRowId(row.rowId)}
                    aria-label={`Chỉnh sửa ${row.employeeCode || "dòng mới"} — ${stateText(row.state)}`}
                  >
                    <span className={styles.rowCardTop}>
                      <strong>{row.employeeCode || "Dòng mới"}</strong>
                      <span className={styles.dirtyBadge}>{stateText(row.state)}</span>
                    </span>
                    <span>{row.workerName || "Chưa nhập họ tên"}</span>
                    <span className={styles.rowCardMeta}>
                      {displayProject(row, catalogFor(row.firstWorkDate)) || "Chưa chọn dự án"}
                      {" · "}Hồ sơ CCCD: {readCccdStatus(cccdCache, row.entryId, row.entryVersion).label}
                    </span>
                  </button>
                  {row.entryId !== null && (
                    <div className={styles.mobileStagedFooter}>
                      <button type="button"
                        className={styles.contextualActionButton}
                        data-testid={`mobile-open-documents-${row.rowId}`}
                        aria-label="Hồ sơ"
                        disabled={!capabilities.includes("document_view")}
                        onClick={() => setDocumentsRowId(row.rowId)}>
                        Hồ sơ
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <h2>Bản ghi đang nhập</h2>
            {stagedValidation.rows.length === 0 && <p>Chưa có dòng đang nhập.</p>}
            <ul className={styles.mobileStagedList}>
              {stagedValidation.rows.map((validationRow) => {
                const stagedRow = stagedModel.rows.find(
                  (candidate) => candidate.clientRowId === validationRow.clientRowId,
                );
                if (!stagedRow) return null;
                const cells = stagedRow.cells;
                const catalog = catalogs[cells.first_work_date ?? ""];
                return (
                  <li key={stagedRow.clientRowId}>
                    <details className={styles.mobileStagedCard}>
                      <summary>
                        {cells.display_name || "Dòng chưa có tên"}
                        {" · "}{validationRow.errorCount} lỗi
                      </summary>
                      <div className={styles.drawerFields}>
                        <Field label="Mã NLĐ">
                          <output>Máy chủ sẽ cấp mã khi lưu</output>
                        </Field>
                        <Field label={<><span>Ngày bắt đầu làm việc</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                          <input type="date" value={cells.first_work_date ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "first_work_date")} />
                        </Field>
                        <Field label={<><span>Dự án</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                          <select value={cells.project_id ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "project_id")}>
                            <option value="">Chọn dự án</option>
                            {(catalog?.projects ?? []).map((project) =>
                              <option key={project.project_id} value={project.project_id}>
                                {project.display_name}
                              </option>)}
                          </select>
                        </Field>
                        <Field label={<><span>Họ và tên</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                          <input value={cells.display_name ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "display_name")} />
                        </Field>
                        <Field label="Giới tính">
                          <select value={cells.gender ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "gender")}>
                            <option value="">—</option>
                            <option value="Nam">Nam</option>
                            <option value="Nữ">Nữ</option>
                          </select>
                        </Field>
                        <Field label="DOB">
                          <input type="date" value={cells.date_of_birth ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "date_of_birth")} />
                        </Field>
                        <Field label="CMT/CCCD">
                          <input value={cells.national_id ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "national_id")} />
                        </Field>
                        <Field label="Ngày cấp">
                          <input type="date" value={cells.national_id_issued_at ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "national_id_issued_at")} />
                        </Field>
                        <Field label="Nơi cấp">
                          <input value={cells.national_id_issued_place ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "national_id_issued_place")} />
                        </Field>
                        <Field label="Địa chỉ">
                          <input value={cells.address ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "address")} />
                        </Field>
                        <Field label="Số điện thoại">
                          <input value={cells.phone ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "phone")} />
                        </Field>
                        <Field label={<><span>HRP/Vendor</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                          <select value={stagedRow.providerType}
                            onChange={(event) => {
                              const next = event.currentTarget.value;
                              const providerType = next === "hrp" || next === "vendor" ? next : "";
                              onStagedProviderTypeChange(stagedRow.clientRowId, providerType);
                            }}>
                            <option value="hrp">HRP</option>
                            <option value="vendor">Vendor</option>
                          </select>
                        </Field>
                        <Field label={<><span>Người tuyển / Vendor</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                          <select value={cells.recruiter_id ?? ""}
                            disabled={stagedRow.providerType === ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "recruiter_id")}>
                            <option value="">—</option>
                            {(catalog?.recruiters ?? []).filter((recruiter) =>
                              stagedRow.providerType === "" || recruiter.provider_type === stagedRow.providerType)
                              .map((recruiter) => <option key={recruiter.recruiter_id}
                                value={recruiter.recruiter_id}>{recruiter.display_name}</option>)}
                          </select>
                        </Field>
                        <Field label={<><span>Loại hình LĐ</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                          <select value={cells.labor_type ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "labor_type")}>
                            <option value="">—</option>
                            <option value="Thời vụ">Thời vụ</option>
                            <option value="Chính thức">Chính thức</option>
                          </select>
                        </Field>
                        <Field label="STK">
                          <input value={cells.account_number ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "account_number")} />
                        </Field>
                        <Field label="Tên ngân hàng">
                          <input value={cells.bank_name ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "bank_name")} />
                        </Field>
                        <Field label="Tên chủ tài khoản">
                          <input value={cells.account_holder_name ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "account_holder_name")} />
                        </Field>
                        <Field label="Ghi chú">
                          <input value={cells.general_note ?? ""}
                            onChange={handleMobileStagedFieldChange(stagedRow.clientRowId, "general_note")} />
                        </Field>
                      </div>
                      <div className={styles.mobileStagedFooter}>
                        <button type="button" className={styles.contextualActionButton}
                          aria-label="Mở sửa nhanh"
                          onClick={() => openQuickEditor(stagedRow.clientRowId)}>
                          Sửa nhanh
                        </button>
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}

      <DirectEntryWorkerDocuments
        key={documentsRow?.entryId ?? "no-documents-row"}
        row={documentsRow}
        onOpenChange={(open) => { if (!open) setDocumentsRowId(null); }}
        canEditDocuments={documentsRow !== null && capabilities.includes("entry_own") &&
          capabilities.includes("document_upload") && isRowEditable(documentsRow, submissions)}
        canViewDocuments={capabilities.includes("document_view")}
        onCccdStatus={setCccdStatus}
        onEntryVersionChange={onPaymentEntryVersionChange}
      />

      {/* P1.7-H06: legacy CCCD manager van duoc goi qua DirectEntryWorkerDocuments
          (CCCD_FRONT/BACK) de giu nguyen transport/upload/OCC/idempotency
          hien huu. The CCCD manager nguyen ban khong con render rieng tren
          desktop; cac nut "Hồ sơ" da chuyen sang documents dialog. */}

      <Dialog.Root open={quickEditClientRowId !== null}
        onOpenChange={(open) => { if (!open) setQuickEditClientRowId(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.drawerOverlay} />
          {quickEditClientRowId !== null && (() => {
            const target = stagedModel.rows.find(
              (candidate) => candidate.clientRowId === quickEditClientRowId);
            if (!target) return null;
            const rowCatalog = catalogs[target.cells.first_work_date ?? ""];
            const isLoadingCatalog = target.cells.first_work_date !== undefined &&
              target.cells.first_work_date !== "" && !rowCatalog;
            const hasCatalogError = target.cells.first_work_date !== undefined &&
              target.cells.first_work_date !== "" && !!catalogErrors[target.cells.first_work_date];
            return (
              <Dialog.Content className={styles.quickDrawer}
                aria-describedby="quick-edit-description"
                data-testid="quick-edit-drawer">
                <div className={styles.quickDrawerHeader}>
                  <Dialog.Title className={styles.quickDrawerTitle}>Thêm nhanh NLĐ</Dialog.Title>
                  <Dialog.Close asChild>
                    <button type="button" className={styles.secondaryButton}>Đóng</button>
                  </Dialog.Close>
                </div>
                <Dialog.Description id="quick-edit-description" className={styles.drawerDescription}>
                  Nhập nhanh một người lao động; dữ liệu sẽ đồng bộ ngay vào đúng dòng trong bảng.
                  Lưu trước để tải hồ sơ.
                </Dialog.Description>
                <div className={styles.quickDrawerFields}>
                  <Field label={<><span>Dự án</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                    {target.cells.first_work_date === undefined || target.cells.first_work_date === ""
                      ? <p className={styles.derivedValue}>Nhập ngày bắt đầu trước</p>
                      : isLoadingCatalog
                        ? <p className={styles.derivedValue}>Đang tải danh mục…</p>
                        : hasCatalogError
                          ? <p className={styles.derivedValue} role="alert">Danh mục chưa khả dụng</p>
                          : (rowCatalog?.projects.length ?? 0) === 0
                            ? <p className={styles.derivedValue}>Chưa có dự án khả dụng</p>
                            : <select aria-label="Dự án" value={target.cells.project_id ?? ""}
                              onChange={handleMobileStagedProjectChange(target.clientRowId)}>
                              <option value="">Chọn dự án</option>
                              {rowCatalog?.projects.map((project) =>
                                <option key={project.project_id} value={project.project_id}>
                                  {project.display_name}
                                </option>)}
                            </select>}
                  </Field>
                  <Field label={<><span>Ngày bắt đầu làm việc</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                    <input type="date" value={target.cells.first_work_date ?? ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "first_work_date")} />
                  </Field>
                  <Field label={<><span>Họ và tên</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                    <input value={target.cells.display_name ?? ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "display_name")} />
                  </Field>
                  <Field label="Giới tính">
                    <select value={target.cells.gender ?? ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "gender")}>
                      <option value="">—</option>
                      <option value="Nam">Nam</option>
                      <option value="Nữ">Nữ</option>
                    </select>
                  </Field>
                  <Field label="DOB">
                    <input type="date" value={target.cells.date_of_birth ?? ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "date_of_birth")} />
                  </Field>
                  <Field label="CMT/CCCD">
                    <input value={target.cells.national_id ?? ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "national_id")} />
                  </Field>
                  <Field label="Ngày cấp">
                    <input type="date" value={target.cells.national_id_issued_at ?? ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "national_id_issued_at")} />
                  </Field>
                  <Field label="Nơi cấp">
                    <input value={target.cells.national_id_issued_place ?? ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "national_id_issued_place")} />
                  </Field>
                  <Field label="Địa chỉ">
                    <input value={target.cells.address ?? ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "address")} />
                  </Field>
                  <Field label="Số điện thoại">
                    <input value={target.cells.phone ?? ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "phone")} />
                  </Field>
                  <Field label={<><span>HRP/Vendor</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                    <select value={target.providerType}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        const providerType = next === "hrp" || next === "vendor" ? next : "";
                        onStagedProviderTypeChange(target.clientRowId, providerType);
                      }}>
                      <option value="hrp">HRP</option>
                      <option value="vendor">Vendor</option>
                    </select>
                  </Field>
                  <Field label={<><span>Người tuyển / Vendor</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                    <select value={target.cells.recruiter_id ?? ""}
                      disabled={target.providerType === ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "recruiter_id")}>
                      <option value="">—</option>
                      {(rowCatalog?.recruiters ?? [])
                        .filter((recruiter) => target.providerType === "" ||
                          recruiter.provider_type === target.providerType)
                        .map((recruiter) => <option key={recruiter.recruiter_id}
                          value={recruiter.recruiter_id}>{recruiter.display_name}</option>)}
                    </select>
                  </Field>
                  <Field label={<><span>Loại hình LĐ</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                    <select value={target.cells.labor_type ?? ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "labor_type")}>
                      <option value="">—</option>
                      <option value="Thời vụ">Thời vụ</option>
                      <option value="Chính thức">Chính thức</option>
                    </select>
                  </Field>
                  <Field label="STK">
                    <input value={target.cells.account_number ?? ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "account_number")} />
                  </Field>
                  <Field label="Tên ngân hàng">
                    <input value={target.cells.bank_name ?? ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "bank_name")} />
                  </Field>
                  <Field label="Tên chủ tài khoản">
                    <input value={target.cells.account_holder_name ?? ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "account_holder_name")} />
                  </Field>
                  <Field label="Ghi chú">
                    <input value={target.cells.general_note ?? ""}
                      onChange={handleMobileStagedFieldChange(target.clientRowId, "general_note")} />
                  </Field>
                </div>
                <div className={styles.quickDrawerActions}>
                  <button type="button" className={styles.primaryButton}
                    data-testid="quick-save-row"
                    onClick={() => void onQuickSaveRow(target.clientRowId)}>
                    Lưu NLĐ
                  </button>
                  <button type="button" className={styles.secondaryButton}
                    onClick={() => setQuickEditClientRowId(null)}>
                    Đóng
                  </button>
                  <button type="button" className={styles.contextualActionButtonDanger}
                    data-testid="quick-delete-row"
                    onClick={() => {
                      onStagedDelete(target.clientRowId);
                      setQuickEditClientRowId(null);
                    }}>
                    Xóa dòng
                  </button>
                </div>
              </Dialog.Content>
            );
          })()}
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={selectedRow !== null} onOpenChange={(open) => {
        if (!open) setSelectedRowId(null);
      }}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.drawerOverlay} />
          {selectedRow && (
            <Dialog.Content className={styles.drawer} aria-describedby="direct-entry-live-description">
              <Dialog.Title className={styles.drawerTitle}>Sửa bản nháp</Dialog.Title>
              <Dialog.Description id="direct-entry-live-description" className={styles.drawerDescription}>
                Trạng thái: {stateText(selectedRow.state)}. Người tuyển, provider và team được xác định theo ngày làm.
              </Dialog.Description>
              {selectedRowLocked && (
                <p className={styles.drawerLockNotice} role="status">
                  Đợt này không ở bản nháp nên chỉ xem được. Thay đổi sau khi gửi duyệt hoặc gửi chính thức
                  phải đi qua yêu cầu thay đổi.
                </p>
              )}
              <div className={styles.drawerFields}>
                <Field label="Mã người lao động">
                  {/* P1.7-H05-R1: Mã NLĐ do server cấp (migration #39).
                      Khong cho nhap hoac sua; chi hien thi ma da cap bang <output>. */}
                  <output aria-label="Mã người lao động"
                    data-testid="persisted-employee-code">
                    {selectedRow.employeeCode || "Máy chủ sẽ cấp mã khi lưu"}
                  </output>
                </Field>
                <Field label={<><span>Ngày đầu tiên đi làm</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                  <input aria-label="Ngày đầu tiên đi làm" type="date" value={selectedRow.firstWorkDate}
                    disabled={selectedRow.state === "saving" || selectedRow.state === "conflict" || selectedRowLocked}
                    onChange={(event) => updateDate(selectedRow.rowId, event.target.value)} />
                </Field>
                <Field label={<><span>Họ tên người lao động</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                  <input aria-label="Họ tên người lao động" value={selectedRow.workerName}
                    disabled={selectedRow.state === "saving" || selectedRow.state === "conflict" || selectedRowLocked}
                    onChange={(event) => updateRow(selectedRow.rowId, { workerName: event.target.value })} />
                </Field>
                <Field label={<><span>Dự án</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                  <select aria-label="Dự án" value={selectedRow.projectId}
                    disabled={selectedRow.state === "saving" || selectedRow.state === "conflict" ||
                      selectedRowLocked || !catalogFor(selectedRow.firstWorkDate)}
                    onChange={(event) => updateRow(selectedRow.rowId, { projectId: event.target.value })}>
                    <option value="">Chọn dự án</option>
                    {catalogFor(selectedRow.firstWorkDate)?.projects.map((project) =>
                      <option key={project.project_id} value={project.project_id}>{project.display_name}</option>,
                    )}
                  </select>
                </Field>
                <div className={styles.field}>
                  <RecruiterTypeahead
                    id={`live-mobile-recruiter-${selectedRow.rowId}`}
                    options={currentOptions}
                    value={selectedRow.recruiterId}
                    disabled={selectedRow.state === "saving" || selectedRow.state === "conflict" || selectedRowLocked}
                    onChange={(recruiterId) => updateRow(selectedRow.rowId, { recruiterId })}
                  />
                </div>
                <p className={styles.derivedValue}>
                  HRP/Vendor: <strong>{currentRecruiter?.provider_type.toUpperCase() ?? "Chưa chọn"}</strong>
                  {" · "}Team: <strong>{currentRecruiter?.team_display_name ?? "—"}</strong>
                </p>
                <Field label={<><span>Loại hình lao động</span><span className={styles.requiredStar} aria-hidden="true"> *</span></>}>
                  <select aria-label="Loại hình lao động" value={selectedRow.laborType}
                    disabled={selectedRow.state === "saving" || selectedRow.state === "conflict" || selectedRowLocked}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      if (value === "TEMPORARY" || value === "PERMANENT") {
                        updateRow(selectedRow.rowId, { laborType: value });
                      }
                    }}>
                    <option value="TEMPORARY">Thời vụ</option>
                    <option value="PERMANENT">Chính thức</option>
                  </select>
                </Field>
                <DirectEntryPaymentEditor
                  key={`${selectedRow.rowId}:${selectedRow.entryId ?? "new"}`}
                  entryId={selectedRow.entryId}
                  entryVersion={selectedRow.entryVersion}
                  rowId={selectedRow.rowId}
                  banks={catalogFor(selectedRow.firstWorkDate)?.banks ?? []}
                  canEdit={capabilities.includes("entry_own") &&
                    selectedRow.state !== "saving" && selectedRow.state !== "conflict" &&
                    !selectedRowLocked}
                  canView={capabilities.includes("payment_view")}
                  onEntryVersionChange={onPaymentEntryVersionChange}
                />
                <DirectEntryDocumentEditor
                  key={`documents-${selectedRow.rowId}:${selectedRow.entryId ?? "new"}`}
                  entryId={selectedRow.entryId}
                  entryVersion={selectedRow.entryVersion}
                  rowId={selectedRow.rowId}
                  canEdit={capabilities.includes("entry_own") &&
                    capabilities.includes("document_upload") &&
                    selectedRow.state !== "saving" && selectedRow.state !== "conflict" &&
                    !selectedRowLocked}
                  canView={capabilities.includes("document_view")}
                  onEntryVersionChange={onPaymentEntryVersionChange}
                />
                {selectedRow.message && <p role="alert">{selectedRow.message}</p>}
                {selectedRow.state === "conflict" && (
                  <div className={styles.conflictBox} role="alert">
                    {selectedRow.conflictCopy
                      ? <>
                        <strong>Có phiên bản mới trên máy chủ.</strong>
                        <span>Phiên bản đang sửa: {selectedRow.entryVersion}; máy chủ: {selectedRow.conflictCopy.version}.</span>
                        <span>Khác biệt: {changedDraftFields(
                          editableFields(selectedRow),
                          selectedRow.conflictCopy.fields,
                        ).join(", ") || "Các trường đã được máy chủ thay đổi"}.</span>
                        <button type="button" className={styles.secondaryButton}
                          onClick={() => loadLatest(selectedRow.rowId)}>Tải bản mới từ máy chủ</button>
                        <button type="button" className={styles.secondaryButton}
                          onClick={() => keepLocal(selectedRow.rowId)}>Tiếp tục giữ bản đang sửa</button>
                      </>
                      : <span>Không thể tải bản mới để đối chiếu. Bản đang sửa vẫn được giữ.</span>}
                    {!selectedRow.conflictCopy && (
                      <button type="button" className={styles.secondaryButton}
                        onClick={() => void retryConflictLoad(selectedRow.rowId)}>
                        Thử tải bản mới
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className={styles.drawerActions}>
                <Dialog.Close asChild>
                  <button type="button" className={styles.secondaryButton}>Quay lại danh sách</button>
                </Dialog.Close>
                <button type="button" className={styles.primaryButton}
                  onClick={() => void saveRow(selectedRow.rowId)}
                  disabled={selectedRow.state === "saving" || selectedRow.state === "conflict" ||
                    selectedRow.state === "clean" || selectedRow.state === "saved"}>
                  {selectedRow.state === "saving" ? "Đang lưu…" : "Lưu nháp"}
                </button>
              </div>
            </Dialog.Content>
          )}
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
