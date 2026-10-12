"use client";

import { useEffect, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import {
  buildDuplicateCccdReportQuery,
  employmentStatusLabel,
  maskedCccd,
  projectDuplicateCccdReportResponse,
  DUPLICATE_CCCD_REPORT_DEFAULT_PAGE_SIZE,
  DUPLICATE_CCCD_REPORT_PAGE_SIZE_OPTIONS as PAGE_SIZE_OPTIONS,
} from "@/lib/direct-entry/duplicate-cccd-report-contract";
import type {
  DuplicateCccdReportGroup,
  DuplicateCccdReportPage,
} from "@/lib/direct-entry/duplicate-cccd-report-contract";

type ReportState =
  | { kind: "loading" }
  | { kind: "loaded"; page: DuplicateCccdReportPage }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "error" };

const button = "inline-flex min-h-10 items-center justify-center rounded-md border border-border " +
  "bg-surface px-3 text-sm font-medium text-foreground focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";

function StatusBadge({ status }: { status: DuplicateCccdReportGroup["episodes"][number]["latest_status"] }) {
  const active = status !== "OFF";
  return (
    <span className={active
      ? "inline-flex whitespace-nowrap rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
      : "inline-flex whitespace-nowrap rounded-full bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-900 dark:bg-slate-700 dark:text-slate-100"}>
      {employmentStatusLabel(status)}
    </span>
  );
}

function GroupCard({ group }: { group: DuplicateCccdReportGroup }) {
  const masked = maskedCccd(group.cccd_last4, group.cccd_length);
  return (
    <Card>
      <CardHeader
        title={"CCCD " + masked}
        description={
          group.cccd_length + " chữ số · " + group.profile_count + " hồ sơ · " +
          group.project_count + " dự án · " + group.active_profile_count + " đang hoạt động"
        }
      />
      <p className="mb-3 text-sm text-muted">
        Vào làm sớm nhất: {group.first_work_date ?? "—"} · gần nhất: {group.latest_first_work_date ?? "—"}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left text-sm">
          <caption className="sr-only">
            Các hồ sơ dùng chung số CCCD {masked}
          </caption>
          <thead className="border-b border-border text-xs uppercase text-muted">
            <tr>
              <th scope="col" className="px-3 py-3">Họ tên</th>
              <th scope="col" className="px-3 py-3">Mã nhân viên</th>
              <th scope="col" className="px-3 py-3">Dự án</th>
              <th scope="col" className="px-3 py-3">Ngày vào làm</th>
              <th scope="col" className="px-3 py-3">Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {group.episodes.map((episode, index) => (
              <tr key={index} className="border-b border-border/70 last:border-0">
                <td className="px-3 py-3 font-medium">{episode.display_name ?? "—"}</td>
                <td className="px-3 py-3">{episode.employee_code ?? "—"}</td>
                <td className="px-3 py-3">{episode.project_display ?? "—"}</td>
                <td className="px-3 py-3">{episode.first_work_date ?? "—"}</td>
                <td className="px-3 py-3"><StatusBadge status={episode.latest_status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function DuplicateCccdReportPanel() {
  const [state, setState] = useState<ReportState>({ kind: "loading" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DUPLICATE_CCCD_REPORT_DEFAULT_PAGE_SIZE);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const query = buildDuplicateCccdReportQuery({ page, page_size: pageSize });
      if (!query) {
        setState({ kind: "error" });
        return;
      }
      let response: Response;
      try {
        response = await fetch(`/api/direct-entry/duplicate-cccd-report?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ kind: "unavailable" });
        return;
      }
      if (response.status === 401 || response.status === 403) {
        setState({ kind: "denied" });
        return;
      }
      if (response.status !== 200) {
        setState(response.status === 404 || response.status >= 500
          ? { kind: "unavailable" }
          : { kind: "error" });
        return;
      }
      try {
        const loaded = projectDuplicateCccdReportResponse(await response.json(), {
          page,
          page_size: pageSize,
        });
        if (!loaded) {
          setState({ kind: "error" });
          return;
        }
        const pageCount = Math.min(1000, Math.max(1,
          Math.ceil(loaded.total_groups / Math.max(1, loaded.page_size))));
        if (page > pageCount) {
          setPage(pageCount);
          return;
        }
        setState({ kind: "loaded", page: loaded });
      } catch {
        setState({ kind: "error" });
      }
    })();
    return () => controller.abort();
  }, [page, pageSize, reloadToken]);

  const reload = () => {
    setState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  const loaded = state.kind === "loaded" ? state.page : null;
  const pageCount = loaded
    ? Math.min(1000, Math.max(1, Math.ceil(loaded.total_groups / Math.max(1, loaded.page_size))))
    : 1;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold text-foreground">Báo cáo hồ sơ có CCCD trùng</h1>
        <p className="mt-1 text-sm text-muted">
          Danh sách các hồ sơ trên toàn hệ thống đang dùng chung một số CCCD. Đây là báo cáo
          chỉ xem — không gộp, không sửa và không xóa hồ sơ.
        </p>
      </header>

      <Alert tone="info" title="Chỉ xem">
        <p>
          Số CCCD được che, chỉ hiển thị 4 chữ số cuối. Báo cáo này độc lập với cảnh báo khi gửi
          duyệt hồ sơ.
        </p>
      </Alert>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Số dòng mỗi trang
          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
              setState({ kind: "loading" });
            }}
            className="min-h-10 rounded-md border border-border bg-surface px-3 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </label>
        <button type="button" className={button} onClick={reload}>Tải lại</button>
      </div>

      {state.kind === "loading" ? (
        <p role="status" className="py-8 text-center text-sm text-muted">Đang tải báo cáo CCCD trùng…</p>
      ) : null}

      {state.kind === "denied" ? (
        <ErrorState
          title="Bạn không có quyền xem báo cáo CCCD trùng"
          detail="Báo cáo chỉ dành cho nhóm được cấp quyền với phạm vi toàn hệ thống."
        />
      ) : null}

      {state.kind === "unavailable" ? (
        <div className="space-y-3">
          <ErrorState title="Báo cáo CCCD trùng hiện không khả dụng" />
          <button type="button" className={button} onClick={reload}>Thử tải lại</button>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="space-y-3">
          <ErrorState
            title="Không tải được báo cáo CCCD trùng"
            detail="Phản hồi không hợp lệ. Hãy thử tải lại."
          />
          <button type="button" className={button} onClick={reload}>Thử tải lại</button>
        </div>
      ) : null}

      {loaded ? (
        loaded.groups.length === 0 ? (
          <EmptyState
            title="Không có hồ sơ trùng CCCD"
            description="Hiện chưa có hồ sơ nào dùng chung số CCCD trong phạm vi báo cáo."
          />
        ) : (
          <>
            <p role="status" className="text-sm text-muted">
              {loaded.total_groups} nhóm CCCD trùng · {loaded.total_entries} hồ sơ
            </p>
            <div className="space-y-4">
              {loaded.groups.map((group, index) => (
                <GroupCard key={group.cccd_last4 + "-" + group.cccd_length + "-" + index} group={group} />
              ))}
            </div>
            <nav aria-label="Phân trang báo cáo CCCD trùng"
              className="flex flex-col gap-3 border-t border-border pt-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <p aria-live="polite">Trang {loaded.page} / {pageCount}</p>
              <div className="flex items-center gap-2">
                <button type="button" className={button} disabled={loaded.page <= 1}
                  onClick={() => { setPage((value) => Math.max(1, value - 1)); setState({ kind: "loading" }); }}>
                  Trang trước
                </button>
                <button type="button" className={button} disabled={!loaded.has_more}
                  onClick={() => { setPage((value) => value + 1); setState({ kind: "loading" }); }}>
                  Trang sau
                </button>
              </div>
            </nav>
          </>
        )
      ) : null}
    </div>
  );
}
