import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SALARY_ADVANCE_MISSING_PORTRAIT_WARNING,
  SALARY_ADVANCE_NON_ACCOUNTING_NOTICE,
  buildEvidencePhotoPreviewUrl,
  buildSalaryAdvanceExportUrl,
  buildWorkerPortraitPreviewUrl,
  canAccessSalaryAdvanceContext,
  countActionableRequestsForTab,
  countOpenRequestsForPmTab,
  createLatestRequestTracker,
  decideSalaryAdvancePageAccess,
  describeWorkerBankTransferEligibility,
  describeWorkerEligibility,
  evaluateEvidenceComparisonPanel,
  evaluateRequestAttentionForTab,
  fetchSalaryAdvanceRequestListPage,
  filterSelectableProjectWorkers,
  formatFileSizeBytes,
  formatVndAmount,
  getEvidenceKindLabel,
  getEvidenceReviewStateMeta,
  getPaymentMethodMeta,
  getRequestStateMeta,
  getSalaryAdvanceActorRoleLabel,
  getSalaryAdvanceEventTone,
  getSalaryAdvanceEventTypeLabel,
  isProjectWorkerHiddenFromPicker,
  isRequestOpenInStateMachine,
  isSalaryAdvanceConflictError,
  newSalaryAdvanceIdempotencyKey,
  normalizePositiveVndInput,
  parseSalaryAdvanceRequestListPayload,
  reconcileSelectedRequestIdFromList,
  reconcileSelectedWorkerEntryId,
  resolveActiveRequestDetail,
  resolveAvailableRequestActions,
  resolveSalaryAdvanceActorDisplayName,
  resolveScopedMutationFailureOutcome,
  resolveVisibleSalaryAdvanceTabs,
  salaryAdvanceErrorMessage,
  sortEventsChronologically,
  updateTabBadgeCountsForTab,
  uploadSalaryAdvanceEvidence,
  validateCreateSalaryAdvanceDraft,
  validateEvidenceFilePreflight,
  validateEvidenceReviewInput,
  validateMessageInput,
  validateTransitionActionInput,
} from "./salary-advance-ui-model.ts";

function makeAllowedActions(overrides = {}) {
  return {
    can_post_message: false,
    can_provide_info: false,
    can_withdraw: false,
    can_upload_evidence: false,
    can_request_info: false,
    can_approve: false,
    can_reject: false,
    can_mark_handled_externally: false,
    can_review_evidence: false,
    ...overrides,
  };
}

function makeRequestSummary(overrides = {}) {
  return {
    request_id: "11111111-1111-4111-8111-111111111111",
    project_id: "22222222-2222-4222-8222-222222222222",
    project_display_name: "Dự án Luxshare Bắc Giang",
    worker_entry_id: "33333333-3333-4333-8333-333333333333",
    worker_employee_code: "NV001",
    worker_display_name: "Nguyễn Văn An",
    requested_amount_vnd: 2500000,
    initial_content: "Ứng lương đợt 1 sau 12 ngày công",
    request_state: "OPEN",
    evidence_review_state: "NOT_UPLOADED",
    version: 3,
    created_by_user_id: "44444444-4444-4444-8444-444444444444",
    created_by_display_name: "Trần QLDA",
    project_accountant_user_id: "55555555-5555-4555-8555-555555555555",
    project_accountant_display_name: "Lê Kế Toán",
    created_at: "2026-10-29T08:00:00.000Z",
    updated_at: "2026-10-29T08:30:00.000Z",
    last_activity_at: "2026-10-29T08:30:00.000Z",
    decided_by_user_id: null,
    decided_by_display_name: null,
    decided_at: null,
    decision_reason: null,
    withdrawn_by_user_id: null,
    withdrawn_by_display_name: null,
    withdrawn_at: null,
    handled_externally_by_user_id: null,
    handled_externally_by_display_name: null,
    handled_externally_at: null,
    handled_externally_note: null,
    latest_message_preview: "Ứng lương đợt 1 sau 12 ngày công",
    current_evidence: null,
    worker_portrait: {
      document_id: "66666666-6666-4666-8666-666666666666",
      version: 2,
      mime_type: "image/jpeg",
      size_bytes: 120000,
      updated_at: "2026-10-20T09:00:00.000Z",
    },
    allowed_actions: makeAllowedActions(),
    ...overrides,
  };
}

test("decideSalaryAdvancePageAccess enforces feature flag, session state, and access denied", () => {
  assert.equal(
    decideSalaryAdvancePageAccess({
      enabledFlag: undefined,
      actor: { ok: true, actor: { app_user_id: "u1", auth_subject: "s1", capabilities: [], scopes: [] } },
    }),
    "NOT_FOUND"
  );
  assert.equal(
    decideSalaryAdvancePageAccess({
      enabledFlag: "false",
      actor: { ok: true, actor: { app_user_id: "u1", auth_subject: "s1", capabilities: [], scopes: [] } },
    }),
    "NOT_FOUND"
  );
  assert.equal(
    decideSalaryAdvancePageAccess({
      enabledFlag: "true",
      actor: { ok: false, reason: "UNAUTHENTICATED" },
    }),
    "REDIRECT_LOGIN"
  );
  assert.equal(
    decideSalaryAdvancePageAccess({
      enabledFlag: "true",
      actor: { ok: false, reason: "ACTOR_DISABLED" },
    }),
    "ACCOUNT_UNAVAILABLE"
  );
  assert.equal(
    decideSalaryAdvancePageAccess({
      enabledFlag: "true",
      actor: null,
    }),
    "TEMPORARY_UNAVAILABLE"
  );
  assert.equal(
    decideSalaryAdvancePageAccess({
      enabledFlag: "true",
      actor: { ok: true, actor: { app_user_id: "u1", auth_subject: "s1", capabilities: [], scopes: [] } },
      contextErrorCode: "SALARY_ADVANCE_ACCESS_DENIED",
    }),
    "ACCESS_DENIED"
  );
  assert.equal(
    decideSalaryAdvancePageAccess({
      enabledFlag: "true",
      actor: { ok: true, actor: { app_user_id: "u1", auth_subject: "s1", capabilities: [], scopes: [] } },
    }),
    "ALLOW"
  );
});

test("resolveVisibleSalaryAdvanceTabs and canAccessSalaryAdvanceContext project PM, Accountant, and Supervisory tabs strictly from server context", () => {
  assert.equal(canAccessSalaryAdvanceContext(null), false);
  assert.equal(
    canAccessSalaryAdvanceContext({
      is_project_manager: false,
      is_project_accountant: false,
      is_supervisory_viewer: false,
    }),
    false
  );

  const pmOnlyTabs = resolveVisibleSalaryAdvanceTabs(
    {
      is_project_manager: true,
      is_project_accountant: false,
      is_supervisory_viewer: false,
    },
    { pm: 4 }
  );
  assert.equal(pmOnlyTabs.length, 1);
  assert.equal(pmOnlyTabs[0].id, "pm");
  assert.equal(pmOnlyTabs[0].label, "Yêu cầu tôi tạo");
  assert.equal(pmOnlyTabs[0].queue, "PM");
  assert.equal(pmOnlyTabs[0].badgeCount, 4);

  const accountantOnlyTabs = resolveVisibleSalaryAdvanceTabs(
    {
      is_project_manager: false,
      is_project_accountant: true,
      is_supervisory_viewer: false,
    },
    { accountant: 2 }
  );
  assert.equal(accountantOnlyTabs.length, 1);
  assert.equal(accountantOnlyTabs[0].id, "accountant");
  assert.equal(accountantOnlyTabs[0].label, "Cần xử lý");
  assert.equal(accountantOnlyTabs[0].queue, "ACCOUNTANT");
  assert.equal(accountantOnlyTabs[0].badgeCount, 2);

  const dualRoleAndSupervisory = resolveVisibleSalaryAdvanceTabs({
    is_project_manager: true,
    is_project_accountant: true,
    is_supervisory_viewer: true,
  });
  assert.deepEqual(
    dualRoleAndSupervisory.map((t) => t.id),
    ["pm", "accountant", "supervisory"]
  );
});

test("resolveAvailableRequestActions never enables actions outside server allowed_actions", () => {
  const none = resolveAvailableRequestActions(null);
  assert.equal(none.hasAnyMutation, false);
  assert.equal(none.canApprove, false);
  assert.equal(none.canWithdraw, false);
  assert.equal(none.canReviewEvidence, false);

  const pmActions = resolveAvailableRequestActions(
    makeAllowedActions({
      can_post_message: true,
      can_provide_info: true,
      can_withdraw: true,
    })
  );
  assert.equal(pmActions.canPostMessage, true);
  assert.equal(pmActions.canProvideInfo, true);
  assert.equal(pmActions.canWithdraw, true);
  assert.equal(pmActions.canApprove, false);
  assert.equal(pmActions.canReject, false);
  assert.equal(pmActions.hasAnyPmMutation, true);
  assert.equal(pmActions.hasAnyAccountantDecision, false);
  assert.equal(pmActions.hasAnyMutation, true);

  const accountantActions = resolveAvailableRequestActions(
    makeAllowedActions({
      can_approve: true,
      can_reject: true,
      can_request_info: true,
      can_mark_handled_externally: true,
    })
  );
  assert.equal(accountantActions.canApprove, true);
  assert.equal(accountantActions.canReject, true);
  assert.equal(accountantActions.canRequestInfo, true);
  assert.equal(accountantActions.canMarkHandledExternally, true);
  assert.equal(accountantActions.canWithdraw, false);
  assert.equal(accountantActions.hasAnyAccountantDecision, true);
});

test("evaluateRequestAttentionForTab and countActionableRequestsForTab count open non-terminal requests for PM badge and actionable items for Accountant badge", () => {
  const pmOpen = makeRequestSummary({
    request_state: "OPEN",
    allowed_actions: makeAllowedActions({ can_withdraw: true }),
  });
  const pmNeedsInfo = makeRequestSummary({
    request_state: "NEEDS_INFO",
    allowed_actions: makeAllowedActions({ can_provide_info: true }),
  });
  const pmRetake = makeRequestSummary({
    request_state: "APPROVED",
    evidence_review_state: "RETAKE_REQUIRED",
    allowed_actions: makeAllowedActions({ can_upload_evidence: true }),
  });
  const pmWaitingUpload = makeRequestSummary({
    request_state: "APPROVED",
    evidence_review_state: "NOT_UPLOADED",
    allowed_actions: makeAllowedActions({ can_upload_evidence: true }),
  });
  const pmClosed = makeRequestSummary({
    request_state: "REJECTED",
    allowed_actions: makeAllowedActions(),
  });
  const pmWithdrawn = makeRequestSummary({
    request_state: "WITHDRAWN",
    allowed_actions: makeAllowedActions(),
  });
  const pmHandledExternally = makeRequestSummary({
    request_state: "HANDLED_EXTERNALLY",
    allowed_actions: makeAllowedActions(),
  });

  // Row-level attention indicators for PM remain intact
  assert.equal(evaluateRequestAttentionForTab(pmNeedsInfo, "pm").needsAttention, true);
  assert.equal(evaluateRequestAttentionForTab(pmRetake, "pm").needsAttention, true);
  assert.equal(evaluateRequestAttentionForTab(pmWaitingUpload, "pm").needsAttention, true);
  assert.equal(evaluateRequestAttentionForTab(pmClosed, "pm").needsAttention, false);

  // State machine open check: OPEN and NEEDS_INFO are non-terminal; APPROVED, REJECTED, WITHDRAWN, HANDLED_EXTERNALLY are terminal
  assert.equal(isRequestOpenInStateMachine(pmOpen), true);
  assert.equal(isRequestOpenInStateMachine(pmNeedsInfo), true);
  assert.equal(isRequestOpenInStateMachine(pmRetake), false);
  assert.equal(isRequestOpenInStateMachine(pmWaitingUpload), false);
  assert.equal(isRequestOpenInStateMachine(pmClosed), false);
  assert.equal(isRequestOpenInStateMachine(pmWithdrawn), false);
  assert.equal(isRequestOpenInStateMachine(pmHandledExternally), false);

  // PM tab badge ("Yêu cầu tôi tạo") counts open non-terminal requests (OPEN + NEEDS_INFO) and excludes terminal states
  assert.equal(
    countOpenRequestsForPmTab([
      pmOpen,
      pmNeedsInfo,
      pmRetake,
      pmWaitingUpload,
      pmClosed,
      pmWithdrawn,
      pmHandledExternally,
    ]),
    2
  );
  assert.equal(
    countActionableRequestsForTab(
      [
        pmOpen,
        pmNeedsInfo,
        pmRetake,
        pmWaitingUpload,
        pmClosed,
        pmWithdrawn,
        pmHandledExternally,
      ],
      "pm"
    ),
    2
  );

  // Accountant tab badge ("Cần xử lý") continues to count actionable requests for the accountant
  const accOpen = makeRequestSummary({
    request_state: "OPEN",
    allowed_actions: makeAllowedActions({ can_approve: true, can_reject: true }),
  });
  const accPendingReview = makeRequestSummary({
    request_state: "APPROVED",
    evidence_review_state: "PENDING_REVIEW",
    allowed_actions: makeAllowedActions({ can_review_evidence: true }),
  });
  assert.equal(
    countActionableRequestsForTab([accOpen, accPendingReview, pmClosed], "accountant"),
    2
  );
});

test("evaluateEvidenceComparisonPanel builds private preview URLs, locks REVIEWED when worker portrait is missing, and preserves RETAKE_REQUIRED", () => {
  const currentEvidence = {
    evidence_version: 2,
    mime_type: "image/jpeg",
    size_bytes: 256000,
    checksum_sha256: "b".repeat(64),
    uploaded_by_user_id: "44444444-4444-4444-8444-444444444444",
    uploaded_by_display_name: "Trần QLDA",
    uploaded_at: "2026-10-29T09:00:00.000Z",
    reviewed_by_user_id: null,
    reviewed_by_display_name: null,
    reviewed_at: null,
    review_note: null,
    reviewed_worker_portrait_document_id: null,
    reviewed_worker_portrait_version: null,
  };

  const versionItem2 = {
    evidence_version: 2,
    event_id: "77777777-7777-4777-8777-777777777777",
    mime_type: "image/jpeg",
    size_bytes: 256000,
    checksum_sha256: "b".repeat(64),
    caption_note: "Đã nhận đủ 2.500.000đ tại văn phòng dự án",
    uploaded_by_user_id: "44444444-4444-4444-8444-444444444444",
    uploaded_by_display_name: "Trần QLDA",
    uploaded_at: "2026-10-29T09:00:00.000Z",
  };

  const versionItem1 = {
    ...versionItem2,
    event_id: "88888888-8888-4888-8888-888888888888",
    evidence_version: 1,
  };

  const detailWithPortrait = {
    request: makeRequestSummary({
      request_state: "APPROVED",
      evidence_review_state: "PENDING_REVIEW",
      current_evidence: currentEvidence,
      allowed_actions: makeAllowedActions({ can_review_evidence: true }),
    }),
    events: [],
    evidence_versions: [versionItem2, versionItem1],
  };

  const modelOk = evaluateEvidenceComparisonPanel(detailWithPortrait, 2);
  assert.equal(modelOk.hasWorkerPortrait, true);
  assert.equal(modelOk.missingPortraitWarning, null);
  assert.equal(modelOk.canConfirmReviewed, true);
  assert.equal(modelOk.canRequestRetake, true);
  assert.equal(modelOk.confirmReviewedLockReason, null);
  assert.equal(
    modelOk.workerPortrait?.previewUrl,
    buildWorkerPortraitPreviewUrl(
      detailWithPortrait.request.request_id,
      "66666666-6666-4666-8666-666666666666"
    )
  );
  assert.equal(
    modelOk.selectedEvidence?.previewUrl,
    buildEvidencePhotoPreviewUrl(detailWithPortrait.request.request_id, 2)
  );
  assert.equal(
    modelOk.selectedEvidence?.previewUrl.includes("?"),
    false,
    "evidence preview endpoint rejects query params via parseNoQueryParams"
  );

  // Viewing historical evidence version (#1) locks both review buttons
  const modelHistory = evaluateEvidenceComparisonPanel(detailWithPortrait, 1);
  assert.equal(modelHistory.selectedEvidence?.evidenceVersion, 1);
  assert.equal(modelHistory.canConfirmReviewed, false);
  assert.equal(modelHistory.canRequestRetake, false);
  assert.ok(modelHistory.confirmReviewedLockReason);

  // Missing worker portrait: warns user, locks REVIEWED, but keeps request/evidence intact and allows RETAKE_REQUIRED
  const detailMissingPortrait = {
    ...detailWithPortrait,
    request: {
      ...detailWithPortrait.request,
      worker_portrait: null,
    },
  };
  const modelMissingPortrait = evaluateEvidenceComparisonPanel(
    detailMissingPortrait,
    2
  );
  assert.equal(modelMissingPortrait.hasWorkerPortrait, false);
  assert.equal(modelMissingPortrait.workerPortrait, null);
  assert.equal(
    modelMissingPortrait.missingPortraitWarning,
    SALARY_ADVANCE_MISSING_PORTRAIT_WARNING
  );
  assert.equal(modelMissingPortrait.hasEvidencePhoto, true);
  assert.equal(modelMissingPortrait.selectedEvidence?.evidenceVersion, 2);
  assert.equal(
    modelMissingPortrait.canConfirmReviewed,
    false,
    "REVIEWED must be locked when worker portrait is missing"
  );
  assert.equal(
    modelMissingPortrait.canRequestRetake,
    true,
    "RETAKE_REQUIRED remains available even when worker portrait is missing"
  );
  assert.ok(modelMissingPortrait.confirmReviewedLockReason);
});

test("VND formatting, create request validation, transition input validation, and review input validation enforce WP1 rules", () => {
  assert.equal(normalizePositiveVndInput("2500000"), 2500000);
  assert.equal(normalizePositiveVndInput("2.500.000"), 2500000);
  assert.equal(normalizePositiveVndInput("2,500,000"), 2500000);
  assert.equal(normalizePositiveVndInput("0"), null);
  assert.equal(normalizePositiveVndInput("-500000"), null);
  assert.equal(normalizePositiveVndInput("abc"), null);
  assert.match(formatVndAmount(2500000), /2[.,]500[.,]000\s*₫/);
  assert.equal(formatFileSizeBytes(1536), "1.5 KB");

  // Project without active accountant is blocked client-side with clear guidance
  const unassignedResult = validateCreateSalaryAdvanceDraft({
    projectId: "22222222-2222-4222-8222-222222222222",
    hasActiveAccountant: false,
    workerEntryId: "33333333-3333-4333-8333-333333333333",
    requestedAmountRaw: "2000000",
    initialContent: "Ứng lương đợt 1",
  });
  assert.equal(unassignedResult.ok, false);

  const validCreate = validateCreateSalaryAdvanceDraft({
    projectId: "22222222-2222-4222-8222-222222222222",
    hasActiveAccountant: true,
    workerEntryId: "33333333-3333-4333-8333-333333333333",
    requestedAmountRaw: "2.000.000",
    initialContent: "Ứng lương đợt 1",
  });
  assert.equal(validCreate.ok, true);
  if (validCreate.ok) {
    assert.equal(validCreate.payload.requested_amount_vnd, "2000000");
  }

  // Transition validation
  assert.equal(
    validateTransitionActionInput({ action: "REJECT", messageText: "   " }).ok,
    false,
    "REJECT requires mandatory reason"
  );
  assert.equal(
    validateTransitionActionInput({
      action: "REJECT",
      messageText: "Vượt định mức công hiện tại",
    }).ok,
    true
  );
  assert.equal(
    validateTransitionActionInput({
      action: "REQUEST_INFO",
      messageText: "",
    }).ok,
    false
  );
  assert.equal(
    validateTransitionActionInput({
      action: "APPROVE",
      messageText: "",
    }).ok,
    true
  );

  // Message validation
  assert.equal(validateMessageInput("   ").ok, false);
  assert.equal(validateMessageInput("Đã xác nhận bảng công").ok, true);

  // Evidence review validation blocks REVIEWED when workerPortrait is null
  assert.equal(
    validateEvidenceReviewInput({
      decision: "REVIEWED",
      note: "",
      workerPortrait: null,
    }).ok,
    false
  );
  const validReview = validateEvidenceReviewInput({
    decision: "REVIEWED",
    note: "Ảnh khớp khuôn mặt hồ sơ",
    workerPortrait: {
      documentId: "66666666-6666-4666-8666-666666666666",
      version: 2,
    },
  });
  assert.equal(validReview.ok, true);
  if (validReview.ok) {
    assert.equal(
      validReview.expectedWorkerPortraitDocumentId,
      "66666666-6666-4666-8666-666666666666"
    );
    assert.equal(validReview.expectedWorkerPortraitVersion, 2);
  }
});

test("uploadSalaryAdvanceEvidence executes 3-step reserve -> PUT -> finalize flow and propagates OCC 409 conflicts", async () => {
  const calls = [];
  const fakeDetailResponse = {
    idempotent_replay: false,
    request: makeRequestSummary({
      request_state: "APPROVED",
      evidence_review_state: "PENDING_REVIEW",
      version: 4,
    }),
    events: [],
    evidence_versions: [],
  };

  const mockFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/evidence/reserve")) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            idempotent_replay: false,
            upload_id: "99999999-9999-4999-8999-999999999999",
            request_id: "11111111-1111-4111-8111-111111111111",
            expected_version: 3,
            mime_type: "image/jpeg",
            size_bytes: 1024,
            checksum_sha256: "a".repeat(64),
            expires_at: "2026-10-29T10:00:00.000Z",
            upload: {
              method: "PUT",
              url: "https://r2-presigned.example.test/put-object",
              expires_at: "2026-10-29T10:00:00.000Z",
              headers: { "Content-Type": "image/jpeg" },
            },
          },
        }),
        { status: 201 }
      );
    }
    if (String(url) === "https://r2-presigned.example.test/put-object") {
      return new Response(null, { status: 200 });
    }
    if (String(url).endsWith("/finalize")) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: fakeDetailResponse,
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const fileBlob = new Blob([new Uint8Array(1024)], { type: "image/jpeg" });
  const result = await uploadSalaryAdvanceEvidence({
    requestId: "11111111-1111-4111-8111-111111111111",
    expectedVersion: 3,
    file: fileBlob,
    captionNote: "Ảnh NLĐ ký nhận tiền mặt",
    reserveIdempotencyKey: "sa-ev-res-fixed-12345",
    finalizeIdempotencyKey: "sa-ev-fin-fixed-12345",
    fetchImpl: mockFetch,
    computeSha256Hex: async () => "a".repeat(64),
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/evidence\/reserve$/);
  assert.equal(calls[1].url, "https://r2-presigned.example.test/put-object");
  assert.match(calls[2].url, /\/evidence\/99999999-9999-4999-8999-999999999999\/finalize$/);

  // Verify preflight rejects unsupported MIME types
  const badMime = validateEvidenceFilePreflight({
    type: "application/pdf",
    size: 1024,
  });
  assert.equal(badMime.ok, false);

  // Verify conflict classification and Vietnamese error messages
  assert.equal(
    isSalaryAdvanceConflictError(409, "SALARY_ADVANCE_VERSION_CONFLICT"),
    true
  );
  assert.equal(
    isSalaryAdvanceConflictError(
      409,
      "SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT"
    ),
    true
  );
  assert.equal(
    isSalaryAdvanceConflictError(400, "SALARY_ADVANCE_AMOUNT_INVALID"),
    false
  );
  assert.match(
    salaryAdvanceErrorMessage("SALARY_ADVANCE_PROJECT_ACCOUNTANT_UNASSIGNED"),
    /Kế toán dự án/
  );
  assert.ok(SALARY_ADVANCE_NON_ACCOUNTING_NOTICE.length > 20);
  assert.ok(newSalaryAdvanceIdempotencyKey("sa-test").length >= 8);
});

test("sortEventsChronologically and metadata helpers cover all states and events", () => {
  const events = [
    { event_seq: 3, event_id: "e3", event_type: "REQUEST_APPROVED" },
    { event_seq: 1, event_id: "e1", event_type: "REQUEST_CREATED" },
    { event_seq: 2, event_id: "e2", event_type: "MESSAGE_POSTED" },
  ];
  const sorted = sortEventsChronologically(events);
  assert.deepEqual(
    sorted.map((e) => e.event_seq),
    [1, 2, 3]
  );

  assert.equal(getRequestStateMeta("APPROVED").tone, "success");
  assert.equal(getEvidenceReviewStateMeta("RETAKE_REQUIRED").tone, "danger");
  assert.equal(
    getSalaryAdvanceEventTypeLabel("EVIDENCE_REVIEWED"),
    "Xác nhận đã đối chiếu ảnh nhận tiền"
  );
  assert.equal(getSalaryAdvanceEventTone("EVIDENCE_REVIEWED"), "success");
  assert.equal(
    getSalaryAdvanceActorRoleLabel("PROJECT_ACCOUNTANT"),
    "Kế toán dự án"
  );
});

test("out-of-order worker search responses are aborted/ignored and worker selection never auto-picks the first worker", async () => {
  const tracker = createLatestRequestTracker();

  const workerAn = {
    worker_entry_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    employee_code: "NV001",
    display_name: "Nguyễn Văn An",
  };
  const workerBinh1 = {
    worker_entry_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    employee_code: "NV002",
    display_name: "Trần Văn Bình",
  };
  const workerBinh2 = {
    worker_entry_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
    employee_code: "NV003",
    display_name: "Lê Thị Bình",
  };

  let stateWorkers = [];
  let selectedWorkerEntryId = "";

  // Simulate two overlapping loadProjectWorkers calls where search #2 ("Bình") resolves BEFORE search #1 ("An")
  const req1 = tracker.begin();
  assert.equal(req1.isCurrent(), true);
  assert.equal(req1.signal.aborted, false);

  const req2 = tracker.begin();
  assert.equal(
    req1.signal.aborted,
    true,
    "Starting search #2 must abort search #1 signal immediately"
  );
  assert.equal(req1.isCurrent(), false);
  assert.equal(req2.isCurrent(), true);

  // Search #2 arrives first
  if (req2.isCurrent()) {
    const nextWorkers = [workerBinh1, workerBinh2];
    stateWorkers = nextWorkers;
    selectedWorkerEntryId = reconcileSelectedWorkerEntryId(
      selectedWorkerEntryId,
      nextWorkers
    );
  }

  assert.deepEqual(stateWorkers, [workerBinh1, workerBinh2]);
  assert.equal(
    selectedWorkerEntryId,
    "",
    "Must NOT auto-select nextWorkers[0] when user has not explicitly chosen a worker"
  );

  // User explicitly chooses workerBinh2
  selectedWorkerEntryId = workerBinh2.worker_entry_id;

  // Stale search #1 ("An") arrives late after search #2 and after user selection
  if (req1.isCurrent()) {
    const staleWorkers = [workerAn];
    stateWorkers = staleWorkers;
    selectedWorkerEntryId = reconcileSelectedWorkerEntryId(
      selectedWorkerEntryId,
      staleWorkers
    );
  }

  assert.deepEqual(
    stateWorkers,
    [workerBinh1, workerBinh2],
    "Late response from search #1 must not overwrite newer worker list"
  );
  assert.equal(
    selectedWorkerEntryId,
    workerBinh2.worker_entry_id,
    "Late response from search #1 must not overwrite user's selected worker"
  );

  // If a subsequent search #3 returns a list still containing workerBinh2, selection is preserved
  const req3 = tracker.begin();
  if (req3.isCurrent()) {
    selectedWorkerEntryId = reconcileSelectedWorkerEntryId(
      selectedWorkerEntryId,
      [workerBinh2]
    );
  }
  assert.equal(selectedWorkerEntryId, workerBinh2.worker_entry_id);

  // If a subsequent search #4 returns a list NOT containing workerBinh2, selection resets to "" (never auto-selects workerAn)
  const req4 = tracker.begin();
  if (req4.isCurrent()) {
    selectedWorkerEntryId = reconcileSelectedWorkerEntryId(
      selectedWorkerEntryId,
      [workerAn]
    );
  }
  assert.equal(
    selectedWorkerEntryId,
    "",
    "When previously selected worker is not in new search results, selection must reset to empty string instead of auto-picking first row"
  );
});

test("out-of-order request list and detail responses are ignored and switching selectedRequestId immediately hides stale detail", async () => {
  const listTracker = createLatestRequestTracker();
  const detailTracker = createLatestRequestTracker();

  const reqSummary1 = makeRequestSummary({
    request_id: "11111111-1111-4111-8111-111111111111",
    worker_display_name: "Nguyễn Văn An",
    version: 1,
    allowed_actions: makeAllowedActions({ can_approve: true }),
  });
  const reqSummary2 = makeRequestSummary({
    request_id: "22222222-2222-4222-8222-222222222222",
    worker_display_name: "Trần Văn Bình",
    version: 5,
    allowed_actions: makeAllowedActions({ can_approve: true }),
  });

  const detail1 = {
    request: reqSummary1,
    events: [],
    evidence_versions: [],
  };
  const detail2 = {
    request: reqSummary2,
    events: [],
    evidence_versions: [],
  };

  // Initial state: req-1 is selected and its detail is loaded
  let selectedRequestId = reqSummary1.request_id;
  let detailState = detail1;

  assert.equal(
    resolveActiveRequestDetail(detailState, selectedRequestId)?.request
      .request_id,
    reqSummary1.request_id
  );

  // User quickly clicks req-2 while detail1 is still in state
  selectedRequestId = reqSummary2.request_id;
  assert.equal(
    resolveActiveRequestDetail(detailState, selectedRequestId),
    null,
    "As soon as selectedRequestId changes to req-2, resolveActiveRequestDetail must return null so stale req-1 detail cannot be rendered or mutated"
  );

  // Simulate rapid selection: user selects req-1 (starts detailReq1) then immediately selects req-2 (starts detailReq2)
  selectedRequestId = reqSummary1.request_id;
  const detailReq1 = detailTracker.begin();
  selectedRequestId = reqSummary2.request_id;
  const detailReq2 = detailTracker.begin();

  assert.equal(
    detailReq1.signal.aborted,
    true,
    "Selecting req-2 must abort in-flight detail fetch for req-1"
  );
  assert.equal(detailReq1.isCurrent(), false);
  assert.equal(detailReq2.isCurrent(), true);

  // detailReq2 resolves first
  if (
    detailReq2.isCurrent() &&
    selectedRequestId === detail2.request.request_id
  ) {
    detailState = detail2;
  }
  assert.equal(
    resolveActiveRequestDetail(detailState, selectedRequestId)?.request
      .request_id,
    reqSummary2.request_id
  );

  // Stale detailReq1 resolves later (out of order)
  if (
    detailReq1.isCurrent() &&
    selectedRequestId === detail1.request.request_id
  ) {
    detailState = detail1;
  }
  assert.equal(
    detailState.request.request_id,
    reqSummary2.request_id,
    "Late detail response for req-1 must be ignored and must not overwrite req-2 detail"
  );

  // Simulate out-of-order loadRequests filter #1 vs filter #2
  const listReq1 = listTracker.begin();
  const listReq2 = listTracker.begin();
  assert.equal(listReq1.signal.aborted, true);
  assert.equal(listReq1.isCurrent(), false);
  assert.equal(listReq2.isCurrent(), true);

  let currentRows = [];
  // Filter #2 resolves first with [reqSummary2]
  if (listReq2.isCurrent()) {
    currentRows = [reqSummary2];
    selectedRequestId = reconcileSelectedRequestIdFromList(
      selectedRequestId,
      currentRows
    );
  }
  // Stale filter #1 resolves later with [reqSummary1]
  if (listReq1.isCurrent()) {
    currentRows = [reqSummary1];
    selectedRequestId = reconcileSelectedRequestIdFromList(
      selectedRequestId,
      currentRows
    );
  }

  assert.deepEqual(currentRows, [reqSummary2]);
  assert.equal(selectedRequestId, reqSummary2.request_id);
});

test("late mutation failure or 409 conflict for request A after switching selection to request B never writes error state or conflict banner onto request B", () => {
  const requestIdA = "11111111-1111-4111-8111-111111111111";
  const requestIdB = "22222222-2222-4222-8222-222222222222";

  // Case 1: User starts mutation on request A, switches to request B, then A fails with 409 VERSION_CONFLICT
  const conflictAfterSwitch = resolveScopedMutationFailureOutcome({
    targetRequestId: requestIdA,
    currentSelectedRequestId: requestIdB,
    status: 409,
    code: "SALARY_ADVANCE_VERSION_CONFLICT",
  });
  assert.equal(
    conflictAfterSwitch.shouldUpdateSelectedRequestUi,
    false,
    "Late 409 on request A must NOT update UI state of currently selected request B"
  );
  assert.equal(conflictAfterSwitch.conflictBannerMessage, null);
  assert.equal(conflictAfterSwitch.errorMessage, null);
  assert.equal(
    conflictAfterSwitch.shouldReloadSelectedDetail,
    false,
    "Must NOT reload detail of A when B is selected"
  );
  assert.equal(
    conflictAfterSwitch.shouldReloadRequestList,
    true,
    "Still refreshes queue list in background after a 409 conflict on A"
  );

  // Case 2: User starts mutation on request A, switches to request B, then A fails with 400/500 error
  const errorAfterSwitch = resolveScopedMutationFailureOutcome({
    targetRequestId: requestIdA,
    currentSelectedRequestId: requestIdB,
    status: 500,
    code: "SALARY_ADVANCE_UNAVAILABLE",
  });
  assert.equal(errorAfterSwitch.shouldUpdateSelectedRequestUi, false);
  assert.equal(errorAfterSwitch.conflictBannerMessage, null);
  assert.equal(errorAfterSwitch.errorMessage, null);
  assert.equal(errorAfterSwitch.shouldReloadSelectedDetail, false);
  assert.equal(errorAfterSwitch.shouldReloadRequestList, false);

  // Case 3: User stays on request A when 409 VERSION_CONFLICT arrives -> banner and detail reload apply to A
  const conflictSameRequest = resolveScopedMutationFailureOutcome({
    targetRequestId: requestIdA,
    currentSelectedRequestId: requestIdA,
    status: 409,
    code: "SALARY_ADVANCE_VERSION_CONFLICT",
  });
  assert.equal(conflictSameRequest.shouldUpdateSelectedRequestUi, true);
  assert.ok(conflictSameRequest.conflictBannerMessage);
  assert.equal(conflictSameRequest.errorMessage, null);
  assert.equal(conflictSameRequest.shouldReloadSelectedDetail, true);
  assert.equal(conflictSameRequest.shouldReloadRequestList, true);

  // Case 4: User stays on request A when non-conflict error arrives -> error message applies to A
  const errorSameRequest = resolveScopedMutationFailureOutcome({
    targetRequestId: requestIdA,
    currentSelectedRequestId: requestIdA,
    status: 400,
    code: "SALARY_ADVANCE_MESSAGE_REQUIRED",
  });
  assert.equal(errorSameRequest.shouldUpdateSelectedRequestUi, true);
  assert.equal(errorSameRequest.conflictBannerMessage, null);
  assert.match(errorSameRequest.errorMessage ?? "", /nội dung trao đổi/);
  assert.equal(errorSameRequest.shouldReloadSelectedDetail, false);
});

test("resolveSalaryAdvanceActorDisplayName enforces unified priority (verified current recruiter -> account display name -> login ID -> fallback without raw UUID)", () => {
  // Priority 1: verified current linked recruiter name wins over login-id display_name
  assert.equal(
    resolveSalaryAdvanceActorDisplayName({
      recruiterDisplayName: "Lê Hoàng Yến",
      verifiedCurrentRecruiterLink: true,
      displayName: "yenlh.td",
      loginId: "yenlh.td@hrpvietnam.com",
    }),
    "Lê Hoàng Yến"
  );

  // Unverified or inactive recruiter link is ignored; falls back to Priority 2 (account displayName)
  assert.equal(
    resolveSalaryAdvanceActorDisplayName({
      recruiterDisplayName: "Lê Hoàng Yến",
      verifiedCurrentRecruiterLink: false,
      displayName: "Yến Tuyển Dụng",
      loginId: "yenlh.td@hrpvietnam.com",
    }),
    "Yến Tuyển Dụng"
  );

  // Priority 3: when recruiter link is missing and displayName is blank or raw UUID, falls back to loginId
  assert.equal(
    resolveSalaryAdvanceActorDisplayName({
      recruiterDisplayName: null,
      displayName: "44444444-4444-4444-8444-444444444444",
      loginId: "YenLH.TD@hrpvietnam.com",
    }),
    "yenlh.td"
  );

  // Priority 4: when all candidates are blank or raw UUIDs, falls back to Vietnamese placeholder (never raw UUID)
  assert.equal(
    resolveSalaryAdvanceActorDisplayName({
      recruiterDisplayName: "   ",
      displayName: "44444444-4444-4444-8444-444444444444",
      loginId: "55555555-5555-4555-8555-555555555555",
    }),
    "Chưa cập nhật tên"
  );
  assert.equal(
    resolveSalaryAdvanceActorDisplayName(
      "44444444-4444-4444-8444-444444444444"
    ),
    "Chưa cập nhật tên"
  );
  assert.equal(resolveSalaryAdvanceActorDisplayName("   "), "Chưa cập nhật tên");
  assert.equal(resolveSalaryAdvanceActorDisplayName(null), "Chưa cập nhật tên");
  assert.equal(
    resolveSalaryAdvanceActorDisplayName("Lê Hoàng Yến"),
    "Lê Hoàng Yến"
  );

  // evaluateEvidenceComparisonPanel sanitizes UUID/blank uploader and reviewer display names
  const detailWithUuidNames = {
    request: makeRequestSummary({
      request_state: "APPROVED",
      evidence_review_state: "REVIEWED",
      current_evidence: {
        evidence_version: 1,
        mime_type: "image/jpeg",
        size_bytes: 120000,
        checksum_sha256: "c".repeat(64),
        uploaded_by_user_id: "44444444-4444-4444-8444-444444444444",
        uploaded_by_display_name: "44444444-4444-4444-8444-444444444444",
        uploaded_at: "2026-10-29T09:00:00.000Z",
        reviewed_by_user_id: "55555555-5555-4555-8555-555555555555",
        reviewed_by_display_name: "",
        reviewed_at: "2026-10-29T09:15:00.000Z",
        review_note: "Đã đối chiếu",
        reviewed_worker_portrait_document_id:
          "66666666-6666-4666-8666-666666666666",
        reviewed_worker_portrait_version: 2,
      },
    }),
    events: [],
    evidence_versions: [],
  };

  const panelModel = evaluateEvidenceComparisonPanel(detailWithUuidNames);
  assert.equal(
    panelModel.selectedEvidence?.uploadedByDisplayName,
    "Chưa cập nhật tên"
  );
  assert.equal(
    panelModel.selectedEvidence?.reviewedByDisplayName,
    "Chưa cập nhật tên"
  );
});

test("updateTabBadgeCountsForTab preserves object reference when badge count is unchanged so loadRequests never loops infinitely", () => {
  const actionableRow = makeRequestSummary({
    request_state: "OPEN",
    allowed_actions: makeAllowedActions({ can_approve: true }),
  });

  const initialCounts = { accountant: 1 };
  const sameCounts = updateTabBadgeCountsForTab(
    initialCounts,
    "accountant",
    [actionableRow]
  );
  assert.equal(
    sameCounts,
    initialCounts,
    "Must return the exact same object reference when badge count is unchanged"
  );

  const updatedCounts = updateTabBadgeCountsForTab(
    initialCounts,
    "accountant",
    [actionableRow, { ...actionableRow, request_id: "99999999-9999-4999-8999-999999999999" }]
  );
  assert.notEqual(updatedCounts, initialCounts);
  assert.equal(updatedCounts.accountant, 2);
});

test("fetchSalaryAdvanceRequestListPage and parseSalaryAdvanceRequestListPayload settle cleanly across success, empty, API/shape error, and stale/cancelled request branches", async () => {
  const row1 = makeRequestSummary({
    request_id: "11111111-1111-4111-8111-111111111111",
    request_state: "OPEN",
    allowed_actions: makeAllowedActions({ can_approve: true }),
  });

  // 1. Success with data
  const tracker1 = createLatestRequestTracker();
  const ticket1 = tracker1.begin();
  const successOutcome = await fetchSalaryAdvanceRequestListPage({
    queue: "ACCOUNTANT",
    projectFilter: "ALL",
    requestStateFilter: "ALL",
    evidenceStateFilter: "ALL",
    appliedSearch: "",
    ticket: ticket1,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            queue: "ACCOUNTANT",
            page_size: 25,
            has_more: false,
            next_cursor: null,
            requests: [row1],
          },
        }),
        { status: 200 }
      ),
  });
  assert.equal(successOutcome.status, "success");
  if (successOutcome.status === "success") {
    assert.equal(successOutcome.isEmpty, false);
    assert.equal(successOutcome.data.requests.length, 1);
    assert.equal(successOutcome.data.requests[0].request_id, row1.request_id);
  }

  // 2. Success with empty list
  const tracker2 = createLatestRequestTracker();
  const ticket2 = tracker2.begin();
  const emptyOutcome = await fetchSalaryAdvanceRequestListPage({
    queue: "ACCOUNTANT",
    projectFilter: "ALL",
    requestStateFilter: "APPROVED",
    evidenceStateFilter: "ALL",
    appliedSearch: "NV999",
    ticket: ticket2,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            queue: "ACCOUNTANT",
            page_size: 25,
            has_more: false,
            next_cursor: null,
            requests: [],
          },
        }),
        { status: 200 }
      ),
  });
  assert.equal(emptyOutcome.status, "success");
  if (emptyOutcome.status === "success") {
    assert.equal(emptyOutcome.isEmpty, true);
    assert.deepEqual(emptyOutcome.data.requests, []);
  }

  // 3a. API error response (HTTP 500 or ok: false) -> status: "error" (never empty list)
  const tracker3 = createLatestRequestTracker();
  const ticket3 = tracker3.begin();
  const apiErrorOutcome = await fetchSalaryAdvanceRequestListPage({
    queue: "ACCOUNTANT",
    projectFilter: "ALL",
    requestStateFilter: "ALL",
    evidenceStateFilter: "ALL",
    appliedSearch: "",
    ticket: ticket3,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ok: false,
          code: "SALARY_ADVANCE_ACCESS_DENIED",
        }),
        { status: 403 }
      ),
  });
  assert.equal(apiErrorOutcome.status, "error");
  if (apiErrorOutcome.status === "error") {
    assert.equal(apiErrorOutcome.code, "SALARY_ADVANCE_ACCESS_DENIED");
    assert.match(apiErrorOutcome.message, /quyền/);
  }

  // 3b. Malformed payload shape (e.g. requests is null or missing has_more) -> status: "error" (never masked as empty list)
  assert.equal(
    parseSalaryAdvanceRequestListPayload({
      queue: "ACCOUNTANT",
      page_size: 25,
      has_more: false,
      next_cursor: null,
      requests: null,
    }).ok,
    false
  );
  assert.equal(
    parseSalaryAdvanceRequestListPayload({
      queue: "ACCOUNTANT",
      page_size: 25,
      requests: [],
    }).ok,
    false
  );

  const ticket3b = tracker3.begin();
  const shapeErrorOutcome = await fetchSalaryAdvanceRequestListPage({
    queue: "ACCOUNTANT",
    projectFilter: "ALL",
    requestStateFilter: "ALL",
    evidenceStateFilter: "ALL",
    appliedSearch: "",
    ticket: ticket3b,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            queue: "ACCOUNTANT",
            page_size: 25,
            has_more: false,
            next_cursor: null,
            requests: [{ invalid_item: true }],
          },
        }),
        { status: 200 }
      ),
  });
  assert.equal(shapeErrorOutcome.status, "error");
  if (shapeErrorOutcome.status === "error") {
    assert.equal(shapeErrorOutcome.code, "SALARY_ADVANCE_PAYLOAD_INVALID");
    assert.match(shapeErrorOutcome.message, /không hợp lệ/);
  }

  // 4. Stale / cancelled request when user changes filter or switches tab before response arrives
  const tracker4 = createLatestRequestTracker();
  const staleTicket = tracker4.begin();
  const newerTicket = tracker4.begin();
  assert.equal(staleTicket.isCurrent(), false);
  assert.equal(newerTicket.isCurrent(), true);

  const staleOutcome = await fetchSalaryAdvanceRequestListPage({
    queue: "PM",
    projectFilter: "ALL",
    requestStateFilter: "ALL",
    evidenceStateFilter: "ALL",
    appliedSearch: "",
    ticket: staleTicket,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            queue: "PM",
            page_size: 25,
            has_more: false,
            next_cursor: null,
            requests: [row1],
          },
        }),
        { status: 200 }
      ),
  });
  assert.deepEqual(staleOutcome, { status: "stale" });
});

test("describeWorkerEligibility, reconcileSelectedWorkerEntryId, and validateCreateSalaryAdvanceDraft block OFF/UNCONFIRMED, multi-project ON, and duplicate CCCD workers", () => {
  const eligibleWorker = {
    worker_entry_id: "33333333-3333-4333-8333-333333333333",
    employee_code: "NV001",
    display_name: "Nguyễn Văn An",
    first_work_date: "2026-01-10",
    has_portrait: true,
    employment_status: "ON",
    active_on_project_count: 1,
    has_duplicate_cccd: false,
    is_eligible: true,
    ineligible_reasons: [],
  };
  const eligView = describeWorkerEligibility(eligibleWorker);
  assert.equal(eligView.isEligible, true);
  assert.equal(eligView.blockingMessage, null);

  const offWorker = {
    ...eligibleWorker,
    worker_entry_id: "33333333-3333-4333-8333-333333333334",
    employment_status: "OFF",
    active_on_project_count: 0,
    is_eligible: false,
    ineligible_reasons: ["WORKER_STATUS_OFF"],
  };
  const offView = describeWorkerEligibility(offWorker);
  assert.equal(offView.isEligible, false);
  assert.deepEqual(offView.reasonCodes, ["WORKER_STATUS_OFF"]);
  assert.match(offView.blockingMessage ?? "", /nghỉ việc \(OFF\)/);

  const unconfirmedWorker = {
    ...eligibleWorker,
    worker_entry_id: "33333333-3333-4333-8333-333333333335",
    employment_status: "UNCONFIRMED",
    active_on_project_count: 0,
    is_eligible: false,
    ineligible_reasons: ["WORKER_STATUS_UNCONFIRMED"],
  };
  const unconfirmedView = describeWorkerEligibility(unconfirmedWorker);
  assert.equal(unconfirmedView.isEligible, false);
  assert.match(unconfirmedView.blockingMessage ?? "", /UNCONFIRMED/);

  const multiProjectAndDupWorker = {
    ...eligibleWorker,
    worker_entry_id: "33333333-3333-4333-8333-333333333336",
    employment_status: "ON",
    active_on_project_count: 2,
    has_duplicate_cccd: true,
    is_eligible: false,
    ineligible_reasons: ["WORKER_MULTI_PROJECT_ON", "WORKER_DUPLICATE_CCCD"],
  };
  const multiView = describeWorkerEligibility(multiProjectAndDupWorker);
  assert.equal(multiView.isEligible, false);
  assert.match(multiView.blockingMessage ?? "", /2 dự án/);
  assert.match(multiView.blockingMessage ?? "", /trùng CCCD/);

  // reconcileSelectedWorkerEntryId clears selection if selected worker becomes ineligible
  assert.equal(
    reconcileSelectedWorkerEntryId(offWorker.worker_entry_id, [
      eligibleWorker,
      offWorker,
    ]),
    ""
  );
  assert.equal(
    reconcileSelectedWorkerEntryId(eligibleWorker.worker_entry_id, [
      eligibleWorker,
      offWorker,
    ]),
    eligibleWorker.worker_entry_id
  );

  // validateCreateSalaryAdvanceDraft blocks ineligible workers
  const blockedDraft = validateCreateSalaryAdvanceDraft({
    projectId: "PRJ_NORTH",
    hasActiveAccountant: true,
    workerEntryId: multiProjectAndDupWorker.worker_entry_id,
    selectedWorker: multiProjectAndDupWorker,
    requestedAmountRaw: "2000000",
    paymentMethod: "CASH",
    initialContent: "Đề nghị ứng lương",
  });
  assert.equal(blockedDraft.ok, false);
  if (!blockedDraft.ok) {
    assert.ok(blockedDraft.fieldErrors.workerEntryId);
    assert.match(blockedDraft.message, /trùng CCCD/);
  }
});

test("describeWorkerBankTransferEligibility, validateCreateSalaryAdvanceDraft, and evaluateEvidenceComparisonPanel enforce CASH vs BANK_TRANSFER rules", () => {
  const selfOwnedWorker = {
    worker_entry_id: "33333333-3333-4333-8333-333333333333",
    employee_code: "NV001",
    display_name: "Đặng Thị Hồng Nhung",
    first_work_date: "2026-01-10",
    has_portrait: false,
    employment_status: "ON",
    active_on_project_count: 1,
    has_duplicate_cccd: false,
    is_eligible: true,
    bank_transfer_eligible: true,
    bank_account: {
      has_bank_account: true,
      bank_id: "VCB",
      institution_name: "Vietcombank",
      account_number: "0123456789",
      account_number_masked: "******6789",
      account_holder_name: "DANG THI HONG NHUNG",
      is_self_owned: true,
    },
  };
  const selfOwnedBankView = describeWorkerBankTransferEligibility(selfOwnedWorker);
  assert.equal(selfOwnedBankView.canUseBankTransfer, true);
  assert.equal(selfOwnedBankView.isSelfOwned, true);

  const nonSelfOwnedWorker = {
    ...selfOwnedWorker,
    bank_transfer_eligible: false,
    bank_ineligible_reason: "BANK_ACCOUNT_NOT_SELF_OWNED",
    bank_account: {
      ...selfOwnedWorker.bank_account,
      account_holder_name: "NGUYEN VAN KHAC",
      is_self_owned: false,
    },
  };
  const nonSelfOwnedBankView =
    describeWorkerBankTransferEligibility(nonSelfOwnedWorker);
  assert.equal(nonSelfOwnedBankView.canUseBankTransfer, false);
  assert.equal(
    nonSelfOwnedBankView.reasonCode,
    "BANK_ACCOUNT_NOT_SELF_OWNED"
  );
  assert.match(nonSelfOwnedBankView.blockingMessage ?? "", /không chính chủ/);

  // Draft validation rejects BANK_TRANSFER when worker's bank account is not self-owned
  const invalidBankDraft = validateCreateSalaryAdvanceDraft({
    projectId: "PRJ_NORTH",
    hasActiveAccountant: true,
    workerEntryId: nonSelfOwnedWorker.worker_entry_id,
    selectedWorker: nonSelfOwnedWorker,
    requestedAmountRaw: "3000000",
    paymentMethod: "BANK_TRANSFER",
    initialContent: "Ứng lương chuyển khoản",
  });
  assert.equal(invalidBankDraft.ok, false);
  if (!invalidBankDraft.ok) {
    assert.ok(invalidBankDraft.fieldErrors.paymentMethod);
  }

  // Draft validation accepts BANK_TRANSFER when worker's bank account is self-owned
  const validBankDraft = validateCreateSalaryAdvanceDraft({
    projectId: "PRJ_NORTH",
    hasActiveAccountant: true,
    workerEntryId: selfOwnedWorker.worker_entry_id,
    selectedWorker: selfOwnedWorker,
    requestedAmountRaw: "3000000",
    paymentMethod: "BANK_TRANSFER",
    initialContent: "Ứng lương chuyển khoản",
  });
  assert.equal(validBankDraft.ok, true);
  if (validBankDraft.ok) {
    assert.equal(validBankDraft.payload.payment_method, "BANK_TRANSFER");
  }

  // evaluateEvidenceComparisonPanel for BANK_TRANSFER does NOT lock REVIEWED when worker portrait is missing
  const bankTransferDetailNoPortrait = {
    request: makeRequestSummary({
      payment_method: "BANK_TRANSFER",
      payment_destination_snapshot: {
        bank_id: "VCB",
        institution_name: "Vietcombank",
        account_number: "0123456789",
        account_number_masked: "******6789",
        account_holder_name: "DANG THI HONG NHUNG",
      },
      request_state: "APPROVED",
      evidence_review_state: "PENDING_REVIEW",
      worker_portrait: null,
      current_evidence: {
        evidence_version: 1,
        evidence_kind: "BANK_TRANSFER_RECEIPT",
        mime_type: "image/png",
        size_bytes: 95000,
        checksum_sha256: "d".repeat(64),
        uploaded_by_user_id: "44444444-4444-4444-8444-444444444444",
        uploaded_by_display_name: "Lê Hoàng Yến",
        uploaded_at: "2026-10-29T10:00:00.000Z",
        reviewed_by_user_id: null,
        reviewed_by_display_name: null,
        reviewed_at: null,
        review_note: null,
        reviewed_worker_portrait_document_id: null,
        reviewed_worker_portrait_version: null,
      },
      allowed_actions: makeAllowedActions({ can_review_evidence: true }),
    }),
    events: [],
    evidence_versions: [],
  };

  const bankPanel = evaluateEvidenceComparisonPanel(bankTransferDetailNoPortrait);
  assert.equal(bankPanel.paymentMethod, "BANK_TRANSFER");
  assert.equal(bankPanel.evidenceKind, "BANK_TRANSFER_RECEIPT");
  assert.equal(bankPanel.requiresWorkerPortraitComparison, false);
  assert.equal(bankPanel.missingPortraitWarning, null);
  assert.equal(bankPanel.canConfirmReviewed, true);
  assert.equal(bankPanel.confirmReviewedLockReason, null);
  assert.equal(
    bankPanel.paymentDestinationSnapshot?.institution_name,
    "Vietcombank"
  );

  // validateEvidenceReviewInput allows REVIEWED for BANK_TRANSFER_RECEIPT without workerPortrait
  const bankReviewValidation = validateEvidenceReviewInput({
    expectedVersion: 3,
    evidenceVersion: 1,
    evidenceKind: "BANK_TRANSFER_RECEIPT",
    decision: "REVIEWED",
    workerPortrait: null,
    note: "Đã đối chiếu bill chuyển khoản",
  });
  assert.equal(bankReviewValidation.ok, true);
  if (bankReviewValidation.ok) {
    assert.equal(bankReviewValidation.evidenceKind, "BANK_TRANSFER_RECEIPT");
    assert.equal(
      bankReviewValidation.expectedWorkerPortraitDocumentId,
      null
    );
  }

  // Event & metadata helpers reflect evidence_kind
  assert.equal(getPaymentMethodMeta("BANK_TRANSFER").shortLabel, "Chuyển khoản");
  assert.equal(getEvidenceKindLabel("BANK_TRANSFER_RECEIPT"), "Chứng từ chuyển khoản");
  assert.equal(
    getSalaryAdvanceEventTypeLabel("EVIDENCE_UPLOADED", "BANK_TRANSFER_RECEIPT"),
    "Tải lên chứng từ chuyển khoản"
  );
  assert.equal(
    getSalaryAdvanceEventTypeLabel("EVIDENCE_REVIEWED", "BANK_TRANSFER_RECEIPT"),
    "Xác nhận đã đối chiếu chứng từ chuyển khoản"
  );
  assert.match(
    salaryAdvanceErrorMessage("SALARY_ADVANCE_WORKER_MULTI_PROJECT_ON"),
    /2 dự án/
  );
  assert.match(
    salaryAdvanceErrorMessage("SALARY_ADVANCE_BANK_ACCOUNT_NOT_SELF_OWNED"),
    /không chính chủ/
  );
  assert.match(
    salaryAdvanceErrorMessage("SALARY_ADVANCE_EXPORT_LIMIT_EXCEEDED"),
    /vượt quá giới hạn xuất Excel/
  );
  assert.match(
    salaryAdvanceErrorMessage("SALARY_ADVANCE_EXPORT_INCOMPLETE"),
    /xuất Excel/
  );
});

test("buildSalaryAdvanceExportUrl maps active accountant filters (project, request_state, evidence_review_state, search) and omits ALL/empty filters", () => {
  assert.equal(
    buildSalaryAdvanceExportUrl({
      projectFilter: "ALL",
      requestStateFilter: "ALL",
      evidenceStateFilter: "ALL",
      appliedSearch: "   ",
    }),
    "/api/salary-advance/requests/export"
  );

  assert.equal(
    buildSalaryAdvanceExportUrl({
      projectFilter: "PRJ_NORTH",
      requestStateFilter: "APPROVED",
      evidenceStateFilter: "PENDING_REVIEW",
      appliedSearch: "  NV001  ",
    }),
    "/api/salary-advance/requests/export?project_id=PRJ_NORTH&request_state=APPROVED&evidence_review_state=PENDING_REVIEW&search=NV001"
  );
});

test("filterSelectableProjectWorkers hides OFF workers while retaining UNCONFIRMED and fixable-ineligible workers with their ineligibility reasons", () => {
  const onEligible = {
    worker_entry_id: "33333333-3333-4333-8333-333333333331",
    employee_code: "NV001",
    display_name: "Nguyễn Văn A",
    first_work_date: "2026-01-10",
    has_portrait: true,
    employment_status: "ON",
    active_on_project_count: 1,
    has_duplicate_cccd: false,
    is_eligible: true,
    ineligible_reasons: [],
    bank_transfer_eligible: true,
  };
  const offWorker = {
    worker_entry_id: "33333333-3333-4333-8333-333333333332",
    employee_code: "NV002",
    display_name: "Trần Văn Nghỉ",
    first_work_date: "2026-01-11",
    has_portrait: true,
    employment_status: "OFF",
    active_on_project_count: 0,
    has_duplicate_cccd: false,
    is_eligible: false,
    ineligible_reasons: ["WORKER_STATUS_OFF"],
    bank_transfer_eligible: true,
  };
  const unconfirmedWorker = {
    worker_entry_id: "33333333-3333-4333-8333-333333333333",
    employee_code: "NV003",
    display_name: "Lê Thị Chưa Xác Nhận",
    first_work_date: "2026-01-12",
    has_portrait: true,
    employment_status: "UNCONFIRMED",
    active_on_project_count: 0,
    has_duplicate_cccd: false,
    is_eligible: false,
    ineligible_reasons: ["WORKER_STATUS_UNCONFIRMED"],
    bank_transfer_eligible: true,
  };
  const dupCccdAndMultiWorker = {
    worker_entry_id: "33333333-3333-4333-8333-333333333334",
    employee_code: "NV004",
    display_name: "Phạm Văn Trùng Hồ Sơ",
    first_work_date: "2026-01-13",
    has_portrait: false,
    employment_status: "ON",
    active_on_project_count: 2,
    has_duplicate_cccd: true,
    is_eligible: false,
    ineligible_reasons: ["WORKER_MULTI_PROJECT_ON", "WORKER_DUPLICATE_CCCD"],
    bank_transfer_eligible: false,
    bank_ineligible_reason: "BANK_ACCOUNT_MISSING",
  };

  assert.equal(isProjectWorkerHiddenFromPicker(offWorker), true);
  assert.equal(isProjectWorkerHiddenFromPicker(onEligible), false);
  assert.equal(isProjectWorkerHiddenFromPicker(unconfirmedWorker), false);
  assert.equal(isProjectWorkerHiddenFromPicker(dupCccdAndMultiWorker), false);

  const filtered = filterSelectableProjectWorkers([
    onEligible,
    offWorker,
    unconfirmedWorker,
    dupCccdAndMultiWorker,
  ]);
  assert.deepEqual(
    filtered.map((w) => w.employee_code),
    ["NV001", "NV003", "NV004"],
    "OFF worker (NV002) must be hidden while ON, UNCONFIRMED (NV003), and fixable-ineligible (NV004) workers remain visible"
  );

  // UNCONFIRMED and fixable-ineligible workers still report their reasons clearly
  const unconfirmedEligibility = describeWorkerEligibility(unconfirmedWorker);
  assert.equal(unconfirmedEligibility.isEligible, false);
  assert.ok(
    unconfirmedEligibility.reasonLabels.some((r) => r.includes("UNCONFIRMED"))
  );

  const dupEligibility = describeWorkerEligibility(dupCccdAndMultiWorker);
  assert.equal(dupEligibility.isEligible, false);
  assert.ok(dupEligibility.reasonLabels.some((r) => r.includes("2 dự án")));
  assert.ok(dupEligibility.reasonLabels.some((r) => r.includes("trùng CCCD")));
});

test("updateTabBadgeCountsForTab and parseSalaryAdvanceRequestListPayload preserve full server-side badge counts across >25 open requests, pagination, and active filters", () => {
  // Simulate 32 open PM requests where page 1 only contains 25 rows (has_more = true)
  const firstPageRows = Array.from({ length: 25 }, (_, idx) =>
    makeRequestSummary({
      request_id: `11111111-1111-4111-8111-${String(idx + 1).padStart(12, "0")}`,
      request_state: idx % 2 === 0 ? "OPEN" : "NEEDS_INFO",
    })
  );

  const parsedPage = parseSalaryAdvanceRequestListPayload({
    requests: firstPageRows,
    has_more: true,
    next_cursor: "2026-10-29T10:00:00Z|11111111-1111-4111-8111-000000000025",
    badge_count: 32,
  });
  assert.equal(parsedPage.ok, true);
  if (parsedPage.ok) {
    assert.equal(parsedPage.data.requests.length, 25);
    assert.equal(parsedPage.data.has_more, true);
    assert.equal(parsedPage.data.badge_count, 32);
  }

  // 1. Even though page 1 only has 25 rows (hasMore = true), serverBadgeCount (32) sets the exact total of 32
  const initialCounts = {};
  const afterPage1 = updateTabBadgeCountsForTab(
    initialCounts,
    "pm",
    firstPageRows,
    {
      serverBadgeCount: 32,
      isUnfiltered: true,
      hasMore: true,
    }
  );
  assert.equal(
    afterPage1.pm,
    32,
    "PM badge must show all 32 open requests in scope, not just the 25 rows loaded on page 1"
  );

  // 2. When the user filters the list (e.g. requestStateFilter = APPROVED -> 0 open rows in filtered page),
  // serverBadgeCount still keeps the badge at 32; and even if serverBadgeCount were omitted, isUnfiltered=false prevents overwriting with 0
  const filteredApprovedRows = [
    makeRequestSummary({
      request_id: "99999999-9999-4999-8999-000000000001",
      request_state: "APPROVED",
    }),
  ];
  const afterFilteredWithServerBadge = updateTabBadgeCountsForTab(
    afterPage1,
    "pm",
    filteredApprovedRows,
    {
      serverBadgeCount: 32,
      isUnfiltered: false,
      hasMore: false,
    }
  );
  assert.equal(
    afterFilteredWithServerBadge,
    afterPage1,
    "Filtering the list must not change the PM badge count or create a new object reference when count is unchanged"
  );

  const afterFilteredWithoutServerBadge = updateTabBadgeCountsForTab(
    afterPage1,
    "pm",
    filteredApprovedRows,
    {
      serverBadgeCount: undefined,
      isUnfiltered: false,
      hasMore: false,
    }
  );
  assert.equal(
    afterFilteredWithoutServerBadge.pm,
    32,
    "Filtered view without serverBadgeCount must never overwrite the PM badge with the filtered subset count"
  );

  // 3. Same protection for Accountant 'Cần xử lý' badge when paginated (>25 rows) or filtered
  const acctInitial = updateTabBadgeCountsForTab(
    afterPage1,
    "accountant",
    [],
    {
      serverBadgeCount: 28,
      isUnfiltered: true,
      hasMore: true,
    }
  );
  assert.equal(acctInitial.accountant, 28);

  const acctAfterFiltered = updateTabBadgeCountsForTab(
    acctInitial,
    "accountant",
    [],
    {
      serverBadgeCount: undefined,
      isUnfiltered: false,
      hasMore: false,
    }
  );
  assert.equal(
    acctAfterFiltered.accountant,
    28,
    "Accountant 'Cần xử lý' badge must not be overwritten with 0 when user filters to an empty subset"
  );

  // 4. parseSalaryAdvanceRequestListPayload preserves badge_count_capped and fetchSalaryAdvanceRequestListPage sends include_badge=1 only when requested
  const cappedPayload = parseSalaryAdvanceRequestListPayload({
    requests: firstPageRows,
    has_more: true,
    next_cursor: "2026-10-29T10:00:00Z|11111111-1111-4111-8111-000000000025",
    badge_count: 1000,
    badge_count_capped: true,
  });
  assert.equal(cappedPayload.ok, true);
  if (cappedPayload.ok) {
    assert.equal(cappedPayload.data.badge_count, 1000);
    assert.equal(cappedPayload.data.badge_count_capped, true);
  }
});
