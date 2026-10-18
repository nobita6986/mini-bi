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
  portraitRowBinding,
  reducePortraitStageLifecycle,
  selectBindablePortraitStages,
} from "../../lib/direct-entry/worker-portrait-stage-client.ts";

const dialog = readFileSync(
  new URL("./direct-entry-worker-profile-paste-dialog.tsx", import.meta.url), "utf8");
const batch = readFileSync(
  new URL("../../lib/direct-entry/full-profile-batch.ts", import.meta.url), "utf8");
const client = readFileSync(
  new URL("../../lib/direct-entry/worker-portrait-stage-client.ts", import.meta.url), "utf8");

const STAGE_ID = "a1000000-0000-4000-8000-000000000001";
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
    sourceRow: row.sourceRow,
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
  const rowBindings = new Map(rows.map((row) => [row.sourceRow, bindingOfRow(row)]));
  const stageIds = selectBindablePortraitStages({ rowBindings, slots: stageState.slots });
  const body = buildFullProfileRequestBody(rows, stageIds);
  return body.rows[0];
}

function runLifecycle(actions) {
  return actions.reduce(reducePortraitStageLifecycle, EMPTY_PORTRAIT_STAGE_LIFECYCLE);
}

function staged(sourceRow, binding) {
  return [
    { kind: "stage-start", sourceRow, binding },
    {
      kind: "stage-result", sourceRow, binding,
      result: { kind: "staged", stageId: STAGE_ID, sizeBytes: 2048 },
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
    { kind: "cancel-result", sourceRow: 1, stageId: STAGE_ID, confirmed: false }, // DELETE 503/network
  ]);
  assert.equal(state.slots.get(1).status, "stale");
  assert.equal(state.slots.get(1).stageId, STAGE_ID, "khong duoc lam mat stage ID");
  assert.equal("portrait_stage_id" in payloadStageField([row], state), false,
    "stage chua don duoc khong duoc gui vao batch");

  // Thu don lai: chi khi da huy duoc moi xoa ID khoi state.
  state = runLifecycle([
    ...staged(1, binding),
    { kind: "invalidate" },
    { kind: "cancel-result", sourceRow: 1, stageId: STAGE_ID, confirmed: false },
    { kind: "cancel-result", sourceRow: 1, stageId: STAGE_ID, confirmed: true },
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
    { kind: "cancel-result", sourceRow: 1, stageId: STAGE_ID, confirmed: true },
  ]);
  assert.equal(afterCleanClose.slots.size, 0);
  assert.equal("portrait_stage_id" in payloadStageField([row], afterCleanClose), false);

  // Dong khi DELETE loi 5xx => con ID nhung KHONG duoc tai su dung khi mo lai voi CUNG du lieu.
  const afterFailedDelete = runLifecycle([
    ...staged(1, binding),
    { kind: "invalidate" },
    { kind: "cancel-result", sourceRow: 1, stageId: STAGE_ID, confirmed: false },
  ]);
  assert.equal(afterFailedDelete.slots.get(1).stageId, STAGE_ID);
  assert.equal("portrait_stage_id" in payloadStageField([row], afterFailedDelete), false,
    "mo lai voi dung du lieu cu van khong duoc dung lai stage da gui DELETE");
});

test("HÀNH VI: kết quả stage về muộn sau edit/close không gắn lại và vẫn còn ID để dọn", () => {
  const rowA = previewRow(1);
  const rowB = previewRow(1, { display_name: "Nguyễn Văn B", employee_code: "hrp-2026-000002" });
  const bindingA = bindingOfRow(rowA);

  // Ket qua ok ve muon sau khi dong doi.
  const lateOk = runLifecycle([
    { kind: "stage-start", sourceRow: 1, binding: bindingA },
    { kind: "invalidate" },
    {
      kind: "stage-result", sourceRow: 1, binding: bindingA,
      result: { kind: "staged", stageId: STAGE_ID, sizeBytes: 1024 },
    },
  ]);
  assert.equal(lateOk.slots.get(1).status, "stale");
  assert.equal(lateOk.slots.get(1).stageId, STAGE_ID);
  assert.equal("portrait_stage_id" in payloadStageField([rowB], lateOk), false);
  assert.equal("portrait_stage_id" in payloadStageField([rowA], lateOk), false);
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
  assert.match(dialog, /stageWorkerPortrait\(\{ file, fetchImpl: fetch \}\)/);
  assert.doesNotMatch(dialog, /readAsDataURL|portrait_bytes|base64:/);
});

test("W2S1: dialog dùng reducer vòng đời; đóng hộp thoại vô hiệu hóa và dọn stage", () => {
  assert.match(dialog, /useState<PortraitStageLifecycle>\(EMPTY_PORTRAIT_STAGE_LIFECYCLE\)/);
  assert.match(dialog, /setStageState\(\(current\) => reducePortraitStageLifecycle\(current, action\)\)/);
  assert.match(dialog, /dispatchStage\(\{ kind: "invalidate" \}\)/);
  assert.match(dialog, /kind: "cancel-result",[\s\S]{0,60}?sourceRow,[\s\S]{0,40}?stageId,/);
  assert.match(dialog, /confirmed: result\.kind === "cancelled" \|\| result\.kind === "not-cancellable",/);
  assert.match(dialog, /hasStalePortrait=\{staleStages\.length > 0\}/);
  assert.match(dialog, /data-testid="profile-portrait-cleanup-retry"/);
  assert.match(dialog, /onRetryPortraitCleanup=\{\(\) => setCleanupNonce\(\(value\) => value \+ 1\)\}/);
  // Khong con xoa ID bang setPortraits truc tiep.
  assert.doesNotMatch(dialog, /setPortraits\(/);
  // Stage da gan (saved) => trang thai cuoi, duoc phep bo state.
  assert.match(dialog, /result\.kind === "saved"[\s\S]{0,400}dispatchStage\(\{ kind: "cancel-result", sourceRow, stageId, confirmed: true \}\)/);
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
