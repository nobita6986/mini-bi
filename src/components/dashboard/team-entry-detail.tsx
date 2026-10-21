"use client";

import { useRef, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { UNKNOWN_TEAM_BUCKET_KEY, type ReportingData } from "@/lib/reporting/p1-reporting";
import type { TeamReportDetail, TeamReportRow } from "@/lib/reporting/p3-w06d-team-report-server";

import { teamReportUrl } from "./team-report-request";

/**
 * P3-W06D-R2 - shared entry-level detail tail of the team report.
 *
 * Rendered once, at the END of the report, for the SELECTED team. The first
 * page arrives with the report from the parent (one authorized request); this
 * component only pages further ("Tải thêm") through the same endpoint and never
 * re-derives any aggregate from the rows. The parent remounts it (keyed by the
 * selection + filter signature) whenever the team or the DB-applied filters
 * change, so stale rows never survive a change.
 */

function failureMessage(status: number, payload: unknown): string {
  const code = typeof payload === "object" && payload !== null && "code" in payload
    ? (payload as { code?: unknown }).code
    : null;
  if (status === 400 || code === "INVALID_FILTER") return "Bộ lọc báo cáo theo nhóm không hợp lệ.";
  if (status === 401) return "Phiên đăng nhập không còn hiệu lực.";
  if (status === 403) return "Bạn không có quyền xem báo cáo của nhóm này.";
  return "Không tải được chi tiết nhóm. Hãy thử lại.";
}

function isDetailEnvelope(value: unknown): value is { detail: TeamReportDetail } {
  if (typeof value !== "object" || value === null) return false;
  const detail = (value as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return false;
  const d = detail as Partial<TeamReportDetail>;
  return Array.isArray(d.rows)
    && (typeof d.nextCursor === "string" || d.nextCursor === null)
    && typeof d.total === "number";
}

function DetailTable({ rows, caption }: { rows: TeamReportRow[]; caption: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="r22-report-table w-full min-w-[760px] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-surface-muted text-xs uppercase tracking-wide text-muted">
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
            <tr key={`${row.business_date}-${row.first_work_date}-${index}`} className="hover:bg-surface-hover">
              <td className="px-3 py-3 font-mono tabular-nums whitespace-nowrap text-xs">{row.business_date}</td>
              <td className="px-3 py-3">{row.project_display}</td>
              <td className="px-3 py-3">{row.recruiter_display}</td>
              <td className="px-3 py-3">{row.provider_type_display}</td>
              <td className="px-3 py-3">{row.employment_type_display}</td>
              <td className="px-3 py-3 text-right font-mono tabular-nums whitespace-nowrap">{row.recruited_count}</td>
              <td className="px-3 py-3 font-mono tabular-nums whitespace-nowrap text-xs">{row.first_work_date}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TeamEntryDetail({
  data,
  bucket,
  initialDetail,
}: {
  data: ReportingData;
  bucket: { key: string; display: string };
  initialDetail: TeamReportDetail;
}) {
  const [rows, setRows] = useState<TeamReportRow[]>(initialDetail.rows);
  const [nextCursor, setNextCursor] = useState<string | null>(initialDetail.nextCursor);
  const [legacyAggregate, setLegacyAggregate] = useState(initialDetail.legacy_aggregate_total);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);

  async function loadMore(): Promise<void> {
    if (nextCursor === null || loadingMore) return;
    const currentRequest = ++requestId.current;
    controller.current?.abort();
    const currentController = new AbortController();
    controller.current = currentController;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await fetch(teamReportUrl(data, bucket.key, nextCursor), {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: currentController.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (currentRequest !== requestId.current) return;
      if (!response.ok || !isDetailEnvelope(payload)) {
        setError(failureMessage(response.status, payload));
        setLoadingMore(false);
        return;
      }
      setRows((previous) => [...previous, ...payload.detail.rows]);
      setNextCursor(payload.detail.nextCursor);
      if (payload.detail.legacy_aggregate_total) setLegacyAggregate(payload.detail.legacy_aggregate_total);
      setLoadingMore(false);
    } catch {
      if (currentRequest !== requestId.current || currentController.signal.aborted) return;
      setError("Không tải được chi tiết nhóm. Hãy thử lại.");
      setLoadingMore(false);
    }
  }

  const caption = "Chi tiết tuyển dụng nhóm " + bucket.display;
  const isUnknown = bucket.key === UNKNOWN_TEAM_BUCKET_KEY;

  return (
    <Card>
      {isUnknown ? (
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
            <DetailBody rows={rows} error={error} caption={caption} onRetry={loadMore} />
          </section>
        </div>
      ) : (
        <section aria-label={`Chi tiết nhóm ${bucket.display}`}>
          <CardHeader title={`Chi tiết nhóm ${bucket.display}`} />
          <DetailBody rows={rows} error={error} caption={caption} onRetry={loadMore} />
        </section>
      )}

      {error === null && nextCursor !== null && rows.length > 0 ? (
        <button type="button" disabled={loadingMore} onClick={() => void loadMore()}
          className="mt-4 min-h-11 rounded-md border border-border px-4 text-sm font-medium disabled:opacity-50">
          {loadingMore ? "Đang tải thêm…" : "Tải thêm"}
        </button>
      ) : null}
      {error === null && nextCursor === null && rows.length > 0 ? (
        <p role="status" className="mt-3 text-sm text-muted">Đã hiển thị hết kết quả.</p>
      ) : null}
    </Card>
  );
}

function DetailBody({
  rows,
  error,
  caption,
  onRetry,
}: {
  rows: TeamReportRow[];
  error: string | null;
  caption: string;
  onRetry(): void;
}) {
  if (error !== null) {
    return (
      <Alert tone="error" role="alert" title="Không tải được chi tiết nhóm">
        <p>{error}</p>
        <button type="button" onClick={onRetry} className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium">Thử tải lại</button>
      </Alert>
    );
  }
  if (rows.length === 0) return <p role="status">Chưa có dòng chi tiết trong bộ lọc hiện tại.</p>;
  return <DetailTable rows={rows} caption={caption} />;
}
