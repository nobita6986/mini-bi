/**
 * P3.1-W02C-R2 - #80 labor type display projection tren ba read surface, DB acceptance.
 *
 * PGlite ap TOAN BO migration local (from scratch) va goi RPC y nhu service-role
 * repository: khong mang, khong Supabase, khong browser. File nay chung minh:
 *   * mot key DANG hoat dong vua nam trong input catalog (ACTIVE-only) vua duoc
 *     resolve thanh nhan that tren ca ba read surface;
 *   * mot key DA TAT khong con la lua chon moi nhung van resolve DUNG nhan cho
 *     row/item da luu - phep tra cuu nhan khong co filter active;
 *   * khong co static map: mot key sinh sau qua admin RPC van tra ve dung
 *     display_name, khong bao gio la key tho hay 'Khong xac dinh';
 *   * phep tra cuu la LIVE: doi display_name bang direct_entry_update_labor_type
 *     thi ca ba surface doi ngay, khong co snapshot;
 *   * shape change request: proposal van giu KEY nghiep vu, nhan la SIBLING
 *     `labor_type_display`, va item khong mang labor type thi nhan dung bang null;
 *   * write guard khong doi: key da tat va key khong ton tai van 23514, khong de
 *     lai entry/revision/audit residue nao.
 *
 * Moi assertion tu choi chi so sanh SQLSTATE, khong bao gio doc message tho, nen
 * khong dinh danh hay du lieu ca nhan nao co the ro ri qua mot test that bai.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTORS,
  PROJECT_ID,
  RECRUITER_A,
  TEAM_A,
  createChangeRequest,
  createMigratedDatabase,
  item,
  readChangeRequest,
  seedChangeRequestFixture,
  transitionInput,
} from "./lib/s04c-read-fixture.mjs";

const R2_MIGRATION = "20261011130000_p3_1_w02c_r2_labor_type_display_projection.sql";
const WORK_DATE = "2026-10-15";
const REASON = "Synthetic R2 labor type display reason";
const UNKNOWN_KEY = "R2_NO_SUCH_LABOR_TYPE";

/** Key seed cua #79: mot key con hoat dong lam mau "choosable + resolvable". */
const ACTIVE_KEY = "TEMPORARY";
const ACTIVE_LABEL = "Thời vụ";
/** Key seed cua #79 se bi TAT: van phai resolve nhan cho du lieu da luu. */
const RETIRED_KEY = "PERMANENT";
const RETIRED_LABEL = "Chính thức";

/** Key sinh DONG qua admin RPC: khong nam trong bat ky static map nao. */
const DYNAMIC_KEY = "PROBATION";
const DYNAMIC_LABEL = "Thời gian thử việc động R2";
/** Key dung cho phep thu LIVE LOOKUP (doi display_name). */
const RENAME_KEY = "ROTATION";
const RENAME_LABEL_BEFORE = "Luân chuyển";
const RENAME_LABEL_AFTER = "Ca xoay vòng R2";
/** Sentinel bi migration #80 cam tren moi read surface. */
const FORBIDDEN_FALLBACK = "Không xác định";

/** Actor quan tri catalog: catalog_master_manage + all scope (khong co trong fixture chung). */
const CATALOG_OPERATOR = {
  auth_subject: "10000000-0000-4000-8000-0000000000d1",
  app_user_id: "20000000-0000-4000-8000-0000000000d1",
};

const RPC_PARAMS = {
  direct_entry_create_labor_type: ["p_auth_subject", "p_app_user_id", "p_expected_version",
    "p_labor_type_key", "p_display_name", "p_sort_order", "p_reason", "p_idempotency_key"],
  direct_entry_update_labor_type: ["p_auth_subject", "p_app_user_id", "p_labor_type_key",
    "p_expected_version", "p_display_name", "p_sort_order", "p_reason", "p_idempotency_key"],
  direct_entry_set_labor_type_active: ["p_auth_subject", "p_app_user_id", "p_labor_type_key",
    "p_active", "p_expected_version", "p_reason", "p_idempotency_key"],
  direct_entry_input_catalog: ["p_auth_subject", "p_app_user_id", "p_effective_date"],
  direct_entry_read_projection: ["p_auth_subject", "p_app_user_id", "p_entry_id"],
  direct_entry_list_workers: ["p_auth_subject", "p_app_user_id", "p_scope", "p_project_id",
    "p_recruiter_id", "p_employment_status", "p_cursor", "p_page_size"],
};

async function rpc(db, name, args = {}) {
  const order = RPC_PARAMS[name];
  assert.ok(order, "unknown rpc " + name);
  const values = order.map((key) => (key in args ? args[key] : null));
  const signature = order.map((_, index) => "$" + (index + 1)).join(", ");
  const { rows } = await db.query("select public." + name + "(" + signature + ") as result", values);
  return rows[0].result;
}

/** Create/update/set-active: dung dung ba duong admin cua #79, khong cham bang tay. */
function createLaborType(db, { key, displayName, sortOrder, idempotencyKey }) {
  return rpc(db, "direct_entry_create_labor_type", {
    p_auth_subject: CATALOG_OPERATOR.auth_subject,
    p_app_user_id: CATALOG_OPERATOR.app_user_id,
    p_expected_version: 0,
    p_labor_type_key: key,
    p_display_name: displayName,
    p_sort_order: sortOrder,
    p_reason: REASON,
    p_idempotency_key: idempotencyKey,
  });
}

function updateLaborType(db, { key, expectedVersion, displayName, sortOrder, idempotencyKey }) {
  return rpc(db, "direct_entry_update_labor_type", {
    p_auth_subject: CATALOG_OPERATOR.auth_subject,
    p_app_user_id: CATALOG_OPERATOR.app_user_id,
    p_labor_type_key: key,
    p_expected_version: expectedVersion,
    p_display_name: displayName,
    p_sort_order: sortOrder,
    p_reason: REASON,
    p_idempotency_key: idempotencyKey,
  });
}

function setLaborTypeActive(db, { key, active, expectedVersion, idempotencyKey }) {
  return rpc(db, "direct_entry_set_labor_type_active", {
    p_auth_subject: CATALOG_OPERATOR.auth_subject,
    p_app_user_id: CATALOG_OPERATOR.app_user_id,
    p_labor_type_key: key,
    p_active: active,
    p_expected_version: expectedVersion,
    p_reason: REASON,
    p_idempotency_key: idempotencyKey,
  });
}

async function currentVersion(db, key) {
  return (await db.query(
    "select version from public.direct_entry_labor_types where labor_type_key = $1",
    [key])).rows[0].version;
}

/** Input catalog ACTIVE-only ma runtime Direct Entry nhan qua getInputCatalog. */
function inputCatalog(db) {
  return rpc(db, "direct_entry_input_catalog", {
    p_auth_subject: ACTORS.proposer.auth_subject,
    p_app_user_id: ACTORS.proposer.app_user_id,
    p_effective_date: WORK_DATE,
  });
}

const WORKER_DETAILS = {
  display_name: "Synthetic R2 Worker",
  date_of_birth: { state: "unknown" },
  national_id: { state: "unknown" },
  address: { state: "unknown" },
  phone: { state: "unknown" },
};

async function insertEntryRow(db, {
  submissionId, candidateId, employeeCode, laborType, firstWorkDate,
}) {
  const { rows } = await db.query(
    "insert into public.direct_entries"
    + " (submission_id, candidate_id, created_by_user_id, project_id, first_work_date,"
    + "  employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type)"
    + " values ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6, $7::jsonb, $8::uuid, $9::uuid,"
    + " 'hrp', $10)"
    + " returning entry_id",
    [submissionId, candidateId, ACTORS.proposer.app_user_id, PROJECT_ID, firstWorkDate,
      employeeCode, JSON.stringify(WORKER_DETAILS), RECRUITER_A, TEAM_A, laborType],
  );
  return rows[0].entry_id;
}

/**
 * Mot entry SUBMITTED that su: submission + candidate + entry trong MOT transaction
 * (submission co constraint trigger deferred "khong duoc rong"), roi di dung duong
 * DRAFT -> REVIEW -> SUBMITTED qua RPC that.
 */
async function addSubmittedEntry(db, { employeeCode, laborType, firstWorkDate }) {
  await db.query("begin");
  let submissionId;
  let entryId;
  try {
    submissionId = (await db.query(
      "insert into public.direct_entry_submissions (created_by_user_id) values ($1::uuid)"
      + " returning submission_id", [ACTORS.proposer.app_user_id])).rows[0].submission_id;
    const candidateId = (await db.query(
      "insert into public.direct_entry_candidates default values returning candidate_id",
    )).rows[0].candidate_id;
    entryId = await insertEntryRow(db, {
      submissionId, candidateId, employeeCode, laborType, firstWorkDate,
    });
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
  const suffix = employeeCode.slice(-6);
  const toReview = transitionInput(ACTORS.proposer, submissionId, 1, "REVIEW", "r2a_" + suffix);
  await db.query(toReview.sql, toReview.values);
  const toSubmitted = transitionInput(ACTORS.proposer, submissionId, 2, "SUBMITTED", "r2b_" + suffix);
  await db.query(toSubmitted.sql, toSubmitted.values);
  return entryId;
}

async function createRequest(db, items, suffix) {
  const created = await createChangeRequest(db, ACTORS.proposer, items,
    "Synthetic R2 request " + suffix, "r2_create_" + suffix);
  if (created.error) throw new Error("change request " + suffix + " failed: " + created.error.message);
  return created.data.request_id;
}

// ---------------------------------------------------------------------------
// Fixture. seedChangeRequestFixture lo team/recruiter/project/actor va submission
// da SUBMITTED; phan con lai la actor quan tri catalog va cac entry mang dung key
// ma tung test can.
// ---------------------------------------------------------------------------
const { db, migrationNames } = await createMigratedDatabase();
assert.equal(migrationNames.at(-3), R2_MIGRATION, "#80 la migration display projection");

const fixture = await seedChangeRequestFixture(db);
assert.equal(typeof fixture.entryA.entry_id, "string", "fixture chung phai seed xong");

await db.query("insert into auth.users (id) values ($1::uuid)", [CATALOG_OPERATOR.auth_subject]);
await db.query(
  "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)"
  + " values ($1::uuid, $2::uuid, true, 'Synthetic Catalog Operator')",
  [CATALOG_OPERATOR.app_user_id, CATALOG_OPERATOR.auth_subject],
);
await db.query(
  "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)"
  + " values ($1::uuid, 'catalog_master_manage', '2020-01-01')",
  [CATALOG_OPERATOR.app_user_id],
);
await db.query(
  "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from)"
  + " values ($1::uuid, 'all', '2020-01-01')",
  [CATALOG_OPERATOR.app_user_id],
);

const DYNAMIC_CREATED = await createLaborType(db, {
  key: DYNAMIC_KEY, displayName: DYNAMIC_LABEL, sortOrder: 40, idempotencyKey: "r2_create_dynamic",
});
assert.equal(DYNAMIC_CREATED.created, true, "PROBATION duoc sinh dong qua admin RPC");
await createLaborType(db, {
  key: RENAME_KEY, displayName: RENAME_LABEL_BEFORE, sortOrder: 50, idempotencyKey: "r2_create_rename",
});

const ACTIVE_ENTRY = await addSubmittedEntry(db, {
  employeeCode: "hrp-2026-500001", laborType: ACTIVE_KEY, firstWorkDate: "2026-10-15",
});
const RETIRED_ENTRY = await addSubmittedEntry(db, {
  employeeCode: "hrp-2026-500002", laborType: RETIRED_KEY, firstWorkDate: "2026-10-16",
});
const DYNAMIC_ENTRY = await addSubmittedEntry(db, {
  employeeCode: "hrp-2026-500003", laborType: DYNAMIC_KEY, firstWorkDate: "2026-10-17",
});
const RENAME_ENTRY = await addSubmittedEntry(db, {
  employeeCode: "hrp-2026-500004", laborType: RENAME_KEY, firstWorkDate: "2026-10-18",
});
/** Entry nay chi de item "khong mang labor type" co mot entry rieng (unique request_id, entry_id). */
const PLAIN_ENTRY = await addSubmittedEntry(db, {
  employeeCode: "hrp-2026-500005", laborType: ACTIVE_KEY, firstWorkDate: "2026-10-19",
});

const ACTIVE_REQUEST = await createRequest(db, [
  item(ACTIVE_ENTRY, 1, { labor_type: ACTIVE_KEY }),
  item(PLAIN_ENTRY, 1, { first_work_date: "2026-11-01" }),
], "active");
const RETIRED_REQUEST = await createRequest(db, [
  item(RETIRED_ENTRY, 1, { labor_type: RETIRED_KEY }),
], "retired");
const DYNAMIC_REQUEST = await createRequest(db, [
  item(DYNAMIC_ENTRY, 1, { labor_type: DYNAMIC_KEY }),
], "dynamic");
const RENAME_REQUEST = await createRequest(db, [
  item(RENAME_ENTRY, 1, { labor_type: RENAME_KEY }),
], "rename");

// ---------------------------------------------------------------------------
// Ba read surface. Moi helper chi DOC, khong de lai trang thai nao.
// ---------------------------------------------------------------------------

/** Surface 1: mot dong Worker Directory (audience 'all' = all scope + change_review). */
async function workerRow(entryId) {
  const page = await rpc(db, "direct_entry_list_workers", {
    p_auth_subject: ACTORS.reviewerAll.auth_subject,
    p_app_user_id: ACTORS.reviewerAll.app_user_id,
    p_scope: "all",
    p_page_size: 100,
  });
  return page.items.find((row) => row.entry_id === entryId) ?? null;
}

/** Surface 2: payload entry cua direct_entry_read_projection (nguoi tao doc row cua minh). */
function readProjection(entryId) {
  return rpc(db, "direct_entry_read_projection", {
    p_auth_subject: ACTORS.proposer.auth_subject,
    p_app_user_id: ACTORS.proposer.app_user_id,
    p_entry_id: entryId,
  });
}

/** Surface 3: item cua direct_entry_read_change_request (reviewer all scope). */
async function requestItem(requestId, entryId) {
  const read = await readChangeRequest(db, ACTORS.reviewerAll, requestId);
  assert.equal(read.error, null, "reviewer phai doc duoc change request detail");
  const found = read.data.items.find((entry) => entry.entry_id === entryId);
  assert.ok(found, "change request item phai ton tai");
  return found;
}

/**
 * Ca BA read surface phai tra ve DUNG cap (key, nhan): key nghiep vu khong doi, nhan
 * resolve tu catalog va KHONG BAO GIO nam trong proposal.
 */
async function assertAllSurfaces({ entryId, requestId, key, label }) {
  const row = await workerRow(entryId);
  assert.ok(row, "worker directory phai liet ke entry");
  assert.equal(row.labor_type, key, "worker directory giu nguyen key nghiep vu");
  assert.equal(row.labor_type_display, label, "worker directory resolve dung nhan");

  const projection = await readProjection(entryId);
  assert.equal(projection.entry_id, entryId);
  assert.equal(projection.labor_type, key, "entry read giu nguyen key nghiep vu");
  assert.equal(projection.labor_type_display, label, "entry read resolve dung nhan");

  const changeItem = await requestItem(requestId, entryId);
  assert.equal(changeItem.proposal.labor_type, key, "proposal giu nguyen key nghiep vu");
  assert.equal(changeItem.labor_type_display, label, "change item resolve dung nhan");
  assert.equal("labor_type_display" in changeItem.proposal, false,
    "nhan la sibling cua proposal, khong bao gio nam trong proposal");
  assert.notEqual(changeItem.labor_type_display, key, "nhan khong bao gio la key tho");
  assert.notEqual(changeItem.labor_type_display, FORBIDDEN_FALLBACK);
}

// ---------------------------------------------------------------------------

test("1: key DANG hoat dong vua la lua chon vua resolve nhan tren ca ba read surface", async () => {
  const catalog = await inputCatalog(db);
  const option = catalog.labor_types.find((row) => row.labor_type_key === ACTIVE_KEY);
  assert.ok(option, "mot key dang hoat dong phai nam trong input catalog");
  assert.equal(option.display_name, ACTIVE_LABEL);

  await assertAllSurfaces({
    entryId: ACTIVE_ENTRY, requestId: ACTIVE_REQUEST, key: ACTIVE_KEY, label: ACTIVE_LABEL,
  });

  const row = await workerRow(ACTIVE_ENTRY);
  assert.notEqual(row.labor_type_display, row.labor_type, "nhan khac key tho");
  assert.notEqual(row.labor_type_display, FORBIDDEN_FALLBACK);
});

test("2: key DA TAT roi khoi lua chon nhung van resolve nhan cho du lieu da luu", async () => {
  const off = await setLaborTypeActive(db, {
    key: RETIRED_KEY, active: false, expectedVersion: await currentVersion(db, RETIRED_KEY),
    idempotencyKey: "r2_retire",
  });
  assert.equal(off.active, false);

  // Lua chon moi: key da tat bien mat khoi input catalog ACTIVE-only.
  const catalog = await inputCatalog(db);
  assert.equal(catalog.labor_types.some((row) => row.labor_type_key === RETIRED_KEY), false,
    "key da tat khong con la lua chon moi");
  const direct = (await db.query(
    "select public.direct_entry_labor_type_options() as options")).rows[0].options;
  assert.equal(direct.some((row) => row.labor_type_key === RETIRED_KEY), false);

  // Nhung du lieu DA LUU van resolve dung nhan: phep tra cuu khong loc active.
  await assertAllSurfaces({
    entryId: RETIRED_ENTRY, requestId: RETIRED_REQUEST, key: RETIRED_KEY, label: RETIRED_LABEL,
  });
});

test("3: khong co static map - key sinh dong tra ve dung display_name cua catalog", async () => {
  // PROBATION khong phai seed va khong la hang so trong source: no chi ton tai trong
  // catalog, nen mot nhan dung o day chung minh phep tra cuu la dong.
  const catalog = await inputCatalog(db);
  const option = catalog.labor_types.find((row) => row.labor_type_key === DYNAMIC_KEY);
  assert.ok(option, "key sinh dong phai la lua chon moi");
  assert.equal(option.display_name, DYNAMIC_LABEL);

  await assertAllSurfaces({
    entryId: DYNAMIC_ENTRY, requestId: DYNAMIC_REQUEST, key: DYNAMIC_KEY, label: DYNAMIC_LABEL,
  });

  const row = await workerRow(DYNAMIC_ENTRY);
  assert.equal(row.labor_type_display, DYNAMIC_LABEL, "nhan dung bang display_name cua catalog");
  assert.notEqual(row.labor_type_display, DYNAMIC_KEY, "khong bao gio tra ve key tho");
  assert.notEqual(row.labor_type_display, FORBIDDEN_FALLBACK, "khong bao gio co nhan fallback");
});

test("4: phep tra cuu nhan la LIVE - doi display_name thi ca ba surface doi ngay", async () => {
  await assertAllSurfaces({
    entryId: RENAME_ENTRY, requestId: RENAME_REQUEST, key: RENAME_KEY, label: RENAME_LABEL_BEFORE,
  });

  const renamed = await updateLaborType(db, {
    key: RENAME_KEY, expectedVersion: await currentVersion(db, RENAME_KEY),
    displayName: RENAME_LABEL_AFTER, sortOrder: 50, idempotencyKey: "r2_rename",
  });
  assert.equal(renamed.display_name, RENAME_LABEL_AFTER);
  assert.equal(renamed.labor_type_key, RENAME_KEY, "key nghiep vu khong doi khi doi nhan");

  // Khong co snapshot: dung ba surface do lai phai thay nhan MOI ngay lap tuc.
  await assertAllSurfaces({
    entryId: RENAME_ENTRY, requestId: RENAME_REQUEST, key: RENAME_KEY, label: RENAME_LABEL_AFTER,
  });
  const row = await workerRow(RENAME_ENTRY);
  assert.equal(row.labor_type_display.includes(RENAME_LABEL_BEFORE), false,
    "nhan cu khong con xuat hien o bat ky surface nao");
});

test("5: shape change request - nhan la sibling cua proposal", async () => {
  const read = await readChangeRequest(db, ACTORS.reviewerAll, ACTIVE_REQUEST);
  assert.equal(read.error, null);

  const withKey = read.data.items.find((entry) => entry.entry_id === ACTIVE_ENTRY);
  assert.deepEqual(Object.keys(withKey).sort(),
    ["entry_id", "expected_version", "labor_type_display", "proposal", "target_kind"]);
  assert.deepEqual(withKey.proposal, { labor_type: ACTIVE_KEY },
    "proposal van giu dung KEY nghiep vu, khong bi doi thanh nhan");
  assert.equal(withKey.labor_type_display, ACTIVE_LABEL);
  assert.equal("labor_type_display" in withKey.proposal, false);
  assert.equal(Object.keys(withKey.proposal).includes("labor_type_display"), false);

  const withoutKey = read.data.items.find((entry) => entry.entry_id === PLAIN_ENTRY);
  assert.equal(withoutKey.labor_type_display, null,
    "item khong mang labor type thi nhan dung bang null");
  assert.deepEqual(withoutKey.proposal, { first_work_date: "2026-11-01" });
  assert.equal("labor_type" in withoutKey.proposal, false);
});

test("6: write guard khong doi - key da tat va key khong ton tai deu 23514, khong residue", async () => {
  // Tien de duoc kiem tra tuong minh thay vi tin vao thu tu test: RETIRED_KEY da bi
  // tat, UNKNOWN_KEY la key canonical nhung khong he co trong catalog.
  const retired = (await db.query(
    "select active from public.direct_entry_labor_types where labor_type_key = $1",
    [RETIRED_KEY])).rows[0];
  assert.equal(retired.active, false, "RETIRED_KEY phai dang bi tat truoc khi thu write guard");
  assert.equal((await db.query(
    "select count(*)::int as n from public.direct_entry_labor_types where labor_type_key = $1",
    [UNKNOWN_KEY])).rows[0].n, 0, "UNKNOWN_KEY khong duoc ton tai trong catalog");

  const before = await counts(db);

  const inactive = await writeProbe(db, { employeeCode: "hrp-2026-510001", laborType: RETIRED_KEY });
  assert.equal(inactive.code, "23514", "key da tat khong bao gio la mot cu ghi moi hop le");
  assert.equal(inactive.entryId, null);

  const unknown = await writeProbe(db, { employeeCode: "hrp-2026-510002", laborType: UNKNOWN_KEY });
  assert.equal(unknown.code, "23514", "key khong ton tai that bai cung mot guard");
  assert.equal(unknown.entryId, null);

  assert.deepEqual(await counts(db), before,
    "khong de lai entry/revision/audit/idempotency residue nao");

  // Doi chung duong: cung mot probe voi key DANG hoat dong thi ghi duoc, nen 23514
  // o tren den tu trang thai catalog chu khong tu mot fixture hong.
  const control = await writeProbe(db, { employeeCode: "hrp-2026-510003", laborType: ACTIVE_KEY });
  assert.equal(control.code, null, "key dang hoat dong van ghi duoc binh thuong");
  assert.equal(typeof control.entryId, "string");
});

/** Anh chup toan bo bang co the bi mot cu ghi bi tu choi lam ban. */
async function counts(db) {
  const { rows } = await db.query(
    "select (select count(*)::int from public.direct_entry_labor_types) as labor_types,"
    + " (select count(*)::int from public.direct_entry_labor_type_revisions) as labor_type_revisions,"
    + " (select count(*)::int from public.direct_entries) as entries,"
    + " (select count(*)::int from public.direct_entry_candidates) as candidates,"
    + " (select count(*)::int from public.direct_entry_submissions) as submissions,"
    + " (select count(*)::int from public.direct_entry_revisions) as revisions,"
    + " (select count(*)::int from public.direct_entry_audit_events) as audits,"
    + " (select count(*)::int from public.direct_entry_restricted_reasons) as reasons,"
    + " (select count(*)::int from public.direct_entry_rpc_idempotency) as idempotency",
  );
  return rows[0];
}

/**
 * Probe write guard. Ca candidate + submission + entry nam trong MOT transaction,
 * nen mot cu ghi bi tu choi rollback sach - do la cach do residue mot cach trung thuc.
 */
async function writeProbe(db, { employeeCode, laborType }) {
  await db.query("begin");
  try {
    const submissionId = (await db.query(
      "insert into public.direct_entry_submissions (created_by_user_id) values ($1::uuid)"
      + " returning submission_id", [ACTORS.proposer.app_user_id])).rows[0].submission_id;
    const candidateId = (await db.query(
      "insert into public.direct_entry_candidates default values returning candidate_id",
    )).rows[0].candidate_id;
    const entryId = await insertEntryRow(db, {
      submissionId, candidateId, employeeCode, laborType, firstWorkDate: WORK_DATE,
    });
    await db.query("commit");
    return { code: null, entryId };
  } catch (error) {
    await db.query("rollback");
    return { code: error.code, entryId: null };
  }
}
