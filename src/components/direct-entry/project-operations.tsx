"use client";

/**
 * P2.5-W06A - Project Operations UI.
 *
 * Nguyen tac:
 * - Server response/RPC la nguon duy nhat ve quyen: UI chi hien/disable (UX),
 *   KHONG suy dien quyen tu role/email/recruiter/team/created_by.
 * - Client khong bao gio gui actor/capability/scope/role.
 * - Moi thao tac thay doi deu BAT BUOC co ly do.
 * - Moi mutation deu gui dung version (OCC). Xung dot 409 => bat buoc tai lai,
 *   KHONG ghi de ngam.
 */

import { useCallback, useEffect, useId, useState } from "react";
import { Dialog } from "radix-ui";

import { AccessDenied } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import {
  buildAssignRequest,
  buildCreateRequest,
  buildRenameRequest,
  buildSetActiveRequest,
  buildUnassignRequest,
  classifyResponse,
  mutationProjectVersion,
  newIdempotencyKey,
  parseDetailResponse,
  parseListResponse,
  projectStatusLabel,
  splitAssignments,
  validatePendingAssignments,
  type AssignmentView,
  type Outcome,
  type PendingAssignment,
  type ProjectDetailView,
  type ProjectView,
  type RequestResult,
} from "@/lib/direct-entry/project-operations-model";

const API = "/api/direct-entry/projects";

type ViewState = "loading" | "ready" | "empty" | "denied" | "unavailable" | "error";

type DialogState =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "rename" }
  | { kind: "set-active"; active: boolean }
  | { kind: "assign" }
  | { kind: "unassign"; assignment: AssignmentView };

const buttonClass =
  "inline-flex h-10 items-center justify-center rounded-md border border-input px-3 text-sm " +
  "font-medium focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50";
const primaryClass =
  "inline-flex h-10 items-center justify-center rounded-md bg-primary px-3 text-sm " +
  "font-medium text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring/40 " +
  "disabled:opacity-50";
const inputClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";

function Field({
  id, label, hint, children,
}: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

type ListResult = { status: number; payload: unknown };

/** Goi API list (module-level: effect chi cam ket promise, khong cham setState). */
async function fetchProjectList(): Promise<ListResult> {
  const response = await fetch(API + "?include_inactive=true", {
    headers: { accept: "application/json" },
  });
  return { status: response.status, payload: await readJson(response) };
}

export function ProjectOperations() {
  const [state, setState] = useState<ViewState>("loading");
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [detail, setDetail] = useState<ProjectDetailView | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [pending, setPending] = useState<PendingAssignment[]>([]);
  const [managerId, setManagerId] = useState("");
  const [validFrom, setValidFrom] = useState("");

  /**
   * Ap ket qua list vao state. Chi duoc goi tu callback BAT DONG BO
   * (promise then/catch) hoac tu event handler — khong goi dong bo trong effect.
   */
  const applyListResult = useCallback((result: ListResult) => {
    if (result.status === 403) { setState("denied"); return; }
    if (result.status >= 500) { setState("unavailable"); return; }
    const parsed = parseListResponse(result.payload);
    if (result.status !== 200 || parsed === null) { setState("error"); return; }
    setProjects(parsed);
    setState(parsed.length === 0 ? "empty" : "ready");
  }, []);

  /** Nap lai danh sach theo yeu cau nguoi dung / sau mutation. */
  const loadList = useCallback(async () => {
    try {
      applyListResult(await fetchProjectList());
    } catch {
      setState("unavailable");
    }
  }, [applyListResult]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const response = await fetch(API + "/" + encodeURIComponent(id), {
        headers: { accept: "application/json" },
      });
      if (response.status !== 200) { setDetail(null); return; }
      setDetail(parseDetailResponse(await readJson(response)));
    } catch {
      setDetail(null);
    }
  }, []);

  // Nap lan dau: state chi duoc cap nhat trong callback cua promise (khong
  // setState dong bo trong effect body).
  useEffect(() => {
    let active = true;
    fetchProjectList().then(
      (result) => { if (active) applyListResult(result); },
      () => { if (active) setState("unavailable"); },
    );
    return () => { active = false; };
  }, [applyListResult]);

  const closeDialog = useCallback(() => {
    setDialog({ kind: "none" });
    setReason("");
    setDisplayName("");
    setProjectId("");
    setPending([]);
    setManagerId("");
    setValidFrom("");
  }, []);

  /** Tai lai day du sau xung dot: khong ghi de ngam bat ky thay doi cuc bo nao. */
  const reloadAfterConflict = useCallback(async () => {
    setConflict(null);
    if (detail) await loadDetail(detail.project_id);
    await loadList();
  }, [detail, loadDetail, loadList]);

  const applyOutcome = useCallback((outcome: Outcome): boolean => {
    if (outcome.kind === "applied") return true;
    if (outcome.kind === "reload-required") { setConflict(outcome.message); return false; }
    if (outcome.kind === "denied") {
      setNotice(outcome.message);
      return false;
    }
    setNotice(outcome.message);
    return false;
  }, []);

  async function send(
    url: string, method: "POST" | "PATCH", request: RequestResult, key: string,
  ): Promise<{ outcome: Outcome; payload: unknown }> {
    if (!request.ok) {
      const outcome: Outcome = { kind: "invalid", message: request.message };
      return { outcome, payload: null };
    }
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(request.body),
    });
    const payload = await readJson(response);
    return { outcome: classifyResponse(response.status, payload), payload };
  }

  async function afterSuccess(projectIdToRefresh: string | null) {
    if (projectIdToRefresh) await loadDetail(projectIdToRefresh);
    await loadList();
  }

  async function submitCreate() {
    const key = newIdempotencyKey();
    const request = buildCreateRequest({ projectId, displayName, reason, idempotencyKey: key });
    setBusy(true);
    const { outcome } = await send(API, "POST", request, key);
    setBusy(false);
    if (!applyOutcome(outcome)) return;
    closeDialog();
    await afterSuccess(null);
  }

  async function submitRename() {
    if (!detail) return;
    const key = newIdempotencyKey();
    const request = buildRenameRequest({
      displayName, reason, expectedVersion: detail.project_version, idempotencyKey: key,
    });
    setBusy(true);
    const { outcome } = await send(API + "/" + encodeURIComponent(detail.project_id),
      "PATCH", request, key);
    setBusy(false);
    if (!applyOutcome(outcome)) return;
    closeDialog();
    await afterSuccess(detail.project_id);
  }

  async function submitSetActive(active: boolean) {
    if (!detail) return;
    const key = newIdempotencyKey();
    const request = buildSetActiveRequest({
      active, reason, expectedVersion: detail.project_version, idempotencyKey: key,
    });
    setBusy(true);
    const { outcome } = await send(
      API + "/" + encodeURIComponent(detail.project_id) + "/active", "POST", request, key);
    setBusy(false);
    if (!applyOutcome(outcome)) return;
    closeDialog();
    await afterSuccess(detail.project_id);
  }

  /** Gan NHIEU quan ly: moi lan gui dung version du an moi nhat (OCC tuan tu). */
  async function submitAssign() {
    if (!detail) return;
    const invalid = validatePendingAssignments(pending);
    if (invalid) { setNotice(invalid); return; }
    setBusy(true);
    let version = detail.project_version;
    for (const row of pending) {
      const key = newIdempotencyKey();
      const request = buildAssignRequest({
        managerRecruiterId: row.managerRecruiterId, validFrom: row.validFrom, reason,
        expectedProjectVersion: version, idempotencyKey: key,
      });
      const { outcome, payload } = await send(
        API + "/" + encodeURIComponent(detail.project_id) + "/managers", "POST", request, key);
      if (!applyOutcome(outcome)) { setBusy(false); await afterSuccess(detail.project_id); return; }
      // OCC dung project_version (khong phai version = assignment version).
      const next = mutationProjectVersion(payload);
      if (next === null) { setBusy(false); await afterSuccess(detail.project_id); return; }
      version = next;
    }
    setBusy(false);
    closeDialog();
    await afterSuccess(detail.project_id);
  }

  async function submitUnassign(assignment: AssignmentView) {
    if (!detail) return;
    const key = newIdempotencyKey();
    const request = buildUnassignRequest({
      reason, expectedVersion: assignment.version,
      expectedProjectVersion: detail.project_version, idempotencyKey: key,
    });
    setBusy(true);
    const { outcome } = await send(
      API + "/" + encodeURIComponent(detail.project_id) + "/managers/" +
        encodeURIComponent(assignment.assignment_id), "POST", request, key);
    setBusy(false);
    if (!applyOutcome(outcome)) return;
    closeDialog();
    await afterSuccess(detail.project_id);
  }

  function openDialog(next: DialogState, seed?: { displayName?: string }) {
    setNotice(null);
    setReason("");
    setPending([]);
    setManagerId("");
    setValidFrom("");
    setDisplayName(seed && seed.displayName ? seed.displayName : "");
    setDialog(next);
  }

  if (state === "denied") return <AccessDenied />;
  if (state === "unavailable") return <TemporaryUnavailable />;

  const view = detail ? splitAssignments(detail.assignments) : { current: [], history: [] };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Quản lý dự án</h1>
          <p className="text-sm text-muted-foreground">
            Tạo, đổi tên, ngừng/kích hoạt dự án và gán quản lý dự án.
          </p>
        </div>
        <button type="button" className={primaryClass} onClick={() => openDialog({ kind: "create" })}>
          Tạo dự án
        </button>
      </header>

      {conflict ? (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <span>{conflict}</span>
          <button type="button" className={buttonClass} onClick={() => void reloadAfterConflict()}>
            Tải lại dữ liệu
          </button>
        </div>
      ) : null}

      {notice ? (
        <p role="alert" className="rounded-md border border-input p-3 text-sm">{notice}</p>
      ) : null}

      <section aria-labelledby="project-list-heading" className="rounded-lg border" aria-busy={state === "loading"}>
        <h2 id="project-list-heading" className="border-b p-3 text-base font-medium">
          Danh sách dự án
        </h2>
        {state === "loading" ? (
          <p className="p-3 text-sm text-muted-foreground" role="status">Đang tải dữ liệu…</p>
        ) : null}
        {state === "empty" ? (
          <p className="p-3 text-sm text-muted-foreground" role="status">
            Chưa có dự án nào. Hãy tạo dự án đầu tiên.
          </p>
        ) : null}
        {state === "error" ? (
          <div className="flex flex-col gap-2 p-3 text-sm" role="alert">
            <span>Không tải được danh sách dự án.</span>
            <button type="button" className={buttonClass}
              onClick={() => { setNotice(null); setState("loading"); void loadList(); }}>
              Thử lại
            </button>
          </div>
        ) : null}
        {state === "ready" || state === "empty" ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <caption className="sr-only">Danh sách dự án và trạng thái</caption>
              <thead>
                <tr className="border-b text-left">
                  <th scope="col" className="p-3">Mã dự án</th>
                  <th scope="col" className="p-3">Tên dự án</th>
                  <th scope="col" className="p-3">Trạng thái</th>
                  <th scope="col" className="p-3">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.project_id} className="border-b last:border-0">
                    <td className="p-3 font-mono text-xs">{project.project_id}</td>
                    <td className="p-3">{project.display_name}</td>
                    <td className="p-3">{projectStatusLabel(project.active)}</td>
                    <td className="flex flex-wrap gap-2 p-3">
                      <button type="button" className={buttonClass}
                        onClick={() => { void loadDetail(project.project_id); }}>
                        Xem quản lý
                      </button>
                      <button type="button" className={buttonClass}
                        onClick={() => { void loadDetail(project.project_id).then(() =>
                          openDialog({ kind: "rename" }, { displayName: project.display_name })); }}>
                        Đổi tên
                      </button>
                      <button type="button" className={buttonClass}
                        onClick={() => { void loadDetail(project.project_id).then(() =>
                          openDialog({ kind: "set-active", active: !project.active })); }}>
                        {project.active ? "Ngừng hoạt động" : "Kích hoạt"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="project-detail-heading" className="rounded-lg border">
        <h2 id="project-detail-heading" className="border-b p-3 text-base font-medium">
          Quản lý dự án hiện tại
        </h2>
        {!detail ? (
          <p className="p-3 text-sm text-muted-foreground">
            Chọn &quot;Xem quản lý&quot; ở một dự án để xem phân công.
          </p>
        ) : (
          <div className="flex flex-col gap-4 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                <span className="font-medium">{detail.display_name}</span>
                {" · "}
                <span className="font-mono text-xs">{detail.project_id}</span>
                {" — "}
                {projectStatusLabel(detail.project_active)}
                {" — phiên bản "}
                <span data-testid="project-version">{detail.project_version}</span>
              </p>
              <button type="button" className={primaryClass}
                onClick={() => openDialog({ kind: "assign" })}>
                Gán quản lý
              </button>
            </div>

            <h3 className="text-sm font-medium">Đang phụ trách ({view.current.length})</h3>
            {view.current.length === 0 ? (
              <p className="text-sm text-muted-foreground">Chưa có quản lý nào đang phụ trách.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {view.current.map((assignment) => (
                  <li key={assignment.assignment_id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
                    <span className="font-mono text-xs">{assignment.manager_recruiter_id}</span>
                    <span className="text-muted-foreground">
                      {"Từ " + assignment.valid_from + " · phiên bản " + String(assignment.version)}
                    </span>
                    <button type="button" className={buttonClass}
                      onClick={() => openDialog({ kind: "unassign", assignment })}>
                      Thu hồi
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="text-sm font-medium">Lịch sử phân công ({view.history.length})</h3>
            {view.history.length === 0 ? (
              <p className="text-sm text-muted-foreground">Chưa có lịch sử phân công.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {view.history.map((assignment) => (
                  <li key={assignment.assignment_id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
                    <span className="font-mono text-xs">{assignment.manager_recruiter_id}</span>
                    <span className="text-muted-foreground">
                      {assignment.valid_from + " → " + (assignment.valid_to ?? "chưa hiệu lực")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <Dialog.Root open={dialog.kind !== "none"}
        onOpenChange={(open) => { if (!open && !busy) closeDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-[min(94vw,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-card p-4 shadow-lg">
            {dialog.kind === "create" ? (
              <form className="flex flex-col gap-3"
                onSubmit={(event) => { event.preventDefault(); void submitCreate(); }}>
                <Dialog.Title className="text-base font-medium">Tạo dự án</Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">
                  Mã dự án không thể đổi sau khi tạo.
                </Dialog.Description>
                <Field id="project-id" label="Mã dự án">
                  <input id="project-id" className={inputClass} value={projectId}
                    onChange={(event) => setProjectId(event.target.value)} />
                </Field>
                <Field id="project-name" label="Tên dự án">
                  <input id="project-name" className={inputClass} value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)} />
                </Field>
                <ReasonField id={reasonId} value={reason} onChange={setReason} />
                <DialogActions busy={busy} onCancel={closeDialog} submitLabel="Tạo dự án" />
              </form>
            ) : null}

            {dialog.kind === "rename" ? (
              <form className="flex flex-col gap-3"
                onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
                <Dialog.Title className="text-base font-medium">Đổi tên dự án</Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">
                  {"Phiên bản hiện tại: " + String(detail ? detail.project_version : 0)}
                </Dialog.Description>
                <Field id="rename-name" label="Tên dự án">
                  <input id="rename-name" className={inputClass} value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)} />
                </Field>
                <ReasonField id={reasonId} value={reason} onChange={setReason} />
                <DialogActions busy={busy} onCancel={closeDialog} submitLabel="Lưu" />
              </form>
            ) : null}

            {dialog.kind === "set-active" ? (
              <form className="flex flex-col gap-3"
                onSubmit={(event) => { event.preventDefault(); void submitSetActive(dialog.active); }}>
                <Dialog.Title className="text-base font-medium">
                  {dialog.active ? "Kích hoạt dự án" : "Ngừng hoạt động dự án"}
                </Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">
                  {"Phiên bản hiện tại: " + String(detail ? detail.project_version : 0)}
                </Dialog.Description>
                <ReasonField id={reasonId} value={reason} onChange={setReason} />
                <DialogActions busy={busy} onCancel={closeDialog}
                  submitLabel={dialog.active ? "Kích hoạt" : "Ngừng hoạt động"} />
              </form>
            ) : null}

            {dialog.kind === "assign" ? (
              <form className="flex flex-col gap-3"
                onSubmit={(event) => { event.preventDefault(); void submitAssign(); }}>
                <Dialog.Title className="text-base font-medium">Gán quản lý dự án</Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">
                  Các phân công được xử lý lần lượt; nếu một bước lỗi, hãy tải lại để xem phần đã áp dụng.
                </Dialog.Description>
                <Field id="manager-id" label="recruiter_id (UUID)"
                  hint="Mã định danh người tuyển. Chỉ recruiter có verified account link được chấp nhận (server enforce).">
                  <input id="manager-id" className={inputClass} value={managerId}
                    onChange={(event) => setManagerId(event.target.value)} />
                </Field>
                <Field id="manager-from" label="Hiệu lực từ" hint="Định dạng YYYY-MM-DD">
                  <input id="manager-from" className={inputClass} value={validFrom}
                    onChange={(event) => setValidFrom(event.target.value)} />
                </Field>
                <button type="button" className={buttonClass}
                  onClick={() => setPending([...pending, { managerRecruiterId: managerId, validFrom }])}>
                  Thêm vào danh sách
                </button>
                <ul aria-label="Danh sách quản lý sẽ gán" className="flex flex-col gap-1 text-sm">
                  {pending.map((row, index) => (
                    <li key={row.managerRecruiterId + String(index)}
                      className="flex items-center justify-between gap-2 rounded border p-2">
                      <span className="font-mono text-xs">
                        {row.managerRecruiterId + " · " + row.validFrom}
                      </span>
                      <button type="button" className={buttonClass}
                        onClick={() => setPending(pending.filter((_, i) => i !== index))}>
                        Bỏ
                      </button>
                    </li>
                  ))}
                </ul>
                <ReasonField id={reasonId} value={reason} onChange={setReason} />
                <DialogActions busy={busy} onCancel={closeDialog} submitLabel="Gán quản lý" />
              </form>
            ) : null}

            {dialog.kind === "unassign" ? (
              <form className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitUnassign(dialog.assignment);
                }}>
                <Dialog.Title className="text-base font-medium">Thu hồi phân công</Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">
                  {"Quản lý: " + dialog.assignment.manager_recruiter_id}
                </Dialog.Description>
                <ReasonField id={reasonId} value={reason} onChange={setReason} />
                <DialogActions busy={busy} onCancel={closeDialog} submitLabel="Thu hồi" />
              </form>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}

function ReasonField({
  id, value, onChange,
}: { id: string; value: string; onChange: (next: string) => void }) {
  return (
    <Field id={id} label="Lý do" hint="Bắt buộc cho mọi thao tác thay đổi.">
      <textarea id={id} className="min-h-20 w-full rounded-md border border-input bg-background p-3 text-sm"
        required aria-required="true" value={value}
        onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function DialogActions({
  busy, onCancel, submitLabel,
}: { busy: boolean; onCancel: () => void; submitLabel: string }) {
  return (
    <div className="flex justify-end gap-2">
      <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>
        Huỷ
      </button>
      <button type="submit" className={primaryClass} disabled={busy} aria-busy={busy}>
        {submitLabel}
      </button>
    </div>
  );
}
