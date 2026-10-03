/**
 * Pilot access gate P1-W03 — HTTP Basic Auth (logic thuần, testable).
 *
 * Shared pilot gate tạm thời, KHÔNG phải Auth/RBAC P3. Chỉ chặn các route được bảo vệ
 * trước khi render/query. Module này KHÔNG tạo Supabase client, KHÔNG đọc
 * SUPABASE_SECRET_KEY, KHÔNG gọi DB/API ngoài, KHÔNG import "@/" (để Node test chạy được).
 *
 * Credential so sánh bằng constant-time (SHA-256 + timingSafeEqual) trên Node.js runtime.
 */

import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";

export const PILOT_AUTH_REALM = "Mini BI Pilot";

export type PilotAccessDecision =
  | { kind: "allow" }
  | { kind: "unauthorized" }
  | { kind: "unavailable" };

export interface PilotAccessInput {
  isDevelopment: boolean;
  username: string | undefined;
  password: string | undefined;
  authorizationHeader: string | null | undefined;
}

const PROTECTED_EXACT = [
  "/dashboard",
  "/pipeline-check",
  "/api/reporting",
  "/direct-entry",
  "/api/direct-entry",
];
const PROTECTED_PREFIXES = [
  "/dashboard/",
  "/pipeline-check/",
  "/api/reporting/",
  "/api/ai/",
  "/direct-entry/",
  "/api/direct-entry/",
];

/** Các route cần Basic Auth (khớp matcher của proxy). */
export function isPilotProtectedPath(pathname: string): boolean {
  if (PROTECTED_EXACT.includes(pathname)) return true;
  return PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** So sánh constant-time (độ dài chuẩn hóa bằng SHA-256). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Giải mã Basic "username:password" (base64 => UTF-8). Trả null nếu sai định dạng. */
function decodeBasicCredentials(encoded: string): { username: string; password: string } | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  if (encoded.length % 4 !== 0) return null;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

/**
 * Đánh giá một request. Không ném, không log credential, không trả giá trị secret.
 * - development: luôn allow (không cần credential).
 * - thiếu username/password => unavailable (fail closed 503).
 * - còn lại: phân tích header Authorization; đúng => allow, sai/thiếu => unauthorized (401).
 */
export function evaluatePilotAccess(input: PilotAccessInput): PilotAccessDecision {
  if (input.isDevelopment) return { kind: "allow" };
  if (!input.username || !input.password) return { kind: "unavailable" };

  const header = (input.authorizationHeader ?? "").trim();
  if (!header) return { kind: "unauthorized" };

  const parts = header.split(/\s+/);
  if (parts.length !== 2) return { kind: "unauthorized" };
  const [scheme, encoded] = parts;
  if (scheme.toLowerCase() !== "basic") return { kind: "unauthorized" };

  const creds = decodeBasicCredentials(encoded);
  if (!creds) return { kind: "unauthorized" };
  if (!safeEqual(creds.username, input.username) || !safeEqual(creds.password, input.password)) {
    return { kind: "unauthorized" };
  }
  return { kind: "allow" };
}
