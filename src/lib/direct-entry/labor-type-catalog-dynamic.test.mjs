/**
 * P3.1-W02C - Bang chung cho catalog "loai hinh lao dong" DONG.
 *
 * Migration #79 (20261011120000_p3_1_w02c_labor_type_catalog.sql) bien labor_type tu mot
 * tu vung DONG (TEMPORARY | PERMANENT) thanh catalog do DB quan ly: mot key moi nhu
 * "PROBATION" co the duoc tao luc chay qua admin RPC. Vi vay moi boundary server/CLI chi
 * duoc kiem tra HINH DANG canonical key (isCanonicalLaborTypeKey) va de DB active-catalog
 * guard quyet dinh ton tai/active.
 *
 * File nay chung minh:
 *   1. key moi "PROBATION" di qua duoc MOI boundary va den dung output cua module;
 *   2. key cu "TEMPORARY"/"PERMANENT" van xanh;
 *   3. validation hinh dang KHONG bi noi long (key sai hinh dang van bi tu choi);
 *   4. khong module server/CLI nao con hardcode closed vocabulary.
 *
 * Toan bo du lieu trong file la GIA (synthetic); khong dung du lieu that.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LABOR_TYPE_KEY_PATTERN,
  isCanonicalLaborTypeKey,
} from "../contracts/direct-entry-v1.ts";
import {
  LABOR_TYPE_KEY,
  isCanonicalLaborTypeKey as isCanonicalCatalogKey,
} from "./labor-type-catalog-contract.ts";
import { projectEntry } from "./write-api.ts";
import { patchDraftEntry } from "./draft-api.ts";
import { DRAFT_LIST_PROJECTION_VERSION, projectOwnDrafts } from "./draft-list-contract.ts";
import {
  parseFullProfilePayload,
  WORKER_PROFILE_CONTRACT_VERSION,
} from "./full-profile-contract.ts";
import { buildFullProfileRequestBody } from "./full-profile-batch.ts";
import { projectPrivilegedEditRequest } from "./privileged-edit-api.ts";
import {
  projectChangeRequestItem,
  projectChangeRequestProposal,
} from "./change-request-contract.ts";
import { buildProposerItems, projectProposerEntry } from "./change-request-proposer.ts";
import {
  buildEntryFieldProposal,
  workerEntryFormFromBaseline,
} from "./change-request-proposal-builders.ts";
import {
  projectWorkerDirectoryPage,
  projectWorkerDirectoryRow,
} from "./worker-directory-contract.ts";
import { parseExcelPaste, parseExcelPasteReport } from "./excel-paste.ts";
import { normalizeLaborTypeHeader } from "./worker-profile-xlsx.ts";
import { parseWorkerProfilePaste } from "./worker-profile-paste.ts";
import {
  buildWorkerProfilePreview,
  createPasteCatalogResolver,
} from "./worker-profile-preview.ts";
import { validateManifest } from "../../../scripts/lib/t0-operator-import.mjs";

// --- Hang so dung chung -------------------------------------------------------------------

/** Key MOI chi ton tai trong catalog dong (khong bao gio nam trong mot union type tinh). */
const NEW_KEY = "PROBATION";
const LEGACY_KEYS = ["TEMPORARY", "PERMANENT"];
const ALL_KEYS = ["TEMPORARY", "PERMANENT", NEW_KEY];
/** Key SAI hinh dang canonical: chu thuong va bat dau bang so. */
const NON_CANONICAL_KEYS = ["probation", "1BAD"];

const REFERENCE_DATE = "2026-10-16";
const FIRST_WORK_DATE = "2026-10-15";
const ENTRY_ID = "c1000000-0000-4000-8000-000000000001";
const SUBMISSION_ID = "a1000000-0000-4000-8000-000000000001";
const RECRUITER_ID = "93000000-0000-4000-8000-000000000001";
const TEAM_ID = "94000000-0000-4000-8000-000000000001";
const EMPLOYEE_CODE = "hrp-2026-000001";

const TEST_DIRECTORY_URL = new URL(".", import.meta.url);
const TEST_DIRECTORY = fileURLToPath(TEST_DIRECTORY_URL);

// --- Fixture (copy tu test cua chinh module, chi doi labor_type) ---------------------------

/** write-api.test.mjs: read projection cua direct_entry_read_projection. */
/**
 * P3.1-W02C-R2: nhan la mot field RIENG do server resolve tu catalog theo key. Fixture nay
 * chi can mot nhan khong rong; nhan THAT luon den tu public.direct_entry_labor_types.
 */
const LABOR_TYPE_DISPLAY_FIXTURE = "Nhãn lao động giả";

function entryProjection(laborType, laborTypeDisplay = LABOR_TYPE_DISPLAY_FIXTURE) {
  return {
    entry_id: ENTRY_ID,
    submission_id: SUBMISSION_ID,
    project_id: "project_synthetic_01",
    first_work_date: FIRST_WORK_DATE,
    employee_code: EMPLOYEE_CODE,
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
    recruiter_id: RECRUITER_ID,
    team_id: TEAM_ID,
    provider_type: "hrp",
    labor_type: laborType,
    labor_type_display: laborTypeDisplay,
    general_note: null,
    version: 1,
    scope_kind: "own",
    payment: null,
    employment_status: { status: "UNCONFIRMED", effective_date: FIRST_WORK_DATE, version: 1 },
    documents: [],
    worker_portrait: null,
  };
}

/** draft-api.test.mjs: mot dong draft trong direct_entry_list_own_drafts. */
function draftRow(laborType) {
  return {
    submission_id: SUBMISSION_ID,
    submission_version: 1,
    entry_id: ENTRY_ID,
    entry_version: 1,
    employee_code: "hrp-2026-900001",
    first_work_date: FIRST_WORK_DATE,
    worker_display_name: "Synthetic Worker",
    project_id: "project_synthetic_01",
    project_display_name: "Synthetic project",
    recruiter_id: RECRUITER_ID,
    recruiter_display_name: "Synthetic recruiter",
    provider_type: "hrp",
    team_id: TEAM_ID,
    team_display_name: "Synthetic team",
    labor_type: laborType,
    labor_type_display: LABOR_TYPE_DISPLAY_FIXTURE,
    employment_status: "UNCONFIRMED",
    created_at: "2026-10-03T00:00:00.000Z",
    updated_at: "2026-10-03T00:00:00.000Z",
    profile: {
      contract_version: "worker-profile/1.0",
      worker_details: {
        display_name: { state: "provided", value: "Synthetic Worker" },
        gender: { state: "omitted" },
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        national_id_issued_at: { state: "omitted" },
        national_id_issued_place: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      },
      general_note: { state: "omitted" },
      employment: null,
      payment: null,
    },
  };
}

function draftProjection(laborType) {
  return { projection_version: DRAFT_LIST_PROJECTION_VERSION, drafts: [draftRow(laborType)] };
}

/** full-profile-contract.test.mjs: baseRow cua worker-profile/1.0. */
function fullProfileRow(laborType) {
  return {
    project_id: "project_synthetic_01",
    first_work_date: "2025-03-04",
    employee_code: "hrp-2025-000001",
    recruiter_id: RECRUITER_ID,
    labor_type: laborType,
    display_name: "Synthetic Worker",
  };
}

function fullProfilePayload(laborType) {
  return {
    contract_version: WORKER_PROFILE_CONTRACT_VERSION,
    rows: [fullProfileRow(laborType)],
  };
}

/** privileged-edit.test.mjs: patch toi thieu cua POST privileged-edit. */
function privilegedEditBody(laborType) {
  return {
    expected_entry_version: 3,
    patch: { labor_type: laborType },
    reason: "R3 correction",
  };
}

/** change-request-contract.test.mjs: mot item ENTRY_FIELD. */
/**
 * WRITE shape cua change-request item: KHONG co labor_type_display. Nhan la field display-only
 * cua READ contract (xem fixture readChangeRequestDetail trong lane R2).
 */
function changeRequestItem(laborType) {
  return {
    entry_id: ENTRY_ID,
    target_kind: "ENTRY_FIELD",
    expected_version: 1,
    proposal: { labor_type: laborType },
  };
}

/** change-request-proposer.test.mjs: 5 field khong PII + nhieu field bi bo qua. */
function proposerFields(laborType) {
  return {
    employee_code: EMPLOYEE_CODE,
    first_work_date: FIRST_WORK_DATE,
    project_id: "project_synthetic_01",
    recruiter_id: RECRUITER_ID,
    labor_type: laborType,
  };
}

function proposerEntryProjection(laborType) {
  return {
    entry_id: ENTRY_ID,
    submission_id: SUBMISSION_ID,
    version: 3,
    project_id: "project_synthetic_01",
    first_work_date: FIRST_WORK_DATE,
    employee_code: EMPLOYEE_CODE,
    recruiter_id: RECRUITER_ID,
    labor_type: laborType,
    labor_type_display: `Tên ${laborType}`,
    worker_details: { display_name: "Kin", national_id: { state: "provided", value: "0123" } },
    payment: { state: "provided", account_number: "000012340056" },
    documents: [{ document_id: ENTRY_ID }],
    team_id: TEAM_ID,
    provider_type: "hrp",
  };
}

/** worker-directory-contract.test.mjs: mot dong cua direct_entry_worker_directory. */
function directoryRow(laborType, laborTypeDisplay = LABOR_TYPE_DISPLAY_FIXTURE) {
  return {
    entry_id: ENTRY_ID,
    entry_version: 3,
    submission_state: "SUBMITTED",
    employee_code: "hrp-2026-300001",
    display_name: "Worker One",
    project_id: "proj_a",
    project_display: "Project A",
    first_work_date: "2026-10-01",
    labor_type: laborType,
    labor_type_display: laborTypeDisplay,
    employment_status: "ON",
    recruiter_id: "d1000000-0000-4000-8000-000000000001",
    recruiter_display: "Recruiter A",
    payment: {
      state: "provided", account_number: "••••••••8901", bank_id: null,
      account_holder_name: "Synthetic Holder", version: 1,
    },
    pending_request: { request_id: "e1000000-0000-4000-8000-000000000001", state: "PENDING", version: 1 },
    last_decision: { state: "REJECTED", decided_at: "2026-10-08T09:00:00.000000Z" },
    is_project_manager: true,
    allowed_actions: {
      view: true, view_pii: false, view_payment: true,
      propose_change: false, propose_change_code: "PROPOSE_PENDING_W04_POLICY",
    },
  };
}

function directoryPage(laborType) {
  return {
    items: [directoryRow(laborType)], scope: "managed", page_size: 25, has_more: false,
    next_cursor: null, authorization_date: "2026-10-08",
    summary: { total_workers: 1, project_count: 1, recruiter_count: 1 },
  };
}

/** excel-paste.test.mjs: header 6 cot + mot dong du lieu. */
const EXCEL_HEADER = [
  "Mã NLĐ", "Ngày đầu tiên đi làm", "Họ tên", "Dự án", "Người tuyển", "Loại hình lao động",
].join("\t");

function excelText(code, laborTypeCell) {
  return EXCEL_HEADER + "\n" +
    [code, FIRST_WORK_DATE, "Nguyen Van A", "p-01", "r-01", laborTypeCell].join("\t");
}

/** worker-profile-paste.test.mjs: 6 cot bat buoc cua worker-profile/1.0. */
function pastePairs(laborTypeCell, code = "hrp-2026-000123") {
  return [
    ["Mã NLĐ", code],
    ["Dự án", "Dự án Giả Bắc"],
    ["Ngày bắt đầu làm việc", FIRST_WORK_DATE],
    ["Họ và tên", "Nguyễn Văn Giả A"],
    ["Tên NV Tuyển dụng", "Tuyển Dụng Giả 1"],
    ["Loại hình LĐ", laborTypeCell],
  ];
}

function toTsv(rows) {
  const header = rows[0].map((pair) => pair[0]).join("\t");
  const body = rows.map((row) => row.map((pair) => pair[1]).join("\t")).join("\n");
  return header + "\n" + body;
}

/** full-profile-batch.test.mjs: preview -> request body cua worker-profile/1.0. */
const PREVIEW_PROJECT = { id: "11111111-1111-4111-8111-111111111111", label: "Dự án Giả Bắc" };
const PREVIEW_RECRUITER = {
  id: "22222222-2222-4222-8222-222222222222",
  label: "Tuyển Dụng Giả 1",
  provider_type: "hrp",
};

function previewBody(laborTypeCell) {
  const resolver = createPasteCatalogResolver(() => ({
    projects: [PREVIEW_PROJECT],
    recruiters: [PREVIEW_RECRUITER],
    labor_types: ALL_KEYS.map((key) => ({ id: key, label: `Tên ${key}` })),
  }));
  const preview = buildWorkerProfilePreview({
    text: toTsv([pastePairs(laborTypeCell)]),
    referenceDate: REFERENCE_DATE,
    resolver,
  });
  return buildFullProfileRequestBody(preview.rows);
}

/** change-request-proposal-builders.test.mjs: baseline worker_details canonical. */
function builderWorker() {
  return {
    display_name: "Nguyen Van Synthetic",
    gender: { state: "provided", value: "MALE" },
    date_of_birth: { state: "provided", value: "1990-01-02" },
    national_id: { state: "unknown" },
    national_id_issued_at: { state: "omitted" },
    national_id_issued_place: { state: "provided", value: "Ha Noi" },
    address: { state: "unknown" },
    phone: { state: "unknown" },
  };
}

function builderBaseline(laborType) {
  return {
    project_id: "project-old",
    first_work_date: "2026-10-01",
    employee_code: EMPLOYEE_CODE,
    recruiter_id: RECRUITER_ID,
    labor_type: laborType,
    worker_details: builderWorker(),
  };
}

/** scripts/lib/t0-operator-import.mjs: mot record manifest day du. */
function manifestRecord(laborType) {
  return {
    source_row_id: "row-1",
    uploader_login: "synthetic.operator",
    project_id: "project_synthetic_01",
    first_work_date: FIRST_WORK_DATE,
    display_name: "Synthetic Worker",
    national_id: "012345678901",
    provider_type: "HRP",
    recruiter_code: "synthetic-recruiter",
    labor_type: laborType,
    target_state: "DRAFT",
  };
}

function manifestLaborTypeErrors(laborType) {
  return validateManifest([manifestRecord(laborType)]).errors
    .filter((error) => error.code === "ROW_LABOR_TYPE_INVALID");
}

// --- 1. write-api.ts ----------------------------------------------------------------------

test("write-api: read projection nhan PROBATION va van nhan TEMPORARY/PERMANENT", () => {
  for (const key of ALL_KEYS) {
    const projected = projectEntry(entryProjection(key));
    assert.ok(projected, key);
    assert.equal(projected.labor_type, key);
    assert.equal(projected.labor_type_display, LABOR_TYPE_DISPLAY_FIXTURE);
    assert.equal(projected.entry_id, ENTRY_ID);
  }
  for (const bad of NON_CANONICAL_KEYS) {
    assert.equal(projectEntry(entryProjection(bad)), null, bad);
  }
  assert.equal(projectEntry(entryProjection("PROBATION ")), null, "khoang trang cuoi");
});

// --- 2. draft-list-contract.ts ------------------------------------------------------------

test("draft-list-contract: projectOwnDrafts nhan PROBATION va van nhan TEMPORARY/PERMANENT", () => {
  for (const key of ALL_KEYS) {
    const projected = projectOwnDrafts(draftProjection(key));
    assert.ok(projected, key);
    assert.equal(projected.length, 1);
    assert.equal(projected[0].labor_type, key);
    assert.equal(projected[0].entry_id, ENTRY_ID);
  }
  for (const bad of NON_CANONICAL_KEYS) {
    assert.equal(projectOwnDrafts(draftProjection(bad)), null, bad);
  }
});

// --- 3. full-profile-contract.ts -----------------------------------------------------------

test("full-profile-contract: parseFullProfilePayload nhan PROBATION, khong bao LABOR_TYPE/BATCH_INVALID", () => {
  for (const key of ALL_KEYS) {
    const parsed = parseFullProfilePayload(fullProfilePayload(key));
    assert.equal(parsed.ok, true, key);
    assert.equal(parsed.payload.rows[0].labor_type, key);
    const codes = parsed.ok ? [] : parsed.issues.map((issue) => issue.code);
    assert.equal(codes.includes("LABOR_TYPE_INVALID"), false, key);
    assert.equal(codes.includes("BATCH_INVALID"), false, key);
  }

  const rejected = parseFullProfilePayload(fullProfilePayload("probation"));
  assert.equal(rejected.ok, false);
  assert.ok(rejected.issues.some((issue) =>
    issue.code === "BATCH_INVALID" && issue.path === "rows[0]"),
  "key sai hinh dang van bi chan o row");
});

// --- 4. privileged-edit-api.ts -------------------------------------------------------------

test("privileged-edit-api: projectPrivilegedEditRequest nhan PROBATION va van nhan TEMPORARY/PERMANENT", () => {
  for (const key of ALL_KEYS) {
    const projected = projectPrivilegedEditRequest(privilegedEditBody(key));
    assert.ok(projected, key);
    assert.equal(projected.patch.labor_type, key);
    assert.equal(projected.expected_entry_version, 3);
  }
  for (const bad of NON_CANONICAL_KEYS) {
    assert.equal(projectPrivilegedEditRequest(privilegedEditBody(bad)), null, bad);
  }
});

// --- 5. change-request-contract.ts ---------------------------------------------------------

test("change-request-contract: projectChangeRequestProposal nhan PROBATION va van nhan TEMPORARY/PERMANENT", () => {
  for (const key of ALL_KEYS) {
    assert.deepEqual(
      projectChangeRequestProposal("ENTRY_FIELD", { labor_type: key }),
      { labor_type: key },
      key,
    );
    const item = projectChangeRequestItem(changeRequestItem(key));
    assert.ok(item, key);
    assert.equal(item.proposal.labor_type, key);
    assert.equal(item.target_kind, "ENTRY_FIELD");
  }
  for (const bad of NON_CANONICAL_KEYS) {
    assert.equal(projectChangeRequestProposal("ENTRY_FIELD", { labor_type: bad }), null, bad);
    assert.equal(projectChangeRequestItem(changeRequestItem(bad)), null, bad);
  }
});

// --- 6. change-request-proposer.ts ---------------------------------------------------------

test("change-request-proposer: validator xuat ra nhan PROBATION va van nhan TEMPORARY/PERMANENT", () => {
  for (const key of ALL_KEYS) {
    const projected = projectProposerEntry(proposerEntryProjection(key));
    assert.ok(projected, key);
    assert.equal(projected.labor_type, key);
    assert.equal(JSON.stringify(projected).includes("account_number"), false);
  }
  for (const bad of NON_CANONICAL_KEYS) {
    assert.equal(projectProposerEntry(proposerEntryProjection(bad)), null, bad);
  }

  const built = buildProposerItems([{
    entry_id: ENTRY_ID,
    expected_version: 1,
    baseline: proposerFields("TEMPORARY"),
    draft: proposerFields(NEW_KEY),
  }]);
  assert.equal(built.ok, true);
  assert.deepEqual(built.items[0].proposal, { labor_type: NEW_KEY });
});

// --- 7. worker-directory-contract.ts -------------------------------------------------------

test("worker-directory-contract: projectWorkerDirectoryRow nhan PROBATION va van nhan TEMPORARY/PERMANENT", () => {
  for (const key of ALL_KEYS) {
    const projected = projectWorkerDirectoryRow(directoryRow(key));
    assert.ok(projected, key);
    assert.equal(projected.labor_type, key);
    const page = projectWorkerDirectoryPage(directoryPage(key), { scope: "managed", page_size: 25 });
    assert.ok(page, key);
    assert.equal(page.items[0].labor_type, key);
  }
  for (const bad of NON_CANONICAL_KEYS) {
    assert.equal(projectWorkerDirectoryRow(directoryRow(bad)), null, bad);
    assert.equal(
      projectWorkerDirectoryPage(directoryPage(bad), { scope: "managed", page_size: 25 }),
      null,
      bad,
    );
  }
});

// --- 8. excel-paste.ts ---------------------------------------------------------------------

test("excel-paste: o loai hinh nhan literal PROBATION va van nhan alias cu", () => {
  const canonical = parseExcelPasteReport(excelText("000123", NEW_KEY));
  assert.deepEqual(canonical.errors, []);
  assert.equal(canonical.rows.length, 1);
  assert.equal(canonical.rows[0].labor_type, NEW_KEY);

  const aliases = [
    ["Thời vụ", "TEMPORARY"],
    ["Toàn thời gian", "PERMANENT"],
    ["temporary", "TEMPORARY"],
    ["permanent", "PERMANENT"],
  ];
  for (const [cell, expected] of aliases) {
    const report = parseExcelPasteReport(excelText("000123", cell));
    assert.deepEqual(report.errors, [], cell);
    assert.equal(report.rows[0].labor_type, expected, cell);
  }

  const legacy = parseExcelPaste(excelText("000999", "Toàn thời gian"));
  assert.equal(legacy.ok, true);
  assert.equal(legacy.rows[0].labor_type, "PERMANENT");

  const rejected = parseExcelPasteReport(excelText("000124", "Không rõ"));
  assert.equal(rejected.rows.length, 0);
  assert.equal(rejected.errors.length, 1);
  assert.equal(rejected.errors[0].column, 6);
  assert.match(rejected.errors[0].message, /Loại hình lao động/);
});

// --- 9. worker-profile-xlsx.ts -------------------------------------------------------------

test("worker-profile-xlsx: normalizeLaborTypeHeader nhan PROBATION va giu mapping cu", () => {
  assert.equal(normalizeLaborTypeHeader(NEW_KEY), NEW_KEY);
  assert.equal(normalizeLaborTypeHeader("  " + NEW_KEY + "  "), NEW_KEY);
  assert.equal(normalizeLaborTypeHeader("Thời vụ"), "TEMPORARY");
  assert.equal(normalizeLaborTypeHeader("Chính thức"), "PERMANENT");
  assert.equal(normalizeLaborTypeHeader("Toàn thời gian"), "PERMANENT");
  assert.equal(normalizeLaborTypeHeader("1BAD"), null);
  assert.equal(normalizeLaborTypeHeader(""), null);
});

// --- 10. worker-profile-paste.ts -----------------------------------------------------------

test("worker-profile-paste: parser nhan PROBATION o cot labor_type va van nhan alias cu", () => {
  const accepted = parseWorkerProfilePaste({
    text: toTsv([pastePairs(NEW_KEY)]),
    referenceDate: REFERENCE_DATE,
  });
  assert.equal(accepted.errorCount, 0);
  assert.equal(accepted.canProceed, true);
  assert.equal(accepted.rows[0].labor_type, NEW_KEY);

  for (const [cell, expected] of [["Thời vụ", "TEMPORARY"], ["Chính thức", "PERMANENT"]]) {
    const legacy = parseWorkerProfilePaste({
      text: toTsv([pastePairs(cell)]),
      referenceDate: REFERENCE_DATE,
    });
    assert.equal(legacy.errorCount, 0, cell);
    assert.equal(legacy.rows[0].labor_type, expected, cell);
  }

  const rejected = parseWorkerProfilePaste({
    text: toTsv([pastePairs("Không rõ")]),
    referenceDate: REFERENCE_DATE,
  });
  assert.equal(rejected.canProceed, false);
  assert.ok(rejected.issues.some((item) => item.code === "PASTE_LABOR_TYPE_INVALID"));
});

// --- 11. scripts/lib/t0-operator-import.mjs -------------------------------------------------

test("t0-operator-import: validateManifest chi kiem tra hinh dang canonical key", () => {
  for (const key of ALL_KEYS) {
    assert.deepEqual(manifestLaborTypeErrors(key), [], key);
  }
  assert.deepEqual(validateManifest([manifestRecord(NEW_KEY)]).errors, []);
  assert.equal(validateManifest([manifestRecord(NEW_KEY)]).rows[0].labor_type, NEW_KEY);

  for (const bad of ["1BAD", "", "bad-key", "BAD KEY"]) {
    const errors = manifestLaborTypeErrors(bad);
    assert.equal(errors.length, 1, bad);
    assert.equal(errors[0].source_row_id, "row-1");
    assert.equal(errors[0].severity, "error");
  }

  // Chu thuong duoc chuan hoa HOA truoc khi kiem tra hinh dang (giu nguyen hanh vi cu),
  // nen "probation" la hop le ve hinh dang; ton tai/active van do DB guard quyet dinh.
  assert.deepEqual(manifestLaborTypeErrors("probation"), []);
});

// --- 12. Predicate dung chung --------------------------------------------------------------

test("predicate dung chung: isCanonicalLaborTypeKey chi kiem tra hinh dang canonical key", () => {
  for (const accepted of ["TEMPORARY", "PERMANENT", NEW_KEY, "A_1", "A", "Z".repeat(64)]) {
    assert.equal(isCanonicalLaborTypeKey(accepted), true, accepted);
    assert.equal(isCanonicalCatalogKey(accepted), true, accepted);
  }
  for (const rejected of [
    "", "probation", "1BAD", "A".repeat(65), null, 42, undefined, 0, true, {}, [],
    " probation", "PROBATION ", "_PROBATION", "A B", "A-B", "A.B",
  ]) {
    assert.equal(isCanonicalLaborTypeKey(rejected), false, String(rejected));
    assert.equal(isCanonicalCatalogKey(rejected), false, String(rejected));
  }

  assert.equal(LABOR_TYPE_KEY_PATTERN.source, "^[A-Z][A-Z0-9_]{0,63}$");
  assert.equal(LABOR_TYPE_KEY, LABOR_TYPE_KEY_PATTERN,
    "labor-type-catalog-contract phai re-export dung predicate dung chung");
});

// --- 13. Fail closed: noi long tu vung nhung KHONG bo validation ----------------------------

/** Boundary NGHIEM NGAT: khong chuan hoa chu hoa/thuong, nen ca "probation" lan "1BAD" deu bi chan. */
test("fail closed: key sai hinh dang van bi tu choi o boundary nghiem ngat", () => {
  for (const bad of NON_CANONICAL_KEYS) {
    assert.equal(projectEntry(entryProjection(bad)), null, "write-api " + bad);
    assert.equal(projectOwnDrafts(draftProjection(bad)), null, "draft-list-contract " + bad);
    assert.equal(parseFullProfilePayload(fullProfilePayload(bad)).ok, false,
      "full-profile-contract " + bad);
    assert.equal(projectPrivilegedEditRequest(privilegedEditBody(bad)), null,
      "privileged-edit-api " + bad);
    assert.equal(projectChangeRequestProposal("ENTRY_FIELD", { labor_type: bad }), null,
      "change-request-contract " + bad);
    assert.equal(projectChangeRequestItem(changeRequestItem(bad)), null,
      "change-request-contract item " + bad);
    assert.equal(projectProposerEntry(proposerEntryProjection(bad)), null,
      "change-request-proposer " + bad);
    assert.equal(projectWorkerDirectoryRow(directoryRow(bad)), null,
      "worker-directory-contract " + bad);
    assert.equal(projectWorkerDirectoryPage(directoryPage(bad), { scope: "managed", page_size: 25 }),
      null, "worker-directory-contract page " + bad);
  }

  // Hinh dang chi la hinh dang: mot key canonical nhung KHONG co trong catalog (vi du key cua
  // tu vung cu da bo) van qua duoc boundary nay - ton tai/active do DB active-catalog guard.
  assert.notEqual(projectPrivilegedEditRequest(privilegedEditBody("OFFICIAL")), null);
  assert.notEqual(projectEntry(entryProjection("OFFICIAL")), null);
});

/**
 * Boundary NHAP LIEU (excel-paste, worker-profile-paste, t0-operator-import): chuoi duoc chuan
 * hoa HOA truoc khi kiem tra hinh dang de tuong thich alias cu ("thời vụ"/"temporary"), nen
 * probe dung la key sai hinh dang NGAY CA khi da hoa. "probation" o cac boundary nay duoc
 * chuan hoa thanh "PROBATION" (khong phai noi long validation: DB active-catalog guard van la
 * noi quyet dinh key co ton tai/active hay khong).
 */
test("fail closed: boundary nhap lieu van chan key sai hinh dang sau khi chuan hoa", () => {
  for (const bad of ["1BAD", "BAD KEY", "A-B", "_PROBATION"]) {
    assert.equal(parseExcelPasteReport(excelText("000123", bad)).errors.length, 1,
      "excel-paste report " + bad);
    assert.equal(parseExcelPaste(excelText("000123", bad)).ok, false, "excel-paste " + bad);
    const pasted = parseWorkerProfilePaste({
      text: toTsv([pastePairs(bad)]),
      referenceDate: REFERENCE_DATE,
    });
    assert.equal(pasted.canProceed, false, "worker-profile-paste " + bad);
    assert.ok(pasted.issues.some((item) => item.code === "PASTE_LABOR_TYPE_INVALID"),
      "worker-profile-paste code " + bad);
    assert.equal(manifestLaborTypeErrors(bad).length, 1, "t0-operator-import " + bad);
  }
});

// --- 14. Khong module server/CLI nao con hardcode closed vocabulary -------------------------

const SERVER_SOURCE_FILES = [
  ["../contracts/direct-entry-v1.ts", "isCanonicalLaborTypeKey"],
  ["./write-api.ts", "projectEntry"],
  ["./draft-api.ts", "patchDraftEntry"],
  ["./draft-list-contract.ts", "projectOwnDrafts"],
  ["./full-profile-batch.ts", "buildFullProfileRequestBody"],
  ["./full-profile-contract.ts", "parseFullProfilePayload"],
  ["./privileged-edit-api.ts", "projectPrivilegedEditRequest"],
  ["./change-request-contract.ts", "projectChangeRequestProposal"],
  ["./change-request-proposer.ts", "projectProposerEntry"],
  ["./change-request-proposal-builders.ts", "buildEntryFieldProposal"],
  ["./worker-directory-contract.ts", "projectWorkerDirectoryRow"],
  ["./excel-paste.ts", "parseExcelPasteReport"],
  ["./worker-profile-xlsx.ts", "normalizeLaborTypeHeader"],
  ["./worker-profile-paste.ts", "parseWorkerProfilePaste"],
  ["../../../scripts/lib/t0-operator-import.mjs", "validateManifest"],
];

/** Cac module PHAI di qua predicate dung chung thay vi tu liet ke lai tu vung. */
const PREDICATE_SOURCE_FILES = [
  "../contracts/direct-entry-v1.ts",
  "./write-api.ts",
  "./draft-api.ts",
  "./draft-list-contract.ts",
  "./full-profile-contract.ts",
  "./privileged-edit-api.ts",
  "./change-request-contract.ts",
  "./change-request-proposer.ts",
  "./worker-directory-contract.ts",
  "./excel-paste.ts",
  "./worker-profile-xlsx.ts",
  "./worker-profile-paste.ts",
  "../../../scripts/lib/t0-operator-import.mjs",
];

function readSource(relative) {
  return readFileSync(new URL(relative, TEST_DIRECTORY_URL), "utf8");
}

test("source: khong module server/CLI nao con hardcode closed vocabulary", () => {
  assert.ok(TEST_DIRECTORY.endsWith("direct-entry") || TEST_DIRECTORY.endsWith("direct-entry\\")
    || TEST_DIRECTORY.endsWith("direct-entry/"), TEST_DIRECTORY);

  for (const [relative, marker] of SERVER_SOURCE_FILES) {
    const source = readSource(relative);
    const fullPath = fileURLToPath(new URL(relative, TEST_DIRECTORY_URL));
    assert.ok(source.includes(marker), fullPath + " thieu marker " + marker);
    assert.equal(source.includes('"TEMPORARY" | "PERMANENT"'), false, fullPath);
    assert.equal(source.includes('["TEMPORARY", "PERMANENT"]'), false, fullPath);
  }

  for (const relative of PREDICATE_SOURCE_FILES) {
    assert.ok(readSource(relative).includes("isCanonicalLaborTypeKey"), relative);
  }
});

// --- 15. Legacy keys van xanh end-to-end ---------------------------------------------------

test("legacy keys TEMPORARY/PERMANENT van xanh end-to-end", () => {
  for (const key of LEGACY_KEYS) {
    assert.equal(projectEntry(entryProjection(key)).labor_type, key);
    assert.equal(projectChangeRequestItem(changeRequestItem(key)).proposal.labor_type, key);
    assert.equal(projectWorkerDirectoryRow(directoryRow(key)).labor_type, key);
    const page = projectWorkerDirectoryPage(directoryPage(key), { scope: "managed", page_size: 25 });
    assert.equal(page.items[0].labor_type, key);
  }
});

// --- Bo sung: cac boundary con lai trong danh sach P3.1-W02C -------------------------------

test("draft-api: patchDraftEntry chap nhan PROBATION va chuyen nguyen ven xuong repository", async () => {
  const actor = {
    auth_subject: "91100000-0000-4000-8000-000000000001",
    app_user_id: "92100000-0000-4000-8000-000000000001",
  };
  const catalog = {
    effective_date: FIRST_WORK_DATE,
    projects: [{ project_id: "project_synthetic_01", display_name: "Synthetic project" }],
    banks: [{ bank_id: "bank_synthetic", display_name: "Synthetic Bank" }],
    recruiters: [{
      recruiter_id: RECRUITER_ID,
      display_name: "Synthetic recruiter",
      personnel_code: "synthetic.td",
      provider_type: "hrp",
      vendor_id: null,
      team_id: TEAM_ID,
      team_display_name: "Synthetic team",
      label: "Synthetic recruiter · synthetic.td · Synthetic team",
    }],
  };
  const patch = (laborType) => ({
    project_id: "project_synthetic_01",
    first_work_date: FIRST_WORK_DATE,
    employee_code: "hrp-2026-900001",
    worker_details: { display_name: "Synthetic Updated" },
    recruiter_id: RECRUITER_ID,
    labor_type: laborType,
  });
  const request = (body) => new Request(
    "https://example.test/api/direct-entry/entries/" + ENTRY_ID,
    {
      method: "PATCH",
      headers: {
        origin: "https://example.test",
        host: "example.test",
        "content-type": "application/json",
        "idempotency-key": "synthetic-update-01",
      },
      body: JSON.stringify(body),
    },
  );
  const dependencies = (calls) => ({
    resolveSession: async () => ({ actor: { ok: true, actor }, response_headers: {} }),
    repository: {
      async loadInputCatalog(input) {
        calls.push({ operation: "catalog", input });
        return { ok: true, data: catalog };
      },
      async updateDraftRow(input) {
        calls.push({ operation: "update", input });
        return {
          ok: true,
          data: { entry_id: input.entry_id, version: 2, submission_version: 2 },
        };
      },
    },
  });

  for (const key of ALL_KEYS) {
    const calls = [];
    const response = await patchDraftEntry(
      request({ expected_version: 1, patch: patch(key) }), ENTRY_ID, "true", dependencies(calls),
    );
    assert.equal(response.status, 200, key);
    assert.equal(calls[1].operation, "update");
    assert.equal(calls[1].input.patch.labor_type, key);
    assert.equal(calls[1].input.expected_version, 1);
  }

  const calls = [];
  const rejected = await patchDraftEntry(
    request({ expected_version: 1, patch: patch("probation") }), ENTRY_ID, "true",
    dependencies(calls),
  );
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, "DRAFT_PATCH_INVALID");
  assert.equal(calls.length, 0, "patch sai hinh dang bi chan truoc khi cham repository");
});

test("full-profile-batch: buildFullProfileRequestBody giu nguyen PROBATION", () => {
  const body = previewBody(NEW_KEY);
  assert.ok(body, "preview phai build duoc request body");
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].labor_type, NEW_KEY);

  for (const [cell, expected] of [["Thời vụ", "TEMPORARY"], ["Chính thức", "PERMANENT"]]) {
    const legacy = previewBody(cell);
    assert.ok(legacy, cell);
    assert.equal(legacy.rows[0].labor_type, expected, cell);
  }
});

test("change-request-proposal-builders: buildEntryFieldProposal giu nguyen PROBATION", () => {
  const baseline = builderBaseline("TEMPORARY");

  const promoted = workerEntryFormFromBaseline(baseline);
  promoted.labor_type = NEW_KEY;
  assert.deepEqual(
    buildEntryFieldProposal({ entryId: ENTRY_ID, expectedVersion: 8, baseline, form: promoted }),
    { ok: true, proposal: { labor_type: NEW_KEY } },
  );

  const legacyForm = workerEntryFormFromBaseline(baseline);
  legacyForm.labor_type = "PERMANENT";
  assert.deepEqual(
    buildEntryFieldProposal({ entryId: ENTRY_ID, expectedVersion: 8, baseline, form: legacyForm }),
    { ok: true, proposal: { labor_type: "PERMANENT" } },
  );

  const invalidForm = workerEntryFormFromBaseline(baseline);
  invalidForm.labor_type = "probation";
  assert.deepEqual(
    buildEntryFieldProposal({ entryId: ENTRY_ID, expectedVersion: 8, baseline, form: invalidForm }),
    { ok: false, code: "WORKER_INVALID" },
    "key sai hinh dang van bi chan o buoc build proposal",
  );
});
