import assert from "node:assert/strict";
import test from "node:test";

import {
  DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS,
  directEntryGridColumn,
} from "./direct-entry-grid-columns.ts";
import { mapClipboardFromAnchor } from "./direct-entry-grid-clipboard.ts";
import {
  DRAFT_EDITABLE_GRID_FIELDS,
  applyLiveGridPaste,
  undoLiveGridPaste,
} from "./live-grid-paste.ts";
import { createSpreadsheetRowModel } from "./spreadsheet-row-model.ts";
import {
  portraitRowBinding,
  selectBindablePortraitStages,
} from "./worker-portrait-stage-client.ts";

const columns = DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS
  .map((key) => directEntryGridColumn(key))
  .filter(Boolean);

function mapping(matrix, rowIndex = 0, columnKey = "display_name") {
  const result = mapClipboardFromAnchor({
    matrix,
    anchor: {
      rowIndex,
      columnIndex: columns.findIndex((column) => column.key === columnKey),
    },
    columns,
    maxRows: 101,
  });
  assert.equal(result.ok, true);
  return result;
}

function liveRow(overrides = {}) {
  return {
    rowId: "entry-1",
    entryId: "11111111-1111-4111-8111-111111111111",
    submissionId: "22222222-2222-4222-8222-222222222222",
    entryVersion: 3,
    submissionVersion: 4,
    employeeCode: "hrp-2026-000001",
    firstWorkDate: "2026-10-19",
    workerName: "Người cũ",
    projectId: "project-1",
    recruiterId: "33333333-3333-4333-8333-333333333333",
    laborType: "TEMPORARY",
    providerType: "hrp",
    profile: {
      contract_version: "worker-profile/1.0",
      worker_details: {
        display_name: { state: "provided", value: "Người cũ" },
        gender: { state: "omitted" },
        date_of_birth: { state: "omitted" },
        national_id: { state: "provided", value: "001OLD" },
        national_id_issued_at: { state: "omitted" },
        national_id_issued_place: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "provided", value: "0900000000" },
      },
      general_note: { state: "omitted" },
      employment: { status: "ON", effective_date: "2026-10-19" },
      payment: null,
    },
    laborTypeDisplay: "Thời vụ",
    teamId: "team-1",
    teamDisplayName: "Team 1",
    projectDisplayName: "Dự án 1",
    recruiterDisplayName: "Recruiter 1",
    employmentStatus: "ON",
    state: "clean",
    saved: null,
    pendingWrite: null,
    conflictCopy: null,
    message: null,
    ...overrides,
  };
}

function gridRows(rows, model, options = {}) {
  return [
    ...rows.map((row) => ({
      clientRowId: row.rowId,
      persisted: true,
      clientStaged: false,
      locked: options.locked === true,
      editableFields: options.editableFields ?? DRAFT_EDITABLE_GRID_FIELDS,
      cells: {
        display_name: row.workerName,
        phone: row.profile.worker_details.phone.value ?? "",
        national_id: row.profile.worker_details.national_id.value ?? "",
      },
    })),
    ...model.rows.map((row) => ({
      clientRowId: row.clientRowId,
      persisted: false,
      clientStaged: true,
      locked: false,
      editableFields: ["provider_type", ...Object.keys(row.cells)],
      cells: row.cells,
    })),
  ];
}

function apply({ rows = [], model = createSpreadsheetRowModel(), map, options }) {
  return applyLiveGridPaste({
    mapping: map,
    gridRows: gridRows(rows, model, options),
    liveRows: rows,
    stagedModel: model,
    recruiters: [],
    laborTypeDefault: "TEMPORARY",
    now: new Date("2026-10-19T00:00:00.000Z"),
  });
}

test("paste saved-only cập nhật đúng persisted DRAFT và không đụng staged rows", () => {
  const row = liveRow();
  const model = createSpreadsheetRowModel();
  const result = apply({
    rows: [row],
    model,
    map: mapping([["Người mới", "0911111111"]]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.liveRows[0].workerName, "Người mới");
  assert.deepEqual(result.liveRows[0].profile.worker_details.phone,
    { state: "provided", value: "0911111111" });
  assert.equal(result.liveRows[0].state, "dirty");
  assert.deepEqual(result.stagedModel, model);
});

test("paste staged-only giữ clientRowId và áp đúng hàng/cột", () => {
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  const result = apply({
    model,
    map: mapping([["Người staged", "0922222222"]]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.stagedModel.rows[0].clientRowId, firstId);
  assert.equal(result.stagedModel.rows[0].cells.display_name, "Người staged");
  assert.equal(result.stagedModel.rows[0].cells.phone, "0922222222");
});

test("paste mixed cập nhật persisted và staged trong cùng một kết quả atomic", () => {
  const row = liveRow();
  const model = createSpreadsheetRowModel();
  const stagedId = model.rows[0].clientRowId;
  const result = apply({
    rows: [row],
    model,
    map: mapping([
      ["Persisted mới", "0933333333"],
      ["Staged mới", "0944444444"],
    ]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.liveRows[0].workerName, "Persisted mới");
  assert.equal(result.stagedModel.rows[0].clientRowId, stagedId);
  assert.equal(result.stagedModel.rows[0].cells.display_name, "Staged mới");
  assert.equal(result.stagedModel.rows[0].cells.phone, "0944444444");
});

test("locked row hoặc cột ngoài allowlist từ chối toàn bộ và không ghi dở", () => {
  const row = liveRow();
  const model = createSpreadsheetRowModel();
  const locked = apply({
    rows: [row], model, map: mapping([["Không được ghi"]]), options: { locked: true },
  });
  assert.deepEqual(locked, { ok: false, code: "CLIPBOARD_PROTECTED_CELL" });
  assert.equal(row.workerName, "Người cũ");
  assert.equal(model.rows[0].cells.display_name, "");

  const protectedColumn = apply({
    rows: [row],
    model,
    map: mapping([["0955555555"]], 0, "phone"),
    options: { editableFields: ["display_name"] },
  });
  assert.deepEqual(protectedColumn, { ok: false, code: "CLIPBOARD_PROTECTED_CELL" });
  assert.deepEqual(row.profile.worker_details.phone, { state: "provided", value: "0900000000" });

  const systemOwned = apply({
    rows: [row],
    model,
    map: mapping([["1"]], 0, "row_index"),
  });
  assert.deepEqual(systemOwned, { ok: false, code: "CLIPBOARD_PROTECTED_CELL" });
});

test("target mapping invalid từ chối trước khi đổi bất kỳ state nào", () => {
  const row = liveRow();
  const model = createSpreadsheetRowModel();
  const valid = mapping([["Không được ghi"]]);
  const moved = (cells) => cells.map((cell) => ({ ...cell, rowIndex: 101 }));
  const invalid = {
    ...valid,
    cells: moved(valid.cells),
    writeCells: moved(valid.writeCells),
    validationCells: moved(valid.validationCells),
    ignoredCells: moved(valid.ignoredCells),
  };
  const result = apply({ rows: [row], model, map: invalid });
  assert.deepEqual(result, { ok: false, code: "CLIPBOARD_TARGET_INVALID" });
  assert.equal(row.workerName, "Người cũ");
  assert.equal(model.rows[0].cells.display_name, "");
});

test("undo mixed khôi phục cả persisted và staged", () => {
  const row = liveRow();
  const model = createSpreadsheetRowModel();
  const result = apply({
    rows: [row],
    model,
    map: mapping([["Persisted mới"], ["Staged mới"]]),
  });
  assert.equal(result.ok, true);
  const restored = undoLiveGridPaste({
    snapshot: result.undo,
    liveRows: result.liveRows,
    stagedModel: result.stagedModel,
    laborTypeDefault: "TEMPORARY",
    now: new Date("2026-10-19T00:00:00.000Z"),
  });
  assert.deepEqual(restored.liveRows[0], row);
  assert.equal(restored.stagedModel.rows[0].cells.display_name, "");
});

test("paste đổi định danh làm binding cũ không còn bindable cho portrait/document stage", () => {
  const model = createSpreadsheetRowModel();
  const rowKey = model.rows[0].clientRowId;
  const oldBinding = portraitRowBinding({
    rowKey,
    employeeCode: "",
    displayName: "Người cũ",
    firstWorkDate: "2026-10-19",
    projectId: "project-1",
    recruiterId: "recruiter-1",
    laborType: "TEMPORARY",
    nationalId: "001OLD",
    dateOfBirth: "",
    phone: "0900000000",
  });
  const result = apply({
    model,
    map: mapping([["Người mới", "0911111111"]]),
  });
  assert.equal(result.ok, true);
  const updated = result.stagedModel.rows[0];
  const newBinding = portraitRowBinding({
    rowKey: updated.clientRowId,
    employeeCode: "",
    displayName: updated.cells.display_name,
    firstWorkDate: updated.cells.first_work_date,
    projectId: updated.cells.project_id,
    recruiterId: updated.cells.recruiter_id,
    laborType: updated.cells.labor_type,
    nationalId: updated.cells.national_id,
    dateOfBirth: updated.cells.date_of_birth,
    phone: updated.cells.phone,
  });
  assert.notEqual(newBinding, oldBinding);
  assert.equal(selectBindablePortraitStages({
    rowBindings: new Map([[rowKey, newBinding]]),
    slots: new Map([[rowKey, {
      binding: oldBinding,
      status: "staged",
      stageId: "44444444-4444-4444-8444-444444444444",
    }]]),
  }).size, 0);
});
