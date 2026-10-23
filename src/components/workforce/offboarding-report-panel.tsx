"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CursorLoadMore } from "@/components/ui/cursor-load-more";
import { DataTableContainer, DATA_TABLE_CLASS, DATA_TABLE_HEAD_CLASS, DATA_TABLE_ROW_CLASS, DATA_TABLE_TD_CLASS, DATA_TABLE_TH_CLASS } from "@/components/ui/data-table";
import { StatusBanner } from "@/components/ui/status-banner";
import type { OffboardingReportItem } from "@/lib/workforce/offboarding-report-contract";

type View = "loading" | "ready" | "denied" | "error";

type List = {
  scope: "all" | "team";
  can_export: boolean;
  total: number;
  has_more: boolean;
  items: OffboardingReportItem[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function parseList(body: unknown): List | null {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.data)) return null;
  const d = body.data;
  if (
    (d.scope !== "all" && d.scope !== "team") ||
    typeof d.can_export !== "boolean" ||
    !Array.isArray(d.items) ||
    typeof d.total !== "number" ||
    typeof d.has_more !== "boolean"
  ) return null;
  return {
    scope: d.scope as "all" | "team",
    can_export: d.can_export,
    total: d.total as number,
    has_more: d.has_more as boolean,
    items: d.items as OffboardingReportItem[],
  };
}

const PAGE_SIZE = 25;

export function OffboardingReportPanel() {
  const [view, setView] = useState<View>("loading");
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<List | null>(null);
  const [items, setItems] = useState<OffboardingReportItem[]>([]);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);

  async function fetchPage(nextPage: number, append: boolean) {
    const gen = ++generation.current;
    try {
      const response = await fetch(`/api/workforce/offboarding?page=${nextPage}&page_size=${PAGE_SIZE}`, {
        cache: "no-store", headers: { accept: "application/json" },
      });
      if (response.status === 403) {
        if (gen === generation.current) { setView("denied"); setError(null); }
        return;
      }
      const body = await response.json().catch(() => null);
      const parsed = response.ok ? parseList(body) : null;
      if (gen !== generation.current) return;
      if (!parsed) {
        setView("error");
        setError("Không tải được báo cáo người lao động nghỉ việc.");
        return;
      }
      setList(parsed);
      setItems((current) => append ? [...current, ...parsed.items] : parsed.items);
      setView("ready");
      setError(null);
    } catch {
      if (gen !== generation.current) return;
      setView("error");
      setError("Không tải được báo cáo người lao động nghỉ việc.");
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => { void fetchPage(1, false); }, 0);
    return () => { clearTimeout(timer); generation.current += 1; };
  }, []);

  async function loadMore() {
    const next = page + 1;
    setLoadingMore(true);
    await fetchPage(next, true);
    setPage(next);
    setLoadingMore(false);
  }

  const canPhone = list?.scope === "all";

  return (
    <div className="space-y-4">
      {view === "loading" ? <p role="status" className="py-8 text-center text-sm text-muted">Đang tải báo cáo…</p> : null}
      {view === "denied" ? <StatusBanner tone="warning">Bạn không có quyền xem báo cáo người lao động nghỉ việc.</StatusBanner> : null}
      {view === "error" ? <StatusBanner tone="error">{error ?? "Không tải được báo cáo."}</StatusBanner> : null}
      {view === "ready" && items.length === 0 ? <StatusBanner>Chưa có người lao động nghỉ việc đủ 3 ngày trong phạm vi hiện tại.</StatusBanner> : null}

      {view === "ready" && items.length > 0 ? (
        <DataTableContainer
          scrollClassName="overflow-x-auto"
          footer={
            list?.can_export ? (
              <div className="flex justify-end">
                <a href="/api/workforce/offboarding/export">
                  <Button variant="secondary">Xuất Excel</Button>
                </a>
              </div>
            ) : null
          }
        >
          <table className={DATA_TABLE_CLASS + " min-w-[820px]"}>
            <thead className={DATA_TABLE_HEAD_CLASS}>
              <tr>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Họ tên</th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Mã NLĐ</th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Dự án / công việc cuối</th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Người tuyển cuối</th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Ngày nghỉ việc</th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>Số ngày đã nghỉ</th>
                {canPhone ? <th scope="col" className={DATA_TABLE_TH_CLASS}>Số điện thoại</th> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.employee_code} className={DATA_TABLE_ROW_CLASS}>
                  <td className={DATA_TABLE_TD_CLASS} data-card-header="true">{item.display_name}</td>
                  <td className={DATA_TABLE_TD_CLASS + " font-mono tabular-nums"} data-label="Mã NLĐ">{item.employee_code}</td>
                  <td className={DATA_TABLE_TD_CLASS} data-label="Dự án cuối">{item.project_display}</td>
                  <td className={DATA_TABLE_TD_CLASS} data-label="Người tuyển cuối">{item.recruiter_display}</td>
                  <td className={DATA_TABLE_TD_CLASS + " whitespace-nowrap"} data-label="Ngày nghỉ">{item.off_effective_date}</td>
                  <td className={DATA_TABLE_TD_CLASS + " font-mono tabular-nums"} data-label="Số ngày đã nghỉ">{item.days_since_off}</td>
                  {canPhone ? <td className={DATA_TABLE_TD_CLASS} data-label="Số điện thoại">{item.phone ?? "—"}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </DataTableContainer>
      ) : null}

      {view === "ready" && list?.has_more ? (
        <div className="flex justify-center">
          <CursorLoadMore hasMore loading={loadingMore} onLoadMore={() => void loadMore()} />
        </div>
      ) : null}
    </div>
  );
}
