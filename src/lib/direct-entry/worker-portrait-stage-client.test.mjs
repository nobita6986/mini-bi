import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_PORTRAIT_STAGE_LIFECYCLE,
  INVALIDATED_PORTRAIT_BINDING,
  PORTRAIT_PROMOTION_PENDING_MESSAGE,
  PORTRAIT_PROMOTION_UNSAVED_MESSAGE,
  PORTRAIT_STAGE_ENDPOINT,
  PORTRAIT_STAGE_ORPHAN_MESSAGE,
  PORTRAIT_STAGE_RECOVER_ENDPOINT,
  cancelWorkerPortraitStage,
  portraitPromotionState,
  portraitRowBinding,
  portraitStageErrorMessage,
  projectPortraitStage,
  projectPortraitStageRecovery,
  recoverWorkerPortraitStage,
  reducePortraitStageLifecycle,
  selectBindablePortraitStages,
  selectOrphanPortraitStages,
  selectStalePortraitStages,
  stageWorkerPortrait,
} from "./worker-portrait-stage-client.ts";
import { checkWorkerPortraitFile } from "./worker-detail-projection.ts";

const STAGE_ID = "a1000000-0000-4000-8000-000000000001";
const OTHER_ID = "a1000000-0000-4000-8000-000000000002";
const KEY = "b1000000-0000-4000-8000-000000000001";

function portraitFile(bytes = 1024, type = "image/png", name = "p.png") {
  return new File([new Uint8Array(bytes)], name, { type });
}

test("projectPortraitStage: chi nhan projection STAGED hop le, fail closed nguoc lai", () => {
  const ok = projectPortraitStage({
    ok: true, stage_id: STAGE_ID, mime_type: "image/png", size_bytes: 1024, status: "STAGED",
  });
  assert.deepEqual(ok, {
    kind: "staged", stageId: STAGE_ID, mimeType: "image/png", sizeBytes: 1024,
  });
  assert.equal(projectPortraitStage({
    ok: true, stage_id: "not-a-uuid", mime_type: "image/png", size_bytes: 1, status: "STAGED",
  }), null);
  assert.equal(projectPortraitStage({
    ok: true, stage_id: STAGE_ID, mime_type: "application/pdf", size_bytes: 1, status: "STAGED",
  }), null);
  assert.equal(projectPortraitStage({
    ok: true, stage_id: STAGE_ID, mime_type: "image/png", size_bytes: 0, status: "STAGED",
  }), null);
  assert.equal(projectPortraitStage({
    ok: true, stage_id: STAGE_ID, mime_type: "image/png", size_bytes: 1, status: "CLAIMED",
  }), null);
  assert.equal(projectPortraitStage({ ok: false, code: "DOCUMENT_DENIED" }), null);
});

test("stageWorkerPortrait: tep rong/sai MIME/vuot dung luong bi tu choi TRUOC khi goi mang", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response("{}", { status: 201 }); };
  for (const [file, code] of [
    [null, "DOCUMENT_FILE_REQUIRED"],
    [portraitFile(0), "DOCUMENT_SIZE_INVALID"],
    [portraitFile(11 * 1024 * 1024), "DOCUMENT_SIZE_INVALID"],
    [portraitFile(1024, "application/pdf", "x.pdf"), "DOCUMENT_MIME_INVALID"],
  ]) {
    const result = await stageWorkerPortrait({ file, idempotencyKey: KEY, fetchImpl });
    assert.deepEqual(result, { kind: "rejected", code });
  }
  assert.equal(calls, 0, "khong duoc gui tep khong hop le len may chu");
  assert.deepEqual(await stageWorkerPortrait({
    file: portraitFile(), idempotencyKey: "invalid", fetchImpl,
  }), { kind: "rejected", code: "IDEMPOTENCY_KEY_INVALID" });
  assert.equal(calls, 0);
});

test("stageWorkerPortrait: multipart dung MOT field `file`, khong gui truong authority", async () => {
  const calls = [];
  const result = await stageWorkerPortrait({
    file: portraitFile(),
    idempotencyKey: KEY,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        ok: true, stage_id: STAGE_ID, mime_type: "image/png", size_bytes: 1024, status: "STAGED",
      }, { status: 201 });
    },
  });
  assert.equal(result.kind, "staged");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PORTRAIT_STAGE_ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.deepEqual(calls[0].init.headers, { "Idempotency-Key": KEY });
  const body = calls[0].init.body;
  assert.ok(body instanceof FormData);
  assert.deepEqual([...body.keys()], ["file"]);
  assert.ok(body.get("file") instanceof File);
  assert.equal("Content-Type" in calls[0].init.headers, false,
    "browser sets the multipart boundary; no authority fields are sent");
});

test("stageWorkerPortrait: loi mang/5xx/2xx khong doc duoc => retry (khong bao thanh cong)", async () => {
  assert.deepEqual(await stageWorkerPortrait({
    file: portraitFile(),
    idempotencyKey: KEY,
    fetchImpl: async () => { throw new Error("down"); },
  }), { kind: "retry", code: "PORTRAIT_STAGE_NETWORK" });
  assert.deepEqual(await stageWorkerPortrait({
    file: portraitFile(),
    idempotencyKey: KEY,
    fetchImpl: async () => Response.json({ ok: false, code: "PORTRAIT_STAGE_UNAVAILABLE" }, { status: 503 }),
  }), { kind: "retry", code: "PORTRAIT_STAGE_UNAVAILABLE" });
  assert.deepEqual(await stageWorkerPortrait({
    file: portraitFile(),
    idempotencyKey: KEY,
    fetchImpl: async () => new Response("not-json", { status: 201 }),
  }), { kind: "retry", code: "PORTRAIT_STAGE_RESPONSE_INVALID" });
  assert.deepEqual(await stageWorkerPortrait({
    file: portraitFile(),
    idempotencyKey: KEY,
    fetchImpl: async () => Response.json({ ok: false, code: "DOCUMENT_DENIED" }, { status: 403 }),
  }), { kind: "rejected", code: "DOCUMENT_DENIED" });
});

test("cancelWorkerPortraitStage: DELETE JSON chi co stage_id; 404/409 la khong huy duoc", async () => {
  const calls = [];
  const cancelled = await cancelWorkerPortraitStage({
    stageId: STAGE_ID,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 204 }); },
  });
  assert.deepEqual(cancelled, { kind: "cancelled" });
  assert.equal(calls[0].url, PORTRAIT_STAGE_ENDPOINT);
  assert.equal(calls[0].init.method, "DELETE");
  assert.deepEqual(JSON.parse(calls[0].init.body), { stage_id: STAGE_ID });
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)), ["stage_id"]);

  const notMine = await cancelWorkerPortraitStage({
    stageId: STAGE_ID,
    fetchImpl: async () => Response.json({ ok: false, code: "ENTRY_NOT_FOUND" }, { status: 404 }),
  });
  assert.deepEqual(notMine, { kind: "not-cancellable", code: "ENTRY_NOT_FOUND" });
  const claimed = await cancelWorkerPortraitStage({
    stageId: STAGE_ID,
    fetchImpl: async () => Response.json({ ok: false, code: "DOCUMENT_VERSION_CONFLICT" }, { status: 409 }),
  });
  assert.deepEqual(claimed, { kind: "not-cancellable", code: "DOCUMENT_VERSION_CONFLICT" });

  let badCalls = 0;
  const bad = await cancelWorkerPortraitStage({
    stageId: "nope",
    fetchImpl: async () => { badCalls += 1; return new Response(null, { status: 204 }); },
  });
  assert.deepEqual(bad, { kind: "rejected", code: "PORTRAIT_STAGE_ID_INVALID" });
  assert.equal(badCalls, 0);
});

test("projectPortraitStageRecovery: chi CLAIMED moi co idempotency_key", () => {
  assert.deepEqual(projectPortraitStageRecovery({
    ok: true, stage_id: STAGE_ID, status: "STAGED", idempotency_key: null,
  }), { stageId: STAGE_ID, status: "STAGED", idempotencyKey: null });
  assert.deepEqual(projectPortraitStageRecovery({
    ok: true, stage_id: STAGE_ID, status: "CLAIMED", idempotency_key: KEY,
  }), { stageId: STAGE_ID, status: "CLAIMED", idempotencyKey: KEY });
  // CLAIMED ma thieu key, hoac khong CLAIMED ma co key => fail closed.
  assert.equal(projectPortraitStageRecovery({
    ok: true, stage_id: STAGE_ID, status: "CLAIMED", idempotency_key: null,
  }), null);
  assert.equal(projectPortraitStageRecovery({
    ok: true, stage_id: STAGE_ID, status: "STAGED", idempotency_key: KEY,
  }), null);
  assert.equal(projectPortraitStageRecovery({
    ok: true, stage_id: OTHER_ID, status: "WEIRD", idempotency_key: null,
  }), null);
});

test("recoverWorkerPortraitStage: POST recover; loi/khong doc duoc => retry", async () => {
  const calls = [];
  const recovered = await recoverWorkerPortraitStage({
    stageId: STAGE_ID,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        ok: true, stage_id: STAGE_ID, status: "CLAIMED", idempotency_key: KEY,
      }, { status: 200 });
    },
  });
  assert.deepEqual(recovered, {
    kind: "recovered",
    recovery: { stageId: STAGE_ID, status: "CLAIMED", idempotencyKey: KEY },
  });
  assert.equal(calls[0].url, PORTRAIT_STAGE_RECOVER_ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { stage_id: STAGE_ID });

  for (const status of [404, 409, 503]) {
    const result = await recoverWorkerPortraitStage({
      stageId: STAGE_ID,
      fetchImpl: async () => Response.json({ ok: false, code: "X" }, { status }),
    });
    assert.equal(result.kind, "retry");
  }
  assert.equal((await recoverWorkerPortraitStage({
    stageId: STAGE_ID,
    fetchImpl: async () => new Response("nope", { status: 200 }),
  })).kind, "retry");
});

test("portraitPromotionState: ho so da luu nhung promote chua xong la CLAIMED => pending", () => {
  assert.equal(portraitPromotionState({ stageId: STAGE_ID, status: "ATTACHED", idempotencyKey: null }),
    "attached");
  assert.equal(portraitPromotionState({ stageId: STAGE_ID, status: "CLAIMED", idempotencyKey: KEY }),
    "pending");
  assert.equal(portraitPromotionState({ stageId: STAGE_ID, status: "STAGED", idempotencyKey: null }),
    "unsaved");
  assert.equal(portraitPromotionState({ stageId: STAGE_ID, status: "CANCELLED", idempotencyKey: null }),
    "cancelled");
  assert.match(PORTRAIT_PROMOTION_PENDING_MESSAGE, /đã được lưu/);
  assert.match(PORTRAIT_PROMOTION_PENDING_MESSAGE, /cùng yêu cầu/);
  assert.match(PORTRAIT_PROMOTION_UNSAVED_MESSAGE, /Chưa xác định/);
  assert.match(PORTRAIT_STAGE_ORPHAN_MESSAGE, /dọn/);
});

test("thong bao loi lay dung nguon, khong lo chi tiet ky thuat", () => {
  assert.equal(portraitStageErrorMessage("DOCUMENT_DENIED"), "Bạn không có quyền tải ảnh hồ sơ.");
  assert.match(portraitStageErrorMessage("PORTRAIT_STAGE_NETWORK"), /thử lại/);
  assert.equal(portraitStageErrorMessage("MA_LA"), "Không xử lý được ảnh hồ sơ. Hãy thử lại.");
});

test("dung chung ham kiem tra tep voi portrait panel (mot nguon duy nhat)", () => {
  assert.deepEqual(checkWorkerPortraitFile(portraitFile(1024, "image/jpeg")),
    { ok: true, mimeType: "image/jpeg" });
  assert.deepEqual(checkWorkerPortraitFile(null), { ok: false, code: "DOCUMENT_FILE_REQUIRED" });
});

/* ------------------------------- rang buoc stage ↔ dong (khong theo vi tri) */

function identity(overrides = {}) {
  return {
    rowKey: "1",
    employeeCode: "hrp-2026-000001",
    displayName: "Nguyễn Văn A",
    firstWorkDate: "2026-01-05",
    projectId: "p1",
    recruiterId: "r1",
    laborType: "FULL_TIME",
    nationalId: "012345678901",
    dateOfBirth: "1990-01-01",
    phone: "0900000000",
    ...overrides,
  };
}

test("portraitRowBinding: doi noi dung hoac doi vi tri deu doi binding", () => {
  const base = portraitRowBinding(identity());
  assert.equal(portraitRowBinding(identity()), base, "cung noi dung => cung binding");
  for (const changed of [
    { displayName: "Nguyễn Văn B" },
    { nationalId: "012345678902" },
    { employeeCode: "hrp-2026-000002" },
    { projectId: "p2" },
    { recruiterId: "r2" },
    { firstWorkDate: "2026-02-01" },
    { dateOfBirth: "1991-01-01" },
    { phone: "0911111111" },
    { rowKey: "2" },
  ]) {
    assert.notEqual(portraitRowBinding(identity(changed)), base,
      "binding phai doi khi " + JSON.stringify(changed));
  }
  // Binding khong chua PII dang doc duoc.
  for (const secret of ["Nguyễn Văn A", "012345678901", "0900000000"]) {
    assert.equal(base.includes(secret), false);
  }
});

test("REGRESSION: stage A staged cho dong A, doi dong thanh NLD B => batch KHONG chua stage A cho B", () => {
  const bindingA = portraitRowBinding(identity({ displayName: "Nguyễn Văn A" }));
  const bindingB = portraitRowBinding(identity({ displayName: "Nguyễn Văn B" }));
  const slots = new Map([["1", { binding: bindingA, status: "staged", stageId: STAGE_ID }]]);

  // Dong 1 van la A => duoc gui.
  assert.deepEqual([...selectBindablePortraitStages({
    rowBindings: new Map([["1", bindingA]]), slots,
  })], [["1", STAGE_ID]]);

  // Dong 1 bi sua/thay bang B => stage A KHONG duoc gui cho B, va bi coi la cu de don.
  const rowBindingsB = new Map([["1", bindingB]]);
  assert.deepEqual([...selectBindablePortraitStages({ rowBindings: rowBindingsB, slots })], []);
  assert.deepEqual(selectStalePortraitStages({ rowBindings: rowBindingsB, slots }),
    [{ rowKey: "1", stageId: STAGE_ID }]);

  // Sap xep lai: noi dung A chuyen sang dong 2 => dong 1 khong con khop => khong gui; stage cu bi don.
  const reordered = new Map([["2", bindingA]]);
  assert.deepEqual([...selectBindablePortraitStages({ rowBindings: reordered, slots })], []);
  assert.deepEqual(selectStalePortraitStages({ rowBindings: reordered, slots }),
    [{ rowKey: "1", stageId: STAGE_ID }]);

  // Xoa het du lieu (preview null) => khong con dong nao khop => stage cu bi don.
  assert.deepEqual(selectStalePortraitStages({ rowBindings: new Map(), slots }),
    [{ rowKey: "1", stageId: STAGE_ID }]);
});

test("selectBindablePortraitStages: chi slot da stage moi duoc gui; staging/error khong gui", () => {
  const binding = portraitRowBinding(identity());
  const rowBindings = new Map([["1", binding]]);
  assert.deepEqual([...selectBindablePortraitStages({
    rowBindings,
    slots: new Map([["1", { binding, status: "staging", stageId: null }]]),
  })], []);
  assert.deepEqual([...selectBindablePortraitStages({
    rowBindings,
    slots: new Map([["1", { binding, status: "error", stageId: null }]]),
  })], []);
  // Slot chua co stageId (chua tao xong) khong duoc gui va cung khong co gi de don.
  assert.deepEqual(selectStalePortraitStages({
    rowBindings,
    slots: new Map([["1", { binding: "khac", status: "staging", stageId: null }]]),
  }), []);
});

/* --------------------- vòng đời stage: hành vi của reducer (không mất ID) */

const REQ_A = "request-a";
const REQ_B = "request-b";
const STAGE_B = "a1000000-0000-4000-8000-000000000002";

function runLifecycle(actions) {
  return actions.reduce(reducePortraitStageLifecycle, EMPTY_PORTRAIT_STAGE_LIFECYCLE);
}

function stagedActions(sourceRow, binding, requestId = REQ_A, stageId = STAGE_ID) {
  const rowKey = String(sourceRow);
  return [
    { kind: "stage-start", rowKey, binding, requestId },
    {
      kind: "stage-result", rowKey, requestId,
      result: { kind: "staged", stageId, sizeBytes: 2048 },
    },
  ];
}

test("HÀNH VI: stage thành công thì bindable; xác nhận hủy mới xóa ID", () => {
  const binding = portraitRowBinding(identity());
  let state = runLifecycle(stagedActions(1, binding));
  assert.equal(state.slots.get("1").status, "staged");
  assert.deepEqual([...selectBindablePortraitStages({
    rowBindings: new Map([["1", binding]]), slots: state.slots,
  })], [["1", STAGE_ID]]);

  state = runLifecycle([
    ...stagedActions(1, binding),
    { kind: "cancel-result", rowKey: "1", stageId: STAGE_ID, confirmed: true },
  ]);
  assert.equal(state.slots.size, 0, "da xac nhan huy => duoc xoa ID khoi state");
});

test("HÀNH VI: DELETE lỗi (retry) KHÔNG xóa ID; giữ state để thử dọn lại", () => {
  const binding = portraitRowBinding(identity());
  const state = runLifecycle([
    ...stagedActions(1, binding),
    { kind: "invalidate" },
    { kind: "cancel-result", rowKey: "1", stageId: STAGE_ID, confirmed: false },
  ]);
  const slot = state.slots.get("1");
  assert.equal(slot.status, "stale");
  assert.equal(slot.stageId, STAGE_ID, "khong duoc lam mat stage ID khi DELETE loi");
  assert.equal(slot.binding, INVALIDATED_PORTRAIT_BINDING);
  assert.deepEqual([...selectBindablePortraitStages({
    rowBindings: new Map([["1", binding]]), slots: state.slots,
  })], []);
  assert.deepEqual(selectStalePortraitStages({
    rowBindings: new Map([["1", binding]]), slots: state.slots,
  }), [{ rowKey: "1", stageId: STAGE_ID }], "van phai con de thu don lai");
});

test("HÀNH VI: đóng dialog vô hiệu hóa binding ngay nhưng giữ ID khi chưa hủy xong", () => {
  const binding = portraitRowBinding(identity());
  const state = runLifecycle([...stagedActions(1, binding), { kind: "invalidate" }]);
  assert.equal(state.epoch, 1, "moi lan dong/doi du lieu la mot epoch moi");
  assert.equal(state.slots.get("1").status, "stale");
  assert.equal(state.slots.get("1").stageId, STAGE_ID);
  assert.deepEqual([...selectBindablePortraitStages({
    rowBindings: new Map([["1", binding]]), slots: state.slots,
  })], []);
});

test("HÀNH VI: kết quả về muộn sau invalidate vào danh sách cleanup riêng, không ghi đè slot", () => {
  const binding = portraitRowBinding(identity());
  const lateOk = runLifecycle([
    { kind: "stage-start", rowKey: "3", binding, requestId: REQ_A },
    { kind: "invalidate" },
    {
      kind: "stage-result", rowKey: "3", requestId: REQ_A,
      result: { kind: "staged", stageId: STAGE_ID, sizeBytes: 1024 },
    },
  ]);
  assert.equal(lateOk.slots.has("3"), false, "khong tao/ghi de slot nao");
  assert.deepEqual([...selectOrphanPortraitStages(lateOk)],
    [{ stageId: STAGE_ID, sizeBytes: 1024 }]);
  assert.deepEqual([...selectBindablePortraitStages({
    rowBindings: new Map([["3", binding]]), slots: lateOk.slots,
  })], []);

  const lateError = runLifecycle([
    { kind: "stage-start", rowKey: "4", binding: portraitRowBinding(identity({ rowKey: "4" })), requestId: REQ_A },
    { kind: "invalidate" },
    {
      kind: "stage-result", rowKey: "4", requestId: REQ_A,
      result: { kind: "error", code: "PORTRAIT_STAGE_NETWORK" },
    },
  ]);
  assert.equal(lateError.slots.has("4"), false);
  assert.deepEqual([...selectOrphanPortraitStages(lateError)], []);
});

test("HÀNH VI: orphan chỉ bị xóa khỏi cleanup khi đã hủy/xác định cuối", () => {
  const binding = portraitRowBinding(identity());
  const base = [
    { kind: "stage-start", rowKey: "1", binding, requestId: REQ_A },
    { kind: "invalidate" },
    {
      kind: "stage-result", rowKey: "1", requestId: REQ_A,
      result: { kind: "staged", stageId: STAGE_ID, sizeBytes: 1 },
    },
  ];
  const kept = runLifecycle([...base, { kind: "orphan-cancel-result", stageId: STAGE_ID, confirmed: false }]);
  assert.deepEqual([...selectOrphanPortraitStages(kept)], [{ stageId: STAGE_ID, sizeBytes: 1 }]);
  const cleared = runLifecycle([...base, { kind: "orphan-cancel-result", stageId: STAGE_ID, confirmed: true }]);
  assert.deepEqual([...selectOrphanPortraitStages(cleared)], []);
});

test("RACE: upload A đang chạy → invalidate → dán lại cùng dòng + upload B → A về sau không ghi đè B", () => {
  const binding = portraitRowBinding(identity()); // dán lại Y HỆT => binding trùng lại
  const afterA = runLifecycle([
    { kind: "stage-start", rowKey: "1", binding, requestId: REQ_A },
    { kind: "invalidate" },
    { kind: "stage-start", rowKey: "1", binding, requestId: REQ_B },
  ]);
  assert.equal(afterA.slots.get("1").requestId, REQ_B);
  assert.equal(afterA.slots.get("1").status, "staging");

  // Response A ve SAU: khong khop requestId => vao cleanup, KHONG dung vao slot cua B.
  const afterLateA = runLifecycle([
    { kind: "stage-start", rowKey: "1", binding, requestId: REQ_A },
    { kind: "invalidate" },
    { kind: "stage-start", rowKey: "1", binding, requestId: REQ_B },
    {
      kind: "stage-result", rowKey: "1", requestId: REQ_A,
      result: { kind: "staged", stageId: STAGE_ID, sizeBytes: 1 },
    },
  ]);
  assert.equal(afterLateA.slots.get("1").status, "staging", "B van dang chay, khong bi A ghi de");
  assert.equal(afterLateA.slots.get("1").requestId, REQ_B);
  assert.equal(afterLateA.slots.get("1").stageId, null);
  assert.deepEqual([...selectOrphanPortraitStages(afterLateA)], [{ stageId: STAGE_ID, sizeBytes: 1 }]);

  // B ve sau => B la stage duy nhat bindable.
  const done = runLifecycle([
    { kind: "stage-start", rowKey: "1", binding, requestId: REQ_A },
    { kind: "invalidate" },
    { kind: "stage-start", rowKey: "1", binding, requestId: REQ_B },
    {
      kind: "stage-result", rowKey: "1", requestId: REQ_A,
      result: { kind: "staged", stageId: STAGE_ID, sizeBytes: 1 },
    },
    {
      kind: "stage-result", rowKey: "1", requestId: REQ_B,
      result: { kind: "staged", stageId: STAGE_B, sizeBytes: 2 },
    },
  ]);
  assert.deepEqual([...selectBindablePortraitStages({
    rowBindings: new Map([["1", binding]]), slots: done.slots,
  })], [["1", STAGE_B]]);
  assert.deepEqual([...selectOrphanPortraitStages(done)], [{ stageId: STAGE_ID, sizeBytes: 1 }]);
});

test("RACE (thứ tự ngược): B về trước rồi A về sau => giữ B, A vào cleanup", () => {
  const binding = portraitRowBinding(identity());
  const state = runLifecycle([
    { kind: "stage-start", rowKey: "1", binding, requestId: REQ_A },
    { kind: "invalidate" },
    { kind: "stage-start", rowKey: "1", binding, requestId: REQ_B },
    {
      kind: "stage-result", rowKey: "1", requestId: REQ_B,
      result: { kind: "staged", stageId: STAGE_B, sizeBytes: 2 },
    },
    {
      kind: "stage-result", rowKey: "1", requestId: REQ_A,
      result: { kind: "staged", stageId: STAGE_ID, sizeBytes: 1 },
    },
  ]);
  assert.equal(state.slots.get("1").status, "staged");
  assert.equal(state.slots.get("1").stageId, STAGE_B, "A khong duoc ghi de B");
  assert.deepEqual([...selectBindablePortraitStages({
    rowBindings: new Map([["1", binding]]), slots: state.slots,
  })], [["1", STAGE_B]]);
  assert.deepEqual([...selectOrphanPortraitStages(state)], [{ stageId: STAGE_ID, sizeBytes: 1 }]);
});
