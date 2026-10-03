/**
 * P1.5-W04-R1 / I02 — Quyết định provider theo môi trường (THUẦN, testable; không đọc process.env trực tiếp).
 *
 * Fail-closed:
 * - preview/production: scripted TUYỆT ĐỐI không được dùng; thiếu live config đã duyệt ⇒ AI_CONFIG_REQUIRED.
 * - live CHỈ được chọn khi AI_PROVIDER_KEY=live VÀ AI_PROVIDER_ALLOWED_HOSTS hợp lệ + không rỗng.
 *   Các điều kiện còn lại (AI_REPORTS_ENABLED, outbound wiring, frozen config active+verified,
 *   profile/model/version khớp, policy hợp lệ) được kiểm ở route/service/worker — thiếu ⇒ fail closed trước outbound.
 * - test/development: scripted chỉ khi được bật RÕ RÀNG (AI_PROVIDER_KEY=scripted); test có thể inject adapter trực tiếp.
 */

export const PROVIDER_KEYS = Object.freeze(["scripted", "live"]);

const HOST_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

function readEnv(env, name) {
  const value = env?.[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** true khi runtime là production/preview (không bao giờ cho scripted). */
export function isProductionLikeRuntime(env) {
  const runtime = typeof env?.NODE_ENV === "string" ? env.NODE_ENV : "development";
  const vercelEnv = typeof env?.VERCEL_ENV === "string" ? env.VERCEL_ENV : null;
  return runtime === "production" || vercelEnv === "production" || vercelEnv === "preview";
}

/** Parse + validate AI_PROVIDER_ALLOWED_HOSTS (hostname, không scheme/path/port). Trả null nếu rỗng/sai. */
export function readAllowedHosts(env) {
  const raw = env?.AI_PROVIDER_ALLOWED_HOSTS;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const hosts = raw.split(",").map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) return null;
  if (hosts.some((h) => !HOST_PATTERN.test(h))) return null;
  return hosts;
}

/**
 * @returns {{ ok:true, provider_key:string, model_key:string } | { ok:false, code:string, message:string }}
 */
export function resolveProviderConfig(env) {
  const providerKey = readEnv(env, "AI_PROVIDER_KEY");
  const modelKey = readEnv(env, "AI_MODEL_KEY");
  const allowedHosts = readAllowedHosts(env);

  if (isProductionLikeRuntime(env)) {
    if (providerKey === "scripted") {
      return { ok: false, code: "AI_PROVIDER_DISABLED", message: "scripted provider bị cấm ngoài test/development" };
    }
    if (providerKey === null) {
      return { ok: false, code: "AI_CONFIG_REQUIRED", message: "thiếu AI_PROVIDER_KEY: production cần live provider đã duyệt" };
    }
    if (providerKey === "live") {
      if (allowedHosts === null) {
        return { ok: false, code: "AI_CONFIG_REQUIRED", message: "thiếu/không hợp lệ AI_PROVIDER_ALLOWED_HOSTS (live cần allowlist)" };
      }
      return { ok: true, provider_key: "live", model_key: modelKey ?? "" };
    }
    return { ok: false, code: "AI_CONFIG_REQUIRED", message: "provider_key không được hỗ trợ" };
  }

  if (providerKey === "live") {
    if (allowedHosts === null) {
      return { ok: false, code: "AI_CONFIG_REQUIRED", message: "thiếu/không hợp lệ AI_PROVIDER_ALLOWED_HOSTS (live cần allowlist)" };
    }
    return { ok: true, provider_key: "live", model_key: modelKey ?? "" };
  }
  if (providerKey !== "scripted") {
    return { ok: false, code: "AI_CONFIG_REQUIRED", message: "thiếu AI_PROVIDER_KEY=scripted (chỉ cho test/development)" };
  }
  return { ok: true, provider_key: "scripted", model_key: modelKey ?? "scripted-deterministic-v1" };
}
