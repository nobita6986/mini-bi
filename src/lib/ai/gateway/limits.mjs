/**
 * P1.5-W04 — Trần/ngưỡng mặc định của AI gateway (không phải ngân sách tiền thật).
 * Production thiếu policy cấu hình ⇒ AI_POLICY_REQUIRED (fail closed).
 */

export const MAX_RESPONSE_BYTES = 128 * 1024;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const PROVIDER_TIMEOUT_MS = 30000;
export const LEASE_SECONDS = 120;
export const MAX_ATTEMPTS = 3;
/** Trần SLOT provider đang chạy — enforce ATOMIC tại DB claim (R3), không enforce ở application. */
export const MAX_CONCURRENT_JOBS = 2;
/** Trần ĐỘ SÂU hàng đợi (job chờ) — policy layer dùng để chặn queue phình vô hạn. */
export const MAX_QUEUE_DEPTH = 50;
export const DAILY_TOKEN_CEILING = 2_000_000;
export const RATE_WINDOW_MS = 60_000;
export const MAX_REQUESTS_PER_WINDOW = 6;
export const WORKER_BATCH_LIMIT = 3;
/** Trần cửa sổ phân tích (ngày) và trần số dòng fact — vượt ⇒ fail rõ, KHÔNG rút ngắn lịch sử. */
export const MAX_ANALYSIS_LOOKBACK_DAYS = 1500;
export const MAX_FACT_ROWS = 50_000;

export const REQUIRED_POLICY_KEYS = Object.freeze([
  "max_requests_per_window",
  "max_concurrent_jobs",
  "max_attempts",
  "provider_timeout_ms",
  "max_response_bytes",
  "daily_token_ceiling",
]);

export const DEFAULT_POLICY = Object.freeze({
  window_ms: RATE_WINDOW_MS,
  max_requests_per_window: MAX_REQUESTS_PER_WINDOW,
  max_concurrent_jobs: MAX_CONCURRENT_JOBS,
  max_queue_depth: MAX_QUEUE_DEPTH,
  max_attempts: MAX_ATTEMPTS,
  provider_timeout_ms: PROVIDER_TIMEOUT_MS,
  max_response_bytes: MAX_RESPONSE_BYTES,
  max_payload_bytes: MAX_PAYLOAD_BYTES,
  daily_token_ceiling: DAILY_TOKEN_CEILING,
  max_lookback_days: MAX_ANALYSIS_LOOKBACK_DAYS,
  max_fact_rows: MAX_FACT_ROWS,
});
