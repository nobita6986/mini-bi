"use client";

import { DataGrid, type Column, type RenderEditCellProps } from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  formatEmployeeCode,
  parseClipboardMatrix,
  recruiterOptions,
  searchRecruiters,
  validateEmployeeCode,
} from "@/lib/grid-spike-helpers.mjs";
import styles from "./grid-spike.module.css";

type RecruiterGroup = "HRP" | "Vendor";
type Row = {
  rowId: number;
  project: string;
  startDate: string;
  employeeCode: string;
  name: string;
  recruiterGroup: RecruiterGroup;
  recruiterId: string;
  laborType: string;
  accountNumber: string;
  bank: string;
  accountHolder: string;
  profileStatus: string;
  active: boolean;
};
type Field = Exclude<keyof Row, "rowId">;

const projects = ["Dự án Ánh Dương", "Dự án Bình An", "Dự án Cánh Diều", "Dự án Đại Lộ"];
const laborTypes = ["Toàn thời gian", "Thời vụ", "Cộng tác viên"];
const profileStatuses = ["Đủ hồ sơ", "Đang bổ sung", "Chờ xác minh"];
const bankNames = ["", "Ngân hàng A", "Ngân hàng B", "Ngân hàng C"];
const pasteFields: (Field | null)[] = [
  null, "project", "startDate", "employeeCode", "name", "recruiterGroup",
  "recruiterId", "laborType", "accountNumber", "bank", "accountHolder",
  "profileStatus", null,
];

function pasteCell(row: Row, field: Field, value: string): Row {
  switch (field) {
    case "startDate": {
      const suffix = row.employeeCode.match(/^hrp-\d{4}-(\d+)$/)?.[1];
      return {
        ...row,
        startDate: value,
        employeeCode: suffix ? formatEmployeeCode(value, suffix) : row.employeeCode,
      };
    }
    case "recruiterId": {
      const recruiter = recruiterOptions.find((option) => option.name === value);
      return recruiter
        ? { ...row, recruiterId: recruiter.id, recruiterGroup: recruiter.group }
        : row;
    }
    case "recruiterGroup":
      return value === "HRP" || value === "Vendor" ? { ...row, recruiterGroup: value } : row;
    case "active":
      return row;
    default:
      return { ...row, [field]: value };
  }
}

function makeRows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => {
    const startDate = `2026-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 27) + 1).padStart(2, "0")}`;
    const recruiter = recruiterOptions[index % recruiterOptions.length];
    return {
      rowId: index + 1,
      project: projects[index % projects.length],
      startDate,
      employeeCode: formatEmployeeCode(startDate, String(index + 1).padStart(5, "0")),
      name: `Nhân sự giả danh ${String(index + 1).padStart(5, "0")}`,
      recruiterGroup: recruiter.group === "HRP" ? "HRP" : "Vendor",
      recruiterId: recruiter.id,
      laborType: laborTypes[index % laborTypes.length],
      accountNumber: "",
      bank: "",
      accountHolder: "",
      profileStatus: index % 3 === 0 ? "Đủ hồ sơ" : "Đang bổ sung",
      active: index % 5 !== 0,
    };
  });
}

function BasicEditor({ row, onRowChange, field, label }: RenderEditCellProps<Row> & {
  field: Field;
  label: string;
}) {
  const value = String(row[field] ?? "");
  return (
    <input
      aria-label={label}
      autoFocus
      className={styles.editor}
      onChange={(event) => onRowChange({ ...row, [field]: event.target.value })}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        if (event.nativeEvent.isComposing) {
          event.stopPropagation();
          return;
        }
        onRowChange({ ...row, [field]: value }, true);
      }}
      value={value}
    />
  );
}

function SelectEditor({ row, onRowChange, field, label, options }: RenderEditCellProps<Row> & {
  field: Field;
  label: string;
  options: string[];
}) {
  return (
    <select
      aria-label={label}
      autoFocus
      className={styles.editor}
      onChange={(event) => onRowChange({ ...row, [field]: event.target.value }, true)}
      value={String(row[field])}
    >
      {options.map((option) => <option key={option} value={option}>{option || "Chưa chọn"}</option>)}
    </select>
  );
}

function DateEditor({ row, onRowChange }: RenderEditCellProps<Row>) {
  return (
    <input
      aria-label="Ngày đầu tiên đi làm"
      autoFocus
      className={styles.editor}
      onChange={(event) => {
        const startDate = event.target.value;
        const suffix = row.employeeCode.match(/^hrp-\d{4}-(\d+)$/)?.[1] ?? "";
        onRowChange({
          ...row,
          startDate,
          employeeCode: formatEmployeeCode(startDate, suffix),
        });
      }}
      type="date"
      value={row.startDate}
    />
  );
}

function EmployeeCodeEditor({ row, onRowChange }: RenderEditCellProps<Row>) {
  const suffix = row.employeeCode.match(/^hrp-\d{4}-(\d+)$/)?.[1] ?? "";
  return (
    <label className={styles.codeEditor}>
      <span aria-hidden="true">hrp-{row.startDate.slice(0, 4)}-</span>
      <input
        aria-label="Mã NLĐ, nhập phần số"
        autoFocus
        className={styles.editor}
        inputMode="numeric"
        onChange={(event) => onRowChange({
          ...row,
          employeeCode: formatEmployeeCode(row.startDate, event.target.value),
        })}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          if (event.nativeEvent.isComposing) {
            event.stopPropagation();
            return;
          }
          onRowChange(row, true);
        }}
        pattern="[0-9]*"
        value={suffix}
      />
    </label>
  );
}

function RecruiterEditor({ row, onRowChange }: RenderEditCellProps<Row>) {
  const current = recruiterOptions.find(({ id }) => id === row.recruiterId);
  const [query, setQuery] = useState(current?.name ?? "");
  const [group, setGroup] = useState<"all" | RecruiterGroup>("all");
  const [activeOption, setActiveOption] = useState(0);
  const options = searchRecruiters(query, group);
  const visibleOptions = options.slice(0, 8);
  const chooseRecruiter = (option: (typeof recruiterOptions)[number]) => {
    onRowChange({ ...row, recruiterId: option.id, recruiterGroup: option.group }, true);
  };

  return (
    <div className={styles.recruiterEditor}>
      <select
        aria-label="Lọc người tuyển theo nhóm"
        onChange={(event) => {
          const value = event.target.value;
          if (value === "all" || value === "HRP" || value === "Vendor") {
            setGroup(value);
            setActiveOption(0);
          }
        }}
        value={group}
      >
        <option value="all">Tất cả</option>
        <option value="HRP">HRP</option>
        <option value="Vendor">Vendor</option>
      </select>
      <input
        aria-label="Người tuyển"
        aria-autocomplete="list"
        aria-expanded={options.length > 0}
        aria-controls="recruiter-suggestions"
        aria-activedescendant={visibleOptions[activeOption] ? `recruiter-option-${visibleOptions[activeOption].id}` : undefined}
        autoComplete="off"
        autoFocus
        className={styles.editor}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveOption(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && visibleOptions.length > 0) {
            event.preventDefault();
            setActiveOption((index) => (index + 1) % visibleOptions.length);
          } else if (event.key === "ArrowUp" && visibleOptions.length > 0) {
            event.preventDefault();
            setActiveOption((index) => (index + visibleOptions.length - 1) % visibleOptions.length);
          } else if (event.key === "Enter") {
            if (event.nativeEvent.isComposing) {
              event.stopPropagation();
            } else if (visibleOptions[activeOption]) {
              chooseRecruiter(visibleOptions[activeOption]);
            }
          }
        }}
        role="combobox"
        value={query}
      />
      <div aria-label="Gợi ý người tuyển" className={styles.suggestions} id="recruiter-suggestions" role="listbox">
        {visibleOptions.map((option, index) => (
          <button
            aria-selected={index === activeOption}
            id={`recruiter-option-${option.id}`}
            key={option.id}
            onClick={() => chooseRecruiter(option)}
            role="option"
            type="button"
          >
            {option.name} <span>{option.group}</span>
          </button>
        ))}
        {options.length === 0 && <p className={styles.noResults}>Không có gợi ý phù hợp.</p>}
      </div>
    </div>
  );
}

const rowKeyGetter = (row: Row) => row.rowId;

export default function GridSpike() {
  const [size, setSize] = useState(500);
  const [rows, setRows] = useState(() => makeRows(500));
  const [dirty, setDirty] = useState(false);
  const [pasteNotice, setPasteNotice] = useState("");
  const [selectedMobileRow, setSelectedMobileRow] = useState<number | null>(null);
  const benchmarkStart = useRef(0);
  const [renderMs, setRenderMs] = useState<number | null>(null);
  const [lastEditMs, setLastEditMs] = useState<number | null>(null);
  const pasteContext = useRef<{ rowIndex: number; columnIndex: number; matrix: string[][] } | null>(null);

  useEffect(() => {
    const start = performance.now();
    requestAnimationFrame(() => setRenderMs(Number((performance.now() - start).toFixed(1))));
  }, []);

  const validation = useMemo(() => {
    const codes = new Map<string, number>();
    for (const row of rows) codes.set(row.employeeCode, (codes.get(row.employeeCode) ?? 0) + 1);
    const byRow = new Map<number, string | null>();
    let errorCount = 0;
    for (const row of rows) {
      const error = codes.get(row.employeeCode)! > 1
        ? "Mã NLĐ bị trùng trong danh sách."
        : validateEmployeeCode(row.employeeCode, row.startDate);
      byRow.set(row.rowId, error);
      if (error) errorCount += 1;
    }
    return { byRow, errorCount };
  }, [rows]);
  const { byRow: validationByRow, errorCount } = validation;

  const commitRows = useCallback((changedRows: Row[]) => {
    let nextRows = changedRows;
    const paste = pasteContext.current;
    pasteContext.current = null;
    if (paste) {
      nextRows = [...changedRows];
      let unknownRecruiters = 0;
      paste.matrix.forEach((pastedRow, rowOffset) => {
        const targetIndex = paste.rowIndex + rowOffset;
        if (!nextRows[targetIndex]) return;
        let targetRow = nextRows[targetIndex];
        pastedRow.forEach((value, columnOffset) => {
          const field = pasteFields[paste.columnIndex + columnOffset];
          if (field === "recruiterId" && !recruiterOptions.some((option) => option.name === value)) {
            unknownRecruiters += 1;
          } else if (field) {
            targetRow = pasteCell(targetRow, field, value);
          }
        });
        nextRows[targetIndex] = targetRow;
      });
      setPasteNotice(unknownRecruiters
        ? `${unknownRecruiters} người tuyển không khớp danh mục; không lưu text tự do.`
        : `Đã dán ma trận ${paste.matrix.length} dòng.`);
    }
    const updateStart = performance.now();
    setDirty(true);
    setRows(nextRows);
    requestAnimationFrame(() => setLastEditMs(Number((performance.now() - updateStart).toFixed(1))));
  }, []);

  const columns = useMemo<readonly Column<Row>[]>(() => [
    { key: "number", name: "STT", width: 62, frozen: true, renderCell: ({ rowIdx }) => rowIdx + 1 },
    {
      key: "project", name: "Dự án", width: 180, editable: true,
      renderEditCell: (props) => <SelectEditor {...props} field="project" label="Dự án" options={projects} />,
    },
    {
      key: "startDate", name: "Ngày đầu tiên đi làm", width: 175, editable: true,
      renderEditCell: DateEditor,
    },
    {
      key: "employeeCode", name: "Mã NLĐ", width: 160, editable: true,
      cellClass: (row) => validationByRow.get(row.rowId) ? styles.invalidCell : "",
      renderCell: ({ row }) => {
        const error = validationByRow.get(row.rowId);
        return (
          <span aria-label={error ? `${row.employeeCode}. Lỗi: ${error}` : row.employeeCode} title={error ?? undefined}>
            {row.employeeCode}{error && <small className={styles.cellError}> · Lỗi</small>}
          </span>
        );
      },
      renderEditCell: EmployeeCodeEditor,
    },
    { key: "name", name: "Họ tên giả danh", width: 220, editable: true,
      renderEditCell: (props) => <BasicEditor {...props} field="name" label="Họ tên giả danh" /> },
    {
      key: "recruiterGroup", name: "HRP/Vendor", width: 120, editable: true,
      renderEditCell: (props) => <SelectEditor {...props} field="recruiterGroup" label="HRP hoặc Vendor" options={["HRP", "Vendor"]} />,
    },
    {
      key: "recruiterId", name: "Người tuyển", width: 190, editable: true,
      renderCell: ({ row }) => recruiterOptions.find(({ id }) => id === row.recruiterId)?.name ?? "Chưa gán",
      renderEditCell: RecruiterEditor,
    },
    {
      key: "laborType", name: "Loại hình lao động", width: 165, editable: true,
      renderEditCell: (props) => <SelectEditor {...props} field="laborType" label="Loại hình lao động" options={laborTypes} />,
    },
    { key: "accountNumber", name: "STK (tùy chọn)", width: 150, editable: true,
      renderEditCell: (props) => <BasicEditor {...props} field="accountNumber" label="Số tài khoản" /> },
    {
      key: "bank", name: "Ngân hàng (tùy chọn)", width: 175, editable: true,
      renderEditCell: (props) => <SelectEditor {...props} field="bank" label="Ngân hàng" options={bankNames} />,
    },
    { key: "accountHolder", name: "Tên chủ tài khoản (tùy chọn)", width: 230, editable: true,
      renderEditCell: (props) => <BasicEditor {...props} field="accountHolder" label="Tên chủ tài khoản" /> },
    {
      key: "profileStatus", name: "Trạng thái hồ sơ", width: 150, editable: true,
      renderCell: ({ row }) => <span className={styles.status}>{row.profileStatus}</span>,
      renderEditCell: (props) => <SelectEditor {...props} field="profileStatus" label="Trạng thái hồ sơ" options={profileStatuses} />,
    },
    { key: "active", name: "ON/OFF", width: 90, renderCell: ({ row }) => row.active ? "ON" : "OFF" },
  ], [validationByRow]);

  function changeSize(nextSize: number) {
    benchmarkStart.current = performance.now();
    setSize(nextSize);
    setRows(makeRows(nextSize));
    setDirty(false);
    setLastEditMs(null);
    setPasteNotice("");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setRenderMs(Number((performance.now() - benchmarkStart.current).toFixed(1)));
    }));
  }

  function updateRow(rowId: number, field: Field, value: string) {
    setRows((currentRows) => currentRows.map((row) => row.rowId === rowId
      ? { ...row, [field]: value }
      : row));
    setDirty(true);
  }

  function saveDemo() {
    setDirty(false);
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>TECHNICAL SPIKE · CHỈ DỮ LIỆU GIẢ DANH</p>
          <h1>Form tuyển dụng dạng bảng</h1>
          <p>Prototype tương tác — không ghi dữ liệu và không kết nối dịch vụ.</p>
        </div>
        <div className={styles.actions}>
          <label htmlFor="row-count">Số dòng benchmark</label>
          <select id="row-count" onChange={(event) => changeSize(Number(event.target.value))} value={size}>
            {[500, 5000, 20000].map((count) => <option key={count}>{count}</option>)}
          </select>
          <button className={styles.saveButton} onClick={saveDemo} type="button">Đánh dấu đã lưu (demo)</button>
        </div>
      </header>

      <section className={styles.stateBar} aria-label="Trạng thái bản nháp">
        <span className={dirty ? styles.dirty : styles.saved} role="status">
          {dirty ? "● Chưa lưu thay đổi" : "✓ Không có thay đổi chưa lưu"}
        </span>
        <span className={errorCount > 0 ? styles.error : styles.ok} role="status">
          {errorCount ? `${errorCount} dòng có lỗi mã NLĐ` : "Không có lỗi mã NLĐ"}
        </span>
        {pasteNotice && <span role="status">{pasteNotice}</span>}
        <span>{renderMs === null ? "Đang đo khởi tạo…" : `Render sau đổi kích thước: ${renderMs} ms`}</span>
        <span>{lastEditMs === null ? "Chỉnh sửa: chưa đo" : `Cập nhật tới frame kế tiếp: ${lastEditMs} ms`}</span>
      </section>
      <p className={styles.hint}>
        Grid: Enter để sửa · Tab/Shift+Tab để di chuyển · mũi tên để chọn ô · Ctrl/Cmd+C,V để copy/paste.
      </p>

      <section className={styles.gridRegion} aria-label="Bảng dữ liệu tuyển dụng">
        <DataGrid
          aria-label="Bảng tuyển dụng giả danh"
          className={styles.grid}
          columns={columns}
          onRowsChange={commitRows}
          onCellCopy={({ column, row }, event) => {
            const field = pasteFields[column.idx];
            if (!field) return;
            const value = field === "recruiterId"
              ? recruiterOptions.find((option) => option.id === row.recruiterId)?.name ?? ""
              : String(row[field] ?? "");
            event.clipboardData.setData("text/plain", value);
            event.preventDefault();
          }}
          onCellPaste={({ column, row }, event) => {
            const matrix = parseClipboardMatrix(event.clipboardData.getData("text/plain"));
            pasteContext.current = {
              rowIndex: rows.findIndex((candidate) => candidate.rowId === row.rowId),
              columnIndex: column.idx,
              matrix,
            };
            return { ...row };
          }}
          rowClass={(row) => validationByRow.get(row.rowId) ? styles.invalidRow : undefined}
          rowHeight={36}
          rowKeyGetter={rowKeyGetter}
          rows={rows}
        />
      </section>

      <section className={styles.mobileList} aria-label="Danh sách tuyển dụng trên màn hình nhỏ">
        <div className={styles.mobileHeading}>
          <h2>Danh sách nhân sự ({rows.length})</h2>
          <p>Chọn một dòng để mở biểu mẫu chỉnh sửa. Spike chỉ hiển thị 100 dòng đầu.</p>
        </div>
        {rows.slice(0, 100).map((row) => (
          <button
            className={styles.mobileRow}
            key={row.rowId}
            onClick={() => setSelectedMobileRow(row.rowId)}
            type="button"
          >
            <span><strong>{row.name}</strong><small>{row.employeeCode} · {row.project}</small></span>
            <span aria-hidden="true">›</span>
          </button>
        ))}
      </section>

      {selectedMobileRow !== null && (() => {
        const row = rows.find(({ rowId }) => rowId === selectedMobileRow);
        if (!row) return null;
        return (
          <div className={styles.drawerBackdrop} onClick={() => setSelectedMobileRow(null)}>
            <section
              aria-labelledby="edit-row-title"
              aria-modal="true"
              className={styles.drawer}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Escape") setSelectedMobileRow(null);
              }}
              role="dialog"
            >
              <header><h2 id="edit-row-title">Chỉnh sửa dòng {row.rowId}</h2><button onClick={() => setSelectedMobileRow(null)} type="button">Đóng</button></header>
              <label>Dự án<select autoFocus value={row.project} onChange={(event) => updateRow(row.rowId, "project", event.target.value)}>{projects.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label>Ngày đầu tiên đi làm<input type="date" value={row.startDate} onChange={(event) => {
                const startDate = event.target.value;
                const suffix = row.employeeCode.match(/^hrp-\d{4}-(\d+)$/)?.[1] ?? "";
                setRows((current) => current.map((item) => item.rowId === row.rowId ? { ...item, startDate, employeeCode: formatEmployeeCode(startDate, suffix) } : item));
                setDirty(true);
              }} /></label>
              <label>Mã NLĐ <input
                aria-describedby={`employee-code-error-${row.rowId}`}
                aria-invalid={Boolean(validationByRow.get(row.rowId))}
                value={row.employeeCode}
                onChange={(event) => updateRow(row.rowId, "employeeCode", event.target.value)}
              /><small id={`employee-code-error-${row.rowId}`} role="status">{validationByRow.get(row.rowId) ?? "Định dạng hrp-YYYY-số; giữ nguyên số 0 đầu."}</small></label>
              <label>Họ tên giả danh<input value={row.name} onChange={(event) => updateRow(row.rowId, "name", event.target.value)} /></label>
              <label>HRP/Vendor<select value={row.recruiterGroup} onChange={(event) => {
                if (event.target.value === "HRP" || event.target.value === "Vendor") {
                  updateRow(row.rowId, "recruiterGroup", event.target.value);
                }
              }}><option>HRP</option><option>Vendor</option></select></label>
              <label>Người tuyển<select value={row.recruiterId} onChange={(event) => {
                const recruiter = recruiterOptions.find(({ id }) => id === event.target.value)!;
                setRows((current) => current.map((item) => item.rowId === row.rowId ? { ...item, recruiterId: recruiter.id, recruiterGroup: recruiter.group } : item));
                setDirty(true);
              }}>{recruiterOptions.map(({ id, name, group }) => <option key={id} value={id}>{name} · {group}</option>)}</select></label>
              <label>Loại hình lao động<select value={row.laborType} onChange={(event) => updateRow(row.rowId, "laborType", event.target.value)}>{laborTypes.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label>Số tài khoản (tùy chọn)<input value={row.accountNumber} onChange={(event) => updateRow(row.rowId, "accountNumber", event.target.value)} /></label>
              <label>Ngân hàng (tùy chọn)<select value={row.bank} onChange={(event) => updateRow(row.rowId, "bank", event.target.value)}>{bankNames.map((item) => <option key={item}>{item || "Chưa chọn"}</option>)}</select></label>
              <label>Tên chủ tài khoản (tùy chọn)<input value={row.accountHolder} onChange={(event) => updateRow(row.rowId, "accountHolder", event.target.value)} /></label>
              <label>Trạng thái hồ sơ<select value={row.profileStatus} onChange={(event) => updateRow(row.rowId, "profileStatus", event.target.value)}>{profileStatuses.map((item) => <option key={item}>{item}</option>)}</select></label>
              <p>ON/OFF: <strong>{row.active ? "ON" : "OFF"}</strong> (chỉ đọc)</p>
              <p className={styles.validationText} role="status">{validationByRow.get(row.rowId) ?? "Dòng hợp lệ"}</p>
              <button className={styles.saveButton} onClick={() => setSelectedMobileRow(null)} type="button">Hoàn tất</button>
            </section>
          </div>
        );
      })()}
    </main>
  );
}
