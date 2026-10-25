import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateN8nBodRequest,
  clearN8nServiceActorCache,
  N8N_BOD_READONLY_PRINCIPAL,
  resolveN8nBodServiceActor,
} from "./auth.ts";
import { N8N_BOD_CATALOG_VERSION } from "./catalog.ts";
import {
  handleN8nBodCatalogGet,
  handleN8nBodQueryPost,
} from "./http-handlers.ts";

const VALID_API_KEY = "n8n_bod_secret_token_for_unit_test_1234567890";
const TEST_ENV = {
  apiEnabled: "true",
  apiKey: VALID_API_KEY,
  authSubject: "11111111-1111-4111-8111-111111111111",
  appUserId: "22222222-2222-4222-8222-222222222222",
};

const TEST_ACTOR = {
  auth_subject: TEST_ENV.authSubject,
  app_user_id: TEST_ENV.appUserId,
};

function makeCatalogRequest(
  path = "/api/integrations/n8n/v1/catalog",
  headers = { authorization: `Bearer ${VALID_API_KEY}` },
) {
  return new Request(`https://bi.internal${path}`, {
    method: "GET",
    headers,
  });
}

function makeQueryRequest(
  body,
  headers = {
    authorization: `Bearer ${VALID_API_KEY}`,
    "content-type": "application/json",
  },
  path = "/api/integrations/n8n/v1/query",
) {
  return new Request(`https://bi.internal${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("authenticateN8nBodRequest enforces dedicated Bearer secret and rejects forbidden headers/query params", () => {
  // 1. Disabled integration
  const disabledRes = authenticateN8nBodRequest(makeCatalogRequest(), {
    ...TEST_ENV,
    apiEnabled: "false",
  });
  assert.equal(disabledRes.ok, false);
  assert.equal(disabledRes.status, 503);
  assert.equal(disabledRes.code, "N8N_INTEGRATION_DISABLED");

  // 2. Missing or short API key
  const unconfiguredRes = authenticateN8nBodRequest(makeCatalogRequest(), {
    ...TEST_ENV,
    apiKey: "too-short",
  });
  assert.equal(unconfiguredRes.ok, false);
  assert.equal(unconfiguredRes.status, 503);
  assert.equal(unconfiguredRes.code, "N8N_INTEGRATION_NOT_CONFIGURED");

  // 3. Token in query string is forbidden
  const queryCredRes = authenticateN8nBodRequest(
    makeCatalogRequest(`/api/integrations/n8n/v1/catalog?api_key=${VALID_API_KEY}`),
    TEST_ENV,
  );
  assert.equal(queryCredRes.ok, false);
  assert.equal(queryCredRes.status, 400);
  assert.equal(queryCredRes.code, "CREDENTIAL_IN_QUERY_FORBIDDEN");

  // 4. Caller-supplied authority header is forbidden
  const headerAuthRes = authenticateN8nBodRequest(
    makeCatalogRequest("/api/integrations/n8n/v1/catalog", {
      authorization: `Bearer ${VALID_API_KEY}`,
      "x-team-id": "33333333-3333-4333-8333-333333333333",
    }),
    TEST_ENV,
  );
  assert.equal(headerAuthRes.ok, false);
  assert.equal(headerAuthRes.status, 400);
  assert.equal(headerAuthRes.code, "CLIENT_AUTHORITY_HEADER_FORBIDDEN");

  // 5. Wrong bearer token -> 401
  const wrongTokenRes = authenticateN8nBodRequest(
    makeCatalogRequest("/api/integrations/n8n/v1/catalog", {
      authorization: "Bearer wrong_token_value_12345678901234567890",
    }),
    TEST_ENV,
  );
  assert.equal(wrongTokenRes.ok, false);
  assert.equal(wrongTokenRes.status, 401);
  assert.equal(wrongTokenRes.code, "UNAUTHORIZED");

  // 6. Valid bearer token -> fixed principal n8n_bod_readonly at all scope
  const okRes = authenticateN8nBodRequest(makeCatalogRequest(), TEST_ENV);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.principal.principal, N8N_BOD_READONLY_PRINCIPAL);
  assert.equal(okRes.principal.scope, "all");
});

test("resolveN8nBodServiceActor supports explicit env and auto-discovers full-admin actor", async () => {
  clearN8nServiceActorCache();
  const explicit = await resolveN8nBodServiceActor({ env: TEST_ENV });
  assert.equal(explicit.ok, true);
  assert.deepEqual(explicit.actor, TEST_ACTOR);

  clearN8nServiceActorCache();
  const discovered = await resolveN8nBodServiceActor({
    env: { apiKey: VALID_API_KEY },
    listAuthUserIds: async () => [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ],
    resolveActorContextRpc: async (authSubject) => {
      if (authSubject === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
        return {
          data: {
            auth_subject: authSubject,
            app_user_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            enabled: true,
            capabilities: ["entry_own"],
            all_scope_grants: [],
          },
          error: null,
        };
      }
      return {
        data: {
          auth_subject: authSubject,
          app_user_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          enabled: true,
          capabilities: [
            "entry_admin",
            "recruiter_master_manage",
            "team_master_manage",
            "catalog_master_manage",
            "entry_privileged_edit",
            "report_view",
            "report_analytics_view",
            "vendor_finance_view",
          ],
          all_scope_grants: [{ valid_from: "2026-01-01", valid_to: null }],
        },
        error: null,
      };
    },
  });
  assert.equal(discovered.ok, true);
  assert.equal(
    discovered.actor.app_user_id,
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  );
  clearN8nServiceActorCache();
});

test("GET /api/integrations/n8n/v1/catalog returns complete versioned catalog and pending work_reports", async () => {
  const response = await handleN8nBodCatalogGet(makeCatalogRequest(), {
    env: TEST_ENV,
    now: new Date("2026-10-25T10:00:00.000Z"),
  });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.ok, true);
  assert.equal(body.catalog_version, N8N_BOD_CATALOG_VERSION);
  assert.equal(body.principal, "n8n_bod_readonly");
  assert.equal(body.scope, "all");
  assert.equal(body.business_timezone, "Asia/Ho_Chi_Minh");
  assert.equal(body.query_contract.arbitrary_sql_allowed, false);
  assert.equal(body.query_contract.client_authority_fields_allowed, false);

  const datasetNames = body.datasets.map((d) => d.dataset);
  const expectedDatasets = [
    "recruitment_cutover_summary",
    "recruitment_legacy_summary",
    "recruitment_cutover_reconciliation",
    "workforce_analytics",
    "workforce_offboarding",
    "workers_directory",
    "workers_profile_detail",
    "workers_episodes_lookup",
    "workers_duplicate_cccd",
    "attendance_checkins",
    "vendor_finance_monthly_report",
    "vendor_finance_subledgers",
    "vendor_finance_entries",
    "vendor_finance_reconciliations",
    "data_quality_pipeline",
    "data_quality_cccd_reconciliation",
    "catalog_projects",
    "catalog_teams",
    "catalog_project_team_scopes",
    "catalog_recruiters",
    "catalog_vendors",
    "catalog_labor_types",
  ];
  assert.deepEqual(datasetNames, expectedDatasets);

  // Every measure must document formula and business_limits
  for (const ds of body.datasets) {
    for (const m of ds.measures) {
      assert.ok(m.formula && m.formula.length > 0, `Measure ${ds.dataset}.${m.name} missing formula`);
      assert.ok(
        m.business_limits && m.business_limits.length > 0,
        `Measure ${ds.dataset}.${m.name} missing business_limits`,
      );
    }
  }

  // Pending work_reports must be explicitly documented
  assert.equal(body.pending_datasets.length, 1);
  assert.equal(body.pending_datasets[0].dataset, "work_reports");
  assert.equal(body.pending_datasets[0].status, "PENDING_T1A_CONTRACT");
});

test("POST /api/integrations/n8n/v1/query rejects SQL, client authority fields, and pending work_reports", async () => {
  // 1. Reject arbitrary SQL
  const sqlRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "workers_directory",
      sql: "SELECT * FROM direct_entries",
    }),
    { env: TEST_ENV },
  );
  assert.equal(sqlRes.status, 400);
  const sqlBody = await sqlRes.json();
  assert.equal(sqlBody.error.code, "ARBITRARY_SQL_FORBIDDEN");

  // 2. Reject client authority fields (actor, role, scope, team_id, capabilities)
  for (const forbiddenField of [
    "actor",
    "role",
    "scope",
    "team_id",
    "auth_subject",
    "app_user_id",
    "capabilities",
  ]) {
    const authRes = await handleN8nBodQueryPost(
      makeQueryRequest({
        dataset: "workers_directory",
        [forbiddenField]: "injected",
      }),
      { env: TEST_ENV },
    );
    assert.equal(authRes.status, 400);
    const authBody = await authRes.json();
    assert.equal(authBody.error.code, "CLIENT_AUTHORITY_FORBIDDEN");
  }

  // 3. Pending dataset work_reports returns 422 DATASET_PENDING_CONTRACT
  const pendingRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "work_reports",
    }),
    { env: TEST_ENV },
  );
  assert.equal(pendingRes.status, 422);
  const pendingBody = await pendingRes.json();
  assert.equal(pendingBody.error.code, "DATASET_PENDING_CONTRACT");
  assert.equal(pendingBody.error.details.status, "PENDING_T1A_CONTRACT");

  // 4. Unknown dataset returns 400 DATASET_NOT_SUPPORTED
  const unknownRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "non_existent_dataset",
    }),
    { env: TEST_ENV },
  );
  assert.equal(unknownRes.status, 400);
  const unknownBody = await unknownRes.json();
  assert.equal(unknownBody.error.code, "DATASET_NOT_SUPPORTED");
});

test("Recruitment cutover reconciliation & summary strictly prevent double-counting across cutoff_date", async () => {
  const dispatcherDeps = {
    resolveActor: async () => ({ ok: true, actor: TEST_ACTOR }),
    fetchDirectEntryCutoverReporting: async () => ({
      ok: true,
      generatedAt: "2026-10-25T10:00:00Z",
      audience: { kind: "all", label: "Toàn công ty", teamLabels: [] },
      data: {
        applied: {
          from: "2026-10-01",
          to: "2026-10-25",
          project: undefined,
          recruiter: undefined,
          team: undefined,
          employment: undefined,
          provider: undefined,
          source: undefined,
        },
        options: {
          projects: [],
          recruiters: [],
          teams: [],
          employments: [],
          providers: [],
          sources: [],
        },
        recruitedTotal: 120,
        byDate: {
          "2026-10-20": 120,
        },
        byProject: {
          "proj-a": {
            key: "proj-a",
            display: "Dự án A",
            recruitedCount: 120,
            validRowCount: 120,
          },
        },
        byRecruiter: {},
        byTeam: {},
        byEmployment: {},
        byProvider: {
          hrp: {
            key: "hrp",
            display: "HRP",
            recruitedCount: 80,
            validRowCount: 80,
          },
          vendor: {
            key: "vendor",
            display: "Vendor",
            recruitedCount: 40,
            validRowCount: 40,
          },
        },
        projectProviderMix: [
          {
            projectKey: "proj-a",
            projectDisplay: "Dự án A",
            recruitedTotal: 120,
            hrpCount: 80,
            vendorCount: 40,
            unknownCount: 0,
            invalidCount: 0,
            knownTotal: 120,
            hrpShare: 80 / 120,
            vendorShare: 40 / 120,
          },
        ],
        sources: [],
        coverage: {
          activeSourcesTotal: 1,
          activeSourcesWithSyncedData: 1,
          activeSourcesMissingData: 0,
          coverageRatio: 1,
          degradedSources: 0,
        },
      },
    }),
    fetchP1Reporting: async () => ({
      ok: true,
      generatedAt: "2026-10-25T10:00:00Z",
      data: {
        applied: {
          from: "2026-10-01",
          to: "2026-10-25",
        },
        options: {
          projects: [],
          recruiters: [],
          teams: [],
          employments: [],
          providers: [],
          sources: [],
        },
        recruitedTotal: 45,
        byDate: {
          "2026-10-15": 45,
        },
        byProject: {},
        byRecruiter: {},
        byTeam: {},
        byEmployment: {},
        byProvider: {
          hrp: {
            key: "hrp",
            display: "HRP",
            recruitedCount: 30,
            validRowCount: 30,
          },
          vendor: {
            key: "vendor",
            display: "Vendor",
            recruitedCount: 15,
            validRowCount: 15,
          },
        },
        projectProviderMix: [],
        sources: [],
        coverage: {
          activeSourcesTotal: 1,
          activeSourcesWithSyncedData: 1,
          activeSourcesMissingData: 0,
          coverageRatio: 1,
          degradedSources: 0,
        },
      },
    }),
  };

  const reconRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "recruitment_cutover_reconciliation",
      date_range: { from: "2026-10-01", to: "2026-10-25" },
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(reconRes.status, 200);
  const reconBody = await reconRes.json();
  assert.equal(reconBody.ok, true);
  assert.equal(reconBody.summary.legacy_before_cutoff_total, 0);
  assert.equal(reconBody.summary.legacy_on_or_after_cutoff_masked_total, 45);
  assert.equal(reconBody.summary.direct_entry_on_or_after_cutoff_total, 120);
  // Strictly 120, NEVER 120 + 45 = 165!
  assert.equal(reconBody.summary.combined_non_overlapping_total, 120);
});

test("Sensitive fields (CCCD, phone, GPS, bank account, free-text notes) are redacted by default and returned only when requested", async () => {
  const dispatcherDeps = {
    resolveActor: async () => ({ ok: true, actor: TEST_ACTOR }),
    attendanceRepo: {
      getAdminReport: async () => ({
        ok: true,
        report: {
          viewer: { can_configure_hq: false },
          filters: {
            from_date: "2026-10-25",
            to_date: "2026-10-25",
            search: null,
            employee_id: null,
            timezone: "Asia/Ho_Chi_Minh",
          },
          employee_options: [],
          current_hq: {
            version: 1,
            latitude: 21.0285,
            longitude: 105.8542,
            effective_from: "2026-10-01T00:00:00Z",
            effective_from_local: "2026-10-01 07:00:00",
            configured_by_display_name: "Admin",
          },
          overview: {
            total_checkins: 1,
            unique_employees: 1,
            verified_time_count: 1,
            unverified_time_count: 0,
            distance_computed_count: 1,
            distance_unavailable_count: 0,
            avg_distance_meters: 12.4,
            max_distance_meters: 12.4,
          },
          pagination: {
            page: 1,
            page_size: 50,
            total_rows: 1,
            total_pages: 1,
            has_more: false,
          },
          items: [
            {
              checkin_id: "99999999-9999-4999-8999-999999999999",
              employee_display_name: "Nguyễn Văn A",
              personnel_code: "HRP001",
              business_date: "2026-10-25",
              sequence_in_day: 1,
              captured_at: "2026-10-25T01:00:00Z",
              captured_at_local: "2026-10-25 08:00:00",
              received_at: "2026-10-25T01:00:02Z",
              time_source: "SERVER_TOKEN",
              time_verified: true,
              sync_delay_seconds: 2,
              latitude: 21.02851,
              longitude: 105.85421,
              accuracy_meters: 8.5,
              address_hint: "Số 1 Tràng Tiền, Hoàn Kiếm",
              distance_meters: 12.4,
              distance_status: "WITHIN_100M",
              hq_version_used: 1,
              note: "Đi họp khách hàng buổi sáng",
            },
          ],
        },
      }),
    },
    offboardingRepo: {
      list: async () => ({
        ok: true,
        data: {
          scope: "all",
          can_phone: true,
          can_export: true,
          can_hide: true,
          authorization_date: "2026-10-25",
          threshold_days: 3,
          page: 1,
          page_size: 25,
          total: 1,
          has_more: false,
          items: [
            {
              employee_code: "CN001",
              display_name: "Trần Thị B",
              project_id: "proj-1",
              project_display: "Dự án 1",
              recruiter_id: "44444444-4444-4444-8444-444444444444",
              recruiter_display: "Lê Tuyển Dụng",
              off_effective_date: "2026-10-15",
              days_since_off: 10,
              phone: "0912345678",
            },
          ],
        },
      }),
    },
    workerWriteRepo: {
      readEntry: async () => ({
        ok: true,
        data: {
          entry_id: "55555555-5555-4555-8555-555555555555",
          submission_id: "66666666-6666-4666-8666-666666666666",
          version: 1,
          employee_code: "CN101",
          project_id: "proj-1",
          recruiter_id: "44444444-4444-4444-8444-444444444444",
          team_id: "77777777-7777-4777-8777-777777777777",
          provider_type: "hrp",
          labor_type: "chinh_thuc",
          labor_type_display: "Chính thức",
          first_work_date: "2026-10-10",
          general_note: "Ghi chú nội bộ nhạy cảm",
          employment_status: {
            status: "ON",
            effective_date: "2026-10-10",
          },
          worker_details: {
            display_name: "Phạm Văn C",
            gender: { state: "provided", value: "Nam" },
            date_of_birth: { state: "provided", value: "1998-05-12" },
            national_id: { state: "provided", value: "001200012345" },
            national_id_issued_at: { state: "provided", value: "2021-01-01" },
            national_id_issued_place: {
              state: "provided",
              value: "Cục Cảnh sát QLHC",
            },
            phone: { state: "provided", value: "0988777666" },
            address: { state: "provided", value: "Quận Cầu Giấy, Hà Nội" },
          },
          payment: {
            state: "READY",
            bank_id: "VCB",
            bank_name: "Vietcombank",
            account_number: "0011009988776",
            account_holder_name: "PHAM VAN C",
          },
          worker_portrait: {
            status: "UPLOADED",
          },
          documents: [{ document_id: "doc-1" }, { document_id: "doc-2" }],
        },
      }),
    },
    duplicateCccdRepo: {
      report: async () => ({
        ok: true,
        data: {
          authorization_date: "2026-10-25",
          page: 1,
          page_size: 25,
          total_groups: 1,
          total_entries: 2,
          has_more: false,
          groups: [
            {
              cccd_last4: "2345",
              cccd_length: 12,
              profile_count: 2,
              project_count: 1,
              active_profile_count: 2,
              first_work_date: "2026-10-10",
              latest_first_work_date: "2026-10-12",
              episodes: [
                {
                  entry_id: "55555555-5555-4555-8555-555555555555",
                  entry_version: 1,
                  employee_code: "CN101",
                  display_name: "Phạm Văn C",
                  project_display: "Dự án 1",
                  first_work_date: "2026-10-10",
                  latest_status: "ON",
                  active: true,
                },
              ],
            },
          ],
        },
      }),
    },
  };

  // 1. Attendance default query (no explicit fields) MUST redact GPS and note
  const attDefaultRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "attendance_checkins",
      date_range: { from: "2026-10-25", to: "2026-10-25" },
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(attDefaultRes.status, 200);
  const attDefaultBody = await attDefaultRes.json();
  assert.equal(attDefaultBody.rows.length, 1);
  assert.equal("latitude" in attDefaultBody.rows[0], false);
  assert.equal("longitude" in attDefaultBody.rows[0], false);
  assert.equal("address_hint" in attDefaultBody.rows[0], false);
  assert.equal("note" in attDefaultBody.rows[0], false);
  assert.deepEqual(attDefaultBody.sensitivity.requested_sensitive_fields, []);
  assert.ok(attDefaultBody.sensitivity.redacted_sensitive_fields.includes("latitude"));
  assert.ok(attDefaultBody.sensitivity.redacted_sensitive_fields.includes("note"));

  // 2. Attendance query explicitly requesting latitude, longitude, note MUST return them
  const attExplicitRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "attendance_checkins",
      fields: ["employee_code", "distance_meters", "latitude", "longitude", "note"],
      date_range: { from: "2026-10-25", to: "2026-10-25" },
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  const attExplicitBody = await attExplicitRes.json();
  assert.equal(attExplicitBody.rows[0].latitude, 21.02851);
  assert.equal(attExplicitBody.rows[0].longitude, 105.85421);
  assert.equal(attExplicitBody.rows[0].note, "Đi họp khách hàng buổi sáng");
  assert.equal("address_hint" in attExplicitBody.rows[0], false);

  // 3. Offboarding default query redacts phone; explicit fields includes phone
  const offDefaultBody = await (
    await handleN8nBodQueryPost(
      makeQueryRequest({ dataset: "workforce_offboarding" }),
      { env: TEST_ENV, dispatcherDeps },
    )
  ).json();
  assert.equal("phone" in offDefaultBody.rows[0], false);

  const offExplicitBody = await (
    await handleN8nBodQueryPost(
      makeQueryRequest({
        dataset: "workforce_offboarding",
        fields: ["employee_code", "display_name", "phone"],
      }),
      { env: TEST_ENV, dispatcherDeps },
    )
  ).json();
  assert.equal(offExplicitBody.rows[0].phone, "0912345678");

  // 4. Worker profile detail default query returns national_id_masked & account_number_masked, redacts national_id/phone/account_number/general_note
  const detailDefaultBody = await (
    await handleN8nBodQueryPost(
      makeQueryRequest({
        dataset: "workers_profile_detail",
        filters: [
          {
            field: "entry_id",
            op: "eq",
            value: "55555555-5555-4555-8555-555555555555",
          },
        ],
      }),
      { env: TEST_ENV, dispatcherDeps },
    )
  ).json();
  assert.equal(detailDefaultBody.rows[0].national_id_masked, "••••••••2345");
  assert.equal(detailDefaultBody.rows[0].account_number_masked, "••••••••8776");
  assert.equal(detailDefaultBody.rows[0].document_count, 2);
  assert.equal("national_id" in detailDefaultBody.rows[0], false);
  assert.equal("phone" in detailDefaultBody.rows[0], false);
  assert.equal("account_number" in detailDefaultBody.rows[0], false);
  assert.equal("general_note" in detailDefaultBody.rows[0], false);

  const detailExplicitBody = await (
    await handleN8nBodQueryPost(
      makeQueryRequest({
        dataset: "workers_profile_detail",
        fields: ["employee_code", "national_id_masked", "national_id"],
        filters: [
          {
            field: "entry_id",
            op: "eq",
            value: "55555555-5555-4555-8555-555555555555",
          },
        ],
      }),
      { env: TEST_ENV, dispatcherDeps },
    )
  ).json();
  assert.equal(detailExplicitBody.rows[0].national_id, "001200012345");

  // 5. Duplicate CCCD returns canonical_cccd_masked (••••••••2345)
  const dupDefaultBody = await (
    await handleN8nBodQueryPost(
      makeQueryRequest({ dataset: "workers_duplicate_cccd" }),
      { env: TEST_ENV, dispatcherDeps },
    )
  ).json();
  assert.equal(dupDefaultBody.rows[0].canonical_cccd_masked, "••••••••2345");
});

test("Vendor finance datasets preserve strict sub-ledger grain (Project + Accountant) and never cross-net accountants", async () => {
  const ACCOUNTANT_A = "aaaa1111-1111-4111-8111-111111111111";
  const ACCOUNTANT_B = "bbbb2222-2222-4222-8222-222222222222";

  const dispatcherDeps = {
    resolveActor: async () => ({ ok: true, actor: TEST_ACTOR }),
    vendorFinanceRepo: {
      getMonthlyReport: async () => ({
        ok: true,
        data: {
          authorization_date: "2026-10-25",
          allowed_actions: { can_view: true, can_record: false },
          filters: {
            month: "2026-10",
            project_id: null,
            accountant_ref: null,
            vendor_id: null,
          },
          totals: {
            vendor_count: 1,
            sub_ledger_count: 2,
            legacy_unallocated_vendor_count: 0,
            balance_before_month_minor: "0",
            opening_payable_in_month_minor: "0",
            opening_advance_in_month_minor: "0",
            obligations_in_month_minor: "50000000",
            paid_in_month_minor: "0",
            advanced_in_month_minor: "20000000",
            paid_and_advanced_in_month_minor: "20000000",
            net_change_in_month_minor: "30000000",
            closing_balance_minor: "30000000",
            closing_payable_minor: "50000000",
            closing_advance_minor: "20000000",
            current_balance_minor: "30000000",
          },
          // Accountant A has +50M payable on Vendor 1; Accountant B has -20M advance on Vendor 1
          project_accountant_summaries: [
            {
              project_id: "proj-lux",
              project_display_name: "Dự án Luxshare",
              project_active: true,
              accountant_ref: ACCOUNTANT_A,
              responsible_accountant_display_name: "Kế toán A",
              is_currently_assigned: true,
              vendor_count: 1,
              balance_before_month_minor: "0",
              opening_payable_in_month_minor: "0",
              opening_advance_in_month_minor: "0",
              obligations_in_month_minor: "50000000",
              paid_in_month_minor: "0",
              advanced_in_month_minor: "0",
              paid_and_advanced_in_month_minor: "0",
              net_change_in_month_minor: "50000000",
              closing_balance_minor: "50000000",
              closing_payable_minor: "50000000",
              closing_advance_minor: "0",
              current_balance_minor: "50000000",
            },
            {
              project_id: "proj-lux",
              project_display_name: "Dự án Luxshare",
              project_active: true,
              accountant_ref: ACCOUNTANT_B,
              responsible_accountant_display_name: "Kế toán B",
              is_currently_assigned: true,
              vendor_count: 1,
              balance_before_month_minor: "0",
              opening_payable_in_month_minor: "0",
              opening_advance_in_month_minor: "0",
              obligations_in_month_minor: "0",
              paid_in_month_minor: "0",
              advanced_in_month_minor: "20000000",
              paid_and_advanced_in_month_minor: "20000000",
              net_change_in_month_minor: "-20000000",
              closing_balance_minor: "-20000000",
              closing_payable_minor: "0",
              closing_advance_minor: "20000000",
              current_balance_minor: "-20000000",
            },
          ],
          legacy_unallocated_rows: [],
          rows: [
            {
              project_id: "proj-lux",
              project_display_name: "Dự án Luxshare",
              project_active: true,
              accountant_ref: ACCOUNTANT_A,
              responsible_accountant_display_name: "Kế toán A",
              is_currently_assigned: true,
              vendor_id: "vendor-alpha",
              vendor_display_name: "Vendor Alpha",
              vendor_active: true,
              balance_before_month_minor: "0",
              opening_payable_in_month_minor: "0",
              opening_advance_in_month_minor: "0",
              obligations_in_month_minor: "50000000",
              paid_in_month_minor: "0",
              advanced_in_month_minor: "0",
              paid_and_advanced_in_month_minor: "0",
              net_change_in_month_minor: "50000000",
              closing_balance_minor: "50000000",
              closing_direction: "PAYABLE",
              closing_payable_minor: "50000000",
              closing_advance_minor: "0",
              current_balance_minor: "50000000",
              in_month_entry_count: 1,
              total_entry_count: 1,
            },
            {
              project_id: "proj-lux",
              project_display_name: "Dự án Luxshare",
              project_active: true,
              accountant_ref: ACCOUNTANT_B,
              responsible_accountant_display_name: "Kế toán B",
              is_currently_assigned: true,
              vendor_id: "vendor-alpha",
              vendor_display_name: "Vendor Alpha",
              vendor_active: true,
              balance_before_month_minor: "0",
              opening_payable_in_month_minor: "0",
              opening_advance_in_month_minor: "0",
              obligations_in_month_minor: "0",
              paid_in_month_minor: "0",
              advanced_in_month_minor: "20000000",
              paid_and_advanced_in_month_minor: "20000000",
              net_change_in_month_minor: "-20000000",
              closing_balance_minor: "-20000000",
              closing_direction: "ADVANCE",
              closing_payable_minor: "0",
              closing_advance_minor: "20000000",
              current_balance_minor: "-20000000",
              in_month_entry_count: 1,
              total_entry_count: 1,
            },
          ],
        },
      }),
      listVendors: async () => ({
        ok: true,
        data: {
          authorization_date: "2026-10-25",
          allowed_actions: { can_view: true, can_record: false },
          filters: {
            search: null,
            active: "all",
            balance_filter: "all",
            project_id: null,
            accountant_ref: null,
            ledger_scope: null,
          },
          page: 1,
          page_size: 25,
          total: 1,
          has_more: false,
          summary: {
            vendor_count: 1,
            sub_ledger_count: 2,
            payable_vendor_count: 1,
            advance_vendor_count: 1,
            uninitialized_vendor_count: 0,
            legacy_unallocated_vendor_count: 0,
            total_payable_minor: "50000000",
            total_advance_minor: "20000000",
          },
          vendors: [
            {
              vendor_id: "vendor-alpha",
              display_name: "Vendor Alpha",
              active: true,
              current_balance_minor: "30000000",
              balance_direction: "PAYABLE",
              payable_minor: "50000000",
              advance_minor: "20000000",
              entry_count: 2,
              has_opening_entry: true,
              eligible_for_opening: false,
              last_effective_date: "2026-10-20",
              last_entry_at: "2026-10-20T10:00:00Z",
              last_reconciled_as_of_date: null,
              last_reconciled_at: null,
              sub_ledger_count: 2,
              legacy_unallocated_balance_minor: "0",
              legacy_unallocated_entry_count: 0,
              sub_ledgers: [
                {
                  ledger_scope: "PROJECT_ACCOUNTANT",
                  project_id: "proj-lux",
                  project_display_name: "Dự án Luxshare",
                  accountant_ref: ACCOUNTANT_A,
                  responsible_accountant_display_name: "Kế toán A",
                  current_balance_minor: "50000000",
                  balance_direction: "PAYABLE",
                  entry_count: 1,
                  has_opening_entry: true,
                  eligible_for_opening: false,
                  last_reconciled_as_of_date: null,
                },
                {
                  ledger_scope: "PROJECT_ACCOUNTANT",
                  project_id: "proj-lux",
                  project_display_name: "Dự án Luxshare",
                  accountant_ref: ACCOUNTANT_B,
                  responsible_accountant_display_name: "Kế toán B",
                  current_balance_minor: "-20000000",
                  balance_direction: "ADVANCE",
                  entry_count: 1,
                  has_opening_entry: true,
                  eligible_for_opening: false,
                  last_reconciled_as_of_date: null,
                },
              ],
            },
          ],
        },
      }),
    },
  };

  // 1. Monthly report preserves both sub-ledgers separately and does not net Accountant A and B
  const monthlyRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "vendor_finance_monthly_report",
      filters: [{ field: "month", op: "eq", value: "2026-10" }],
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(monthlyRes.status, 200);
  const monthlyBody = await monthlyRes.json();
  assert.equal(monthlyBody.rows.length, 2);
  assert.equal(
    monthlyBody.summary.subledger_policy,
    "STRICT_PROJECT_ACCOUNTANT_SUBLEDGER_NO_CROSS_ACCOUNTANT_NETTING",
  );
  assert.equal(monthlyBody.summary.project_accountant_summaries.length, 2);
  assert.equal(
    monthlyBody.summary.project_accountant_summaries[0].closing_payable_minor,
    "50000000",
  );
  assert.equal(
    monthlyBody.summary.project_accountant_summaries[1].closing_advance_minor,
    "20000000",
  );

  // 2. Subledgers dataset projects each (project, accountant, vendor) sub-ledger without global net_balance_minor
  const subledgersRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "vendor_finance_subledgers",
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(subledgersRes.status, 200);
  const subledgersBody = await subledgersRes.json();
  assert.equal(subledgersBody.rows.length, 2);
  assert.equal(subledgersBody.summary.by_project_accountant.length, 2);
  assert.equal("net_balance_minor" in subledgersBody.summary, false);
});

test("Cursor pagination and multi-query cross-domain workflow work end-to-end", async () => {
  const dispatcherDeps = {
    resolveActor: async () => ({ ok: true, actor: TEST_ACTOR }),
    projectAdminRepo: {
      listProjects: async () => ({
        ok: true,
        data: {
          authorization_date: "2026-10-25",
          projects: [
            {
              project_id: "proj-1",
              display_name: "Dự án Bắc Ninh 1",
              active: true,
              version: 1,
              active_assignment_count: 1,
              revision_count: 1,
              updated_at: "2026-10-25T00:00:00Z",
              updated_by_user_id: null,
            },
            {
              project_id: "proj-2",
              display_name: "Dự án Bắc Giang 2",
              active: true,
              version: 1,
              active_assignment_count: 0,
              revision_count: 1,
              updated_at: "2026-10-25T00:00:00Z",
              updated_by_user_id: null,
            },
          ],
        },
      }),
    },
  };

  // Page 1 with page_size = 1
  const page1Res = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "catalog_projects",
      page_size: 1,
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(page1Res.status, 200);
  const page1Body = await page1Res.json();
  assert.equal(page1Body.rows.length, 1);
  assert.equal(page1Body.rows[0].project_id, "proj-1");
  assert.equal(page1Body.pagination.has_more, true);
  assert.ok(page1Body.pagination.next_cursor);

  // Page 2 using next_cursor
  const page2Res = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "catalog_projects",
      page_size: 1,
      cursor: page1Body.pagination.next_cursor,
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(page2Res.status, 200);
  const page2Body = await page2Res.json();
  assert.equal(page2Body.rows.length, 1);
  assert.equal(page2Body.rows[0].project_id, "proj-2");
  assert.equal(page2Body.pagination.has_more, false);
  assert.equal(page2Body.pagination.next_cursor, null);

  // Replaying cursor from catalog_projects on catalog_teams must fail with INVALID_CURSOR
  const crossCursorRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "catalog_teams",
      cursor: page1Body.pagination.next_cursor,
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(crossCursorRes.status, 400);
  const crossCursorBody = await crossCursorRes.json();
  assert.equal(crossCursorBody.error.code, "INVALID_CURSOR");
});
