"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { Button } from "@/components/ui/button";
import { CursorLoadMore } from "@/components/ui/cursor-load-more";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
  EMPTY_RECRUITMENT_POST_FILTERS,
  applyIndustrialParkFilterChange,
  applyProvinceFilterChange,
  buildRecruitmentPostListUrl,
  classifyRecruitmentPostAccessLoss,
  createEmptyRecruitmentPostDataState,
  createLatestRequestTracker,
  extractRecruitmentPostErrorCode,
  hasActiveRecruitmentPostFilters,
  mergeUniqueRecruitmentPostItems,
  parseRecruitmentPostContextEnvelope,
  parseRecruitmentPostDetailEnvelope,
  parseRecruitmentPostListEnvelope,
  recruitmentPostErrorMessage,
  toRecruitmentPostCardViewModel,
  toRecruitmentPostDetailViewModel,
  validateRecruitmentPostFeedFilters,
  visibleIndustrialParksForFilter,
  visibleLaborTypesForFilter,
  visibleProvincesForFilter,
  type LatestRequestTracker,
  type RecruitmentPostAccessLossKind,
  type RecruitmentPostDataState,
  type RecruitmentPostFeedFilterState,
} from "@/lib/recruitment-posts/recruitment-post-ui-model";

import { RecruitmentPostCard } from "./recruitment-post-card";
import { RecruitmentPostDetailDialog } from "./recruitment-post-detail-dialog";

const FILTER_SELECT_CLASS =
  "h-11 w-full rounded-lg border border-border bg-surface px-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60";

const FILTER_DATE_INPUT_CLASS =
  "h-11 w-full rounded-lg border border-border bg-surface px-2.5 text-sm font-mono tabular-nums text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60";

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function getRequestTracker(
  ref: { current: LatestRequestTracker | null },
): LatestRequestTracker {
  if (!ref.current) {
    ref.current = createLatestRequestTracker();
  }
  return ref.current;
}

export function RecruitmentPostFeedWorkspace() {
  const [filters, setFilters] = useState<RecruitmentPostFeedFilterState>(
    EMPTY_RECRUITMENT_POST_FILTERS,
  );
  const [dataState, setDataState] = useState<RecruitmentPostDataState>(
    createEmptyRecruitmentPostDataState,
  );
  const [accessLoss, setAccessLoss] =
    useState<RecruitmentPostAccessLossKind | null>(null);
  const [initialLoading, setInitialLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);

  const contextTrackerRef = useRef<LatestRequestTracker | null>(null);
  const feedTrackerRef = useRef<LatestRequestTracker | null>(null);
  const detailTrackerRef = useRef<LatestRequestTracker | null>(null);

  const handleAccessRevoked = useCallback(
    (lossKind: RecruitmentPostAccessLossKind) => {
      getRequestTracker(contextTrackerRef).cancelAll();
      getRequestTracker(feedTrackerRef).cancelAll();
      getRequestTracker(detailTrackerRef).cancelAll();
      setDataState(createEmptyRecruitmentPostDataState());
      setInitialLoading(false);
      setLoadingMore(false);
      setDetailLoading(false);
      setFeedError(null);
      setLoadMoreError(null);
      setAccessLoss(lossKind);
    },
    [],
  );

  const loadContext = useCallback(async () => {
    const ticket = getRequestTracker(contextTrackerRef).begin();

    try {
      const response = await fetch("/api/recruitment-posts/context", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        signal: ticket.signal,
      });
      if (!ticket.isCurrent()) return;

      const rawPayload = await response.json().catch(() => null);
      if (!ticket.isCurrent()) return;

      const errorCode = extractRecruitmentPostErrorCode(rawPayload);
      const revoked = classifyRecruitmentPostAccessLoss(
        response.status,
        errorCode,
      );
      if (revoked) {
        handleAccessRevoked(revoked);
        return;
      }

      if (!response.ok) {
        return;
      }

      const parsedContext = parseRecruitmentPostContextEnvelope(rawPayload);
      if (!parsedContext) {
        return;
      }

      setDataState((prev) => ({
        ...prev,
        context: parsedContext,
      }));
    } catch (error) {
      if (isAbortError(error) || !ticket.isCurrent()) return;
    }
  }, [handleAccessRevoked]);

  const loadFirstPage = useCallback(
    async (activeFilters: RecruitmentPostFeedFilterState) => {
      const validation = validateRecruitmentPostFeedFilters(activeFilters);
      if (!validation.ok) {
        getRequestTracker(feedTrackerRef).cancelAll();
        setInitialLoading(false);
        setLoadingMore(false);
        setFeedError(validation.message);
        setLoadMoreError(null);
        return;
      }

      const ticket = getRequestTracker(feedTrackerRef).begin();

      setInitialLoading(true);
      setLoadingMore(false);
      setFeedError(null);
      setLoadMoreError(null);
      setDataState((prev) => ({
        ...prev,
        nextCursor: null,
        snapshotToken: null,
        hasMore: false,
      }));

      const url = buildRecruitmentPostListUrl(activeFilters, {
        pageSize: DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
      });

      try {
        const response = await fetch(url, {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          signal: ticket.signal,
        });
        if (!ticket.isCurrent()) return;

        const rawPayload = await response.json().catch(() => null);
        if (!ticket.isCurrent()) return;

        const errorCode = extractRecruitmentPostErrorCode(rawPayload);
        const revoked = classifyRecruitmentPostAccessLoss(
          response.status,
          errorCode,
        );
        if (revoked) {
          handleAccessRevoked(revoked);
          return;
        }

        if (!response.ok) {
          setInitialLoading(false);
          setFeedError(recruitmentPostErrorMessage(errorCode));
          return;
        }

        const parsedList = parseRecruitmentPostListEnvelope(rawPayload);
        if (!parsedList) {
          setInitialLoading(false);
          setFeedError(
            recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
          );
          return;
        }

        setAccessLoss(null);
        setInitialLoading(false);
        setFeedError(null);
        setDataState((prev) => ({
          ...prev,
          items: mergeUniqueRecruitmentPostItems([], parsedList.items),
          nextCursor: parsedList.next_cursor,
          snapshotToken: parsedList.snapshot_token,
          hasMore: parsedList.has_more && parsedList.next_cursor !== null,
        }));
      } catch (error) {
        if (isAbortError(error) || !ticket.isCurrent()) return;
        setInitialLoading(false);
        setFeedError(
          recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
        );
      }
    },
    [handleAccessRevoked],
  );

  const handleLoadMore = useCallback(async () => {
    if (
      initialLoading ||
      loadingMore ||
      !dataState.hasMore ||
      !dataState.nextCursor ||
      !dataState.snapshotToken
    ) {
      return;
    }

    const ticket = getRequestTracker(feedTrackerRef).begin();

    setLoadingMore(true);
    setLoadMoreError(null);

    const url = buildRecruitmentPostListUrl(filters, {
      cursor: dataState.nextCursor,
      snapshotToken: dataState.snapshotToken,
      pageSize: DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
    });

    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        signal: ticket.signal,
      });
      if (!ticket.isCurrent()) return;

      const rawPayload = await response.json().catch(() => null);
      if (!ticket.isCurrent()) return;

      const errorCode = extractRecruitmentPostErrorCode(rawPayload);
      const revoked = classifyRecruitmentPostAccessLoss(
        response.status,
        errorCode,
      );
      if (revoked) {
        handleAccessRevoked(revoked);
        return;
      }

      if (!response.ok) {
        setLoadingMore(false);
        setLoadMoreError(recruitmentPostErrorMessage(errorCode));
        return;
      }

      const parsedList = parseRecruitmentPostListEnvelope(rawPayload);
      if (!parsedList) {
        setLoadingMore(false);
        setLoadMoreError(
          recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
        );
        return;
      }

      setLoadingMore(false);
      setLoadMoreError(null);
      setDataState((prev) => ({
        ...prev,
        items: mergeUniqueRecruitmentPostItems(prev.items, parsedList.items),
        nextCursor: parsedList.next_cursor,
        snapshotToken: parsedList.snapshot_token,
        hasMore: parsedList.has_more && parsedList.next_cursor !== null,
      }));
    } catch (error) {
      if (isAbortError(error) || !ticket.isCurrent()) return;
      setLoadingMore(false);
      setLoadMoreError(
        recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
      );
    }
  }, [
    dataState.hasMore,
    dataState.nextCursor,
    dataState.snapshotToken,
    filters,
    handleAccessRevoked,
    initialLoading,
    loadingMore,
  ]);

  const fetchDetail = useCallback(
    async (briefId: string) => {
      const ticket = getRequestTracker(detailTrackerRef).begin();

      setDetailLoading(true);
      setDataState((prev) => ({
        ...prev,
        detailError: null,
      }));

      try {
        const response = await fetch(
          `/api/recruitment-posts/${encodeURIComponent(briefId)}`,
          {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
            signal: ticket.signal,
          },
        );
        if (!ticket.isCurrent()) return;

        const rawPayload = await response.json().catch(() => null);
        if (!ticket.isCurrent()) return;

        const errorCode = extractRecruitmentPostErrorCode(rawPayload);
        const revoked = classifyRecruitmentPostAccessLoss(
          response.status,
          errorCode,
        );
        if (revoked) {
          handleAccessRevoked(revoked);
          return;
        }

        if (!response.ok) {
          setDetailLoading(false);
          setDataState((prev) => ({
            ...prev,
            selectedDetail:
              response.status === 404 ? null : prev.selectedDetail,
            items:
              response.status === 404
                ? prev.items.filter((item) => item.brief_id !== briefId)
                : prev.items,
            detailError: recruitmentPostErrorMessage(errorCode),
          }));
          return;
        }

        const parsedDetail = parseRecruitmentPostDetailEnvelope(rawPayload);
        if (!parsedDetail) {
          setDetailLoading(false);
          setDataState((prev) => ({
            ...prev,
            detailError: recruitmentPostErrorMessage(
              "RECRUITMENT_POST_UNAVAILABLE",
            ),
          }));
          return;
        }

        setDetailLoading(false);
        setDataState((prev) => ({
          ...prev,
          selectedDetail: parsedDetail.post,
          detailError: null,
          items: prev.items.map((item) =>
            item.brief_id === parsedDetail.post.brief_id
              ? parsedDetail.post
              : item,
          ),
        }));
      } catch (error) {
        if (isAbortError(error) || !ticket.isCurrent()) return;
        setDetailLoading(false);
        setDataState((prev) => ({
          ...prev,
          detailError: recruitmentPostErrorMessage(
            "RECRUITMENT_POST_UNAVAILABLE",
          ),
        }));
      }
    },
    [handleAccessRevoked],
  );

  const handleOpenDetail = useCallback(
    (briefId: string) => {
      setDataState((prev) => {
        const existingItem =
          prev.items.find((item) => item.brief_id === briefId) ?? null;
        return {
          ...prev,
          detailOpen: true,
          detailBriefId: briefId,
          selectedDetail: existingItem,
          detailError: null,
        };
      });
      void fetchDetail(briefId);
    },
    [fetchDetail],
  );

  const handleDetailOpenChange = useCallback((open: boolean) => {
    if (!open) {
      getRequestTracker(detailTrackerRef).cancelAll();
      setDetailLoading(false);
      setDataState((prev) => ({
        ...prev,
        detailOpen: false,
        detailBriefId: null,
        selectedDetail: null,
        detailError: null,
      }));
    }
  }, []);

  const handleRetryDetail = useCallback(() => {
    if (!dataState.detailBriefId) return;
    void fetchDetail(dataState.detailBriefId);
  }, [dataState.detailBriefId, fetchDetail]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadContext();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadContext]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadFirstPage(filters);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filters, loadFirstPage]);

  useEffect(() => {
    return () => {
      getRequestTracker(contextTrackerRef).cancelAll();
      getRequestTracker(feedTrackerRef).cancelAll();
      getRequestTracker(detailTrackerRef).cancelAll();
    };
  }, []);

  const filterProjects = useMemo(
    () => dataState.context?.filter_projects ?? [],
    [dataState.context],
  );

  const activeProvinces = useMemo(
    () => visibleProvincesForFilter(dataState.context?.provinces ?? []),
    [dataState.context],
  );

  const activeIndustrialParks = useMemo(
    () =>
      visibleIndustrialParksForFilter(
        dataState.context?.industrial_parks ?? [],
        filters.provinceId,
      ),
    [dataState.context, filters.provinceId],
  );

  const activeLaborTypes = useMemo(
    () => visibleLaborTypesForFilter(dataState.context?.labor_types ?? []),
    [dataState.context],
  );

  const cardViewModels = useMemo(
    () => dataState.items.map((item) => toRecruitmentPostCardViewModel(item)),
    [dataState.items],
  );

  const detailViewModel = useMemo(
    () =>
      dataState.selectedDetail
        ? toRecruitmentPostDetailViewModel(dataState.selectedDetail)
        : null,
    [dataState.selectedDetail],
  );

  const hasFilters = hasActiveRecruitmentPostFilters(filters);

  if (accessLoss === "ACCESS_DENIED") {
    return <AccessDenied />;
  }

  if (accessLoss === "ACCOUNT_UNAVAILABLE") {
    return <AccountUnavailable />;
  }

  if (accessLoss === "UNAUTHENTICATED") {
    return (
      <main
        data-testid="recruitment-posts-unauthenticated"
        className="flex min-h-full flex-1 items-center justify-center p-4"
      >
        <div
          role="alert"
          className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 text-center shadow-xs"
        >
          <h1 className="mb-2 text-lg font-semibold text-foreground">
            Phiên đăng nhập đã hết hạn
          </h1>
          <p className="mb-5 text-sm text-muted">
            Dữ liệu trên màn hình đã được xóa để bảo mật. Vui lòng đăng nhập lại
            để tiếp tục xem tin tuyển dụng.
          </p>
          <div className="flex flex-col gap-2">
            <Link
              href="/login?next=%2Frecruitment-posts"
              className="inline-flex min-h-11 h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              Đăng nhập lại
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <PageShell dataTestId="recruitment-posts-workspace">
      <PageHeader
        title="Tin tuyển dụng"
        description="Tra cứu thông tin các phiếu yêu cầu tuyển dụng đang hiệu lực theo dự án, khu công nghiệp và hình thức tuyển dụng."
      />

      <FilterToolbar
        dataTestId="recruitment-posts-filter-toolbar"
        actions={
          hasFilters ? (
            <Button
              type="button"
              variant="secondary"
              size="md"
              data-testid="recruitment-posts-clear-filters"
              onClick={() => setFilters(EMPTY_RECRUITMENT_POST_FILTERS)}
            >
              Xóa bộ lọc
            </Button>
          ) : null
        }
        summary={
          <span>
            Hiển thị{" "}
            <strong className="font-mono tabular-nums text-foreground">
              {cardViewModels.length}
            </strong>{" "}
            tin tuyển dụng đang hiệu lực (tối đa{" "}
            {DEFAULT_RECRUITMENT_POST_PAGE_SIZE} tin mỗi lượt tải).
          </span>
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <label
              htmlFor="recruitment-posts-filter-project"
              className="font-medium text-muted"
            >
              Dự án
            </label>
            <select
              id="recruitment-posts-filter-project"
              data-testid="recruitment-posts-filter-project"
              value={filters.projectId}
              onChange={(event) =>
                setFilters((prev) => ({
                  ...prev,
                  projectId: event.target.value,
                }))
              }
              className={FILTER_SELECT_CLASS}
            >
              <option value="">Tất cả dự án</option>
              {filterProjects.map((project) => (
                <option key={project.project_id} value={project.project_id}>
                  {project.display_name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <label
              htmlFor="recruitment-posts-filter-province"
              className="font-medium text-muted"
            >
              Tỉnh/Thành
            </label>
            <select
              id="recruitment-posts-filter-province"
              data-testid="recruitment-posts-filter-province"
              value={filters.provinceId}
              onChange={(event) =>
                setFilters((prev) =>
                  applyProvinceFilterChange(
                    prev,
                    event.target.value,
                    dataState.context?.industrial_parks ?? [],
                  ),
                )
              }
              className={FILTER_SELECT_CLASS}
            >
              <option value="">Tất cả tỉnh/thành</option>
              {activeProvinces.map((province) => (
                <option key={province.province_id} value={province.province_id}>
                  {province.display_name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <label
              htmlFor="recruitment-posts-filter-park"
              className="font-medium text-muted"
            >
              Khu công nghiệp
            </label>
            <select
              id="recruitment-posts-filter-park"
              data-testid="recruitment-posts-filter-park"
              value={filters.industrialParkId}
              onChange={(event) =>
                setFilters((prev) =>
                  applyIndustrialParkFilterChange(
                    prev,
                    event.target.value,
                    dataState.context?.industrial_parks ?? [],
                  ),
                )
              }
              className={FILTER_SELECT_CLASS}
            >
              <option value="">Tất cả KCN</option>
              {activeIndustrialParks.map((park) => (
                <option
                  key={park.industrial_park_id}
                  value={park.industrial_park_id}
                >
                  {park.display_name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <label
              htmlFor="recruitment-posts-filter-labor-type"
              className="font-medium text-muted"
            >
              Hình thức tuyển dụng
            </label>
            <select
              id="recruitment-posts-filter-labor-type"
              data-testid="recruitment-posts-filter-labor-type"
              value={filters.laborTypeKey}
              onChange={(event) =>
                setFilters((prev) => ({
                  ...prev,
                  laborTypeKey: event.target.value,
                }))
              }
              className={FILTER_SELECT_CLASS}
            >
              <option value="">Tất cả hình thức</option>
              {activeLaborTypes.map((laborType) => (
                <option
                  key={laborType.labor_type_key}
                  value={laborType.labor_type_key}
                >
                  {laborType.display_name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <label
              htmlFor="recruitment-posts-filter-updated-from"
              className="font-medium text-muted"
            >
              Từ ngày cập nhật
            </label>
            <input
              id="recruitment-posts-filter-updated-from"
              data-testid="recruitment-posts-filter-updated-from"
              type="date"
              value={filters.updatedFrom}
              max={filters.updatedTo || undefined}
              onChange={(event) =>
                setFilters((prev) => ({
                  ...prev,
                  updatedFrom: event.target.value,
                }))
              }
              className={FILTER_DATE_INPUT_CLASS}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <label
              htmlFor="recruitment-posts-filter-updated-to"
              className="font-medium text-muted"
            >
              Đến ngày cập nhật
            </label>
            <input
              id="recruitment-posts-filter-updated-to"
              data-testid="recruitment-posts-filter-updated-to"
              type="date"
              value={filters.updatedTo}
              min={filters.updatedFrom || undefined}
              onChange={(event) =>
                setFilters((prev) => ({
                  ...prev,
                  updatedTo: event.target.value,
                }))
              }
              className={FILTER_DATE_INPUT_CLASS}
            />
          </div>
        </div>
      </FilterToolbar>

      {feedError ? (
        <StatusBanner
          tone="error"
          title="Không thể tải danh sách tin tuyển dụng"
          dataTestId="recruitment-posts-feed-error"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{feedError}</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="recruitment-posts-feed-retry"
              onClick={() => {
                void loadContext();
                void loadFirstPage(filters);
              }}
            >
              Thử lại
            </Button>
          </div>
        </StatusBanner>
      ) : null}

      {initialLoading ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="recruitment-posts-loading"
          className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-muted"
        >
          Đang tải danh sách tin tuyển dụng…
        </div>
      ) : null}

      {!initialLoading && !feedError && cardViewModels.length === 0 ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="recruitment-posts-empty"
          className="rounded-xl border border-border bg-surface p-8 text-center space-y-3"
        >
          <p className="text-sm font-medium text-foreground">
            {hasFilters
              ? "Không có phiếu tuyển dụng nào khớp với bộ lọc."
              : "Hiện chưa có phiếu tuyển dụng nào đang hiệu lực."}
          </p>
          {hasFilters ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setFilters(EMPTY_RECRUITMENT_POST_FILTERS)}
              >
                Xóa bộ lọc
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {!initialLoading && cardViewModels.length > 0 ? (
        <div
          data-testid="recruitment-posts-list"
          className="flex flex-col gap-4"
        >
          {cardViewModels.map((card) => (
            <RecruitmentPostCard
              key={card.briefId}
              card={card}
              onViewDetail={handleOpenDetail}
            />
          ))}

          {loadMoreError ? (
            <StatusBanner
              tone="error"
              title="Không thể tải thêm tin tuyển dụng"
              dataTestId="recruitment-posts-load-more-error"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{loadMoreError}</span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid="recruitment-posts-load-more-retry"
                  onClick={() => {
                    void handleLoadMore();
                  }}
                  disabled={loadingMore}
                >
                  Thử lại
                </Button>
              </div>
            </StatusBanner>
          ) : null}

          <div className="flex justify-center pt-2">
            <CursorLoadMore
              hasMore={dataState.hasMore}
              loading={loadingMore}
              onLoadMore={() => {
                void handleLoadMore();
              }}
              label="Tải thêm"
              loadingLabel="Đang tải thêm…"
            />
          </div>
        </div>
      ) : null}

      <RecruitmentPostDetailDialog
        open={dataState.detailOpen}
        onOpenChange={handleDetailOpenChange}
        detail={detailViewModel}
        loading={detailLoading}
        error={dataState.detailError}
        onRetry={handleRetryDetail}
      />
    </PageShell>
  );
}
