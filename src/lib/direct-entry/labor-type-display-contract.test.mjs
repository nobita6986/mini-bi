/**
 * P3.1-W02C-R2 - hop dong hien thi labor type (#80) o boundary TypeScript.
 *
 * Lane thuan, khong DB: import truc tiep cac projection nghiem ngat va chung minh
 * chung fail-closed voi field display-only `labor_type_display`:
 *   * thieu / rong / sai kieu => ca projection tra null, nen UI khong bao gio phai
 *     tu map key sang nhan va khong bao gio render mot nhan fallback;
 *   * item change request CO labor type thi BAT BUOC co nhan khong rong, item KHONG
 *     co labor type thi BAT BUOC nhan dung bang null;
 *   * nhan hop le duoc truyen nguyen ven, va `labor_type_display` la sibling cua
 *     `proposal`: proposal khong bao gio bi nhet them nhan.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DETAIL_ITEM_KEYS,
  projectChangeRequestDetail,
} from "./change-request-read-contract.ts";
import {
  WORKER_DIRECTORY_ROW_KEYS,
  projectWorkerDirectoryPage,
  projectWorkerDirectoryRow,
} from "./worker-directory-contract.ts";
import { projectEntry } from "./write-api.ts";

const entryId = "c1000000-0000-4000-8000-000000000001";
const recruiterId = "d1000000-0000-4000-8000-000000000001";
const requestId = "e1000000-0000-4000-8000-000000000001";
const submissionId = "a1000000-0000-4000-8000-000000000001";
const decidedAt = "2026-10-08T09:00:00.000000Z";
const createdAt = "2026-10-03T10:00:00.000000Z";

/** Nhan that do server resolve tu catalog; khong bao gio la key tho. */
const LABEL = "Thời gian thử việc";
/** Sentinel ma migration #80 cam: khong duong nao duoc phep tra ve no. */
const FORBIDDEN_FALLBACK = "Không xác định";

function withoutKey(source, key) {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

/** Hinh dang row Worker Directory da duoc biet la tot (worker-directory-contract.test.mjs). */
function workerRow(overrides = {}) {
  return {
    entry_id: entryId,
    entry_version: 3,
    submission_state: "SUBMITTED",
    employee_code: "hrp-2026-300001",
    display_name: "Worker One",
    project_id: "proj_a",
    project_display: "Project A",
    first_work_date: "2026-10-01",
    labor_type: "PROBATION",
    labor_type_display: LABEL,
    employment_status: "ON",
    recruiter_id: recruiterId,
    recruiter_display: "Recruiter A",
    payment: {
      state: "provided", account_number: "••••••••8901", bank_id: null,
      account_holder_name: "Synthetic Holder", version: 1,
    },
    pending_request: { request_id: requestId, state: "PENDING", version: 1 },
    last_decision: { state: "REJECTED", decided_at: decidedAt },
    is_project_manager: true,
    allowed_actions: {
      view: true, view_pii: false, view_payment: true,
      propose_change: false, propose_change_code: "PROPOSE_PENDING_W04_POLICY",
    },
    ...overrides,
  };
}

function workerPage(overrides = {}) {
  return {
    items: [workerRow()], scope: "managed", page_size: 25, has_more: false, next_cursor: null,
    authorization_date: "2026-10-08",
    ...overrides,
  };
}

/** Hinh dang entry payload da duoc biet la tot (write-api.test.mjs). */
function entryProjection(overrides = {}) {
  return {
    entry_id: "a2000000-0000-4000-8000-000000000001",
    submission_id: submissionId,
    project_id: "project_synthetic_01",
    first_work_date: "2026-10-15",
    employee_code: "hrp-2026-000001",
    worker_details: {
      display_name: "Nguyen Thi Ngoc Anh",
      gender: { state: "provided", value: "FEMALE" },
      date_of_birth: { state: "provided", value: "8/6/2005" },
      national_id: { state: "provided", value: "013050393450" },
      national_id_issued_at: { state: "omitted" },
      national_id_issued_place: { state: "omitted" },
      address: { state: "provided", value: "Thanh Hoa" },
      phone: { state: "provided", value: "0976039982" },
    },
    recruiter_id: recruiterId,
    team_id: "94000000-0000-4000-8000-000000000001",
    provider_type: "hrp",
    labor_type: "PROBATION",
    labor_type_display: LABEL,
    general_note: null,
    version: 1,
    scope_kind: "own",
    payment: null,
    employment_status: { status: "UNCONFIRMED", effective_date: "2026-10-15", version: 1 },
    documents: [],
    worker_portrait: null,
    ...overrides,
  };
}

function detailItem(overrides = {}) {
  return {
    entry_id: entryId,
    target_kind: "ENTRY_FIELD",
    expected_version: 1,
    proposal: { labor_type: "PROBATION" },
    labor_type_display: LABEL,
    ...overrides,
  };
}

function detailBody(items) {
  return {
    request_id: requestId,
    state: "PENDING",
    version: 1,
    created_at: createdAt,
    request_reason: null,
    items,
    can_withdraw: false,
    can_decide: true,
  };
}

test("worker directory row: nhan rong/thieu/sai kieu lam ca row lan page unavailable", () => {
  const accepted = projectWorkerDirectoryRow(workerRow());
  assert.ok(accepted, "mot row co nhan that phai duoc chap nhan");
  assert.equal(accepted.labor_type, "PROBATION");
  assert.equal(accepted.labor_type_display, LABEL);

  const page = projectWorkerDirectoryPage(workerPage(), { scope: "managed", page_size: 25 });
  assert.ok(page, "page hop le van duoc chap nhan");
  assert.equal(page.items[0].labor_type_display, LABEL);

  const rejected = {
    "thieu field": withoutKey(workerRow(), "labor_type_display"),
    "chuoi rong": workerRow({ labor_type_display: "" }),
    "so": workerRow({ labor_type_display: 7 }),
    "null": workerRow({ labor_type_display: null }),
    "object": workerRow({ labor_type_display: { display_name: LABEL } }),
    "mang": workerRow({ labor_type_display: [LABEL] }),
    "boolean": workerRow({ labor_type_display: true }),
    "undefined": workerRow({ labor_type_display: undefined }),
  };
  for (const [label, value] of Object.entries(rejected)) {
    assert.equal(projectWorkerDirectoryRow(value), null, "row / " + label);
    assert.equal(
      projectWorkerDirectoryPage(workerPage({ items: [value] }), { scope: "managed", page_size: 25 }),
      null,
      "page / " + label,
    );
  }
});

test("entry payload: nhan rong/thieu/sai kieu lam ca projection unavailable", () => {
  const accepted = projectEntry(entryProjection());
  assert.ok(accepted, "mot entry co nhan that phai duoc chap nhan");
  assert.equal(accepted.labor_type, "PROBATION");
  assert.equal(accepted.labor_type_display, LABEL);

  const rejected = {
    "thieu field": withoutKey(entryProjection(), "labor_type_display"),
    "chuoi rong": entryProjection({ labor_type_display: "" }),
    "so": entryProjection({ labor_type_display: 1 }),
    "null": entryProjection({ labor_type_display: null }),
    "object": entryProjection({ labor_type_display: { display_name: LABEL } }),
    "mang": entryProjection({ labor_type_display: [LABEL] }),
    "boolean": entryProjection({ labor_type_display: false }),
    "undefined": entryProjection({ labor_type_display: undefined }),
  };
  for (const [label, value] of Object.entries(rejected)) {
    assert.equal(projectEntry(value), null, label);
  }
  assert.equal(projectEntry(withoutKey(entryProjection(), "worker_portrait")), null,
    "portrait projection remains required even when no portrait exists");
});

test("change request detail: nhan phai khop voi su hien dien cua labor type trong proposal", () => {
  const detail = projectChangeRequestDetail(detailBody([detailItem()]), { request_id: requestId });
  assert.ok(detail, "item ENTRY_FIELD co labor type va co nhan phai duoc chap nhan");
  const item = detail.items[0];
  assert.deepEqual(item.proposal, { labor_type: "PROBATION" }, "proposal giu nguyen key nghiep vu");
  assert.equal(item.labor_type_display, LABEL);
  assert.equal("labor_type_display" in item.proposal, false,
    "nhan la sibling cua proposal, khong bao gio nam trong proposal");
  assert.deepEqual(Object.keys(item).sort(), [...DETAIL_ITEM_KEYS].sort());

  // Item KHONG mang labor type: nhan BAT BUOC dung bang null, khong duoc la chuoi nao.
  const noLaborType = {
    entry_id: entryId,
    target_kind: "ENTRY_FIELD",
    expected_version: 1,
    proposal: { first_work_date: "2026-11-01" },
    labor_type_display: null,
  };
  const withoutLaborType = projectChangeRequestDetail(detailBody([noLaborType]),
    { request_id: requestId });
  assert.ok(withoutLaborType, "item khong co labor type + nhan null phai duoc chap nhan");
  assert.equal(withoutLaborType.items[0].labor_type_display, null);

  const withLaborType = {
    "thieu field": withoutKey(detailItem(), "labor_type_display"),
    "chuoi rong": detailItem({ labor_type_display: "" }),
    "so": detailItem({ labor_type_display: 3 }),
    "null": detailItem({ labor_type_display: null }),
    "object": detailItem({ labor_type_display: {} }),
    "undefined": detailItem({ labor_type_display: undefined }),
  };
  for (const [label, value] of Object.entries(withLaborType)) {
    assert.equal(projectChangeRequestDetail(detailBody([value]), { request_id: requestId }), null,
      "co labor type / " + label);
  }

  const noLaborTypeVariants = {
    "thieu field": withoutKey(noLaborType, "labor_type_display"),
    "chuoi rong": { ...noLaborType, labor_type_display: "" },
    "chuoi nhan": { ...noLaborType, labor_type_display: LABEL },
    "so": { ...noLaborType, labor_type_display: 3 },
    "object": { ...noLaborType, labor_type_display: {} },
    "undefined": { ...noLaborType, labor_type_display: undefined },
  };
  for (const [label, value] of Object.entries(noLaborTypeVariants)) {
    assert.equal(projectChangeRequestDetail(detailBody([value]), { request_id: requestId }), null,
      "khong co labor type / " + label);
  }
});

test("key set: row Worker Directory va entry payload deu mang ca key lan nhan", () => {
  assert.equal(WORKER_DIRECTORY_ROW_KEYS.includes("labor_type"), true);
  assert.equal(WORKER_DIRECTORY_ROW_KEYS.includes("labor_type_display"), true);
  const row = projectWorkerDirectoryRow(workerRow());
  assert.deepEqual(Object.keys(row).sort(), [...WORKER_DIRECTORY_ROW_KEYS].sort(),
    "row tra ve dung key set da cong bo");

  const entry = projectEntry(entryProjection());
  const entryKeys = Object.keys(entry);
  assert.equal(entryKeys.includes("labor_type"), true);
  assert.equal(entryKeys.includes("labor_type_display"), true);
  assert.deepEqual([...entryKeys].sort(), Object.keys(entryProjection()).sort(),
    "entry tra ve nguyen key set da gui, khong tu them/bot field");

  // Ca hai deu la thanh vien BAT BUOC cua key set: thieu mot trong hai la unavailable.
  assert.equal(projectEntry(withoutKey(entryProjection(), "labor_type")), null);
  assert.equal(projectEntry(withoutKey(entryProjection(), "labor_type_display")), null);
  assert.equal(projectEntry(withoutKey(entryProjection(), "worker_portrait")), null);
  assert.equal(projectWorkerDirectoryRow(withoutKey(workerRow(), "labor_type")), null);
  assert.equal(projectWorkerDirectoryRow(withoutKey(workerRow(), "labor_type_display")), null);

  assert.deepEqual([...DETAIL_ITEM_KEYS].sort(),
    ["entry_id", "expected_version", "labor_type_display", "proposal", "target_kind"],
    "key set cua detail item la chinh xac");
});

test("nhan duoc truyen nguyen ven: khong map theo key, khong thay bang key hay nhan fallback", () => {
  const row = projectWorkerDirectoryRow(workerRow());
  assert.equal(row.labor_type_display, LABEL);
  assert.notEqual(row.labor_type_display, row.labor_type);
  assert.notEqual(row.labor_type_display, FORBIDDEN_FALLBACK);

  const entry = projectEntry(entryProjection());
  assert.equal(entry.labor_type_display, LABEL);
  assert.notEqual(entry.labor_type_display, entry.labor_type);
  assert.notEqual(entry.labor_type_display, FORBIDDEN_FALLBACK);

  const detail = projectChangeRequestDetail(detailBody([detailItem()]), { request_id: requestId });
  assert.equal(detail.items[0].labor_type_display, LABEL);
  assert.notEqual(detail.items[0].labor_type_display, detail.items[0].proposal.labor_type);
  assert.notEqual(detail.items[0].labor_type_display, FORBIDDEN_FALLBACK);

  // Mot cap (key, nhan) ma contract chua bao gio biet cung phai di qua nguyen ven:
  // day la bang chung khong co static map o lop TypeScript.
  const freshKey = "SOME_UNSEEN_KEY";
  const freshLabel = "Nhãn động chưa từng biết";
  assert.equal(projectWorkerDirectoryRow(workerRow({
    labor_type: freshKey, labor_type_display: freshLabel,
  })).labor_type_display, freshLabel);
  assert.equal(projectEntry(entryProjection({
    labor_type: freshKey, labor_type_display: freshLabel,
  })).labor_type_display, freshLabel);
  assert.equal(projectChangeRequestDetail(detailBody([detailItem({
    proposal: { labor_type: freshKey }, labor_type_display: freshLabel,
  })]), { request_id: requestId }).items[0].labor_type_display, freshLabel);
});
