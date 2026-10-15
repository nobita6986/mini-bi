/**
 * PRE-W2-P1 - API boundary xuat Excel full-PII (POST).
 *
 * Khoa: gate -> CSRF -> content-type -> body -> forbidden-authority -> allowlist; session actor
 * server-side; taxonomy 400/401/403/422/503; 200 XLSX voi header an toan; khong lo PII/raw error.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { exportWorkers } from "./worker-export-api.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};

const row = {
  employee_code: "hrp-2026-300001",
  display_name: "Worker One",
  date_of_birth: "1990-01-01",
  national_id: "012345678901",
  national_id_issued_at: "2020-01-01",
  phone: "0900000001",
  address: "1 Street",
  project_display: "Project A",
  first_work_date: "2026-10-01",
  labor_type_display: "Thời vụ",
  recruiter_display: "Recruiter A",
  provider_type: "HRP",
  employment_status: "ON",
  leave_date: null,
  leave_reason: null,
  account_number: "012345678901",
  bank_name: null,
  account_holder_name: null,
  payment_note: null,
  general_note: null,
};

const VALID_BODY = { scope: "recruited", reason: "export test" };

function fakeRequest(body, overrides = {}) {
  const headers = {
    origin: "https://example.test",
    host: "example.test",
    "content-type": "application/json",
    ...overrides,
  };
  const lower = {};
  for (const [key, value] of Object.entries(headers)) {
    lower[key.toLowerCase()] = value === undefined ? null : value;
  }
  const bytes = new TextEncoder().encode(
    typeof body === "string" ? body : JSON.stringify(body));
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
  return { headers: { get: (name) => lower[name.toLowerCase()] ?? null }, body: stream };
}

function dependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    resolveSession: async () => ({ actor: { ok: true, actor }, response_headers: {} }),
    repository: {
      async exportWorkers(input) {
        calls.push({ name: "exportWorkers", input });
        return { ok: true, envelope: { status: "ok", rows: [row] } };
      },
      ...overrides,
    },
  };
}

async function callApi(body, options = {}) {
  const flag = "flag" in options ? options.flag : "true";
  const deps = options.deps ?? dependencies();
  const buildXlsx = deps.buildXlsx ?? (async () => new Uint8Array([1, 2, 3]));
  return exportWorkers(fakeRequest(body, options.overrides), flag, { ...deps, buildXlsx });
}

test("the flag gate runs before body parsing or session", async () => {
  const deps = dependencies();
  const response = await callApi(VALID_BODY, { flag: undefined, deps });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "NOT_FOUND");
  assert.equal(deps.calls.length, 0);
});

test("CSRF, content-type and body guards reject before the repository", async () => {
  assert.equal((await callApi(VALID_BODY, { overrides: { origin: undefined } })).status, 403);
  assert.equal((await callApi(VALID_BODY, { overrides: { origin: "https://evil.test" } })).status, 403);
  assert.equal(
    (await callApi(VALID_BODY, { overrides: { "content-type": "text/plain" } })).status, 400);
  assert.equal(
    (await callApi("{not json", { overrides: {} })).status, 400);
});

test("client authority fields and an invalid request body are refused", async () => {
  assert.equal((await callApi({ ...VALID_BODY, auth_subject: "x" })).status, 400);
  assert.equal((await callApi({ ...VALID_BODY, app_user_id: "x" })).status, 400);
  assert.equal((await callApi({ ...VALID_BODY, scope: "everything" })).status, 400);
  assert.equal((await callApi({ scope: "recruited" })).status, 400);
  assert.equal((await callApi({ ...VALID_BODY, employment_status: "MAYBE" })).status, 400);
});

test("session failures map to sanitized 401/403", async () => {
  for (const [session, status, code] of [
    [{ actor: { ok: false, reason: "UNAUTHENTICATED" } }, 401, "UNAUTHENTICATED"],
    [{ actor: { ok: false, reason: "ACTOR_DISABLED" } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: { auth_subject: actor.auth_subject } } }, 403, "ACTOR_NOT_AVAILABLE"],
  ]) {
    const response = await callApi(VALID_BODY, {
      deps: { ...dependencies(), resolveSession: async () => ({ ...session, response_headers: {} }) },
    });
    assert.equal(response.status, status, code);
    assert.equal((await response.json()).code, code);
  }
});

test("repository outcomes map to the HTTP taxonomy, never leaking PII", async () => {
  for (const [kind, status, code] of [
    ["denied", 403, "WORKER_EXPORT_DENIED"],
    ["invalid", 400, "WORKER_EXPORT_REQUEST_INVALID"],
    ["unavailable", 503, "WORKER_EXPORT_UNAVAILABLE"],
  ]) {
    const response = await callApi(VALID_BODY, {
      deps: dependencies({ async exportWorkers() { return { ok: false, kind }; } }),
    });
    assert.equal(response.status, status, kind);
    const body = await response.json();
    assert.equal(body.code, code, kind);
    assert.doesNotMatch(JSON.stringify(body), /012345678901|national_id/);
  }
});

test("too_many_rows maps to 422 with the row-limit envelope and no rows", async () => {
  const response = await callApi(VALID_BODY, {
    deps: dependencies({
      async exportWorkers() { return { ok: true, envelope: { status: "too_many_rows", limit: 10000 } }; },
    }),
  });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    ok: false, code: "WORKER_EXPORT_ROW_LIMIT_EXCEEDED", limit: 10000,
  });
});

test("a successful export returns the XLSX bytes with private/no-store safety headers", async () => {
  const bytes = new Uint8Array([80, 75, 3, 4]);
  const seen = [];
  const response = await callApi(VALID_BODY, {
    deps: {
      ...dependencies(),
      async buildXlsx(rows) { seen.push(rows); return bytes; },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.match(response.headers.get("content-disposition"),
    /^attachment; filename="danh-sach-nguoi-lao-dong-[0-9]{4}-[0-9]{2}-[0-9]{2}\.xlsx"$/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0].national_id, "012345678901");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("an XLSX build failure is a sanitized 503", async () => {
  const response = await callApi(VALID_BODY, {
    deps: { ...dependencies(), async buildXlsx() { throw new Error("boom PII 012345678901"); } },
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "WORKER_EXPORT_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(body), /012345678901|boom/);
});

test("the request is forwarded to the repository with the server actor only", async () => {
  const deps = dependencies();
  await callApi({ scope: "managed", project_id: "proj_a", employment_status: "ON", reason: "x" },
    { deps });
  assert.deepEqual(deps.calls, [{
    name: "exportWorkers",
    input: {
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      scope: "managed",
      project_id: "proj_a",
      recruiter_id: null,
      employment_status: "ON",
      reason: "x",
    },
  }]);
});

test("the all scope is accepted by the body allowlist (authority stays server-side)", async () => {
  const deps = dependencies();
  await callApi({ scope: "all", reason: "audit all" }, { deps });
  assert.deepEqual(deps.calls, [{
    name: "exportWorkers",
    input: {
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      scope: "all",
      project_id: null,
      recruiter_id: null,
      employment_status: null,
      reason: "audit all",
    },
  }]);
});
