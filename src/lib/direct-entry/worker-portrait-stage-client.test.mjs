import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PORTRAIT_PROMOTION_PENDING_MESSAGE,
  PORTRAIT_PROMOTION_UNSAVED_MESSAGE,
  PORTRAIT_STAGE_ENDPOINT,
  PORTRAIT_STAGE_ORPHAN_MESSAGE,
  PORTRAIT_STAGE_RECOVER_ENDPOINT,
  cancelWorkerPortraitStage,
  portraitPromotionState,
  portraitStageErrorMessage,
  projectPortraitStage,
  projectPortraitStageRecovery,
  recoverWorkerPortraitStage,
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
    const result = await stageWorkerPortrait({ file, fetchImpl });
    assert.deepEqual(result, { kind: "rejected", code });
  }
  assert.equal(calls, 0, "khong duoc gui tep khong hop le len may chu");
});

test("stageWorkerPortrait: multipart dung MOT field `file`, khong gui truong authority", async () => {
  const calls = [];
  const result = await stageWorkerPortrait({
    file: portraitFile(),
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
  const body = calls[0].init.body;
  assert.ok(body instanceof FormData);
  assert.deepEqual([...body.keys()], ["file"]);
  assert.ok(body.get("file") instanceof File);
  assert.equal(calls[0].init.headers, undefined, "khong tu dat header authority/idempotency cho stage");
});

test("stageWorkerPortrait: loi mang/5xx/2xx khong doc duoc => retry (khong bao thanh cong)", async () => {
  assert.deepEqual(await stageWorkerPortrait({
    file: portraitFile(),
    fetchImpl: async () => { throw new Error("down"); },
  }), { kind: "retry", code: "PORTRAIT_STAGE_NETWORK" });
  assert.deepEqual(await stageWorkerPortrait({
    file: portraitFile(),
    fetchImpl: async () => Response.json({ ok: false, code: "PORTRAIT_STAGE_UNAVAILABLE" }, { status: 503 }),
  }), { kind: "retry", code: "PORTRAIT_STAGE_UNAVAILABLE" });
  assert.deepEqual(await stageWorkerPortrait({
    file: portraitFile(),
    fetchImpl: async () => new Response("not-json", { status: 201 }),
  }), { kind: "retry", code: "PORTRAIT_STAGE_RESPONSE_INVALID" });
  assert.deepEqual(await stageWorkerPortrait({
    file: portraitFile(),
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
