/**
 * P1.5-W04A — Registry provider profile ĐÓNG (server-side).
 *
 * UI KHÔNG bao giờ gửi header tùy ý: chỉ chọn `provider_profile`, server dựng header xác thực.
 * Thêm profile mới = sửa file này (có review), không phải cấu hình từ client.
 */

import { SecurityError } from "./errors.ts";

export type ProviderProfile = {
  id: string;
  label: string;
  /** Header xác thực do SERVER dựng; client không bao giờ gửi header. */
  auth_header: string;
  auth_scheme: string;
  /** Đường dẫn tương đối nối vào base URL đã chuẩn hoá (không có query/fragment). */
  path: string;
  method: "POST";
  /** Body probe tối thiểu cho kiểm tra kết nối. */
  probe_body: (model: string) => string;
};

const OPENAI_COMPATIBLE: ProviderProfile = {
  id: "openai-compatible",
  label: "OpenAI-compatible",
  auth_header: "authorization",
  auth_scheme: "Bearer",
  path: "chat/completions",
  method: "POST",
  probe_body: (model) => JSON.stringify({
    model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
  }),
};

export const PROVIDER_PROFILES: readonly ProviderProfile[] = [OPENAI_COMPATIBLE];
export const DEFAULT_PROVIDER_PROFILE_ID = OPENAI_COMPATIBLE.id;

export function isKnownProviderProfile(value: unknown): boolean {
  return typeof value === "string" && PROVIDER_PROFILES.some((profile) => profile.id === value);
}

export function getProviderProfile(id: string): ProviderProfile {
  const profile = PROVIDER_PROFILES.find((candidate) => candidate.id === id);
  if (!profile) throw new SecurityError("INVALID_INPUT");
  return profile;
}

/** Nối path vào base URL đã chuẩn hoá mà KHÔNG nuốt path sẵn có (vd: /v1). */
export function joinProviderPath(apiBaseUrl: string, relativePath: string): string {
  const base = new URL(apiBaseUrl);
  if (base.search !== "" || base.hash !== "") throw new SecurityError("INVALID_INPUT");
  if (!base.pathname.endsWith("/")) base.pathname = base.pathname + "/";
  const joined = new URL(relativePath, base);
  if (joined.origin !== base.origin) throw new SecurityError("URL_REJECTED");
  return joined.href;
}

/**
 * Dựng request kiểm tra kết nối: header xác thực CHỈ ở đây (server), body bounded.
 * Trả về object thuần để test không cần mạng.
 */
export function buildConnectionProbe(input: {
  api_base_url: string;
  model: string;
  secret: string;
  provider_profile: string;
}): { url: string; method: "POST"; headers: Record<string, string>; body: string } {
  const profile = getProviderProfile(input.provider_profile);
  if (typeof input.secret !== "string" || input.secret.length === 0 || input.secret.length > 16_384) {
    throw new SecurityError("INVALID_INPUT");
  }
  return {
    url: joinProviderPath(input.api_base_url, profile.path),
    method: profile.method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      [profile.auth_header]: profile.auth_scheme + " " + input.secret,
    },
    body: profile.probe_body(input.model),
  };
}
