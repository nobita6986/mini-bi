import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildServerGeneratedFullProfileRequestBody,
} from "../../../src/lib/direct-entry/full-profile-batch.ts";
import {
  EMPTY_PORTRAIT_STAGE_LIFECYCLE,
  buildPortraitRowBindings,
  buildPortraitStageIdsBySourceRow,
  portraitPromotionState,
  reducePortraitStageLifecycle,
  selectBindablePortraitStages,
  selectOrphanPortraitStages,
  selectStalePortraitStages,
  stageWorkerPortrait,
} from "../../../src/lib/direct-entry/worker-portrait-stage-client.ts";

const live = readFileSync(
  new URL("./direct-entry-live.tsx", import.meta.url), "utf8");
const hook = readFileSync(
  new URL("./use-worker-portrait-stages.ts", import.meta.url), "utf8");
const slot = readFileSync(
  new URL("./worker-portrait-stage-slot.tsx", import.meta.url), "utf8");

const STAGE_A = "a1000000-0000-4000-8000-000000000001";
const STAGE_B = "a1000000-0000-4000-8000-000000000002";
const KEY = "b1000000-0000-4000-8000-000000000001";
const REQ_A = "request-a";
const REQ_B = "request-b";

/* ----------------------------------------------------------- fixtures */

function previewRow(sourceRow, overrides = {}) {
  return {
    sourceRow,
    row: {
      employee_code: overrides.employee_code ?? "hrp-2026-000001",
      display_name: overrides.display_name ?? "Nguyễn Văn A",
      first_work_date: "2026-01-05",
      labor_type: "FULL_TIME",
      worker: {
        gender: { state: "omitted" },
        national_id: { state: "provided", value: overrides.national_id ?? "012345678901" },
        national_id_issued_at: { state: "omitted" },
        national_id_issued_place: { state: "omitted" },
        date_of_birth: { state: "provided", value: "1990-01-01" },
        address: { state: "omitted" },
        phone: { state: "provided", value: "0900000000" },
      },
      general_note: { state: "omitted" },
      payment: {
        account_number: { state: "omitted" },
        bank_name: { state: "omitted" },
        account_holder_name: { state: "omitted" },
      },
      employment: {
        initial_status: { state: "omitted" },
        leave_date: { state: "omitted" },
        leave_reason_text: { state: "omitted" },
      },
    },
    resolved: { project_id: "p1", recruiter_id: "r1", provider_type: "hrp" },
  };
}

/** Hai dong cua bang nhap nhieu dong, khoa on dinh clientRowId. */
function liveRows() {
  return {
    rows: [{ clientRowId: "row-a" }, { clientRowId: "row-b" }],
    previewRows: [previewRow(1), previewRow(2, { display_name: "Nguyễn Văn B" })],
  };
}

function runLifecycle(actions) {
  return actions.reduce(reducePortraitStageLifecycle, EMPTY_PORTRAIT_STAGE_LIFECYCLE);
}

function stagedActions(rowKey, binding, requestId, stageId) {
  return [
    { kind: "stage-start", rowKey, binding, requestId },
    {
      kind: "stage-result", rowKey, requestId,
      result: { kind: "staged", stageId, sizeBytes: 2048 },
    },
  ];
}

/** Payload THAT SU gui len cho luong nhap truc tiep. */
function livePayload(rows, previewRows, state) {
  const bindings = buildPortraitRowBindings({ rows, previewRows });
  const bindable = selectBindablePortraitStages({ rowBindings: bindings, slots: state.slots });
  const stageIds = buildPortraitStageIdsBySourceRow({
    bindableStageIds: bindable, rows, previewRows,
  });
  return buildServerGeneratedFullProfileRequestBody(previewRows, stageIds);
}

/* ------------------------------------------------- gắn ảnh đúng dòng */

test("LIVE bảng nhiều dòng: ảnh chỉ gắn đúng dòng đã stage", () => {
  const { rows, previewRows } = liveRows();
  const bindings = buildPortraitRowBindings({ rows, previewRows });
  const state = runLifecycle(stagedActions(
    "row-a", bindings.get("row-a"), REQ_A, STAGE_A));

  const body = livePayload(rows, previewRows, state);
  assert.equal(body.rows[0].portrait_stage_id, STAGE_A);
  assert.equal("portrait_stage_id" in body.rows[1], false, "dong B khong bi gan anh cua A");
});

test("LIVE quick-add: chỉ gửi stage của đúng dòng đang mở", () => {
  const { rows, previewRows } = liveRows();
  const bindings = buildPortraitRowBindings({ rows, previewRows });
  const state = runLifecycle(stagedActions(
    "row-b", bindings.get("row-b"), REQ_A, STAGE_B));

  // Quick-add chi gui row dang mo (row-b).
  const body = livePayload([rows[1]], [previewRows[1]], state);
  assert.equal(body.rows[0].portrait_stage_id, STAGE_B);

  // Neu mo row-a thi khong duoc lay stage cua row-b.
  const other = livePayload([rows[0]], [previewRows[0]], state);
  assert.equal("portrait_stage_id" in other.rows[0], false);
});

/* ------------------------------------------- sửa / xoá dòng không gắn nhầm */

test("LIVE: sửa nội dung dòng => ảnh cũ không gắn nữa và vào cleanup", () => {
  const { rows } = liveRows();
  const bindings = buildPortraitRowBindings({ rows, previewRows: [previewRow(1), previewRow(2)] });
  const state = runLifecycle(stagedActions(
    "row-a", bindings.get("row-a"), REQ_A, STAGE_A));

  // Sua ho ten/CCCD cua dong A.
  const edited = [previewRow(1, { display_name: "Nguyễn Văn A2", national_id: "012345678902" }), previewRow(2)];
  const body = livePayload(rows, edited, state);
  assert.equal("portrait_stage_id" in body.rows[0], false);

  const editedBindings = buildPortraitRowBindings({ rows, previewRows: edited });
  assert.deepEqual(
    selectStalePortraitStages({ rowBindings: editedBindings, slots: state.slots }),
    [{ rowKey: "row-a", stageId: STAGE_A }],
    "stage cu phai duoc don, khong bi mat ID",
  );
});

test("LIVE: xoá dòng => ảnh của dòng đó không vào payload và được dọn", () => {
  const { rows, previewRows } = liveRows();
  const bindings = buildPortraitRowBindings({ rows, previewRows });
  const state = runLifecycle(stagedActions(
    "row-a", bindings.get("row-a"), REQ_A, STAGE_A));

  // Xoa dong A khoi bang.
  const remainingRows = [rows[1]];
  const remainingPreview = [previewRows[1]];
  const body = livePayload(remainingRows, remainingPreview, state);
  assert.equal("portrait_stage_id" in body.rows[0], false);

  const remainingBindings = buildPortraitRowBindings({
    rows: remainingRows, previewRows: remainingPreview,
  });
  assert.deepEqual(
    selectStalePortraitStages({ rowBindings: remainingBindings, slots: state.slots }),
    [{ rowKey: "row-a", stageId: STAGE_A }],
  );
});

/* --------------------------------------------------- race hai luồng */

test("LIVE: response A muộn không ghi đè upload B và A được giữ để dọn", () => {
  const { rows, previewRows } = liveRows();
  const binding = buildPortraitRowBindings({ rows, previewRows }).get("row-b");
  const state = runLifecycle([
    { kind: "stage-start", rowKey: "row-b", binding, requestId: REQ_A },
    { kind: "invalidate" },
    { kind: "stage-start", rowKey: "row-b", binding, requestId: REQ_B },
    {
      kind: "stage-result", rowKey: "row-b", requestId: REQ_A,
      result: { kind: "staged", stageId: STAGE_A, sizeBytes: 1 },
    },
    {
      kind: "stage-result", rowKey: "row-b", requestId: REQ_B,
      result: { kind: "staged", stageId: STAGE_B, sizeBytes: 2 },
    },
  ]);
  assert.equal(livePayload([rows[1]], [previewRows[1]], state).rows[0].portrait_stage_id, STAGE_B);
  assert.deepEqual([...selectOrphanPortraitStages(state)], [{ stageId: STAGE_A, sizeBytes: 1 }]);
});

/* ------------------------------------------- idempotency + recovery */

test("IDEMPOTENCY: stage create gửi Idempotency-Key và retry dùng lại đúng key", async () => {
  const calls = [];
  const file = new File([new Uint8Array(1024)], "p.png", { type: "image/png" });
  const fetchImpl = async (url, init) => {
    calls.push(init.headers["Idempotency-Key"]);
    return Response.json({
      ok: true, stage_id: STAGE_A, mime_type: "image/png", size_bytes: 1024, status: "STAGED",
    }, { status: 201 });
  };
  await stageWorkerPortrait({ file, idempotencyKey: KEY, fetchImpl });
  await stageWorkerPortrait({ file, idempotencyKey: KEY, fetchImpl });
  assert.deepEqual(calls, [KEY, KEY], "retry POST phai dung lai cung key");
  await stageWorkerPortrait({ file, idempotencyKey: REQ_A, fetchImpl });
  assert.notEqual(calls[2], KEY, "lan chon anh moi phai co key moi");
});

test("RECOVERY: ho so da luu nhung anh chua xong => pending (khong bao 'chua luu')", () => {
  assert.equal(portraitPromotionState({
    stageId: STAGE_A, status: "CLAIMED", idempotencyKey: KEY,
  }), "pending");
  assert.equal(portraitPromotionState({
    stageId: STAGE_A, status: "ATTACHED", idempotencyKey: null,
  }), "attached");
  assert.equal(portraitPromotionState({
    stageId: STAGE_A, status: "STAGED", idempotencyKey: null,
  }), "unsaved");
});

/* ------------------------------------------------------------ wiring */

test("LIVE wiring: hai luồng dùng chung controller và payload mang stage_id", () => {
  // Bang nhieu dong.
  assert.match(live, /buildServerGeneratedFullProfileRequestBody\(validPreviewRows, portraitStageIdsBySourceRow\)/);
  // Quick-add chi gui row dang mo.
  assert.match(live, /buildServerGeneratedFullProfileRequestBody\(\s*\n\s*\[matchingPreview\],/);
  assert.match(live, /const portraitStages = useWorkerPortraitStages\(\{ rowBindings: portraitRowBindings \}\)/);
  assert.match(live, /const portraitRowBindings = useMemo\(\(\) => buildPortraitRowBindings\(\{/);
  assert.match(live, /const portraitStageIdsBySourceRow = useMemo\(\(\) => buildPortraitStageIdsBySourceRow\(\{/);
  // Saved => settle; retry => recovery truoc khi bao loi.
  assert.match(live, /portraitStages\.settle\(rowKey, stageId\)/);
  assert.match(live, /portraitStages\.settle\(clientRowId, savedStageId\)/);
  assert.match(live, /const portraitPending = await reconcileStagedPortraits\(\);/);
  assert.match(live, /recoverWorkerPortraitStage\(\{ stageId, fetchImpl: fetch \}\)/);
  // Quick editor co slot anh + nut don.
  assert.match(live, /<WorkerPortraitStageSlot/);
  assert.match(live, /data-testid="quick-portrait-cleanup-retry"/);
  // Khong gui bytes/storage key/authority trong payload.
  assert.doesNotMatch(live, /portrait_bytes|base64|readAsDataURL/);
  // Controller dùng chung: khoá dòng string + requestId.
  assert.match(hook, /const requestId = crypto\.randomUUID\(\);/);
  assert.match(hook, /idempotencyKey: crypto\.randomUUID\(\)/);
  assert.match(hook, /selectBindablePortraitStages/);
  assert.match(hook, /selectOrphanPortraitStages/);
  assert.match(slot, /accept="image\/jpeg,image\/png"/);
});

test("LIVE: không mở rộng POST /batches (composer draft vẫn là luồng riêng)", () => {
  // Live chi goi full-profile cho hai luong tao NLD da noi; khong gui portrait_stage_id sang /batches.
  assert.doesNotMatch(live, /buildPortraitStageIdsBySourceRow[\s\S]{0,600}\/api\/direct-entry\/batches"/);
  assert.match(live, /postFullProfileBatch\(/);
});
