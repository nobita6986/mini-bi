export interface DirectEntryRow {
  rowId: string;
  employeeCode: string;
  firstWorkDate: string;
  workerLabel: string;
  project: string;
  recruiterId: string;
  laborType: "Toàn thời gian" | "Thời vụ";
  workStatus: "Chưa xác nhận" | "Đang làm" | "Đã nghỉ";
}

export interface RecruiterRecord {
  id: string;
  label: string;
  provider: "HRP" | "Vendor";
  team: string;
  active: true;
}

export const SYNTHETIC_RECRUITERS: readonly RecruiterRecord[] = [
  { id: "recruiter-sample-hrp-01", label: "CongHr1", provider: "HRP", team: "Bắc", active: true },
  { id: "recruiter-sample-hrp-02", label: "CongHr2", provider: "HRP", team: "Nam", active: true },
  { id: "recruiter-sample-vendor-01", label: "ChungVendor", provider: "Vendor", team: "Bắc", active: true },
];

export const INITIAL_DIRECT_ENTRY_ROWS: readonly DirectEntryRow[] = [
  {
    rowId: "sample-row-001",
    employeeCode: "hrp-2026-001",
    firstWorkDate: "2026-10-01",
    workerLabel: "Nhân sự mẫu 01",
    project: "Dự án thử nghiệm Bắc",
    recruiterId: SYNTHETIC_RECRUITERS[0].id,
    laborType: "Toàn thời gian",
    workStatus: "Đang làm",
  },
  {
    rowId: "sample-row-002",
    employeeCode: "hrp-2026-002",
    firstWorkDate: "2026-10-02",
    workerLabel: "Nhân sự mẫu 02",
    project: "Dự án thử nghiệm Nam",
    recruiterId: SYNTHETIC_RECRUITERS[1].id,
    laborType: "Thời vụ",
    workStatus: "Chưa xác nhận",
  },
  {
    rowId: "sample-row-003",
    employeeCode: "hrp-2026-003",
    firstWorkDate: "2026-10-03",
    workerLabel: "Nhân sự mẫu 03",
    project: "Dự án thử nghiệm Bắc",
    recruiterId: SYNTHETIC_RECRUITERS[2].id,
    laborType: "Toàn thời gian",
    workStatus: "Chưa xác nhận",
  },
];

export function stableDirectEntryRowKey(row: DirectEntryRow): string {
  return row.rowId;
}

export function editDirectEntryRow(
  rows: readonly DirectEntryRow[],
  rowId: string,
  patch: Partial<Omit<DirectEntryRow, "rowId">>,
): DirectEntryRow[] {
  return rows.map((row) => row.rowId === rowId ? { ...row, ...patch, rowId } : row);
}

export function isDirectEntryUiEnabled(flag: string | undefined): boolean {
  return flag === "true";
}
