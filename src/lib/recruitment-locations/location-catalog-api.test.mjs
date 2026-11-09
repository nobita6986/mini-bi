import assert from "node:assert/strict";
import test from "node:test";

import {
  createIndustrialParkCatalog,
  createProvinceCatalog,
  listIndustrialParksCatalog,
  listProvincesCatalog,
  parseCreateIndustrialParkRequest,
  parseCreateProvinceRequest,
  parseListIndustrialParksQuery,
  parseListProvincesQuery,
  parseSetLocationActiveRequest,
  parseUpdateIndustrialParkRequest,
  parseUpdateProvinceRequest,
  setIndustrialParkActiveCatalog,
  setProvinceActiveCatalog,
  updateIndustrialParkCatalog,
  updateProvinceCatalog,
} from "./location-catalog-api.ts";
import {
  normalizeIndustrialParkKey,
  normalizeProvinceKey,
  projectAdminIndustrialPark,
  projectAdminIndustrialParkCreateResult,
  projectAdminIndustrialParkList,
  projectAdminIndustrialParkMutation,
  projectAdminProvince,
  projectAdminProvinceCreateResult,
  projectAdminProvinceList,
  projectAdminProvinceMutation,
} from "./location-catalog-contract.ts";
import {
  classifyLocationCatalogError,
  createLocationCatalogRepository,
} from "./location-catalog-repository.ts";

const ACTOR = {
  auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222",
};
const PROVINCE_ID = "33333333-3333-4333-8333-333333333333";
const PARK_ID = "44444444-4444-4444-8444-444444444444";
const IDEM_KEY = "55555555-5555-4555-8555-555555555555";
const REV_ID = "66666666-6666-4666-8666-666666666666";

const PROVINCE_ITEM = {
  province_id: PROVINCE_ID,
  province_code: "VINH_PHUC",
  display_name: "Vĩnh Phúc",
  normalized_key: "vinhphuc",
  active: true,
  version: 1,
  industrial_park_count: 6,
  active_industrial_park_count: 6,
  revision_count: 1,
};

const PROVINCE_LIST = {
  authorization_date: "2026-11-09",
  include_inactive: true,
  search: null,
  page: 1,
  page_size: 50,
  total: 1,
  provinces: [PROVINCE_ITEM],
};

const PROVINCE_MUTATION = {
  province_id: PROVINCE_ID,
  province_code: "VINH_PHUC",
  display_name: "Vĩnh Phúc",
  normalized_key: "vinhphuc",
  active: true,
  version: 2,
  revision_id: REV_ID,
};

const PROVINCE_CREATE = {
  ...PROVINCE_MUTATION,
  version: 1,
  created: true,
};

const PARK_ITEM = {
  industrial_park_id: PARK_ID,
  industrial_park_code: "VP_KHAI_QUANG",
  province_id: PROVINCE_ID,
  province_code: "VINH_PHUC",
  province_display_name: "Vĩnh Phúc",
  province_active: true,
  display_name: "Khai Quang",
  normalized_key: "khaiquang",
  active: true,
  version: 1,
  revision_count: 1,
};

const PARK_LIST = {
  authorization_date: "2026-11-09",
  province_id: PROVINCE_ID,
  include_inactive: true,
  search: null,
  page: 1,
  page_size: 50,
  total: 1,
  industrial_parks: [PARK_ITEM],
};

const PARK_MUTATION = {
  industrial_park_id: PARK_ID,
  industrial_park_code: "VP_KHAI_QUANG",
  province_id: PROVINCE_ID,
  province_code: "VINH_PHUC",
  province_display_name: "Vĩnh Phúc",
  display_name: "Khai Quang",
  normalized_key: "khaiquang",
  active: true,
  version: 2,
  revision_id: REV_ID,
};

const PARK_CREATE = {
  ...PARK_MUTATION,
  version: 1,
  created: true,
};

function makeDeps(
  result,
  session = { actor: { ok: true, actor: ACTOR } },
) {
  const calls = { session: 0, rpc: [] };
  return {
    calls,
    dependencies: {
      resolveSession: async () => {
        calls.session += 1;
        return session;
      },
      repository: {
        listProvinces: async (i) => {
          calls.rpc.push(["listProvinces", i]);
          return result;
        },
        createProvince: async (i) => {
          calls.rpc.push(["createProvince", i]);
          return result;
        },
        updateProvince: async (i) => {
          calls.rpc.push(["updateProvince", i]);
          return result;
        },
        setProvinceActive: async (i) => {
          calls.rpc.push(["setProvinceActive", i]);
          return result;
        },
        listIndustrialParks: async (i) => {
          calls.rpc.push(["listIndustrialParks", i]);
          return result;
        },
        createIndustrialPark: async (i) => {
          calls.rpc.push(["createIndustrialPark", i]);
          return result;
        },
        updateIndustrialPark: async (i) => {
          calls.rpc.push(["updateIndustrialPark", i]);
          return result;
        },
        setIndustrialParkActive: async (i) => {
          calls.rpc.push(["setIndustrialParkActive", i]);
          return result;
        },
      },
    },
  };
}

function jsonRequest(
  body,
  path = "/api/admin/catalog/provinces",
  method = "POST",
  headers = {},
) {
  return new Request(`https://app.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: "https://app.test",
      host: "app.test",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("1. Normalization helpers match SQL canonicalization rules", () => {
  assert.equal(normalizeIndustrialParkKey("Khai Quang"), "khaiquang");
  assert.equal(normalizeIndustrialParkKey("KHAIQUANG"), "khaiquang");
  assert.equal(normalizeIndustrialParkKey("KCN Khai Quang"), "khaiquang");
  assert.equal(
    normalizeIndustrialParkKey("Khu công nghiệp Khai-Quang"),
    "khaiquang",
  );
  assert.equal(normalizeIndustrialParkKey("Thăng Long 3"), "thanglong3");
  assert.equal(normalizeIndustrialParkKey("Thăng Long III"), "thanglongiii");
  assert.equal(normalizeProvinceKey("Tỉnh Vĩnh Phúc"), "vinhphuc");
  assert.equal(normalizeProvinceKey("Vĩnh-Phúc"), "vinhphuc");
});

test("2. Contract projections accept exact shapes and fail closed on unknown or malformed fields", () => {
  assert.deepEqual(projectAdminProvince(PROVINCE_ITEM), PROVINCE_ITEM);
  assert.deepEqual(projectAdminProvinceList(PROVINCE_LIST), PROVINCE_LIST);
  assert.deepEqual(
    projectAdminProvinceMutation(PROVINCE_MUTATION),
    PROVINCE_MUTATION,
  );
  assert.deepEqual(
    projectAdminProvinceCreateResult(PROVINCE_CREATE),
    PROVINCE_CREATE,
  );

  assert.deepEqual(projectAdminIndustrialPark(PARK_ITEM), PARK_ITEM);
  assert.deepEqual(projectAdminIndustrialParkList(PARK_LIST), PARK_LIST);
  assert.deepEqual(
    projectAdminIndustrialParkMutation(PARK_MUTATION),
    PARK_MUTATION,
  );
  assert.deepEqual(
    projectAdminIndustrialParkCreateResult(PARK_CREATE),
    PARK_CREATE,
  );

  // Reject extra unknown keys or invalid values
  assert.equal(projectAdminProvince({ ...PROVINCE_ITEM, extra: 1 }), null);
  assert.equal(projectAdminProvince({ ...PROVINCE_ITEM, version: 0 }), null);
  assert.equal(projectAdminIndustrialPark({ ...PARK_ITEM, address: "x" }), null);
  assert.equal(
    projectAdminProvinceCreateResult({ ...PROVINCE_CREATE, created: false }),
    null,
  );
});

test("3. Repository classifies SQLSTATEs and fails closed on malformed RPC payloads", async () => {
  assert.equal(classifyLocationCatalogError({ code: "40001" }), "conflict");
  assert.equal(classifyLocationCatalogError({ code: "23505" }), "conflict");
  assert.equal(classifyLocationCatalogError({ code: "PT409" }), "conflict");
  assert.equal(classifyLocationCatalogError({ code: "42501" }), "denied");
  assert.equal(classifyLocationCatalogError({ code: "P0002" }), "not-found");
  assert.equal(classifyLocationCatalogError({ code: "23514" }), "invalid");
  assert.equal(
    classifyLocationCatalogError({
      code: "22023",
      message: "idempotency key reused with different input",
    }),
    "conflict",
  );
  assert.equal(
    classifyLocationCatalogError({ code: "22023", message: "other invalid" }),
    "invalid",
  );
  assert.equal(classifyLocationCatalogError({ code: "XX000" }), "unavailable");

  const calls = [];
  const repo = createLocationCatalogRepository(async (name, args) => {
    calls.push([name, args]);
    return { data: PARK_CREATE, error: null };
  });

  const outcome = await repo.createIndustrialPark({
    ...ACTOR,
    expected_version: 0,
    province_id: PROVINCE_ID,
    industrial_park_code: "VP_KHAI_QUANG",
    display_name: "Khai Quang",
    reason: "Create park",
    idempotency_key: IDEM_KEY,
  });
  assert.deepEqual(outcome, { ok: true, data: PARK_CREATE });
  assert.equal(calls[0][0], "industrial_park_create_admin");

  const badRepo = createLocationCatalogRepository(async () => ({
    data: { unexpected: true },
    error: null,
  }));
  const badOutcome = await badRepo.listProvinces({
    ...ACTOR,
    search: null,
    include_inactive: true,
    page: 1,
    page_size: 50,
  });
  assert.deepEqual(badOutcome, { ok: false, kind: "unavailable" });
});

test("4. Feature gate, CSRF guard, client authority fields, and client normalized_key override are rejected before session", async () => {
  const d = makeDeps({ ok: true, data: PROVINCE_CREATE });

  // Feature gate disabled -> 404
  const gatedRes = await listProvincesCatalog(
    new Request("https://app.test/api/admin/catalog/provinces"),
    "false",
    d.dependencies,
  );
  assert.equal(gatedRes.status, 404);
  assert.equal(d.calls.session, 0);

  // Cross-origin mutation -> 403 CSRF_REJECTED
  const csrfRes = await createProvinceCatalog(
    jsonRequest(
      {
        expected_version: 0,
        province_code: "VINH_PHUC",
        display_name: "Vĩnh Phúc",
        idempotency_key: IDEM_KEY,
      },
      "/api/admin/catalog/provinces",
      "POST",
      { origin: "https://evil.example" },
    ),
    "true",
    d.dependencies,
  );
  assert.equal(csrfRes.status, 403);
  assert.equal((await csrfRes.json()).code, "CSRF_REJECTED");
  assert.equal(d.calls.session, 0);

  // Client authority fields -> 400 CLIENT_AUTHORITY_FIELD_FORBIDDEN
  for (const forbidden of [
    { auth_subject: ACTOR.auth_subject },
    { app_user_id: ACTOR.app_user_id },
    { role: "admin" },
    { capabilities: ["entry_admin"] },
    { scope: "all" },
  ]) {
    const res = await createProvinceCatalog(
      jsonRequest({
        expected_version: 0,
        province_code: "VINH_PHUC",
        display_name: "Vĩnh Phúc",
        idempotency_key: IDEM_KEY,
        ...forbidden,
      }),
      "true",
      d.dependencies,
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  // Client normalized_key override -> 400 NORMALIZED_KEY_CLIENT_FORBIDDEN
  const normRes = await createIndustrialParkCatalog(
    jsonRequest(
      {
        expected_version: 0,
        province_id: PROVINCE_ID,
        industrial_park_code: "VP_KHAI_QUANG",
        display_name: "Khai Quang",
        normalized_key: "customkey",
        idempotency_key: IDEM_KEY,
      },
      "/api/admin/catalog/industrial-parks",
    ),
    "true",
    d.dependencies,
  );
  assert.equal(normRes.status, 400);
  assert.equal((await normRes.json()).code, "NORMALIZED_KEY_CLIENT_FORBIDDEN");
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("5. Session & repository error mapping across all 8 endpoints (200, 400, 401, 403, 404, 409, 503)", async () => {
  // 401 UNAUTHENTICATED
  const unauthDeps = makeDeps(
    { ok: true, data: PROVINCE_LIST },
    { actor: { ok: false, reason: "UNAUTHENTICATED" } },
  );
  const unauthRes = await listProvincesCatalog(
    new Request("https://app.test/api/admin/catalog/provinces"),
    "true",
    unauthDeps.dependencies,
  );
  assert.equal(unauthRes.status, 401);
  assert.equal((await unauthRes.json()).code, "UNAUTHENTICATED");

  // 403 ACTOR_NOT_AVAILABLE
  const disabledDeps = makeDeps(
    { ok: true, data: PROVINCE_LIST },
    { actor: { ok: false, reason: "ACTOR_DISABLED" } },
  );
  const disabledRes = await listIndustrialParksCatalog(
    new Request("https://app.test/api/admin/catalog/industrial-parks"),
    "true",
    disabledDeps.dependencies,
  );
  assert.equal(disabledRes.status, 403);
  assert.equal((await disabledRes.json()).code, "ACTOR_NOT_AVAILABLE");

  // Idempotency-Key header mismatch -> 400
  const okDeps = makeDeps({ ok: true, data: PROVINCE_MUTATION });
  const mismatchRes = await updateProvinceCatalog(
    jsonRequest(
      {
        expected_version: 1,
        display_name: "Vĩnh Phúc",
        idempotency_key: IDEM_KEY,
      },
      `/api/admin/catalog/provinces/${PROVINCE_ID}`,
      "PATCH",
      { "idempotency-key": "99999999-9999-4999-8999-999999999999" },
    ),
    PROVINCE_ID,
    "true",
    okDeps.dependencies,
  );
  assert.equal(mismatchRes.status, 400);
  assert.equal((await mismatchRes.json()).code, "IDEMPOTENCY_KEY_MISMATCH");

  // Repository error statuses: denied -> 403, not-found -> 404, conflict -> 409, invalid -> 400, unavailable -> 503
  for (const [kind, expectedStatus, expectedCode] of [
    ["denied", 403, "LOCATION_CATALOG_DENIED"],
    ["not-found", 404, "LOCATION_CATALOG_NOT_FOUND"],
    ["conflict", 409, "LOCATION_CATALOG_CONFLICT"],
    ["invalid", 400, "LOCATION_CATALOG_INVALID"],
    ["unavailable", 503, "LOCATION_CATALOG_UNAVAILABLE"],
  ]) {
    const errDeps = makeDeps({ ok: false, kind });
    const res = await setIndustrialParkActiveCatalog(
      jsonRequest(
        {
          active: false,
          expected_version: 1,
          idempotency_key: IDEM_KEY,
        },
        `/api/admin/catalog/industrial-parks/${PARK_ID}/active`,
      ),
      PARK_ID,
      "true",
      errDeps.dependencies,
    );
    assert.equal(res.status, expectedStatus);
    assert.deepEqual(await res.json(), { ok: false, code: expectedCode });
  }

  // Successful mutations & reads return 200 and pass actor exclusively from session
  const parkUpdateDeps = makeDeps({ ok: true, data: PARK_MUTATION });
  const parkUpdateRes = await updateIndustrialParkCatalog(
    jsonRequest(
      {
        expected_version: 1,
        province_id: PROVINCE_ID,
        display_name: "Khai Quang Mở Rộng",
        reason: "Update park",
        idempotency_key: IDEM_KEY,
      },
      `/api/admin/catalog/industrial-parks/${PARK_ID}`,
      "PATCH",
    ),
    PARK_ID,
    "true",
    parkUpdateDeps.dependencies,
  );
  assert.equal(parkUpdateRes.status, 200);
  assert.deepEqual(await parkUpdateRes.json(), {
    ok: true,
    industrial_park: PARK_MUTATION,
  });
  assert.equal(parkUpdateDeps.calls.rpc[0][1].auth_subject, ACTOR.auth_subject);
  assert.equal(parkUpdateDeps.calls.rpc[0][1].app_user_id, ACTOR.app_user_id);

  const provActiveDeps = makeDeps({ ok: true, data: PROVINCE_MUTATION });
  const provActiveRes = await setProvinceActiveCatalog(
    jsonRequest(
      {
        active: false,
        expected_version: 1,
        idempotency_key: IDEM_KEY,
      },
      `/api/admin/catalog/provinces/${PROVINCE_ID}/active`,
    ),
    PROVINCE_ID,
    "true",
    provActiveDeps.dependencies,
  );
  assert.equal(provActiveRes.status, 200);
  assert.deepEqual(await provActiveRes.json(), {
    ok: true,
    province: PROVINCE_MUTATION,
  });
});

test("6. Query and request parsers enforce strict field validation", () => {
  assert.equal(
    parseListProvincesQuery(
      new URL("https://app.test/api/admin/catalog/provinces?include_inactive=false&search=Vinh"),
    ).ok,
    true,
  );
  assert.equal(
    parseListProvincesQuery(
      new URL("https://app.test/api/admin/catalog/provinces?unknown=1"),
    ).ok,
    false,
  );
  assert.equal(
    parseListIndustrialParksQuery(
      new URL(
        `https://app.test/api/admin/catalog/industrial-parks?province_id=${PROVINCE_ID}`,
      ),
    ).ok,
    true,
  );
  assert.equal(
    parseListIndustrialParksQuery(
      new URL("https://app.test/api/admin/catalog/industrial-parks?province_id=bad-uuid"),
    ).ok,
    false,
  );
  assert.equal(
    parseCreateProvinceRequest({
      expected_version: 1,
      province_code: "VINH_PHUC",
      display_name: "Vĩnh Phúc",
      idempotency_key: IDEM_KEY,
    }).ok,
    false,
  );
  assert.equal(
    parseUpdateProvinceRequest({
      expected_version: 0,
      display_name: "Vĩnh Phúc",
      idempotency_key: IDEM_KEY,
    }).ok,
    false,
  );
  assert.equal(
    parseCreateIndustrialParkRequest({
      expected_version: 0,
      province_id: PROVINCE_ID,
      industrial_park_code: "VP_KHAI_QUANG",
      display_name: "Khai Quang",
      idempotency_key: IDEM_KEY,
    }).ok,
    true,
  );
  assert.equal(
    parseUpdateIndustrialParkRequest({
      expected_version: 1,
      idempotency_key: IDEM_KEY,
    }).ok,
    false,
  );
  assert.equal(
    parseSetLocationActiveRequest({
      active: "true",
      expected_version: 1,
      idempotency_key: IDEM_KEY,
    }).ok,
    false,
  );
});
