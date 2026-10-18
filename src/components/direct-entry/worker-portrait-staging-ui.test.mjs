import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  fullProfileRequiredCapabilities,
  fullProfileSubmitBlockers,
} from "../../lib/direct-entry/full-profile-batch.ts";
import {
  PORTRAIT_PROMOTION_PENDING_MESSAGE,
  PORTRAIT_STAGE_ENDPOINT,
  PORTRAIT_STAGE_RECOVER_ENDPOINT,
} from "../../lib/direct-entry/worker-portrait-stage-client.ts";

const dialog = readFileSync(
  new URL("./direct-entry-worker-profile-paste-dialog.tsx", import.meta.url), "utf8");
const batch = readFileSync(
  new URL("../../lib/direct-entry/full-profile-batch.ts", import.meta.url), "utf8");
const client = readFileSync(
  new URL("../../lib/direct-entry/worker-portrait-stage-client.ts", import.meta.url), "utf8");

const STAGE_ID = "a1000000-0000-4000-8000-000000000001";

function minimalRow(overrides = {}) {
  return {
    project_id: "p1",
    first_work_date: "2026-01-05",
    employee_code: "hrp-2026-000001",
    recruiter_id: "a1000000-0000-4000-8000-000000000009",
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

test("W2S1: co anh stage => CTA doi hoi them capability document_upload", () => {
  assert.deepEqual(fullProfileRequiredCapabilities([minimalRow()]),
    ["entry_create", "submission_create"]);
  assert.deepEqual(fullProfileRequiredCapabilities([minimalRow({ portrait_stage_id: STAGE_ID })]),
    ["entry_create", "submission_create", "document_upload"]);
  // change_request_create khong thay the document_upload.
  assert.equal(fullProfileRequiredCapabilities([minimalRow({ portrait_stage_id: STAGE_ID })])
    .includes("document_upload"), true);
});

test("W2S1: thieu document_upload thi CTA bi chan boi PROFILE_CAPABILITY_MISSING", () => {
  const preview = {
    rows: [{
      sourceRow: 1,
      row: {
        employee_code: "hrp-2026-000001", project_label: "P", recruiter_label: "R",
        first_work_date: "2026-01-05", display_name: "A",
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
        employment: { initial_status: { state: "omitted" }, leave_date: { state: "omitted" },
          leave_reason_text: { state: "omitted" } },
      },
      resolved: { project_id: "p1", recruiter_id: STAGE_ID, provider_type: "hrp" },
      labels: {},
      issues: [], warnings: [],
    }],
    totalRows: 1, validRows: 1, errorCount: 0, warningCount: 0,
    canProceed: true, catalogDates: [],
  };
  const stages = new Map([[1, STAGE_ID]]);
  const blocked = fullProfileSubmitBlockers({
    preview, capabilities: ["entry_create", "submission_create"], submitting: false,
    portraitStageIds: stages,
  });
  assert.ok(blocked.includes("PROFILE_CAPABILITY_MISSING"));
  const allowed = fullProfileSubmitBlockers({
    preview, capabilities: ["entry_create", "submission_create", "document_upload"],
    submitting: false, portraitStageIds: stages,
  });
  assert.deepEqual(allowed, []);
});

test("W2S1: row chi mang portrait_stage_id khi co anh, khong bao gio mang bytes/key", () => {
  assert.match(batch, /\.\.\.\(portraitStageId === undefined \? \{\} : \{ portrait_stage_id: portraitStageId \}\)/);
  assert.match(batch, /portrait_stage_id\?: string;/);
  // Khong bao gio sinh field bytes/key/url trong payload gui len.
  assert.doesNotMatch(batch, /portrait_bytes:|base64:|storage_key:|signed_url:/);
});

test("W2S1: dialog gui stage_id theo tung dong va KHONG gui bytes trong payload batch", () => {
  assert.match(dialog, /buildFullProfileRequestBody\(preview\.rows, stagedStageIds\)/);
  assert.match(dialog, /portraitStageIds: stagedStageIds,/);
  assert.match(dialog, /const stagedStageIds = useMemo/);
  assert.match(dialog, /stageWorkerPortrait\(\{ file, fetchImpl: fetch \}\)/);
  assert.doesNotMatch(dialog, /readAsDataURL|portrait_bytes|base64:/);
});

test("W2S1: dialog huy stage chua gan khi nguoi dung dong hop thoai", () => {
  assert.match(dialog, /cancelWorkerPortraitStage\(\{ stageId: slot\.stageId, fetchImpl: fetch \}\)/);
  assert.match(dialog, /for \(const slot of portraits\.values\(\)\)/);
  assert.match(dialog, /if \(slot\.status === "staged"\)/);
  assert.match(dialog, /\}, \[onOpenChange, portraits\]\);/);
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
  // Key chi duoc xoa khi server da xac nhan hoac khi ket qua la 4xx nghiep vu.
  assert.match(dialog, /result\.kind === "saved"[\s\S]{0,200}clearIntentKey/);
});

test("W2S1: stage client khong tu gui truong authority/scope va dung dung endpoint", () => {
  assert.match(client, new RegExp(PORTRAIT_STAGE_ENDPOINT.replace(/\//g, "\\/")));
  assert.match(client, new RegExp(PORTRAIT_STAGE_RECOVER_ENDPOINT.replace(/\//g, "\\/")));
  // Khong co field authority nao duoc gui len (comment giai thich khong tinh).
  assert.doesNotMatch(client, /"auth_subject"|"app_user_id"|"capability"|"scope"|"team_id"/);
  assert.doesNotMatch(batch, /"auth_subject"|"app_user_id"|"capability"|"scope"|"team_id"/);
  assert.match(client, /form\.append\("file", input\.file, "portrait"\)/);
  assert.match(client, /body: JSON\.stringify\(\{ stage_id: input\.stageId \}\)/);
});
