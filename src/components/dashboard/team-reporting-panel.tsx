"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseAsString, useQueryStates } from "nuqs";

import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/reporting/empty-state";
import { FiltersOrError, NoMatchesBlock } from "./dashboard-shared";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";
import {
  UNKNOWN_TEAM_BUCKET_KEY,
  type ReportingBucket,
  type ReportingData,
} from "@/lib/reporting/p1-reporting";
import { sortBuckets } from "@/lib/reporting/p1-dashboard";
import type {
  TeamDrillDownEnvelope,
  TeamDrillDownRow,
} from "@/lib/reporting/p2-w05b-team-reporting-server";
import { TeamBucketChart } from "./team-bucket-chart";

const filterParsers = {
  from: parseAsString,
  to: parseAsString,
  project: parseAsString,
  recruiter: parseAsString,
  provider: parseAsString,
  employment: parseAsString,
  source: parseAsString,
};

const filterKeys = ["from", "to", "project", "recruiter", "provider", "employment", "source"] as const;
type QueryFilters = Record<(typeof filterKeys)[number], string | null>;
type DrillState = "idle" | "loading" | "loaded" | "error";

type LastRequest = {
  bucketKey: string;
  cursor: string | null;
  append: boolean;
};

function valueOrNull(value: string | undefined | null): string | null {
  return value ?? null;
}

function filtersSignature(filters: QueryFilters): string {
  return JSON.stringify(filters);
}

function dataFiltersSignature(data: ReportingData): string {
  return filtersSignature({
    from: valueOrNull(data.applied.from),
    to: valueOrNull(data.applied.to),
    project: valueOrNull(data.applied.project),
    recruiter: valueOrNull(data.applied.recruiter),
    provider: valueOrNull(data.applied.provider),
    employment: valueOrNull(data.applied.employment),
    source: valueOrNull(data.applied.source),
  });
}

function drillDownUrl(data: ReportingData, bucketKey: string, cursor: string | null): string {
  const params = new URLSearchParams({ bucket_key: bucketKey, limit: "25" });
  for (const key of filterKeys.slice(0, -1)) {
    const value = data.applied[key];
    if (value) params.set(key, value);
  }
  if (cursor) params.set("cursor", cursor);
  return "/api/reporting/team-drill-down?" + params.toString();
}

function failureMessage(status: number, payload: unknown): string {
  const code = typeof payload === "object" && payload !== null && "code" in payload
    ? (payload as { code?: unknown }).code
    : null;
  if (status === 400 || code === "INVALID_FILTER") return "Bộ lọc báo cáo theo nhóm không hợp lệ.";
  if (status === 401) return "Phiên đăng nhập không còn hiệu lực.";
  if (status === 403) return "Bạn không có quyền xem báo cáo theo nhóm.";
  return "Không tải được chi tiết nhóm. Hãy thử lại.";
}

function isEnvelope(value: unknown): value is TeamDrillDownEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Partial<TeamDrillDownEnvelope>;
  return typeof envelope.bucket === "object"
    && envelope.bucket !== null
    && Array.isArray(envelope.rows)
    && (typeof envelope.nextCursor === "string" || envelope.nextCursor === null)
    && typeof envelope.total === "number"
    && typeof envelope.applied === "object"
    && envelope.applied !== null;
}

function DetailTable({ rows, caption }: { rows: TeamDrillDownRow[]; caption: string }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[760px] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted/20 text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-3 py-3">Ngày</th>
            <th scope="col" className="px-3 py-3">Dự án</th>
            <th scope="col" className="px-3 py-3">Người tuyển</th>
            <th scope="col" className="px-3 py-3">HRP/Vendor</th>
            <th scope="col" className="px-3 py-3">Loại hình</th>
            <th scope="col" className="px-3 py-3 text-right">Số người</th>
            <th scope="col" className="px-3 py-3">Ngày bắt đầu</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, index) => (
            <tr key={`${row.business_date}-${row.first_work_date}-${index}`}>
              <td className="px-3 py-3 font-mono text-xs">{row.business_date}</td>
              <td className="px-3 py-3">{row.project_display}</td>
              <td className="px-3 py-3">{row.recruiter_display}</td>
              <td className="px-3 py-3">{row.provider_type_display}</td>
              <td className="px-3 py-3">{row.employment_type_display}</td>
              <td className="px-3 py-3 text-right font-mono">{row.recruited_count}</td>
              <td className="px-3 py-3 font-mono text-xs">{row.first_work_date}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TeamReportingPanel({
  data,
  optionsResult,
}: {
  data: ReportingData;
  optionsResult: ReportingOptionsResult;
}) {
  const [queryFilters] = useQueryStates(filterParsers, { shallow: false, scroll: false });
  const querySignature = filtersSignature(queryFilters as QueryFilters);
  return <TeamReportingPanelContent key={querySignature} data={data} optionsResult={optionsResult} querySignature={querySignature} />;
}

function TeamReportingPanelContent({
  data,
  optionsResult,
  querySignature,
}: {
  data: ReportingData;
  optionsResult: ReportingOptionsResult;
  querySignature: string;
}) {
  const dataSignature = dataFiltersSignature(data);
  const authoritative = querySignature === dataSignature && data.applied.source === undefined;
  const buckets = useMemo(() => sortBuckets(data.byTeam), [data.byTeam]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [rows, setRows] = useState<TeamDrillDownRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [legacyAggregate, setLegacyAggregate] = useState<TeamDrillDownEnvelope["legacy_aggregate_total"]>(null);
  const [drillState, setDrillState] = useState<DrillState>("idle");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const lastRequest = useRef<LastRequest | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  async function loadPage(bucketKey: string, cursor: string | null, append: boolean): Promise<void> {
    const currentRequest = ++requestId.current;
    controller.current?.abort();
    const currentController = new AbortController();
    controller.current = currentController;
    lastRequest.current = { bucketKey, cursor, append };
    setError(null);
    if (append) setLoadingMore(true);
    else {
      setDrillState("loading");
      setRows([]);
      setNextCursor(null);
      setLegacyAggregate(null);
    }
    try {
      const response = await fetch(drillDownUrl(data, bucketKey, cursor), {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: currentController.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (currentRequest !== requestId.current) return;
      if (!response.ok || !isEnvelope(payload)) {
        setError(failureMessage(response.status, payload));
        setDrillState("error");
        setLoadingMore(false);
        return;
      }
      setRows((previous) => append ? [...previous, ...payload.rows] : payload.rows);
      setNextCursor(payload.nextCursor);
      setLegacyAggregate(payload.legacy_aggregate_total);
      setDrillState("loaded");
      setLoadingMore(false);
    } catch {
      if (currentRequest !== requestId.current || currentController.signal.aborted) return;
      setError("Không tải được chi tiết nhóm. Hãy thử lại.");
      setDrillState("error");
      setLoadingMore(false);
    }
  }

  function selectBucket(bucket: ReportingBucket): void {
    if (!authoritative || drillState === "loading" || loadingMore) return;
    setSelectedKey(bucket.key);
    void loadPage(bucket.key, null, false);
  }

  function retry(): void {
    const request = lastRequest.current;
    if (request) void loadPage(request.bucketKey, request.cursor, request.append);
  }

  const selectedBucket = selectedKey === null ? null : buckets.find((bucket) => bucket.key === selectedKey) ?? null;
  const noAggregate = data.empty.noSources || data.empty.noFacts;

  return (
    <div className="space-y-4">
      <FiltersOrError optionsResult={optionsResult} />
      {!authoritative ? (
        <Alert tone="info" role="status" title="Đang tải dữ liệu theo nhóm">
          Dữ liệu theo nhóm đang được tải lại theo đúng bộ lọc hiện tại.
        </Alert>
      ) : noAggregate ? (
        <EmptyState title="Chưa có dữ liệu tuyển dụng theo nhóm" description="Hiện chưa có dữ liệu để hiển thị." />
      ) : data.empty.noMatches ? (
        <NoMatchesBlock detail="Không có nhóm nào khớp bộ lọc đang chọn." />
      ) : buckets.length === 0 ? (
        <EmptyState title="Chưa có nhóm trong dữ liệu báo cáo" description="Hãy thử lại sau khi dữ liệu được đồng bộ." />
      ) : (
        <>
          <Card>
            <CardHeader title="Tuyển dụng theo nhóm" description="Chọn một nhóm để xem các dòng chi tiết đã được máy chủ làm sạch." />
            <TeamBucketChart buckets={buckets} />
            <div className="mt-5 border-t border-border pt-4">
              <h3 className="text-sm font-semibold text-foreground">Danh sách nhóm</h3>
              <ul aria-label="Danh sách nhóm báo cáo" className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {buckets.map((bucket) => (
                  <li key={bucket.key}>
                    <button
                      type="button"
                      aria-pressed={selectedKey === bucket.key}
                      disabled={drillState === "loading" || loadingMore}
                      onClick={() => selectBucket(bucket)}
                      className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 ${selectedKey === bucket.key
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border bg-surface text-foreground hover:bg-muted/10"}`}
                    >
                      <span className="min-w-0 break-words">{bucket.display}</span>
                      <span className="shrink-0 font-mono">{bucket.recruitedCount}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </Card>

          {selectedBucket ? (
            <Card>
              {selectedKey === UNKNOWN_TEAM_BUCKET_KEY ? (
                <div className="space-y-4">
                  {legacyAggregate ? (
                    <section aria-label="Tổng hợp dữ liệu cũ">
                      <CardHeader title="Tổng hợp từ dữ liệu cũ (tổng hợp theo ngày, không phải entry-level)" description="Tổng này không phải danh sách các dòng chi tiết." />
                      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                        <div><dt className="text-muted">Số người</dt><dd className="font-semibold text-foreground">{legacyAggregate.recruited_count}</dd></div>
                        <div><dt className="text-muted">Từ ngày</dt><dd className="font-mono text-foreground">{legacyAggregate.from ?? "—"}</dd></div>
                        <div><dt className="text-muted">Đến ngày</dt><dd className="font-mono text-foreground">{legacyAggregate.to ?? "—"}</dd></div>
                      </dl>
                    </section>
                  ) : null}
                  <section aria-label="Anomaly Direct Entry">
                    <CardHeader title="Anomaly Direct Entry (không gán được team)" description="Các dòng Direct Entry không xác định được nhóm." />
                    <DrillDownBody state={drillState} error={error} rows={rows} caption="Các dòng Direct Entry không gán được nhóm" onRetry={retry} />
                  </section>
                </div>
              ) : (
                <section aria-label={`Chi tiết nhóm ${selectedBucket.display}`}>
                  <CardHeader title={`Chi tiết nhóm ${selectedBucket.display}`} />
                  <DrillDownBody state={drillState} error={error} rows={rows} caption={`Chi tiết tuyển dụng nhóm ${selectedBucket.display}`} onRetry={retry} />
                </section>
              )}
              {drillState === "loaded" && rows.length > 0 && nextCursor !== null ? (
                <button type="button" disabled={loadingMore} onClick={() => void loadPage(selectedBucket.key, nextCursor, true)}
                  className="mt-4 min-h-11 rounded-md border border-border px-4 text-sm font-medium disabled:opacity-50">
                  {loadingMore ? "Đang tải thêm…" : "Tải thêm"}
                </button>
              ) : null}
              {drillState === "loaded" && rows.length > 0 && nextCursor === null ? (
                <p role="status" className="mt-3 text-sm text-muted">Đã hiển thị hết kết quả.</p>
              ) : null}
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

function DrillDownBody({
  state,
  error,
  rows,
  caption,
  onRetry,
}: {
  state: DrillState;
  error: string | null;
  rows: TeamDrillDownRow[];
  caption: string;
  onRetry(): void;
}) {
  if (state === "loading") return <p role="status">Đang tải chi tiết nhóm…</p>;
  if (state === "error") {
    return (
      <Alert tone="error" role="alert" title="Không tải được chi tiết nhóm">
        <p>{error ?? "Hãy thử lại."}</p>
        <button type="button" onClick={onRetry} className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium">Thử tải lại</button>
      </Alert>
    );
  }
  if (state === "loaded" && rows.length === 0) return <p role="status">Chưa có dòng chi tiết trong bộ lọc hiện tại.</p>;
  if (state !== "loaded") return <p role="status">Chọn một nhóm để xem chi tiết.</p>;
  return <DetailTable rows={rows} caption={caption} />;
}
