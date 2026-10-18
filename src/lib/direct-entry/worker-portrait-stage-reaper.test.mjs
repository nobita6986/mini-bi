import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isW2S1PortraitStageReaperStagingEnvironment,
  runWorkerPortraitStageReaper,
} from "./worker-portrait-stage-reaper.ts";

const STAGE_A = "a1000000-0000-4000-8000-000000000001";
const STAGE_B = "a1000000-0000-4000-8000-000000000002";
const TOKEN = "b1000000-0000-4000-8000-000000000001";

test("reaper configuration accepts only the isolated staging Supabase project and Preview bucket", () => {
  const staging = {
    NEXT_PUBLIC_SUPABASE_URL: "https://oyykqfxkyqhxgrfntokl.supabase.co",
    DOCUMENT_STORAGE_ENVIRONMENT: "preview",
    R2_BUCKET_NAME: "hrp-bi-preview",
  };
  assert.equal(isW2S1PortraitStageReaperStagingEnvironment(staging), true);
  assert.equal(isW2S1PortraitStageReaperStagingEnvironment({
    ...staging,
    NEXT_PUBLIC_SUPABASE_URL: "https://production.supabase.co",
  }), false);
  assert.equal(isW2S1PortraitStageReaperStagingEnvironment({
    ...staging,
    DOCUMENT_STORAGE_ENVIRONMENT: "production",
  }), false);
  assert.equal(isW2S1PortraitStageReaperStagingEnvironment({
    ...staging,
    R2_BUCKET_NAME: "hrp-bi-product",
  }), false);
});

function dependencies({ deleteFailure } = {}) {
  const calls = [];
  return {
    calls,
    repository: {
      async claimExpiredCleanup(input) {
        calls.push(["claim", input]);
        return { ok: true, data: [STAGE_A, STAGE_B] };
      },
      async completeCleanup(input) {
        calls.push(["complete", input]);
        return { ok: true, data: true };
      },
    },
    storage: {
      async deleteEnrollmentPortraitStage(stageId) {
        calls.push(["delete", stageId]);
        if (stageId === deleteFailure) throw new Error("synthetic storage failure");
      },
    },
  };
}

test("reaper deletes each claimed object by stage id, then acknowledges cleanup", async () => {
  const d = dependencies();
  const result = await runWorkerPortraitStageReaper({
    ...d,
    createClaimToken: () => TOKEN,
  });

  assert.deepEqual(result, { claimed: 2, deleted: 2, failed: 0 });
  assert.deepEqual(d.calls, [
    ["claim", { claim_token: TOKEN, limit: 50 }],
    ["delete", STAGE_A],
    ["complete", { stage_id: STAGE_A, claim_token: TOKEN }],
    ["delete", STAGE_B],
    ["complete", { stage_id: STAGE_B, claim_token: TOKEN }],
  ]);
});

test("failed object deletion leaves cleanup pending for lease-based retry", async () => {
  const d = dependencies({ deleteFailure: STAGE_A });
  const result = await runWorkerPortraitStageReaper({
    ...d,
    createClaimToken: () => TOKEN,
  });

  assert.deepEqual(result, { claimed: 2, deleted: 1, failed: 1 });
  assert.equal(d.calls.some(([name, stageId]) => name === "complete" && stageId === STAGE_A), false);
  assert.equal(d.calls.some(([name, value]) =>
    name === "complete" && value.stage_id === STAGE_B), true);
});

test("database claim failures are surfaced instead of reported as a successful empty run", async () => {
  await assert.rejects(
    runWorkerPortraitStageReaper({
      repository: {
        async claimExpiredCleanup() { return { ok: false, kind: "unavailable" }; },
        async completeCleanup() { return { ok: true, data: true }; },
      },
      storage: { async deleteEnrollmentPortraitStage() {} },
    }),
    /PORTRAIT_STAGE_REAPER_CLAIM_FAILED/,
  );
});
