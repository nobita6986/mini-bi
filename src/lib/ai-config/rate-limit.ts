/**
 * P1.5-W04A — Rate limit có trần, thuần, deterministic (testable) cho mutation cấu hình.
 *
 * R1 (E) — CÔNG BỐ CHÍNH XÁC: đây là limiter **process-local / best-effort** cho pilot. Cửa sổ trượt nằm
 * trong bộ nhớ CỦA MỘT tiến trình serverless, nên khi có nhiều instance thì trần thực tế có thể cao hơn
 * cấu hình. Nó KHÔNG phải hard distributed rate limit và không phải hàng rào chống abuse.
 * P3 PHẢI thay bằng limiter atomic ở DB/KV (ví dụ bảng counter + upsert trong transaction) khoá theo
 * **authenticated actor** (user thật + org), và trả 429 nhất quán giữa các instance.
 */

export type RateLimiter = {
  check(key: string): { ok: true } | { ok: false; code: "RATE_LIMITED"; retry_after_ms: number };
};

export function createRateLimiter(options: {
  limit: number;
  window_ms: number;
  now?: () => number;
}): RateLimiter {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error("limit không hợp lệ");
  if (!Number.isSafeInteger(options.window_ms) || options.window_ms < 1) throw new Error("window_ms không hợp lệ");
  const now = options.now ?? (() => Date.now());
  const hits = new Map<string, number[]>();

  return {
    check(key) {
      const current = now();
      const window = (hits.get(key) ?? []).filter((timestamp) => current - timestamp < options.window_ms);
      if (window.length >= options.limit) {
        const oldest = window[0];
        hits.set(key, window);
        return {
          ok: false,
          code: "RATE_LIMITED",
          retry_after_ms: Math.max(1, options.window_ms - (current - oldest)),
        };
      }
      window.push(current);
      hits.set(key, window);
      return { ok: true };
    },
  };
}
