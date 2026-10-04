"use client";

/**
 * P1.7-W02 - Spreadsheet-lite grid cho Direct Entry.
 *
 * Component nay CHI lo phan trinh bay + tuong tac luoi:
 *   - render column registry 27 cot bang react-data-grid dang co;
 *   - giu o neo (anchor) cua lan paste/copy/keyboard;
 *   - bat su kien copy/paste do nguoi dung chu dong tao va goi pure mapper cua W01;
 *   - thao tac dong (lam trong / xoa / nhan ban / ho so CCCD).
 *
 * Component KHONG goi API, KHONG doc/ghi localStorage, KHONG tu parse nghiep vu,
 * KHONG dung Clipboard permission API va KHONG giu state cua row model. Moi thay doi
 * du lieu duoc bao nguoc len orchestrator qua callback, nen paste chi doi React state
 * o tang cha.
 */
import { useCallback, useMemo, type ClipboardEvent } from "react";
import {
  DataGrid,
  renderTextEditor,
  type CellCopyArgs,
  type CellKeyDownArgs,
  type CellPasteArgs,
  type Column,
  type RenderCellProps,
  type RenderEditCellProps,
} from "react-data-grid";
import "react-data-grid/lib/styles.css";

import {
  DIRECT_ENTRY_GRID_COLUMNS,
  type DirectEntryGridColumn,
} from "@/lib/direct-entry/direct-entry-grid-columns";
import {
  mapClipboardFromAnchor,
  parseClipboardTsv,
  serializeClipboardTsv,
  type ClipboardMapResult,
} from "@/lib/direct-entry/direct-entry-grid-clipboard";
import type { SpreadsheetValidation } from "@/lib/direct-entry/direct-entry-grid-validation";

import styles from "./direct-entry-spreadsheet-grid.module.css";

export const SPREADSHEET_GRID_ARIA_LABEL = "Bảng nhập liệu Direct Entry";

export type SpreadsheetGridRow = {
  clientRowId: string;
  /** true khi dong da ton tai tren server, khong phai placeholder. */
  persisted: boolean;
  /** true chi voi row nam trong staged batch W02. */
  clientStaged: boolean;
  /** true khi submission state khoa dong (REVIEW/SUBMITTED). */
  locked: boolean;
  cells: Readonly<Record<string, string>>;
  /** Sanitized display-only labels; these values are never copied or written. */
  displayValues?: Readonly<Record<string, string>>;
  /** Field key duoc phep sua truc tiep; rong nghia la read-only. */
  editableFields: readonly string[];
  cccdStatus: string;
  canManageCccd: boolean;
  employeeCode: string;
  displayName: string;
  projectLabel: string;
  recruiterLabel: string;
  saveStatus: string;
};

export type SpreadsheetCatalogOptions = {
  projects: readonly { id: string; label: string }[];
  recruiters: readonly { id: string; label: string }[];
};

export type SpreadsheetPasteRejection =
  | "CLIPBOARD_ROW_OVERFLOW"
  | "CLIPBOARD_COLUMN_OVERFLOW"
  | "CLIPBOARD_ANCHOR_INVALID"
  | "CLIPBOARD_EMPTY"
  | "CLIPBOARD_PERSISTED_ROW";

export type SpreadsheetPasteRequest = {
  mapping: Extract<ClipboardMapResult, { ok: true }>;
  rowCount: number;
  columnCount: number;
};

export type DirectEntrySpreadsheetGridProps = {
  rows: readonly SpreadsheetGridRow[];
  validation: SpreadsheetValidation;
  catalogOptions?: SpreadsheetCatalogOptions;
  onCellsChange(clientRowId: string, patch: Readonly<Record<string, string>>): void;
  onPasteApplied(request: SpreadsheetPasteRequest): void;
  onPasteRejected(reason: SpreadsheetPasteRejection): void;
  onClearRow(clientRowId: string): void;
  onDeleteRow(clientRowId: string): void;
  onDuplicateRow(clientRowId: string): void;
  onOpenDraft?(clientRowId: string): void;
  onManageDocuments?(clientRowId: string): void;
  onSave(): void;
  saveLabel: string;
  saveDisabled: boolean;
  saveBusy?: boolean;
  notice: string;
  canUndo: boolean;
  onUndo(): void;
  saveMessage?: string;
};

const GENDER_OPTIONS = ["", "Nam", "Nữ", "Khác"];
const LABOR_TYPE_OPTIONS = ["", "Thời vụ", "Toàn thời gian"];
const STATUS_OPTIONS = ["", "Chưa xác nhận", "Đang làm", "Đã nghỉ"];

export function spreadsheetSelectOptions(
  columnKey: string,
  catalogs: SpreadsheetCatalogOptions | undefined,
): readonly string[] | null {
  if (columnKey === "gender") return GENDER_OPTIONS;
  if (columnKey === "labor_type") return LABOR_TYPE_OPTIONS;
  if (columnKey === "initial_status") return STATUS_OPTIONS;
  if (columnKey === "project_id") return ["", ...(catalogs?.projects ?? []).map((option) => option.label)];
  if (columnKey === "recruiter_id") return ["", ...(catalogs?.recruiters ?? []).map((option) => option.label)];
  return null;
}

export function spreadsheetColumnIndex(columnKey: string): number {
  return DIRECT_ENTRY_GRID_COLUMNS.findIndex((column) => column.key === columnKey);
}

function SelectCellEditor(
  props: RenderEditCellProps<SpreadsheetGridRow> & { columnKey: string; catalogs: SpreadsheetCatalogOptions | undefined },
) {
  const options = spreadsheetSelectOptions(props.columnKey, props.catalogs) ?? [];
  return (
    <select
      aria-label={props.columnKey}
      autoFocus
      value={props.row.cells[props.columnKey] ?? ""}
      onChange={(event) => props.onRowChange(
        { ...props.row, cells: { ...props.row.cells, [props.columnKey]: event.currentTarget.value } }, true)}
    >
      {options.map((option) => <option key={option} value={option}>{option === "" ? "—" : option}</option>)}
    </select>
  );
}

function DateCellEditor(props: RenderEditCellProps<SpreadsheetGridRow> & { columnKey: string }) {
  return (
    <input
      aria-label={props.columnKey}
      autoFocus
      type="date"
      value={props.row.cells[props.columnKey] ?? ""}
      onChange={(event) => props.onRowChange(
        { ...props.row, cells: { ...props.row.cells, [props.columnKey]: event.currentTarget.value } }, true)}
    />
  );
}

export function DirectEntrySpreadsheetGrid(props: DirectEntrySpreadsheetGridProps) {
  const {
    rows, validation, catalogOptions, onCellsChange, onPasteApplied, onPasteRejected,
    onClearRow, onDeleteRow, onDuplicateRow, onOpenDraft, onManageDocuments, onSave, saveLabel,
    saveDisabled, saveBusy, notice, canUndo, onUndo, saveMessage,
  } = props;

  const rowIndexOf = useCallback((clientRowId: string) =>
    rows.findIndex((row) => row.clientRowId === clientRowId), [rows]);

  const isEditable = useCallback((row: SpreadsheetGridRow, columnKey: string) =>
    !row.locked && row.editableFields.includes(columnKey), []);

  const issueFor = useCallback((row: SpreadsheetGridRow, columnKey: string) =>
    validation.cellIssues.find((issue) =>
      issue.clientRowId === row.clientRowId && issue.columnKey === columnKey) ?? null, [validation]);

  const columns = useMemo<readonly Column<SpreadsheetGridRow>[]>(() => {
    const build = (column: DirectEntryGridColumn): Column<SpreadsheetGridRow> => {
      const editable = column.editor !== "readonly" && column.editor !== "action" &&
        column.pasteMode === "write";

      if (column.key === "row_actions") {
        return {
          key: column.key, name: column.label, width: column.width, resizable: true,
          renderCell: ({ row }: RenderCellProps<SpreadsheetGridRow>) => !row.clientStaged
            ? (
              <button type="button" disabled={!onOpenDraft} aria-label={`Mở bản nháp ${row.employeeCode}`}
                onClick={() => onOpenDraft?.(row.clientRowId)}>Mở bản nháp</button>
            )
            : (
              <span className={styles.rowActions}>
                <button type="button" aria-label={`Nhân bản ${row.employeeCode || "dòng mới"}`}
                  onClick={() => onDuplicateRow(row.clientRowId)}>Nhân bản</button>
                <button type="button" aria-label={`Làm trống ${row.employeeCode || "dòng mới"}`}
                  onClick={() => onClearRow(row.clientRowId)}>Làm trống</button>
                <button type="button" aria-label={`Xóa ${row.employeeCode || "dòng mới"}`}
                  onClick={() => onDeleteRow(row.clientRowId)}>Xóa</button>
              </span>
            ),
        };
      }
      if (column.key === "cccd_documents") {
        return {
          key: column.key, name: column.label, width: column.width, resizable: true,
          renderCell: ({ row }: RenderCellProps<SpreadsheetGridRow>) => (
            <span className={styles.rowActions}>
              <span>{row.cccdStatus}</span>
              <button type="button" aria-label={`Quản lý hồ sơ CCCD ${row.employeeCode}`}
                disabled={!row.persisted || !row.canManageCccd || !onManageDocuments}
                onClick={() => onManageDocuments?.(row.clientRowId)}>Quản lý hồ sơ</button>
            </span>
          ),
        };
      }

      const renderCell = ({ row }: RenderCellProps<SpreadsheetGridRow>) => {
        const issue = issueFor(row, column.key);
        const display = (() => {
          if (row.displayValues && Object.hasOwn(row.displayValues, column.key)) {
            return row.displayValues[column.key];
          }
          if (column.key === "save_status") return row.saveStatus;
          if (column.key === "employee_code") return row.employeeCode;
          if (column.key === "display_name") return row.displayName;
          if (column.key === "project_id") return row.projectLabel;
          if (column.key === "recruiter_id") return row.recruiterLabel;
          if (column.key === "row_index") return String(rowIndexOf(row.clientRowId) + 1);
          return row.cells[column.key] ?? "";
        })();
        return (
          <span data-cell-state={issue ? issue.severity : "ok"}
            title={issue ? issue.message : undefined}
            className={issue ? styles.cellError : undefined}>
            {display}
          </span>
        );
      };

      if (!editable) {
        return { key: column.key, name: column.label, width: column.width, resizable: true, renderCell };
      }

      if (column.editor === "select" || column.editor === "catalog") {
        return {
          key: column.key, name: column.label, width: column.width, resizable: true,
          editable: (row: SpreadsheetGridRow) => isEditable(row, column.key),
          renderCell,
          renderEditCell: (editProps: RenderEditCellProps<SpreadsheetGridRow>) => (
            <SelectCellEditor {...editProps} columnKey={column.key} catalogs={catalogOptions} />
          ),
        };
      }
      if (column.editor === "date") {
        return {
          key: column.key, name: column.label, width: column.width, resizable: true,
          editable: (row: SpreadsheetGridRow) => isEditable(row, column.key),
          renderCell,
          renderEditCell: (editProps: RenderEditCellProps<SpreadsheetGridRow>) => (
            <DateCellEditor {...editProps} columnKey={column.key} />
          ),
        };
      }
      return {
        key: column.key, name: column.label, width: column.width, resizable: true,
        editable: (row: SpreadsheetGridRow) => isEditable(row, column.key),
        renderCell,
        renderEditCell: renderTextEditor,
      };
    };
    return DIRECT_ENTRY_GRID_COLUMNS.map(build);
  }, [catalogOptions, isEditable, issueFor, onClearRow, onDeleteRow, onDuplicateRow, onManageDocuments, onOpenDraft, rowIndexOf]);

  const onRowsChange = useCallback((next: SpreadsheetGridRow[]) => {
    for (const row of next) {
      const current = rows.find((candidate) => candidate.clientRowId === row.clientRowId);
      if (!current) continue;
      const patch: Record<string, string> = {};
      for (const key of row.editableFields) {
        const value = row.cells[key] ?? "";
        if (value !== (current.cells[key] ?? "")) patch[key] = value;
      }
      if (Object.keys(patch).length > 0) onCellsChange(row.clientRowId, patch);
    }
  }, [onCellsChange, rows]);

  /**
   * Paste do nguoi dung chu dong tao tren o dang active. Ma tran duoc map tu o neo;
   * khong co request mang nao o day.
   */
  const onCellPaste = useCallback((args: CellPasteArgs<SpreadsheetGridRow>, event: ClipboardEvent<HTMLDivElement>) => {
    const columnIndex = spreadsheetColumnIndex(args.column.key);
    const rowIndex = rowIndexOf(args.row.clientRowId);
    event.preventDefault();
    if (columnIndex < 0 || rowIndex < 0) {
      onPasteRejected("CLIPBOARD_ANCHOR_INVALID");
      return args.row;
    }
    const text = event.clipboardData.getData("text/plain");
    if (text === "") { onPasteRejected("CLIPBOARD_EMPTY"); return args.row; }
    const parsed = parseClipboardTsv(text);
    if (!parsed.ok) { onPasteRejected("CLIPBOARD_ROW_OVERFLOW"); return args.row; }
    const liveDraftRows = rows.filter((row) => !row.clientStaged).length;
    const mapping = mapClipboardFromAnchor({
      matrix: parsed.matrix,
      anchor: { rowIndex, columnIndex },
      maxRows: liveDraftRows + 100,
    });
    if (!mapping.ok) { onPasteRejected(mapping.code); return args.row; }
    onPasteApplied({ mapping, rowCount: mapping.rowCount, columnCount: mapping.columnCount });
    return args.row;
  }, [onPasteApplied, onPasteRejected, rowIndexOf, rows]);

  const onCellCopy = useCallback((args: CellCopyArgs<SpreadsheetGridRow>, event: ClipboardEvent<HTMLDivElement>) => {
    const value = args.row.cells[args.column.key] ?? "";
    event.clipboardData.setData("text/plain", serializeClipboardTsv([[value]]));
    event.preventDefault();
  }, []);

  const onCellKeyDown = useCallback((args: CellKeyDownArgs<SpreadsheetGridRow>, event: { key: string; preventGridDefault: () => void }) => {
    if (args.mode !== "ACTIVE") return;
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    const column = args.column;
    const row = args.row;
    if (!column || !row) return;
    if (!isEditable(row, column.key)) return;
    event.preventGridDefault();
    onCellsChange(row.clientRowId, { [column.key]: "" });
  }, [isEditable, onCellsChange]);

  const errorRowCount = validation.rows.filter((row) => row.errorCount > 0).length;

  return (
    <div className={styles.spreadsheet} data-testid="spreadsheet-grid">
      <div className={styles.toolbar}>
        <button type="button" data-testid="spreadsheet-save" onClick={onSave}
          disabled={saveDisabled || saveBusy === true} aria-busy={saveBusy === true}>
          {saveLabel}
        </button>
        {notice !== "" && (
          <span data-testid="spreadsheet-paste-notice" role="status">
            <span>{notice}</span>
            {canUndo && (
              <button type="button" data-testid="spreadsheet-undo" onClick={onUndo}>Hoàn tác</button>
            )}
          </span>
        )}
        {errorRowCount > 0 && (
          <span data-testid="spreadsheet-error-summary" role="status">{errorRowCount} dòng có lỗi</span>
        )}
        {validation.headerIssues.length > 0 && (
          <span data-testid="spreadsheet-header-issues" role="alert">
            {validation.headerIssues.map((issue) => issue.message).join(" ")}
          </span>
        )}
        {saveMessage !== undefined && saveMessage !== "" && (
          <span data-testid="spreadsheet-save-message" role="status">{saveMessage}</span>
        )}
      </div>
      <div className={styles.viewport}>
        <DataGrid<SpreadsheetGridRow>
          aria-label={SPREADSHEET_GRID_ARIA_LABEL}
          columns={columns}
          rows={rows as SpreadsheetGridRow[]}
          rowKeyGetter={(row) => row.clientRowId}
          onRowsChange={onRowsChange}
          onCellPaste={onCellPaste}
          onCellCopy={onCellCopy}
          onCellKeyDown={onCellKeyDown}
          rowHeight={40}
          headerRowHeight={38}
        />
      </div>
    </div>
  );
}
