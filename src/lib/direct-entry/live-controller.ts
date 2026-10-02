import type { OwnDraft } from "./write-repository";

export type EditableDraftFields = {
  employeeCode: string;
  firstWorkDate: string;
  workerName: string;
  projectId: string;
  recruiterId: string;
  laborType: "TEMPORARY" | "PERMANENT";
};

export type DraftSaveState = "clean" | "dirty" | "saving" | "saved" | "conflict" | "error";

export type PendingDraftWrite = {
  key: string;
  fields: EditableDraftFields;
  expectedVersion: number | null;
};

export type ConflictCopy = {
  version: number;
  submissionVersion: number;
  fields: EditableDraftFields;
};

export type CreateDraftResult = {
  entryId: string;
  submissionId: string;
  entryVersion: number;
  submissionVersion: number;
};

export type UpdateDraftResult = {
  entryVersion: number;
  submissionVersion: number;
};

export type LiveDraftRow = EditableDraftFields & {
  rowId: string;
  entryId: string | null;
  submissionId: string | null;
  entryVersion: number | null;
  submissionVersion: number | null;
  providerType: "hrp" | "vendor" | null;
  teamId: string | null;
  teamDisplayName: string;
  projectDisplayName: string;
  recruiterDisplayName: string;
  employmentStatus: "UNCONFIRMED" | "ON" | "OFF" | null;
  state: DraftSaveState;
  saved: EditableDraftFields | null;
  pendingWrite: PendingDraftWrite | null;
  conflictCopy: ConflictCopy | null;
  message: string | null;
};

export function draftRowFromProjection(draft: OwnDraft): LiveDraftRow {
  const fields: EditableDraftFields = {
    employeeCode: draft.employee_code,
    firstWorkDate: draft.first_work_date,
    workerName: draft.worker_display_name,
    projectId: draft.project_id,
    recruiterId: draft.recruiter_id,
    laborType: draft.labor_type,
  };
  return {
    ...fields,
    rowId: draft.entry_id,
    entryId: draft.entry_id,
    submissionId: draft.submission_id,
    entryVersion: draft.entry_version,
    submissionVersion: draft.submission_version,
    providerType: draft.provider_type,
    teamId: draft.team_id,
    teamDisplayName: draft.team_display_name,
    projectDisplayName: draft.project_display_name,
    recruiterDisplayName: draft.recruiter_display_name,
    employmentStatus: draft.employment_status,
    state: "clean",
    saved: { ...fields },
    pendingWrite: null,
    conflictCopy: null,
    message: null,
  };
}

export function newDraftRow(rowId: string, firstWorkDate: string): LiveDraftRow {
  return {
    rowId,
    entryId: null,
    submissionId: null,
    entryVersion: null,
    submissionVersion: null,
    employeeCode: "",
    firstWorkDate,
    workerName: "",
    projectId: "",
    recruiterId: "",
    laborType: "TEMPORARY",
    providerType: null,
    teamId: null,
    teamDisplayName: "",
    projectDisplayName: "",
    recruiterDisplayName: "",
    employmentStatus: "UNCONFIRMED",
    state: "dirty",
    saved: null,
    pendingWrite: null,
    conflictCopy: null,
    message: null,
  };
}

export function editableFields(row: LiveDraftRow): EditableDraftFields {
  return {
    employeeCode: row.employeeCode,
    firstWorkDate: row.firstWorkDate,
    workerName: row.workerName,
    projectId: row.projectId,
    recruiterId: row.recruiterId,
    laborType: row.laborType,
  };
}

export function fieldsDiffer(
  left: EditableDraftFields,
  right: EditableDraftFields,
): boolean {
  return left.employeeCode !== right.employeeCode ||
    left.firstWorkDate !== right.firstWorkDate ||
    left.workerName !== right.workerName ||
    left.projectId !== right.projectId ||
    left.recruiterId !== right.recruiterId ||
    left.laborType !== right.laborType;
}

export function updateLiveDraftRow(
  rows: readonly LiveDraftRow[],
  rowId: string,
  patch: Partial<EditableDraftFields>,
): LiveDraftRow[] {
  return rows.map((row) => {
    if (row.rowId !== rowId || row.state === "saving") return row;
    const next = { ...row, ...patch };
    return {
      ...next,
      state: !row.entryId || !row.saved || fieldsDiffer(editableFields(next), row.saved)
        ? "dirty"
        : "clean",
      pendingWrite: row.pendingWrite &&
        !fieldsDiffer(editableFields(next), row.pendingWrite.fields)
        ? row.pendingWrite
        : null,
      conflictCopy: row.state === "conflict" ? row.conflictCopy : null,
      message: null,
    };
  });
}

export function changedDraftFields(
  local: EditableDraftFields,
  server: EditableDraftFields,
): string[] {
  const labels: Array<[keyof EditableDraftFields, string]> = [
    ["employeeCode", "Mã người lao động"],
    ["firstWorkDate", "Ngày đầu tiên đi làm"],
    ["workerName", "Họ tên"],
    ["projectId", "Dự án"],
    ["recruiterId", "Người tuyển"],
    ["laborType", "Loại hình lao động"],
  ];
  return labels.filter(([key]) => local[key] !== server[key]).map(([, label]) => label);
}

export function stableLiveDraftKey(row: LiveDraftRow): string {
  return row.entryId ?? row.rowId;
}

export function acceptDraftCreate(
  row: LiveDraftRow,
  pending: PendingDraftWrite,
  result: CreateDraftResult,
): LiveDraftRow {
  const next = {
    ...row,
    rowId: result.entryId,
    entryId: result.entryId,
    submissionId: result.submissionId,
    entryVersion: result.entryVersion,
    submissionVersion: result.submissionVersion,
    saved: { ...pending.fields },
    pendingWrite: null,
    conflictCopy: null,
    message: null,
  };
  return {
    ...next,
    state: fieldsDiffer(editableFields(next), pending.fields) ? "dirty" : "saved",
  };
}

export function acceptDraftUpdate(
  row: LiveDraftRow,
  pending: PendingDraftWrite,
  result: UpdateDraftResult,
): LiveDraftRow {
  const next = {
    ...row,
    entryVersion: result.entryVersion,
    submissionVersion: result.submissionVersion,
    saved: { ...pending.fields },
    pendingWrite: null,
    conflictCopy: null,
    message: null,
  };
  return {
    ...next,
    state: fieldsDiffer(editableFields(next), pending.fields) ? "dirty" : "saved",
  };
}

export function failDraftWrite(
  row: LiveDraftRow,
  pending: PendingDraftWrite,
  message: string,
): LiveDraftRow {
  return { ...row, state: "error", pendingWrite: pending, message };
}

export function markDraftConflict(
  row: LiveDraftRow,
  pending: PendingDraftWrite,
  conflictCopy: ConflictCopy | null,
): LiveDraftRow {
  return {
    ...row,
    state: "conflict",
    pendingWrite: pending,
    conflictCopy,
    message: conflictCopy ? null : "Không tải được bản mới từ máy chủ.",
  };
}

export function applyServerDraft(row: LiveDraftRow): LiveDraftRow {
  if (!row.conflictCopy) return row;
  return {
    ...row,
    ...row.conflictCopy.fields,
    entryVersion: row.conflictCopy.version,
    submissionVersion: row.conflictCopy.submissionVersion,
    saved: { ...row.conflictCopy.fields },
    state: "clean",
    pendingWrite: null,
    conflictCopy: null,
    message: null,
  };
}

export function keepLocalDraft(row: LiveDraftRow): LiveDraftRow {
  if (!row.conflictCopy) return row;
  return {
    ...row,
    entryVersion: row.conflictCopy.version,
    submissionVersion: row.conflictCopy.submissionVersion,
    saved: { ...row.conflictCopy.fields },
    state: "dirty",
    pendingWrite: null,
    conflictCopy: null,
    message: "Bản đang sửa được giữ; phiên bản mới nhất đã được xác nhận. Bấm lưu để gửi lại.",
  };
}
