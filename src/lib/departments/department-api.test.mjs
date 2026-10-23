import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assignAccountingMemberAdmin,
  endAccountingMemberAdmin,
  getDepartmentAdmin,
  listAccountingCandidatesAdmin,
  listAccountingMembershipsAdmin,
  listDepartmentsAdmin,
  listRecruitmentTeamsAdmin,
} from "./department-api.ts";
import { createServiceDepartmentRepository } from "./department-repository.ts";

const HOST = "bi.local";
const ORIGIN = `https://${HOST}`;
const SAME_ORIGIN_POST_HEADERS = Object.freeze({
  host: HOST,
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
});
const ADMIN_AUTH = "10000000-0000-4000-8000-000000000001";
const ADMIN_APP = "20000000-0000-4000-8000-000000000001";
const USER_REF = "30000000-0000-4000-8000-000000000002";
const DEPT_ACCOUNTING = "40000000-0000-4000-8000-000000000003";
const DEPT_RECRUITMENT = "40000000-0000-4000-8000-000000000004";
const MEMBERSHIP_ID = "50000000-0000-4000-8000-000000000005";
const IDEM_KEY = "60000000-0000-4000-8000-000000000006";

function makeSession({
  unauthenticated = false,
  enabled = true,
  capabilities = ["entry_admin", "recruiter_master_manage", "team_master_manage"],
  scopes = [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
} = {}) {
  if (unauthenticated) {
    return async () => ({
      actor: { ok: false, reason: "UNAUTHENTICATED" },
    });
  }
  return async () => ({
    actor: {
      ok: true,
      actor: {
        auth_subject: ADMIN_AUTH,
        app_user_id: ADMIN_APP,
        display_name: "Synthetic Actor",
        enabled,
        capabilities,
        scopes,
        self_recruiter_suggestion: null,
        session: {
          provider: "supabase",
          verification: "getUser",
          authenticated_at: "2026-10-24T00:00:00.000Z",
        },
      },
    },
  });
}

function failIfCalledRepository() {
  const boom = async () => {
    throw new Error("Repository must not be called for unauthorized or invalid preflight");
  };
  return {
    listDepartments: boom,
    getDepartment: boom,
    listAccountingMemberships: boom,
    listAccountingCandidates: boom,
    assignAccountingMember: boom,
    endAccountingMember: boom,
    listRecruitmentTeams: boom,
  };
}

test("unauthenticated and non-Full-Admin actors are rejected with 401/403 before repository access", async () => {
  const unauthRes = await listDepartmentsAdmin(
    new Request(`${ORIGIN}/api/admin/departments`),
    {
      resolveSession: makeSession({ unauthenticated: true }),
      repository: failIfCalledRepository(),
    },
  );
  assert.equal(unauthRes.status, 401);
  assert.deepEqual(await unauthRes.json(), { ok: false, code: "UNAUTHENTICATED" });
  assert.equal(unauthRes.headers.get("cache-control"), "private, no-store");

  const nonAdminPersonas = [
    {
      label: "BoD / direct-grant viewer",
      capabilities: ["report_analytics_view", "entry_privileged_edit", "catalog_master_manage"],
      scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
    },
    {
      label: "Catalog operator only",
      capabilities: ["catalog_master_manage"],
      scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
    },
    {
      label: "Team Leader",
      capabilities: ["entry_team", "team_manager_assign", "report_view"],
      scopes: [
        { kind: "team", reference: DEPT_RECRUITMENT, valid_from: "2026-01-01", valid_to: null },
      ],
    },
    {
      label: "Staff / Accounting member without Full Admin",
      capabilities: ["entry_own"],
      scopes: [{ kind: "own", reference: ADMIN_APP, valid_from: "2026-01-01", valid_to: null }],
    },
  ];

  for (const persona of nonAdminPersonas) {
    const deps = {
      resolveSession: makeSession({
        capabilities: persona.capabilities,
        scopes: persona.scopes,
      }),
      repository: failIfCalledRepository(),
    };

    const readChecks = await Promise.all([
      listDepartmentsAdmin(new Request(`${ORIGIN}/api/admin/departments`), deps),
      getDepartmentAdmin(
        new Request(`${ORIGIN}/api/admin/departments/${DEPT_ACCOUNTING}`),
        DEPT_ACCOUNTING,
        deps,
      ),
      listAccountingMembershipsAdmin(
        new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`),
        deps,
      ),
      listAccountingCandidatesAdmin(
        new Request(`${ORIGIN}/api/admin/departments/accounting/candidates`),
        deps,
      ),
      listRecruitmentTeamsAdmin(
        new Request(`${ORIGIN}/api/admin/departments/recruitment/teams`),
        deps,
      ),
      assignAccountingMemberAdmin(
        new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`, {
          method: "POST",
          headers: {
            ...SAME_ORIGIN_POST_HEADERS,
            "content-type": "application/json",
            "idempotency-key": IDEM_KEY,
          },
          body: JSON.stringify({
            account_ref: USER_REF,
            expected_pair_version: 0,
            reason: "Thử gán trái phép",
            idempotency_key: IDEM_KEY,
          }),
        }),
        deps,
      ),
      endAccountingMemberAdmin(
        new Request(
          `${ORIGIN}/api/admin/departments/accounting/memberships/${MEMBERSHIP_ID}/end`,
          {
            method: "POST",
            headers: {
              ...SAME_ORIGIN_POST_HEADERS,
              "content-type": "application/json",
              "idempotency-key": IDEM_KEY,
            },
            body: JSON.stringify({
              expected_pair_version: 1,
              reason: "Thử thu hồi trái phép",
              idempotency_key: IDEM_KEY,
            }),
          },
        ),
        MEMBERSHIP_ID,
        deps,
      ),
    ]);

    for (const response of readChecks) {
      assert.equal(response.status, 403, `${persona.label} must receive 403`);
      assert.deepEqual(await response.json(), {
        ok: false,
        code: "DEPARTMENT_ACCESS_DENIED",
      });
    }
  }
});

test("mutation endpoints enforce same-origin CSRF, disallowed header guard, Content-Type, and 8 KiB body cap", async () => {
  const deps = {
    resolveSession: makeSession(),
    repository: failIfCalledRepository(),
  };

  // Cross-origin POST rejected with 403 CSRF_REJECTED
  const csrfRes = await assignAccountingMemberAdmin(
    new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
        "idempotency-key": IDEM_KEY,
      },
      body: JSON.stringify({
        account_ref: USER_REF,
        expected_pair_version: 0,
        reason: "CSRF probe",
        idempotency_key: IDEM_KEY,
      }),
    }),
    deps,
  );
  assert.equal(csrfRes.status, 403);
  assert.deepEqual(await csrfRes.json(), { ok: false, code: "CSRF_REJECTED" });

  // Disallowed client authority header rejected with 400
  const headerRes = await listDepartmentsAdmin(
    new Request(`${ORIGIN}/api/admin/departments`, {
      headers: { "x-app-user-id": ADMIN_APP },
    }),
    deps,
  );
  assert.equal(headerRes.status, 400);
  assert.deepEqual(await headerRes.json(), {
    ok: false,
    code: "DEPARTMENT_QUERY_INVALID",
  });

  // Wrong Content-Type rejected with 400
  const ctRes = await assignAccountingMemberAdmin(
    new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "text/plain",
        "idempotency-key": IDEM_KEY,
      },
      body: "{}",
    }),
    deps,
  );
  assert.equal(ctRes.status, 400);
  assert.deepEqual(await ctRes.json(), { ok: false, code: "CONTENT_TYPE_INVALID" });

  // Oversized JSON body rejected with 413
  const bigRes = await assignAccountingMemberAdmin(
    new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "application/json",
        "idempotency-key": IDEM_KEY,
      },
      body: JSON.stringify({
        account_ref: USER_REF,
        expected_pair_version: 0,
        reason: "x".repeat(9000),
        idempotency_key: IDEM_KEY,
      }),
    }),
    deps,
  );
  assert.equal(bigRes.status, 413);
  assert.deepEqual(await bigRes.json(), { ok: false, code: "BODY_TOO_LARGE" });
});

test("repository and API sanitize raw SQL errors and return canonical status codes on assign, replay, and end", async () => {
  const calls = [];
  const sampleMembership = {
    membership_id: MEMBERSHIP_ID,
    department_id: DEPT_ACCOUNTING,
    account_ref: USER_REF,
    display_name: "Trần Kế Toán",
    login_id: "ketoan.tran",
    personnel_code: "ketoan.tran",
    account_enabled: true,
    valid_from: "2026-10-24",
    valid_to: null,
    state: "CURRENT",
    effective: true,
    version: 1,
    pair_version: 1,
    granted_by_display_name: "Admin Gốc",
    revoked_by_display_name: null,
    revoked_at: null,
    created_at: "2026-10-24T02:00:00.000Z",
    updated_at: "2026-10-24T02:00:00.000Z",
  };

  let nextRpcResponse = { data: null, error: null };
  const repo = createServiceDepartmentRepository(async (fn, args) => {
    calls.push({ fn, args });
    return nextRpcResponse;
  });
  const deps = {
    resolveSession: makeSession(),
    repository: repo,
  };

  // Fresh assign -> 201
  nextRpcResponse = {
    data: { replayed: false, membership: sampleMembership },
    error: null,
  };
  const createdRes = await assignAccountingMemberAdmin(
    new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "application/json",
        "idempotency-key": IDEM_KEY,
      },
      body: JSON.stringify({
        account_ref: USER_REF,
        expected_pair_version: 0,
        reason: "Bổ nhiệm chính thức",
        idempotency_key: IDEM_KEY,
      }),
    }),
    deps,
  );
  assert.equal(createdRes.status, 201);
  const createdJson = await createdRes.json();
  assert.equal(createdJson.ok, true);
  assert.equal(createdJson.replayed, false);
  assert.equal(calls.at(-1)?.fn, "org_department_assign_accounting_member");

  // Replayed assign -> 200
  nextRpcResponse = {
    data: { replayed: true, membership: sampleMembership },
    error: null,
  };
  const replayRes = await assignAccountingMemberAdmin(
    new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "application/json",
        "idempotency-key": IDEM_KEY,
      },
      body: JSON.stringify({
        account_ref: USER_REF,
        expected_pair_version: 0,
        reason: "Bổ nhiệm chính thức",
        idempotency_key: IDEM_KEY,
      }),
    }),
    deps,
  );
  assert.equal(replayRes.status, 200);
  assert.equal((await replayRes.json()).replayed, true);

  // End membership -> 200
  nextRpcResponse = {
    data: {
      replayed: false,
      membership: {
        ...sampleMembership,
        valid_to: "2026-10-24",
        state: "HISTORY",
        effective: false,
        version: 2,
        pair_version: 2,
        revoked_by_display_name: "Admin Gốc",
        revoked_at: "2026-10-24T03:00:00.000Z",
      },
    },
    error: null,
  };
  const endedRes = await endAccountingMemberAdmin(
    new Request(`${ORIGIN}/api/admin/departments/accounting/memberships/${MEMBERSHIP_ID}/end`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "application/json",
        "idempotency-key": IDEM_KEY,
      },
      body: JSON.stringify({
        expected_pair_version: 1,
        reason: "Điều chuyển sang đơn vị khác",
        idempotency_key: IDEM_KEY,
      }),
    }),
    MEMBERSHIP_ID,
    deps,
  );
  assert.equal(endedRes.status, 200);
  const endedJson = await endedRes.json();
  assert.equal(endedJson.ok, true);
  assert.equal(endedJson.membership.state, "HISTORY");
  assert.equal(endedJson.membership.effective, false);
  assert.equal(calls.at(-1)?.fn, "org_department_end_accounting_member");

  // Idempotency conflict -> 409 IDEMPOTENCY_CONFLICT
  nextRpcResponse = {
    data: null,
    error: { code: "23505", message: "IDEMPOTENCY_CONFLICT" },
  };
  const conflictRes = await endAccountingMemberAdmin(
    new Request(`${ORIGIN}/api/admin/departments/accounting/memberships/${MEMBERSHIP_ID}/end`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "application/json",
        "idempotency-key": IDEM_KEY,
      },
      body: JSON.stringify({
        expected_pair_version: 1,
        reason: "Khác lý do với cùng key",
        idempotency_key: IDEM_KEY,
      }),
    }),
    MEMBERSHIP_ID,
    deps,
  );
  assert.equal(conflictRes.status, 409);
  assert.deepEqual(await conflictRes.json(), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });

  // Raw unexpected SQL error never leaks table/column/SQL text to client
  nextRpcResponse = {
    data: null,
    error: {
      code: "XX000",
      message: 'internal postgres failure on relation "organization_department_memberships" secret@company.vn',
    },
  };
  const sanitizedRes = await listDepartmentsAdmin(
    new Request(`${ORIGIN}/api/admin/departments`),
    deps,
  );
  assert.equal(sanitizedRes.status, 503);
  const sanitizedText = await sanitizedRes.text();
  assert.equal(sanitizedText.includes("organization_department_memberships"), false);
  assert.equal(sanitizedText.includes("secret@company.vn"), false);
  assert.deepEqual(JSON.parse(sanitizedText), {
    ok: false,
    code: "DEPARTMENT_UNAVAILABLE",
  });
});

test("Recruitment teams route exports GET only and exposes zero write methods", async () => {
  const routeSource = await readFile(
    path.resolve("src/app/api/admin/departments/recruitment/teams/route.ts"),
    "utf8",
  );
  assert.match(routeSource, /export\s+async\s+function\s+GET\b/);
  for (const forbiddenVerb of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.doesNotMatch(
      routeSource,
      new RegExp(`export\\s+(async\\s+)?function\\s+${forbiddenVerb}\\b`),
      `Recruitment teams route must not export ${forbiddenVerb}`,
    );
  }
});
