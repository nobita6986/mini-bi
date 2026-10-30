import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { buildSalaryAdvanceEvidenceStorageKey } from "./r2-salary-advance-evidence-storage.ts";
import {
  MAX_SALARY_ADVANCE_MUTATION_JSON_BYTES,
  computeServerQueueBadgeCount,
  handleGetExportSalaryAdvanceRequests,
  handleGetPreviewSalaryAdvanceEvidence,
  handleGetSalaryAdvanceContext,
  handleGetSalaryAdvanceProjectWorkers,
  handleGetSalaryAdvanceRequestDetail,
  handleGetSalaryAdvanceRequests,
  handleGetSalaryAdvanceWorkerHistory,
  handleGetSalaryAdvanceWorkerPortrait,
  handlePostCreateSalaryAdvanceRequest,
  handlePostFinalizeSalaryAdvanceEvidence,
  handlePostReserveSalaryAdvanceEvidence,
  handlePostReviewSalaryAdvanceEvidence,
  handlePostSalaryAdvanceAction,
  handlePostSalaryAdvanceMessage,
} from "./salary-advance-api.ts";
import { createSalaryAdvanceRepository } from "./salary-advance-repository.ts";

const HOST = "bi.local";
const ORIGIN = `https://${HOST}`;
const SAME_ORIGIN_POST_HEADERS = Object.freeze({
  host: HOST,
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
});

const AUTH_SUBJECT = "10000000-0000-4000-8000-000000000001";
const PM_USER_ID = "20000000-0000-4000-8000-000000000001";
const ACCT_USER_ID = "20000000-0000-4000-8000-000000000002";
const REQ_ID = "30000000-0000-4000-8000-000000000001";
const WORKER_ID = "40000000-0000-4000-8000-000000000001";
const PORTRAIT_DOC_ID = "50000000-0000-4000-8000-000000000001";
const UPLOAD_1_ID = "60000000-0000-4000-8000-000000000001";
const UPLOAD_2_ID = "60000000-0000-4000-8000-000000000002";
const EVENT_1_ID = "70000000-0000-4000-8000-000000000001";
const IDEM_1 = "idem-api-test-00001";
const IDEM_2 = "idem-api-test-00002";

function makeValidJpegBytes(tag = "cash-receipt-photo") {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.from(tag, "utf8"),
      Buffer.from([0xff, 0xd9]),
    ]),
  );
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeActorSession(appUserId = PM_USER_ID) {
  return async () => ({
    actor: {
      ok: true,
      actor: {
        auth_subject: AUTH_SUBJECT,
        app_user_id: appUserId,
        username: "qlda01",
        display_name: "QLDA 01",
        enabled: true,
        capabilities: [],
        scopes: [],
      },
    },
  });
}

function makeSampleDetail(overrides = {}) {
  return {
    request: {
      request_id: REQ_ID,
      project_id: "PRJ_NORTH",
      project_display_name: "Dự án Bắc",
      worker_entry_id: WORKER_ID,
      worker_employee_code: "NV001",
      worker_display_name: "Nguyễn Văn A",
      worker_portrait: {
        document_id: PORTRAIT_DOC_ID,
        version: 1,
        mime_type: "image/jpeg",
        size_bytes: 128,
        checksum_sha256: "a".repeat(64),
      },
      requested_amount_vnd: "15000000",
      initial_content: "Ứng lương đợt 1",
      request_state: "OPEN",
      evidence_review_state: "NOT_UPLOADED",
      version: 1,
      created_by_user_id: PM_USER_ID,
      created_by_display_name: "QLDA 01",
      decided_by_user_id: null,
      decided_by_display_name: null,
      decided_at: null,
      decision_note: null,
      handled_externally_by_user_id: null,
      handled_externally_by_display_name: null,
      handled_externally_at: null,
      handled_externally_note: null,
      withdrawn_by_user_id: null,
      withdrawn_by_display_name: null,
      withdrawn_at: null,
      withdrawn_note: null,
      current_evidence: null,
      current_project_accountant: {
        app_user_id: ACCT_USER_ID,
        display_name: "Kế toán A",
      },
      allowed_actions: {
        can_post_message: true,
        can_provide_info: false,
        can_withdraw: true,
        can_upload_evidence: false,
        can_request_info: false,
        can_approve: false,
        can_reject: false,
        can_mark_handled_externally: false,
        can_review_evidence: false,
      },
      last_activity_at: "2026-10-29T10:00:00Z",
      created_at: "2026-10-29T10:00:00Z",
      updated_at: "2026-10-29T10:00:00Z",
      ...overrides,
    },
    events: [
      {
        event_id: EVENT_1_ID,
        event_seq: 1,
        event_type: "REQUEST_CREATED",
        actor_user_id: PM_USER_ID,
        actor_display_name: "QLDA 01",
        actor_role: "PROJECT_MANAGER",
        from_request_state: null,
        to_request_state: "OPEN",
        from_evidence_review_state: null,
        to_evidence_review_state: "NOT_UPLOADED",
        message_text: "Ứng lương đợt 1",
        evidence_version: null,
        evidence_mime_type: null,
        evidence_size_bytes: null,
        evidence_checksum_sha256: null,
        reviewed_worker_portrait_document_id: null,
        reviewed_worker_portrait_version: null,
        created_at: "2026-10-29T10:00:00Z",
      },
    ],
    evidence_versions: [],
  };
}

function createFakeEvidenceStorage() {
  const stagedObjects = new Map();
  const finalObjects = new Map();
  const portraitObjects = new Map();
  const deletedStagedKeys = [];

  return {
    stagedObjects,
    finalObjects,
    portraitObjects,
    deletedStagedKeys,
    available: () => true,
    async createUploadUrl(input) {
      return {
        url: `https://r2.example.test/upload/${encodeURIComponent(input.storage_key)}`,
        expires_at: "2026-10-29T10:15:00.000Z",
        headers: { "Content-Type": input.mime_type },
      };
    },
    async readStagedBounded(storageKey) {
      if (!stagedObjects.has(storageKey)) return { kind: "missing" };
      const bytes = stagedObjects.get(storageKey);
      return { kind: "found", bytes };
    },
    async promoteStagedToFinal(input) {
      const bytes = stagedObjects.get(input.storage_key);
      if (!bytes) throw new Error("missing staged object");
      finalObjects.set(input.storage_key, bytes);
    },
    async deleteStaged(storageKey) {
      deletedStagedKeys.push(storageKey);
      stagedObjects.delete(storageKey);
    },
    async readFinalBounded(storageKey) {
      if (!finalObjects.has(storageKey)) return { kind: "missing" };
      return { kind: "found", bytes: finalObjects.get(storageKey) };
    },
    async readWorkerPortraitFinalBounded(storageKey) {
      if (!portraitObjects.has(storageKey)) return { kind: "missing" };
      return { kind: "found", bytes: portraitObjects.get(storageKey) };
    },
  };
}

test("feature gate, disallowed authority headers, CSRF, session failures, and oversized body fail closed", async () => {
  const repository = createSalaryAdvanceRepository(async () => ({
    data: null,
    error: null,
  }));
  const deps = {
    resolveSession: makeActorSession(),
    repository,
  };

  // Feature gate disabled -> 404
  const disabledRes = await handleGetSalaryAdvanceContext(
    new Request(`${ORIGIN}/api/salary-advance/context`),
    "false",
    deps,
  );
  assert.equal(disabledRes.status, 404);

  // Disallowed client authority header -> 400
  const spoofedRes = await handleGetSalaryAdvanceContext(
    new Request(`${ORIGIN}/api/salary-advance/context`, {
      headers: { "x-app-user-id": PM_USER_ID },
    }),
    "true",
    deps,
  );
  assert.equal(spoofedRes.status, 400);
  assert.equal(
    (await spoofedRes.json()).code,
    "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  );

  // Cross-origin POST -> 403 CSRF_ORIGIN_DENIED
  const csrfRes = await handlePostCreateSalaryAdvanceRequest(
    new Request(`${ORIGIN}/api/salary-advance/requests`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    }),
    "true",
    deps,
  );
  assert.equal(csrfRes.status, 403);
  assert.equal((await csrfRes.json()).code, "CSRF_ORIGIN_DENIED");

  // Unauthenticated session -> 401
  const unauthRes = await handleGetSalaryAdvanceContext(
    new Request(`${ORIGIN}/api/salary-advance/context`),
    "true",
    {
      resolveSession: async () => ({
        actor: { ok: false, reason: "UNAUTHENTICATED" },
      }),
      repository,
    },
  );
  assert.equal(unauthRes.status, 401);

  // Oversized JSON body -> 413
  const oversizedBody = JSON.stringify({
    project_id: "PRJ_NORTH",
    worker_entry_id: WORKER_ID,
    requested_amount_vnd: "1000000",
    initial_content: "x".repeat(MAX_SALARY_ADVANCE_MUTATION_JSON_BYTES + 100),
  });
  const tooLargeRes = await handlePostCreateSalaryAdvanceRequest(
    new Request(`${ORIGIN}/api/salary-advance/requests`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: oversizedBody,
    }),
    "true",
    deps,
  );
  assert.equal(tooLargeRes.status, 413);
  assert.equal((await tooLargeRes.json()).code, "REQUEST_BODY_TOO_LARGE");
});

test("context, workers, list, create, detail, message, action, and review handlers preserve contract and strip internal fields", async () => {
  const sampleDetail = makeSampleDetail();
  const repository = createSalaryAdvanceRepository(async (fn, args) => {
    switch (fn) {
      case "salary_advance_get_actor_context":
        return {
          data: {
            app_user_id: args.p_app_user_id,
            display_name: "QLDA 01",
            is_project_manager: true,
            is_project_accountant: false,
            is_supervisory_viewer: false,
            is_full_admin: false,
            is_bod: false,
            managed_projects: [
              {
                project_id: "PRJ_NORTH",
                display_name: "Dự án Bắc",
                active: true,
                has_active_accountant: true,
                accountant_user_id: ACCT_USER_ID,
                accountant_display_name: "Kế toán A",
              },
            ],
            accountant_projects: [],
            supervisory_projects: [],
            authorization_date: "2026-10-29",
          },
          error: null,
        };
      case "salary_advance_list_project_workers":
        return {
          data: {
            project_id: args.p_project_id,
            workers: [
              {
                worker_entry_id: WORKER_ID,
                employee_code: "NV001",
                display_name: "Nguyễn Văn A",
                first_work_date: "2026-01-10",
                has_portrait: true,
              },
            ],
            has_more: false,
            next_cursor: null,
          },
          error: null,
        };
      case "salary_advance_list_requests":
        return {
          data: {
            requests: [sampleDetail.request],
            has_more: false,
            next_cursor: null,
          },
          error: null,
        };
      case "salary_advance_get_request_detail":
        return {
          data: sampleDetail,
          error: null,
        };
      case "salary_advance_create_request":
      case "salary_advance_post_message":
      case "salary_advance_transition_request":
      case "salary_advance_review_evidence":
        return {
          data: { ...sampleDetail, replayed: false },
          error: null,
        };
      default:
        return { data: null, error: { message: "UNEXPECTED_RPC" } };
    }
  });

  const deps = {
    resolveSession: makeActorSession(),
    repository,
  };

  const ctxRes = await handleGetSalaryAdvanceContext(
    new Request(`${ORIGIN}/api/salary-advance/context`),
    "true",
    deps,
  );
  assert.equal(ctxRes.status, 200);
  const ctxBody = await ctxRes.json();
  assert.equal(ctxBody.ok, true);
  assert.equal(ctxBody.data.is_project_manager, true);

  const workersRes = await handleGetSalaryAdvanceProjectWorkers(
    new Request(`${ORIGIN}/api/salary-advance/projects/PRJ_NORTH/workers`),
    "PRJ_NORTH",
    "true",
    deps,
  );
  assert.equal(workersRes.status, 200);

  const listRes = await handleGetSalaryAdvanceRequests(
    new Request(`${ORIGIN}/api/salary-advance/requests?queue=PM`),
    "true",
    deps,
  );
  assert.equal(listRes.status, 200);

  const createRes = await handlePostCreateSalaryAdvanceRequest(
    new Request(`${ORIGIN}/api/salary-advance/requests`, {
      method: "POST",
      headers: { ...SAME_ORIGIN_POST_HEADERS, "idempotency-key": IDEM_1 },
      body: JSON.stringify({
        project_id: "PRJ_NORTH",
        worker_entry_id: WORKER_ID,
        requested_amount_vnd: "15000000",
        payment_method: "CASH",
        initial_content: "Ứng lương đợt 1",
      }),
    }),
    "true",
    deps,
  );
  assert.equal(createRes.status, 201);

  const detailRes = await handleGetSalaryAdvanceRequestDetail(
    new Request(`${ORIGIN}/api/salary-advance/requests/${REQ_ID}`),
    REQ_ID,
    "true",
    deps,
  );
  assert.equal(detailRes.status, 200);

  const msgRes = await handlePostSalaryAdvanceMessage(
    new Request(`${ORIGIN}/api/salary-advance/requests/${REQ_ID}/messages`, {
      method: "POST",
      headers: { ...SAME_ORIGIN_POST_HEADERS, "idempotency-key": IDEM_1 },
      body: JSON.stringify({
        expected_version: 1,
        message_text: "Gửi thêm thông tin",
      }),
    }),
    REQ_ID,
    "true",
    deps,
  );
  assert.equal(msgRes.status, 201);

  const actionRes = await handlePostSalaryAdvanceAction(
    new Request(`${ORIGIN}/api/salary-advance/requests/${REQ_ID}/actions`, {
      method: "POST",
      headers: { ...SAME_ORIGIN_POST_HEADERS, "idempotency-key": IDEM_1 },
      body: JSON.stringify({
        action: "APPROVE",
        expected_version: 1,
      }),
    }),
    REQ_ID,
    "true",
    deps,
  );
  assert.equal(actionRes.status, 200);

  const reviewRes = await handlePostReviewSalaryAdvanceEvidence(
    new Request(
      `${ORIGIN}/api/salary-advance/requests/${REQ_ID}/evidence/review`,
      {
        method: "POST",
        headers: { ...SAME_ORIGIN_POST_HEADERS, "idempotency-key": IDEM_1 },
        body: JSON.stringify({
          expected_version: 3,
          evidence_version: 1,
          decision: "REVIEWED",
          expected_worker_portrait_document_id: PORTRAIT_DOC_ID,
          expected_worker_portrait_version: 1,
        }),
      },
    ),
    REQ_ID,
    "true",
    deps,
  );
  assert.equal(reviewRes.status, 200);
});

test("evidence reserve/finalize race safety cleans ONLY losing attempt's staged object and NEVER deletes committed final evidence", async () => {
  const storage = createFakeEvidenceStorage();
  const storageKey1 = buildSalaryAdvanceEvidenceStorageKey(REQ_ID, UPLOAD_1_ID);
  const storageKey2 = buildSalaryAdvanceEvidenceStorageKey(REQ_ID, UPLOAD_2_ID);

  const bytes1 = makeValidJpegBytes("evidence-attempt-1");
  const bytes2 = makeValidJpegBytes("evidence-attempt-2-winner");
  const sha2 = sha256Hex(bytes2);

  // Both attempts upload to their respective R2 staging keys
  storage.stagedObjects.set(storageKey1, bytes1);
  storage.stagedObjects.set(storageKey2, bytes2);

  // Attempt 2 already promoted and committed to final/ as evidence_version = 1
  storage.finalObjects.set(storageKey2, bytes2);

  let reserveCallCount = 0;
  const repository = createSalaryAdvanceRepository(async (fn, args) => {
    if (fn === "salary_advance_reserve_evidence") {
      reserveCallCount += 1;
      return {
        data: {
          request_id: REQ_ID,
          upload_id: UPLOAD_2_ID,
          expected_version: 2,
          storage_key: storageKey2,
          mime_type: "image/jpeg",
          size_bytes: bytes2.byteLength,
          checksum_sha256: sha2,
          expires_at: "2026-10-29T10:15:00.000Z",
          superseded_storage_key: reserveCallCount === 1 ? storageKey1 : null,
          replayed: false,
        },
        error: null,
      };
    }

    if (fn === "salary_advance_get_evidence_finalize_context") {
      // Attempt 1 arrives late after Attempt 2 already committed (version advanced from 2 to 3)
      if (args.p_upload_id === UPLOAD_1_ID) {
        return {
          data: null,
          error: {
            code: "PT409",
            message: "SALARY_ADVANCE_VERSION_CONFLICT",
          },
        };
      }
      return {
        data: {
          status: "READY_TO_FINALIZE",
          request_id: REQ_ID,
          upload_id: UPLOAD_2_ID,
          expected_version: 2,
          storage_key: storageKey2,
          mime_type: "image/jpeg",
          size_bytes: bytes2.byteLength,
          checksum_sha256: sha2,
        },
        error: null,
      };
    }

    if (fn === "salary_advance_finalize_evidence") {
      return {
        data: {
          ...makeSampleDetail({
            request_state: "APPROVED",
            evidence_review_state: "PENDING_REVIEW",
            version: 3,
          }),
          replayed: false,
        },
        error: null,
      };
    }

    return { data: null, error: { message: "UNEXPECTED_RPC" } };
  });

  const deps = {
    resolveSession: makeActorSession(),
    repository,
    storage,
  };

  // Reserve call returns upload descriptor WITHOUT exposing storage_key or superseded_storage_key
  const reserveRes = await handlePostReserveSalaryAdvanceEvidence(
    new Request(
      `${ORIGIN}/api/salary-advance/requests/${REQ_ID}/evidence/reserve`,
      {
        method: "POST",
        headers: { ...SAME_ORIGIN_POST_HEADERS, "idempotency-key": IDEM_1 },
        body: JSON.stringify({
          expected_version: 2,
          mime_type: "image/jpeg",
          size_bytes: bytes2.byteLength,
          checksum_sha256: sha2,
        }),
      },
    ),
    REQ_ID,
    "true",
    deps,
  );
  assert.equal(reserveRes.status, 201);
  const reservePayload = await reserveRes.json();
  assert.equal(reservePayload.ok, true);
  assert.equal("storage_key" in reservePayload.data, false);
  assert.equal("superseded_storage_key" in reservePayload.data, false);

  // Re-populate staged object for Attempt 1 (simulating late PUT completion after Attempt 2 reserved)
  storage.stagedObjects.set(storageKey1, bytes1);

  // Late finalize from Attempt 1 -> 409 SALARY_ADVANCE_VERSION_CONFLICT
  const lateFinalizeRes = await handlePostFinalizeSalaryAdvanceEvidence(
    new Request(
      `${ORIGIN}/api/salary-advance/requests/${REQ_ID}/evidence/${UPLOAD_1_ID}/finalize`,
      {
        method: "POST",
        headers: { ...SAME_ORIGIN_POST_HEADERS, "idempotency-key": IDEM_2 },
        body: JSON.stringify({
          expected_version: 2,
        }),
      },
    ),
    REQ_ID,
    UPLOAD_1_ID,
    "true",
    deps,
  );
  assert.equal(lateFinalizeRes.status, 409);
  assert.equal(
    (await lateFinalizeRes.json()).code,
    "SALARY_ADVANCE_VERSION_CONFLICT",
  );

  // Attempt 1's staged object was cleaned up, while Attempt 2's committed final object is UNTOUCHED
  assert.equal(storage.stagedObjects.has(storageKey1), false);
  assert.equal(storage.finalObjects.has(storageKey2), true);
  assert.deepEqual(storage.finalObjects.get(storageKey2), bytes2);
});

test("evidence preview and worker portrait routes stream inline binary image with strict no-store headers and verify integrity", async () => {
  const storage = createFakeEvidenceStorage();
  const evidenceKey = buildSalaryAdvanceEvidenceStorageKey(REQ_ID, UPLOAD_2_ID);
  const portraitKey = `p1.6/${WORKER_ID}/WORKER_PORTRAIT/1/${PORTRAIT_DOC_ID}`;

  const evidenceBytes = makeValidJpegBytes("evidence-v1");
  const portraitBytes = makeValidJpegBytes("worker-portrait-v1");

  storage.finalObjects.set(evidenceKey, evidenceBytes);
  storage.portraitObjects.set(portraitKey, portraitBytes);

  const repository = createSalaryAdvanceRepository(async (fn) => {
    if (fn === "salary_advance_get_evidence_preview_context") {
      return {
        data: {
          request_id: REQ_ID,
          evidence_version: 1,
          storage_key: evidenceKey,
          mime_type: "image/jpeg",
          size_bytes: evidenceBytes.byteLength,
          checksum_sha256: sha256Hex(evidenceBytes),
        },
        error: null,
      };
    }
    if (fn === "salary_advance_get_worker_portrait_context") {
      return {
        data: {
          request_id: REQ_ID,
          worker_entry_id: WORKER_ID,
          document_id: PORTRAIT_DOC_ID,
          version: 1,
          storage_key: portraitKey,
          mime_type: "image/jpeg",
          size_bytes: portraitBytes.byteLength,
          checksum_sha256: sha256Hex(portraitBytes),
        },
        error: null,
      };
    }
    return { data: null, error: { message: "UNEXPECTED_RPC" } };
  });

  const deps = {
    resolveSession: makeActorSession(ACCT_USER_ID),
    repository,
    storage,
  };

  const evPreviewRes = await handleGetPreviewSalaryAdvanceEvidence(
    new Request(
      `${ORIGIN}/api/salary-advance/requests/${REQ_ID}/evidence/1/preview`,
    ),
    REQ_ID,
    "1",
    "true",
    deps,
  );
  assert.equal(evPreviewRes.status, 200);
  assert.equal(evPreviewRes.headers.get("Content-Type"), "image/jpeg");
  assert.equal(evPreviewRes.headers.get("Cache-Control"), "private, no-store");
  assert.equal(evPreviewRes.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(
    evPreviewRes.headers.get("Content-Security-Policy"),
    "default-src 'none'; sandbox",
  );
  assert.equal(evPreviewRes.headers.get("Referrer-Policy"), "no-referrer");
  assert.deepEqual(
    new Uint8Array(await evPreviewRes.arrayBuffer()),
    evidenceBytes,
  );

  const portraitRes = await handleGetSalaryAdvanceWorkerPortrait(
    new Request(
      `${ORIGIN}/api/salary-advance/requests/${REQ_ID}/worker-portrait?expected_document_id=${PORTRAIT_DOC_ID}`,
    ),
    REQ_ID,
    "true",
    deps,
  );
  assert.equal(portraitRes.status, 200);
  assert.equal(portraitRes.headers.get("Content-Type"), "image/jpeg");
  assert.equal(portraitRes.headers.get("Cache-Control"), "private, no-store");
  assert.equal(portraitRes.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(
    portraitRes.headers.get("Content-Security-Policy"),
    "default-src 'none'; sandbox",
  );
  assert.deepEqual(
    new Uint8Array(await portraitRes.arrayBuffer()),
    portraitBytes,
  );

  // Corrupt the portrait bytes in storage -> must fail closed with 503
  storage.portraitObjects.set(portraitKey, new Uint8Array([0x00, 0x01, 0x02]));
  const corruptedRes = await handleGetSalaryAdvanceWorkerPortrait(
    new Request(
      `${ORIGIN}/api/salary-advance/requests/${REQ_ID}/worker-portrait`,
    ),
    REQ_ID,
    "true",
    deps,
  );
  assert.equal(corruptedRes.status, 503);
});

test("all Next.js salary-advance API route files enforce nodejs runtime, force-dynamic, and feature gate", async () => {
  const routeRelativePaths = [
    "src/app/api/salary-advance/context/route.ts",
    "src/app/api/salary-advance/projects/[projectId]/workers/route.ts",
    "src/app/api/salary-advance/requests/route.ts",
    "src/app/api/salary-advance/requests/export/route.ts",
    "src/app/api/salary-advance/requests/[requestId]/route.ts",
    "src/app/api/salary-advance/requests/[requestId]/messages/route.ts",
    "src/app/api/salary-advance/requests/[requestId]/actions/route.ts",
    "src/app/api/salary-advance/requests/[requestId]/evidence/reserve/route.ts",
    "src/app/api/salary-advance/requests/[requestId]/evidence/[evidenceRef]/finalize/route.ts",
    "src/app/api/salary-advance/requests/[requestId]/evidence/review/route.ts",
    "src/app/api/salary-advance/requests/[requestId]/evidence/[evidenceRef]/preview/route.ts",
    "src/app/api/salary-advance/requests/[requestId]/worker-portrait/route.ts",
    "src/app/api/salary-advance/requests/[requestId]/worker-history/route.ts",
  ];

  for (const rel of routeRelativePaths) {
    const content = await readFile(path.resolve(process.cwd(), rel), "utf8");
    assert.match(content, /import "server-only";/, `${rel} missing server-only`);
    assert.match(
      content,
      /export const runtime = "nodejs";/,
      `${rel} missing nodejs runtime`,
    );
    assert.match(
      content,
      /export const dynamic = "force-dynamic";/,
      `${rel} missing force-dynamic`,
    );
    assert.match(
      content,
      /process\.env\.DIRECT_ENTRY_API_ENABLED !== "true"/,
      `${rel} missing feature gate check`,
    );
  }

  const finalizeRoute = await readFile(
    path.resolve(
      process.cwd(),
      "src/app/api/salary-advance/requests/[requestId]/evidence/[evidenceRef]/finalize/route.ts",
    ),
    "utf8",
  );
  assert.match(finalizeRoute, /evidenceRef: uploadId/);

  const previewRoute = await readFile(
    path.resolve(
      process.cwd(),
      "src/app/api/salary-advance/requests/[requestId]/evidence/[evidenceRef]/preview/route.ts",
    ),
    "utf8",
  );
  assert.match(previewRoute, /evidenceRef: version/);
});

test("BANK_TRANSFER creation, BANK_TRANSFER_RECEIPT review without portrait lock, and worker/bank eligibility 409 error mapping", async () => {
  let lastRpcArgs = null;
  let simulatedRpcErrorCode = null;
  const repository = createSalaryAdvanceRepository(async (fn, args) => {
    lastRpcArgs = { fn, args };
    if (simulatedRpcErrorCode) {
      return {
        data: null,
        error: {
          code: "PT409",
          message: simulatedRpcErrorCode,
        },
      };
    }
    if (fn === "salary_advance_create_request") {
      return {
        data: {
          ...makeSampleDetail({
            payment_method: args.p_payment_method,
            payment_destination_snapshot: {
              bank_id: "VCB",
              institution_name: "Vietcombank",
              account_number: "0123456789",
              account_number_masked: "******6789",
              account_holder_name: "NGUYEN VAN CONG NHAN",
            },
          }),
          replayed: false,
        },
        error: null,
      };
    }
    if (fn === "salary_advance_review_evidence") {
      return {
        data: {
          ...makeSampleDetail({
            payment_method: "BANK_TRANSFER",
            evidence_review_state: "REVIEWED",
            version: 4,
          }),
          replayed: false,
        },
        error: null,
      };
    }
    return { data: null, error: { message: "UNEXPECTED_RPC" } };
  });

  const deps = {
    resolveSession: makeActorSession(),
    repository,
  };

  const bankCreateRes = await handlePostCreateSalaryAdvanceRequest(
    new Request(`${ORIGIN}/api/salary-advance/requests`, {
      method: "POST",
      headers: { ...SAME_ORIGIN_POST_HEADERS, "idempotency-key": IDEM_1 },
      body: JSON.stringify({
        project_id: "PRJ_NORTH",
        worker_entry_id: WORKER_ID,
        requested_amount_vnd: "3500000",
        payment_method: "BANK_TRANSFER",
        initial_content: "Ứng lương chuyển khoản chính chủ",
      }),
    }),
    "true",
    deps,
  );
  assert.equal(bankCreateRes.status, 201);
  assert.equal(lastRpcArgs?.fn, "salary_advance_create_request");
  assert.equal(lastRpcArgs?.args?.p_payment_method, "BANK_TRANSFER");

  const bankReviewRes = await handlePostReviewSalaryAdvanceEvidence(
    new Request(
      `${ORIGIN}/api/salary-advance/requests/${REQ_ID}/evidence/review`,
      {
        method: "POST",
        headers: { ...SAME_ORIGIN_POST_HEADERS, "idempotency-key": IDEM_1 },
        body: JSON.stringify({
          expected_version: 3,
          evidence_version: 1,
          evidence_kind: "BANK_TRANSFER_RECEIPT",
          decision: "REVIEWED",
          note: "Đã đối chiếu bill chuyển khoản hợp lệ",
        }),
      },
    ),
    REQ_ID,
    "true",
    deps,
  );
  assert.equal(bankReviewRes.status, 200);
  assert.equal(lastRpcArgs?.fn, "salary_advance_review_evidence");
  assert.equal(lastRpcArgs?.args?.p_expected_worker_portrait_document_id, null);
  assert.equal(lastRpcArgs?.args?.p_expected_worker_portrait_version, null);

  for (const errorCode of [
    "SALARY_ADVANCE_WORKER_INELIGIBLE_STATUS",
    "SALARY_ADVANCE_WORKER_VENDOR_RECRUITED",
    "SALARY_ADVANCE_WORKER_MULTI_PROJECT_ON",
    "SALARY_ADVANCE_WORKER_DUPLICATE_CCCD",
    "SALARY_ADVANCE_BANK_ACCOUNT_MISSING",
    "SALARY_ADVANCE_BANK_ACCOUNT_NOT_SELF_OWNED",
  ]) {
    simulatedRpcErrorCode = errorCode;
    const errRes = await handlePostCreateSalaryAdvanceRequest(
      new Request(`${ORIGIN}/api/salary-advance/requests`, {
        method: "POST",
        headers: { ...SAME_ORIGIN_POST_HEADERS, "idempotency-key": IDEM_1 },
        body: JSON.stringify({
          project_id: "PRJ_NORTH",
          worker_entry_id: WORKER_ID,
          requested_amount_vnd: "2000000",
          payment_method: "BANK_TRANSFER",
          initial_content: "Kiểm tra chặn",
        }),
      }),
      "true",
      deps,
    );
    assert.equal(errRes.status, 409);
    const errPayload = await errRes.json();
    assert.equal(errPayload.ok, false);
    assert.equal(errPayload.code, errorCode);
  }
});

test("handleGetSalaryAdvanceProjectWorkers excludes OFF workers while keeping ON and UNCONFIRMED workers (including fixable-ineligible ones) and refilling pagination", async () => {
  const workerCalls = [];
  const repository = createSalaryAdvanceRepository(async (fn, args) => {
    if (fn === "salary_advance_list_project_workers") {
      workerCalls.push(args);
      if (!args.p_cursor) {
        return {
          data: {
            project_id: "PRJ_NORTH",
            workers: [
              {
                worker_entry_id: "40000000-0000-4000-8000-000000000010",
                employee_code: "NV010",
                display_name: "Lê Đã Nghỉ",
                position_label: "Công nhân",
                employment_status: "OFF",
                has_worker_portrait: true,
                worker_portrait_document_id: PORTRAIT_DOC_ID,
                worker_portrait_version: 1,
                bank_account: null,
                is_eligible_for_request: false,
                is_eligible_for_cash: false,
                is_eligible_for_bank_transfer: false,
                ineligible_reasons: ["WORKER_STATUS_OFF"],
              },
              {
                worker_entry_id: "40000000-0000-4000-8000-000000000011",
                employee_code: "NV011",
                display_name: "Phạm Chưa Xác Nhận",
                position_label: "Công nhân",
                employment_status: "UNCONFIRMED",
                has_worker_portrait: true,
                worker_portrait_document_id: PORTRAIT_DOC_ID,
                worker_portrait_version: 1,
                bank_account: null,
                is_eligible_for_request: false,
                is_eligible_for_cash: false,
                is_eligible_for_bank_transfer: false,
                ineligible_reasons: ["WORKER_STATUS_UNCONFIRMED"],
              },
            ],
            next_cursor: "NV011|40000000-0000-4000-8000-000000000011",
            has_more: true,
          },
          error: null,
        };
      }
      return {
        data: {
          project_id: "PRJ_NORTH",
          workers: [
            {
              worker_entry_id: "40000000-0000-4000-8000-000000000012",
              employee_code: "NV012",
              display_name: "Hoàng Thiếu Ảnh",
              position_label: "Tổ trưởng",
              employment_status: "ON",
              has_worker_portrait: false,
              worker_portrait_document_id: null,
              worker_portrait_version: null,
              bank_account: {
                bank_id: "VCB",
                institution_name: "Vietcombank",
                account_number: "0123456789",
                account_number_masked: "******6789",
                account_holder_name: "NGUYEN KHAC TEN",
                is_self_owned: false,
              },
              is_eligible_for_request: true,
              is_eligible_for_cash: false,
              is_eligible_for_bank_transfer: false,
              ineligible_reasons: [
                "MISSING_WORKER_PORTRAIT",
                "BANK_ACCOUNT_NOT_SELF_OWNED",
              ],
            },
          ],
          next_cursor: null,
          has_more: false,
        },
        error: null,
      };
    }
    return { data: null, error: { message: "UNEXPECTED_RPC" } };
  });

  const res = await handleGetSalaryAdvanceProjectWorkers(
    new Request(`${ORIGIN}/api/salary-advance/projects/PRJ_NORTH/workers?page_size=2`),
    "PRJ_NORTH",
    "true",
    {
      resolveSession: makeActorSession(PM_USER_ID),
      repository,
    },
  );
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.ok, true);
  assert.equal(workerCalls.length, 2);
  assert.deepEqual(
    payload.data.workers.map((w) => ({
      code: w.employee_code,
      status: w.employment_status,
      reasons: w.ineligible_reasons,
    })),
    [
      {
        code: "NV011",
        status: "UNCONFIRMED",
        reasons: ["WORKER_STATUS_UNCONFIRMED"],
      },
      {
        code: "NV012",
        status: "ON",
        reasons: ["MISSING_WORKER_PORTRAIT", "BANK_ACCOUNT_NOT_SELF_OWNED"],
      },
    ],
  );
  assert.equal(payload.data.has_more, false);
});

test("handleGetExportSalaryAdvanceRequests paginates all matching ACCOUNTANT rows into .xlsx without sensitive fields and fails closed on limits/incomplete pagination", async () => {
  const listCalls = [];
  const makeExportListItem = (seq, overrides = {}) => ({
    request_id: `30000000-0000-4000-8000-00000000000${seq}`,
    project_id: "PRJ_NORTH",
    project_display_name: "Dự án Bắc",
    worker_entry_id: `40000000-0000-4000-8000-00000000000${seq}`,
    worker_employee_code: `NV00${seq}`,
    worker_display_name: `Nguyễn Văn ${seq}`,
    has_worker_portrait: true,
    worker_portrait_document_id: PORTRAIT_DOC_ID,
    worker_portrait_version: 1,
    requested_amount_vnd: `${seq}500000`,
    payment_method: seq === 1 ? "BANK_TRANSFER" : "CASH",
    payment_destination_snapshot:
      seq === 1
        ? {
            bank_id: "VCB",
            institution_name: "Vietcombank",
            account_number: "0123456789",
            account_number_masked: "******6789",
            account_holder_name: "NGUYEN VAN 1",
          }
        : null,
    worker_eligibility_warning: null,
    initial_content: `Ứng lương đợt ${seq}`,
    request_state: "APPROVED",
    evidence_review_state: "REVIEWED",
    current_evidence_version: 1,
    version: 3,
    created_by_user_id: PM_USER_ID,
    created_by_display_name: "Phạm Quản Lý",
    current_project_accountant_user_id: ACCT_USER_ID,
    current_project_accountant_display_name: "Lê Kế Toán",
    decided_at: "2026-10-29T10:30:00Z",
    handled_externally_at: null,
    withdrawn_at: null,
    last_activity_at: `2026-10-29T11:0${seq}:00Z`,
    created_at: `2026-10-29T09:0${seq}:00Z`,
    updated_at: `2026-10-29T11:0${seq}:00Z`,
    ...overrides,
  });

  const repository = createSalaryAdvanceRepository(async (fn, args) => {
    if (fn === "salary_advance_list_requests") {
      listCalls.push(args);
      if (!args.p_cursor) {
        return {
          data: {
            queue: "ACCOUNTANT",
            requests: [makeExportListItem(1)],
            next_cursor: "2026-10-29T11:01:00Z|30000000-0000-4000-8000-000000000001",
            has_more: true,
          },
          error: null,
        };
      }
      return {
        data: {
          queue: "ACCOUNTANT",
          requests: [makeExportListItem(2)],
          next_cursor: null,
          has_more: false,
        },
        error: null,
      };
    }
    return { data: null, error: { message: "UNEXPECTED_RPC" } };
  });

  const exportRes = await handleGetExportSalaryAdvanceRequests(
    new Request(
      `${ORIGIN}/api/salary-advance/requests/export?project_id=PRJ_NORTH&request_state=APPROVED&evidence_review_state=REVIEWED&search=NV00`,
    ),
    "true",
    {
      resolveSession: makeActorSession(ACCT_USER_ID),
      repository,
      now: () => new Date("2026-10-30T08:00:00Z"),
    },
  );
  assert.equal(exportRes.status, 200);
  assert.equal(
    exportRes.headers.get("Content-Type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.match(
    exportRes.headers.get("Content-Disposition") ?? "",
    /attachment; filename="ung-luong-doi-soat-[0-9]{4}-[0-9]{2}-[0-9]{2}\.xlsx"/,
  );
  assert.equal(listCalls.length, 2);
  assert.equal(listCalls[0].p_queue, "ACCOUNTANT");
  assert.equal(listCalls[0].p_project_id, "PRJ_NORTH");
  assert.equal(listCalls[0].p_request_state, "APPROVED");
  assert.equal(listCalls[0].p_evidence_review_state, "REVIEWED");
  assert.equal(listCalls[0].p_search, "NV00");

  // Parse the returned .xlsx workbook and verify both pages were included and no UUID/storage_key/CCCD columns exist
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await exportRes.arrayBuffer()));
  const worksheet = workbook.getWorksheet("Đối soát ứng lương");
  assert.ok(worksheet, "Expected worksheet 'Đối soát ứng lương'");
  assert.equal(worksheet.rowCount, 3); // 1 header + 2 data rows

  const headers = worksheet.getRow(1).values.slice(1);
  assert.equal(headers.includes("CCCD"), false);
  assert.equal(headers.includes("storage_key"), false);
  assert.equal(headers.includes("request_id"), false);

  const row1Values = worksheet.getRow(2).values.slice(1);
  const row2Values = worksheet.getRow(3).values.slice(1);
  assert.equal(row1Values.includes("NV001"), true);
  assert.equal(row1Values.includes("Chuyển khoản ngân hàng"), true);
  assert.equal(row1Values.includes("0123456789"), true);
  assert.equal(row2Values.includes("NV002"), true);
  assert.equal(row2Values.includes("Nhận tiền mặt"), true);

  // Exceeding maxExportRows must fail closed with 422 SALARY_ADVANCE_EXPORT_LIMIT_EXCEEDED
  const limitRes = await handleGetExportSalaryAdvanceRequests(
    new Request(`${ORIGIN}/api/salary-advance/requests/export`),
    "true",
    {
      resolveSession: makeActorSession(ACCT_USER_ID),
      repository,
    },
    { maxExportRows: 1 },
  );
  assert.equal(limitRes.status, 422);
  assert.equal(
    (await limitRes.json()).code,
    "SALARY_ADVANCE_EXPORT_LIMIT_EXCEEDED",
  );

  // Missing next_cursor when has_more=true must fail closed with 503 SALARY_ADVANCE_EXPORT_INCOMPLETE
  const brokenPaginationRepo = createSalaryAdvanceRepository(async () => ({
    data: {
      queue: "ACCOUNTANT",
      requests: [makeExportListItem(1)],
      next_cursor: null,
      has_more: true,
    },
    error: null,
  }));
  const incompleteRes = await handleGetExportSalaryAdvanceRequests(
    new Request(`${ORIGIN}/api/salary-advance/requests/export`),
    "true",
    {
      resolveSession: makeActorSession(ACCT_USER_ID),
      repository: brokenPaginationRepo,
    },
  );
  assert.equal(incompleteRes.status, 503);
  assert.equal(
    (await incompleteRes.json()).code,
    "SALARY_ADVANCE_EXPORT_INCOMPLETE",
  );

  // Unauthorized actor (e.g., not a project accountant) fails closed with 403 SALARY_ADVANCE_ACCESS_DENIED
  const deniedRepo = createSalaryAdvanceRepository(async () => ({
    data: null,
    error: { code: "PT403", message: "SALARY_ADVANCE_ACCESS_DENIED" },
  }));
  const deniedRes = await handleGetExportSalaryAdvanceRequests(
    new Request(`${ORIGIN}/api/salary-advance/requests/export`),
    "true",
    {
      resolveSession: makeActorSession(PM_USER_ID),
      repository: deniedRepo,
    },
  );
  assert.equal(deniedRes.status, 403);
  assert.equal(
    (await deniedRes.json()).code,
    "SALARY_ADVANCE_ACCESS_DENIED",
  );
});

test("handleGetSalaryAdvanceRequests and handleGetSalaryAdvanceContext compute exact full-scope badge counts across >25 open requests independientemente of page_size=25 or active UI filters", async () => {
  // Build 37 PM requests: 30 OPEN + 2 NEEDS_INFO (= 32 open in state machine) + 5 terminal (APPROVED/REJECTED/WITHDRAWN)
  const allPmRequests = Array.from({ length: 37 }, (_, i) => {
    const seq = i + 1;
    const state =
      seq <= 30
        ? "OPEN"
        : seq <= 32
          ? "NEEDS_INFO"
          : seq <= 35
            ? "APPROVED"
            : seq === 36
              ? "REJECTED"
              : "WITHDRAWN";
    return {
      ...makeSampleDetail().request,
      request_id: `30000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      project_id: seq % 2 === 0 ? "PRJ_NORTH" : "PRJ_SOUTH",
      worker_employee_code: `NV${String(seq).padStart(3, "0")}`,
      worker_display_name: `Công Nhân ${seq}`,
      request_state: state,
      evidence_review_state: "NOT_UPLOADED",
      allowed_actions: {
        ...makeSampleDetail().request.allowed_actions,
        can_withdraw: state === "OPEN" || state === "NEEDS_INFO",
        can_provide_info: state === "NEEDS_INFO",
      },
      last_activity_at: `2026-10-29T10:${String(60 - seq).padStart(2, "0")}:00Z`,
    };
  });

  // Build 29 Accountant requests: 27 actionable (20 OPEN + 7 APPROVED/PENDING_REVIEW) + 2 non-actionable
  const allAccountantRequests = Array.from({ length: 29 }, (_, i) => {
    const seq = i + 1;
    const isOpen = seq <= 20;
    const isPendingReview = seq > 20 && seq <= 27;
    return {
      ...makeSampleDetail().request,
      request_id: `80000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      project_id: "PRJ_NORTH",
      worker_employee_code: `KT${String(seq).padStart(3, "0")}`,
      worker_display_name: `NLĐ Kế Toán ${seq}`,
      request_state: isOpen ? "OPEN" : "APPROVED",
      evidence_review_state: isPendingReview ? "PENDING_REVIEW" : "REVIEWED",
      allowed_actions: {
        can_post_message: true,
        can_provide_info: false,
        can_withdraw: false,
        can_upload_evidence: false,
        can_request_info: isOpen,
        can_approve: isOpen,
        can_reject: isOpen,
        can_mark_handled_externally: !isOpen,
        can_review_evidence: isPendingReview,
      },
      last_activity_at: `2026-10-29T11:${String(60 - seq).padStart(2, "0")}:00Z`,
    };
  });

  const rpcCalls = [];
  const repository = createSalaryAdvanceRepository(async (fn, args) => {
    rpcCalls.push({ fn, args });
    if (fn === "salary_advance_get_actor_context") {
      return {
        data: {
          app_user_id: args.p_app_user_id,
          display_name: "QLDA Kiêm KT",
          is_project_manager: true,
          is_project_accountant: true,
          is_supervisory_viewer: false,
          is_full_admin: false,
          is_bod: false,
          managed_projects: [
            {
              project_id: "PRJ_NORTH",
              display_name: "Dự án Bắc",
              active: true,
              has_active_accountant: true,
              accountant_user_id: ACCT_USER_ID,
              accountant_display_name: "Kế toán A",
            },
            {
              project_id: "PRJ_SOUTH",
              display_name: "Dự án Nam",
              active: true,
              has_active_accountant: true,
              accountant_user_id: ACCT_USER_ID,
              accountant_display_name: "Kế toán A",
            },
          ],
          accountant_projects: [
            {
              project_id: "PRJ_NORTH",
              display_name: "Dự án Bắc",
              active: true,
            },
          ],
          supervisory_projects: [],
          authorization_date: "2026-10-29",
        },
        error: null,
      };
    }

    if (fn === "salary_advance_list_requests") {
      const source =
        args.p_queue === "PM" ? allPmRequests : allAccountantRequests;
      let filtered = source;
      if (args.p_project_id) {
        filtered = filtered.filter((r) => r.project_id === args.p_project_id);
      }
      if (args.p_request_state) {
        filtered = filtered.filter(
          (r) => r.request_state === args.p_request_state,
        );
      }
      if (args.p_evidence_review_state) {
        filtered = filtered.filter(
          (r) => r.evidence_review_state === args.p_evidence_review_state,
        );
      }
      if (args.p_search) {
        const q = args.p_search.toLowerCase();
        filtered = filtered.filter(
          (r) =>
            r.worker_employee_code.toLowerCase().includes(q) ||
            r.worker_display_name.toLowerCase().includes(q),
        );
      }

      let startIdx = 0;
      if (args.p_cursor) {
        const cursorId = String(args.p_cursor).split("|")[1];
        const foundIdx = filtered.findIndex((r) => r.request_id === cursorId);
        startIdx = foundIdx >= 0 ? foundIdx + 1 : filtered.length;
      }

      const pageSize = args.p_page_size ?? 25;
      const slice = filtered.slice(startIdx, startIdx + pageSize);
      const hasMore = startIdx + pageSize < filtered.length;
      const lastItem = slice[slice.length - 1];
      const nextCursor =
        hasMore && lastItem
          ? `${lastItem.last_activity_at}|${lastItem.request_id}`
          : null;

      return {
        data: {
          requests: slice,
          has_more: hasMore,
          next_cursor: nextCursor,
        },
        error: null,
      };
    }

    return { data: null, error: { message: "UNEXPECTED_RPC" } };
  });

  const deps = {
    resolveSession: makeActorSession(PM_USER_ID),
    repository,
  };

  // 1. Context endpoint returns full-scope badge_counts for both PM (32) and Accountant (27)
  const ctxRes = await handleGetSalaryAdvanceContext(
    new Request(`${ORIGIN}/api/salary-advance/context`),
    "true",
    deps,
  );
  assert.equal(ctxRes.status, 200);
  const ctxPayload = await ctxRes.json();
  assert.deepEqual(ctxPayload.data.badge_counts, {
    pm: 32,
    accountant: 27,
  });

  // 2. Unfiltered PM page 1 (page_size=25) returns 25 rows with has_more=true AND badge_count=32 (>25 open requests)
  const pmPage1Res = await handleGetSalaryAdvanceRequests(
    new Request(`${ORIGIN}/api/salary-advance/requests?queue=PM&page_size=25`),
    "true",
    deps,
  );
  assert.equal(pmPage1Res.status, 200);
  const pmPage1Payload = await pmPage1Res.json();
  assert.equal(pmPage1Payload.data.requests.length, 25);
  assert.equal(pmPage1Payload.data.has_more, true);
  assert.equal(
    pmPage1Payload.data.badge_count,
    32,
    "PM badge_count must equal all 32 open requests across pages, not 25 from page 1",
  );

  // 3. Normal filtered PM query or cursor load-more query does NOT re-scan the queue for badges (0 extra badge RPCs)
  rpcCalls.length = 0;
  const pmFilteredNoBadgeScanRes = await handleGetSalaryAdvanceRequests(
    new Request(
      `${ORIGIN}/api/salary-advance/requests?queue=PM&project_id=PRJ_NORTH&request_state=APPROVED&page_size=25`,
    ),
    "true",
    deps,
  );
  assert.equal(pmFilteredNoBadgeScanRes.status, 200);
  const pmFilteredNoBadgeScanPayload = await pmFilteredNoBadgeScanRes.json();
  assert.ok(pmFilteredNoBadgeScanPayload.data.requests.length < 5);
  assert.equal(
    rpcCalls.length,
    1,
    "Filtered list request without include_badge=1 must execute only 1 RPC call and never re-scan the unfiltered queue",
  );
  assert.equal(pmFilteredNoBadgeScanPayload.data.badge_count, undefined);

  rpcCalls.length = 0;
  const pmCursorLoadMoreRes = await handleGetSalaryAdvanceRequests(
    new Request(
      `${ORIGIN}/api/salary-advance/requests?queue=PM&cursor=${encodeURIComponent(pmPage1Payload.data.next_cursor)}&page_size=25`,
    ),
    "true",
    deps,
  );
  assert.equal(pmCursorLoadMoreRes.status, 200);
  assert.equal(
    rpcCalls.length,
    1,
    "Load-more cursor pagination must execute only 1 RPC call and never re-scan the queue for badges",
  );

  // 4. Explicit badge refresh (include_badge=1) while filtered queries only active state slices and returns full badge_count
  rpcCalls.length = 0;
  const pmFilteredWithBadgeRes = await handleGetSalaryAdvanceRequests(
    new Request(
      `${ORIGIN}/api/salary-advance/requests?queue=PM&project_id=PRJ_NORTH&request_state=APPROVED&page_size=25&include_badge=1`,
    ),
    "true",
    deps,
  );
  assert.equal(pmFilteredWithBadgeRes.status, 200);
  const pmFilteredWithBadgePayload = await pmFilteredWithBadgeRes.json();
  assert.equal(
    pmFilteredWithBadgePayload.data.badge_count,
    32,
    "When include_badge=1 is requested on reload/refresh, PM badge_count returns all 32 open requests in scope",
  );
  // 1 filtered list RPC + 2 targeted slice RPCs (OPEN + NEEDS_INFO), never p_request_state=null unfiltered scan
  assert.equal(rpcCalls.length, 3);
  assert.deepEqual(
    rpcCalls.slice(1).map((c) => c.args.p_request_state).sort(),
    ["NEEDS_INFO", "OPEN"],
  );

  // 5. Accountant list with include_badge=1 and search filter returns full actionable badge_count=27 via targeted slices
  rpcCalls.length = 0;
  const acctFilteredRes = await handleGetSalaryAdvanceRequests(
    new Request(
      `${ORIGIN}/api/salary-advance/requests?queue=ACCOUNTANT&search=KT029&page_size=25&include_badge=1`,
    ),
    "true",
    deps,
  );
  assert.equal(acctFilteredRes.status, 200);
  const acctFilteredPayload = await acctFilteredRes.json();
  assert.equal(acctFilteredPayload.data.requests.length, 1);
  assert.equal(
    acctFilteredPayload.data.badge_count,
    27,
    "Accountant 'Cần xử lý' badge_count must remain 27 across pages when include_badge=1 is requested",
  );
  assert.equal(rpcCalls.length, 3);

  // 6. When active requests exceed maxPagesPerSlice, computeServerQueueBadgeCount returns a deterministic capped count instead of null
  const cappedResult = await computeServerQueueBadgeCount({
    repository,
    auth_subject: AUTH_SUBJECT,
    app_user_id: PM_USER_ID,
    queue: "PM",
    pageSize: 10,
    maxPagesPerSlice: 2,
  });
  assert.deepEqual(cappedResult, {
    count: 22, // 2 pages * 10 OPEN (= 20) + 2 NEEDS_INFO (= 2)
    capped: true,
  });
});

test("handleGetSalaryAdvanceProjectWorkers excludes Vendor-recruited workers and handleGetSalaryAdvanceWorkerHistory enforces feature gate, authority, query validation, and scoped history projection", async () => {
  const historyCalls = [];
  const repository = createSalaryAdvanceRepository(async (fn, args) => {
    if (fn === "salary_advance_list_project_workers") {
      return {
        data: {
          project_id: "PRJ_NORTH",
          workers: [
            {
              worker_entry_id: "40000000-0000-4000-8000-000000000020",
              employee_code: "NV020",
              display_name: "Công Nhân Vendor A",
              employment_status: "ON",
              provider_type: "vendor",
              is_eligible: false,
              ineligible_reasons: ["WORKER_VENDOR_RECRUITED"],
            },
            {
              worker_entry_id: "40000000-0000-4000-8000-000000000021",
              employee_code: "NV021",
              display_name: "Công Nhân Vendor B",
              employment_status: "ON",
              provider_type: "hrp",
              is_eligible: false,
              ineligible_reasons: ["WORKER_VENDOR_RECRUITED"],
            },
            {
              worker_entry_id: "40000000-0000-4000-8000-000000000022",
              employee_code: "NV022",
              display_name: "Công Nhân Nội Bộ HRP",
              employment_status: "ON",
              provider_type: "hrp",
              is_eligible: true,
              ineligible_reasons: [],
            },
          ],
          next_cursor: null,
          has_more: false,
        },
        error: null,
      };
    }

    if (fn === "salary_advance_list_worker_history") {
      historyCalls.push(args);
      if (args.p_app_user_id === PM_USER_ID) {
        return {
          data: null,
          error: {
            code: "PT403",
            message: "SALARY_ADVANCE_ACCESS_DENIED",
          },
        };
      }
      return {
        data: {
          request_id: args.p_request_id,
          worker_entry_id: WORKER_ID,
          worker_employee_code: "NV022",
          worker_display_name: "Công Nhân Nội Bộ HRP",
          period_mode: args.p_period_mode,
          month: args.p_month,
          from_date: "2026-10-01",
          to_date: "2026-10-30",
          qualifying_rule: "APPROVED_AND_EVIDENCE_REVIEWED",
          timezone: "Asia/Ho_Chi_Minh",
          total_count: 2,
          total_amount_vnd: "5500000",
          has_more: false,
          next_cursor: null,
          items: [
            {
              request_id: REQ_ID,
              project_id: "PRJ_NORTH",
              project_display_name: "Dự án Bắc",
              worker_entry_id: WORKER_ID,
              worker_employee_code: "NV022",
              worker_display_name: "Công Nhân Nội Bộ HRP",
              effective_date: "2026-10-28",
              effective_at: "2026-10-28T10:00:00Z",
              requested_amount_vnd: "3000000",
              payment_method: "BANK_TRANSFER",
              initial_content: "Ứng lương đợt 2",
              request_state: "APPROVED",
              evidence_review_state: "REVIEWED",
              created_by_display_name: "QLDA 01",
              decided_by_display_name: "Kế toán A",
              decided_at: "2026-10-28T09:00:00Z",
              evidence_reviewed_by_display_name: "Kế toán A",
              evidence_reviewed_at: "2026-10-28T10:00:00Z",
              created_at: "2026-10-28T08:00:00Z",
            },
          ],
        },
        error: null,
      };
    }

    return { data: null, error: { message: "UNEXPECTED_RPC" } };
  });

  // 1. Worker picker defense-in-depth hides both provider_type === "vendor" and WORKER_VENDOR_RECRUITED
  const workersRes = await handleGetSalaryAdvanceProjectWorkers(
    new Request(`${ORIGIN}/api/salary-advance/projects/PRJ_NORTH/workers`),
    "PRJ_NORTH",
    "true",
    {
      resolveSession: makeActorSession(PM_USER_ID),
      repository,
    },
  );
  assert.equal(workersRes.status, 200);
  const workersPayload = await workersRes.json();
  assert.deepEqual(
    workersPayload.data.workers.map((w) => w.employee_code),
    ["NV022"],
    "Vendor-recruited workers must never be returned by handleGetSalaryAdvanceProjectWorkers",
  );

  // 2. Worker history endpoint: feature gate disabled -> 404
  const disabledHistRes = await handleGetSalaryAdvanceWorkerHistory(
    new Request(`${ORIGIN}/api/salary-advance/requests/${REQ_ID}/worker-history`),
    REQ_ID,
    "false",
    {
      resolveSession: makeActorSession(ACCT_USER_ID),
      repository,
    },
  );
  assert.equal(disabledHistRes.status, 404);

  // 3. Worker history endpoint: invalid query -> 400
  const badQueryHistRes = await handleGetSalaryAdvanceWorkerHistory(
    new Request(
      `${ORIGIN}/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=CUSTOM_RANGE&from_date=2026-10-30&to_date=2026-10-01`,
    ),
    REQ_ID,
    "true",
    {
      resolveSession: makeActorSession(ACCT_USER_ID),
      repository,
    },
  );
  assert.equal(badQueryHistRes.status, 400);

  // 4. Worker history endpoint: PM without accountant/supervisory role -> 403 SALARY_ADVANCE_ACCESS_DENIED
  const deniedHistRes = await handleGetSalaryAdvanceWorkerHistory(
    new Request(`${ORIGIN}/api/salary-advance/requests/${REQ_ID}/worker-history`),
    REQ_ID,
    "true",
    {
      resolveSession: makeActorSession(PM_USER_ID),
      repository,
    },
  );
  assert.equal(deniedHistRes.status, 403);
  assert.equal(
    (await deniedHistRes.json()).code,
    "SALARY_ADVANCE_ACCESS_DENIED",
  );

  // 5. Worker history endpoint: assigned Project Accountant -> 200 with full period summary and items
  const okHistRes = await handleGetSalaryAdvanceWorkerHistory(
    new Request(
      `${ORIGIN}/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=MONTH&month=2026-10&page_size=10`,
    ),
    REQ_ID,
    "true",
    {
      resolveSession: makeActorSession(ACCT_USER_ID),
      repository,
    },
  );
  assert.equal(okHistRes.status, 200);
  const okHistPayload = await okHistRes.json();
  assert.equal(okHistPayload.ok, true);
  assert.equal(okHistPayload.data.total_count, 2);
  assert.equal(okHistPayload.data.total_amount_vnd, "5500000");
  assert.equal(okHistPayload.data.period_mode, "MONTH");
  assert.equal(okHistPayload.data.month, "2026-10");
  assert.equal(okHistPayload.data.items.length, 1);
  assert.equal(historyCalls[historyCalls.length - 1].p_period_mode, "MONTH");
  assert.equal(historyCalls[historyCalls.length - 1].p_month, "2026-10");
  assert.equal(historyCalls[historyCalls.length - 1].p_page_size, 10);
});
