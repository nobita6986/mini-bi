/**
 * P3-W07C-R1 behavioral regressions: lazy default entry points.
 *
 * P3-W07C-R3: chỉ còn lazy default cho `first_work_date` (hôm nay theo
 * Asia/Ho_Chi_Minh). `national_id_issued_place` không còn được tự điền
 * ở client — server-authoritative migration #46 ghi "Bộ Công An" tại
 * RPC create-batch. Behavioral checks dưới đây đã được viết lại để
 * phù hợp với R3 contract; vẫn đảm bảo mỗi user interaction với một
 * staged row commit `today` vào row state TRƯỚC khi drawer/mobile card
 * render, và user/paste values luôn thắng.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  SPREADSHEET_DEFAULT_DATE_FIELD_KEY,
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

test("Add quick: fresh row -> drawer nhan du first_work_date default truoc khi mo", () => {
  // P3-W07C-R3: chi con first_work_date default; place do server migration.
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
  assert.equal(model.rows[0].cells.national_id_issued_place ?? "",
    "",
    "R3: place cell EMPTY luc dau (server migration ghi default)");
  assert.equal(model.rows[0].lazyDefaultsApplied, false);

  // addQuickStagedRow: chon row trong dau tien -> activate.
  model = activateSpreadsheetRowLazyDefaults(model, firstId, NOW);
  assert.equal(model.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], TODAY,
    "first_work_date duoc set today");
  // R3: national_id_issued_place van EMPTY o client.
  assert.equal(model.rows[0].cells.national_id_issued_place ?? "", "",
    "R3: national_id_issued_place KHONG duoc tu dien o client");
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
  assert.equal(model.rows[0].cells.national_id_issued_place ?? "", "",
    "R3: national_id_issued_place khong tu dien o client");
  // Mac dinh chi co 1 default (today) => van blank (de tranh bi dem vao batch khi user chua nhap gi).
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
  // R3: KHONG tu dien Bộ Công An o client.
  assert.equal(result.rows[0].cells.national_id_issued_place ?? "", "",
    "R3: mobile edit KHONG tu dien Bộ Công An o client");
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
  // R3: place van EMPTY o client.
  assert.equal(result.rows[0].cells.national_id_issued_place ?? "", "",
    "R3: desktop edit khong tu dien national_id_issued_place");
});

test("Provider selection (HRP/Vendor) activate lazy defaults", () => {
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;

  const result = updateSpreadsheetRowProviderType(model, firstId, "hrp", NOW);
  assert.equal(result.rows[0].lazyDefaultsApplied, true);
  assert.equal(result.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], TODAY,
    "chon HRP/Vendor cung dien today qua mat date");
  // R3: chi today, khong con place default.
  assert.equal(result.rows[0].cells.national_id_issued_place ?? "", "",
    "R3: chon HRP/Vendor khong tu dien Bộ Công An o client");
  assert.equal(result.rows[0].providerType, "hrp");
});

test("Paste/import (date + place) thang defaults (activation patch wins)", () => {
  // importSpreadsheetRows/dat paste path. Contract moi: activation truoc,
  // nhung patch (importedCells) duoc apply sau activation, nen cac cell
  // ma nguon ngoai cung cap se thang defaults.
  // P3-W07C-R3: neu paste gui gia tri cho national_id_issued_place
  // (template cu), patch do van thang (user wins o client); server
  // migration #46 sau do ghi de bang "Bộ Công An" o RPC.
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
  assert.equal(result.rows[0].cells.national_id_issued_place, "Sở Công An Tỉnh",
    "patch place tu paste/import giu nguyen o client; server migration #46 ghi đè 'Bộ Công An' o RPC");
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
  // se chen defaults; neu user clear ca default, row van blank.
  let model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  model = updateSpreadsheetRowCells(model, firstId, { display_name: "E" }, NOW);
  // row co business + 1 default.
  assert.equal(model.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], TODAY);

  // User clear default date: vi row da lazyDefaultsApplied=true, activation
  // khong goi lai; patch { date: "" } ghi de defaults (user wins).
  const userCleared = updateSpreadsheetRowCells(model, firstId, {
    [SPREADSHEET_DEFAULT_DATE_FIELD_KEY]: "",
  }, NOW);
  assert.equal(userCleared.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], "",
    "user clear default date => EMPTY (user wins, khong activation override)");
  assert.equal(spreadsheetRowIsBlank(userCleared.rows[0], NOW), false,
    "van con display_name 'E' nen khong blank");

  // Tiep: clear luon display_name => row EMPTY => blank, loai batch.
  const allBlank = updateSpreadsheetRowCells(userCleared, firstId, { display_name: "" }, NOW);
  assert.equal(spreadsheetRowIsBlank(allBlank.rows[0], NOW), true,
    "clear business field + default EMPTY => row blank, loai batch");
  assert.equal(selectNonEmptySpreadsheetRows(allBlank, NOW).length, 0);
});

test("openQuickEditor activate truoc khi mo drawer", () => {
  assert.match(live, /const openQuickEditor = useCallback\(\(clientRowId: string\) => \{[\s\S]*activateStagedRowLazyDefaults\(clientRowId\)[\s\S]*setQuickEditClientRowId\(clientRowId\)/,
    "openQuickEditor phai activate truoc khi setQuickEditClientRowId");

  // Behavioral: openQuickEditor tren row empty => chen first_work_date today.
  // P3-W07C-R3: khong con chen place default; chi first_work_date.
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  const activated = activateSpreadsheetRowLazyDefaults(model, firstId, NOW);
  assert.equal(activated.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], TODAY);
  assert.equal(activated.rows[0].cells.national_id_issued_place ?? "", "",
    "R3: openQuickEditor khong con chen place default o client");
});

test("handleMobileStagedFieldChange (mobile edit) di qua updateSpreadsheetRowCells", () => {
  assert.match(live, /const onMobileStagedChange = useCallback\(\([\s\S]{0,1200}updateSpreadsheetRowCells\(current, clientRowId, \{[\s\S]{0,500}\}\)/,
    "onMobileStagedChange phai goi updateSpreadsheetRowCells (activation contract)");
});