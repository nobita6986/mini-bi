"use client";

import { useEffect, useState } from "react";
import * as Dialog from "radix-ui/dialog";

import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import {
  buildGrantRequest,
  buildMappingListQuery,
  buildRevokeRequest,
  classifyMappingResponse,
  newMappingKey,
  type MappingUiOutcome,
} from "@/lib/admin/project-team-scope-ui-model";
import type {
  ProjectTeamScopeMapping,
  ProjectTeamScopeList,
} from "@/lib/admin/project-team-scope-contract";

const button = "inline-flex min-h-10 items-center justify-center rounded-md border border-border bg-surface px-3 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
const primary = "inline-flex min-h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-on-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
const input = "min-h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

type DialogState =
  | { kind: "grant" }
  | { kind: "revoke"; mapping: ProjectTeamScopeMapping }
  | null;

export function ProjectTeamScopeManager() {
  const [list, setList] = useState<ProjectTeamScopeList | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [projectIdFilter, setProjectIdFilter] = useState("");
  const [teamIdFilter, setTeamIdFilter] = useState("");
  const [includeHistory, setIncludeHistory] = useState(false);
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<MappingUiOutcome | null>(null);
  const [grantProjectId, setGrantProjectId] = useState("");
  const [grantTeamId, setGrantTeamId] = useState("");
  const [grantPairVersion, setGrantPairVersion] = useState("0");
  const [grantEffectiveFrom, setGrantEffectiveFrom] = useState("");
  const [revokeEffectiveTo, setRevokeEffectiveTo] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    const query = buildMappingListQuery({ projectId: projectIdFilter, teamId: teamIdFilter, includeHistory, page });
    if (!query) return;
    const controller = new AbortController();
    void (async () => {
      setState("loading");
      try {
        const response = await fetch(`/api/admin/catalog/project-team-scopes?${query.toString()}`, {
          method: "GET", cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" },
        });
        if (response.status === 401 || response.status === 403) { setState("denied"); return; }
        if (response.status !== 200) { setState("error"); return; }
        const data = await response.json();
        if (data && typeof data === "object" && "list" in data) {
          setList((data as { list: ProjectTeamScopeList }).list);
          setState("ready");
        } else setState("error");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState("error");
      }
    })();
    return () => controller.abort();
  }, [includeHistory, page, projectIdFilter, reloadToken, teamIdFilter]);

  const reloadList = () => { setState("loading"); setReloadToken((v) => v + 1); };

  async function submitDialog() {
    setFormError(null);
    setNotice(null);
    if (!dialog) return;
    const key = newMappingKey();
    const request = dialog.kind === "grant"
      ? buildGrantRequest({ projectId: grantProjectId, teamId: grantTeamId,
        expectedPairVersion: /^(0|[1-9]\d*)$/.test(grantPairVersion) ? Number(grantPairVersion) : Number.NaN,
        effectiveFrom: grantEffectiveFrom, reason, idempotencyKey: key })
      : buildRevokeRequest({ mappingId: dialog.mapping.mapping_id, expectedPairVersion: dialog.mapping.version, effectiveTo: revokeEffectiveTo, reason, idempotencyKey: key });
    if (!request.ok) { setFormError(request.message); return; }
    const url = dialog.kind === "grant" ? "/api/admin/catalog/project-team-scopes" : `/api/admin/catalog/project-team-scopes/${encodeURIComponent(dialog.mapping.mapping_id)}/revoke`;
    setBusy(true);
    try {
      const response = await fetch(url, {
        method: "POST", cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(request.body),
      });
      const outcome = classifyMappingResponse(response.status);
      setBusy(false);
      setNotice(outcome);
      if (outcome.kind === "applied") { setDialog(null); reloadList(); }
      else setFormError(outcome.message);
    } catch {
      setBusy(false);
      setFormError("Không nhận được phản hồi. Có thể thử lại.");
    }
  }

  const mappings = list?.mappings ?? [];
  const pageCount = list ? Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size))) : 1;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">Mapping Dự án ↔ Nhóm</h1>
        <p className="mt-1 text-sm text-muted">Cấp và thu hồi mapping Project↔Team. Chỉ Full Admin.</p>
      </header>

      {notice ? <Alert tone={notice.kind === "applied" ? "info" : "warning"} title="Trạng thái thao tác">{notice.message}</Alert> : null}

      <Card>
        <CardHeader title="Danh sách mapping" description={list ? `${list.total} mapping` : "Lọc theo project ID hoặc xem lịch sử."} />
        <form className="mb-4 flex flex-wrap gap-3 items-end" onSubmit={(e) => { e.preventDefault(); setPage(1); reloadList(); }}>
          <label className="flex flex-col gap-1 text-sm font-medium flex-1">Project ID
            <input value={projectIdFilter} maxLength={128} onChange={(e) => setProjectIdFilter(e.target.value)} className={input} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">Team ID
            <input value={teamIdFilter} maxLength={36} onChange={(e) => setTeamIdFilter(e.target.value)} className={input} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeHistory} onChange={(e) => { setIncludeHistory(e.target.checked); setPage(1); reloadList(); }} className="size-4 accent-primary" />
            Bao gồm lịch sử
          </label>
          <button type="submit" className={button}>Lọc</button>
          <button type="button" className={primary} onClick={() => { setReason(""); setGrantPairVersion("0"); setFormError(null); setDialog({ kind: "grant" }); }}>Cấp mapping</button>
        </form>

        {state === "loading" ? <p role="status" className="py-8 text-center text-sm text-muted">Đang tải…</p> : null}
        {state === "denied" ? <Alert tone="error" title="Không có quyền">Chỉ Full Admin được xem mapping.</Alert> : null}
        {state === "error" ? <ErrorState title="Không tải được danh sách mapping" /> : null}
        {state === "ready" && mappings.length === 0 ? <EmptyState title="Chưa có mapping nào" /> : null}
        {state === "ready" && mappings.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead><tr className="border-b">
                <th scope="col" className="px-3 py-3 font-semibold">Dự án</th>
                <th scope="col" className="px-3 py-3 font-semibold">Nhóm</th>
                <th scope="col" className="px-3 py-3 font-semibold">Hiệu lực</th>
                <th scope="col" className="px-3 py-3 font-semibold">Trạng thái</th>
                <th scope="col" className="px-3 py-3 font-semibold">Phiên bản cặp</th>
                <th scope="col" className="px-3 py-3 text-right">Thao tác</th>
              </tr></thead>
              <tbody>
                {mappings.map((m) => (
                  <tr key={m.mapping_id} className="border-b last:border-0">
                    <td className="px-3 py-3 font-medium">{m.project_display_name}</td>
                    <td className="px-3 py-3">{m.team_display_name} ({m.team_code})</td>
                    <td className="px-3 py-3">{m.valid_from} → {m.valid_to ?? "∞"}</td>
                    <td className="px-3 py-3">{m.state}</td>
                    <td className="px-3 py-3">{m.version}</td>
                    <td className="px-3 py-3 text-right">
                      {m.valid_to === null ? (
                        <button type="button" className={button} disabled={busy}
                          onClick={() => { setRevokeEffectiveTo(""); setReason(""); setFormError(null); setDialog({ kind: "revoke", mapping: m }); }}>
                          Thu hồi
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {state === "ready" && list && list.total > 0 ? (
          <div className="mt-3 flex gap-2 items-center text-sm text-muted">
            <button type="button" className={button} disabled={page <= 1} onClick={() => { setPage((v) => Math.max(1, v - 1)); reloadList(); }}>Trang trước</button>
            <span>Trang {page} / {pageCount}</span>
            <button type="button" className={button} disabled={!list.has_more} onClick={() => { setPage((v) => Math.min(1000, v + 1)); reloadList(); }}>Trang sau</button>
          </div>
        ) : null}
      </Card>

      <Dialog.Root open={dialog !== null} onOpenChange={(open) => { if (!open && !busy) setDialog(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-xl focus:outline-none sm:p-6" aria-describedby="mapping-dialog-desc">
            <div className="flex items-start justify-between gap-4">
              <Dialog.Title className="text-xl font-semibold text-foreground">
                {dialog?.kind === "grant" ? "Cấp mapping Dự án ↔ Nhóm" : "Thu hồi mapping Dự án ↔ Nhóm"}
              </Dialog.Title>
              <Dialog.Close asChild><button type="button" aria-label="Đóng" disabled={busy} className={button}>×</button></Dialog.Close>
            </div>
            <Dialog.Description id="mapping-dialog-desc" className="mt-1 text-sm text-muted">Mọi thay đổi cần lý do và có audit.</Dialog.Description>
            <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); void submitDialog(); }}>
              {dialog?.kind === "grant" ? (
                <>
                  <label className="flex flex-col gap-1 text-sm font-medium">Project ID
                    <input value={grantProjectId} maxLength={128} required onChange={(e) => setGrantProjectId(e.target.value)} className={input} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-medium">Team ID (UUID)
                    <input value={grantTeamId} maxLength={64} required onChange={(e) => setGrantTeamId(e.target.value)} className={input} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-medium">Phiên bản cặp mapping
                    <input type="number" min="0" step="1" value={grantPairVersion} required
                      onChange={(e) => setGrantPairVersion(e.target.value)} className={input} />
                    <span className="text-xs text-muted">Dùng 0 nếu cặp này chưa từng được cấp; nếu đã có lịch sử, lọc theo Project ID + Team ID, bật lịch sử và nhập version mới nhất.</span>
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-medium">Ngày hiệu lực
                    <input type="date" value={grantEffectiveFrom} onChange={(e) => setGrantEffectiveFrom(e.target.value)} className={input} />
                  </label>
                </>
              ) : dialog ? (
                <>
                  <p>Bạn sắp thu hồi mapping <strong>{dialog.mapping.project_display_name}</strong> ↔ <strong>{dialog.mapping.team_display_name}</strong> (version {dialog.mapping.version}).</p>
                  <label className="flex flex-col gap-1 text-sm font-medium">Ngày kết thúc (để trống = hôm nay)
                    <input type="date" value={revokeEffectiveTo} onChange={(e) => setRevokeEffectiveTo(e.target.value)} className={input} />
                  </label>
                </>
              ) : null}
              <label className="flex flex-col gap-1 text-sm font-medium">Lý do
                <textarea value={reason} maxLength={4000} required rows={3} onChange={(e) => { setReason(e.target.value); setFormError(null); }} className={input} />
              </label>
              {formError ? <p role="alert" className="text-sm text-red-700">{formError}</p> : null}
              <div className="flex justify-end gap-2">
                <Dialog.Close asChild><button type="button" disabled={busy} className={button}>Hủy</button></Dialog.Close>
                <button type="submit" disabled={busy} className={primary}>{busy ? "Đang lưu…" : dialog?.kind === "grant" ? "Cấp mapping" : "Xác nhận thu hồi"}</button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
