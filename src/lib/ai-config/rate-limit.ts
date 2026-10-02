/**
 * P1.5-W04A — Rate limit có trần, thuần, deterministic (testable) cho mutation cấu hình.
 * Cửa sổ trượt trong bộ nhớ tiến trình; KHÔNG phải hàng rào phân tán (ghi rõ hạn chế).
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
