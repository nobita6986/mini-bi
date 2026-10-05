import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { WORKER_PROFILE_FIELDS } from "./worker-profile-import-contract.ts";
import {
  SPREADSHEET_INITIAL_ROW_COUNT,
  SPREADSHEET_MAX_DATA_ROWS,
  SPREADSHEET_SPARE_ROW_COUNT,
  SPREADSHEET_WRITABLE_FIELD_KEYS,
  SpreadsheetDataRowLimitError,
  clearSpreadsheetRow,
  createSpreadsheetRowModel,
  deleteSpreadsheetRow,
  duplicateSpreadsheetRow,
  selectNonEmptySpreadsheetRows,
  spreadsheetRowIsBlank,
  updateSpreadsheetRowProviderType,
  updateSpreadsheetRowCells,
} from "./spreadsheet-row-model.ts";

test("initializes 30 client-only blank rows with stable unique IDs and canonical writable fields", () => {
  const model = createSpreadsheetRowModel();
  const expectedKeys = WORKER_PROFILE_FIELDS.filter((field) => field.persisted)
    .filter((field) => field.key !== "employee_code")
    .map((field) => field.key);

  assert.equal(model.rows.length, SPREADSHEET_INITIAL_ROW_COUNT);
  assert.equal(new Set(model.rows.map((row) => row.clientRowId)).size, model.rows.length);
  assert.deepEqual(SPREADSHEET_WRITABLE_FIELD_KEYS, expectedKeys);
  for (const row of model.rows) {
    assert.equal(spreadsheetRowIsBlank(row), true);
    assert.deepEqual(Object.keys(row.cells), expectedKeys);
    assert.equal(Object.values(row.cells).every((value) => value === ""), true);
    assert.match(row.clientRowId, /^spreadsheet-row-[1-9][0-9]*$/);
  }
});

test("partial user data makes a row non-empty while whitespace-only cells stay blank", () => {
  const initial = createSpreadsheetRowModel();
  const firstId = initial.rows[0].clientRowId;
  const whitespace = updateSpreadsheetRowCells(initial, firstId, { display_name: "   " });
  assert.equal(selectNonEmptySpreadsheetRows(whitespace).length, 0);

  const edited = updateSpreadsheetRowCells(whitespace, firstId, {
    address: "Synthetic Address",
  });
  assert.equal(edited.rows[0].clientRowId, firstId);
  assert.equal(edited.rows[0].cells.address, "Synthetic Address");
  assert.equal(edited.rows[0].cells.display_name, "   ");
  assert.equal(selectNonEmptySpreadsheetRows(edited).length, 1);
  assert.throws(
    () => updateSpreadsheetRowCells(edited, firstId, { invented_field: "value" }),
    /Unknown spreadsheet writable field/,
  );
});

test("save selection skips internal blank rows and preserves visual order", () => {
  let model = createSpreadsheetRowModel();
  const [first, , third, , fifth] = model.rows;
  model = updateSpreadsheetRowCells(model, fifth.clientRowId, { display_name: "Người thứ năm" });
  model = updateSpreadsheetRowCells(model, first.clientRowId, { display_name: "Người thứ nhất" });
  model = updateSpreadsheetRowCells(model, third.clientRowId, { display_name: "Người thứ ba" });

  assert.deepEqual(
    selectNonEmptySpreadsheetRows(model).map((row) => row.clientRowId),
    [first.clientRowId, third.clientRowId, fifth.clientRowId],
  );
});

test("provider selection stays client-only and clears an incompatible recruiter", () => {
  const initial = createSpreadsheetRowModel();
  const clientRowId = initial.rows[0].clientRowId;
  const withRecruiter = updateSpreadsheetRowCells(initial, clientRowId, {
    recruiter_id: "hrp-recruiter-id",
  });
  const selected = updateSpreadsheetRowProviderType(withRecruiter, clientRowId, "hrp");
  assert.equal(selected.rows[0].providerType, "hrp");
  assert.equal(selected.rows[0].cells.recruiter_id, "");
  const changed = updateSpreadsheetRowProviderType(
    updateSpreadsheetRowCells(selected, clientRowId, { recruiter_id: "hrp-recruiter-id" }),
    clientRowId,
    "vendor",
  );
  assert.equal(changed.rows[0].providerType, "vendor");
  assert.equal(changed.rows[0].cells.recruiter_id, "");
  assert.equal(Object.hasOwn(changed.rows[0].cells, "provider_type"), false);
});

test("replenishes ten trailing blanks and refuses a 101st data row", () => {
  let model = createSpreadsheetRowModel();
  for (let index = 0; index < SPREADSHEET_MAX_DATA_ROWS; index += 1) {
    const row = model.rows[index];
    assert.ok(row);
    model = updateSpreadsheetRowCells(model, row.clientRowId, {
      display_name: `Synthetic Worker ${index + 1}`,
    });
  }

  assert.equal(selectNonEmptySpreadsheetRows(model).length, SPREADSHEET_MAX_DATA_ROWS);
  assert.equal(model.rows.length, SPREADSHEET_MAX_DATA_ROWS + SPREADSHEET_SPARE_ROW_COUNT);
  assert.equal(model.rows.slice(-SPREADSHEET_SPARE_ROW_COUNT).every(spreadsheetRowIsBlank), true);
  assert.throws(
    () => updateSpreadsheetRowCells(model, model.rows.at(-1).clientRowId, {
      display_name: "Vượt giới hạn",
    }),
    SpreadsheetDataRowLimitError,
  );
});

test("clear, delete and duplicate keep identities stable and never recycle IDs", () => {
  let model = createSpreadsheetRowModel();
  const sourceId = model.rows[0].clientRowId;
  model = updateSpreadsheetRowProviderType(model, sourceId, "vendor");
  model = updateSpreadsheetRowCells(model, sourceId, {
    display_name: "Nguyễn Văn A",
  });

  const duplicated = duplicateSpreadsheetRow(model, sourceId);
  const duplicate = duplicated.rows[1];
  assert.notEqual(duplicate.clientRowId, sourceId);
  assert.deepEqual(duplicate.cells, duplicated.rows[0].cells);
  assert.equal(duplicate.providerType, "vendor");
  assert.equal(duplicated.rows[0].clientRowId, sourceId);

  const cleared = clearSpreadsheetRow(duplicated, sourceId);
  assert.equal(cleared.rows[0].clientRowId, sourceId);
  assert.equal(spreadsheetRowIsBlank(cleared.rows[0]), true);
  assert.equal(spreadsheetRowIsBlank(cleared.rows[1]), false);

  const afterDelete = deleteSpreadsheetRow(cleared, sourceId);
  assert.equal(afterDelete.rows.some((row) => row.clientRowId === sourceId), false);
  assert.equal(afterDelete.rows.some((row) => row.clientRowId === duplicate.clientRowId), true);
  assert.equal(afterDelete.rows.length >= SPREADSHEET_INITIAL_ROW_COUNT, true);

  const newDuplicate = duplicateSpreadsheetRow(afterDelete, duplicate.clientRowId);
  assert.notEqual(newDuplicate.rows[1].clientRowId, sourceId);
  assert.notEqual(newDuplicate.rows[1].clientRowId, duplicate.clientRowId);
});

test("model source contains no storage, network, logging or server ID behavior", () => {
  const source = readFileSync(new URL("./spreadsheet-row-model.ts", import.meta.url), "utf8");
  for (const forbidden of [
    "localStorage", "sessionStorage", "indexedDB", "fetch(", "XMLHttpRequest",
    "console.", "entryId", "entry_id", "crypto.randomUUID",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
