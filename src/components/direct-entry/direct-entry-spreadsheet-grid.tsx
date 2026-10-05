"use client";

/**
 * P1.7-W02 - Spreadsheet-lite grid cho Direct Entry.
 *
 * Component nay CHI lo phan trinh bay + tuong tac luoi:
 *   - render bo cot nhap lieu mac dinh va action rail bang react-data-grid dang co;
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
  DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS,
  DIRECT_ENTRY_GENDER_OPTIONS,
  DIRECT_ENTRY_LABOR_TYPE_OPTIONS,
  recruitersForProvider,
  directEntryGridColumn,
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
  providerType: "hrp" | "vendor" | "";
  cells: Readonly<Record<string, string>>;
  catalogOptions?: SpreadsheetCatalogOptions;
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
  recruiters: readonly { id: string; label: string; provider_type: "hrp" | "vendor" }[];
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
  onProviderTypeChange(clientRowId: string, providerType: "hrp" | "vendor" | ""): void;
  onPasteApplied(request: SpreadsheetPasteRequest): void;
  onPasteRejected(reason: SpreadsheetPasteRejection): void;
  onDeleteRow(clientRowId: string): void;
  notice: string;
  canUndo: boolean;
  onUndo(): void;
  saveMessage?: string;
  /**
   * P1.7-H06: clientRowId dang duoc chon de contextual action bar thao tac.
   * Chi truyen mot ID duy nhat moi luc; neu `null` thi khong co dong nao duoc chon.
   * Select chi thay doi focus/highlight, khong mutate data cell.
   */
  selectedClientRowId?: string | null;
  onSelectedClientRowChange(clientRowId: string | null): void;
};

const PROVIDER_OPTIONS = ["hrp", "vendor"] as const;
const LABOR_TYPE_UI_VALUES: readonly string[] = DIRECT_ENTRY_LABOR_TYPE_OPTIONS;

export function spreadsheetSelectOptions(
  columnKey: string,
  catalogs: SpreadsheetCatalogOptions | undefined,
  providerType: "hrp" | "vendor" | "" = "",
  rowDate: string | null = null,
  projectCatalog: SpreadsheetCatalogOptions | undefined = catalogs,
): readonly string[] | null {
  if (columnKey === "gender") return DIRECT_ENTRY_GENDER_OPTIONS;
  if (columnKey === "labor_type") return LABOR_TYPE_UI_VALUES;
  if (columnKey === "provider_type") return PROVIDER_OPTIONS;
  if (columnKey === "project_id") {
    // Project dropdown phai resolve theo first_work_date cua chinh row.
    const source = projectCatalog ?? catalogs;
    if (rowDate === null || rowDate === "") return ["", ...(source?.projects ?? []).map((option) => option.label)];
    return ["", ...(source?.projects ?? []).map((option) => option.label)];
  }
  if (columnKey === "recruiter_id") {
    return recruitersForProvider(catalogs?.recruiters ?? [], providerType).map((option) => option.id);
  }
  return null;
}

export function spreadsheetColumnIndex(columnKey: string): number {
  return DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.indexOf(columnKey);
}

function SelectCellEditor(
  props: RenderEditCellProps<SpreadsheetGridRow> & {
    columnKey: string;
    catalogs: SpreadsheetCatalogOptions | undefined;
  },
) {
  const rowCatalogs = props.row.catalogOptions ?? props.catalogs;
  const rowDate = props.row.cells.first_work_date ?? null;
  const options = spreadsheetSelectOptions(
    props.columnKey, rowCatalogs, props.row.providerType, rowDate, rowCatalogs,
  ) ?? [];
  const recruiter = rowCatalogs?.recruiters.find((option) =>
    option.id === props.row.cells.recruiter_id || option.label === props.row.cells.recruiter_id);
  const value = props.columnKey === "provider_type"
    ? props.row.providerType
    : props.columnKey === "recruiter_id"
      ? recruiter?.id ?? ""
      : props.row.cells[props.columnKey] ?? "";
  const change = (nextValue: string) => props.onRowChange(
    { ...props.row, cells: { ...props.row.cells, [props.columnKey]: nextValue } }, true);
  if (props.columnKey === "provider_type") {
    return (
      <select aria-label="HRP/Vendor" autoFocus value={value}
        onChange={(event) => {
          const next = event.currentTarget.value;
          const providerType = next === "hrp" || next === "vendor" ? next : "";
          props.onRowChange({ ...props.row, providerType }, true);
        }}>
        <option value="hrp">HRP</option>
        <option value="vendor">Vendor</option>
      </select>
    );
  }
  if (props.columnKey === "recruiter_id") {
    const recruiters = recruitersForProvider(rowCatalogs?.recruiters ?? [], props.row.providerType);
    return (
      <select aria-label="Người tuyển / Vendor" autoFocus value={value}
        disabled={props.row.providerType === ""}
        onChange={(event) => change(event.currentTarget.value)}>
        {recruiters.length === 0
          ? <option value="">—</option>
          : <option value="">—</option>}
        {recruiters.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    );
  }
  if (props.columnKey === "project_id") {
    if (rowDate === null || rowDate === "") {
      return (
        <span className={styles.cellHint} role="status" aria-live="polite">
          Nhập ngày bắt đầu trước
        </span>
      );
    }
    return (
      <select aria-label="Dự án" autoFocus value={value}
        onChange={(event) => change(event.currentTarget.value)}>
        {options.map((option) =>
          <option key={option} value={option}>{option === "" ? "—" : option}</option>)}
      </select>
    );
  }
  return (
    <select
      aria-label={props.columnKey}
      autoFocus
      value={value}
      onChange={(event) => change(event.currentTarget.value)}
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
    onProviderTypeChange,
    notice, canUndo, onUndo, saveMessage,
    selectedClientRowId, onSelectedClientRowChange,
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
        (column.key === "provider_type" || column.pasteMode === "write");
      const headerLabel = column.required
        ? <span><span>{column.label}</span><span className={styles.requiredMark} aria-hidden="true"> *</span><span className={styles.srOnly}> (bắt buộc)</span></span>
        : column.label;


      const renderCell = ({ row }: RenderCellProps<SpreadsheetGridRow>) => {
        const issue = issueFor(row, column.key);
        const display = (() => {
          if (row.displayValues && Object.hasOwn(row.displayValues, column.key)) {
            return row.displayValues[column.key];
          }
          if (column.key === "display_name") return row.displayName;
          if (column.key === "project_id") return row.projectLabel;
          if (column.key === "provider_type") return row.providerType.toUpperCase();
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
        return {
          key: column.key, name: headerLabel, width: column.width, resizable: true,
          renderCell,
        };
      }

      if (column.editor === "select" || column.editor === "catalog") {
        return {
          key: column.key, name: headerLabel, width: column.width, resizable: true,
          editable: (row: SpreadsheetGridRow) => column.key === "provider_type"
            ? row.clientStaged
            : isEditable(row, column.key) &&
              (column.key !== "recruiter_id" || row.providerType !== ""),
          renderCell,
          renderEditCell: (editProps: RenderEditCellProps<SpreadsheetGridRow>) => (
            <SelectCellEditor {...editProps} columnKey={column.key} catalogs={catalogOptions}
            />
          ),
        };
      }
      if (column.editor === "date") {
        return {
          key: column.key, name: headerLabel, width: column.width, resizable: true,
          editable: (row: SpreadsheetGridRow) => isEditable(row, column.key),
          renderCell,
          renderEditCell: (editProps: RenderEditCellProps<SpreadsheetGridRow>) => (
            <DateCellEditor {...editProps} columnKey={column.key} />
          ),
        };
      }
      return {
        key: column.key, name: headerLabel, width: column.width, resizable: true,
        editable: (row: SpreadsheetGridRow) => isEditable(row, column.key),
        renderCell,
        renderEditCell: renderTextEditor,
      };
    };
    const dataColumns = DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS
      .map((key) => directEntryGridColumn(key))
      .filter((column): column is DirectEntryGridColumn => column !== undefined);
    return dataColumns.map(build);
  }, [catalogOptions, isEditable, issueFor, rowIndexOf]);

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
      if (row.providerType !== current.providerType) {
        onProviderTypeChange(row.clientRowId, row.providerType);
      }
    }
  }, [onCellsChange, onProviderTypeChange, rows]);

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
      columns: DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS
        .map((key) => directEntryGridColumn(key))
        .filter((column): column is DirectEntryGridColumn => column !== undefined),
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
          selectedRows={selectedClientRowId === null || selectedClientRowId === undefined
            ? new Set<string>()
            : new Set<string>([selectedClientRowId])}
          onSelectedRowsChange={(next) => {
            // P1.7-H06: chi giu mot clientRowId duy nhat cho contextual action
            // bar; nhieu selection (cheking box) duoc xem nhuf khong chon.
            if (next.size === 0) {
              if (selectedClientRowId !== null) onSelectedClientRowChange(null);
              return;
            }
            const only = next.values().next().value;
            if (typeof only === "string" && only !== selectedClientRowId) {
              onSelectedClientRowChange(only);
            }
          }}
        />
      </div>
    </div>
  );
}
