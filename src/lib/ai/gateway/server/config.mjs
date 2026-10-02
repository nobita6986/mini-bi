import "server-only";

/**
 * P1.5-W04 — Cấu hình server cho AI gateway (KHÔNG đọc NEXT_PUBLIC_*, không hard-code key/URL/model).
 *
 * Fail-closed:
 * - Production thiếu `AI_REPORTS_ENABLED=true` ⇒ AI_DISABLED (chặn TRƯỚC DB/config/provider).
 * - Production thiếu policy bắt buộc ⇒ AI_POLICY_REQUIRED.
 * - Live provider luôn bị chặn cho tới G4A ⇒ AI_PROVIDER_DISABLED.
 */

import { canonicalHash } from "../../engine-shared.mjs";
import { checkWorkerToken as checkWorkerTokenPure } from "../http-guards.mjs";
import { resolveProviderConfig } from "../provider-config.mjs";
import { DEFAULT_POLICY, REQUIRED_POLICY_KEYS } from "../limits.mjs";
import { readPolicyConfig } from "../policy.mjs";
import { DEFAULT_PROMPT_VERSION } from "../prompt-registry.mjs";

export { checkSameOriginRequest } from "../http-guards.mjs";

export const AI_REPORTS_ENABLED_VAR = "AI_REPORTS_ENABLED";
export const AI_WORKER_TOKEN_VAR = "AI_WORKER_TOKEN";
/** Actor pilot tạm thời (shared Basic Auth) — KHÔNG phải RBAC P3. */
export const PILOT_ACTOR_REF = "pilot-admin";

function envValue(name) {
  return envValueIn(process.env, name);
}

function envValueIn(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function intEnv(name) {
  const raw = envValue(name);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

export function isAiReportsEnabled() {
  return envValue(AI_REPORTS_ENABLED_VAR) === "true";
}

export function isProductionRuntime() {
  return process.env.NODE_ENV === "production";
}

/** Cấu hình provider: uỷ quyền cho module thuần (testable) — production/preview không bao giờ dùng scripted. */
export function readProviderConfig(env = process.env) {
  return resolveProviderConfig(env);
}

/** Policy: production bắt buộc khai báo; dev dùng mặc định kỹ thuật (không phải ngân sách tiền thật). */
export function readGatewayPolicy() {
  const source = {
    window_ms: intEnv("AI_POLICY_WINDOW_MS"),
    max_requests_per_window: intEnv("AI_POLICY_MAX_REQUESTS_PER_WINDOW"),
    max_concurrent_jobs: intEnv("AI_POLICY_MAX_CONCURRENT_JOBS"),
    max_attempts: intEnv("AI_POLICY_MAX_ATTEMPTS"),
    provider_timeout_ms: intEnv("AI_POLICY_PROVIDER_TIMEOUT_MS"),
    max_response_bytes: intEnv("AI_POLICY_MAX_RESPONSE_BYTES"),
    max_payload_bytes: intEnv("AI_POLICY_MAX_PAYLOAD_BYTES"),
    daily_token_ceiling: intEnv("AI_POLICY_DAILY_TOKEN_CEILING"),
  };
  const declared = REQUIRED_POLICY_KEYS.filter((key) => source[key] !== null).length;
  if (declared === 0 && !isProductionRuntime()) {
    return { ok: true, config: { ...DEFAULT_POLICY } };
  }
  const parsed = readPolicyConfig(source);
  if (!parsed.ok) return { ok: false, code: "AI_POLICY_REQUIRED", message: parsed.message };
  return { ok: true, config: parsed.config };
}

/**
 * Hash access scope của actor pilot (server-derived, KHÔNG nhận từ client).
 * Shared Basic Auth ⇒ một scope pilot duy nhất; P3 sẽ thay bằng RBAC thật.
 */
export function accessScopeHashFor(actorRef) {
  return canonicalHash({ pilot_actor_ref: actorRef, access_model: "pilot-shared-basic-auth", version: "1" });
}

/** Prompt manifest đang dùng (versioned, bất biến). */
export function currentPromptVersion() {
  return envValue("AI_PROMPT_VERSION") ?? DEFAULT_PROMPT_VERSION;
}

/** Token worker: uỷ quyền cho module thuần (constant-time, testable). */
export function checkWorkerToken(provided) {
  return checkWorkerTokenPure(provided, envValue(AI_WORKER_TOKEN_VAR));
}