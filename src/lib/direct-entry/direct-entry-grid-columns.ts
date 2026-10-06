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

/**
 * P1.7-H05 - Bo cot mac dinh cho Direct Entry Production UI.
 *
 * Thu tu 18 cot vat ly da duoc khoa theo task brief. STT chi la hien thi, Mã NLĐ
 * khong xuat hien o day va them khong cho nhap; việc cấp mã định danh vẫn do server
 * (migration #39) đảm nhiệm và hiện ở action rail/drawer. Tuổi suy ra từ DOB; lifecycle
 * (nghỉ việc/trạng thái) đóng vai trò nội bộ và không nằm trên grid mặc định.
 *
 * Registry tong `DIRECT_ENTRY_GRID_COLUMNS` van giu day du cac truong de ho tro
 * drawer/projection, validation va mo rong sau nay; chỉ danh sach default visible bi
 * gioi han theo yeu cau H05.
 */
export const DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS: readonly string[] = Object.freeze([
  "row_index",
  "project_id",
  "first_work_date",
  "display_name",
  "gender",
  "date_of_birth",
  "national_id",
  "national_id_issued_at",
  "national_id_issued_place",
  "address",
  "phone",
  "provider_type",
  "recruiter_id",
  "labor_type",
  "account_number",
  "bank_name",
  "account_holder_name",
  "general_note",
]);

/**
 * Action rail dat NGOAI grid: chi gom trang thai luu va thao tac tren dong.
 * Cot `cccd_documents` da duoc loai khoi rail theo yeu cau H05 — hồ sơ CCCD mo qua
 * drawer/dialog rieng cua row (`DirectEntryCccdManager` / `DirectEntryDocumentEditor`)
 * va khong con la data header cua bang.
 */
export const DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS: readonly string[] = Object.freeze([
  "save_status",
  "row_actions",
]);

export const DIRECT_ENTRY_GENDER_OPTIONS: readonly string[] = Object.freeze(["Nam", "Nữ"]);
/**
 * UI theo ngu canh P1.7-H05: hien thi "Chính thức"; backend canonical value van la
 * "PERMANENT". Bo bao gom "Toàn thời gian" khoi UI moi nhung XLSX import alias van
 * chap nhan.
 */
export const DIRECT_ENTRY_LABOR_TYPE_OPTIONS: readonly string[] = Object.freeze([
  "Thời vụ",
  "Chính thức",
]);
export const DIRECT_ENTRY_PROVIDER_OPTIONS: readonly string[] = Object.freeze(["HRP", "Vendor"]);

export type GridRecruiterOption = {
  id: string;
  label: string;
  provider_type: "hrp" | "vendor";
  /** P3-W07A: business identifier (e.g. vinht.td); null for Vendor rows. */
  personnel_code: string | null;
  /** P3-W07A: vendor id for Vendor rows; null for HRP rows. */
  vendor_id: string | null;
};

/**
 * P3-W07A-R1: locked UI label mapping for the canonical `personnel_position`
 * enum. W07A is data-only and does not add a role token; the helper just
 * renders the catalog position in Vietnamese. A `TEAM_LEADER` row is a
 * catalog/membership fact, not an authenticated app user. Account,
 * capability and team dashboard creation live in P3-W07B.
 */
export const PERSONNEL_POSITION_UI_LABELS: Readonly<Record<"STAFF" | "TEAM_LEADER", string>> =
  Object.freeze({
    STAFF: "Nhân viên",
    TEAM_LEADER: "Trưởng nhóm",
  });

export function personnelPositionUiLabel(position: "STAFF" | "TEAM_LEADER" | null): string {
  if (position === null) return "—";
  return PERSONNEL_POSITION_UI_LABELS[position];
}

export function recruitersForProvider(
  recruiters: readonly GridRecruiterOption[],
  providerType: "hrp" | "vendor" | "",
): readonly GridRecruiterOption[] {
  return providerType === ""
    ? []
    : recruiters.filter((recruiter) => recruiter.provider_type === providerType);
}

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
  fieldColumn("employee_code", { group: "entry", pasteMode: "validate-only", width: 150,
    editor: "readonly", editable: false }),
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
    editor: "text", label: "Địa chỉ" }),
  fieldColumn("phone", { group: "worker", pasteMode: "write", width: 150,
    editor: "text", label: "Số điện thoại" }),
  fieldColumn("provider_hint", { group: "derived", pasteMode: "validate-only", width: 150,
    editor: "readonly", editable: false, label: "HRP/Vendor" }),
  uiColumn({ key: "provider_type", label: "HRP/Vendor", group: "entry", editable: true,
    pasteMode: "ignore", required: false, width: 140, visibleByDefault: true, editor: "select" }),
  fieldColumn("recruiter_id", { group: "entry", pasteMode: "write", width: 210,
    editor: "catalog", label: "Người tuyển / Vendor" }),
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
  uiColumn({ key: "save_status", label: "Trạng thái", group: "derived", editable: false,
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
