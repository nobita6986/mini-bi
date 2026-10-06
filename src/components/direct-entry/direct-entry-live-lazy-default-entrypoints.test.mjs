/**
 * P3-W07C-R1 behavioral regressions: lazy default entry points.
 *
 * Behavioral checks that every user interaction with a staged row commits
 * today (Asia/Ho_Chi_Minh) + `Bộ Công An` to the row state BEFORE the
 * drawer/mobile card renders, while user/paste values always win.
 *
 * Strategy: drive the helper functions used by `direct-entry-live.tsx` to
 * validate the activation contract at each entry point. Component-level
 * interactions (drawer open, mobile details open) are mapped to the same
 * helper calls so the assertions match the production code path.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  SPREADSHEET_DEFAULT_DATE_FIELD_KEY,
  SPREADSHEET_DEFAULT_PLACE_FIELD_KEY,
  DEFAULT_NATIONAL_ID_ISSUED_PLACE,
  activateSpreadsheetRowLazyDefaults,
  createSpreadsheetRowModel,
  selectNonEmptySpreadsheetRows,
  spreadsheetDefaultFirstWorkDate,
  spreadsheetRowIsBlank,
  updateSpreadsheetRowCells,
  updateSpreadsheetRowProviderType,
} from "../../lib/direct-entry/spreadsheet-row-model.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = join(HERE, "direct-entry-live.tsx");
const live = readFileSync(LIVE, "utf8");

const NOW = new Date("2026-04-15T08:00:00.000Z");
const TODAY = spreadsheetDefaultFirstWorkDate(NOW);

test("Add quick: fresh row -> drawer nhan du 2 defaults truoc khi mo", () => {
  // Production path: addQuickStagedRow tinh target rowId + activated model
  // TRUOC khi setStagedModel commit, roi setQuickEditClientRowId ben ngoai
  // updater (khong side effect trong setStagedModel). Source pattern:
  //   `targetClientRowId = emptyRow.clientRowId;`
  //   `return activateSpreadsheetRowLazyDefaults(current, emptyRow.clientRowId);`
  assert.match(live,
    /const addQuickStagedRow = useCallback\(\(\) => \{[\s\S]{0,800}targetClientRowId = emptyRow\.clientRowId;[\s\S]{0,500}return activateSpreadsheetRowLazyDefaults\(current, emptyRow\.clientRowId\)/,
    "addQuickStagedRow phai activate row truoc khi setQuickEditClientRowId (ben ngoai updater)");

  let model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  // Truoc khi activate: row EMPTY.
  assert.equal(model.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], "");
  assert.equal(model.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], "");
  assert.equal(model.rows[0].lazyDefaultsApplied, false);

  // addQuickStagedRow: chon row trong dau tien -> activate.
  model = activateSpreadsheetRowLazyDefaults(model, firstId, NOW);
  assert.equal(model.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], TODAY);
  assert.equal(model.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], DEFAULT_NATIONAL_ID_ISSUED_PLACE);
  assert.equal(model.rows[0].lazyDefaultsApplied, true);
});

test("Mobile <details> open: activate lazy defaults qua onToggle", () => {
  // Source phai co onToggle tren <details className={styles.mobileStagedCard}> va
  // goi activateStagedRowLazyDefaults khi details.open.
  assert.match(live, /className=\{styles\.mobileStagedCard\}[\s\S]{0,500}onToggle=\{/,
    "mobileStagedCard phai co onToggle handler");
  assert.match(live,
    /onToggle=\{\(event\) => \{[\s\S]{0,400}activateStagedRowLazyDefaults\(stagedRow\.clientRowId\)/,
    "onToggle phai activate lazy defaults khi details.open");

  let model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  // Mo card (onToggle activation).
  model = activateSpreadsheetRowLazyDefaults(model, firstId, NOW);
  assert.equal(model.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], TODAY);
  assert.equal(model.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], DEFAULT_NATIONAL_ID_ISSUED_PLACE);
  // Mac dinh chi co 2 default => van blank (de tranh bi dem vao batch khi user chua nhap gi).
  assert.equal(spreadsheetRowIsBlank(model.rows[0], NOW), true);
});

test("Mobile edit: handleMobileStagedFieldChange (qua updateSpreadsheetRowCells) activate", () => {
  // onMobileStagedChange goi updateSpreadsheetRowCells, va contract moi
  // dam bao activation truoc khi apply patch.
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;

  const result = updateSpreadsheetRowCells(model, firstId,
    { display_name: "Nguyễn Văn D" }, NOW);
  assert.equal(result.rows[0].lazyDefaultsApplied, true);
  assert.equal(result.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], TODAY,
    "mobile edit (display_name) tu dong dien today");
  assert.equal(result.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], DEFAULT_NATIONAL_ID_ISSUED_PLACE,
    "mobile edit (display_name) tu dong dien Bộ Công An");
});

test("Desktop grid edit: onCellsChange (qua updateSpreadsheetRowCells) activate", () => {
  // onCellsChange trong grid goi setStagedModel voi updateSpreadsheetRowCells
  // (qua onSpreadsheetCellsChange handler).
  assert.match(live, /onCellsChange=\{onSpreadsheetCellsChange\}/,
    "grid onCellsChange phai duoc wire vao onSpreadsheetCellsChange");
  assert.match(live,
    /onSpreadsheetCellsChange = useCallback\([\s\S]{0,1500}setStagedModel\(\(current\) => updateSpreadsheetRowCells\(/,
    "onSpreadsheetCellsChange phai goi updateSpreadsheetRowCells (activation contract)");

  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  const result = updateSpreadsheetRowCells(model, firstId,
    { national_id: "012345678901" }, NOW);
  assert.equal(result.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], TODAY);
  assert.equal(result.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], DEFAULT_NATIONAL_ID_ISSUED_PLACE);
});

test("Provider selection (HRP/Vendor) activate lazy defaults", () => {
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;

  const result = updateSpreadsheetRowProviderType(model, firstId, "hrp", NOW);
  assert.equal(result.rows[0].lazyDefaultsApplied, true);
  assert.equal(result.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], TODAY,
    "chon HRP/Vendor cung dien today qua mat date");
  assert.equal(result.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], DEFAULT_NATIONAL_ID_ISSUED_PLACE,
    "chon HRP/Vendor cung dien Bộ Công An qua mat place");
  assert.equal(result.rows[0].providerType, "hrp");
});

test("Paste/import (date + place) thang defaults (activation patch wins)", () => {
  // importSpreadsheetRows/dat paste path. Contract moi: activation truoc,
  // nhung patch (importedCells) duoc apply sau activation, nen cac cell
  // ma nguon ngoai cung cap se thang defaults.
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;

  const result = updateSpreadsheetRowCells(model, firstId, {
    display_name: "Paste User",
    first_work_date: "2027-01-15",
    national_id_issued_place: "Sở Công An Tỉnh",
  }, NOW);
  // Patch tu paste (date + place) giu nguyen, khong bi default overwrite.
  assert.equal(result.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], "2027-01-15",
    "patch date tu paste/import thang default today");
  assert.equal(result.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], "Sở Công An Tỉnh",
    "patch place tu paste/import thang default Bộ Công An");
  assert.equal(result.rows[0].cells.display_name, "Paste User");
});

test("Default-only row van bi loai khoi batch (selectNonEmpty)", () => {
  // Sau activation nhung chua co business field, row van la blank.
  let model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  model = activateSpreadsheetRowLazyDefaults(model, firstId, NOW);
  assert.equal(selectNonEmptySpreadsheetRows(model, NOW).length, 0,
    "activated-only row (chua co business field) khong dem vao batch");
  assert.equal(spreadsheetRowIsBlank(model.rows[0], NOW), true,
    "activated-only row van la blank");

  // Sau khi edit 1 business field, row se la non-blank.
  model = updateSpreadsheetRowCells(model, firstId, { display_name: "Real" });
  assert.equal(selectNonEmptySpreadsheetRows(model, NOW).length, 1);
  assert.equal(spreadsheetRowIsBlank(model.rows[0], NOW), false);
});

test("clear row reset ve blank chua kich hoat (activate override default), mac dinh EMPTY", () => {
  // Sau clear: cells EMPTY + lazyDefaultsApplied=false. Sau do activation
  // se chen defaults; neu user clear ca 2 default, row van blank.
  let model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  model = updateSpreadsheetRowCells(model, firstId, { display_name: "E" }, NOW);
  // row co business + 2 default.
  assert.equal(model.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], TODAY);

  // User clear ca 2 default: vi row da lazyDefaultsApplied=true, activation
  // khong goi lai; patch { date: "", place: "" } ghi de defaults (user wins).
  // Day la contract dung: user chu dong clear thi gia tri EMPTY duoc giu.
  const userCleared = updateSpreadsheetRowCells(model, firstId, {
    [SPREADSHEET_DEFAULT_DATE_FIELD_KEY]: "",
    [SPREADSHEET_DEFAULT_PLACE_FIELD_KEY]: "",
  }, NOW);
  assert.equal(userCleared.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], "",
    "user clear default date => EMPTY (user wins, khong activation override)");
  assert.equal(userCleared.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], "",
    "user clear default place => EMPTY (user wins, khong activation override)");
  assert.equal(spreadsheetRowIsBlank(userCleared.rows[0], NOW), false,
    "van con display_name 'E' nen khong blank");

  // Tiep: clear luon display_name => row EMPTY => blank, loai batch.
  const allBlank = updateSpreadsheetRowCells(userCleared, firstId, { display_name: "" }, NOW);
  assert.equal(spreadsheetRowIsBlank(allBlank.rows[0], NOW), true,
    "clear business field + 2 default EMPTY => row blank, loai batch");
  assert.equal(selectNonEmptySpreadsheetRows(allBlank, NOW).length, 0);
});

test("openQuickEditor activate truoc khi mo drawer", () => {
  assert.match(live, /const openQuickEditor = useCallback\(\(clientRowId: string\) => \{[\s\S]*activateStagedRowLazyDefaults\(clientRowId\)[\s\S]*setQuickEditClientRowId\(clientRowId\)/,
    "openQuickEditor phai activate truoc khi setQuickEditClientRowId");

  // Behavioral: openQuickEditor tren row empty => chen defaults.
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  const activated = activateSpreadsheetRowLazyDefaults(model, firstId, NOW);
  assert.equal(activated.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], TODAY);
  assert.equal(activated.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], DEFAULT_NATIONAL_ID_ISSUED_PLACE);
});

test("handleMobileStagedFieldChange (mobile edit) di qua updateSpreadsheetRowCells", () => {
  assert.match(live, /const onMobileStagedChange = useCallback\(\([\s\S]{0,1200}updateSpreadsheetRowCells\(current, clientRowId, \{[\s\S]{0,500}\}\)/,
    "onMobileStagedChange phai goi updateSpreadsheetRowCells (activation contract)");
});