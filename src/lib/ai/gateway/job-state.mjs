/**
 * P1.5-W04 — Job state machine, failure taxonomy và retry policy (thuần, deterministic).
 *
 * Không DB, không mạng, không đọc đồng hồ hệ thống: mọi thời điểm do caller truyền.
 */

/** Trạng thái đang hoạt động (chưa kết thúc) — dùng cho unique index + claim. */
export const ACTIVE_STATUSES = Object.freeze(["requested", "queued", "computing", "ai_generating", "validating"]);

/** Trạng thái kết thúc. */
export const TERMINAL_STATUSES = Object.freeze([
  "draft",
  "failed_input",
  "failed_config",
  "failed_provider_transient",
  "failed_provider_permanent",
  "failed_validation",
  "failed_budget",
  "failed_internal",
]);

export const JOB_STATUSES = Object.freeze([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);

/** Transition hợp lệ của state machine. */
const TRANSITIONS = Object.freeze({
  requested: ["queued", "failed_input", "failed_config", "failed_budget", "failed_internal"],
  queued: ["computing", "failed_input", "failed_config", "failed_budget", "failed_internal"],
  computing: ["ai_generating", "queued", "failed_provider_transient", "failed_provider_permanent", "failed_config", "failed_budget", "failed_internal"],
  ai_generating: ["validating", "queued", "failed_provider_transient", "failed_provider_permanent", "failed_validation", "failed_internal"],
  validating: ["draft", "failed_validation", "queued", "failed_internal"],
  draft: [],
  failed_input: [],
  failed_config: [],
  failed_provider_transient: ["queued"],
  failed_provider_permanent: [],
  failed_validation: ["queued"],
  failed_budget: [],
  failed_internal: ["queued"],
});

export function isJobStatus(value) {
  return typeof value === "string" && JOB_STATUSES.includes(value);
}

export function isActiveStatus(value) {
  return typeof value === "string" && ACTIVE_STATUSES.includes(value);
}

export function isTerminalStatus(value) {
  return typeof value === "string" && TERMINAL_STATUSES.includes(value);
}

export function canTransition(from, to) {
  if (!isJobStatus(from) || !isJobStatus(to)) return false;
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Áp transition; trả { ok, status } hoặc { ok:false, code, message }. */
export function transition(from, to) {
  if (!canTransition(from, to)) {
    return { ok: false, code: "AI_INTERNAL", message: "transition không hợp lệ: " + String(from) + " -> " + String(to) };
  }
  return { ok: true, status: to };
}

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------

/**
 * Nhóm lỗi cấp gateway → trạng thái thất bại tương ứng.
 * - provider_transient: có thể retry bounded.
 * - provider_permanent (401/403/model sai/allowlist): KHÔNG retry.
 * - validation (schema/grounding/PII/injection): KHÔNG retry (model cần prompt/data khác).
 * - input/config/budget/internal.
 */
export const FAILURE_TAXONOMY = Object.freeze({
  AI_INPUT_INVALID: { status: "failed_input", retryable: false },
  AI_JOB_NOT_FOUND: { status: "failed_input", retryable: false },
  AI_CONFIG_REQUIRED: { status: "failed_config", retryable: false },
  AI_POLICY_REQUIRED: { status: "failed_config", retryable: false },
  AI_PROVIDER_DISABLED: { status: "failed_config", retryable: false },
  AI_PROVIDER_PERMANENT: { status: "failed_provider_permanent", retryable: false },
  AI_PROVIDER_TIMEOUT: { status: "failed_provider_transient", retryable: true },
  AI_PROVIDER_RATE_LIMITED: { status: "failed_provider_transient", retryable: true },
  AI_PROVIDER_TRANSIENT: { status: "failed_provider_transient", retryable: true },
  AI_PROVIDER_MALFORMED: { status: "failed_validation", retryable: false },
  AI_PROVIDER_OVERSIZED: { status: "failed_validation", retryable: false },
  AI_VALIDATION_FAILED: { status: "failed_validation", retryable: false },
  AI_BUDGET_LIMITED: { status: "failed_budget", retryable: false },
  AI_RATE_LIMITED: { status: "failed_budget", retryable: false },
  AI_CONCURRENCY_LIMITED: { status: "failed_budget", retryable: false },
  AI_INTERNAL: { status: "failed_internal", retryable: true },
});

export function classifyFailure(errorCode) {
  return FAILURE_TAXONOMY[errorCode] ?? { status: "failed_internal", retryable: false };
}

export function isRetryableError(errorCode) {
  return classifyFailure(errorCode).retryable === true;
}

/** Chỉ các lỗi provider tạm thời (timeout/429/5xx đã chọn) được retry. */
export const RETRYABLE_PROVIDER_ERRORS = Object.freeze([
  "AI_PROVIDER_TIMEOUT",
  "AI_PROVIDER_RATE_LIMITED",
  "AI_PROVIDER_TRANSIENT",
]);

export const RETRY_POLICY = Object.freeze({
  base_delay_ms: 2000,
  factor: 3,
  max_delay_ms: 60000,
  jitter_ratio: 0.2,
  max_attempts: 3,
});

/**
 * Backoff deterministic + bounded jitter (jitter suy từ seed, KHÔNG dùng Math.random).
 * attempt bắt đầu từ 1.
 */
export function computeBackoffMs(attempt, seed, policy = RETRY_POLICY) {
  const safeAttempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  const raw = policy.base_delay_ms * Math.pow(policy.factor, safeAttempt - 1);
  const capped = Math.min(raw, policy.max_delay_ms);
  const seedNumber = typeof seed === "string" && seed.length > 0 ? seed.charCodeAt(0) + seed.length : 0;
  const jitter = (seedNumber % 100) / 100 * policy.jitter_ratio;
  return Math.round(capped * (1 + jitter));
}

/**
 * Quyết định sau khi một attempt thất bại.
 * Trả { next_status, next_attempt_at, exhausted }.
 */
export function decideAfterFailure({ error_code, attempts, max_attempts, now_ms, seed, policy = RETRY_POLICY }) {
  const classification = classifyFailure(error_code);
  const attemptsUsed = Number.isInteger(attempts) ? attempts : 1;
  const limit = Number.isInteger(max_attempts) ? max_attempts : policy.max_attempts;
  if (!classification.retryable || attemptsUsed >= limit) {
    return {
      next_status: classification.status,
      next_attempt_at: null,
      exhausted: true,
    };
  }
  const delay = computeBackoffMs(attemptsUsed, seed, policy);
  return {
    next_status: "queued",
    next_attempt_at: new Date(now_ms + delay).toISOString(),
    exhausted: false,
  };
}

/** Lease đã hết hạn chưa (dùng để recover job treo). */
export function isLeaseExpired(leaseExpiresAt, nowMs) {
  if (typeof leaseExpiresAt !== "string") return true;
  const parsed = Date.parse(leaseExpiresAt);
  if (Number.isNaN(parsed)) return true;
  return parsed <= nowMs;
}

/** Job đến hạn chạy chưa (next_attempt_at <= now). */
export function isDue(nextAttemptAt, nowMs) {
  if (nextAttemptAt === null || nextAttemptAt === undefined) return true;
  const parsed = Date.parse(nextAttemptAt);
  if (Number.isNaN(parsed)) return true;
  return parsed <= nowMs;
}
