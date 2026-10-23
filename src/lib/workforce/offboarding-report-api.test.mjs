import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import ExcelJS from "exceljs";
import {
  exportOffboardingReport,
  hideOffboardingWorker,
  listOffboardingReport,
} from "./offboarding-report-api.ts";
import { createOffboardingReportRepository } from "./offboarding-report-repository.ts";

const AUTH_SUBJECT = "19100000-0000-4000-8000-000000000001";
const APP_USER_ID = "29100000-0000-4000-8000-000000000001";
const RECRUITER_ID = "39100000-0000-4000-8000-000000000001";
const SNAPSHOT_ENTRY_ID = "49100000-0000-4000-8000-000000000001";
const SNAPSHOT_EVENT_ID = "59100000-0000-4000-8000-000000000001";
const SUPPRESSION_ID = "69100000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "79100000-0000-4000-8000-000000000001";

function makeSessionOk(overrides = {}) {
  return {
    actor: {
      ok: true,
      actor: {
        auth_subject: AUTH_SUBJECT,
        app_user_id: APP_USER_ID,
        display_name: "Admin Test",
        enabled: true,
        capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
        scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
        self_recruiter_suggestion: null,
        session: {
          provider: "supabase",
          verification: "getUser",
          authenticated_at: "2026-10-24T01:00:00.000Z",
        },
        ...overrides,
      },
    },
  };
}

function makeSessionDenied(reason) {
  return { actor: { ok: false, reason } };
}

function makeHideRequest(
  body,
  {
    url = "https://bi.example.com/api/workforce/offboarding/hide",
    origin = "https://bi.example.com",
    contentType = "application/json",
    extraHeaders = {},
  } = {},
) {
  const headers = new Headers({
    host: "bi.example.com",
    ...(origin === null ? {} : { origin }),
    ...(contentType === null ? {} : { "content-type": contentType }),
    ...extraHeaders,
  });
  return new Request(url, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("GET /api/workforce/offboarding returns HTTP 200 on 8-row payload containing phone: null and never returns 503", async () => {
  const rpcCalls = [];
  const repository = createOffboardingReportRepository(async (name, args) => {
    rpcCalls.push({ name, args });
    return {
      data: {
        scope: "all",
        authority: "admin",
        can_export: true,
        can_hide: true,
        authorization_date: "2026-10-24",
        page: 1,
        page_size: 25,
        total: 8,
        has_more: false,
        items: Array.from({ length: 8 }, (_, idx) => ({
          employee_code: `hrp-2026-00000${idx + 1}`,
          display_name: `Người lao động ${idx + 1}`,
          project_id: "proj-01",
          project_display: "Dự án Điện tử",
          recruiter_id: RECRUITER_ID,
          recruiter_display: "Tuyển dụng viên A",
          off_effective_date: "2026-10-18",
          days_since_off: 6,
          phone: idx < 4 ? null : `098800000${idx}`,
          snapshot_entry_id: `49100000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
          snapshot_status_event_id: `59100000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
        })),
      },
      error: null,
    };
  });

  const response = await listOffboardingReport(
    new Request("https://bi.example.com/api/workforce/offboarding?page=1&page_size=25"),
    "true",
    {
      resolveSession: async () => makeSessionOk(),
      repository,
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.equal(json.data.can_hide, true);
  assert.equal(json.data.items.length, 8);
  assert.equal(json.data.items[0].phone, null);
  assert.equal(json.data.items[7].phone, "0988000007");
  assert.deepEqual(rpcCalls, [
    {
      name: "direct_entry_offboarding_report",
      args: {
        p_auth_subject: AUTH_SUBJECT,
        p_app_user_id: APP_USER_ID,
        p_page: 1,
        p_page_size: 25,
      },
    },
  ]);
});

test("GET /api/workforce/offboarding/export generates Excel with Báo cáo NLĐ nghỉ việc title, handles phone: null, and leaks zero CCCD/internal refs", async () => {
  const repository = createOffboardingReportRepository(async (name) => {
    assert.equal(name, "direct_entry_offboarding_report_export");
    return {
      data: {
        authorization_date: "2026-10-24",
        items: [
          {
            employee_code: "hrp-2026-000010",
            display_name: "Trần Thị Không ĐT",
            project_id: "proj-01",
            project_display: "Dự án A",
            recruiter_id: RECRUITER_ID,
            recruiter_display: "Tuyển dụng A",
            off_effective_date: "2026-10-19",
            days_since_off: 5,
            phone: null,
          },
          {
            employee_code: "hrp-2026-000011",
            display_name: "Lê Văn Có ĐT",
            project_id: "proj-02",
            project_display: "Dự án B",
            recruiter_id: RECRUITER_ID,
            recruiter_display: "Tuyển dụng A",
            off_effective_date: "2026-10-20",
            days_since_off: 4,
            phone: "0912345678",
          },
        ],
      },
      error: null,
    };
  });

  const response = await exportOffboardingReport(
    new Request("https://bi.example.com/api/workforce/offboarding/export"),
    "true",
    {
      resolveSession: async () => makeSessionOk(),
      repository,
    },
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="bao-cao-nld-nghi-viec-2026-10-24.xlsx"',
  );

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await response.arrayBuffer());
  assert.equal(workbook.worksheets.length, 1);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.name, "Báo cáo NLĐ nghỉ việc");

  const rows = [];
  sheet.eachRow((row) => {
    rows.push(row.values.slice(1));
  });
  assert.deepEqual(rows, [
    [
      "Họ tên",
      "Mã NLĐ",
      "Dự án / công việc cuối",
      "Người tuyển cuối",
      "Ngày nghỉ việc",
      "Số ngày đã nghỉ",
      "Số điện thoại",
    ],
    ["Trần Thị Không ĐT", "hrp-2026-000010", "Dự án A", "Tuyển dụng A", "2026-10-19", 5, ""],
    ["Lê Văn Có ĐT", "hrp-2026-000011", "Dự án B", "Tuyển dụng A", "2026-10-20", 4, "0912345678"],
  ]);

  const serializedCells = JSON.stringify(rows);
  assert.equal(serializedCells.includes("cccd"), false);
  assert.equal(serializedCells.includes(SNAPSHOT_ENTRY_ID), false);
});

test("POST /api/workforce/offboarding/hide enforces CSRF, content-type, body limits, actor binding, error codes, idempotent status codes, and zero reason logging", async () => {
  const unusedRepo = createOffboardingReportRepository(async () => {
    throw new Error("RPC must not be called");
  });

  // 1. Disabled feature flag -> 404
  {
    const disabled = await hideOffboardingWorker(
      makeHideRequest({
        snapshot_entry_id: SNAPSHOT_ENTRY_ID,
        snapshot_status_event_id: SNAPSHOT_EVENT_ID,
        reason: "Đã về quê",
        idempotency_key: IDEMPOTENCY_KEY,
      }),
      "false",
      { resolveSession: async () => makeSessionOk(), repository: unusedRepo },
    );
    assert.equal(disabled.status, 404);
    assert.deepEqual(await disabled.json(), { ok: false, code: "NOT_FOUND" });
  }

  // 2. CSRF protection -> 403 CSRF_REJECTED before session resolution
  for (const badOrigin of [null, "https://attacker.example"]) {
    let sessionResolved = false;
    const csrfRes = await hideOffboardingWorker(
      makeHideRequest(
        {
          snapshot_entry_id: SNAPSHOT_ENTRY_ID,
          snapshot_status_event_id: SNAPSHOT_EVENT_ID,
          reason: "Đã về quê",
          idempotency_key: IDEMPOTENCY_KEY,
        },
        { origin: badOrigin },
      ),
      "true",
      {
        resolveSession: async () => {
          sessionResolved = true;
          return makeSessionOk();
        },
        repository: unusedRepo,
      },
    );
    assert.equal(csrfRes.status, 403);
    assert.deepEqual(await csrfRes.json(), { ok: false, code: "CSRF_REJECTED" });
    assert.equal(sessionResolved, false);
  }

  // 3. Disallowed authority headers, query params, and Content-Type checks
  {
    const headerForged = await hideOffboardingWorker(
      makeHideRequest(
        {
          snapshot_entry_id: SNAPSHOT_ENTRY_ID,
          snapshot_status_event_id: SNAPSHOT_EVENT_ID,
          reason: "Đã về quê",
          idempotency_key: IDEMPOTENCY_KEY,
        },
        { extraHeaders: { "x-app-user-id": APP_USER_ID } },
      ),
      "true",
      { resolveSession: async () => makeSessionOk(), repository: unusedRepo },
    );
    assert.equal(headerForged.status, 400);
    assert.deepEqual(await headerForged.json(), {
      ok: false,
      code: "WORKFORCE_OFFBOARDING_HIDE_INVALID",
    });

    const withQuery = await hideOffboardingWorker(
      makeHideRequest(
        {
          snapshot_entry_id: SNAPSHOT_ENTRY_ID,
          snapshot_status_event_id: SNAPSHOT_EVENT_ID,
          reason: "Đã về quê",
          idempotency_key: IDEMPOTENCY_KEY,
        },
        { url: "https://bi.example.com/api/workforce/offboarding/hide?override=1" },
      ),
      "true",
      { resolveSession: async () => makeSessionOk(), repository: unusedRepo },
    );
    assert.equal(withQuery.status, 400);
    assert.deepEqual(await withQuery.json(), {
      ok: false,
      code: "WORKFORCE_OFFBOARDING_HIDE_INVALID",
    });

    const badContentType = await hideOffboardingWorker(
      makeHideRequest("reason=abc", { contentType: "text/plain" }),
      "true",
      { resolveSession: async () => makeSessionOk(), repository: unusedRepo },
    );
    assert.equal(badContentType.status, 400);
    assert.deepEqual(await badContentType.json(), {
      ok: false,
      code: "CONTENT_TYPE_INVALID",
    });
  }

  // 4. Session failures -> 401 / 403 / 503
  {
    const r401 = await hideOffboardingWorker(
      makeHideRequest({
        snapshot_entry_id: SNAPSHOT_ENTRY_ID,
        snapshot_status_event_id: SNAPSHOT_EVENT_ID,
        reason: "Đã về quê",
        idempotency_key: IDEMPOTENCY_KEY,
      }),
      "true",
      { resolveSession: async () => makeSessionDenied("UNAUTHENTICATED"), repository: unusedRepo },
    );
    assert.equal(r401.status, 401);
    assert.deepEqual(await r401.json(), { ok: false, code: "UNAUTHENTICATED" });

    const r403 = await hideOffboardingWorker(
      makeHideRequest({
        snapshot_entry_id: SNAPSHOT_ENTRY_ID,
        snapshot_status_event_id: SNAPSHOT_EVENT_ID,
        reason: "Đã về quê",
        idempotency_key: IDEMPOTENCY_KEY,
      }),
      "true",
      { resolveSession: async () => makeSessionDenied("ACTOR_DISABLED"), repository: unusedRepo },
    );
    assert.equal(r403.status, 403);
    assert.deepEqual(await r403.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });

    const r503 = await hideOffboardingWorker(
      makeHideRequest({
        snapshot_entry_id: SNAPSHOT_ENTRY_ID,
        snapshot_status_event_id: SNAPSHOT_EVENT_ID,
        reason: "Đã về quê",
        idempotency_key: IDEMPOTENCY_KEY,
      }),
      "true",
      {
        resolveSession: async () => {
          throw new Error("session store unavailable");
        },
        repository: unusedRepo,
      },
    );
    assert.equal(r503.status, 503);
    assert.deepEqual(await r503.json(), {
      ok: false,
      code: "WORKFORCE_OFFBOARDING_UNAVAILABLE",
    });
  }

  // 5. Bounded JSON body & input validation -> 400
  {
    const declaredTooLarge = await hideOffboardingWorker(
      makeHideRequest("{}", { extraHeaders: { "content-length": "9000" } }),
      "true",
      { resolveSession: async () => makeSessionOk(), repository: unusedRepo },
    );
    assert.equal(declaredTooLarge.status, 400);
    assert.deepEqual(await declaredTooLarge.json(), { ok: false, code: "BODY_TOO_LARGE" });

    const streamedTooLarge = await hideOffboardingWorker(
      new Request("https://bi.example.com/api/workforce/offboarding/hide", {
        method: "POST",
        headers: {
          host: "bi.example.com",
          origin: "https://bi.example.com",
          "content-type": "application/json",
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`{"pad":"${"x".repeat(8300)}"}`));
            controller.close();
          },
        }),
        duplex: "half",
      }),
      "true",
      { resolveSession: async () => makeSessionOk(), repository: unusedRepo },
    );
    assert.equal(streamedTooLarge.status, 400);
    assert.deepEqual(await streamedTooLarge.json(), { ok: false, code: "BODY_TOO_LARGE" });

    const malformedJson = await hideOffboardingWorker(
      makeHideRequest("{bad-json"),
      "true",
      { resolveSession: async () => makeSessionOk(), repository: unusedRepo },
    );
    assert.equal(malformedJson.status, 400);
    assert.deepEqual(await malformedJson.json(), { ok: false, code: "BODY_INVALID" });

    for (const invalidPayload of [
      {
        snapshot_entry_id: SNAPSHOT_ENTRY_ID,
        snapshot_status_event_id: SNAPSHOT_EVENT_ID,
        reason: "   ",
        idempotency_key: IDEMPOTENCY_KEY,
      },
      {
        snapshot_entry_id: SNAPSHOT_ENTRY_ID,
        snapshot_status_event_id: SNAPSHOT_EVENT_ID,
        reason: "x".repeat(501),
        idempotency_key: IDEMPOTENCY_KEY,
      },
      {
        snapshot_entry_id: SNAPSHOT_ENTRY_ID,
        snapshot_status_event_id: SNAPSHOT_EVENT_ID,
        reason: "Đã về quê",
      },
    ]) {
      const invalidRes = await hideOffboardingWorker(
        makeHideRequest(invalidPayload),
        "true",
        { resolveSession: async () => makeSessionOk(), repository: unusedRepo },
      );
      assert.equal(invalidRes.status, 400);
      assert.deepEqual(await invalidRes.json(), {
        ok: false,
        code: "WORKFORCE_OFFBOARDING_HIDE_INVALID",
      });
    }
  }

  // 6. Fresh hide (201), replay (200), SQL error mapping (403/400/409/503), and zero reason/PII logging
  const loggedMessages = [];
  const origError = console.error;
  const origWarn = console.warn;
  const origInfo = console.info;
  const origLog = console.log;
  const capture = (...args) => {
    loggedMessages.push(args.map((a) => String(a)).join(" "));
  };
  console.error = capture;
  console.warn = capture;
  console.info = capture;
  console.log = capture;

  const sentinelReason = "SENSITIVE_HIDE_REASON_DO_NOT_LOG_991122";
  try {
    const rpcCalls = [];
    const createdRes = await hideOffboardingWorker(
      makeHideRequest(
        {
          snapshot_entry_id: SNAPSHOT_ENTRY_ID.toUpperCase(),
          snapshot_status_event_id: SNAPSHOT_EVENT_ID.toUpperCase(),
          reason: `  ${sentinelReason}  `,
        },
        { extraHeaders: { "Idempotency-Key": IDEMPOTENCY_KEY } },
      ),
      "true",
      {
        resolveSession: async () => makeSessionOk(),
        repository: createOffboardingReportRepository(async (name, args) => {
          rpcCalls.push({ name, args });
          return {
            data: {
              suppression_id: SUPPRESSION_ID,
              snapshot_entry_id: SNAPSHOT_ENTRY_ID,
              snapshot_status_event_id: SNAPSHOT_EVENT_ID,
              hidden_at: "2026-10-24T08:30:00.000Z",
              replayed: false,
            },
            error: null,
          };
        }),
      },
    );

    assert.equal(createdRes.status, 201);
    assert.equal(createdRes.headers.get("cache-control"), "private, no-store");
    const createdBody = await createdRes.json();
    assert.deepEqual(createdBody, {
      ok: true,
      data: {
        suppression_id: SUPPRESSION_ID,
        snapshot_entry_id: SNAPSHOT_ENTRY_ID,
        snapshot_status_event_id: SNAPSHOT_EVENT_ID,
        hidden_at: "2026-10-24T08:30:00.000Z",
        replayed: false,
      },
    });
    assert.deepEqual(rpcCalls, [
      {
        name: "direct_entry_offboarding_hide_snapshot",
        args: {
          p_auth_subject: AUTH_SUBJECT,
          p_app_user_id: APP_USER_ID,
          p_snapshot_entry_id: SNAPSHOT_ENTRY_ID,
          p_snapshot_status_event_id: SNAPSHOT_EVENT_ID,
          p_reason: sentinelReason,
          p_idempotency_key: IDEMPOTENCY_KEY,
        },
      },
    ]);

    const replayRes = await hideOffboardingWorker(
      makeHideRequest({
        snapshot_entry_id: SNAPSHOT_ENTRY_ID,
        snapshot_status_event_id: SNAPSHOT_EVENT_ID,
        reason: sentinelReason,
        idempotency_key: IDEMPOTENCY_KEY,
      }),
      "true",
      {
        resolveSession: async () => makeSessionOk(),
        repository: createOffboardingReportRepository(async () => ({
          data: {
            suppression_id: SUPPRESSION_ID,
            snapshot_entry_id: SNAPSHOT_ENTRY_ID,
            snapshot_status_event_id: SNAPSHOT_EVENT_ID,
            hidden_at: "2026-10-24T08:30:00.000Z",
            replayed: true,
          },
          error: null,
        })),
      },
    );
    assert.equal(replayRes.status, 200);
    assert.equal((await replayRes.json()).data.replayed, true);

    for (const [sqlCode, expectedHttp, expectedCode] of [
      ["42501", 403, "WORKFORCE_OFFBOARDING_HIDE_DENIED"],
      ["22023", 400, "WORKFORCE_OFFBOARDING_HIDE_INVALID"],
      ["40001", 409, "WORKFORCE_OFFBOARDING_SNAPSHOT_STALE"],
      ["23505", 409, "IDEMPOTENCY_CONFLICT"],
      ["XX000", 503, "WORKFORCE_OFFBOARDING_UNAVAILABLE"],
    ]) {
      const errRes = await hideOffboardingWorker(
        makeHideRequest({
          snapshot_entry_id: SNAPSHOT_ENTRY_ID,
          snapshot_status_event_id: SNAPSHOT_EVENT_ID,
          reason: sentinelReason,
          idempotency_key: IDEMPOTENCY_KEY,
        }),
        "true",
        {
          resolveSession: async () => makeSessionOk(),
          repository: createOffboardingReportRepository(async () => ({
            data: null,
            error: { code: sqlCode, message: `db failure ${sentinelReason}` },
          })),
        },
      );
      assert.equal(errRes.status, expectedHttp, sqlCode);
      assert.deepEqual(await errRes.json(), { ok: false, code: expectedCode }, sqlCode);
    }
  } finally {
    console.error = origError;
    console.warn = origWarn;
    console.info = origInfo;
    console.log = origLog;
  }

  assert.equal(
    loggedMessages.some((msg) => msg.includes(sentinelReason)),
    false,
    "hide reason must never be written to server logs",
  );
});

test("Offboarding UI panel, Dashboard tab, standalone page, and route handler satisfy deduplicated contract and FormDialog rules", () => {
  const panelSource = readFileSync(
    new URL("../../components/workforce/offboarding-report-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(panelSource, /parseOffboardingReportList\(body\.data\)/);
  assert.doesNotMatch(panelSource, /function\s+parseList\b/);
  assert.doesNotMatch(panelSource, /function\s+parseItem\b/);
  assert.doesNotMatch(panelSource, /window\.prompt\b/);
  assert.doesNotMatch(panelSource, /window\.confirm\b/);
  assert.match(panelSource, /<FormDialog\b/);
  assert.match(panelSource, /const canHide = list\?\.can_hide === true;/);
  assert.match(panelSource, /hideDialog\.item\.display_name/);
  assert.match(panelSource, /hideDialog\.item\.employee_code/);
  assert.match(panelSource, /\/api\/workforce\/offboarding\/hide/);
  assert.match(panelSource, /"Idempotency-Key":\s*intentKey/);
  assert.match(panelSource, /await fetchPage\(1,\s*false\)/);

  const tabsSource = readFileSync(
    new URL("../../components/dashboard/bod-dashboard-tabs.tsx", import.meta.url),
    "utf8",
  );
  assert.match(tabsSource, /label:\s*"Báo cáo NLĐ nghỉ việc"/);

  const pageSource = readFileSync(
    new URL("../../app/workforce/offboarding/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(pageSource, /Báo cáo NLĐ nghỉ việc/);

  const hideRouteSource = readFileSync(
    new URL("../../app/api/workforce/offboarding/hide/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(hideRouteSource, /export async function POST\(request:\s*Request\)/);
  assert.match(hideRouteSource, /hideOffboardingWorker\(/);
});
