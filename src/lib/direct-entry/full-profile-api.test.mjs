import assert from "node:assert/strict";
import test from "node:test";

import { postFullProfileBatch } from "./full-profile-api.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const row = {
  project_id: "project_synthetic_01",
  first_work_date: "2025-03-04",
  employee_code: "hrp-2025-000001",
  recruiter_id: "93000000-0000-4000-8000-000000000001",
  labor_type: "TEMPORARY",
  display_name: "Synthetic Worker",
  worker: { national_id: { state: "provided", value: "012345678901" } },
};
const payload = { contract_version: "worker-profile/1.0", rows: [row] };
const rpcResult = {
  submission_id: "a1000000-0000-4000-8000-000000000001",
  state: "DRAFT",
  version: 1,
  entry_ids: ["a2000000-0000-4000-8000-000000000001"],
  replayed: false,
};
const key = "b1000000-0000-4000-8000-000000000001";

function request(body = payload, headers = {}) {
  return new Request("https://example.test/api/direct-entry/batches/full-profile", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": key,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function deps(overrides = {}) {
  const calls = [];
  let sessionCalls = 0;
  return {
    calls,
    get sessionCalls() { return sessionCalls; },
    resolveSession: async () => {
      sessionCalls += 1;
      return { actor: { ok: true, actor }, response_headers: {} };
    },
    repository: {
      async createFullProfileBatch(input) {
        calls.push(input);
        return { ok: true, data: rpcResult };
      },
      ...overrides,
    },
  };
}

test("feature gate, same-origin, content type and idempotency validation precede auth", async () => {
  const dependencies = deps();
  assert.equal((await postFullProfileBatch(request(), undefined, dependencies)).status, 404);
  assert.equal((await postFullProfileBatch(request(payload, {
    origin: "https://attacker.test",
  }), "true", dependencies)).status, 403);
  assert.equal((await postFullProfileBatch(request(payload, {
    "content-type": "application/jsonp",
  }), "true", dependencies)).status, 400);
  assert.equal((await postFullProfileBatch(request(payload, {
    "idempotency-key": "not-a-uuid",
  }), "true", dependencies)).status, 400);
  assert.equal(dependencies.sessionCalls, 0);
  assert.equal(dependencies.calls.length, 0);
});

test("valid payload calls only the full-profile repository with trusted actor and safe response", async () => {
  const dependencies = deps();
  const response = await postFullProfileBatch(request(), "true", dependencies);
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.deepEqual(dependencies.calls[0], {
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    payload: {
      contract_version: "worker-profile/1.0",
      rows: [{
        project_id: row.project_id,
        first_work_date: row.first_work_date,
        employee_code: row.employee_code,
        recruiter_id: row.recruiter_id,
        labor_type: row.labor_type,
        display_name: row.display_name,
        worker_details: {
          gender: { state: "omitted" },
          date_of_birth: { state: "omitted" },
          national_id: { state: "provided", value: "012345678901" },
          national_id_issued_at: { state: "omitted" },
          national_id_issued_place: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "omitted" },
        },
        general_note: { state: "omitted" },
        payment: null,
        employment: null,
      }],
    },
    idempotency_key: key,
  });
  assert.deepEqual(body, {
    ok: true,
    submission_id: rpcResult.submission_id,
    state: "DRAFT",
    version: 1,
    entry_ids: rpcResult.entry_ids,
  });
  assert.equal(JSON.stringify(body).includes("012345678901"), false);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("worker-profile/1.1 returns validated server-generated codes without client code input", async () => {
  const { employee_code: _employeeCode, ...rowWithoutCode } = row;
  void _employeeCode;
  assert.equal("employee_code" in rowWithoutCode, false);
  const generated = deps();
  generated.repository.createFullProfileBatch = async (input) => {
    generated.calls.push(input);
    return {
      ok: true,
      data: { ...rpcResult, employee_codes: ["hrp-2025-000001"] },
    };
  };
  const response = await postFullProfileBatch(request({
    contract_version: "worker-profile/1.1",
    rows: [{ ...rowWithoutCode, provider_type: "hrp" }],
  }), "true", generated);
  assert.equal(response.status, 201);
  assert.deepEqual(generated.calls[0].payload.rows[0].provider_type, "hrp");
  assert.equal("employee_code" in generated.calls[0].payload.rows[0], false);
  assert.deepEqual((await response.json()).employee_codes, ["hrp-2025-000001"]);

  const wrongYear = deps();
  wrongYear.repository.createFullProfileBatch = async () => ({
    ok: true,
    data: { ...rpcResult, employee_codes: ["hrp-2024-000001"] },
  });
  assert.equal((await postFullProfileBatch(request({
    contract_version: "worker-profile/1.1",
    rows: [{ ...rowWithoutCode, provider_type: "hrp" }],
  }), "true", wrongYear)).status, 500);
});

test("idempotent replay is 200 and conflicts are 409", async () => {
  const replay = deps({
    async createFullProfileBatch() {
      return { ok: true, data: { ...rpcResult, replayed: true } };
    },
  });
  assert.equal((await postFullProfileBatch(request(), "true", replay)).status, 200);
  const conflict = deps({
    async createFullProfileBatch() { return { ok: false, kind: "conflict" }; },
  });
  assert.equal((await postFullProfileBatch(request(), "true", conflict)).status, 409);
});

test("body limit, row validation and database errors map to bounded statuses", async () => {
  const tooLarge = await postFullProfileBatch(
    request("x".repeat(4 * 1024 * 1024 + 1)),
    "true",
    deps(),
  );
  assert.equal(tooLarge.status, 413);
  const malformed = await postFullProfileBatch(request({
    ...payload,
    rows: [{ ...row, worker: { phone: { state: "omitted" }, team_id: "forbidden" } }],
  }), "true", deps());
  assert.equal(malformed.status, 400);
  const denied = deps({
    async createFullProfileBatch() { return { ok: false, kind: "denied" }; },
  });
  assert.equal((await postFullProfileBatch(request(), "true", denied)).status, 403);
  const invalid = deps({
    async createFullProfileBatch() {
      return { ok: false, kind: "invalid", code: "BANK_NOT_ACTIVE" };
    },
  });
  const response = await postFullProfileBatch(request(), "true", invalid);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, code: "BANK_NOT_ACTIVE" });
});

test("unauthenticated and malformed RPC responses fail closed", async () => {
  const unauthenticated = deps();
  unauthenticated.resolveSession = async () => ({
    actor: { ok: false, reason: "UNAUTHENTICATED" },
    response_headers: {},
  });
  assert.equal((await postFullProfileBatch(request(), "true", unauthenticated)).status, 401);
  const malformed = deps({
    async createFullProfileBatch() {
      return { ok: true, data: { ...rpcResult, national_id: "should not be returned" } };
    },
  });
  assert.equal((await postFullProfileBatch(request(), "true", malformed)).status, 500);
});

// P3-W07C regression: khoa nguyen nhan 2 request 400 BATCH_INVALID tren
// Production 2026-10-06 23:13:37 / 23:13:46 GMT+7 (deployment dpl_4kYHy...).
// 1) Production-shaped valid row PHAI tra 201 (khong 400).
// 2) Loi Postgres 23514/22023/22008/23505 co message trong SAFE_INVALID_CODES
//    phai duoc chuyen nguyen ban, khong collapse ve BATCH_INVALID.
// 3) Loi 23505/22023 voi message khong trong SAFE_INVALID_CODES phai duoc
//    fallback BATCH_INVALID, NHUNG khong leak PII/UUID/auth (404 fallback).
test("P3-W07C REGRESSION: production-shaped valid row (today GMT+7, full profile) returns 201, not 400", async () => {
  // Tao ngay hom nay theo Asia/Ho_Chi_Minh, dinh dang YYYY-MM-DD (pure helper,
  // tranh `new Date("YYYY-MM-DD")` gay UTC leak).
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const today = `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}-${parts.find((p) => p.type === "day").value}`;

  // Row khop Production (today + DOB + gender + project + HRP + recruiter +
  // labor_type + national_id 12 chu so + issued_at/place).
  const productionRow = {
    project_id: "project_synthetic_01",
    first_work_date: today,
    employee_code: `hrp-${today.slice(0, 4)}-000123`,
    recruiter_id: "93000000-0000-4000-8000-000000000001",
    labor_type: "TEMPORARY",
    display_name: "Synthetic Worker Production",
    worker: {
      gender: { state: "provided", value: "MALE" },
      date_of_birth: { state: "provided", value: "1990-05-20" },
      national_id: { state: "provided", value: "012345678901" },
      national_id_issued_at: { state: "provided", value: "2020-06-01" },
      national_id_issued_place: { state: "provided", value: "Bộ Công An" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
    general_note: { state: "omitted" },
    payment: null,
    employment: null,
  };
  const prodPayload = { contract_version: "worker-profile/1.0", rows: [productionRow] };
  const dependencies = deps();
  const response = await postFullProfileBatch(
    new Request("https://example.test/api/direct-entry/batches/full-profile", {
      method: "POST",
      headers: {
        origin: "https://example.test",
        host: "example.test",
        "content-type": "application/json",
        "idempotency-key": "b1000000-0000-4000-8000-000000000010",
      },
      body: JSON.stringify(prodPayload),
    }),
    "true",
    dependencies,
  );
  assert.equal(response.status, 201,
    "production-shaped valid row phai 201; neu 400 => reproduction BATCH_INVALID");
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.state, "DRAFT");
  // Da forward row dung (today + DOB + issued place) toi repository, khong mutate.
  const forwarded = dependencies.calls[0].payload.rows[0];
  assert.equal(forwarded.first_work_date, today);
  assert.equal(forwarded.worker_details.date_of_birth.value, "1990-05-20");
  assert.equal(forwarded.worker_details.national_id_issued_place.value, "Bộ Công An");
});

test("P3-W07C REGRESSION: Postgres check/range/unique errors forward safe code, khong collapse ve BATCH_INVALID", async () => {
  // Khi repository (Postgres) raise 23514/22023/22008/23505 voi message
  // thuoc SAFE_INVALID_CODES, API phai tra DUNG code do, khong doi thanh
  // BATCH_INVALID (nguyen nhan goc 2 request 400 Production).
  const cases = [
    ["23514", "BANK_NOT_ACTIVE", "BANK_NOT_ACTIVE"],
    ["23514", "PROJECT_NOT_ACTIVE", "PROJECT_NOT_ACTIVE"],
    ["23514", "RECRUITER_NOT_ACTIVE", "RECRUITER_NOT_ACTIVE"],
    ["23514", "RECRUITER_MEMBERSHIP_INVALID", "RECRUITER_MEMBERSHIP_INVALID"],
    ["23514", "NATIONAL_ID_DUPLICATE", "NATIONAL_ID_DUPLICATE"],
    ["23514", "NATIONAL_ID_INVALID", "NATIONAL_ID_INVALID"],
    ["23514", "EMPLOYEE_CODE_DUPLICATE", "EMPLOYEE_CODE_DUPLICATE"],
    ["22023", "PROFILE_DATE_INVALID", "PROFILE_DATE_INVALID"],
    ["22008", "PROFILE_DATE_INVALID", "PROFILE_DATE_INVALID"],
    ["23505", "NATIONAL_ID_DUPLICATE", "NATIONAL_ID_DUPLICATE"],
  ];
  for (const [pgCode, message, expectedClientCode] of cases) {
    const dependencies = deps({
      async createFullProfileBatch() {
        return { ok: false, kind: "invalid", code: message };
      },
    });
    const response = await postFullProfileBatch(request(), "true", dependencies);
    assert.equal(response.status, 400,
      `pg ${pgCode} ${message} => phai 400`);
    const body = await response.json();
    assert.equal(body.code, expectedClientCode,
      `pg ${pgCode} ${message} => API phai tra ${expectedClientCode}, KHONG collapse ve BATCH_INVALID`);
  }
});

test("P3-W07C REGRESSION: loi Postgres khong xac dinh => BATCH_INVALID fallback (khong leak PII/UUID)", async () => {
  const sensitive = "duplicate key value violates unique constraint \"direct_entries_pkey\" with UUID 12345";
  const dependencies = deps({
    async createFullProfileBatch() {
      return { ok: false, kind: "invalid", code: sensitive };
    },
  });
  const response = await postFullProfileBatch(request(), "true", dependencies);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "BATCH_INVALID",
    "code khong nam trong SAFE_INVALID_CODES phai fallback BATCH_INVALID, khong leak PII/UUID/auth");
  const responseText = JSON.stringify(body);
  assert.equal(responseText.includes("12345"), false,
    "fallback khong duoc chua gia tri sensitive tu raw error message");
  assert.equal(responseText.toLowerCase().includes("unique"), false,
    "fallback khong duoc chua thong tin SQL/constraint noi bo");
});
