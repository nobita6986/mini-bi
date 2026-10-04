import {
  workerProfileField,
  type WorkerProfileFieldSpec,
} from "./worker-profile-import-contract.ts";

export type DirectEntryGridColumnGroup =
  | "entry"
  | "worker"
  | "employment"
  | "payment"
  | "derived"
  | "action";

export type DirectEntryGridPasteMode = "write" | "validate-only" | "ignore";

export type DirectEntryGridEditor =
  | "text"
  | "date"
  | "select"
  | "catalog"
  | "readonly"
  | "action";

export type DirectEntryGridColumn = {
  key: string;
  label: string;
  group: DirectEntryGridColumnGroup;
  editable: boolean;
  pasteMode: DirectEntryGridPasteMode;
  required: boolean;
  width: number;
  visibleByDefault: boolean;
  editor: DirectEntryGridEditor;
  /** Contract source of truth; null only for UI-only columns. */
  contractField: WorkerProfileFieldSpec | null;
};

type FieldColumnOptions = Pick<DirectEntryGridColumn, "group" | "pasteMode" | "width" | "editor"> &
  Partial<Pick<DirectEntryGridColumn, "editable" | "visibleByDefault" | "label">>;

function fieldColumn(key: string, options: FieldColumnOptions): DirectEntryGridColumn {
  const contractField = workerProfileField(key);
  if (!contractField) throw new Error(`Unknown worker-profile field: ${key}`);
  return Object.freeze({
    key,
    label: options.label ?? contractField.canonicalHeader,
    group: options.group,
    editable: options.editable ?? options.pasteMode === "write",
    pasteMode: options.pasteMode,
    required: contractField.requirement === "required",
    width: options.width,
    visibleByDefault: options.visibleByDefault ?? true,
    editor: options.editor,
    contractField,
  });
}

function uiColumn(input: Omit<DirectEntryGridColumn, "contractField">): DirectEntryGridColumn {
  return Object.freeze({ ...input, contractField: null });
}

/**
 * Physical order is the clipboard coordinate contract. Keep this list ordered and append/reorder only
 * through an explicit P1.7 contract change.
 */
export const DIRECT_ENTRY_GRID_COLUMNS: readonly DirectEntryGridColumn[] = Object.freeze([
  fieldColumn("row_index", { group: "derived", pasteMode: "validate-only", width: 72,
    editor: "readonly", editable: false }),
  fieldColumn("project_id", { group: "entry", pasteMode: "write", width: 210,
    editor: "catalog" }),
  fieldColumn("first_work_date", { group: "entry", pasteMode: "write", width: 178,
    editor: "date" }),
  fieldColumn("employee_code", { group: "entry", pasteMode: "write", width: 150,
    editor: "text" }),
  fieldColumn("display_name", { group: "worker", pasteMode: "write", width: 220,
    editor: "text" }),
  fieldColumn("gender", { group: "worker", pasteMode: "write", width: 120,
    editor: "select" }),
  fieldColumn("date_of_birth", { group: "worker", pasteMode: "write", width: 130,
    editor: "date" }),
  fieldColumn("age_years", { group: "derived", pasteMode: "validate-only", width: 88,
    editor: "readonly", editable: false }),
  fieldColumn("national_id", { group: "worker", pasteMode: "write", width: 150,
    editor: "text" }),
  fieldColumn("national_id_issued_at", { group: "worker", pasteMode: "write", width: 130,
    editor: "date" }),
  fieldColumn("national_id_issued_place", { group: "worker", pasteMode: "write", width: 180,
    editor: "text" }),
  fieldColumn("address", { group: "worker", pasteMode: "write", width: 260,
    editor: "text" }),
  fieldColumn("phone", { group: "worker", pasteMode: "write", width: 150,
    editor: "text" }),
  fieldColumn("provider_hint", { group: "derived", pasteMode: "validate-only", width: 150,
    editor: "readonly", editable: false, label: "HRP/Vendor" }),
  fieldColumn("recruiter_id", { group: "entry", pasteMode: "write", width: 210,
    editor: "catalog" }),
  fieldColumn("team_hint", { group: "derived", pasteMode: "validate-only", width: 160,
    editor: "readonly", editable: false }),
  fieldColumn("labor_type", { group: "entry", pasteMode: "write", width: 140,
    editor: "select" }),
  fieldColumn("initial_status", { group: "employment", pasteMode: "write", width: 205,
    editor: "select" }),
  fieldColumn("leave_date", { group: "employment", pasteMode: "write", width: 150,
    editor: "date" }),
  fieldColumn("leave_reason_text", { group: "employment", pasteMode: "write", width: 240,
    editor: "text" }),
  fieldColumn("general_note", { group: "entry", pasteMode: "write", width: 240,
    editor: "text" }),
  fieldColumn("account_number", { group: "payment", pasteMode: "write", width: 170,
    editor: "text" }),
  fieldColumn("bank_name", { group: "payment", pasteMode: "write", width: 200,
    editor: "text" }),
  fieldColumn("account_holder_name", { group: "payment", pasteMode: "write", width: 200,
    editor: "text" }),
  uiColumn({ key: "cccd_documents", label: "Hồ sơ CCCD", group: "action", editable: false,
    pasteMode: "ignore", required: false, width: 150, visibleByDefault: true, editor: "action" }),
  uiColumn({ key: "save_status", label: "Trạng thái lưu", group: "derived", editable: false,
    pasteMode: "ignore", required: false, width: 140, visibleByDefault: true,
    editor: "readonly" }),
  uiColumn({ key: "row_actions", label: "Thao tác", group: "action", editable: false,
    pasteMode: "ignore", required: false, width: 150, visibleByDefault: true, editor: "action" }),
]);

const COLUMN_BY_KEY = new Map(DIRECT_ENTRY_GRID_COLUMNS.map((column) => [column.key, column]));

export function directEntryGridColumn(key: string): DirectEntryGridColumn | undefined {
  return COLUMN_BY_KEY.get(key);
}

export function directEntryGridColumnIndex(key: string): number {
  return DIRECT_ENTRY_GRID_COLUMNS.findIndex((column) => column.key === key);
}
