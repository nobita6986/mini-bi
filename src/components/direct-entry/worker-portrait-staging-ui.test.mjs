import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildFullProfileRequestBody,
  fullProfileRequiredCapabilities,
  fullProfileSubmitBlockers,
} from "../../lib/direct-entry/full-profile-batch.ts";
import {
  EMPTY_PORTRAIT_STAGE_LIFECYCLE,
  PORTRAIT_PROMOTION_PENDING_MESSAGE,
  PORTRAIT_STAGE_ENDPOINT,
  PORTRAIT_STAGE_RECOVER_ENDPOINT,
  buildPortraitStageIdsBySourceRow,
  portraitRowBinding,
  reducePortraitStageLifecycle,
  selectBindablePortraitStages,
  selectOrphanPortraitStages,
} from "../../lib/direct-entry/worker-portrait-stage-client.ts";

const dialog = readFileSync(
  new URL("./direct-entry-worker-profile-paste-dialog.tsx", import.meta.url), "utf8");
const batch = readFileSync(
  new URL("../../lib/direct-entry/full-profile-batch.ts", import.meta.url), "utf8");
const client = readFileSync(
  new URL("../../lib/direct-entry/worker-portrait-stage-client.ts", import.meta.url), "utf8");

const STAGE_ID = "a1000000-0000-4000-8000-000000000001";
const STAGE_B = "a1000000-0000-4000-8000-000000000002";
const REQ_A = "request-a";
const REQ_B = "request-b";
const RECRUITER_ID = "a1000000-0000-4000-8000-000000000009";

/* ------------------------------------------------------------- fixtures */

function minimalRow(overrides = {}) {
  return {
    project_id: "p1",
    first_work_date: "2026-01-05",
    employee_code: "hrp-2026-000001",
    recruiter_id: RECRUITER_ID,
    labor_type: "FULL_TIME",
    display_name: "Nguyễn Văn A",
    worker: {
      gender: { state: "omitted" }, date_of_birth: { state: "omitted" },
      national_id: { state: "omitted" }, national_id_issued_at: { state: "omitted" },
      national_id_issued_place: { state: "omitted" }, address: { state: "omitted" },
      phone: { state: "omitted" },
    },
    general_note: { state: "omitted" },
    payment: null,
    employment: null,
    ...overrides,
  };
}

/** Mot dong preview day du de goi duoc builder payload that. */
function previewRow(sourceRow, overrides = {}) {
  const profile = minimalRow(overrides);
  return {
    sourceRow,
    row: {
      employee_code: profile.employee_code,
      project_label: "Dự án",
      recruiter_label: "Người tuyển",
      first_work_date: profile.first_work_date,
      display_name: profile.display_name,
      labor_type: profile.labor_type,
      worker: {
        gender: { state: "omitted" }, date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" }, national_id_issued_at: { state: "omitted" },
        national_id_issued_place: { state: "omitted" }, address: { state: "omitted" },
        phone: { state: "omitted" },
      },
      general_note: { state: "omitted" },
      payment: {
        account_number: { state: "omitted" }, bank_name: { state: "omitted" },
        account_holder_name: { state: "omitted" },
      },
      employment: {
        initial_status: { state: "omitted" }, leave_date: { state: "omitted" },
        leave_reason_text: { state: "omitted" },
      },
    },
    resolved: { project_id: "p1", recruiter_id: RECRUITER_ID, provider_type: "hrp" },
    labels: {},
    issues: [],
    warnings: [],
  };
}

function previewWith(rows) {
  return {
    rows,
    totalRows: rows.length, validRows: rows.length, errorCount: 0, warningCount: 0,
    canProceed: true, catalogDates: [],
  };
}

/** Binding y het ham `rowBinding` trong dialog. */
function bindingOfRow(row) {
  const raw = (value) => (value.state === "provided" ? value.value : value.state);
  return portraitRowBinding({
    rowKey: String(row.sourceRow),
    employeeCode: row.row.employee_code,
    displayName: row.row.display_name,
    firstWorkDate: row.row.first_work_date,
    projectId: row.resolved.project_id,
    recruiterId: row.resolved.recruiter_id,
    laborType: row.row.labor_type,
    nationalId: raw(row.row.worker.national_id),
    dateOfBirth: raw(row.row.worker.date_of_birth),
    phone: raw(row.row.worker.phone),
  });
}

/** Payload batch THAT SU duoc gui, voi danh sach stage lay tu state reducer. */
function payloadStageField(rows, stageState) {
  const rowBindings = new Map(rows.map((row) => [String(row.sourceRow), bindingOfRow(row)]));
  const bindable = selectBindablePortraitStages({ rowBindings, slots: stageState.slots });
  // Payload builder nhan Map<sourceRow, stage_id> dung nhu luong live.
  const stageIds = buildPortraitStageIdsBySourceRow({
    bindableStageIds: bindable,
    rows: rows.map((row) => ({ clientRowId: String(row.sourceRow) })),
    previewRows: rows,
  });
  const body = buildFullProfileRequestBody(rows, stageIds);
  return body.rows[0];
}

function runLifecycle(actions) {
  return actions.reduce(reducePortraitStageLifecycle, EMPTY_PORTRAIT_STAGE_LIFECYCLE);
}

function staged(sourceRow, binding, requestId = REQ_A, stageId = STAGE_ID) {
  const rowKey = String(sourceRow);
  return [
    { kind: "stage-start", rowKey, binding, requestId },
    {
      kind: "stage-result", rowKey, requestId,
      result: { kind: "staged", stageId, sizeBytes: 2048 },
    },
  ];
}

/* ------------------------------------------------------- hành vi payload */

test("HÀNH VI (đối chứng): stage còn khớp dòng thì CÓ trong payload batch", () => {
  const row = previewRow(1);
  const state = runLifecycle(staged(1, bindingOfRow(row)));
  assert.equal(payloadStageField([row], state).portrait_stage_id, STAGE_ID);
});

test("HÀNH VI: stage A staged cho dòng A, đổi dòng thành NLD B => payload KHÔNG chứa stage A cho B", () => {
  const rowA = previewRow(1);
  const state = runLifecycle(staged(1, bindingOfRow(rowA)));
  assert.equal(payloadStageField([rowA], state).portrait_stage_id, STAGE_ID);

  const rowB = previewRow(1, { display_name: "Nguyễn Văn B", employee_code: "hrp-2026-000002" });
  assert.equal("portrait_stage_id" in payloadStageField([rowB], state), false,
    "stage A khong duoc gui cho NLD B");
});

test("HÀNH VI: DELETE lỗi mạng/5xx không làm mất ID và stage không vào payload; thử lại thì dọn được", () => {
  const row = previewRow(1);
  const binding = bindingOfRow(row);
  let state = runLifecycle([
    ...staged(1, binding),
    { kind: "invalidate" },                                     // dong hop thoai
    { kind: "cancel-result", rowKey: "1", stageId: STAGE_ID, confirmed: false }, // DELETE 503/network
  ]);
  assert.equal(state.slots.get("1").status, "stale");
  assert.equal(state.slots.get("1").stageId, STAGE_ID, "khong duoc lam mat stage ID");
  assert.equal("portrait_stage_id" in payloadStageField([row], state), false,
    "stage chua don duoc khong duoc gui vao batch");

  // Thu don lai: chi khi da huy duoc moi xoa ID khoi state.
  state = runLifecycle([
    ...staged(1, binding),
    { kind: "invalidate" },
    { kind: "cancel-result", rowKey: "1", stageId: STAGE_ID, confirmed: false },
    { kind: "cancel-result", rowKey: "1", stageId: STAGE_ID, confirmed: true },
  ]);
  assert.equal(state.slots.size, 0);
});

test("HÀNH VI: chu trình đóng–mở lại không tái sử dụng stage đã gửi DELETE", () => {
  const row = previewRow(1);
  const binding = bindingOfRow(row);

  // Dong + DELETE thanh cong => state sach.
  const afterCleanClose = runLifecycle([
    ...staged(1, binding),
    { kind: "invalidate" },
    { kind: "cancel-result", rowKey: "1", stageId: STAGE_ID, confirmed: true },
  ]);
  assert.equal(afterCleanClose.slots.size, 0);
  assert.equal("portrait_stage_id" in payloadStageField([row], afterCleanClose), false);

  // Dong khi DELETE loi 5xx => con ID nhung KHONG duoc tai su dung khi mo lai voi CUNG du lieu.
  const afterFailedDelete = runLifecycle([
    ...staged(1, binding),
    { kind: "invalidate" },
    { kind: "cancel-result", rowKey: "1", stageId: STAGE_ID, confirmed: false },
  ]);
  assert.equal(afterFailedDelete.slots.get("1").stageId, STAGE_ID);
  assert.equal("portrait_stage_id" in payloadStageField([row], afterFailedDelete), false,
    "mo lai voi dung du lieu cu van khong duoc dung lai stage da gui DELETE");
});

test("HÀNH VI: kết quả stage về muộn sau edit/close vào danh sách cleanup riêng, không gắn lại", () => {
  const rowA = previewRow(1);
  const rowB = previewRow(1, { display_name: "Nguyễn Văn B", employee_code: "hrp-2026-000002" });
  const bindingA = bindingOfRow(rowA);

  const lateOk = runLifecycle([
    { kind: "stage-start", rowKey: "1", binding: bindingA, requestId: REQ_A },
    { kind: "invalidate" },
    {
      kind: "stage-result", rowKey: "1", requestId: REQ_A,
      result: { kind: "staged", stageId: STAGE_ID, sizeBytes: 1024 },
    },
  ]);
  assert.equal(lateOk.slots.has(1), false, "khong tao/ghi de slot nao");
  assert.deepEqual([...selectOrphanPortraitStages(lateOk)], [{ stageId: STAGE_ID, sizeBytes: 1024 }]);
  assert.equal("portrait_stage_id" in payloadStageField([rowB], lateOk), false);
  assert.equal("portrait_stage_id" in payloadStageField([rowA], lateOk), false);
});

test("RACE: upload A → invalidate → dán lại cùng dòng + upload B → A về sau: payload chỉ có B, A vào cleanup", () => {
  const row = previewRow(1);
  const binding = bindingOfRow(row); // dan lai Y HET => binding trung lai
  const state = runLifecycle([
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
  assert.equal(payloadStageField([row], state).portrait_stage_id, STAGE_B,
    "payload chi chua stage B, khong phai stage A");
  assert.deepEqual([...selectOrphanPortraitStages(state)], [{ stageId: STAGE_ID, sizeBytes: 1 }],
    "stage A van duoc giu de huy, khong bi mat");
});

test("RACE (thứ tự ngược): B về trước rồi A về sau => payload vẫn chỉ có B", () => {
  const row = previewRow(1);
  const binding = bindingOfRow(row);
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
  assert.equal(payloadStageField([row], state).portrait_stage_id, STAGE_B);
  assert.deepEqual([...selectOrphanPortraitStages(state)], [{ stageId: STAGE_ID, sizeBytes: 1 }]);
});

/* ------------------------------------------------- wiring dialog (một phần) */

test("W2S1: co anh stage => CTA doi hoi them capability document_upload", () => {
  assert.deepEqual(fullProfileRequiredCapabilities([minimalRow()]),
    ["entry_create", "submission_create"]);
  assert.deepEqual(fullProfileRequiredCapabilities([minimalRow({ portrait_stage_id: STAGE_ID })]),
    ["entry_create", "submission_create", "document_upload"]);
});

test("W2S1: thieu document_upload thi CTA bi chan boi PROFILE_CAPABILITY_MISSING", () => {
  const rows = [previewRow(1)];
  const stages = new Map([[1, STAGE_ID]]);
  const blocked = fullProfileSubmitBlockers({
    preview: previewWith(rows), capabilities: ["entry_create", "submission_create"],
    submitting: false, portraitStageIds: stages,
  });
  assert.ok(blocked.includes("PROFILE_CAPABILITY_MISSING"));
  const allowed = fullProfileSubmitBlockers({
    preview: previewWith(rows), capabilities: ["entry_create", "submission_create", "document_upload"],
    submitting: false, portraitStageIds: stages,
  });
  assert.deepEqual(allowed, []);
});

test("W2S1: row chi mang portrait_stage_id khi co anh, khong bao gio mang bytes/key", () => {
  assert.match(batch, /\.\.\.\(portraitStageId === undefined \? \{\} : \{ portrait_stage_id: portraitStageId \}\)/);
  assert.match(batch, /portrait_stage_id\?: string;/);
  assert.doesNotMatch(batch, /portrait_bytes:|base64:|storage_key:|signed_url:/);
});

test("W2S1: dialog gui stage_id theo tung dong va KHONG gui bytes trong payload batch", () => {
  assert.match(dialog, /buildFullProfileRequestBody\(preview\.rows, stagedStageIds\)/);
  assert.match(dialog, /portraitStageIds: stagedStageIds,/);
  assert.match(dialog, /stageWorkerPortrait\(\{[\s\S]{0,120}idempotencyKey: pending\.idempotencyKey/);
  assert.doesNotMatch(dialog, /readAsDataURL|portrait_bytes|base64:/);
});

test("W2S1: retry ảnh dùng lại key và File của cùng lần chọn", () => {
  assert.match(dialog, /idempotencyKey: crypto\.randomUUID\(\)/);
  assert.match(dialog, /pendingPortraitUploads\.current\.set\(sourceRow, pending\)/);
  assert.match(dialog,
    /const pending = pendingPortraitUploads\.current\.get\(sourceRow\);[\s\S]{0,180}sendPortraitStage\(sourceRow, pending\)/);
  assert.match(dialog, /data-testid=\{"profile-portrait-retry-" \+ sourceRow\}/);
  assert.match(client, /headers: \{ "Idempotency-Key": input\.idempotencyKey \}/);
});

test("W2S1: dialog dùng reducer vòng đời; đóng hộp thoại vô hiệu hóa và dọn stage", () => {
  assert.match(dialog, /useState<PortraitStageLifecycle>\(EMPTY_PORTRAIT_STAGE_LIFECYCLE\)/);
  assert.match(dialog, /setStageState\(\(current\) => reducePortraitStageLifecycle\(current, action\)\)/);
  // Moi lan stage co generation/request ID duy nhat.
  assert.match(dialog, /const requestId = crypto\.randomUUID\(\);/);
  assert.match(dialog,
    /dispatchStage\(\{ kind: "stage-start", rowKey: String\(sourceRow\), binding: pending\.binding, requestId \}\)/);
  assert.match(dialog, /kind: "stage-result",\s*\n\s*rowKey: String\(sourceRow\),\s*\n\s*requestId,/);
  assert.match(dialog, /dispatchStage\(\{ kind: "invalidate" \}\)/);
  assert.match(dialog, /kind: "cancel-result",[\s\S]{0,80}?rowKey: String\(sourceRow\),[\s\S]{0,40}?stageId,/);
  assert.match(dialog, /confirmed: result\.kind === "cancelled" \|\| result\.kind === "not-cancellable",/);
  // Stage mo coi (response cu) duoc don qua danh sach rieng.
  assert.match(dialog, /selectOrphanPortraitStages\(stageState\)/);
  assert.match(dialog, /kind: "orphan-cancel-result",/);
  assert.match(dialog, /hasStalePortrait=\{staleStages\.length > 0 \|\| orphanStages\.length > 0\}/);
  assert.match(dialog, /data-testid="profile-portrait-cleanup-retry"/);
  assert.match(dialog, /onRetryPortraitCleanup=\{\(\) => setCleanupNonce\(\(value\) => value \+ 1\)\}/);
  assert.doesNotMatch(dialog, /setPortraits\(/);
  assert.match(dialog, /result\.kind === "saved"[\s\S]{0,400}dispatchStage\(\{ kind: "cancel-result", rowKey: String\(sourceRow\), stageId, confirmed: true \}\)/);
});

test("W2S1: ket qua khong xac dinh => recovery quyet dinh trang thai UI (khong doan)", () => {
  assert.match(dialog, /await reconcilePortraits\(\);/);
  assert.match(dialog, /recoverWorkerPortraitStage\(\{ stageId, fetchImpl: fetch \}\)/);
  assert.match(dialog, /portraitPromotionState\(recovered\.recovery\)/);
  assert.match(dialog, /PORTRAIT_PROMOTION_PENDING_MESSAGE/);
  assert.match(dialog, /PORTRAIT_PROMOTION_UNSAVED_MESSAGE/);
  assert.match(dialog, /PORTRAIT_STAGE_ORPHAN_MESSAGE/);
  assert.match(dialog, /data-testid="profile-portrait-message"/);
  assert.match(PORTRAIT_PROMOTION_PENDING_MESSAGE, /đã được lưu nhưng ảnh hồ sơ chưa hoàn tất/);
});

test("W2S1: retry giu nguyen stage + idempotency key cua batch", () => {
  assert.match(dialog, /if \(result\.kind === "retry"\) \{/);
  assert.match(dialog, /await reconcilePortraits\(\);\s*\n\s*setSubmitMessageKind\("error"\);/);
  assert.match(dialog, /result\.kind === "saved"[\s\S]{0,200}clearIntentKey/);
});

test("W2S1: stage client khong tu gui truong authority/scope va dung dung endpoint", () => {
  assert.match(client, new RegExp(PORTRAIT_STAGE_ENDPOINT.replace(/\//g, "\\/")));
  assert.match(client, new RegExp(PORTRAIT_STAGE_RECOVER_ENDPOINT.replace(/\//g, "\\/")));
  assert.doesNotMatch(client, /"auth_subject"|"app_user_id"|"capability"|"scope"|"team_id"/);
  assert.doesNotMatch(batch, /"auth_subject"|"app_user_id"|"capability"|"scope"|"team_id"/);
  assert.match(client, /form\.append\("file", input\.file, "portrait"\)/);
  assert.match(client, /body: JSON\.stringify\(\{ stage_id: input\.stageId \}\)/);
});
