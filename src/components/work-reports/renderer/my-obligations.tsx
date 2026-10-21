"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";
import { WorkReportFormRenderer, type WorkReportRendererDetail } from "./work-report-form-renderer";

type Obligation = {
  obligation_id: string; template_name: string; period_key: string; period_start_date: string; period_end_date: string;
  due_at: string; obligation_status: string; submission_state: string; submission_version: number | null;
};

export function MyObligations({ history = false }: { history?: boolean }) {
  const [items, setItems] = useState<Obligation[]>([]);
  const [selected, setSelected] = useState<{ detail: WorkReportRendererDetail; periodStart: string; periodEnd: string } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/work-reports/obligations", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result?.ok || !Array.isArray(result.data)) throw new Error("unavailable");
      setItems(result.data); setError(null);
    } catch { setError("Không tải được danh sách báo cáo. Vui lòng tải lại trang."); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/work-reports/obligations", { cache: "no-store" }).then(async (response) => {
      const result = await response.json();
      if (!response.ok || !result?.ok || !Array.isArray(result.data)) throw new Error("unavailable");
      if (active) { setItems(result.data); setError(null); }
    }).catch(() => { if (active) setError("Không tải được danh sách báo cáo. Vui lòng tải lại trang."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  async function open(item: Obligation) {
    setSelected(null); setError(null);
    try {
      const response = await fetch(`/api/work-reports/obligations/${item.obligation_id}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result?.ok || !result.data) throw new Error("unavailable");
      setSelected({ detail: result.data, periodStart: item.period_start_date, periodEnd: item.period_end_date });
    } catch { setError("Không tải được nội dung báo cáo. Hãy kiểm tra quyền truy cập hoặc thử lại."); }
  }

  const visibleItems = items.filter((item) => history
    ? item.submission_state !== "NOT_STARTED"
    : item.obligation_status === "ACTIVE");

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted">{history ? "Các báo cáo đã lưu hoặc nộp." : "Nghĩa vụ báo cáo được giao cho tài khoản của bạn."}</p>
      <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={busy}>{busy ? "Đang tải…" : "Tải lại"}</Button>
    </div>
    {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
    {busy && items.length === 0 ? <p role="status" className="text-sm text-muted">Đang tải nghĩa vụ báo cáo…</p> : null}
    {!busy && visibleItems.length === 0 ? <StatusBanner>Không có báo cáo nào trong danh sách này.</StatusBanner> : null}
    <ul className="divide-y divide-border rounded-xl border border-border">
      {visibleItems.map((item) => <li key={item.obligation_id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div><p className="font-medium">{item.template_name}</p><p className="mt-1 text-sm text-muted">Kỳ {item.period_key} · Hạn {new Date(item.due_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</p>
          <p className="mt-1 text-xs text-muted">{item.submission_state === "NOT_STARTED" ? "Chưa bắt đầu" : item.submission_state}</p></div>
        <Button variant="outline" size="sm" onClick={() => void open(item)}>{history ? "Xem lịch sử" : item.submission_state === "NOT_STARTED" ? "Bắt đầu" : "Mở báo cáo"}</Button>
      </li>)}
    </ul>
    {selected ? <div className="rounded-xl border border-border bg-surface p-4 sm:p-6">
      <div className="mb-5 flex justify-end"><Button variant="ghost" size="sm" onClick={() => setSelected(null)}>Đóng</Button></div>
      <WorkReportFormRenderer key={selected.detail.obligation.obligation_id} detail={{ ...selected.detail,
        obligation: { ...selected.detail.obligation, period_start_date: selected.periodStart, period_end_date: selected.periodEnd } }}
        onSaved={() => { void refresh(); const item = items.find((candidate) => candidate.obligation_id === selected.detail.obligation.obligation_id);
          if (item) void open(item); }} />
    </div> : null}
  </div>;
}
