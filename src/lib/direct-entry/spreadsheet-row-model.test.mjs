import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { WORKER_PROFILE_FIELDS } from "./worker-profile-import-contract.ts";
import {
  DEFAULT_NATIONAL_ID_ISSUED_PLACE,
  SPREADSHEET_DEFAULT_DATE_FIELD_KEY,
  SPREADSHEET_DEFAULT_PLACE_FIELD_KEY,
  SPREADSHEET_INITIAL_ROW_COUNT,
  SPREADSHEET_MAX_DATA_ROWS,
  SPREADSHEET_SPARE_ROW_COUNT,
  SPREADSHEET_WRITABLE_FIELD_KEYS,
  SpreadsheetDataRowLimitError,
  activateSpreadsheetRowLazyDefaults,
  clearSpreadsheetRow,
  createSpreadsheetRowModel,
  defaultCells,
  deleteSpreadsheetRow,
  duplicateSpreadsheetRow,
  ensureSpreadsheetRowCount,
  importSpreadsheetRows,
  selectNonEmptySpreadsheetRows,
  spreadsheetDefaultFirstWorkDate,
  spreadsheetRowIsBlank,
  updateSpreadsheetRowCells,
  updateSpreadsheetRowProviderType,
} from "./spreadsheet-row-model.ts";

test("P3-W07C row moi: state rong, lazyDefaultsApplied=false; placeholders duoc render layer xu ly", () => {
  const model = createSpreadsheetRowModel();
  const expectedKeys = WORKER_PROFILE_FIELDS.filter((field) => field.persisted)
    .filter((field) => field.key !== "employee_code")
    .map((field) => field.key);

  assert.equal(model.rows.length, SPREADSHEET_INITIAL_ROW_COUNT);
  assert.equal(new Set(model.rows.map((row) => row.clientRowId)).size, model.rows.length);
  assert.deepEqual(SPREADSHEET_WRITABLE_FIELD_KEYS, expectedKeys);
  for (const row of model.rows) {
    // Row moi hoan toan rong; CHUA duoc kich hoat lazy defaults.
    assert.equal(row.lazyDefaultsApplied, false,
      "row moi phai co lazyDefaultsApplied=false (chua tuong tac)");
    assert.equal(spreadsheetRowIsBlank(row), true,
      "row moi khong co business data => van blank");
    assert.deepEqual(Object.keys(row.cells), expectedKeys);
    for (const key of expectedKeys) {
      assert.equal(row.cells[key], "", `field ${key} phai mac dinh rong (state rong)`);
    }
    assert.match(row.clientRowId, /^spreadsheet-row-[1-9][0-9]*$/);
  }
});

test("partial user data makes a row non-empty while whitespace-only cells stay blank", () => {
  const initial = createSpreadsheetRowModel();
  const firstId = initial.rows[0].clientRowId;
  const whitespace = updateSpreadsheetRowCells(initial, firstId, { display_name: "   " });
  // P3-W07C: whitespace chinh se duoc trim; row 0 van khong co business data.
  assert.equal(selectNonEmptySpreadsheetRows(whitespace).length, 0);

  const edited = updateSpreadsheetRowCells(whitespace, firstId, {
    address: "Synthetic Address",
  });
  assert.equal(edited.rows[0].clientRowId, firstId);
  assert.equal(edited.rows[0].cells.address, "Synthetic Address");
  assert.equal(edited.rows[0].cells.display_name, "   ");
  assert.equal(edited.rows[0].lazyDefaultsApplied, true,
    "edit cell phai danh dau row da kich hoat");
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

test("provider selection stays client-only, clears incompatible recruiter, marks row as activated", () => {
  const initial = createSpreadsheetRowModel();
  const clientRowId = initial.rows[0].clientRowId;
  // P3-W07C: khi chon provider, row duoc danh dau activated nhung cells
  // van rong (van la blank, khong tu dong dien lazy defaults).
  const selected = updateSpreadsheetRowProviderType(initial, clientRowId, "hrp");
  assert.equal(selected.rows[0].providerType, "hrp");
  assert.equal(selected.rows[0].lazyDefaultsApplied, true);
  assert.equal(spreadsheetRowIsBlank(selected.rows[0]), true,
    "sau khi chon provider, row van chua co business data => van blank");
  // Recruiter patch duoc commit sau khi chon provider.
  const withRecruiter = updateSpreadsheetRowCells(selected, clientRowId, {
    recruiter_id: "hrp-recruiter-id",
  });
  assert.equal(withRecruiter.rows[0].providerType, "hrp");
  assert.equal(withRecruiter.rows[0].cells.recruiter_id, "hrp-recruiter-id");
  // Chuyen provider xoa recruiter_id cu (incompatible) nhung van activated.
  const changed = updateSpreadsheetRowProviderType(
    updateSpreadsheetRowCells(withRecruiter, clientRowId, { recruiter_id: "hrp-recruiter-id" }),
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
  assert.equal(duplicate.lazyDefaultsApplied, true,
    "duplicate row giu lazyDefaultsApplied cua source");
  assert.equal(duplicated.rows[0].clientRowId, sourceId);

  const cleared = clearSpreadsheetRow(duplicated, sourceId);
  assert.equal(cleared.rows[0].clientRowId, sourceId);
  assert.equal(spreadsheetRowIsBlank(cleared.rows[0]), true);
  // P3-W07C: clear row dua ve trang thai chua kich hoat.
  assert.equal(cleared.rows[0].lazyDefaultsApplied, false);
  assert.equal(cleared.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], "",
    "clear row xoa luon lazy default (state rong)");
  assert.equal(cleared.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], "",
    "clear row xoa luon lazy default (state rong)");
  // Duplicate row khong bi clear.
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

// --- P1.7-H08-R1 + P3-W07C: entry defaults + lazy activation -----------

test("R1-1 spreadsheetDefaultFirstWorkDate tra ngay theo Asia/Ho_Chi_Minh, khong lech UTC", () => {
  // 2026-01-01T17:30:00Z => 2026-01-02 00:30 GMT+7
  const a = spreadsheetDefaultFirstWorkDate(new Date("2026-01-01T17:30:00.000Z"));
  assert.equal(a, "2026-01-02", "phai chuyen doi sang ngay GMT+7");
  // 2026-07-31T16:59:59Z => 2026-07-31 23:59:59 GMT+7 (van ngay 31)
  const b = spreadsheetDefaultFirstWorkDate(new Date("2026-07-31T16:59:59.000Z"));
  assert.equal(b, "2026-07-31");
  // 2026-07-31T17:00:00Z => 2026-08-01 00:00 GMT+7
  const c = spreadsheetDefaultFirstWorkDate(new Date("2026-07-31T17:00:00.000Z"));
  assert.equal(c, "2026-08-01", "qua moc 17:00 UTC la 00:00 ngay hom sau theo GMT+7");
  // Tra ve format YYYY-MM-DD (khong chua time component).
  assert.match(a, /^\d{4}-\d{2}-\d{2}$/);
  // Su dung Intl.DateTimeFormat, KHONG toISOString (tranh UTC leak) trong code.
  const source = readFileSync(new URL("./spreadsheet-row-model.ts", import.meta.url), "utf8");
  const withoutComments = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");
  assert.equal(/toISOString/.test(withoutComments), false,
    "spreadsheet-row-model runtime code khong dung toISOString de tinh ngay default");
});

test("P3-W07C R2-1 default cells tra ve EMPTY (khong lazy); activate moi chen lazy defaults", () => {
  const cells = defaultCells();
  // P3-W07C: state cua row moi phai EMPTY, khong con lazy defaults nua.
  for (const key of SPREADSHEET_WRITABLE_FIELD_KEYS) {
    assert.equal(cells[key], "", `field ${key} phai empty ngay tu dau (lazy)`);
  }
});

test("P3-W07C R2-2 30 initial rows deu rong; khong co lazy default nao trong state", () => {
  const initial = createSpreadsheetRowModel();
  for (const row of initial.rows) {
    assert.equal(row.cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], "",
      "row moi khong co first_work_date lazy default trong state");
    assert.equal(row.cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], "",
      "row moi khong co national_id_issued_place lazy default trong state");
    assert.equal(row.lazyDefaultsApplied, false);
  }
});

test("P3-W07C R2-3 activateSpreadsheetRowLazyDefaults: idempotent, chen default khi cells empty", () => {
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  const today = spreadsheetDefaultFirstWorkDate(new Date("2026-04-15T08:00:00.000Z"));
  // Truoc activate: row 0 empty, chua activated.
  assert.equal(model.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], "");
  assert.equal(model.rows[0].lazyDefaultsApplied, false);

  const activated = activateSpreadsheetRowLazyDefaults(
    model, firstId, new Date("2026-04-15T08:00:00.000Z"));
  assert.equal(activated.rows[0].lazyDefaultsApplied, true);
  assert.equal(activated.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], today);
  assert.equal(activated.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], DEFAULT_NATIONAL_ID_ISSUED_PLACE);
  // Cac field khac van empty (khong tu dien them).
  for (const key of SPREADSHEET_WRITABLE_FIELD_KEYS) {
    if (key === SPREADSHEET_DEFAULT_DATE_FIELD_KEY) continue;
    if (key === SPREADSHEET_DEFAULT_PLACE_FIELD_KEY) continue;
    assert.equal(activated.rows[0].cells[key], "", `field ${key} phai van empty`);
  }

  // Idempotent: goi 2 lan khong doi gia tri.
  const twice = activateSpreadsheetRowLazyDefaults(
    activated, firstId, new Date("2099-12-31T00:00:00.000Z"));
  assert.equal(twice.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], today,
    "activate lan 2 KHONG ghi de ngay default da set (date cua lan 1)");
  assert.equal(twice.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], DEFAULT_NATIONAL_ID_ISSUED_PLACE);
});

test("P3-W07C R2-4 activate KHONG ghi de gia tri user/paste; row khong ton tai thi no-op", () => {
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  // User/paste da dien gia tri rieng vao 2 cell default.
  const seeded = updateSpreadsheetRowCells(model, firstId, {
    [SPREADSHEET_DEFAULT_DATE_FIELD_KEY]: "2027-01-15",
    [SPREADSHEET_DEFAULT_PLACE_FIELD_KEY]: "Sở Công An Tỉnh",
  });
  // Activate khong ghi de gia tri user (cells da co).
  const activated = activateSpreadsheetRowLazyDefaults(
    seeded, firstId, new Date("2099-12-31T00:00:00.000Z"));
  assert.equal(activated.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], "2027-01-15",
    "activate phai giu nguyen gia tri user/paste cua first_work_date");
  assert.equal(activated.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], "Sở Công An Tỉnh",
    "activate phai giu nguyen gia tri user/paste cua national_id_issued_place");

  // Khong ton tai rowId => no-op (tra ve nguyen model).
  const ghost = activateSpreadsheetRowLazyDefaults(
    seeded, "spreadsheet-row-9999", new Date("2026-04-15T08:00:00.000Z"));
  assert.equal(ghost, seeded);
});

test("P3-W07C R2-5 row chi chua lazy defaults (sau activate) van la blank", () => {
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  // Pinned `now` de activation va blank check cung dung 1 moc thoi gian.
  const now = new Date("2026-04-15T08:00:00.000Z");
  // Truoc activate: row rong => blank.
  assert.equal(spreadsheetRowIsBlank(model.rows[0], now), true);
  // Sau activate: chi co 2 default value => van blank.
  const activated = activateSpreadsheetRowLazyDefaults(model, firstId, now);
  assert.equal(spreadsheetRowIsBlank(activated.rows[0], now), true,
    "row chi co lazy defaults (today + 'Bộ Công An') van la blank");
  assert.equal(selectNonEmptySpreadsheetRows(activated, now).length, 0,
    "activated row khong dem vao batch");

  // Nhap them 1 business field => row khong con blank.
  const withName = updateSpreadsheetRowCells(activated, firstId, {
    display_name: "Nguyễn Văn A",
  });
  assert.equal(spreadsheetRowIsBlank(withName.rows[0], now), false,
    "them business field kich hoat row thanh non-blank");
  assert.equal(selectNonEmptySpreadsheetRows(withName, now).length, 1);
});

test("P3-W07C R2-6 user sua default value (sau activate) => row non-blank; import/paste giu nguyen", () => {
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  const now = new Date("2026-04-15T08:00:00.000Z");
  const activated = activateSpreadsheetRowLazyDefaults(model, firstId, now);
  // User doi 'Bộ Công An' thanh noi cap rieng.
  const userEdited = updateSpreadsheetRowCells(activated, firstId, {
    [SPREADSHEET_DEFAULT_PLACE_FIELD_KEY]: "Sở Công An Tỉnh",
  });
  assert.equal(spreadsheetRowIsBlank(userEdited.rows[0], now), false,
    "user doi gia tri default => row khong con default-only => non-blank");

  // User doi ca ngay default.
  const dateEdited = updateSpreadsheetRowCells(activated, firstId, {
    [SPREADSHEET_DEFAULT_DATE_FIELD_KEY]: "2099-12-31",
  });
  assert.equal(spreadsheetRowIsBlank(dateEdited.rows[0], now), false,
    "user doi ngay default => row non-blank");

  // User clear default place thanh "" (sau activate): row van con 1 default (today) => van blank.
  const clearedPlace = updateSpreadsheetRowCells(activated, firstId, {
    [SPREADSHEET_DEFAULT_PLACE_FIELD_KEY]: "",
  });
  assert.equal(spreadsheetRowIsBlank(clearedPlace.rows[0], now), true,
    "xoa default place (empty) + 1 default con lai => row van blank");

  // Clear ca 2 default => row chi empty => van blank.
  const clearedAll = updateSpreadsheetRowCells(clearedPlace, firstId, {
    [SPREADSHEET_DEFAULT_DATE_FIELD_KEY]: "",
  });
  assert.equal(spreadsheetRowIsBlank(clearedAll.rows[0], now), true);
});

test("P3-W07C R2-7 import batch rows: lazyDefaultsApplied=true; row blank bi loai khoi batch", () => {
  const model = createSpreadsheetRowModel();
  const now = new Date("2026-04-15T08:00:00.000Z");
  const today = spreadsheetDefaultFirstWorkDate(now);
  // Mix: 1 row day du, 1 row chi co 2 default, 1 row empty.
  const result = importSpreadsheetRows(model, [
    { display_name: "Nguyễn Văn A", first_work_date: today,
      national_id_issued_place: "Bộ Công An", project_id: "P",
      recruiter_id: "R", labor_type: "TEMPORARY" },
    { first_work_date: today, national_id_issued_place: "Bộ Công An" },
    {},
  ]);
  // Import them 2 row; 1 row blank bi loai.
  const imported = result.rows.filter((row) => row.cells.display_name === "Nguyễn Văn A"
    || (row.cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY] === today
      && row.cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY] === "Bộ Công An"
      && row.cells.display_name === ""));
  // Row 1 (full data) co mat; row 2 (chi 2 default) cung duoc them nhung
  // van la blank theo spreadsheetRowIsBlank.
  assert.equal(imported.length, 2);
  for (const row of imported) {
    assert.equal(row.lazyDefaultsApplied, true,
      "imported row phai duoc danh dau la da kich hoat");
  }
  // Batch chi dem 1 row co business data (blank rows bi loai khi select).
  const nonEmpty = selectNonEmptySpreadsheetRows(result, now);
  assert.equal(nonEmpty.length, 1);
  assert.equal(nonEmpty[0].cells.display_name, "Nguyễn Văn A");

  // Import 0 row (empty input) => khong doi model.
  const empty = importSpreadsheetRows(model, []);
  assert.equal(empty, model);

  // Import khi dat 100 data row => khong them (no-op).
  let full = createSpreadsheetRowModel();
  for (let index = 0; index < SPREADSHEET_MAX_DATA_ROWS; index += 1) {
    const row = full.rows[index];
    assert.ok(row);
    full = updateSpreadsheetRowCells(full, row.clientRowId, {
      display_name: `W ${index + 1}`,
    });
  }
  const overflow = importSpreadsheetRows(full, [
    { display_name: "Should not be added", first_work_date: today,
      national_id_issued_place: "Bộ Công An", project_id: "P",
      recruiter_id: "R", labor_type: "TEMPORARY" },
  ]);
  assert.equal(overflow, full,
    "khi dat max data row, import se khong them row nao (no-op)");
});

test("P3-W07C R2-8 lazy defaults la hang so khong hard-code; chi mot noi runtime 'Bộ Công An'", () => {
  assert.equal(DEFAULT_NATIONAL_ID_ISSUED_PLACE, "Bộ Công An");
  assert.equal(SPREADSHEET_DEFAULT_DATE_FIELD_KEY, "first_work_date");
  assert.equal(SPREADSHEET_DEFAULT_PLACE_FIELD_KEY, "national_id_issued_place");
  const source = readFileSync(new URL("./spreadsheet-row-model.ts", import.meta.url), "utf8");
  const withoutComments = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");
  assert.equal((withoutComments.match(/Bộ Công An/g) ?? []).length, 1,
    "chi co mot noi runtime 'Bộ Công An' (khong tinh comment)");
  assert.equal(/"\d{4}-\d{2}-\d{2}"/.test(source), false,
    "khong hard-code ngay default; phai tinh tu Asia/Ho_Chi_Minh");
});

test("P3-W07C R2-9 updateSpreadsheetRowCells khong tu activate lazy defaults (chi danh dau activated)", () => {
  // Activation phai di qua activateSpreadsheetRowLazyDefaults rieng; edit
  // cell se danh dau activated=true nhung KHONG tu dien 2 default value.
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  const edited = updateSpreadsheetRowCells(model, firstId, {
    display_name: "Trần Thị B",
  });
  assert.equal(edited.rows[0].lazyDefaultsApplied, true);
  // display_name co gia tri nhung 2 default cell van rong.
  assert.equal(edited.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], "",
    "edit cell khong tu dien first_work_date lazy default");
  assert.equal(edited.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], "",
    "edit cell khong tu dien national_id_issued_place lazy default");
  // Row van non-blank (co display_name).
  assert.equal(spreadsheetRowIsBlank(edited.rows[0]), false);
});