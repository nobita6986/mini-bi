/**
 * P1.7-H07 - Bounded retry cho session bootstrap o server-side.
 *
 * Trang /direct-entry va /dashboard doc `getDirectEntryActor` trong SSR; khi
 * supabase SSR client dang o giua refresh cookie (vd tab moi, SSR dau tien
 * sau khi anh xac thuc), `getUser()` co the throw mot error mang tinh
 * transient (network/cookies stream/IMPORT timeout). Trang hien thi
 * `TemporaryUnavailable` ngay lap tuc se danh dong nguoi dung thay vi cho
 * hydrate binh thuong.
 *
 * Helper nay chi retry TOI DA 1 LAN (bounded) truoc khi tra ket qua. Khong
 * polling vo han; neu lan goi dau tien thanh cong hoac khong phai transient
 * thi khong retry. Khong thay doi contract tra ve (van la
 * `DirectEntrySessionResult`); khong them dependency.
 */
import type { DirectEntrySessionResult } from "./direct-entry-session-core";

const RETRY_DELAY_MS = 80;
const MAX_ATTEMPTS = 2;

export async function resolveSessionWithBoundedRetry(
  resolve: () => Promise<DirectEntrySessionResult>,
): Promise<DirectEntrySessionResult> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await resolve();
    } catch (cause) {
      lastError = cause;
      if (attempt >= MAX_ATTEMPTS) break;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, RETRY_DELAY_MS));
    }
  }
  throw lastError;
}
