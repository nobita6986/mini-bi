/**
 * P3.1-W02C-R3 - #81 labor_type_display tren Own Draft projection, DB acceptance.
 *
 * PGlite ap TOAN BO migration local (from scratch) va goi RPC y nhu service-role
 * repository: khong mang, khong Supabase, khong browser. File nay chung minh:
 *   * mot draft luu key DANG hoat dong tra ve CA key lan nhan that, va envelope
 *     bao dung \`direct-entry-draft-list/2\`;
 *   * mot key DA TAT khong con la lua chon moi (input catalog ACTIVE-only) nhung
 *     draft da luu van resolve DUNG display_name - phep tra cuu khong loc active;
 *   * khong co static map: mot key sinh dong qua admin RPC van tra ve dung
 *     display_name, khong bao gio la key tho hay 'Khong xac dinh'; doi ten bang
 *     direct_entry_update_labor_type thi payload doi NGAY, khong co snapshot;
 *   * #81 khong noi rong gi: cung entry set, cung key set (20 key), draft cua
 *     actor khac van vo hinh;
 *   * mot key KHONG co catalog row khong bao gio bi lang le bo qua va khong bao
 *     gio sinh ra mot nhan bia dat: bieu thuc SQL cua RPC tra ve JSON null, va
 *     projection nghiem ngat cua client TU CHOI mot element nhu vay.
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
  assertDataOk,
  createMigratedDatabase,
  seedChangeRequestFixture,
} from "./lib/s04c-read-fixture.mjs";
import {
  DRAFT_LIST_PROJECTION_VERSION,
  projectOwnDrafts,
} from "../src/lib/direct-entry/draft-list-contract.ts";

const R3_MIGRATION = "20261011140000_p3_1_w02c_r3_own_draft_display_projection.sql";
const WORK_DATE = "2026-10-15";
const REASON = "Synthetic R3 own draft display reason";

/** Key canonical nhung KHONG he co trong catalog: khong the luu, chi co the tra cuu. */
const UNKNOWN_KEY = "R3_NO_SUCH_LABOR_TYPE";

/**
 * Du an thu hai, KHONG co project manager assignment nao. Scope resolver cua draft
 * cho project manager thay MOI draft trong du an minh quan ly (P3-W07C-R7), nen
 * muon chung minh "draft cua actor khac van vo hinh" thi draft do phai nam o mot
 * du an ma proposer khong quan ly.
 */
const FOREIGN_PROJECT_ID = "r3_foreign_project";

/** Key seed cua #79: mot key con hoat dong lam mau "choosable + resolvable". */
const ACTIVE_KEY = "TEMPORARY";
const ACTIVE_LABEL = "Thời vụ";
/** Key seed cua #79 se bi TAT: draft da luu van phai resolve nhan cua no. */
const INACTIVE_KEY = "PERMANENT";
const INACTIVE_LABEL = "Chính thức";

/** Key sinh DONG qua admin RPC: khong nam trong bat ky static map nao. */
const DYNAMIC_KEY = "PROBATION";
const DYNAMIC_LABEL = "Thời gian thử việc động R3";
/** Nhan MOI sau khi doi ten: phep tra cuu phai la LIVE, khong snapshot. */
const RENAMED_LABEL = "Ca thử việc đổi tên R3";
/** Sentinel bi #80/#81 cam tren moi read surface. */
const FORBIDDEN_FALLBACK = "Không xác định";

/**
 * Key set CHINH XAC cua mot draft /2: 19 key cu + \`labor_type_display\`. Danh
 * sach nay duoc viet tuong minh de mot thay doi shape (them/bot key) lam test do,
 * chu khong the lang le di qua.
 */
const DRAFT_KEYS = [
  "submission_id",
  "submission_version",
  "entry_id",
  "entry_version",
  "employee_code",
  "first_work_date",
  "worker_display_name",
  "project_id",
  "project_display_name",
  "recruiter_id",
  "recruiter_display_name",
  "provider_type",
  "team_id",
  "team_display_name",
  "labor_type",
  "labor_type_display",
  "employment_status",
  "created_at",
  "updated_at",
  "profile",
];

/** Actor quan tri catalog: catalog_master_manage + all scope (khong co trong fixture chung). */
const CATALOG_OPERATOR = {
  auth_subject: "10000000-0000-4000-8000-0000000000e1",
  app_user_id: "20000000-0000-4000-8000-0000000000e1",
};

const RPC_PARAMS = {
  direct_entry_create_labor_type: ["p_auth_subject", "p_app_user_id", "p_expected_version",
    "p_labor_type_key", "p_display_name", "p_sort_order", "p_reason", "p_idempotency_key"],
  direct_entry_update_labor_type: ["p_auth_subject", "p_app_user_id", "p_labor_type_key",
    "p_expected_version", "p_display_name", "p_sort_order", "p_reason", "p_idempotency_key"],
  direct_entry_set_labor_type_active: ["p_auth_subject", "p_app_user_id", "p_labor_type_key",
    "p_active", "p_expected_version", "p_reason", "p_idempotency_key"],
  direct_entry_input_catalog: ["p_auth_subject", "p_app_user_id", "p_effective_date"],
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

/** Nhan THAT cua mot key trong catalog, doc truc tiep tu bang chu khong qua RPC nao. */
async function catalogLabel(db, key) {
  const { rows } = await db.query(
    "select display_name from public.direct_entry_labor_types where labor_type_key = $1", [key]);
  return rows.length === 0 ? null : rows[0].display_name;
}

/** Input catalog ACTIVE-only ma runtime Direct Entry nhan qua getInputCatalog. */
function inputCatalog(db) {
  return rpc(db, "direct_entry_input_catalog", {
    p_auth_subject: ACTORS.proposer.auth_subject,
    p_app_user_id: ACTORS.proposer.app_user_id,
    p_effective_date: WORK_DATE,
  });
}

/** Lua chon moi (ACTIVE-only) doc thang tu projection cua #79. */
async function laborTypeOptions(db) {
  return (await db.query("select public.direct_entry_labor_type_options() as options")).rows[0].options;
}

/** Payload Own Draft y nhu repository nhan: chi DOC, khong de lai trang thai nao. */
async function listOwnDrafts(db, actor = ACTORS.proposer) {
  return (await db.query(
    "select public.direct_entry_list_own_drafts($1::uuid,$2::uuid) as data",
    [actor.auth_subject, actor.app_user_id])).rows[0].data;
}

function draftFor(payload, entryId) {
  const found = payload.drafts.find((draft) => draft.entry_id === entryId);
  assert.ok(found, "draft " + entryId + " phai nam trong payload own draft");
  return found;
}

const WORKER_DETAILS = {
  display_name: "Synthetic R3 Worker",
  date_of_birth: { state: "unknown" },
  national_id: { state: "unknown" },
  address: { state: "unknown" },
  phone: { state: "unknown" },
};

/** Mot DRAFT that su: submission + entry qua dung RPC create batch cua write path. */
async function createDraftEntry(db, { employeeCode, laborType, firstWorkDate, idempotencyKey }) {
  const data = assertDataOk(await db.query(
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text) as data",
    [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id,
      JSON.stringify([{
        project_id: PROJECT_ID,
        first_work_date: firstWorkDate,
        employee_code: employeeCode,
        worker_details: WORKER_DETAILS,
        recruiter_id: RECRUITER_A,
        labor_type: laborType,
      }]),
      idempotencyKey]));
  assert.equal(data.state, "DRAFT", "batch phai de lai mot submission DRAFT");
  assert.equal(data.entry_ids.length, 1);
  return data.entry_ids[0];
}

/**
 * Ghim mot draft bang duong ghi truc tiep: dung cho draft cua MOT ACTOR KHAC (actor
 * do khong co quyen entry_create nen khong the di qua RPC) va cho probe write guard.
 * Submission + candidate + entry nam trong MOT transaction vi submission co rang
 * buoc deferred "khong duoc rong"; mot cu ghi bi tu choi rollback sach.
 */
async function insertDraftRow(db, {
  createdBy, employeeCode, laborType, firstWorkDate, projectId = PROJECT_ID,
}) {
  await db.query("begin");
  try {
    const submissionId = (await db.query(
      "insert into public.direct_entry_submissions (created_by_user_id) values ($1::uuid)"
      + " returning submission_id", [createdBy.app_user_id])).rows[0].submission_id;
    const candidateId = (await db.query(
      "insert into public.direct_entry_candidates default values returning candidate_id",
    )).rows[0].candidate_id;
    const entryId = (await db.query(
      "insert into public.direct_entries"
      + " (submission_id, candidate_id, created_by_user_id, project_id, first_work_date,"
      + "  employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type)"
      + " values ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6, $7::jsonb, $8::uuid, $9::uuid,"
      + " 'hrp', $10)"
      + " returning entry_id",
      [submissionId, candidateId, createdBy.app_user_id, projectId, firstWorkDate, employeeCode,
        JSON.stringify(WORKER_DETAILS), RECRUITER_A, TEAM_A, laborType])).rows[0].entry_id;
    await db.query("commit");
    return { code: null, entryId };
  } catch (error) {
    await db.query("rollback");
    return { code: error.code, entryId: null };
  }
}

// ---------------------------------------------------------------------------
// Fixture. seedChangeRequestFixture lo team/recruiter/project/actor; phan con lai
// la actor quan tri catalog, key sinh dong va cac DRAFT entry mang dung key ma
// tung test can.
// ---------------------------------------------------------------------------
const { db, migrationNames } = await createMigratedDatabase();
assert.equal(migrationNames.at(-34), R3_MIGRATION,
  "#81 la migration own draft display projection truoc cac migration W03A");

const fixture = await seedChangeRequestFixture(db);
assert.equal(typeof fixture.entryA.entry_id, "string", "fixture chung phai seed xong");

await db.query("insert into auth.users (id) values ($1::uuid)", [CATALOG_OPERATOR.auth_subject]);
await db.query(
  "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)"
  + " values ($1::uuid, $2::uuid, true, 'Synthetic Catalog Operator R3')",
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

// Key sinh dong: chi ton tai trong catalog sau lenh nay.
const DYNAMIC_CREATED = await createLaborType(db, {
  key: DYNAMIC_KEY, displayName: DYNAMIC_LABEL, sortOrder: 40,
  idempotencyKey: "r3_create_dynamic",
});
assert.equal(DYNAMIC_CREATED.created, true, "PROBATION duoc sinh dong qua admin RPC");

const ACTIVE_ENTRY = await createDraftEntry(db, {
  employeeCode: "hrp-2026-600001", laborType: ACTIVE_KEY, firstWorkDate: "2026-10-15",
  idempotencyKey: "r3_draft_active",
});
const INACTIVE_ENTRY = await createDraftEntry(db, {
  employeeCode: "hrp-2026-600002", laborType: INACTIVE_KEY, firstWorkDate: "2026-10-16",
  idempotencyKey: "r3_draft_inactive",
});
const DYNAMIC_ENTRY = await createDraftEntry(db, {
  employeeCode: "hrp-2026-600003", laborType: DYNAMIC_KEY, firstWorkDate: "2026-10-17",
  idempotencyKey: "r3_draft_dynamic",
});

// Du an thu hai khong co manager assignment: proposer khong co entry_admin/all nen
// khong the voi toi draft o day.
await db.query(
  "insert into public.direct_entry_projects (project_id, display_name) values ($1,$2)",
  [FOREIGN_PROJECT_ID, "R3 foreign project"]);

/** Draft cua actor khac: phai ton tai that trong SQL nhung khong thuoc scope cua proposer. */
const FOREIGN = await insertDraftRow(db, {
  createdBy: ACTORS.outsider, employeeCode: "hrp-2026-600004",
  laborType: ACTIVE_KEY, firstWorkDate: "2026-10-18", projectId: FOREIGN_PROJECT_ID,
});
assert.equal(FOREIGN.code, null, "draft cua actor khac phai ghim duoc");
assert.equal(typeof FOREIGN.entryId, "string");

/** Entry set ma payload own draft PHAI tra ve: dung ba draft cua proposer. */
const EXPECTED_ENTRY_IDS = [ACTIVE_ENTRY, INACTIVE_ENTRY, DYNAMIC_ENTRY].sort();

// ---------------------------------------------------------------------------

test("1: key DANG hoat dong - draft tra ve ca key lan nhan that, envelope la /2", async () => {
  const payload = await listOwnDrafts(db);
  assert.equal(payload.projection_version, DRAFT_LIST_PROJECTION_VERSION);
  assert.equal(payload.projection_version, "direct-entry-draft-list/2",
    "envelope phai bao dung shape /2");
  assert.equal(JSON.stringify(payload).includes("direct-entry-draft-list/1"), false,
    "shape /1 da bi thay the, khong duoc con xuat hien o bat ky dau");

  const draft = draftFor(payload, ACTIVE_ENTRY);
  assert.equal(draft.labor_type, ACTIVE_KEY, "key nghiep vu khong doi");
  const label = await catalogLabel(db, ACTIVE_KEY);
  assert.equal(label, ACTIVE_LABEL, "nhan cua catalog phai la nhan seed cua #79");
  assert.equal(draft.labor_type_display, label, "nhan phai bang display_name cua catalog");
  assert.equal(typeof draft.labor_type_display, "string");
  assert.equal(draft.labor_type_display.length > 0, true, "nhan khong duoc rong");
  assert.notEqual(draft.labor_type_display, draft.labor_type, "nhan khong bao gio la key tho");
  assert.notEqual(draft.labor_type_display, FORBIDDEN_FALLBACK);

  // Cung key nay dang la mot lua chon moi trong input catalog ACTIVE-only.
  const catalog = await inputCatalog(db);
  const option = catalog.labor_types.find((row) => row.labor_type_key === ACTIVE_KEY);
  assert.ok(option, "key dang hoat dong phai la lua chon moi");
  assert.equal(option.display_name, draft.labor_type_display,
    "nhan tren draft va nhan trong catalog la cung mot nguon");
});

test("2: key DA TAT roi khoi lua chon nhung draft van resolve dung nhan", async () => {
  const off = await setLaborTypeActive(db, {
    key: INACTIVE_KEY, active: false, expectedVersion: await currentVersion(db, INACTIVE_KEY),
    idempotencyKey: "r3_retire",
  });
  assert.equal(off.active, false);

  // Lua chon moi: key da tat bien mat khoi ca hai duong ACTIVE-only.
  const catalog = await inputCatalog(db);
  assert.equal(catalog.labor_types.some((row) => row.labor_type_key === INACTIVE_KEY), false,
    "key da tat khong con la lua chon moi trong input catalog");
  assert.equal((await laborTypeOptions(db)).some((row) => row.labor_type_key === INACTIVE_KEY),
    false, "key da tat khong con trong direct_entry_labor_type_options");

  // Nhung du lieu DA LUU van resolve dung nhan: phep tra cuu khong loc active.
  const payload = await listOwnDrafts(db);
  const draft = draftFor(payload, INACTIVE_ENTRY);
  assert.equal(draft.labor_type, INACTIVE_KEY, "draft khong duoc bien mat theo catalog");
  assert.equal(draft.labor_type_display, INACTIVE_LABEL, "nhan authoritative van duoc resolve");
  assert.equal(draft.labor_type_display, await catalogLabel(db, INACTIVE_KEY));
  assert.equal(draft.labor_type_display.length > 0, true);
  assert.notEqual(draft.labor_type_display, draft.labor_type);
  assert.notEqual(draft.labor_type_display, FORBIDDEN_FALLBACK);
});

test("3: khong co static map - key sinh dong va doi ten thi draft doi nhan NGAY", async () => {
  const before = await listOwnDrafts(db);
  const dynamic = draftFor(before, DYNAMIC_ENTRY);
  assert.equal(dynamic.labor_type, DYNAMIC_KEY);
  assert.equal(dynamic.labor_type_display, DYNAMIC_LABEL,
    "key sinh dong tra ve dung display_name cua catalog");
  assert.notEqual(dynamic.labor_type_display, DYNAMIC_KEY, "khong bao gio tra ve key tho");
  assert.notEqual(dynamic.labor_type_display, FORBIDDEN_FALLBACK);

  const renamed = await updateLaborType(db, {
    key: DYNAMIC_KEY, expectedVersion: await currentVersion(db, DYNAMIC_KEY),
    displayName: RENAMED_LABEL, sortOrder: 40, idempotencyKey: "r3_rename",
  });
  assert.equal(renamed.display_name, RENAMED_LABEL);
  assert.equal(renamed.labor_type_key, DYNAMIC_KEY, "doi nhan khong doi key nghiep vu");

  // Khong co snapshot: do lai ngay lap tuc phai thay nhan MOI.
  const after = await listOwnDrafts(db);
  const renamedDraft = draftFor(after, DYNAMIC_ENTRY);
  assert.equal(renamedDraft.labor_type, DYNAMIC_KEY, "key nghiep vu van khong doi");
  assert.equal(renamedDraft.labor_type_display, RENAMED_LABEL);
  assert.equal(renamedDraft.labor_type_display, await catalogLabel(db, DYNAMIC_KEY));
  assert.equal(renamedDraft.labor_type_display.includes(DYNAMIC_LABEL), false,
    "nhan cu khong con xuat hien o bat ky dau");
  assert.notEqual(renamedDraft.labor_type_display, DYNAMIC_KEY);
  assert.notEqual(renamedDraft.labor_type_display, FORBIDDEN_FALLBACK);
});

test("4: #81 khong noi rong gi - cung entry set, cung key set, draft actor khac van vo hinh", async () => {
  const payload = await listOwnDrafts(db);

  // Cung entry set nhu truoc #81: draft la cua proposer va dang DRAFT; entry da
  // SUBMITTED cua fixture khong bao gio quay lai danh sach nay.
  assert.deepEqual(payload.drafts.map((draft) => draft.entry_id).sort(), EXPECTED_ENTRY_IDS);
  assert.equal(payload.drafts.length, EXPECTED_ENTRY_IDS.length);

  // Cung key set: dung 20 key, mang ca key lan nhan tren MOI element.
  assert.equal(DRAFT_KEYS.length, 20);
  assert.equal(DRAFT_KEYS.includes("labor_type"), true);
  assert.equal(DRAFT_KEYS.includes("labor_type_display"), true);
  assert.equal(new Set(DRAFT_KEYS).size, DRAFT_KEYS.length, "key set khong co key trung");
  for (const draft of payload.drafts) {
    assert.deepEqual(Object.keys(draft).sort(), [...DRAFT_KEYS].sort(),
      "draft " + draft.entry_id + " phai mang dung key set /2");
    assert.equal(typeof draft.labor_type_display, "string");
    assert.notEqual(draft.labor_type_display, FORBIDDEN_FALLBACK);
  }

  // Draft cua actor khac: co that trong SQL, dang DRAFT, nhung khong thuoc own scope.
  const foreign = (await db.query(
    "select e.entry_id, e.created_by_user_id, e.labor_type, e.project_id, s.state"
    + " from public.direct_entries e"
    + " join public.direct_entry_submissions s on s.submission_id = e.submission_id"
    + " where e.entry_id = $1::uuid", [FOREIGN.entryId])).rows;
  assert.equal(foreign.length, 1, "draft cua actor khac phai ton tai trong bang");
  assert.equal(foreign[0].state, "DRAFT");
  assert.equal(foreign[0].created_by_user_id, ACTORS.outsider.app_user_id);
  assert.equal(foreign[0].project_id, FOREIGN_PROJECT_ID);
  // Tien de cua su vo hinh: proposer khong quan ly du an do. Neu dieu nay sai thi
  // assertion ben duoi se do vi mot ly do khac, nen no duoc kiem tra tuong minh.
  assert.equal((await db.query(
    "select public.direct_entry_project_assignment_effective($1::uuid,$2::text) as effective",
    [ACTORS.proposer.app_user_id, FOREIGN_PROJECT_ID])).rows[0].effective, false,
    "proposer khong duoc la project manager cua du an chua draft actor khac");
  assert.equal((await db.query(
    "select public.direct_entry_project_assignment_effective($1::uuid,$2::text) as effective",
    [ACTORS.proposer.app_user_id, PROJECT_ID])).rows[0].effective, true,
    "doi chung: proposer quan ly du an cua chinh minh");
  assert.equal(payload.drafts.some((draft) => draft.entry_id === FOREIGN.entryId), false,
    "draft cua actor khac khong bao gio lo ra qua own draft list");
  assert.equal(payload.drafts.some((draft) => draft.entry_id === fixture.entryA.entry_id), false,
    "entry da SUBMITTED khong nam trong danh sach draft");
  assert.equal(payload.drafts.some((draft) => draft.entry_id === fixture.entryB.entry_id), false);
});

test("5: key khong co catalog row => JSON null, khong bo qua va khong bia nhan", async () => {
  assert.equal(await catalogLabel(db, UNKNOWN_KEY), null, "UNKNOWN_KEY khong duoc ton tai");

  // Khong the ghim mot draft mang key nay: write guard cua #79 tu choi ngay tu
  // INSERT, va FK RESTRICT la lop thu hai. Vi vay phep thu duoc viet truc tiep
  // tren bieu thuc SQL ma #81 cam vao RPC.
  const probe = await insertDraftRow(db, {
    createdBy: ACTORS.proposer, employeeCode: "hrp-2026-600005",
    laborType: UNKNOWN_KEY, firstWorkDate: WORK_DATE,
  });
  assert.equal(probe.code, "23514", "key khong ton tai khong bao gio la mot cu ghi hop le");
  assert.equal(probe.entryId, null);

  // Chinh bieu thuc scalar subquery cua #81, voi mot key khong co row.
  const scalar = (await db.query(
    "select (select lt.display_name from public.direct_entry_labor_types lt"
    + " where lt.labor_type_key = $1) as label", [UNKNOWN_KEY])).rows[0];
  assert.equal(scalar.label, null,
    "phep tra cuu khong co fallback: key khong ton tai tra ve SQL NULL");

  // Va o trong element jsonb dung nhu RPC build: o nhan la JSON null, key tho van con.
  const element = (await db.query(
    "select jsonb_build_object('labor_type', $1::text, 'labor_type_display',"
    + " (select lt.display_name from public.direct_entry_labor_types lt"
    + " where lt.labor_type_key = $1)) as element", [UNKNOWN_KEY])).rows[0].element;
  assert.equal(element.labor_type, UNKNOWN_KEY, "key tho van duoc giu lai, khong bi nuot");
  assert.equal(Object.keys(element).includes("labor_type_display"), true,
    "element khong duoc lang le bo qua o nhan");
  assert.equal(element.labor_type_display, null,
    "o nhan la JSON null chu khong phai mot nhan bia ra");
  assert.notEqual(element.labor_type_display, FORBIDDEN_FALLBACK);
  assert.notEqual(element.labor_type_display, UNKNOWN_KEY);

  // Client nghiem ngat phai TU CHOI mot element nhu vay thay vi render key tho.
  const payload = await listOwnDrafts(db);
  const withNullLabel = payload.drafts.map((draft, index) => (index === 0
    ? { ...draft, labor_type_display: element.labor_type_display }
    : draft));
  assert.equal(projectOwnDrafts({ ...payload, drafts: withNullLabel }), null,
    "mot element JSON null lam ca payload unavailable");

  // Doi chung duong: payload that (moi draft deu co nhan) van duoc chap nhan, nen
  // phep thu tren khong hong vi mot ly do khac.
  const accepted = projectOwnDrafts(payload);
  assert.ok(accepted, "payload own draft that phai qua duoc projection nghiem ngat");
  assert.equal(accepted.length, payload.drafts.length);
  assert.equal(accepted.every((draft) => typeof draft.labor_type_display === "string"
    && draft.labor_type_display.length > 0), true, "moi draft deu mang nhan khong rong");
  assert.deepEqual(accepted.map((draft) => draft.entry_id).sort(), EXPECTED_ENTRY_IDS);
});
