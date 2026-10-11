/**
 * P3.1-W02C-R3 - hop dong hien thi labor type tren Own Draft projection (#81).
 *
 * Lane thuan, khong DB: import truc tiep projection nghiem ngat cua draft list va
 * chung minh no fail-closed voi field display-only moi \`labor_type_display\`:
 *   * envelope chi duoc la \`direct-entry-draft-list/2\`; mot client con mong doi
 *     shape /1 phai TU CHOI payload thay vi lang le render draft khong co nhan;
 *   * thieu / rong / sai kieu => ca payload tra null, nen UI khong bao gio phai tu
 *     map key sang nhan va khong bao gio render mot nhan fallback;
 *   * nhan hop le duoc truyen NGUYEN VEN: contract khong map theo key, khong thay
 *     bang key tho va khong bao gio tra ve 'Khong xac dinh';
 *   * key set cua draft la CHINH XAC 20 key, mang ca \`labor_type\` (key nghiep vu)
 *     lan \`labor_type_display\` (nhan), nen mot key thua hay thieu deu la unavailable.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAFT_LIST_PROJECTION_VERSION,
  projectOwnDrafts,
} from "./draft-list-contract.ts";

/** Nhan that do server resolve tu catalog; khong bao gio la key tho. */
const LABEL = "Thời gian thử việc";
/** Sentinel ma #80/#81 cam tren moi read surface. */
const FORBIDDEN_FALLBACK = "Không xác định";

/**
 * Key set CHINH XAC cua mot draft /2, dung thu tu jsonb_build_object cua
 * public.direct_entry_list_own_drafts: 19 key cu + \`labor_type_display\`.
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

/**
 * Hinh dang draft da duoc biet la tot (draft-api.test.mjs), da mang
 * \`labor_type_display\`. Cap (key, nhan) o day la mot cap that trong catalog.
 */
function draft(overrides = {}) {
  return {
    submission_id: "a1000000-0000-4000-8000-000000000001",
    submission_version: 1,
    entry_id: "a2000000-0000-4000-8000-000000000001",
    entry_version: 1,
    employee_code: "hrp-2026-900001",
    first_work_date: "2026-10-15",
    worker_display_name: "Synthetic Worker",
    project_id: "project_synthetic_01",
    project_display_name: "Synthetic project",
    recruiter_id: "93100000-0000-4000-8000-000000000001",
    recruiter_display_name: "Synthetic recruiter",
    provider_type: "hrp",
    team_id: "94100000-0000-4000-8000-000000000001",
    team_display_name: "Synthetic team",
    labor_type: "PROBATION",
    labor_type_display: LABEL,
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
    ...overrides,
  };
}

function envelope(drafts, overrides = {}) {
  return {
    projection_version: DRAFT_LIST_PROJECTION_VERSION,
    drafts,
    ...overrides,
  };
}

function withoutKey(source, key) {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

/** Mot draft /2 hop le phai di qua nguyen ven; day la phep thu dung chung. */
function accepted(overrides = {}) {
  const value = projectOwnDrafts(envelope([draft(overrides)]));
  assert.ok(value, "mot draft /2 hop le phai duoc chap nhan");
  assert.equal(value.length, 1);
  return value[0];
}

test("1: envelope /2 hop le - key va nhan deu duoc tra ve nguyen ven", () => {
  const value = projectOwnDrafts(envelope([draft()]));
  assert.ok(value, "envelope co du labor_type_display phai duoc chap nhan");
  assert.equal(value.length, 1);

  const projected = value[0];
  assert.equal(projected.labor_type, "PROBATION", "key nghiep vu khong doi");
  assert.equal(projected.labor_type_display, LABEL, "nhan duoc tra ve nguyen ven");
  assert.notEqual(projected.labor_type_display, projected.labor_type,
    "nhan khong bao gio la key tho");
  assert.equal(projected.labor_type_display.length > 0, true, "nhan khong duoc rong");

  // Nhieu draft cung mot payload: moi element deu mang nhan cua rieng no.
  const multi = projectOwnDrafts(envelope([
    draft(),
    draft({
      entry_id: "a2000000-0000-4000-8000-000000000002",
      labor_type: "TEMPORARY",
      labor_type_display: "Thời vụ",
    }),
  ]));
  assert.ok(multi, "payload nhieu draft van duoc chap nhan");
  assert.deepEqual(multi.map((entry) => [entry.labor_type, entry.labor_type_display]), [
    ["PROBATION", LABEL],
    ["TEMPORARY", "Thời vụ"],
  ]);
});

test("2: chi version /2 duoc chap nhan - shape /1 cu va moi version khac deu bi tu choi", () => {
  assert.equal(projectOwnDrafts(envelope([draft()], {
    projection_version: "direct-entry-draft-list/1",
  })), null, "shape /1 da bi thay the, client cu phai tu choi");

  const wrongVersions = {
    "version khac": "direct-entry-draft-list/3",
    "version cua surface khac": "direct-entry-worker-directory/1",
    "version rong": "",
    "version hoa": "DIRECT-ENTRY-DRAFT-LIST/2",
    "version thua khoang trang": " direct-entry-draft-list/2",
    "so": 2,
    "null": null,
    "undefined": undefined,
    "object": { version: DRAFT_LIST_PROJECTION_VERSION },
    "mang": [DRAFT_LIST_PROJECTION_VERSION],
    "boolean": true,
  };
  for (const [name, projectionVersion] of Object.entries(wrongVersions)) {
    assert.equal(projectOwnDrafts(envelope([draft()], { projection_version: projectionVersion })),
      null, "projection_version / " + name);
  }

  // Thieu han version: khong duoc suy dien tu drafts.
  assert.equal(projectOwnDrafts({ drafts: [draft()] }), null, "thieu projection_version");
  // Key thua o envelope cung la unavailable.
  assert.equal(projectOwnDrafts(envelope([draft()], { extra: 1 })), null,
    "envelope khong duoc mang key thua");
});

test("3: nhan thieu/rong/sai kieu lam ca payload unavailable", () => {
  const rejected = {
    "thieu field": withoutKey(draft(), "labor_type_display"),
    "chuoi rong": draft({ labor_type_display: "" }),
    "so": draft({ labor_type_display: 7 }),
    "so 0": draft({ labor_type_display: 0 }),
    "null": draft({ labor_type_display: null }),
    "object": draft({ labor_type_display: { display_name: LABEL } }),
    "mang": draft({ labor_type_display: [LABEL] }),
    "mang rong": draft({ labor_type_display: [] }),
    "boolean": draft({ labor_type_display: true }),
    "undefined": draft({ labor_type_display: undefined }),
  };
  for (const [name, value] of Object.entries(rejected)) {
    assert.equal(projectOwnDrafts(envelope([value])), null, "draft / " + name);
    // Mot draft hong lam CA payload unavailable, khong chi rieng element do.
    assert.equal(projectOwnDrafts(envelope([draft(), value])), null,
      "payload tron / " + name);
  }
});

test("4: nhan duoc truyen nguyen ven - khong map theo key, khong thay bang key hay nhan fallback", () => {
  const projected = accepted();
  assert.equal(projected.labor_type_display, LABEL);
  assert.notEqual(projected.labor_type_display, projected.labor_type);
  assert.notEqual(projected.labor_type_display, FORBIDDEN_FALLBACK);

  // Mot cap (key, nhan) ma contract chua bao gio biet cung phai di qua nguyen ven:
  // day la bang chung khong co static map o lop TypeScript.
  const freshKey = "SOME_UNSEEN_KEY";
  const freshLabel = "Nhãn động chưa từng biết";
  const fresh = accepted({ labor_type: freshKey, labor_type_display: freshLabel });
  assert.equal(fresh.labor_type, freshKey);
  assert.equal(fresh.labor_type_display, freshLabel);
  assert.notEqual(fresh.labor_type_display, FORBIDDEN_FALLBACK);

  // Nhan khong duoc "chuan hoa": moi chuoi khong rong deu duoc giu nguyen, ke ca khi
  // no trung voi key. Contract khong duoc phep dac cach hoa truong hop nay, vi no
  // khong so huu catalog - viec server khong bao gio gui key tho duoc chung minh
  // o lane DB (p3-1-w02c-r3-own-draft-display-db.test.mjs).
  const rawKeyLabel = accepted({ labor_type_display: "PROBATION" });
  assert.equal(rawKeyLabel.labor_type_display, "PROBATION",
    "contract khong tu dac cach hoa mot nhan trung key");
  assert.notEqual(rawKeyLabel.labor_type_display, FORBIDDEN_FALLBACK);
  // Nhan la chuoi bat ky: khong bi cat, khong bi doi dau, khong bi thay the.
  const spaced = "  Nhãn có khoảng trắng  ";
  assert.equal(accepted({ labor_type_display: spaced }).labor_type_display, spaced);
});

test("5: key set cua draft la chinh xac 20 key, mang ca key lan nhan", () => {
  assert.equal(DRAFT_KEYS.length, 20, "draft /2 co dung 20 key");
  assert.equal(DRAFT_KEYS.includes("labor_type"), true);
  assert.equal(DRAFT_KEYS.includes("labor_type_display"), true);
  assert.equal(new Set(DRAFT_KEYS).size, DRAFT_KEYS.length, "key set khong co key trung");

  // Thieu mot trong hai key display-only la unavailable.
  assert.equal(projectOwnDrafts(envelope([withoutKey(draft(), "labor_type")])), null);
  assert.equal(projectOwnDrafts(envelope([withoutKey(draft(), "labor_type_display")])), null);

  // Thua MOT key la unavailable: mot client /1 khong the lang le di qua.
  assert.equal(projectOwnDrafts(envelope([{ ...draft(), labor_type_label: LABEL }])), null);
  assert.equal(projectOwnDrafts(envelope([{ ...draft(), extra: null }])), null);
  // Thieu MOT key bat ky cung la unavailable.
  for (const key of DRAFT_KEYS) {
    assert.equal(projectOwnDrafts(envelope([withoutKey(draft(), key)])), null,
      "thieu key " + key);
  }
});

test("6: draft duoc chap nhan khong mang key nao ngoai key set chinh xac", () => {
  const projected = accepted();
  assert.deepEqual(Object.keys(projected).sort(), [...DRAFT_KEYS].sort(),
    "draft tra ve dung key set da cong bo");
  assert.equal(Object.keys(projected).length, DRAFT_KEYS.length,
    "khong duoc thua mot key nao");

  // Shape /1 (khong co labor_type_display) khong the lot qua du envelope da la /2.
  const legacyShape = withoutKey(draft(), "labor_type_display");
  assert.deepEqual(Object.keys(legacyShape).sort(), [...DRAFT_KEYS].sort()
    .filter((key) => key !== "labor_type_display"), "shape /1 thieu dung mot key");
  assert.equal(projectOwnDrafts(envelope([legacyShape])), null,
    "shape /1 khong duoc chap nhan du envelope da la /2");
});

test("7: DRAFT_LIST_PROJECTION_VERSION la /2", () => {
  assert.equal(DRAFT_LIST_PROJECTION_VERSION, "direct-entry-draft-list/2");
});
