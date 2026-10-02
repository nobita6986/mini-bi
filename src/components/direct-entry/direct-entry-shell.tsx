"use client";

import { useCallback, useMemo, useState } from "react";
import { Dialog } from "radix-ui";
import { DataGrid, renderTextEditor, type Column, type RenderEditCellProps } from "react-data-grid";
import "react-data-grid/lib/styles.css";

import { RecruiterTypeahead, type PickerOption } from "@/components/direct-entry/typeahead-picker-smoke";
import {
  editDirectEntryRow,
  INITIAL_DIRECT_ENTRY_ROWS,
  stableDirectEntryRowKey,
  SYNTHETIC_RECRUITERS,
  type DirectEntryRow,
} from "@/lib/direct-entry/ui-model";
import styles from "./direct-entry-shell.module.css";

const pickerOptions: readonly PickerOption[] = SYNTHETIC_RECRUITERS.map((recruiter) => ({
  id: recruiter.id,
  label: recruiter.label,
  groupLabel: `${recruiter.provider} · Team ${recruiter.team}`,
  provider: recruiter.provider,
  team: recruiter.team,
}));

function RecruiterEditor({
  row,
  onRowChange,
}: RenderEditCellProps<DirectEntryRow>) {
  return (
    <RecruiterTypeahead
      id={`recruiter-${row.rowId}`}
      label="Người tuyển"
      options={pickerOptions}
      value={row.recruiterId}
      onChange={(recruiterId) => onRowChange({ ...row, recruiterId }, true)}
    />
  );
}

function DateEditor({ row, onRowChange }: RenderEditCellProps<DirectEntryRow>) {
  return (
    <input
      aria-label="Ngày bắt đầu làm"
      type="date"
      value={row.firstWorkDate}
      onChange={(event) => onRowChange({ ...row, firstWorkDate: event.currentTarget.value }, true)}
    />
  );
}

function textColumn(
  key: keyof DirectEntryRow,
  name: string,
  width: number,
): Column<DirectEntryRow> {
  return { key, name, width, editable: true, renderEditCell: renderTextEditor };
}

const columns: readonly Column<DirectEntryRow>[] = [
  textColumn("employeeCode", "Mã người lao động", 180),
  {
    key: "firstWorkDate",
    name: "Ngày bắt đầu làm",
    width: 155,
    editable: true,
    renderEditCell: DateEditor,
  },
  textColumn("workerLabel", "Người lao động", 180),
  textColumn("project", "Dự án", 210),
  {
    key: "recruiterId",
    name: "Người tuyển",
    width: 210,
    editable: true,
    renderCell: ({ row }) => pickerOptions.find(({ id }) => id === row.recruiterId)?.label ?? "Chưa chọn",
    renderEditCell: RecruiterEditor,
  },
  {
    key: "provider",
    name: "HRP/Vendor",
    width: 110,
    renderCell: ({ row }) => pickerOptions.find(({ id }) => id === row.recruiterId)?.provider ?? "—",
  },
  textColumn("laborType", "Loại hình", 155),
  textColumn("workStatus", "Trạng thái", 150),
];

const originalRows = new Map(INITIAL_DIRECT_ENTRY_ROWS.map((row) => [row.rowId, row]));

function rowIsDirty(row: DirectEntryRow): boolean {
  const initial = originalRows.get(row.rowId);
  return initial !== undefined && Object.keys(initial).some((key) =>
    initial[key as keyof DirectEntryRow] !== row[key as keyof DirectEntryRow],
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.field}>
      <span>{label}</span>
      {children}
    </div>
  );
}

export function DirectEntryShell() {
  const [rows, setRows] = useState<DirectEntryRow[]>(() => [...INITIAL_DIRECT_ENTRY_ROWS]);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [localSaved, setLocalSaved] = useState(false);
  const selectedRow = rows.find(({ rowId }) => rowId === selectedRowId) ?? null;
  const dirtyIds = useMemo(
    () => new Set(rows.filter(rowIsDirty).map(({ rowId }) => rowId)),
    [rows],
  );

  const updateRow = useCallback((rowId: string, patch: Partial<Omit<DirectEntryRow, "rowId">>) => {
    setRows((current) => editDirectEntryRow(current, rowId, patch));
    setLocalSaved(false);
  }, []);

  const onRowsChange = useCallback((updatedRows: DirectEntryRow[]) => {
    setRows(updatedRows);
    setLocalSaved(false);
  }, []);

  return (
    <main className={styles.page}>
      <div className={styles.banner} role="status">
        <strong>Dữ liệu thử nghiệm — thay đổi chưa được lưu</strong>
        <span>Chỉ dùng dữ liệu tổng hợp. Thay đổi ở trong bộ nhớ trang và có thể mất khi tải lại.</span>
      </div>

      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>P1.6 · Direct Entry · S02</p>
          <h1>Nhập liệu trực tiếp</h1>
          <p>Bản nháp · {rows.length} dòng · chưa kết nối máy chủ</p>
        </div>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => setLocalSaved(true)}
          aria-label="Lưu nháp cục bộ"
        >
          Lưu nháp
        </button>
      </header>

      <div className={styles.notice} aria-live="polite">
        {localSaved
          ? "Bản nháp chỉ được giữ trong bộ nhớ trang; dữ liệu chưa gửi lên máy chủ."
          : `Số dòng đã sửa: ${dirtyIds.size}. “Lưu nháp” chỉ mô phỏng lưu cục bộ.`}
      </div>

      <section className={styles.gridSection} aria-label="Bảng nhập liệu cho desktop và tablet">
        <p className={styles.gridHint}>Có thể chỉnh sửa trong bảng. Cuộn ngang bên trong bảng để xem các cột rộng.</p>
        <div className={styles.gridViewport}>
          <DataGrid<DirectEntryRow>
            aria-label="Dữ liệu thử nghiệm"
            className={styles.grid}
            columns={columns}
            onRowsChange={onRowsChange}
            rowClass={(row) => dirtyIds.has(row.rowId) ? styles.dirtyRow : undefined}
            rowHeight={42}
            rowKeyGetter={stableDirectEntryRowKey}
            rows={rows}
          />
        </div>
      </section>

      <section className={styles.mobileSection} aria-label="Danh sách cho màn hình di động">
        <ul className={styles.mobileList}>
          {rows.map((row) => (
            <li key={row.rowId}>
              <button
                type="button"
                className={`${styles.rowCard} ${dirtyIds.has(row.rowId) ? styles.rowCardDirty : ""}`}
                onClick={() => setSelectedRowId(row.rowId)}
                aria-label={`Chỉnh sửa dòng ${row.employeeCode}`}
              >
                <span className={styles.rowCardTop}>
                  <strong>{row.employeeCode}</strong>
                  {dirtyIds.has(row.rowId) && <span className={styles.dirtyBadge}>Đã sửa</span>}
                </span>
                <span>{row.workerLabel}</span>
                <span className={styles.rowCardMeta}>{row.project} · {row.workStatus}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Dialog.Root
        open={selectedRow !== null}
        onOpenChange={(open) => { if (!open) setSelectedRowId(null); }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.drawerOverlay} />
          {selectedRow && (
            <Dialog.Content className={styles.drawer} aria-describedby="direct-entry-drawer-description">
              <Dialog.Title className={styles.drawerTitle}>Chỉnh sửa dòng dữ liệu</Dialog.Title>
              <Dialog.Description id="direct-entry-drawer-description" className={styles.drawerDescription}>
                Thay đổi chỉ ở trong bộ nhớ trang và có thể mất sau khi tải lại.
              </Dialog.Description>
              <div className={styles.drawerFields}>
                <Field label="Mã người lao động">
                  <input aria-label="Mã người lao động" value={selectedRow.employeeCode} onChange={(event) => updateRow(selectedRow.rowId, { employeeCode: event.target.value })} />
                </Field>
                <Field label="Ngày bắt đầu làm">
                  <input aria-label="Ngày bắt đầu làm" type="date" value={selectedRow.firstWorkDate} onChange={(event) => updateRow(selectedRow.rowId, { firstWorkDate: event.target.value })} />
                </Field>
                <Field label="Người lao động">
                  <input aria-label="Người lao động" value={selectedRow.workerLabel} onChange={(event) => updateRow(selectedRow.rowId, { workerLabel: event.target.value })} />
                </Field>
                <Field label="Dự án">
                  <input aria-label="Dự án" value={selectedRow.project} onChange={(event) => updateRow(selectedRow.rowId, { project: event.target.value })} />
                </Field>
                <div className={styles.field}>
                  <RecruiterTypeahead
                    id={`mobile-recruiter-${selectedRow.rowId}`}
                    options={pickerOptions}
                    value={selectedRow.recruiterId}
                    onChange={(recruiterId) => updateRow(selectedRow.rowId, { recruiterId })}
                  />
                </div>
                <p className={styles.derivedValue}>
                  HRP/Vendor được suy ra: <strong>{pickerOptions.find(({ id }) => id === selectedRow.recruiterId)?.provider}</strong>
                </p>
                <Field label="Loại hình làm việc">
                  <select aria-label="Loại hình làm việc" value={selectedRow.laborType} onChange={(event) => updateRow(selectedRow.rowId, { laborType: event.target.value as DirectEntryRow["laborType"] })}>
                    <option>Toàn thời gian</option><option>Thời vụ</option>
                  </select>
                </Field>
                <Field label="Trạng thái làm việc">
                  <select aria-label="Trạng thái làm việc" value={selectedRow.workStatus} onChange={(event) => {
                    const workStatus = event.currentTarget.value;
                    if (workStatus === "Chưa xác nhận" || workStatus === "Đang làm" || workStatus === "Đã nghỉ") {
                      updateRow(selectedRow.rowId, { workStatus });
                    }
                  }}>
                    <option>Chưa xác nhận</option><option>Đang làm</option><option>Đã nghỉ</option>
                  </select>
                </Field>
              </div>
              <div className={styles.drawerActions}>
                <Dialog.Close asChild><button type="button" className={styles.secondaryButton}>Quay lại danh sách</button></Dialog.Close>
                <Dialog.Close asChild><button type="button" className={styles.primaryButton} onClick={() => setLocalSaved(true)}>Lưu nháp cục bộ</button></Dialog.Close>
              </div>
            </Dialog.Content>
          )}
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
