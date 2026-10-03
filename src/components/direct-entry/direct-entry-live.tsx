"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { DataGrid, renderTextEditor, type Column, type RenderEditCellProps } from "react-data-grid";
import "react-data-grid/lib/styles.css";

import { RecruiterTypeahead, type PickerOption } from "@/components/direct-entry/typeahead-picker-smoke";
import { DirectEntryPaymentEditor } from "@/components/direct-entry/direct-entry-payment-editor";
import { DirectEntryDocumentEditor } from "@/components/direct-entry/direct-entry-document-editor";
import { isRealCalendarDate } from "@/lib/analytics/identity/identity-shared.mjs";
import { validateEmployeeCode } from "@/lib/contracts/direct-entry-v1";
import {
  acceptDraftCreate,
  acceptDraftUpdate,
  changedDraftFields,
  draftRowFromProjection,
  editableFields,
  failDraftWrite,
  keepLocalDraft,
  markDraftConflict,
  newDraftRow,
  stableLiveDraftKey,
  applyServerDraft,
  updateLiveDraftRow,
  type ConflictCopy,
  type EditableDraftFields,
  type LiveDraftRow,
  type PendingDraftWrite,
} from "@/lib/direct-entry/live-controller";
import type { DraftCatalog, OwnDraft } from "@/lib/direct-entry/write-repository";
import styles from "./direct-entry-shell.module.css";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hcmDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseCatalog(value: unknown, expectedDate: string): DraftCatalog | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.catalog) ||
      value.catalog.effective_date !== expectedDate ||
      !Array.isArray(value.catalog.projects) || !Array.isArray(value.catalog.recruiters) ||
      !Array.isArray(value.catalog.banks)) return null;
  if (!value.catalog.projects.every((project) => isRecord(project) &&
      typeof project.project_id === "string" && typeof project.display_name === "string") ||
      !value.catalog.recruiters.every((recruiter) => isRecord(recruiter) &&
        typeof recruiter.recruiter_id === "string" && typeof recruiter.display_name === "string" &&
        (recruiter.provider_type === "hrp" || recruiter.provider_type === "vendor") &&
        typeof recruiter.team_id === "string" && typeof recruiter.team_display_name === "string")) {
    return null;
  }
  if (!value.catalog.banks.every((bank) => isRecord(bank) &&
      typeof bank.bank_id === "string" && typeof bank.display_name === "string")) return null;
  return value.catalog as DraftCatalog;
}

function parseOwnDrafts(value: unknown): OwnDraft[] | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.drafts)) return null;
  return value.drafts.every((draft) => isRecord(draft) &&
    typeof draft.entry_id === "string" && typeof draft.submission_id === "string" &&
    typeof draft.entry_version === "number" && typeof draft.submission_version === "number" &&
    typeof draft.employee_code === "string" && typeof draft.first_work_date === "string" &&
    typeof draft.worker_display_name === "string" && typeof draft.project_id === "string" &&
    typeof draft.project_display_name === "string" && typeof draft.recruiter_id === "string" &&
    typeof draft.recruiter_display_name === "string" &&
    (draft.provider_type === "hrp" || draft.provider_type === "vendor") &&
    typeof draft.team_id === "string" && typeof draft.team_display_name === "string" &&
    (draft.labor_type === "TEMPORARY" || draft.labor_type === "PERMANENT") &&
    (draft.employment_status === null || typeof draft.employment_status === "string") &&
    typeof draft.created_at === "string" && typeof draft.updated_at === "string")
    ? value.drafts as OwnDraft[]
    : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function optionalWorker(value: string) {
  return {
    display_name: value,
    date_of_birth: { state: "omitted" },
    national_id: { state: "omitted" },
    address: { state: "omitted" },
    phone: { state: "omitted" },
  };
}

function createPayload(row: LiveDraftRow) {
  return {
    project_id: row.projectId,
    first_work_date: row.firstWorkDate,
    employee_code: row.employeeCode,
    worker: optionalWorker(row.workerName),
    recruiter_id: row.recruiterId,
    labor_type: row.laborType,
  };
}

function updatePayload(fields: EditableDraftFields) {
  return {
    project_id: fields.projectId,
    first_work_date: fields.firstWorkDate,
    employee_code: fields.employeeCode,
    worker_details: { display_name: fields.workerName },
    recruiter_id: fields.recruiterId,
    labor_type: fields.laborType,
  };
}

function optionsFor(catalog: DraftCatalog | undefined): PickerOption[] {
  return catalog?.recruiters.map((recruiter) => ({
    id: recruiter.recruiter_id,
    label: recruiter.display_name,
    groupLabel: `${recruiter.provider_type.toUpperCase()} · ${recruiter.team_display_name}`,
    provider: recruiter.provider_type.toUpperCase(),
    team: recruiter.team_display_name,
  })) ?? [];
}

function displayProject(row: LiveDraftRow, catalog: DraftCatalog | undefined): string {
  return catalog?.projects.find(({ project_id }) => project_id === row.projectId)?.display_name ??
    row.projectDisplayName;
}

function displayRecruiter(row: LiveDraftRow, catalog: DraftCatalog | undefined): string {
  return catalog?.recruiters.find(({ recruiter_id }) => recruiter_id === row.recruiterId)?.display_name ?? "";
}

function stateText(state: LiveDraftRow["state"]): string {
  return {
    clean: "Đã lưu",
    dirty: "Có thay đổi chưa lưu",
    saving: "Đang lưu",
    saved: "Đã lưu thành công",
    conflict: "Xung đột phiên bản",
    error: "Lỗi lưu",
  }[state];
}

function rowWithFields(row: LiveDraftRow, fields: EditableDraftFields): LiveDraftRow {
  return { ...row, ...fields };
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return <label className={styles.field}><span>{label}</span>{children}</label>;
}

function DateEditor(props: RenderEditCellProps<LiveDraftRow>) {
  return (
    <input
      aria-label="Ngày đầu tiên đi làm"
      type="date"
      value={props.row.firstWorkDate}
      disabled={props.row.state === "saving"}
      onChange={(event) => props.onRowChange({
        ...props.row,
        firstWorkDate: event.currentTarget.value,
      }, true)}
    />
  );
}

function LiveRecruiterEditor({
  row,
  onRowChange,
  catalog,
}: RenderEditCellProps<LiveDraftRow> & { catalog: DraftCatalog | undefined }) {
  return (
    <RecruiterTypeahead
      id={`live-recruiter-${row.rowId}`}
      label="Người tuyển"
      options={optionsFor(catalog)}
      value={row.recruiterId}
      disabled={row.state === "saving" || row.state === "conflict"}
      onChange={(recruiterId) => onRowChange({ ...row, recruiterId }, true)}
    />
  );
}

export function DirectEntryLive() {
  const [today] = useState(hcmDate);
  const [rows, setRows] = useState<LiveDraftRow[]>([]);
  const rowsRef = useRef(rows);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, DraftCatalog>>({});
  const catalogCache = useRef(new Map<string, DraftCatalog>());
  const catalogLoads = useRef(new Map<string, Promise<DraftCatalog>>());
  const [catalogErrors, setCatalogErrors] = useState<Record<string, string>>({});
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadMessage, setLoadMessage] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const inFlight = useRef(new Set<string>());
  const selectedRow = rows.find(({ rowId }) => rowId === selectedRowId) ?? null;
  const catalogFor = useCallback((date: string) => catalogs[date], [catalogs]);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const ensureCatalog = useCallback((date: string): Promise<DraftCatalog> => {
    const cached = catalogCache.current.get(date);
    if (cached) return Promise.resolve(cached);
    const inProgress = catalogLoads.current.get(date);
    if (inProgress) return inProgress;
    const load = fetch(`/api/direct-entry/catalog?effective_date=${encodeURIComponent(date)}`, {
      cache: "no-store",
      credentials: "same-origin",
    }).then(async (response) => {
      const body = await readJson(response);
      const payload = parseCatalog(body, date);
      if (!response.ok || !payload) {
        const code = isRecord(body) && typeof body.code === "string" ? body.code : "CATALOG_UNAVAILABLE";
        if (response.status === 401 || response.status === 403) throw new Error(code);
        throw new Error("CATALOG_UNAVAILABLE");
      }
      catalogCache.current.set(date, payload);
      setCatalogs((current) => ({ ...current, [date]: payload }));
      setCatalogErrors((current) => {
        const next = { ...current };
        delete next[date];
        return next;
      });
      return payload;
    }).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : "CATALOG_UNAVAILABLE";
      setCatalogErrors((current) => ({ ...current, [date]: message }));
      throw cause;
    }).finally(() => {
      catalogLoads.current.delete(date);
    });
    catalogLoads.current.set(date, load);
    return load;
  }, []);

  const onPaymentEntryVersionChange = useCallback((rowId: string, entryVersion: number) => {
    const next = rowsRef.current.map((row) =>
      row.rowId === rowId ? { ...row, entryVersion } : row,
    );
    rowsRef.current = next;
    setRows(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadState("loading");
      try {
        const sessionResponse = await fetch("/api/direct-entry/session", {
          cache: "no-store",
          credentials: "same-origin",
        });
        const session = await readJson(sessionResponse);
        if (!sessionResponse.ok || !isRecord(session) || session.ok !== true) {
          const code = isRecord(session) && typeof session.code === "string"
            ? session.code
            : "SESSION_UNAVAILABLE";
          throw new Error(code);
        }
        if (!isRecord(session.actor) || !Array.isArray(session.actor.capabilities) ||
            !session.actor.capabilities.every((capability) => typeof capability === "string")) {
          throw new Error("SESSION_UNAVAILABLE");
        }
        setCapabilities(session.actor.capabilities);
        const [draftResponse, catalog] = await Promise.all([
          fetch("/api/direct-entry/drafts", { cache: "no-store", credentials: "same-origin" }),
          ensureCatalog(today),
        ]);
        const draftPayload = parseOwnDrafts(await readJson(draftResponse));
        if (!draftResponse.ok || !draftPayload) {
          throw new Error("DRAFTS_UNAVAILABLE");
        }
        const mapped = draftPayload.map(draftRowFromProjection);
        const neededDates = [...new Set(mapped.map(({ firstWorkDate }) => firstWorkDate))]
          .filter((date) => date !== today);
        await Promise.all(neededDates.map(ensureCatalog));
        if (cancelled) return;
        setRows(mapped);
        setCatalogs((current) => ({ ...current, [today]: catalog }));
        setLoadState("ready");
        setLoadMessage("");
      } catch (cause) {
        if (cancelled) return;
        setLoadState("error");
        setLoadMessage(cause instanceof Error ? cause.message : "DIRECT_ENTRY_UNAVAILABLE");
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [ensureCatalog, today]);

  useEffect(() => {
    for (const row of rows) {
      if (row.firstWorkDate && !catalogCache.current.has(row.firstWorkDate) &&
          !catalogErrors[row.firstWorkDate]) {
        void ensureCatalog(row.firstWorkDate).then((catalog) => {
          const current = rowsRef.current.find(({ rowId }) => rowId === row.rowId);
          if (current && current.recruiterId &&
              !catalog.recruiters.some(({ recruiter_id }) => recruiter_id === current.recruiterId)) {
            setRows((existing) => updateLiveDraftRow(existing, current.rowId, { recruiterId: "" }));
          }
        }).catch(() => {});
      }
    }
  }, [catalogErrors, ensureCatalog, rows]);

  const updateRow = useCallback((
    rowId: string,
    patch: Partial<EditableDraftFields>,
  ) => {
    setRows((current) => updateLiveDraftRow(current, rowId, patch));
  }, []);

  const fetchConflictCopy = useCallback(async (entryId: string): Promise<ConflictCopy | null> => {
    const projectionResponse = await fetch(
      `/api/direct-entry/entries/${encodeURIComponent(entryId)}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    const projection = await readJson(projectionResponse);
    if (!projectionResponse.ok || !isRecord(projection) || projection.ok !== true ||
        !isRecord(projection.entry) || projection.entry.entry_id !== entryId) return null;
    const draftsResponse = await fetch("/api/direct-entry/drafts", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const drafts = parseOwnDrafts(await readJson(draftsResponse));
    if (!draftsResponse.ok || !drafts) return null;
    const latest = drafts.find(({ entry_id }) => entry_id === entryId);
    if (!latest) return null;
    await ensureCatalog(latest.first_work_date);
    const serverRow = draftRowFromProjection(latest);
    return {
      version: serverRow.entryVersion!,
      submissionVersion: serverRow.submissionVersion!,
      fields: editableFields(serverRow),
    };
  }, [ensureCatalog]);

  const retryConflictLoad = useCallback(async (rowId: string) => {
    const current = rowsRef.current.find((row) => row.rowId === rowId);
    if (!current?.entryId || current.state !== "conflict") return;
    try {
      const conflictCopy = await fetchConflictCopy(current.entryId);
      if (!conflictCopy) throw new Error("DRAFT_CONFLICT_PROJECTION_UNAVAILABLE");
      setRows((existing) => existing.map((row) => row.rowId === rowId
        ? { ...row, conflictCopy, message: null }
        : row));
    } catch {
      setRows((existing) => existing.map((row) => row.rowId === rowId
        ? { ...row, message: "Không tải được bản mới từ máy chủ. Hãy thử lại." }
        : row));
    }
  }, [fetchConflictCopy]);

  const addRow = useCallback(() => {
    const row = newDraftRow(crypto.randomUUID(), today);
    setRows((current) => [...current, row]);
    setSelectedRowId(row.rowId);
    void ensureCatalog(today).catch(() => {});
  }, [ensureCatalog, today]);

  const saveRow = useCallback(async (rowId: string) => {
    const current = rowsRef.current.find((row) => row.rowId === rowId);
    if (!current || current.state === "saving" || current.state === "conflict" ||
        inFlight.current.has(rowId)) return;
    const catalog = catalogCache.current.get(current.firstWorkDate);
    if (!catalog) {
      setCatalogErrors((errors) => ({
        ...errors,
        [current.firstWorkDate]: errors[current.firstWorkDate] ?? "CATALOG_UNAVAILABLE",
      }));
      return;
    }
    const validation = validateEmployeeCode(current.employeeCode, current.firstWorkDate);
    const valid = isRealCalendarDate(current.firstWorkDate) &&
      current.workerName.trim().length > 0 &&
      catalog.projects.some(({ project_id }) => project_id === current.projectId) &&
      catalog.recruiters.some(({ recruiter_id }) => recruiter_id === current.recruiterId) &&
      validation.length === 0;
    if (!valid) {
      updateRow(rowId, { recruiterId: catalog.recruiters.some(({ recruiter_id }) =>
        recruiter_id === current.recruiterId) ? current.recruiterId : "",
      });
      setRows((existing) => existing.map((row) => row.rowId === rowId
        ? { ...row, state: "error", message: "Kiểm tra ngày, mã, họ tên, dự án và người tuyển." }
        : row));
      return;
    }
    inFlight.current.add(rowId);
    const pending: PendingDraftWrite = current.pendingWrite ?? {
      key: crypto.randomUUID(),
      fields: editableFields(current),
      expectedVersion: current.entryVersion,
    };
    setRows((existing) => existing.map((row) => row.rowId === rowId
      ? { ...row, state: "saving", pendingWrite: pending, message: null }
      : row));
    try {
      const response = pending.expectedVersion === null
        ? await fetch("/api/direct-entry/batches", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": pending.key,
          },
          body: JSON.stringify({ rows: [createPayload(rowWithFields(current, pending.fields))] }),
        })
        : await fetch(`/api/direct-entry/entries/${encodeURIComponent(current.entryId!)}`, {
          method: "PATCH",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": pending.key,
          },
          body: JSON.stringify({
            expected_version: pending.expectedVersion,
            patch: updatePayload(pending.fields),
          }),
        });
      const payload = await readJson(response);
      if (response.status === 409 && pending.expectedVersion !== null) {
        let conflictCopy: ConflictCopy | null = null;
        try {
          conflictCopy = await fetchConflictCopy(current.entryId!);
        } catch {
          conflictCopy = null;
        }
        setRows((existing) => existing.map((row) => row.rowId === rowId
          ? markDraftConflict(row, pending, conflictCopy)
          : row));
        return;
      }
      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : "SAVE_FAILED";
        throw new Error(code);
      }
      if (pending.expectedVersion === null) {
        if (typeof payload.submission_id !== "string" ||
            typeof payload.submission_version !== "number" ||
            !Array.isArray(payload.entry_ids) || typeof payload.entry_ids[0] !== "string") {
          throw new Error("SAVE_RESPONSE_INVALID");
        }
        const entryId = payload.entry_ids[0];
        const submissionId = payload.submission_id;
        const submissionVersion = payload.submission_version;
        setRows((existing) => existing.map((row) => row.rowId === rowId
          ? acceptDraftCreate(row, pending, {
            entryId,
            submissionId,
            entryVersion: 1,
            submissionVersion,
          })
          : row));
        setSelectedRowId((selected) => selected === rowId ? entryId : selected);
      } else {
        if (typeof payload.entry_version !== "number" ||
            typeof payload.submission_version !== "number") {
          throw new Error("SAVE_RESPONSE_INVALID");
        }
        const entryVersion = payload.entry_version;
        const submissionVersion = payload.submission_version;
        setRows((existing) => existing.map((row) => {
          if (row.rowId !== rowId) return row;
          return acceptDraftUpdate(row, pending, { entryVersion, submissionVersion });
        }));
      }
      window.setTimeout(() => {
        setRows((existing) => existing.map((row) => row.rowId === rowId && row.state === "saved"
          ? { ...row, state: "clean" }
          : row));
      }, 1600);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "SAVE_FAILED";
      setRows((existing) => existing.map((row) => row.rowId === rowId
        ? failDraftWrite(row, pending, code)
        : row));
    } finally {
      inFlight.current.delete(rowId);
    }
  }, [fetchConflictCopy, updateRow]);

  const saveDirtyRows = useCallback(async () => {
    for (const row of rowsRef.current.filter(({ state }) => state === "dirty" || state === "error")) {
      await saveRow(row.rowId);
    }
  }, [saveRow]);

  const loadLatest = useCallback((rowId: string) => {
    setRows((current) => current.map((row) => {
      if (row.rowId !== rowId || !row.conflictCopy) return row;
      const catalog = catalogCache.current.get(row.conflictCopy.fields.firstWorkDate);
      const recruiter = catalog?.recruiters.find(
        ({ recruiter_id }) => recruiter_id === row.conflictCopy?.fields.recruiterId,
      );
      const project = catalog?.projects.find(
        ({ project_id }) => project_id === row.conflictCopy?.fields.projectId,
      );
      const resolved = applyServerDraft(row);
      return {
        ...resolved,
        providerType: recruiter?.provider_type ?? null,
        teamId: recruiter?.team_id ?? null,
        teamDisplayName: recruiter?.team_display_name ?? "",
        recruiterDisplayName: recruiter?.display_name ?? "",
        projectDisplayName: project?.display_name ?? "",
      };
    }));
    setSelectedRowId(null);
  }, []);

  const keepLocal = useCallback((rowId: string) => {
    setRows((current) => current.map((row) => {
      if (row.rowId !== rowId || !row.conflictCopy) return row;
      return keepLocalDraft(row);
    }));
    setSelectedRowId(null);
  }, []);

  const columns = useMemo<readonly Column<LiveDraftRow>[]>(() => {
    const textColumn = (
      key: keyof LiveDraftRow,
      name: string,
      width: number,
    ): Column<LiveDraftRow> => ({
      key: String(key),
      name,
      width,
      editable: (row) => row.state !== "saving" && row.state !== "conflict",
      renderEditCell: renderTextEditor,
    });
    return [
      textColumn("employeeCode", "Mã NLĐ", 160),
      {
        key: "firstWorkDate",
        name: "Ngày đầu tiên đi làm",
        width: 170,
        editable: (row) => row.state !== "saving" && row.state !== "conflict",
        renderEditCell: DateEditor,
      },
      textColumn("workerName", "Họ tên", 180),
      {
        key: "projectId",
        name: "Dự án",
        width: 200,
        editable: (row) => row.state !== "saving" && row.state !== "conflict",
        renderCell: ({ row }) => displayProject(row, catalogFor(row.firstWorkDate)) || "Chọn dự án",
        renderEditCell: (props) => (
          <select
            aria-label="Dự án"
            value={props.row.projectId}
            disabled={props.row.state === "saving"}
            onChange={(event) => props.onRowChange({
              ...props.row,
              projectId: event.currentTarget.value,
            }, true)}
          >
            <option value="">Chọn dự án</option>
            {catalogFor(props.row.firstWorkDate)?.projects.map((project) => (
              <option key={project.project_id} value={project.project_id}>{project.display_name}</option>
            ))}
          </select>
        ),
      },
      {
        key: "recruiterId",
        name: "Người tuyển",
        width: 220,
        editable: (row) => row.state !== "saving" && row.state !== "conflict",
        renderCell: ({ row }) => displayRecruiter(row, catalogFor(row.firstWorkDate)) || "Chọn người tuyển",
        renderEditCell: (props) => (
          <LiveRecruiterEditor {...props} catalog={catalogFor(props.row.firstWorkDate)} />
        ),
      },
      {
        key: "providerType",
        name: "HRP/Vendor",
        width: 115,
        renderCell: ({ row }) => catalogFor(row.firstWorkDate)?.recruiters.find(
          ({ recruiter_id }) => recruiter_id === row.recruiterId,
        )?.provider_type.toUpperCase() ?? "—",
      },
      {
        key: "teamDisplayName",
        name: "Team",
        width: 140,
        renderCell: ({ row }) => catalogFor(row.firstWorkDate)?.recruiters.find(
          ({ recruiter_id }) => recruiter_id === row.recruiterId,
        )?.team_display_name ?? "—",
      },
      {
        key: "laborType",
        name: "Loại hình",
        width: 150,
        editable: (row) => row.state !== "saving" && row.state !== "conflict",
        renderCell: ({ row }) => row.laborType === "TEMPORARY" ? "Thời vụ" : "Toàn thời gian",
        renderEditCell: (props) => (
          <select
            aria-label="Loại hình lao động"
            value={props.row.laborType}
            disabled={props.row.state === "saving"}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "TEMPORARY" || value === "PERMANENT") {
                props.onRowChange({ ...props.row, laborType: value }, true);
              }
            }}
          >
            <option value="TEMPORARY">Thời vụ</option>
            <option value="PERMANENT">Toàn thời gian</option>
          </select>
        ),
      },
      {
        key: "state",
        name: "Trạng thái lưu",
        width: 170,
        renderCell: ({ row }) => stateText(row.state),
      },
      {
        key: "paymentEditor",
        name: "Thông tin thanh toán",
        width: 180,
        renderCell: ({ row }) => (
          <button
            type="button"
            className={styles.gridEditButton}
            onClick={(event) => {
              event.stopPropagation();
              setSelectedRowId(row.rowId);
            }}
          >
            Mở bản nháp
          </button>
        ),
      },
    ];
  }, [catalogFor]);

  const onRowsChange = useCallback((updated: LiveDraftRow[]) => {
    setRows((current) => updated.map((next) => {
      const previous = current.find(({ rowId }) => rowId === next.rowId);
      if (!previous) return next;
      const merged = rowWithFields(previous, editableFields(next));
      return updateLiveDraftRow([previous], previous.rowId, editableFields(next))[0] ?? merged;
    }));
  }, []);

  const updateDate = useCallback((rowId: string, firstWorkDate: string) => {
    updateRow(rowId, { firstWorkDate, recruiterId: "" });
    if (isRealCalendarDate(firstWorkDate)) void ensureCatalog(firstWorkDate).catch(() => {});
  }, [ensureCatalog, updateRow]);

  const currentOptions = selectedRow ? optionsFor(catalogFor(selectedRow.firstWorkDate)) : [];
  const currentRecruiter = selectedRow
    ? catalogFor(selectedRow.firstWorkDate)?.recruiters.find(
      ({ recruiter_id }) => recruiter_id === selectedRow.recruiterId,
    )
    : undefined;
  const dirtyCount = rows.filter(({ state }) =>
    ["dirty", "error", "conflict"].includes(state),
  ).length;
  const catalogMissing = Object.values(catalogs).some(({ projects, recruiters }) =>
    projects.length === 0 || recruiters.length === 0,
  );

  return (
    <main className={styles.page}>
      <div className={styles.banner} role="status">
        <strong>Dữ liệu nháp trên máy chủ</strong>
        <span>Thay đổi chỉ được lưu khi máy chủ xác nhận; bản chưa lưu nằm trong bộ nhớ trang.</span>
      </div>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>P1.6 · Direct Entry · S03CD</p>
          <h1>Nhập liệu trực tiếp</h1>
          <p>Bản nháp của bạn · {rows.length} dòng</p>
        </div>
        <div className={styles.liveHeaderActions}>
          <button type="button" className={styles.secondaryButton} onClick={addRow} disabled={loadState !== "ready"}>
            Thêm dòng
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => void saveDirtyRows()}
            disabled={loadState !== "ready" || dirtyCount === 0 || catalogMissing}
          >
            Lưu nháp
          </button>
        </div>
      </header>

      <div className={styles.notice} aria-live="polite">
        {loadState === "loading" && "Đang tải quyền, danh mục và bản nháp…"}
        {loadState === "error" && `Không tải được Direct Entry (${loadMessage}). Không dùng dữ liệu mẫu khi chế độ máy chủ đang bật.`}
        {loadState === "ready" && catalogMissing &&
          "Danh mục dự án hoặc người tuyển chưa được cấu hình; thao tác lưu đang bị khóa."}
        {loadState === "ready" && !catalogMissing &&
          `${dirtyCount} dòng cần lưu hoặc đối chiếu. Tải lại trang sẽ giữ các bản nháp máy chủ đã xác nhận.`}
        {Object.entries(catalogErrors).map(([date, message]) =>
          <span key={date}>Danh mục ngày {date} không khả dụng ({message}).</span>,
        )}
      </div>

      {loadState === "ready" && (
        <>
          <section className={styles.gridSection} aria-label="Bảng bản nháp Direct Entry">
            <p className={styles.gridHint}>Dự án, recruiter, HRP/Vendor và team đến từ danh mục theo ngày hiệu lực.</p>
            <div className={styles.gridViewport}>
              <DataGrid<LiveDraftRow>
                aria-label="Bản nháp Direct Entry"
                className={styles.grid}
                columns={columns}
                onRowsChange={onRowsChange}
                rowClass={(row) => row.state === "dirty" || row.state === "error" || row.state === "conflict"
                  ? styles.dirtyRow
                  : undefined}
                rowHeight={44}
                rowKeyGetter={stableLiveDraftKey}
                rows={rows}
              />
            </div>
          </section>

          <section className={styles.mobileSection} aria-label="Danh sách bản nháp">
            {rows.length === 0 && <p>Chưa có bản nháp. Chọn “Thêm dòng” để bắt đầu.</p>}
            <ul className={styles.mobileList}>
              {rows.map((row) => (
                <li key={row.rowId}>
                  <button
                    type="button"
                    className={`${styles.rowCard} ${row.state !== "clean" ? styles.rowCardDirty : ""}`}
                    onClick={() => setSelectedRowId(row.rowId)}
                    aria-label={`Chỉnh sửa ${row.employeeCode || "dòng mới"} — ${stateText(row.state)}`}
                  >
                    <span className={styles.rowCardTop}>
                      <strong>{row.employeeCode || "Dòng mới"}</strong>
                      <span className={styles.dirtyBadge}>{stateText(row.state)}</span>
                    </span>
                    <span>{row.workerName || "Chưa nhập họ tên"}</span>
                    <span className={styles.rowCardMeta}>
                      {displayProject(row, catalogFor(row.firstWorkDate)) || "Chưa chọn dự án"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <Dialog.Root open={selectedRow !== null} onOpenChange={(open) => {
        if (!open) setSelectedRowId(null);
      }}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.drawerOverlay} />
          {selectedRow && (
            <Dialog.Content className={styles.drawer} aria-describedby="direct-entry-live-description">
              <Dialog.Title className={styles.drawerTitle}>Sửa bản nháp</Dialog.Title>
              <Dialog.Description id="direct-entry-live-description" className={styles.drawerDescription}>
                Trạng thái: {stateText(selectedRow.state)}. Người tuyển, provider và team được xác định theo ngày làm.
              </Dialog.Description>
              <div className={styles.drawerFields}>
                <Field label="Mã người lao động">
                  <input aria-label="Mã người lao động" value={selectedRow.employeeCode}
                    disabled={selectedRow.state === "saving" || selectedRow.state === "conflict"}
                    onChange={(event) => updateRow(selectedRow.rowId, { employeeCode: event.target.value })} />
                </Field>
                <Field label="Ngày đầu tiên đi làm">
                  <input aria-label="Ngày đầu tiên đi làm" type="date" value={selectedRow.firstWorkDate}
                    disabled={selectedRow.state === "saving" || selectedRow.state === "conflict"}
                    onChange={(event) => updateDate(selectedRow.rowId, event.target.value)} />
                </Field>
                <Field label="Họ tên người lao động">
                  <input aria-label="Họ tên người lao động" value={selectedRow.workerName}
                    disabled={selectedRow.state === "saving" || selectedRow.state === "conflict"}
                    onChange={(event) => updateRow(selectedRow.rowId, { workerName: event.target.value })} />
                </Field>
                <Field label="Dự án">
                  <select aria-label="Dự án" value={selectedRow.projectId}
                    disabled={selectedRow.state === "saving" || selectedRow.state === "conflict" ||
                      !catalogFor(selectedRow.firstWorkDate)}
                    onChange={(event) => updateRow(selectedRow.rowId, { projectId: event.target.value })}>
                    <option value="">Chọn dự án</option>
                    {catalogFor(selectedRow.firstWorkDate)?.projects.map((project) =>
                      <option key={project.project_id} value={project.project_id}>{project.display_name}</option>,
                    )}
                  </select>
                </Field>
                <div className={styles.field}>
                  <RecruiterTypeahead
                    id={`live-mobile-recruiter-${selectedRow.rowId}`}
                    options={currentOptions}
                    value={selectedRow.recruiterId}
                    disabled={selectedRow.state === "saving" || selectedRow.state === "conflict"}
                    onChange={(recruiterId) => updateRow(selectedRow.rowId, { recruiterId })}
                  />
                </div>
                <p className={styles.derivedValue}>
                  HRP/Vendor: <strong>{currentRecruiter?.provider_type.toUpperCase() ?? "Chưa chọn"}</strong>
                  {" · "}Team: <strong>{currentRecruiter?.team_display_name ?? "—"}</strong>
                </p>
                <Field label="Loại hình lao động">
                  <select aria-label="Loại hình lao động" value={selectedRow.laborType}
                    disabled={selectedRow.state === "saving" || selectedRow.state === "conflict"}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      if (value === "TEMPORARY" || value === "PERMANENT") {
                        updateRow(selectedRow.rowId, { laborType: value });
                      }
                    }}>
                    <option value="TEMPORARY">Thời vụ</option>
                    <option value="PERMANENT">Toàn thời gian</option>
                  </select>
                </Field>
                <DirectEntryPaymentEditor
                  key={`${selectedRow.rowId}:${selectedRow.entryId ?? "new"}`}
                  entryId={selectedRow.entryId}
                  entryVersion={selectedRow.entryVersion}
                  rowId={selectedRow.rowId}
                  banks={catalogFor(selectedRow.firstWorkDate)?.banks ?? []}
                  canEdit={capabilities.includes("entry_own") &&
                    selectedRow.state !== "saving" && selectedRow.state !== "conflict"}
                  canView={capabilities.includes("payment_view")}
                  onEntryVersionChange={onPaymentEntryVersionChange}
                />
                <DirectEntryDocumentEditor
                  key={`documents-${selectedRow.rowId}:${selectedRow.entryId ?? "new"}`}
                  entryId={selectedRow.entryId}
                  entryVersion={selectedRow.entryVersion}
                  rowId={selectedRow.rowId}
                  canEdit={capabilities.includes("entry_own") &&
                    capabilities.includes("document_upload") &&
                    selectedRow.state !== "saving" && selectedRow.state !== "conflict"}
                  canView={capabilities.includes("document_view")}
                  onEntryVersionChange={onPaymentEntryVersionChange}
                />
                {selectedRow.message && <p role="alert">{selectedRow.message}</p>}
                {selectedRow.state === "conflict" && (
                  <div className={styles.conflictBox} role="alert">
                    {selectedRow.conflictCopy
                      ? <>
                        <strong>Có phiên bản mới trên máy chủ.</strong>
                        <span>Phiên bản đang sửa: {selectedRow.entryVersion}; máy chủ: {selectedRow.conflictCopy.version}.</span>
                        <span>Khác biệt: {changedDraftFields(
                          editableFields(selectedRow),
                          selectedRow.conflictCopy.fields,
                        ).join(", ") || "Các trường đã được máy chủ thay đổi"}.</span>
                        <button type="button" className={styles.secondaryButton}
                          onClick={() => loadLatest(selectedRow.rowId)}>Tải bản mới từ máy chủ</button>
                        <button type="button" className={styles.secondaryButton}
                          onClick={() => keepLocal(selectedRow.rowId)}>Tiếp tục giữ bản đang sửa</button>
                      </>
                      : <span>Không thể tải bản mới để đối chiếu. Bản đang sửa vẫn được giữ.</span>}
                    {!selectedRow.conflictCopy && (
                      <button type="button" className={styles.secondaryButton}
                        onClick={() => void retryConflictLoad(selectedRow.rowId)}>
                        Thử tải bản mới
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className={styles.drawerActions}>
                <Dialog.Close asChild>
                  <button type="button" className={styles.secondaryButton}>Quay lại danh sách</button>
                </Dialog.Close>
                <button type="button" className={styles.primaryButton}
                  onClick={() => void saveRow(selectedRow.rowId)}
                  disabled={selectedRow.state === "saving" || selectedRow.state === "conflict" ||
                    selectedRow.state === "clean" || selectedRow.state === "saved"}>
                  {selectedRow.state === "saving" ? "Đang lưu…" : "Lưu nháp"}
                </button>
              </div>
            </Dialog.Content>
          )}
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
