"use client";

import { useCallback, useState } from "react";
import { DataGrid, type Column } from "react-data-grid";

interface SmokeRow {
  rowId: string;
  project: string;
}

const columns: readonly Column<SmokeRow>[] = [
  { key: "project", name: "Project", editable: true },
];

const rowKeyGetter = (row: SmokeRow) => row.rowId;

export function GridSmoke() {
  const [rows, setRows] = useState<SmokeRow[]>([{ rowId: "synthetic-row-1", project: "Sample" }]);
  const onRowsChange = useCallback((updatedRows: SmokeRow[]) => {
    setRows(updatedRows);
  }, []);

  return (
    <DataGrid<SmokeRow>
      aria-label="Grid dependency smoke test"
      columns={columns}
      onRowsChange={onRowsChange}
      rowKeyGetter={rowKeyGetter}
      rows={rows}
    />
  );
}
