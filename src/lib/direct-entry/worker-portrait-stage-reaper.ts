import { randomUUID } from "node:crypto";

import type { DocumentObjectStorage } from "./r2-document-storage.ts";

type CleanupRepository = {
  claimExpiredCleanup(input: {
    claim_token: string;
    limit: number;
  }): Promise<{ ok: true; data: string[] } | { ok: false; kind: string }>;
  completeCleanup(input: {
    stage_id: string;
    claim_token: string;
  }): Promise<{ ok: true; data: true } | { ok: false; kind: string }>;
};

export const PORTRAIT_STAGE_REAPER_BATCH_SIZE = 50;

export async function runWorkerPortraitStageReaper(input: {
  repository: CleanupRepository;
  storage: Pick<DocumentObjectStorage, "deleteEnrollmentPortraitStage">;
  createClaimToken?: () => string;
}): Promise<{ claimed: number; deleted: number; failed: number }> {
  const claimToken = (input.createClaimToken ?? randomUUID)();
  const claimed = await input.repository.claimExpiredCleanup({
    claim_token: claimToken,
    limit: PORTRAIT_STAGE_REAPER_BATCH_SIZE,
  });
  if (!claimed.ok) throw new Error("PORTRAIT_STAGE_REAPER_CLAIM_FAILED");

  let deleted = 0;
  let failed = 0;
  for (const stageId of claimed.data) {
    try {
      await input.storage.deleteEnrollmentPortraitStage(stageId);
    } catch {
      failed += 1;
      continue;
    }
    const completed = await input.repository.completeCleanup({
      stage_id: stageId,
      claim_token: claimToken,
    });
    if (!completed.ok) {
      failed += 1;
      continue;
    }
    deleted += 1;
  }

  return { claimed: claimed.data.length, deleted, failed };
}
