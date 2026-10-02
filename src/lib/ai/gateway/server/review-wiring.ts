import "server-only";

import type { HistoryResult, ReviewResult } from "@/lib/ai-report/review-projection";

import { createServerAiReviewService } from "./review.mjs";

export type ReviewCapability = { approve: boolean; reject: boolean; regenerate: boolean };

export type ReviewService = {
  capability(): Promise<ReviewCapability>;
  approve(input: { job_id: string; expected_revision_number: number; actor_ref: string }): Promise<ReviewResult>;
  reject(input: { job_id: string; expected_revision_number: number; actor_ref: string; reason: string }): Promise<ReviewResult>;
  history(input: { actor_ref: string; cursor: string | null; page_size: number }): Promise<HistoryResult>;
};

export function createReviewService(): ReviewService {
  return createServerAiReviewService() as ReviewService;
}