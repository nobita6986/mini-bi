import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIndustrialParkCreateRequest,
  buildIndustrialParkListQuery,
  buildIndustrialParkUpdateRequest,
  buildLocationSetActiveRequest,
  buildProvinceCreateRequest,
  buildProvinceListQuery,
  buildProvinceUpdateRequest,
  classifyIndustrialParkMutation,
  classifyProvinceMutation,
  industrialParkListConfirmsCode,
  projectIndustrialParkListForQuery,
  projectProvinceListForQuery,
  provinceListConfirmsCode,
} from "./location-catalog-model.ts";

const KEY = "10000000-0000-4000-8000-000000000001";
const PROVINCE_ID = "20000000-0000-4000-8000-000000000001";
const PARK_ID = "30000000-0000-4000-8000-000000000001";
const REVISION_ID = "40000000-0000-4000-8000-000000000001";

const provinceItem = {
  province_id: PROVINCE_ID,
  province_code: "BAC_NINH",
  display_name: "Bắc Ninh",
  normalized_key: "bacninh",
  active: true,
  version: 2,
  industrial_park_count: 3,
  active_industrial_park_count: 2,
  revision_count: 2,
};

const parkItem = {
  industrial_park_id: PARK_ID,
  industrial_park_code: "KCN_YEN_PHONG_1",
  province_id: PROVINCE_ID,
  province_code: "BAC_NINH",
  province_display_name: "Bắc Ninh",
  province_active: true,
  display_name: "KCN Yên Phong I",
  normalized_key: "yenphong1",
  active: true,
  version: 4,
  revision_count: 5,
};

function provinceListPayload(overrides = {}) {
  return {
    ok: true,
    list: {
      authorization_date: "2026-11-09",
      include_inactive: true,
      search: "BAC",
      page: 1,
      page_size: 50,
      total: 1,
      provinces: [provinceItem],
      ...overrides,
    },
  };
}

function parkListPayload(overrides = {}) {
  return {
    ok: true,
    list: {
      authorization_date: "2026-11-09",
      province_id: PROVINCE_ID,
      include_inactive: true,
      search: "YEN",
      page: 1,
      page_size: 50,
      total: 1,
      industrial_parks: [parkItem],
      ...overrides,
    },
  };
}

test("strict list projections retain only contracted province & industrial park fields and query echo", () => {
  const provList = projectProvinceListForQuery(provinceListPayload(), {
    search: "BAC",
    includeInactive: true,
    page: 1,
  });
  assert.equal(provList?.provinces[0]?.province_code, "BAC_NINH");
  assert.equal(provList?.provinces[0]?.display_name, "Bắc Ninh");
  assert.equal(
    projectProvinceListForQuery(provinceListPayload({ search: "OTHER" }), {
      search: "BAC",
      includeInactive: true,
      page: 1,
    }),
    null,
  );

  const parkList = projectIndustrialParkListForQuery(parkListPayload(), {
    provinceId: PROVINCE_ID,
    search: "YEN",
    includeInactive: true,
    page: 1,
  });
  assert.equal(parkList?.industrial_parks[0]?.industrial_park_code, "KCN_YEN_PHONG_1");
  assert.equal(parkList?.industrial_parks[0]?.province_display_name, "Bắc Ninh");
  assert.equal(
    projectIndustrialParkListForQuery(parkListPayload({ province_id: null }), {
      provinceId: PROVINCE_ID,
      search: "YEN",
      includeInactive: true,
      page: 1,
    }),
    null,
  );
});

test("buildProvinceListQuery and buildIndustrialParkListQuery enforce bounded parameters", () => {
  const pQuery = buildProvinceListQuery({
    search: "  Bắc Ninh  ",
    includeInactive: false,
    page: 2,
  });
  assert.equal(
    pQuery?.toString(),
    "include_inactive=false&page=2&page_size=50&search=B%E1%BA%AFc+Ninh",
  );
  assert.equal(
    buildProvinceListQuery({ search: "x", includeInactive: true, page: 0 }),
    null,
  );

  const kQuery = buildIndustrialParkListQuery({
    provinceId: PROVINCE_ID,
    search: "Yên Phong",
    includeInactive: true,
    page: 1,
  });
  assert.equal(
    kQuery?.toString(),
    `include_inactive=true&page=1&page_size=50&province_id=${PROVINCE_ID}&search=Y%C3%AAn+Phong`,
  );
  assert.equal(
    buildIndustrialParkListQuery({
      provinceId: "not-a-uuid",
      search: "",
      includeInactive: true,
      page: 1,
    }),
    null,
  );
});

test("province and industrial park create/update/set-active builders enforce exact keys and never send normalized_key", () => {
  const createProvince = buildProvinceCreateRequest({
    provinceCode: " bac_ninh ",
    displayName: " Tỉnh Bắc Ninh ",
    reason: "Bổ sung danh mục",
    idempotencyKey: KEY,
  });
  assert.equal(createProvince.ok, true);
  if (createProvince.ok) {
    assert.deepEqual(Object.keys(createProvince.body).sort(), [
      "display_name",
      "expected_version",
      "idempotency_key",
      "province_code",
      "reason",
    ]);
    assert.equal(createProvince.body.province_code, "BAC_NINH");
    assert.equal(createProvince.body.display_name, "Tỉnh Bắc Ninh");
    assert.equal(createProvince.body.expected_version, 0);
    assert.equal("normalized_key" in createProvince.body, false);
  }

  // Reject display name that collapses to empty after stripping leading province prefix
  assert.equal(
    buildProvinceCreateRequest({
      provinceCode: "BAC_NINH",
      displayName: "Tỉnh   ",
      idempotencyKey: KEY,
    }).ok,
    false,
  );

  const updateProvince = buildProvinceUpdateRequest({
    displayName: "Bắc Ninh Mới",
    expectedVersion: 2,
    reason: "Chuẩn hóa tên",
    idempotencyKey: KEY,
  });
  assert.equal(updateProvince.ok, true);
  if (updateProvince.ok) {
    assert.deepEqual(Object.keys(updateProvince.body).sort(), [
      "display_name",
      "expected_version",
      "idempotency_key",
      "reason",
    ]);
  }

  const createPark = buildIndustrialParkCreateRequest({
    provinceId: PROVINCE_ID,
    industrialParkCode: "kcn_yen_phong_1",
    displayName: "KCN Yên Phong I",
    reason: "Tạo KCN",
    idempotencyKey: KEY,
  });
  assert.equal(createPark.ok, true);
  if (createPark.ok) {
    assert.deepEqual(Object.keys(createPark.body).sort(), [
      "display_name",
      "expected_version",
      "idempotency_key",
      "industrial_park_code",
      "province_id",
      "reason",
    ]);
    assert.equal(createPark.body.industrial_park_code, "KCN_YEN_PHONG_1");
    assert.equal("normalized_key" in createPark.body, false);
  }

  const updatePark = buildIndustrialParkUpdateRequest({
    provinceId: PROVINCE_ID,
    displayName: "KCN Yên Phong 1 (Mở rộng)",
    expectedVersion: 4,
    reason: "Đổi tên",
    idempotencyKey: KEY,
  });
  assert.equal(updatePark.ok, true);
  if (updatePark.ok) {
    assert.deepEqual(Object.keys(updatePark.body).sort(), [
      "display_name",
      "expected_version",
      "idempotency_key",
      "province_id",
      "reason",
    ]);
  }

  const setActive = buildLocationSetActiveRequest({
    active: false,
    expectedVersion: 4,
    reason: "Tạm ngừng",
    idempotencyKey: KEY,
  });
  assert.equal(setActive.ok, true);
  if (setActive.ok) {
    assert.deepEqual(Object.keys(setActive.body).sort(), [
      "active",
      "expected_version",
      "idempotency_key",
      "reason",
    ]);
  }
});

test("classifyProvinceMutation and classifyIndustrialParkMutation map 200, 409 (including PUBLISHED post lock), 403, 401, 404, 400, 503", () => {
  const appliedProvince = {
    ok: true,
    province: {
      province_id: PROVINCE_ID,
      province_code: "BAC_NINH",
      display_name: "Bắc Ninh",
      normalized_key: "bacninh",
      active: true,
      version: 3,
      revision_id: REVISION_ID,
    },
  };
  assert.equal(
    classifyProvinceMutation(200, appliedProvince, "update").kind,
    "applied",
  );
  assert.equal(
    classifyProvinceMutation(200, appliedProvince, "create").kind,
    "unavailable",
  );
  assert.equal(
    classifyProvinceMutation(
      200,
      { ok: true, province: { ...appliedProvince.province, created: true } },
      "create",
    ).kind,
    "applied",
  );

  const appliedPark = {
    ok: true,
    industrial_park: {
      industrial_park_id: PARK_ID,
      industrial_park_code: "KCN_YEN_PHONG_1",
      province_id: PROVINCE_ID,
      province_code: "BAC_NINH",
      province_display_name: "Bắc Ninh",
      display_name: "KCN Yên Phong I",
      normalized_key: "yenphong1",
      active: false,
      version: 5,
      revision_id: REVISION_ID,
    },
  };
  assert.equal(
    classifyIndustrialParkMutation(200, appliedPark, "set-active").kind,
    "applied",
  );

  const parkConflictActive = classifyIndustrialParkMutation(
    409,
    { ok: false, code: "LOCATION_CATALOG_CONFLICT" },
    "set-active",
  );
  assert.equal(parkConflictActive.kind, "conflict");
  if (parkConflictActive.kind === "conflict") {
    assert.match(parkConflictActive.message, /PUBLISHED/);
  }

  const parkConflictCreate = classifyIndustrialParkMutation(
    409,
    { ok: false, code: "LOCATION_CATALOG_CONFLICT" },
    "create",
  );
  assert.equal(parkConflictCreate.kind, "conflict");
  if (parkConflictCreate.kind === "conflict") {
    assert.match(parkConflictCreate.message, /tên chuẩn hóa/);
  }

  assert.equal(classifyIndustrialParkMutation(401, null, "update").kind, "unauthenticated");
  assert.equal(classifyIndustrialParkMutation(403, null, "update").kind, "denied");
  assert.equal(classifyIndustrialParkMutation(404, null, "update").kind, "not-found");
  assert.equal(classifyIndustrialParkMutation(400, null, "update").kind, "invalid");
  assert.equal(classifyIndustrialParkMutation(503, null, "update").kind, "unavailable");

  const pList = projectProvinceListForQuery(provinceListPayload(), {
    search: "BAC",
    includeInactive: true,
    page: 1,
  });
  const kList = projectIndustrialParkListForQuery(parkListPayload(), {
    provinceId: PROVINCE_ID,
    search: "YEN",
    includeInactive: true,
    page: 1,
  });
  assert.ok(pList && kList);
  assert.equal(provinceListConfirmsCode(pList, "bac_ninh"), true);
  assert.equal(industrialParkListConfirmsCode(kList, "kcn_yen_phong_1"), true);
});
