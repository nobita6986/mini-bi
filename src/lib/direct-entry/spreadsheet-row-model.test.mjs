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
  clearSpreadsheetRow,
  createSpreadsheetRowModel,
  defaultCells,
  deleteSpreadsheetRow,
  duplicateSpreadsheetRow,
  ensureSpreadsheetRowCount,
  selectNonEmptySpreadsheetRows,
  spreadsheetDefaultFirstWorkDate,
  spreadsheetRowIsBlank,
  updateSpreadsheetRowCells,
  updateSpreadsheetRowProviderType,
} from "./spreadsheet-row-model.ts";

test("initializes 30 client-only rows with stable unique IDs and canonical writable fields (P1.7-H08-R1: defaults applied)", () => {
  const model = createSpreadsheetRowModel();
  const expectedKeys = WORKER_PROFILE_FIELDS.filter((field) => field.persisted)
    .filter((field) => field.key !== "employee_code")
    .map((field) => field.key);
  const today = spreadsheetDefaultFirstWorkDate();

  assert.equal(model.rows.length, SPREADSHEET_INITIAL_ROW_COUNT);
  assert.equal(new Set(model.rows.map((row) => row.clientRowId)).size, model.rows.length);
  assert.deepEqual(SPREADSHEET_WRITABLE_FIELD_KEYS, expectedKeys);
  for (const row of model.rows) {
    // P1.7-H08-R1: default-only row van la blank (khong tinh vao save/validate).
    assert.equal(spreadsheetRowIsBlank(row), true);
    assert.deepEqual(Object.keys(row.cells), expectedKeys);
    // 2 default value, cac o khac empty.
    for (const key of expectedKeys) {
      if (key === SPREADSHEET_DEFAULT_DATE_FIELD_KEY) {
        assert.equal(row.cells[key], today);
      } else if (key === SPREADSHEET_DEFAULT_PLACE_FIELD_KEY) {
        assert.equal(row.cells[key], DEFAULT_NATIONAL_ID_ISSUED_PLACE);
      } else {
        assert.equal(row.cells[key], "");
      }
    }
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

// --- P1.7-H08-R1: entry defaults ---------------------------------------

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
  // Doc source va loai tru comment lines truoc khi check.
  const source = readFileSync(new URL("./spreadsheet-row-model.ts", import.meta.url), "utf8");
  const withoutComments = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");
  assert.equal(/toISOString/.test(withoutComments), false,
    "spreadsheet-row-model runtime code khong dung toISOString de tinh ngay default");
});

test("R1-2 default cells co first_work_date = today GMT+7 va issue_place = Bộ Công An", () => {
  const cells = defaultCells(new Date("2026-04-15T08:00:00.000Z"));
  // 2026-04-15T08:00Z = 2026-04-15 15:00 GMT+7 (cung ngay)
  assert.equal(cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], "2026-04-15");
  assert.equal(cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], DEFAULT_NATIONAL_ID_ISSUED_PLACE);
  // Default khong ghi de cac field khac.
  for (const key of SPREADSHEET_WRITABLE_FIELD_KEYS) {
    if (key === SPREADSHEET_DEFAULT_DATE_FIELD_KEY) continue;
    if (key === SPREADSHEET_DEFAULT_PLACE_FIELD_KEY) continue;
    assert.equal(cells[key], "", `field ${key} phai mac dinh rong`);
  }
  // Bộ Công An dung dung chinh ta (co dau va khoang trang).
  assert.equal(DEFAULT_NATIONAL_ID_ISSUED_PLACE, "Bộ Công An");
});

test("R1-3 30 initial rows deu co defaults; ensureSpreadsheetRowCount cung them rows co defaults", () => {
  const initial = createSpreadsheetRowModel();
  const today = spreadsheetDefaultFirstWorkDate();
  for (const row of initial.rows) {
    assert.equal(row.cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], today);
    assert.equal(row.cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], DEFAULT_NATIONAL_ID_ISSUED_PLACE);
  }
  // Them 10 rows qua ensureSpreadsheetRowCount (kha nang cua nut "Thêm dòng").
  const grown = ensureSpreadsheetRowCount(initial, initial.rows.length + 10);
  assert.equal(grown.rows.length, initial.rows.length + 10);
  for (let index = initial.rows.length; index < grown.rows.length; index += 1) {
    const row = grown.rows[index];
    assert.ok(row);
    assert.equal(row.cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], today);
    assert.equal(row.cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], DEFAULT_NATIONAL_ID_ISSUED_PLACE);
  }
});

test("R1-4 row chi chua defaults van la blank; khong vao selectNonEmptySpreadsheetRows", () => {
  const model = createSpreadsheetRowModel();
  // Mac dinh 30 rows deu blank (vi chi chua 2 default).
  assert.equal(model.rows.every(spreadsheetRowIsBlank), true);
  assert.equal(selectNonEmptySpreadsheetRows(model).length, 0);
});

test("R1-5 sua default kich hoat row (khong con la blank)", () => {
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  // Thay 'Bộ Công An' bang gia tri khac => row active.
  const editedPlace = updateSpreadsheetRowCells(model, firstId, {
    [SPREADSHEET_DEFAULT_PLACE_FIELD_KEY]: "Sở Công An Tỉnh",
  });
  assert.equal(spreadsheetRowIsBlank(editedPlace.rows[0]), false);
  assert.equal(selectNonEmptySpreadsheetRows(editedPlace).length, 1);
  // Doi ngay default => row active.
  const editedDate = updateSpreadsheetRowCells(model, firstId, {
    [SPREADSHEET_DEFAULT_DATE_FIELD_KEY]: "2099-12-31",
  });
  assert.equal(spreadsheetRowIsBlank(editedDate.rows[0]), false);
  // Clear default place thanh "" + giu default date: row van la default-only
  // (1 default con lai, 1 empty khong phai default value), nen van blank.
  // Day la behavior mong muon: row default-only la row khong co business data.
  const clearedPlace = updateSpreadsheetRowCells(model, firstId, {
    [SPREADSHEET_DEFAULT_PLACE_FIELD_KEY]: "",
  });
  assert.equal(spreadsheetRowIsBlank(clearedPlace.rows[0]), true,
    "xoa default place (de trong) van la default-only row => van blank");
  // Clear ca 2 default => row chi co empty cells => van blank.
  const clearedAll = updateSpreadsheetRowCells(clearedPlace, firstId, {
    [SPREADSHEET_DEFAULT_DATE_FIELD_KEY]: "",
  });
  assert.equal(spreadsheetRowIsBlank(clearedAll.rows[0]), true);
});

test("R1-6 nhap business field o row con default cung kich hoat row (vi khong con default-only)", () => {
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  // Row 0 ban dau chi co 2 default, van blank.
  assert.equal(spreadsheetRowIsBlank(model.rows[0]), true);
  // Nhap display_name => row khong con default-only.
  const edited = updateSpreadsheetRowCells(model, firstId, {
    display_name: "Nguyễn Văn A",
  });
  assert.equal(spreadsheetRowIsBlank(edited.rows[0]), false);
  assert.equal(selectNonEmptySpreadsheetRows(edited).length, 1);
  // display_name whitespace van khong active.
  const whitespace = updateSpreadsheetRowCells(model, firstId, { display_name: "   " });
  assert.equal(spreadsheetRowIsBlank(whitespace.rows[0]), true,
    "whitespace display_name + 2 default => row van blank");
});

test("R1-7 user modify default duoc giu qua update patches; import/imported khong bi ghi de", () => {
  const model = createSpreadsheetRowModel();
  const firstId = model.rows[0].clientRowId;
  const userEdit = updateSpreadsheetRowCells(model, firstId, {
    [SPREADSHEET_DEFAULT_DATE_FIELD_KEY]: "2027-01-15",
    [SPREADSHEET_DEFAULT_PLACE_FIELD_KEY]: "Cục Cảnh sát",
  });
  assert.equal(userEdit.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], "2027-01-15");
  assert.equal(userEdit.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], "Cục Cảnh sát");
  // Apply patch khac (display_name) → 2 default user-edited van giu nguyen.
  const withName = updateSpreadsheetRowCells(userEdit, firstId, {
    display_name: "Trần Thị B",
  });
  assert.equal(withName.rows[0].cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY], "2027-01-15");
  assert.equal(withName.rows[0].cells[SPREADSHEET_DEFAULT_PLACE_FIELD_KEY], "Cục Cảnh sát");
  assert.equal(withName.rows[0].cells.display_name, "Trần Thị B");
});

test("R1-8 default gia tri la 1 hang so (khong bi hook vao local time cua may dev/CI)", () => {
  // Hang so DEFAULT_NATIONAL_ID_ISSUED_PLACE phai dung chinh ta.
  assert.equal(DEFAULT_NATIONAL_ID_ISSUED_PLACE, "Bộ Công An");
  // Field key constants cung cap nhat.
  assert.equal(SPREADSHEET_DEFAULT_DATE_FIELD_KEY, "first_work_date");
  assert.equal(SPREADSHEET_DEFAULT_PLACE_FIELD_KEY, "national_id_issued_place");
  // spreadsheet-row-model chi dinh nghia default place MOT noi (no duplication).
  // Dem trong row-model.ts, loai tru comment mo ta "Bộ Công An".
  const source = readFileSync(new URL("./spreadsheet-row-model.ts", import.meta.url), "utf8");
  const withoutComments = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");
  assert.equal((withoutComments.match(/Bộ Công An/g) ?? []).length, 1,
    "chi co mot noi dinh nghia runtime 'Bộ Công An' (khong tinh comment)");
  // Date default khong hard-code vao 1 ngay co dinh (ky thuat nhay cam).
  assert.equal(/"\d{4}-\d{2}-\d{2}"/.test(source), false,
    "khong hard-code ngay default; phai tinh tu Asia/Ho_Chi_Minh");
});
