/**
 * P1.5-W05-S02 — Strict projection cho review (approve/reject) + history.
 * Thuan, dung chung cho server route va test; malformed => AI_INTERNAL.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string { return typeof value === "string" && UUID_RE.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

export type ReviewResult =
  | { ok: true; revision_id: string; lifecycle_status: "approved" | "rejected"; idempotent: boolean }
  | { ok: false; code: string; message: string };

export function projectReviewResponse(raw: unknown): ReviewResult {
  const fail: ReviewResult = { ok: false, code: "AI_INTERNAL", message: "Phản hồi duyệt báo cáo không hợp lệ." };
  if (!isRecord(raw) || raw.ok !== true) return fail;
  if (!isUuid(raw.revision_id)) return fail;
  if (raw.lifecycle_status !== "approved" && raw.lifecycle_status !== "rejected") return fail;
  if (typeof raw.idempotent !== "boolean") return fail;
  return { ok: true, revision_id: raw.revision_id, lifecycle_status: raw.lifecycle_status, idempotent: raw.idempotent };
}

const JOB_STATUSES = [
  "requested", "queued", "computing", "ai_generating", "validating", "draft",
  "failed_input", "failed_config", "failed_provider_transient", "failed_provider_permanent",
  "failed_validation", "failed_budget", "failed_internal",
];

export type ReviewRequest =
  | { ok: true; decision: "approve" | "reject"; expected_revision_number: number; reason: string | null }
  | { ok: false; code: "AI_INPUT_INVALID" | "AI_INTERNAL"; message: string };

/** Project body POST review: decision chỉ approve|reject; expected_revision_number bắt buộc; reject bắt buộc reason. */
export function projectReviewRequest(raw: unknown): ReviewRequest {
  const invalid = (message: string): ReviewRequest => ({ ok: false, code: "AI_INPUT_INVALID", message });
  if (!isRecord(raw)) return invalid("body phải là JSON object");
  const decision = raw.decision;
  if (decision !== "approve" && decision !== "reject") return invalid("decision chỉ approve|reject");
  const expected = raw.expected_revision_number;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 1) {
    return invalid("thiếu expected_revision_number hợp lệ");
  }
  const reasonRaw = raw.reason;
  if (decision === "reject") {
    if (typeof reasonRaw !== "string" || reasonRaw.trim().length < 3 || reasonRaw.trim().length > 300) {
      return invalid("reject cần lý do 3..300 ký tự");
    }
    return { ok: true, decision, expected_revision_number: expected, reason: reasonRaw.trim() };
  }
  if (reasonRaw !== undefined && reasonRaw !== null && typeof reasonRaw !== "string") return invalid("reason phải là chuỗi");
  return { ok: true, decision, expected_revision_number: expected, reason: null };
}

export type HistoryResult =
  | { ok: true; items: unknown[]; next_cursor: string | null; has_more: boolean }
  | { ok: false; code: string; message: string };

export function projectHistoryResponse(raw: unknown): HistoryResult {
  const fail: HistoryResult = { ok: false, code: "AI_INTERNAL", message: "Dữ liệu lịch sử không hợp lệ." };
  if (!isRecord(raw) || raw.ok !== true) return fail;
  if (!Array.isArray(raw.items)) return fail;
  const items = [];
  for (const item of raw.items) {
    if (!isRecord(item)) return fail;
    if (!isUuid(item.job_id)) return fail;
    if (typeof item.status !== "string" || !JOB_STATUSES.includes(item.status)) return fail;
    if (typeof item.created_at !== "string" || item.created_at === "") return fail;
    if (item.completed_at !== null && typeof item.completed_at !== "string") return fail;
    if (typeof item.provider_key !== "string" || typeof item.model_key !== "string") return fail;
    if (item.revision_id !== null && !isUuid(item.revision_id)) return fail;
    if (item.revision_number !== null && (typeof item.revision_number !== "number" || item.revision_number < 1)) return fail;
    if (item.lifecycle_status !== null && !["draft", "approved", "rejected"].includes(String(item.lifecycle_status))) return fail;
    if (!Array.isArray(item.dimensions) || !item.dimensions.every((d: unknown) => typeof d === "string")) return fail;
    if (item.focus !== null && typeof item.focus !== "string") return fail;
    items.push({
      job_id: item.job_id,
      status: item.status,
      created_at: item.created_at,
      completed_at: item.completed_at,
      provider_key: item.provider_key,
      model_key: item.model_key,
      revision_id: item.revision_id,
      revision_number: item.revision_number,
      lifecycle_status: item.lifecycle_status,
      period: item.period,
      dimensions: item.dimensions,
      focus: item.focus,
    });
  }
  const nextCursor = raw.next_cursor;
  if (nextCursor !== null && nextCursor !== undefined && (typeof nextCursor !== "string" || nextCursor === "")) return fail;
  if (typeof raw.has_more !== "boolean") return fail;
  return { ok: true, items, next_cursor: nextCursor ?? null, has_more: raw.has_more };
}