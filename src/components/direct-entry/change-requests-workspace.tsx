"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  DirectEntryChangeRequestList,
  type ResolvedAgeFilter,
} from "@/components/direct-entry/direct-entry-change-request-list";
import { DirectEntryChangeRequestReviewer } from "@/components/direct-entry/direct-entry-change-request-reviewer";
import { StatusBadge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { CursorLoadMore } from "@/components/ui/cursor-load-more";
import { PageHeader } from "@/components/ui/page-shell";
import { StatusBanner, type StatusBannerTone } from "@/components/ui/status-banner";
import { parseDirectEntryCatalogResponse } from "@/lib/direct-entry/catalog-response";
import { projectChangeRequestStateResult } from "@/lib/direct-entry/change-request-contract";
import { changeRequestErrorMessage } from "@/lib/direct-entry/change-request-proposer";
import {
  projectChangeRequestListPage,
  type ChangeRequestListItem,
  type ChangeRequestQueueFilter,
} from "@/lib/direct-entry/change-request-read-contract";
import {
  clearIntentKey,
  EMPTY_INTENT_KEY,
  resolveIntentKey,
  shortRef,
  type TransitionIntentKeyState,
} from "@/lib/direct-entry/submission-lifecycle";
import {
  changeRequestWorkspaceTabs,
  initialChangeRequestQueue,
  initialChangeRequestWorkspaceMode,
  requestsQuery,
  WORKER_REQUEST_PAGE_SIZE,
  type ChangeRequestWorkspaceMode,
} from "@/lib/direct-entry/worker-operations-model";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";

import styles from "./direct-entry-shell.module.css";

const CHANGE_REQUEST_LIST_KEYS = ["requests", "page_size", "has_more", "next_cursor"] as const;
const CHANGE_REQUEST_RESULT_KEYS = ["request_id", "state", "version"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export type ChangeRequestsWorkspaceProps = {
  canReview: boolean;
  canPropose?: boolean;
  canViewGlobalHistory: boolean;
  canAccessDirectEntry?: boolean;
  canAccessWorkerDirectory?: boolean;
  hasProposerPending?: boolean;
  hasProposerResolved?: boolean;
  hasReviewerResolved?: boolean;
};

export function ChangeRequestsWorkspace({
  canReview,
  canPropose = false,
  canViewGlobalHistory,
  canAccessDirectEntry = false,
  canAccessWorkerDirectory = false,
  hasProposerPending = false,
  hasProposerResolved = false,
  hasReviewerResolved = false,
}: ChangeRequestsWorkspaceProps) {
  const initialAccess = {
    canReview,
    canPropose,
    hasProposerPending,
    hasProposerResolved,
    hasReviewerResolved,
  };
  const [mode, setMode] = useState<ChangeRequestWorkspaceMode>(() =>
    initialChangeRequestWorkspaceMode(initialAccess),
  );
  const [queueFilter, setQueueFilter] = useState<ChangeRequestQueueFilter>(() =>
    initialChangeRequestQueue(initialAccess),
  );
  const queueFilterRef = useRef<ChangeRequestQueueFilter>(initialChangeRequestQueue(initialAccess));
  const historyAgeRef = useRef<ResolvedAgeFilter>("3");
  const cursorRef = useRef<string | null>(null);
  const loadRef = useRef(0);
  const intentKeys = useRef(new Map<string, TransitionIntentKeyState>());

  const [requests, setRequests] = useState<ChangeRequestListItem[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [listMessage, setListMessage] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [reviewRequest, setReviewRequest] = useState<ChangeRequestListItem | null>(null);
  const [notice, setNotice] = useState<{ tone: StatusBannerTone; text: string } | null>(null);

  const [catalogs, setCatalogs] = useState<Record<string, DraftCatalog>>({});
  const catalogCache = useRef(new Map<string, DraftCatalog>());
  const catalogLoads = useRef(new Map<string, Promise<DraftCatalog>>());

  const catalogFor = useCallback((date: string) => catalogs[date], [catalogs]);

  const ensureCatalog = useCallback((date: string): Promise<DraftCatalog> => {
    const cached = catalogCache.current.get(date);
    if (cached) return Promise.resolve(cached);
    const inProgress = catalogLoads.current.get(date);
    if (inProgress) return inProgress;
    const load = fetch(`/api/direct-entry/catalog?effective_date=${encodeURIComponent(date)}`, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (response) => {
        const body = await readJson(response);
        const payload = parseDirectEntryCatalogResponse(body, date);
        if (!response.ok || !payload) {
          throw new Error("CATALOG_UNAVAILABLE");
        }
        catalogCache.current.set(date, payload);
        setCatalogs((current) => ({ ...current, [date]: payload }));
        return payload;
      })
      .finally(() => {
        catalogLoads.current.delete(date);
      });
    catalogLoads.current.set(date, load);
    return load;
  }, []);

  const loadChangeRequests = useCallback(async (
    loadMode: "replace" | "append",
    queue: ChangeRequestQueueFilter = queueFilterRef.current,
    age: ResolvedAgeFilter = historyAgeRef.current,
  ) => {
    const loadId = ++loadRef.current;
    setListState("loading");
    if (loadMode === "replace") {
      setRequests([]);
      setHasMore(false);
    }
    try {
      const cursor = loadMode === "append" ? cursorRef.current : null;
      const query = requestsQuery(cursor, queue, age);
      const response = await fetch("/api/direct-entry/change-requests" + query, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = await readJson(response);
      const page = projectChangeRequestListPage(
        projectionSlice(body, CHANGE_REQUEST_LIST_KEYS),
        { page_size: WORKER_REQUEST_PAGE_SIZE, audit: queue === "GLOBAL_AUDIT" },
      );
      if (!response.ok || !page) {
        throw new Error("CHANGE_REQUESTS_UNAVAILABLE");
      }
      if (loadId !== loadRef.current) return;
      setRequests((current) => {
        if (loadMode === "replace") return page.requests;
        const seen = new Set(current.map((item) => item.request_id));
        return [...current, ...page.requests.filter((item) => !seen.has(item.request_id))];
      });
      cursorRef.current = page.next_cursor;
      setHasMore(page.has_more);
      setListState("ready");
      setListMessage("");
    } catch (cause) {
      if (loadId !== loadRef.current) return;
      setListState("error");
      setListMessage(cause instanceof Error ? cause.message : "CHANGE_REQUESTS_UNAVAILABLE");
    }
  }, []);

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      await Promise.resolve();
      if (!active) return;
      await loadChangeRequests("replace", queueFilterRef.current, historyAgeRef.current);
    }
    void bootstrap();
    return () => {
      active = false;
    };
  }, [loadChangeRequests]);

  const selectQueue = useCallback((nextQueue: ChangeRequestQueueFilter) => {
    if (nextQueue === queueFilterRef.current) return;
    cursorRef.current = null;
    queueFilterRef.current = nextQueue;
    setQueueFilter(nextQueue);
    void loadChangeRequests("replace", nextQueue, historyAgeRef.current);
  }, [loadChangeRequests]);

  const switchWorkspaceMode = useCallback((nextMode: ChangeRequestWorkspaceMode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
    const nextQueue: ChangeRequestQueueFilter =
      nextMode === "reviewer"
        ? (canReview ? "REVIEWER_PENDING" : "REVIEWER_RESOLVED")
        : (!canPropose && !hasProposerPending && hasProposerResolved
            ? "PROPOSER_RESOLVED"
            : "PROPOSER_PENDING");
    cursorRef.current = null;
    queueFilterRef.current = nextQueue;
    setQueueFilter(nextQueue);
    void loadChangeRequests("replace", nextQueue, historyAgeRef.current);
  }, [canPropose, canReview, hasProposerPending, hasProposerResolved, loadChangeRequests, mode]);

  const withdrawChangeRequest = useCallback(async (request: ChangeRequestListItem) => {
    const intent = "change_request_withdraw:" + request.request_id + ":" + request.version;
    const resolved = resolveIntentKey(
      intentKeys.current.get(request.request_id) ?? EMPTY_INTENT_KEY,
      intent,
      () => crypto.randomUUID(),
    );
    intentKeys.current.set(request.request_id, resolved.state);
    setBusyRequestId(request.request_id);
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
          setNotice({ tone: "error", text: changeRequestErrorMessage(500) });
          return;
        }
        intentKeys.current.set(
          request.request_id,
          clearIntentKey(resolved.state, intent),
        );
        setNotice({
          tone: "success",
          text: "Đã rút yêu cầu " + shortRef(updated.request_id) + ".",
        });
        await loadChangeRequests("replace");
        return;
      }
      const status = response.status;
      if (status === 409) {
        intentKeys.current.set(
          request.request_id,
          clearIntentKey(resolved.state, intent),
        );
        setNotice({ tone: "warning", text: changeRequestErrorMessage(409) });
        await loadChangeRequests("replace");
        return;
      }
      if (status >= 500) {
        setNotice({ tone: "error", text: changeRequestErrorMessage(status) });
        return;
      }
      intentKeys.current.set(
        request.request_id,
        clearIntentKey(resolved.state, intent),
      );
      setNotice({ tone: "error", text: changeRequestErrorMessage(status) });
      if (status === 401 || status === 403) {
        await loadChangeRequests("replace");
      }
    } catch {
      setNotice({ tone: "error", text: changeRequestErrorMessage(0) });
    } finally {
      setBusyRequestId(null);
    }
  }, [loadChangeRequests]);

  const reloadAfterChangeRequestMutation = useCallback(async (
    message: string,
    tone: StatusBannerTone = "info",
  ) => {
    setNotice({ tone, text: message });
    await loadChangeRequests("replace");
  }, [loadChangeRequests]);

  const tabs = changeRequestWorkspaceTabs({ mode, canViewGlobalHistory });

  return (
    <main
      className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-3.5 py-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:gap-5 sm:px-6 sm:py-6 lg:px-8 overflow-x-clip"
      data-testid="change-requests-workspace"
    >
      <PageHeader
        className="border-b border-border pb-4"
        title="Yêu cầu thay đổi"
        badge={<StatusBadge tone="primary">{requests.length} yêu cầu</StatusBadge>}
        description={
          mode === "reviewer"
            ? "Xử lý yêu cầu chờ duyệt theo thẩm quyền hiện tại và tra cứu lịch sử các quyết định bạn đã thực hiện."
            : "Theo dõi các yêu cầu thay đổi bạn đã gửi và tra cứu lịch sử xử lý bất biến."
        }
        actions={
          <>
            {(canReview || hasReviewerResolved) && (
              mode === "reviewer" ? (
                <button
                  type="button"
                  data-testid="toggle-proposer-history-mode"
                  onClick={() => switchWorkspaceMode("proposer")}
                  className={buttonClasses({ variant: "secondary", size: "md" })}
                >
                  Lịch sử đề xuất của tôi
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="toggle-reviewer-mode"
                  onClick={() => switchWorkspaceMode("reviewer")}
                  className={buttonClasses({ variant: "secondary", size: "md" })}
                >
                  {canReview ? "Quay lại hàng đợi duyệt" : "Lịch sử duyệt của tôi"}
                </button>
              )
            )}
            <button
              type="button"
              disabled={listState === "loading"}
              onClick={() => void loadChangeRequests("replace")}
              className={buttonClasses({ variant: "secondary", size: "md" })}
            >
              Tải lại danh sách
            </button>
          </>
        }
      />

      {(canAccessDirectEntry || canAccessWorkerDirectory) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-xs sm:text-sm text-muted shadow-2xs">
          <span>
            Để tạo đề xuất thay đổi mới, hãy mở đợt đã gửi chính thức hoặc chọn trực tiếp người lao động trong phạm vi được phép.
          </span>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {canAccessDirectEntry && (
              <Link
                href="/direct-entry"
                className={buttonClasses({ variant: "soft", size: "sm" })}
              >
                Tới Nhập liệu
              </Link>
            )}
            {canAccessWorkerDirectory && (
              <Link
                href="/direct-entry/workers"
                className={buttonClasses({ variant: "soft", size: "sm" })}
              >
                Tới Người lao động
              </Link>
            )}
          </div>
        </div>
      )}

      {notice !== null && (
        <StatusBanner
          tone={notice.tone}
          dataTestId="change-request-workspace-notice"
        >
          {notice.text}
        </StatusBanner>
      )}

      <div className={styles.shell}>
        <DirectEntryChangeRequestList
          queueFilter={queueFilter}
          tabs={tabs}
          canViewGlobalHistory={canViewGlobalHistory}
          onQueueFilterChange={selectQueue}
          onGlobalHistoryAgeFilterChange={(age) => {
            historyAgeRef.current = age;
            if (queueFilterRef.current === "GLOBAL_AUDIT") {
              cursorRef.current = null;
              void loadChangeRequests("replace", "GLOBAL_AUDIT", age);
            }
          }}
          state={listState}
          message={listMessage}
          requests={requests}
          hasMore={hasMore}
          busyRequestId={busyRequestId}
          onLoadMore={() => void loadChangeRequests("append")}
          onWithdraw={(request) => void withdrawChangeRequest(request)}
          onReview={(request) => setReviewRequest(request)}
        />

        <div className="mt-4 flex justify-center">
          <CursorLoadMore
            hasMore={hasMore}
            loading={listState === "loading"}
            onLoadMore={() => void loadChangeRequests("append")}
            label="Tải thêm yêu cầu cũ hơn"
          />
        </div>
      </div>

      <DirectEntryChangeRequestReviewer
        request={reviewRequest}
        onOpenChange={(next) => {
          if (!next) setReviewRequest(null);
        }}
        catalogFor={catalogFor}
        ensureCatalog={ensureCatalog}
        onDecided={(message) => {
          void reloadAfterChangeRequestMutation(message, "success");
        }}
        onConflict={(message) => {
          void reloadAfterChangeRequestMutation(message, "warning");
        }}
      />
    </main>
  );
}
