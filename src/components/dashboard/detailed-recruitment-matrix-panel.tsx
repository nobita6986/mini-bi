"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { useNotify } from "@/components/ui/notify-provider";
import { formatTimestamp } from "@/lib/format";
import {
  ALL_RECRUITERS_TEAM_FILTER,
  formatPersonnelCodeCell,
  formatWorkMonthsCell,
  type DetailedMatrixTeamOption,
  type DetailedRecruitmentMatrixReport,
} from "@/lib/reporting/detailed-recruitment-matrix";
import {
  TREND_RESOLUTION_OPTIONS,
  type TrendResolution,
} from "@/lib/reporting/p1-dashboard-period";
import type { ReportingData } from "@/lib/reporting/p1-reporting";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";

import { FiltersOrError } from "./dashboard-shared";

export function buildDetailedMatrixFilterSignature(data: ReportingData): string {
  const a = data.applied;
  return [
    a.from ?? "",
    a.to ?? "",
    a.project ?? "",
    a.recruiter ?? "",
    a.provider ?? "",
    a.employment ?? "",
    a.status ?? "",
    a.source ?? "",
  ].join("|");
}

export function buildDetailedMatrixUrl(
  data: ReportingData,
  options?: { resolution?: TrendResolution; teamId?: string },
): string {
  const query = new URLSearchParams();
  const a = data.applied;
  if (a.from) query.set("from", a.from);
  else if (!a.to) query.set("range", "all");
  if (a.to) query.set("to", a.to);
  if (a.project) query.set("project", a.project);
  if (a.recruiter) query.set("recruiter", a.recruiter);
  if (a.provider) query.set("provider", a.provider);
  if (a.employment) query.set("employment", a.employment);
  if (a.status) query.set("status", a.status);
  if (a.source) query.set("source", a.source);

  const resolution = options?.resolution ?? "day";
  query.set("resolution", resolution);

  const teamId =
    options?.teamId && options.teamId.trim().length > 0
      ? options.teamId.trim()
      : ALL_RECRUITERS_TEAM_FILTER;
  if (teamId !== ALL_RECRUITERS_TEAM_FILTER) {
    query.set("team", teamId);
  }

  return "/api/reporting/detailed-matrix?" + query.toString();
}

function isReadyDetailedMatrixEnvelope(value: unknown): value is {
  ok: true;
  matrix: DetailedRecruitmentMatrixReport;
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.ok !== true) return false;
  const matrix = record.matrix as Record<string, unknown> | null | undefined;
  return Boolean(
    matrix &&
      typeof matrix === "object" &&
      Array.isArray(matrix.rows) &&
      Array.isArray(matrix.buckets) &&
      Array.isArray(matrix.columnTotals) &&
      typeof matrix.grandTotal === "number",
  );
}

/**
 * Panel cho tab `Báo cáo chi tiết` trên Dashboard toàn cục (`scope = "all"`).
 *
 * Hiển thị bảng ma trận 2 chiều:
 * - Cột cố định: `STT`, `Họ tên`, `Mã nhân viên`, `Số tháng làm việc`
 * - Cột thời gian động theo bộ chuyển `Ngày` / `Tuần` / `Tháng`
 * - Chế độ lọc `Tất cả người tuyển` hoặc từng nhóm (team) đang hoạt động
 * - Tổng theo dòng (`Tổng`) và tổng theo cột (`Tổng cộng`), đối soát khớp với Dashboard.
 */
export function DetailedRecruitmentMatrixPanel({
  data,
  generatedAt,
  optionsResult,
}: {
  data: ReportingData;
  generatedAt?: string;
  optionsResult: ReportingOptionsResult;
}) {
  const filterSignature = buildDetailedMatrixFilterSignature(data);
  const [resolution, setResolution] = useState<TrendResolution>("day");
  const [selectedTeamId, setSelectedTeamId] = useState<string>(
    ALL_RECRUITERS_TEAM_FILTER,
  );
  const [knownTeams, setKnownTeams] = useState<DetailedMatrixTeamOption[]>([]);
  const [reloadToken, setReloadToken] = useState(0);

  const cacheRef = useRef<Map<string, DetailedRecruitmentMatrixReport>>(
    new Map(),
  );
  const requestSeqRef = useRef(0);
  const userRetryRef = useRef(false);
  const resolutionButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const notify = useNotify();

  const requestKey = `${filterSignature}|${resolution}|${selectedTeamId}`;

  const [state, setState] = useState<{
    requestKey: string;
    status: "loading" | "ready" | "error";
    matrix: DetailedRecruitmentMatrixReport | null;
  }>({
    requestKey,
    status: "loading",
    matrix: null,
  });

  useEffect(() => {
    const cached =
      reloadToken === 0 ? cacheRef.current.get(requestKey) : undefined;
    if (cached) {
      userRetryRef.current = false;
      setKnownTeams(cached.teams);
      setState({
        requestKey,
        status: "ready",
        matrix: cached,
      });
      return;
    }

    const seq = ++requestSeqRef.current;
    const controller = new AbortController();
    const isUserRetry = userRetryRef.current;
    setState((prev) => ({
      requestKey,
      status: "loading",
      matrix: prev.requestKey === requestKey ? prev.matrix : null,
    }));

    fetch(
      buildDetailedMatrixUrl(data, {
        resolution,
        teamId: selectedTeamId,
      }),
      {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const json: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted || seq !== requestSeqRef.current) return;
        if (!response.ok || !isReadyDetailedMatrixEnvelope(json)) {
          userRetryRef.current = false;
          setState({ requestKey, status: "error", matrix: null });
          if (isUserRetry) {
            notify.error({
              title:
                "Không tải được dữ liệu báo cáo chi tiết cho bộ lọc hiện tại. Vui lòng thử lại.",
            });
          }
          return;
        }

        const matrix = json.matrix;
        userRetryRef.current = false;
        cacheRef.current.set(requestKey, matrix);
        setKnownTeams(matrix.teams);

        if (
          selectedTeamId !== ALL_RECRUITERS_TEAM_FILTER &&
          matrix.teams.length > 0 &&
          !matrix.teams.some((t) => t.teamId === selectedTeamId)
        ) {
          setSelectedTeamId(ALL_RECRUITERS_TEAM_FILTER);
          return;
        }

        setState({
          requestKey,
          status: "ready",
          matrix,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted && seq === requestSeqRef.current) {
          userRetryRef.current = false;
          setState({ requestKey, status: "error", matrix: null });
          if (isUserRetry) {
            notify.error({
              title:
                "Không tải được dữ liệu báo cáo chi tiết cho bộ lọc hiện tại. Vui lòng thử lại.",
            });
          }
        }
      });

    return () => controller.abort();
  }, [data, notify, reloadToken, requestKey, resolution, selectedTeamId]);

  function handleRetry(): void {
    userRetryRef.current = true;
    cacheRef.current.delete(requestKey);
    setReloadToken((n) => n + 1);
  }

  function handleResolutionKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void {
    let nextIndex = -1;
    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % TREND_RESOLUTION_OPTIONS.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex =
        (index + TREND_RESOLUTION_OPTIONS.length - 1) %
        TREND_RESOLUTION_OPTIONS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = TREND_RESOLUTION_OPTIONS.length - 1;
    }
    if (nextIndex < 0) return;
    event.preventDefault();
    setResolution(TREND_RESOLUTION_OPTIONS[nextIndex].key);
    requestAnimationFrame(() => resolutionButtonRefs.current[nextIndex]?.focus());
  }

  const isCurrentRequest = state.requestKey === requestKey;
  const effectiveStatus = isCurrentRequest ? state.status : "loading";
  const effectiveMatrix = isCurrentRequest ? state.matrix : null;
  const activeResolutionOption =
    TREND_RESOLUTION_OPTIONS.find((opt) => opt.key === resolution) ??
    TREND_RESOLUTION_OPTIONS[0];
  const teamOptions = effectiveMatrix?.teams ?? knownTeams;
  const selectedTeamLabel =
    selectedTeamId === ALL_RECRUITERS_TEAM_FILTER
      ? "Tất cả người tuyển"
      : (teamOptions.find((t) => t.teamId === selectedTeamId)?.displayName ??
        "Nhóm đã chọn");

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4 sm:px-6">
      <header className="rounded-2xl border border-border bg-gradient-to-r from-primary/10 via-surface to-secondary/10 px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-primary">
            BoD · Báo cáo chi tiết
          </p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-foreground">
            Báo cáo chi tiết tuyển dụng
          </h1>
          <p className="mt-0.5 max-w-2xl text-sm text-muted">
            Bảng chi tiết số lượng tuyển dụng theo từng nhân viên tuyển dụng và mốc thời gian (Ngày / Tuần / Tháng), đối soát khớp với tổng số liệu trên Dashboard.
          </p>
          {generatedAt ? (
            <p className="mt-1 text-xs text-muted">
              Báo cáo tạo lúc: <time>{formatTimestamp(generatedAt)}</time>
            </p>
          ) : null}
        </div>
      </header>

      <div className="mt-4 space-y-4">
        <FiltersOrError optionsResult={optionsResult} />

        <Card className="p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1">
              <CardHeader title="Bảng chi tiết tuyển dụng theo nhân viên" />
              <p className="text-xs text-muted" aria-live="polite">
                Phạm vi hiển thị:{" "}
                <span className="font-medium text-foreground">
                  {selectedTeamLabel}
                </span>
                {" · "}
                Độ phân giải:{" "}
                <span className="font-medium text-foreground">
                  {activeResolutionOption.label}
                </span>
                {effectiveMatrix ? (
                  <>
                    {" · "}
                    <span className="font-mono tabular-nums">
                      {effectiveMatrix.rows.length}
                    </span>{" "}
                    nhân viên
                    {" · "}
                    <span className="font-mono tabular-nums">
                      {effectiveMatrix.buckets.length}
                    </span>{" "}
                    mốc
                    {" · "}
                    Tổng tuyển:{" "}
                    <strong className="font-mono tabular-nums text-foreground">
                      {effectiveMatrix.grandTotal}
                    </strong>
                  </>
                ) : null}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {effectiveMatrix?.asOfDate ? (
                <StatusBadge tone="neutral" dot>
                  Thâm niên tính đến {effectiveMatrix.asOfDate}
                </StatusBadge>
              ) : null}

              <div className="flex items-center gap-2">
                <label
                  htmlFor="detailed-matrix-team-select"
                  className="text-xs font-medium whitespace-nowrap text-muted"
                >
                  Người tuyển / Nhóm
                </label>
                <select
                  id="detailed-matrix-team-select"
                  aria-label="Người tuyển / Nhóm"
                  value={selectedTeamId}
                  onChange={(event) => setSelectedTeamId(event.target.value)}
                  className="min-h-9 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <option value={ALL_RECRUITERS_TEAM_FILTER}>
                    Tất cả người tuyển
                  </option>
                  {teamOptions.map((team) => (
                    <option key={team.teamId} value={team.teamId}>
                      {team.displayName} ({team.memberCount})
                    </option>
                  ))}
                </select>
              </div>

              <div
                role="group"
                aria-label="Độ phân giải thời gian báo cáo chi tiết"
                className="inline-flex flex-wrap items-center rounded-lg border border-border bg-surface-muted p-0.5"
              >
                {TREND_RESOLUTION_OPTIONS.map((opt, idx) => {
                  const active = resolution === opt.key;
                  return (
                    <button
                      key={opt.key}
                      ref={(el) => {
                        resolutionButtonRefs.current[idx] = el;
                      }}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setResolution(opt.key)}
                      onKeyDown={(event) => handleResolutionKeyDown(event, idx)}
                      className={`min-h-9 rounded-md px-3 text-xs font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                        active
                          ? "bg-primary text-on-primary shadow-sm"
                          : "text-muted hover:text-foreground"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {effectiveStatus === "loading" ? (
            <div
              role="status"
              className="mt-4 rounded-2xl border border-border bg-surface px-6 py-10 text-center text-sm text-muted"
            >
              Đang tải báo cáo chi tiết…
            </div>
          ) : effectiveStatus === "error" || !effectiveMatrix ? (
            <div className="mt-4">
              <Alert
                tone="error"
                role="alert"
                title="Không tải được báo cáo chi tiết"
              >
                <p>
                  Không tải được dữ liệu báo cáo chi tiết cho bộ lọc hiện tại. Vui lòng thử lại.
                </p>
                <button
                  type="button"
                  onClick={handleRetry}
                  className="mt-2 min-h-10 rounded-md border border-current px-3 text-xs font-medium transition-[background-color,transform] duration-[var(--ui-motion-hover,160ms)] hover:bg-black/5 dark:hover:bg-white/10 active:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  Thử tải lại
                </button>
              </Alert>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-surface">
              <table
                className="r22-report-table min-w-full border-collapse text-left text-xs"
                aria-label="Bảng báo cáo chi tiết tuyển dụng theo nhân viên"
              >
                <caption className="sr-only">
                  Bảng báo cáo chi tiết tuyển dụng theo nhân viên ({selectedTeamLabel}, độ phân giải {activeResolutionOption.label})
                </caption>
                <thead className="bg-surface-muted uppercase tracking-wide text-muted">
                  <tr className="border-b border-border">
                    <th
                      scope="col"
                      className="sticky left-0 z-20 w-11 min-w-[44px] bg-surface-muted px-2.5 py-2.5 text-center font-medium whitespace-nowrap"
                    >
                      STT
                    </th>
                    <th
                      scope="col"
                      className="sticky left-11 z-20 min-w-[148px] max-w-[200px] border-r border-border bg-surface-muted px-3 py-2.5 font-medium whitespace-nowrap sm:min-w-[180px] sm:max-w-[240px]"
                    >
                      Họ tên
                    </th>
                    <th
                      scope="col"
                      className="min-w-[110px] bg-surface-muted px-3 py-2.5 font-medium whitespace-nowrap"
                    >
                      Mã nhân viên
                    </th>
                    <th
                      scope="col"
                      className="min-w-[136px] border-r border-border bg-surface-muted px-3 py-2.5 text-right font-medium whitespace-nowrap"
                    >
                      Số tháng làm việc
                    </th>
                    {effectiveMatrix.buckets.map((bucket) => (
                      <th
                        key={bucket.key}
                        scope="col"
                        title={
                          bucket.startDate === bucket.endDate
                            ? bucket.startDate
                            : `${bucket.startDate} → ${bucket.endDate}`
                        }
                        className="min-w-[88px] bg-surface-muted px-2.5 py-2.5 text-right font-medium tabular-nums whitespace-nowrap"
                      >
                        {bucket.date}
                      </th>
                    ))}
                    <th
                      scope="col"
                      className="min-w-[88px] border-l border-border bg-surface-muted px-3 py-2.5 text-right font-semibold text-foreground whitespace-nowrap md:sticky md:right-0 md:z-20"
                    >
                      Tổng
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {effectiveMatrix.rows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={5 + effectiveMatrix.buckets.length}
                        className="px-4 py-8 text-center text-sm text-muted"
                      >
                        Không có nhân viên tuyển dụng nào khớp bộ lọc đang chọn.
                      </td>
                    </tr>
                  ) : (
                    effectiveMatrix.rows.map((row) => (
                      <tr
                        key={row.recruiterId}
                        className="group text-foreground hover:bg-surface-hover"
                      >
                        <td className="sticky left-0 z-10 w-11 min-w-[44px] bg-surface px-2.5 py-2 text-center tabular-nums text-muted group-hover:bg-surface-hover">
                          {row.stt}
                        </td>
                        <th
                          scope="row"
                          title={row.displayName}
                          className="sticky left-11 z-10 min-w-[148px] max-w-[200px] truncate border-r border-border bg-surface px-3 py-2 font-medium text-foreground group-hover:bg-surface-hover sm:min-w-[180px] sm:max-w-[240px]"
                        >
                          {row.displayName}
                        </th>
                        <td className="px-3 py-2 font-mono tabular-nums text-muted whitespace-nowrap">
                          {formatPersonnelCodeCell(row.personnelCode)}
                        </td>
                        <td className="border-r border-border px-3 py-2 text-right tabular-nums whitespace-nowrap">
                          {formatWorkMonthsCell(row.workMonths)}
                        </td>
                        {effectiveMatrix.buckets.map((bucket, bucketIdx) => {
                          const count = row.counts[bucketIdx] ?? 0;
                          return (
                            <td
                              key={bucket.key}
                              className={`px-2.5 py-2 text-right tabular-nums whitespace-nowrap ${
                                count > 0
                                  ? "font-medium text-foreground"
                                  : "text-muted"
                              }`}
                            >
                              {count}
                            </td>
                          );
                        })}
                        <td className="border-l border-border bg-surface px-3 py-2 text-right font-semibold tabular-nums text-foreground whitespace-nowrap group-hover:bg-surface-hover md:sticky md:right-0 md:z-10">
                          {row.total}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot className="border-t-2 border-border bg-surface-muted font-semibold text-foreground">
                  <tr>
                    <th
                      scope="row"
                      colSpan={2}
                      className="sticky left-0 z-10 border-r border-border bg-surface-muted px-3 py-2.5 text-left whitespace-nowrap"
                    >
                      Tổng cộng
                    </th>
                    <td
                      colSpan={2}
                      className="border-r border-border bg-surface-muted px-3 py-2.5 text-right text-xs font-normal text-muted whitespace-nowrap"
                    >
                      {effectiveMatrix.rows.length} nhân viên
                    </td>
                    {effectiveMatrix.buckets.map((bucket, bucketIdx) => (
                      <td
                        key={bucket.key}
                        className="bg-surface-muted px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap"
                      >
                        {effectiveMatrix.columnTotals[bucketIdx] ?? 0}
                      </td>
                    ))}
                    <td className="border-l border-border bg-surface-muted px-3 py-2.5 text-right font-bold tabular-nums text-primary whitespace-nowrap md:sticky md:right-0 md:z-10">
                      {effectiveMatrix.grandTotal}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}
