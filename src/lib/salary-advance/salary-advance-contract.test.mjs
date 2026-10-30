import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildSalaryAdvanceEvidenceStorageKey,
  createR2SalaryAdvanceEvidenceStorage,
  inspectSalaryAdvanceEvidenceContent,
  isOpaqueSalaryAdvanceEvidenceStorageKey,
  isOpaqueWorkerPortraitStorageKey,
  salaryAdvanceFinalObjectKey,
  salaryAdvanceStagingObjectKey,
} from "./r2-salary-advance-evidence-storage.ts";
import {
  MAX_PG_BIGINT,
  SALARY_ADVANCE_EVIDENCE_MAX_BYTES,
  computeCreateRequestFingerprint,
  computeFinalizeEvidenceFingerprint,
  computePostMessageFingerprint,
  computeReserveEvidenceFingerprint,
  computeReviewEvidenceFingerprint,
  computeTransitionRequestFingerprint,
  isSelfOwnedBankAccountNameMatch,
  normalizeSalaryAdvancePersonName,
  parseCreateSalaryAdvanceRequestBody,
  parseEvidenceVersionParam,
  parseExportSalaryAdvanceRequestsQuery,
  parseFinalizeSalaryAdvanceEvidenceBody,
  parseIdempotencyKeyHeader,
  parseListProjectWorkersQuery,
  parseListSalaryAdvanceRequestsQuery,
  parseListWorkerHistoryQuery,
  parseNoQueryParams,
  parsePositiveAmountVnd,
  parsePostSalaryAdvanceMessageBody,
  parseProjectIdParam,
  parseReserveSalaryAdvanceEvidenceBody,
  parseReviewSalaryAdvanceEvidenceBody,
  parseTransitionSalaryAdvanceRequestBody,
  parseUuidParam,
  parseWorkerPortraitQuery,
  salaryAdvanceHttpStatusForError,
} from "./salary-advance-contract.ts";

const REQ_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";
const WORKER_ID = "33333333-3333-4333-8333-333333333333";
const PORTRAIT_DOC_ID = "44444444-4444-4444-8444-444444444444";
const IDEM_KEY = "idem-salary-advance-0001";
const SHA_A = "a".repeat(64);

function makeValidJpegBytes(payloadText = "valid-jpeg-pixel-stream") {
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const body = Buffer.from(payloadText, "utf8");
  const trailer = Buffer.from([0xff, 0xd9]);
  return new Uint8Array(Buffer.concat([header, body, trailer]));
}

function makeValidPngBytes(payloadText = "valid-png-chunk") {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.from(payloadText, "utf8");
  const trailer = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return new Uint8Array(Buffer.concat([magic, body, trailer]));
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("parsePositiveAmountVnd accepts positive integer strings up to MAX_PG_BIGINT with no business cap and rejects invalid formats", () => {
  for (const valid of [
    "1",
    "500000",
    "25000000",
    "500000000",
    MAX_PG_BIGINT.toString(),
  ]) {
    const res = parsePositiveAmountVnd(valid);
    assert.equal(res.ok, true, `expected ${valid} to be accepted`);
    if (res.ok) {
      assert.equal(res.value, valid);
    }
  }

  for (const invalid of [
    "",
    "0",
    "-1",
    "-500000",
    "01",
    "00500",
    "100.5",
    "100,000",
    "1e6",
    "9223372036854775808",
    "99999999999999999999",
    500000,
    null,
    undefined,
  ]) {
    const res = parsePositiveAmountVnd(invalid);
    assert.equal(res.ok, false, `expected ${String(invalid)} to be rejected`);
    if (!res.ok) {
      assert.equal(res.code, "SALARY_ADVANCE_AMOUNT_INVALID");
    }
  }
});

test("parseCreateSalaryAdvanceRequestBody and parseTransitionSalaryAdvanceRequestBody enforce field contracts", () => {
  const created = parseCreateSalaryAdvanceRequestBody(
    {
      project_id: "PRJ_ALPHA",
      worker_entry_id: WORKER_ID,
      requested_amount_vnd: "150000000",
      payment_method: "CASH",
      initial_content: "Ứng lương đợt 1 cho tổ thi công",
    },
    IDEM_KEY,
  );
  assert.equal(created.ok, true);
  if (created.ok) {
    assert.equal(created.value.project_id, "PRJ_ALPHA");
    assert.equal(created.value.worker_entry_id, WORKER_ID);
    assert.equal(created.value.requested_amount_vnd, "150000000");
    assert.equal(created.value.payment_method, "CASH");
    assert.equal(created.value.idempotency_key, IDEM_KEY);
  }

  const createdBankTransfer = parseCreateSalaryAdvanceRequestBody(
    {
      project_id: "PRJ_ALPHA",
      worker_entry_id: WORKER_ID,
      requested_amount_vnd: "3000000",
      payment_method: "BANK_TRANSFER",
      initial_content: "Ứng lương chuyển khoản",
    },
    IDEM_KEY,
  );
  assert.equal(createdBankTransfer.ok, true);
  if (createdBankTransfer.ok) {
    assert.equal(createdBankTransfer.value.payment_method, "BANK_TRANSFER");
  }

  const missingPaymentMethod = parseCreateSalaryAdvanceRequestBody(
    {
      project_id: "PRJ_ALPHA",
      worker_entry_id: WORKER_ID,
      requested_amount_vnd: "3000000",
      initial_content: "Ứng lương thiếu phương thức",
    },
    IDEM_KEY,
  );
  assert.deepEqual(missingPaymentMethod, {
    ok: false,
    code: "SALARY_ADVANCE_PAYMENT_METHOD_INVALID",
  });

  // Extra unknown field rejected
  const unknownField = parseCreateSalaryAdvanceRequestBody(
    {
      project_id: "PRJ_ALPHA",
      worker_entry_id: WORKER_ID,
      requested_amount_vnd: "1500000",
      payment_method: "CASH",
      initial_content: "Ứng lương",
      worker_display_name: "Injected Name",
    },
    IDEM_KEY,
  );
  assert.equal(unknownField.ok, false);

  // REJECT requires reason
  const rejectMissingReason = parseTransitionSalaryAdvanceRequestBody(
    {
      action: "REJECT",
      expected_version: 1,
      message_text: "   ",
    },
    IDEM_KEY,
  );
  assert.deepEqual(rejectMissingReason, {
    ok: false,
    code: "SALARY_ADVANCE_REASON_REQUIRED",
  });

  // REQUEST_INFO and PROVIDE_INFO require message
  for (const action of ["REQUEST_INFO", "PROVIDE_INFO"]) {
    const missingMsg = parseTransitionSalaryAdvanceRequestBody(
      {
        action,
        expected_version: 1,
      },
      IDEM_KEY,
    );
    assert.deepEqual(missingMsg, {
      ok: false,
      code: "SALARY_ADVANCE_MESSAGE_REQUIRED",
    });
  }

  // APPROVE, WITHDRAW, MARK_HANDLED_EXTERNALLY allow optional note
  for (const action of ["APPROVE", "WITHDRAW", "MARK_HANDLED_EXTERNALLY"]) {
    const okNoNote = parseTransitionSalaryAdvanceRequestBody(
      {
        action,
        expected_version: 2,
      },
      IDEM_KEY,
    );
    assert.equal(okNoNote.ok, true);
    if (okNoNote.ok) {
      assert.equal(okNoNote.value.message_text, null);
    }
  }
});

test("parseReviewSalaryAdvanceEvidenceBody enforces 4-way portrait lock on REVIEWED for CASH_HANDOVER_PHOTO and allows BANK_TRANSFER_RECEIPT without portrait lock", () => {
  const reviewedMissingLock = parseReviewSalaryAdvanceEvidenceBody(
    {
      expected_version: 3,
      evidence_version: 1,
      decision: "REVIEWED",
    },
    IDEM_KEY,
  );
  assert.deepEqual(reviewedMissingLock, {
    ok: false,
    code: "SALARY_ADVANCE_PORTRAIT_LOCK_INVALID",
  });

  const reviewedOk = parseReviewSalaryAdvanceEvidenceBody(
    {
      expected_version: 3,
      evidence_version: 1,
      decision: "REVIEWED",
      expected_worker_portrait_document_id: PORTRAIT_DOC_ID,
      expected_worker_portrait_version: 2,
    },
    IDEM_KEY,
  );
  assert.equal(reviewedOk.ok, true);
  if (reviewedOk.ok) {
    assert.equal(reviewedOk.value.note, null);
    assert.equal(
      reviewedOk.value.expected_worker_portrait_document_id,
      PORTRAIT_DOC_ID,
    );
    assert.equal(reviewedOk.value.expected_worker_portrait_version, 2);
  }

  // BANK_TRANSFER_RECEIPT does not require portrait lock on REVIEWED
  const reviewedBankReceiptOk = parseReviewSalaryAdvanceEvidenceBody(
    {
      expected_version: 3,
      evidence_version: 1,
      evidence_kind: "BANK_TRANSFER_RECEIPT",
      decision: "REVIEWED",
      note: "Đã đối chiếu bill chuyển khoản khớp số tài khoản",
    },
    IDEM_KEY,
  );
  assert.equal(reviewedBankReceiptOk.ok, true);
  if (reviewedBankReceiptOk.ok) {
    assert.equal(
      reviewedBankReceiptOk.value.expected_worker_portrait_document_id,
      null,
    );
    assert.equal(
      reviewedBankReceiptOk.value.expected_worker_portrait_version,
      null,
    );
    assert.equal(
      reviewedBankReceiptOk.value.note,
      "Đã đối chiếu bill chuyển khoản khớp số tài khoản",
    );
  }

  // RETAKE_REQUIRED does not require portrait lock or note
  const retakeOk = parseReviewSalaryAdvanceEvidenceBody(
    {
      expected_version: 3,
      evidence_version: 1,
      decision: "RETAKE_REQUIRED",
    },
    IDEM_KEY,
  );
  assert.equal(retakeOk.ok, true);
  if (retakeOk.ok) {
    assert.equal(retakeOk.value.note, null);
    assert.equal(retakeOk.value.expected_worker_portrait_document_id, null);
    assert.equal(retakeOk.value.expected_worker_portrait_version, null);
  }
});

test("normalizeSalaryAdvancePersonName and isSelfOwnedBankAccountNameMatch normalize Vietnamese diacritics and enforce self-owned account matching", () => {
  assert.equal(
    normalizeSalaryAdvancePersonName("  Đặng   Thị  Hồng   Nhung "),
    "DANG THI HONG NHUNG",
  );
  assert.equal(
    isSelfOwnedBankAccountNameMatch("Đặng Thị Hồng Nhung", "DANG THI HONG NHUNG"),
    true,
  );
  assert.equal(
    isSelfOwnedBankAccountNameMatch("Nguyễn Văn A", "NGUYEN VAN B"),
    false,
  );
});

test("query and parameter parsers validate inputs strictly", () => {
  assert.equal(
    parseNoQueryParams(new URL("https://bi.local/api/salary-advance/context")).ok,
    true,
  );
  assert.equal(
    parseNoQueryParams(
      new URL("https://bi.local/api/salary-advance/context?extra=1"),
    ).ok,
    false,
  );

  const workersQuery = parseListProjectWorkersQuery(
    new URL(
      `https://bi.local/api/salary-advance/projects/PRJ_01/workers?search=NV01&page_size=20&cursor=NV001|${WORKER_ID}`,
    ),
  );
  assert.equal(workersQuery.ok, true);

  const listQuery = parseListSalaryAdvanceRequestsQuery(
    new URL(
      `https://bi.local/api/salary-advance/requests?queue=accountant&project_id=PRJ_01&request_state=approved&evidence_review_state=pending_review&page_size=10`,
    ),
  );
  assert.equal(listQuery.ok, true);
  if (listQuery.ok) {
    assert.equal(listQuery.value.queue, "ACCOUNTANT");
    assert.equal(listQuery.value.request_state, "APPROVED");
    assert.equal(listQuery.value.evidence_review_state, "PENDING_REVIEW");
  }

  const exportQuery = parseExportSalaryAdvanceRequestsQuery(
    new URL(
      `https://bi.local/api/salary-advance/requests/export?project_id=PRJ_01&request_state=approved&evidence_review_state=pending_review&search=NV001`,
    ),
  );
  assert.deepEqual(exportQuery, {
    ok: true,
    value: {
      project_id: "PRJ_01",
      request_state: "APPROVED",
      evidence_review_state: "PENDING_REVIEW",
      search: "NV001",
    },
  });
  assert.equal(
    parseExportSalaryAdvanceRequestsQuery(
      new URL("https://bi.local/api/salary-advance/requests/export?cursor=abc"),
    ).ok,
    false,
  );

  const portraitQuery = parseWorkerPortraitQuery(
    new URL(
      `https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-portrait?expected_document_id=${PORTRAIT_DOC_ID}`,
    ),
  );
  assert.deepEqual(portraitQuery, {
    ok: true,
    value: { expected_document_id: PORTRAIT_DOC_ID },
  });

  assert.equal(parseUuidParam(REQ_ID).ok, true);
  assert.equal(parseProjectIdParam("PRJ_NORTH-01").ok, true);
  assert.equal(parseEvidenceVersionParam("2").ok, true);
  assert.equal(parseEvidenceVersionParam("0").ok, false);
  assert.equal(parseIdempotencyKeyHeader(IDEM_KEY, "different-key").ok, false);
});

test("inspectSalaryAdvanceEvidenceContent validates JPEG/PNG magic bytes, trailers, polyglot payloads, and SHA-256", () => {
  const jpegBytes = makeValidJpegBytes();
  const jpegSha = sha256Hex(jpegBytes);
  assert.deepEqual(
    inspectSalaryAdvanceEvidenceContent({
      mime_type: "image/jpeg",
      expected_size_bytes: jpegBytes.byteLength,
      expected_checksum_sha256: jpegSha,
      bytes: jpegBytes,
    }),
    { ok: true, checksum_sha256: jpegSha },
  );

  const pngBytes = makeValidPngBytes();
  const pngSha = sha256Hex(pngBytes);
  assert.deepEqual(
    inspectSalaryAdvanceEvidenceContent({
      mime_type: "image/png",
      expected_size_bytes: pngBytes.byteLength,
      expected_checksum_sha256: pngSha,
      bytes: pngBytes,
    }),
    { ok: true, checksum_sha256: pngSha },
  );

  // Polyglot JPEG containing <script
  const polyglotJpeg = makeValidJpegBytes("<script>alert(1)</script>");
  assert.deepEqual(
    inspectSalaryAdvanceEvidenceContent({
      mime_type: "image/jpeg",
      expected_size_bytes: polyglotJpeg.byteLength,
      expected_checksum_sha256: sha256Hex(polyglotJpeg),
      bytes: polyglotJpeg,
    }),
    { ok: false, code: "SALARY_ADVANCE_EVIDENCE_CONTENT_INVALID" },
  );

  // Truncated PNG missing IEND trailer
  const truncatedPng = pngBytes.slice(0, pngBytes.byteLength - 2);
  assert.deepEqual(
    inspectSalaryAdvanceEvidenceContent({
      mime_type: "image/png",
      expected_size_bytes: truncatedPng.byteLength,
      expected_checksum_sha256: sha256Hex(truncatedPng),
      bytes: truncatedPng,
    }),
    { ok: false, code: "SALARY_ADVANCE_EVIDENCE_CONTENT_INVALID" },
  );

  // Checksum mismatch
  assert.deepEqual(
    inspectSalaryAdvanceEvidenceContent({
      mime_type: "image/jpeg",
      expected_size_bytes: jpegBytes.byteLength,
      expected_checksum_sha256: SHA_A,
      bytes: jpegBytes,
    }),
    { ok: false, code: "SALARY_ADVANCE_EVIDENCE_CHECKSUM_INVALID" },
  );

  // Disallowed MIME
  assert.deepEqual(
    inspectSalaryAdvanceEvidenceContent({
      mime_type: "application/pdf",
      expected_size_bytes: jpegBytes.byteLength,
      expected_checksum_sha256: jpegSha,
      bytes: jpegBytes,
    }),
    { ok: false, code: "SALARY_ADVANCE_EVIDENCE_MIME_INVALID" },
  );

  // Size mismatch or > 10MB
  assert.deepEqual(
    inspectSalaryAdvanceEvidenceContent({
      mime_type: "image/jpeg",
      expected_size_bytes: SALARY_ADVANCE_EVIDENCE_MAX_BYTES + 1,
      expected_checksum_sha256: jpegSha,
      bytes: jpegBytes,
    }),
    { ok: false, code: "SALARY_ADVANCE_EVIDENCE_SIZE_INVALID" },
  );
});

test("storage keys and R2 adapter enforce opaque key patterns and omit deleteFinal", () => {
  const key = buildSalaryAdvanceEvidenceStorageKey(REQ_ID, UPLOAD_ID);
  assert.equal(isOpaqueSalaryAdvanceEvidenceStorageKey(key), true);
  assert.equal(
    salaryAdvanceStagingObjectKey("staging", key),
    `staging/staging/${key}`,
  );
  assert.equal(
    salaryAdvanceFinalObjectKey("prod", key),
    `prod/final/${key}`,
  );

  const portraitKey = `p1.6/${WORKER_ID}/WORKER_PORTRAIT/1/${PORTRAIT_DOC_ID}`;
  assert.equal(isOpaqueWorkerPortraitStorageKey(portraitKey), true);
  assert.equal(
    isOpaqueWorkerPortraitStorageKey(
      `p1.6/${WORKER_ID}/CCCD_FRONT/1/${PORTRAIT_DOC_ID}`,
    ),
    false,
  );

  const storage = createR2SalaryAdvanceEvidenceStorage({});
  assert.equal(storage.available(), false);
  assert.equal("deleteFinal" in storage, false);
});

test("fingerprints and HTTP status mapping are deterministic", () => {
  const fp1 = computeCreateRequestFingerprint({
    project_id: "PRJ_1",
    worker_entry_id: WORKER_ID,
    requested_amount_vnd: "1000000",
    payment_method: "CASH",
    initial_content: "Tạm ứng",
  });
  const fp2 = computeCreateRequestFingerprint({
    project_id: "PRJ_1",
    worker_entry_id: WORKER_ID,
    requested_amount_vnd: "2000000",
    payment_method: "CASH",
    initial_content: "Tạm ứng",
  });
  const fp3 = computeCreateRequestFingerprint({
    project_id: "PRJ_1",
    worker_entry_id: WORKER_ID,
    requested_amount_vnd: "1000000",
    payment_method: "BANK_TRANSFER",
    initial_content: "Tạm ứng",
  });
  assert.notEqual(fp1, fp2);
  assert.notEqual(fp1, fp3);
  assert.equal(fp1.length, 64);

  assert.equal(
    computePostMessageFingerprint({
      request_id: REQ_ID,
      expected_version: 1,
      message_text: "ok",
    }).length,
    64,
  );
  assert.equal(
    computeTransitionRequestFingerprint({
      request_id: REQ_ID,
      action: "APPROVE",
      expected_version: 1,
      message_text: null,
    }).length,
    64,
  );
  assert.equal(
    computeReserveEvidenceFingerprint({
      request_id: REQ_ID,
      expected_version: 2,
      mime_type: "image/jpeg",
      size_bytes: 1024,
      checksum_sha256: SHA_A,
      caption_note: null,
    }).length,
    64,
  );
  assert.equal(
    computeFinalizeEvidenceFingerprint({
      request_id: REQ_ID,
      upload_id: UPLOAD_ID,
      expected_version: 2,
    }).length,
    64,
  );
  assert.equal(
    computeReviewEvidenceFingerprint({
      request_id: REQ_ID,
      expected_version: 3,
      evidence_version: 1,
      decision: "REVIEWED",
      expected_worker_portrait_document_id: PORTRAIT_DOC_ID,
      expected_worker_portrait_version: 1,
      note: null,
    }).length,
    64,
  );

  assert.equal(salaryAdvanceHttpStatusForError("UNAUTHENTICATED"), 401);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_ACCESS_DENIED"), 403);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_REQUEST_NOT_FOUND"), 404);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_VERSION_CONFLICT"), 409);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_UPLOAD_SUPERSEDED"), 409);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT"), 409);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_WORKER_INELIGIBLE_STATUS"), 409);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_WORKER_VENDOR_RECRUITED"), 409);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_WORKER_MULTI_PROJECT_ON"), 409);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_WORKER_DUPLICATE_CCCD"), 409);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_BANK_ACCOUNT_MISSING"), 409);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_BANK_ACCOUNT_NOT_SELF_OWNED"), 409);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_PAYMENT_METHOD_INVALID"), 400);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_EVIDENCE_CONTENT_INVALID"), 422);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_EXPORT_LIMIT_EXCEEDED"), 422);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_STORAGE_UNAVAILABLE"), 503);
  assert.equal(salaryAdvanceHttpStatusForError("SALARY_ADVANCE_EXPORT_INCOMPLETE"), 503);
  assert.equal(
    parseReserveSalaryAdvanceEvidenceBody(
      {
        expected_version: 2,
        mime_type: "image/jpeg",
        size_bytes: 1200,
        checksum_sha256: SHA_A,
      },
      IDEM_KEY,
    ).ok,
    true,
  );
  assert.equal(
    parseFinalizeSalaryAdvanceEvidenceBody({ expected_version: 2 }, IDEM_KEY).ok,
    true,
  );
  assert.equal(
    parsePostSalaryAdvanceMessageBody(
      { expected_version: 1, message_text: "Cần bổ sung" },
      IDEM_KEY,
    ).ok,
    true,
  );
});

test("parseListWorkerHistoryQuery validates THIS_MONTH, LAST_30_DAYS, MONTH, ALL, CUSTOM_RANGE, cursor, and page_size strictly", () => {
  // Default period_mode is THIS_MONTH
  const defaultRes = parseListWorkerHistoryQuery(
    new URL(`https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-history`),
  );
  assert.deepEqual(defaultRes, {
    ok: true,
    value: {
      period_mode: "THIS_MONTH",
      month: null,
      from_date: null,
      to_date: null,
      cursor: null,
      page_size: 20,
    },
  });

  // LAST_30_DAYS and ALL
  for (const mode of ["LAST_30_DAYS", "ALL"]) {
    const res = parseListWorkerHistoryQuery(
      new URL(
        `https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=${mode.toLowerCase()}&page_size=15`,
      ),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.period_mode, mode);
      assert.equal(res.value.page_size, 15);
    }
  }

  // MONTH requires valid YYYY-MM and rejects extra date params
  const monthOk = parseListWorkerHistoryQuery(
    new URL(
      `https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=MONTH&month=2026-10`,
    ),
  );
  assert.equal(monthOk.ok, true);
  if (monthOk.ok) {
    assert.equal(monthOk.value.period_mode, "MONTH");
    assert.equal(monthOk.value.month, "2026-10");
  }

  for (const badMonthUrl of [
    `https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=MONTH`,
    `https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=MONTH&month=2026-13`,
    `https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=MONTH&month=2026-00`,
    `https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=MONTH&month=10-2026`,
    `https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=THIS_MONTH&month=2026-10`,
  ]) {
    const res = parseListWorkerHistoryQuery(new URL(badMonthUrl));
    assert.equal(res.ok, false, `Expected ${badMonthUrl} to fail`);
  }

  // CUSTOM_RANGE requires valid calendar dates and from_date <= to_date
  const customOk = parseListWorkerHistoryQuery(
    new URL(
      `https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=CUSTOM_RANGE&from_date=2026-10-01&to_date=2026-10-30&cursor=2026-10-15T10:00:00Z|${REQ_ID}`,
    ),
  );
  assert.equal(customOk.ok, true);
  if (customOk.ok) {
    assert.equal(customOk.value.period_mode, "CUSTOM_RANGE");
    assert.equal(customOk.value.from_date, "2026-10-01");
    assert.equal(customOk.value.to_date, "2026-10-30");
    assert.equal(customOk.value.cursor, `2026-10-15T10:00:00Z|${REQ_ID}`);
  }

  for (const badRangeUrl of [
    `https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=CUSTOM_RANGE`,
    `https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=CUSTOM_RANGE&from_date=2026-10-30&to_date=2026-10-01`,
    `https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=CUSTOM_RANGE&from_date=2026-02-30&to_date=2026-03-01`,
    `https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=ALL&from_date=2026-10-01`,
    `https://bi.local/api/salary-advance/requests/${REQ_ID}/worker-history?period_mode=ALL&unknown=1`,
  ]) {
    const res = parseListWorkerHistoryQuery(new URL(badRangeUrl));
    assert.equal(res.ok, false, `Expected ${badRangeUrl} to fail`);
  }
});
