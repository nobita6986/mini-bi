import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PORTRAIT_HIDDEN_MESSAGE,
  PORTRAIT_IN_FLIGHT_MESSAGE,
  PORTRAIT_REPLACEMENT_REQUIRES_APPROVAL_MESSAGE,
  WORKER_PORTRAIT_MAX_BYTES,
  WORKER_PORTRAIT_STATUS_LABELS,
  checkWorkerPortraitFile,
  fetchWorkerDetail,
  projectWorkerDetail,
  projectWorkerPortrait,
  workerDocumentReady,
  workerDocumentStatusLabel,
  workerPortraitOriginLabel,
  workerPortraitPreviewUrl,
  workerPortraitUploadPolicy,
  workerPortraitUploadPolicyMessage,
  workerPortraitUploadUrl,
} from "./worker-detail-projection.ts";

const ENTRY_ID = "c2000000-0000-4000-8000-000000000001";
const DOC_A = "c2000000-0000-4000-8000-000000000002";
const DOC_B = "c2000000-0000-4000-8000-000000000003";

const CHECKSUM = "a".repeat(64);

function fullWorker() {
  return {
    display_name: "Nguyễn Văn A",
    gender: { state: "provided", value: "MALE" },
    date_of_birth: { state: "provided", value: "1990-01-01" },
    national_id: { state: "provided", value: "012345678901" },
    national_id_issued_at: { state: "provided", value: "2015-05-05" },
    national_id_issued_place: { state: "provided", value: "Hà Nội" },
    address: { state: "omitted" },
    phone: { state: "provided", value: "0900000000" },
  };
}

function redactedWorker() {
  return {
    display_name: { present: true },
    gender: { state: "provided" },
    date_of_birth: { state: "provided" },
    national_id: { state: "provided" },
    national_id_issued_at: { state: "provided" },
    national_id_issued_place: { state: "provided" },
    address: { state: "omitted" },
    phone: { state: "unknown" },
  };
}

function documentFixture(overrides = {}) {
  return {
    document_id: DOC_A,
    document_type: "CCCD_FRONT",
    version: 1,
    size_bytes: 1000,
    mime_type: "image/jpeg",
    upload_status: "READY",
    scan_status: "CLEAN",
    validation_status: "VALIDATED",
    ...overrides,
  };
}

function portraitFixture(overrides = {}) {
  return {
    origin: "ENROLLMENT",
    added_at: null,
    status: "READY",
    current: {
      document_id: DOC_A,
      version: 1,
      checksum_sha256: CHECKSUM,
      mime_type: "image/png",
      size_bytes: 2048,
    },
    ...overrides,
  };
}

function entryBody(overrides = {}) {
  return {
    ok: true,
    entry: {
      entry_id: ENTRY_ID,
      version: 3,
      worker_details: fullWorker(),
      employment_status: { status: "ON", effective_date: "2026-01-01", version: 2 },
      provider_type: "hrp",
      documents: [documentFixture()],
      worker_portrait: portraitFixture(),
      ...overrides,
    },
  };
}

test("projectWorkerDetail: entry hợp lệ được chiếu đầy đủ nhóm dữ liệu W2S1", () => {
  const detail = projectWorkerDetail(entryBody(), ENTRY_ID);
  assert.ok(detail);
  assert.equal(detail.entryId, ENTRY_ID);
  assert.equal(detail.entryVersion, 3);
  assert.equal(detail.providerType, "hrp");
  assert.equal(detail.providerLabel, "HRP");
  assert.equal(detail.employment.status, "ON");
  assert.equal(detail.employment.effective_date, "2026-01-01");
  assert.equal(detail.documents.length, 1);
  assert.equal(detail.worker.kind, "full");
  assert.equal(detail.worker.national_id, "012345678901");
  assert.equal(detail.worker.address, null);
  assert.ok(detail.portrait);
  assert.equal(detail.portrait.origin, "ENROLLMENT");
  assert.equal(detail.portrait.added_at, null);
  assert.equal(detail.portrait.current.document_id, DOC_A);
});

test("projectWorkerDetail: vendor được ghi nhãn từ server, không suy từ UI", () => {
  const detail = projectWorkerDetail(entryBody({ provider_type: "vendor" }), ENTRY_ID);
  assert.ok(detail);
  assert.equal(detail.providerType, "vendor");
  assert.equal(detail.providerLabel, "Vendor");
});

test("projectWorkerDetail: legacy redacted worker_details fail closed", () => {
  const detail = projectWorkerDetail(entryBody({ worker_details: redactedWorker() }), ENTRY_ID);
  assert.equal(detail, null);
});

test("projectWorkerDetail: thiếu document_view (worker_portrait null) vẫn chiếu được phần còn lại", () => {
  const detail = projectWorkerDetail(entryBody({ worker_portrait: null }), ENTRY_ID);
  assert.ok(detail);
  assert.equal(detail.portrait, null);
});

test("projectWorkerDetail: thiếu hẳn khóa worker_portrait => fail-closed", () => {
  const body = entryBody();
  delete body.entry.worker_portrait;
  assert.equal(projectWorkerDetail(body, ENTRY_ID), null);
});

test("projectWorkerPortrait: LEGACY_ADDED phải kèm added_at và không đổi thành ảnh nhập mới", () => {
  const portrait = projectWorkerPortrait(portraitFixture({
    origin: "LEGACY_ADDED",
    added_at: "2026-03-04T00:00:00.000Z",
  }));
  assert.ok(portrait);
  assert.equal(portrait.origin, "LEGACY_ADDED");
  assert.equal(workerPortraitOriginLabel(portrait.origin, portrait.added_at), "Ảnh bổ sung · 2026-03-04");
  assert.equal(projectWorkerPortrait(portraitFixture({ origin: "LEGACY_ADDED", added_at: null })), null);
});

test("projectWorkerPortrait: ENROLLMENT không được kèm added_at", () => {
  assert.equal(projectWorkerPortrait(portraitFixture({
    origin: "ENROLLMENT",
    added_at: "2026-03-04T00:00:00.000Z",
  })), null);
  assert.equal(workerPortraitOriginLabel("ENROLLMENT", null), "Ảnh nhập mới");
  assert.equal(workerPortraitOriginLabel(null, null), "Chưa xác định nguồn ảnh");
});

test("projectWorkerPortrait: current phải có origin và đúng bộ khóa (không nhận trường lạ)", () => {
  // Chưa có ảnh: origin null + current null là hợp lệ.
  assert.ok(projectWorkerPortrait({ origin: null, added_at: null, status: "MISSING", current: null }));
  // origin null nhưng có current => mâu thuẫn.
  assert.equal(projectWorkerPortrait(portraitFixture({ origin: null })), null);
  const withExtra = portraitFixture();
  withExtra.current = { ...withExtra.current, storage_key: "p1.6/secret" };
  assert.equal(projectWorkerPortrait(withExtra), null);
  const badChecksum = portraitFixture();
  badChecksum.current = { ...badChecksum.current, checksum_sha256: "not-a-hash" };
  assert.equal(projectWorkerPortrait(badChecksum), null);
  const badMime = portraitFixture();
  badMime.current = { ...badMime.current, mime_type: "application/pdf" };
  assert.equal(projectWorkerPortrait(badMime), null);
});

test("projectWorkerPortrait: trạng thái vòng đời phải nằm trong allow-list", () => {
  assert.ok(projectWorkerPortrait(portraitFixture({ status: "SCANNING" })));
  assert.equal(projectWorkerPortrait(portraitFixture({ status: "DONE" })), null);
  assert.equal(WORKER_PORTRAIT_STATUS_LABELS.FAILED, "Xử lý thất bại");
  assert.equal(WORKER_PORTRAIT_STATUS_LABELS.READY, "Sẵn sàng");
});

test("projectWorkerDetail: sai entry_id hoặc body sai hình dạng => null", () => {
  assert.equal(projectWorkerDetail(entryBody(), DOC_A), null);
  assert.equal(projectWorkerDetail({ ok: false }, ENTRY_ID), null);
  assert.equal(projectWorkerDetail(null, ENTRY_ID), null);
});

test("projectWorkerDetail: loại tài liệu ngoài allow-list (gồm WORKER_PORTRAIT) => null", () => {
  assert.equal(projectWorkerDetail(entryBody({
    documents: [documentFixture({ document_type: "WORKER_PORTRAIT" })],
  }), ENTRY_ID), null);
  assert.equal(projectWorkerDetail(entryBody({
    documents: [documentFixture({ document_type: "PASSPORT" })],
  }), ENTRY_ID), null);
});

test("projectWorkerDetail: trạng thái làm việc sai => null", () => {
  assert.equal(projectWorkerDetail(entryBody({
    employment_status: { status: "MAYBE", effective_date: "2026-01-01", version: 2 },
  }), ENTRY_ID), null);
  assert.equal(projectWorkerDetail(entryBody({
    employment_status: { status: "ON", effective_date: "01-01-2026", version: 2 },
  }), ENTRY_ID), null);
});

test("nhãn tình trạng hồ sơ chỉ READY + VALIDATED + (CLEAN|NOT_REQUIRED) là sẵn sàng", () => {
  assert.equal(workerDocumentReady(documentFixture()), true);
  assert.equal(workerDocumentReady(documentFixture({ scan_status: "NOT_REQUIRED" })), true);
  assert.equal(workerDocumentReady(documentFixture({ upload_status: "SCANNING" })), false);
  assert.equal(workerDocumentReady(documentFixture({ scan_status: "PENDING" })), false);
  assert.equal(workerDocumentStatusLabel("SCANNING"), "Đang kiểm tra");
  assert.equal(workerDocumentStatusLabel("không-có-nhãn"), "Không xác định");
});

test("URL preview là route same-origin riêng tư, không phải storage key hay signed URL", () => {
  assert.equal(
    workerPortraitPreviewUrl(ENTRY_ID, DOC_B),
    `/api/direct-entry/entries/${ENTRY_ID}/documents/${DOC_B}/preview`,
  );
  assert.equal(workerPortraitUploadUrl(ENTRY_ID), `/api/direct-entry/entries/${ENTRY_ID}/documents`);
  assert.equal(
    workerPortraitUploadUrl(ENTRY_ID, DOC_B),
    `/api/direct-entry/entries/${ENTRY_ID}/documents/${DOC_B}/finalize`,
  );
});

test("fetchWorkerDetail: đúng một GET tới entry detail, lỗi mạng/HTTP => null", async () => {
  const calls = [];
  const okDetail = await fetchWorkerDetail(ENTRY_ID, async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(entryBody()), { status: 200 });
  });
  assert.ok(okDetail);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/direct-entry/entries/${ENTRY_ID}`);
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.credentials, "same-origin");

  let deniedCalls = 0;
  assert.equal(await fetchWorkerDetail(ENTRY_ID, async () => {
    deniedCalls += 1;
    return new Response("{}", { status: 403 });
  }), null);
  assert.equal(deniedCalls, 1);

  assert.equal(await fetchWorkerDetail(ENTRY_ID, async () => {
    throw new Error("network down");
  }), null);
});

/**
 * Coverage MUC CODE cho 404/403: projection fail-closed va dialog hien trang thai loi + "Thu lai".
 * CHUA UAT voi tai khoan/ho so that — ghi ro trong handoff.
 */
test("fetchWorkerDetail: 404 (không tìm thấy/ngoài scope) và 403 đều fail-closed, không lộ dữ liệu", async () => {
  for (const status of [404, 403]) {
    let calls = 0;
    const result = await fetchWorkerDetail(ENTRY_ID, async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: false, code: "ENTRY_NOT_FOUND" }), { status });
    });
    assert.equal(result, null);
    assert.equal(calls, 1);
  }
  let malformedCalls = 0;
  assert.equal(await fetchWorkerDetail(ENTRY_ID, async () => {
    malformedCalls += 1;
    return new Response("not-json", { status: 200 });
  }), null);
  assert.equal(malformedCalls, 1);
});

test("checkWorkerPortraitFile: rỗng / sai MIME / vượt dung lượng đều bị từ chối trước khi gửi", () => {
  assert.deepEqual(checkWorkerPortraitFile(null), { ok: false, code: "DOCUMENT_FILE_REQUIRED" });
  assert.deepEqual(checkWorkerPortraitFile(undefined), { ok: false, code: "DOCUMENT_FILE_REQUIRED" });
  assert.deepEqual(checkWorkerPortraitFile({ size: 0, type: "image/png" }),
    { ok: false, code: "DOCUMENT_SIZE_INVALID" });
  assert.deepEqual(checkWorkerPortraitFile({ size: -1, type: "image/png" }),
    { ok: false, code: "DOCUMENT_SIZE_INVALID" });
  assert.deepEqual(checkWorkerPortraitFile({ size: WORKER_PORTRAIT_MAX_BYTES + 1, type: "image/jpeg" }),
    { ok: false, code: "DOCUMENT_SIZE_INVALID" });
  assert.deepEqual(checkWorkerPortraitFile({ size: 1024, type: "application/pdf" }),
    { ok: false, code: "DOCUMENT_MIME_INVALID" });
  assert.deepEqual(checkWorkerPortraitFile({ size: 1024, type: "" }),
    { ok: false, code: "DOCUMENT_MIME_INVALID" });
  assert.deepEqual(checkWorkerPortraitFile({ size: 1024, type: "image/jpeg" }),
    { ok: true, mimeType: "image/jpeg" });
  assert.deepEqual(checkWorkerPortraitFile({ size: WORKER_PORTRAIT_MAX_BYTES, type: "image/png" }),
    { ok: true, mimeType: "image/png" });
});

test("ảnh thay thế bị khoá: có current => không có đường upload thay thế", () => {
  const withCurrent = projectWorkerPortrait(portraitFixture());
  assert.ok(withCurrent);
  assert.deepEqual(workerPortraitUploadPolicy(withCurrent),
    { allow: false, reason: "REPLACEMENT_REQUIRES_APPROVAL" });
  assert.equal(workerPortraitUploadPolicyMessage("REPLACEMENT_REQUIRES_APPROVAL"),
    PORTRAIT_REPLACEMENT_REQUIRES_APPROVAL_MESSAGE);
  assert.match(PORTRAIT_REPLACEMENT_REQUIRES_APPROVAL_MESSAGE, /được duyệt/);
});

test("ảnh cũ vẫn là current cho tới khi ảnh mới được duyệt", () => {
  // Reserve/finalize ảnh mới thành công KHÔNG tự đổi current: server vẫn chỉ current là bản cũ,
  // còn ảnh mới chỉ ở vòng đời xử lý.
  const uploading = projectWorkerDetail(entryBody({
    worker_portrait: portraitFixture({ status: "SCANNING" }),
  }), ENTRY_ID);
  assert.ok(uploading);
  assert.equal(uploading.portrait.current.document_id, DOC_A);
  assert.equal(uploading.portrait.current.version, 1);
  assert.equal(uploading.portrait.status, "SCANNING");
  // Còn current cũ => khoá thay thế (mạnh hơn trạng thái đang xử lý).
  assert.deepEqual(workerPortraitUploadPolicy(uploading.portrait),
    { allow: false, reason: "REPLACEMENT_REQUIRES_APPROVAL" });

  // Kể cả khi ảnh mới đã READY, current do server trả về vẫn là bản cũ => vẫn không thay thế được.
  const readyOldCurrent = projectWorkerDetail(entryBody({
    worker_portrait: portraitFixture({
      status: "READY",
      current: { ...portraitFixture().current, document_id: DOC_B, version: 1 },
    }),
  }), ENTRY_ID);
  assert.ok(readyOldCurrent);
  assert.equal(readyOldCurrent.portrait.current.document_id, DOC_B);
  assert.deepEqual(workerPortraitUploadPolicy(readyOldCurrent.portrait),
    { allow: false, reason: "REPLACEMENT_REQUIRES_APPROVAL" });
});

test("chỉ cho gửi ảnh đầu tiên khi chưa có current", () => {
  const empty = { origin: null, added_at: null, status: "MISSING", current: null };
  assert.deepEqual(workerPortraitUploadPolicy(projectWorkerPortrait(empty)), { allow: true });
  assert.deepEqual(workerPortraitUploadPolicy(projectWorkerPortrait({ ...empty, status: "FAILED" })),
    { allow: true });
  for (const status of ["QUEUED", "UPLOADING", "QUARANTINED", "SCANNING"]) {
    const portrait = projectWorkerPortrait({ ...empty, status });
    assert.ok(portrait);
    assert.deepEqual(workerPortraitUploadPolicy(portrait), { allow: false, reason: "IN_FLIGHT" });
  }
  assert.equal(workerPortraitUploadPolicyMessage("IN_FLIGHT"),
    "Ảnh đã gửi đang được xử lý. Chờ kết quả trước khi gửi ảnh khác.");
});

test("QUARANTINED là đang xử lý: current null + QUARANTINED => IN_FLIGHT, không cho upload", () => {
  const portrait = projectWorkerPortrait({
    origin: null, added_at: null, status: "QUARANTINED", current: null,
  });
  assert.ok(portrait);
  assert.equal(portrait.status, "QUARANTINED");
  assert.equal(portrait.current, null);
  assert.deepEqual(workerPortraitUploadPolicy(portrait), { allow: false, reason: "IN_FLIGHT" });
  assert.equal(workerPortraitUploadPolicy(portrait).allow, false);
  assert.equal(workerPortraitUploadPolicyMessage("IN_FLIGHT"), PORTRAIT_IN_FLIGHT_MESSAGE);
  // Có current cũ thì khoá thay thế vẫn mạnh hơn trạng thái đang xử lý.
  assert.deepEqual(
    workerPortraitUploadPolicy(projectWorkerPortrait(portraitFixture({ status: "QUARANTINED" }))),
    { allow: false, reason: "REPLACEMENT_REQUIRES_APPROVAL" });
});

test("workerPortraitUploadPolicy: thiếu document_view (portrait null) => HIDDEN, không upload", () => {
  assert.deepEqual(workerPortraitUploadPolicy(null), { allow: false, reason: "HIDDEN" });
  assert.equal(workerPortraitUploadPolicyMessage("HIDDEN"), PORTRAIT_HIDDEN_MESSAGE);
});
