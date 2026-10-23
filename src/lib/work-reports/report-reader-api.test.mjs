import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "./contracts.ts";
import { listReadableWorkReportSubmissions } from "./report-reader-api.ts";
import { createReportReaderRepository } from "./report-reader-repository.ts";
import { getWorkReportSubmission } from "./submission-api.ts";
import { createSubmissionRepository } from "./submission-repository.ts";

const AUTH = "10000000-0000-4000-8000-000000000101";
const APP = "20000000-0000-4000-8000-000000000101";
const TEMPLATE_ID = "30000000-0000-4000-8000-000000000101";
const VERSION_ID = "40000000-0000-4000-8000-000000000101";
const TEAM_A = "50000000-0000-4000-8000-000000000101";
const TEAM_B = "50000000-0000-4000-8000-000000000102";
const ASSIGNEE_A = "60000000-0000-4000-8000-000000000101";
const OBLIGATION_ID = "70000000-0000-4000-8000-000000000101";
const SUBMISSION_ID = "80000000-0000-4000-8000-000000000101";
const REVISION_ID = "90000000-0000-4000-8000-000000000101";

const activeSession = async () => ({
  actor: {
    ok: true,
    actor: { auth_subject: AUTH, app_user_id: APP },
  },
});

const SAMPLE_READER_PAYLOAD = {
  effective_scope: { kind: "all", label: "Toàn công ty" },
  filter_options: {
    templates: [
      {
        template_id: TEMPLATE_ID,
        template_code: "DAILY_RECRUITMENT",
        display_name: "Báo cáo tuyển dụng ngày",
        versions: [
          {
            version_id: VERSION_ID,
            version_no: 1,
            status: "PUBLISHED",
          },
        ],
      },
    ],
    teams: [
      {
        team_id: TEAM_A,
        code: "TEAM_A",
        display_name: "Nhóm Tuyển Dụng A",
      },
    ],
    assignees: [
      {
        app_user_id: ASSIGNEE_A,
        display_name: "Nguyễn Văn A",
      },
    ],
  },
  items: [
    {
      obligation_id: OBLIGATION_ID,
      submission_id: SUBMISSION_ID,
      template_id: TEMPLATE_ID,
      template_name: "Báo cáo tuyển dụng ngày",
      template_version_id: VERSION_ID,
      template_version_no: 1,
      assignee_app_user_id: ASSIGNEE_A,
      assignee_display_name: "Nguyễn Văn A",
      team_id: TEAM_A,
      team_display_name: "Nhóm Tuyển Dụng A",
      period_key: "2026-10-22",
      period_start_date: "2026-10-22",
      period_end_date: "2026-10-22",
      state: "COMPLETED",
      latest_submitted_at: "2026-10-22T10:30:00.123456Z",
      is_late: false,
      has_post_deadline_amendment: false,
      current_revision_no: 2,
    },
  ],
  next_cursor: null,
  has_more: false,
};

test("GET /api/work-reports/submissions works without template_id, sets private no-store headers, and binds server session actor", async () => {
  let capturedRpc = null;
  const repository = createReportReaderRepository(async (name, args) => {
    capturedRpc = { name, args };
    return { data: SAMPLE_READER_PAYLOAD, error: null };
  });

  const response = await listReadableWorkReportSubmissions(
    new Request("https://bi.local/api/work-reports/submissions"),
    "true",
    { resolveSession: activeSession, repository },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.data, SAMPLE_READER_PAYLOAD);
  assert.deepEqual(body.effective_scope, SAMPLE_READER_PAYLOAD.effective_scope);
  assert.deepEqual(body.filter_options, SAMPLE_READER_PAYLOAD.filter_options);
  assert.deepEqual(body.items, SAMPLE_READER_PAYLOAD.items);
  assert.equal(body.next_cursor, null);
  assert.equal(body.has_more, false);

  assert.deepEqual(capturedRpc, {
    name: "work_report_list_readable_submissions",
    args: {
      p_auth_subject: AUTH,
      p_app_user_id: APP,
      p_template_id: null,
      p_version_id: null,
      p_from: null,
      p_to: null,
      p_team_id: null,
      p_assignee_id: null,
      p_state: null,
      p_cursor: null,
      p_limit: 50,
    },
  });
});

test("GET /api/work-reports/submissions passes validated optional filters and cursor", async () => {
  let capturedArgs = null;
  const cursor = `2026-10-22T10:30:00.123456Z|${SUBMISSION_ID}`;
  const paginatedPayload = {
    ...SAMPLE_READER_PAYLOAD,
    has_more: true,
    next_cursor: cursor,
  };
  const repository = createReportReaderRepository(async (_name, args) => {
    capturedArgs = args;
    return { data: paginatedPayload, error: null };
  });

  const url = new URL("https://bi.local/api/work-reports/submissions");
  url.searchParams.set("template_id", TEMPLATE_ID);
  url.searchParams.set("version_id", VERSION_ID);
  url.searchParams.set("from", "2026-10-01");
  url.searchParams.set("to", "2026-10-31");
  url.searchParams.set("team_id", TEAM_A);
  url.searchParams.set("assignee_id", ASSIGNEE_A);
  url.searchParams.set("state", "PENDING_REVIEW");
  url.searchParams.set("cursor", cursor);
  url.searchParams.set("limit", "25");

  const response = await listReadableWorkReportSubmissions(new Request(url), "true", {
    resolveSession: activeSession,
    repository,
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.has_more, true);
  assert.equal(body.next_cursor, cursor);
  assert.deepEqual(capturedArgs, {
    p_auth_subject: AUTH,
    p_app_user_id: APP,
    p_template_id: TEMPLATE_ID,
    p_version_id: VERSION_ID,
    p_from: "2026-10-01",
    p_to: "2026-10-31",
    p_team_id: TEAM_A,
    p_assignee_id: ASSIGNEE_A,
    p_state: "PENDING_REVIEW",
    p_cursor: cursor,
    p_limit: 25,
  });
});

test("GET /api/work-reports/submissions allowlists query params and rejects client authority fields, draft/not-started states, bad dates, cursors, and limits with 400", async () => {
  let rpcCalled = false;
  const repository = createReportReaderRepository(async () => {
    rpcCalled = true;
    return { data: SAMPLE_READER_PAYLOAD, error: null };
  });

  const invalidQueries = [
    "?role=admin",
    "?capability=report_view",
    "?scope=all",
    `?app_user_id=${APP}`,
    `?auth_subject=${AUTH}`,
    "?unknown_param=1",
    `?template_id=${TEMPLATE_ID}&template_id=${TEMPLATE_ID}`,
    "?template_id=not-a-uuid",
    "?version_id=not-a-uuid",
    "?team_id=not-a-uuid",
    "?assignee_id=not-a-uuid",
    "?from=2026-02-30",
    "?to=2026-13-01",
    "?from=2026-10-25&to=2026-10-20",
    "?state=DRAFT",
    "?state=NOT_STARTED",
    "?state=UNKNOWN",
    "?cursor=invalid-cursor",
    `?cursor=not-a-timestamp|${SUBMISSION_ID}`,
    "?cursor=2026-10-22T10:30:00.000000Z|not-a-uuid",
    "?limit=0",
    "?limit=101",
    "?limit=-5",
    "?limit=abc",
  ];

  for (const qs of invalidQueries) {
    const res = await listReadableWorkReportSubmissions(
      new Request(`https://bi.local/api/work-reports/submissions${qs}`),
      "true",
      { resolveSession: activeSession, repository },
    );
    assert.equal(res.status, 400, `Expected 400 for query ${qs}`);
    const body = await res.json();
    assert.deepEqual(body, { ok: false, code: "WORK_REPORT_QUERY_INVALID" });
  }
  assert.equal(rpcCalled, false, "invalid query parameters must never invoke session or RPC");
});

test("GET /api/work-reports/submissions distinguishes 400, 401, 403, 404, and 503 without leaking payload or PII", async () => {
  const noopRepo = createReportReaderRepository(async () => ({
    data: SAMPLE_READER_PAYLOAD,
    error: null,
  }));

  // Feature gate disabled => 404
  const disabledGate = await listReadableWorkReportSubmissions(
    new Request("https://bi.local/api/work-reports/submissions"),
    "false",
    { resolveSession: activeSession, repository: noopRepo },
  );
  assert.equal(disabledGate.status, 404);
  assert.deepEqual(await disabledGate.json(), { ok: false, code: "NOT_FOUND" });

  // Unauthenticated => 401
  const unauth = await listReadableWorkReportSubmissions(
    new Request("https://bi.local/api/work-reports/submissions"),
    "true",
    {
      resolveSession: async () => ({ actor: { ok: false, reason: "UNAUTHENTICATED" } }),
      repository: noopRepo,
    },
  );
  assert.equal(unauth.status, 401);
  assert.deepEqual(await unauth.json(), { ok: false, code: "UNAUTHENTICATED" });

  // Disabled session actor => 403 ACTOR_NOT_AVAILABLE
  const disabledSession = await listReadableWorkReportSubmissions(
    new Request("https://bi.local/api/work-reports/submissions"),
    "true",
    {
      resolveSession: async () => ({ actor: { ok: false, reason: "DISABLED" } }),
      repository: noopRepo,
    },
  );
  assert.equal(disabledSession.status, 403);
  assert.deepEqual(await disabledSession.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });

  // Session throws => 503 WORK_REPORT_UNAVAILABLE
  const sessionDown = await listReadableWorkReportSubmissions(
    new Request("https://bi.local/api/work-reports/submissions"),
    "true",
    {
      resolveSession: async () => {
        throw new Error("sensitive db connection error");
      },
      repository: noopRepo,
    },
  );
  assert.equal(sessionDown.status, 503);
  assert.deepEqual(await sessionDown.json(), { ok: false, code: "WORK_REPORT_UNAVAILABLE" });

  // Cross-team filter => 403 WORK_REPORT_SCOPE_DENIED
  const crossTeam = await listReadableWorkReportSubmissions(
    new Request(`https://bi.local/api/work-reports/submissions?team_id=${TEAM_B}`),
    "true",
    {
      resolveSession: activeSession,
      repository: createReportReaderRepository(async () => ({
        data: null,
        error: { code: "42501", message: "WORK_REPORT_SCOPE_DENIED" },
      })),
    },
  );
  assert.equal(crossTeam.status, 403);
  assert.deepEqual(await crossTeam.json(), { ok: false, code: "WORK_REPORT_SCOPE_DENIED" });

  // Missing capability => 403 WORK_REPORT_ACCESS_DENIED
  const missingCap = await listReadableWorkReportSubmissions(
    new Request("https://bi.local/api/work-reports/submissions"),
    "true",
    {
      resolveSession: activeSession,
      repository: createReportReaderRepository(async () => ({
        data: null,
        error: { code: "42501", message: "WORK_REPORT_CAPABILITY_DENIED" },
      })),
    },
  );
  assert.equal(missingCap.status, 403);
  assert.deepEqual(await missingCap.json(), { ok: false, code: "WORK_REPORT_ACCESS_DENIED" });

  // Disabled actor at DB => 403 ACTOR_NOT_AVAILABLE
  const dbActorDenied = await listReadableWorkReportSubmissions(
    new Request("https://bi.local/api/work-reports/submissions"),
    "true",
    {
      resolveSession: activeSession,
      repository: createReportReaderRepository(async () => ({
        data: null,
        error: { code: "42501", message: "WORK_REPORT_ACTOR_DENIED" },
      })),
    },
  );
  assert.equal(dbActorDenied.status, 403);
  assert.deepEqual(await dbActorDenied.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });

  // Unknown template / version => 404 WORK_REPORT_NOT_FOUND
  const notFound = await listReadableWorkReportSubmissions(
    new Request(`https://bi.local/api/work-reports/submissions?template_id=${TEMPLATE_ID}`),
    "true",
    {
      resolveSession: activeSession,
      repository: createReportReaderRepository(async () => ({
        data: null,
        error: { code: "P0002", message: "WORK_REPORT_TEMPLATE_NOT_FOUND" },
      })),
    },
  );
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { ok: false, code: "WORK_REPORT_NOT_FOUND" });

  // SQL 22023 => 400 WORK_REPORT_QUERY_INVALID
  const sqlInvalid = await listReadableWorkReportSubmissions(
    new Request("https://bi.local/api/work-reports/submissions"),
    "true",
    {
      resolveSession: activeSession,
      repository: createReportReaderRepository(async () => ({
        data: null,
        error: { code: "22023", message: "WORK_REPORT_CURSOR_INVALID" },
      })),
    },
  );
  assert.equal(sqlInvalid.status, 400);
  assert.deepEqual(await sqlInvalid.json(), { ok: false, code: "WORK_REPORT_QUERY_INVALID" });

  // Malformed RPC payload (e.g. accidental draft state or leaked payload_json) => 503 fail-closed
  for (const badPayload of [
    {
      ...SAMPLE_READER_PAYLOAD,
      items: [{ ...SAMPLE_READER_PAYLOAD.items[0], state: "DRAFT" }],
    },
    {
      ...SAMPLE_READER_PAYLOAD,
      items: [{ ...SAMPLE_READER_PAYLOAD.items[0], payload_json: { secret: "x" } }],
    },
    {
      ...SAMPLE_READER_PAYLOAD,
      has_more: true,
      next_cursor: null,
    },
  ]) {
    const badRes = await listReadableWorkReportSubmissions(
      new Request("https://bi.local/api/work-reports/submissions"),
      "true",
      {
        resolveSession: activeSession,
        repository: createReportReaderRepository(async () => ({
          data: badPayload,
          error: null,
        })),
      },
    );
    assert.equal(badRes.status, 503);
    assert.deepEqual(await badRes.json(), { ok: false, code: "WORK_REPORT_UNAVAILABLE" });
  }
});

test("Route files and detail endpoint /api/work-reports/submissions/[obligationId] remain intact and server-gated", async () => {
  const listRouteSource = await readFile(
    path.resolve("src/app/api/work-reports/submissions/route.ts"),
    "utf8",
  );
  const detailRouteSource = await readFile(
    path.resolve("src/app/api/work-reports/submissions/[obligationId]/route.ts"),
    "utf8",
  );
  assert.match(listRouteSource, /import "server-only";/);
  assert.match(listRouteSource, /process\.env\.WORK_REPORTS_API_ENABLED !== "true"/);
  assert.match(detailRouteSource, /import "server-only";/);
  assert.match(detailRouteSource, /getWorkReportSubmission/);

  const detailRepo = createSubmissionRepository(async (name, args) => {
    assert.equal(name, "work_report_get_submission");
    assert.equal(args.p_obligation_id, OBLIGATION_ID);
    return {
      data: {
        obligation: { obligation_id: OBLIGATION_ID },
        template: {
          template_code: "DAILY_RECRUITMENT",
          display_name: "Báo cáo tuyển dụng ngày",
          schema_json: RECRUITMENT_DAILY_TEMPLATE_SCHEMA,
        },
        submission: {
          submission_id: SUBMISSION_ID,
          state: "APPROVED",
          draft_payload_json: null,
          first_submitted_at: "2026-10-22T09:00:00Z",
          latest_submitted_at: "2026-10-22T10:30:00Z",
          is_late: false,
          has_post_deadline_amendment: false,
          current_revision_id: REVISION_ID,
          version: 2,
        },
        latest_review_event: {
          decision: "APPROVED",
          reason: "Đầy đủ số liệu",
          reviewed_at: "2026-10-22T11:00:00Z",
        },
        revisions: [
          {
            revision_id: REVISION_ID,
            revision_no: 1,
            payload_json: { calls_made: 15, interested_candidates: 4, workers_started: 1 },
            created_at: "2026-10-22T09:00:00Z",
          },
        ],
      },
      error: null,
    };
  });

  const detailRes = await getWorkReportSubmission(
    new Request(`https://bi.local/api/work-reports/submissions/${OBLIGATION_ID}`),
    OBLIGATION_ID,
    "true",
    { resolveSession: activeSession, repository: detailRepo },
  );
  assert.equal(detailRes.status, 200);
  const detailBody = await detailRes.json();
  assert.equal(detailBody.ok, true);
  assert.equal(detailBody.data.latest_review_event.decision, "APPROVED");
  assert.equal(detailBody.data.revisions.length, 1);
  assert.ok(detailBody.data.template.schema_json);
});
