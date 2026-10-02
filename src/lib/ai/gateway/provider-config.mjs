/**
 * P1.5-W04-R1 — Quyết định provider theo môi trường (THUẦN, testable; không đọc process.env trực tiếp).
 *
 * Fail-closed:
 * - preview/production: scripted TUYỆT ĐỐI không được dùng; thiếu live config đã duyệt ⇒ AI_CONFIG_REQUIRED;
 *   live chưa tích hợp ở W04-R1 (W04A là authority) ⇒ AI_PROVIDER_DISABLED.
 * - test/development: scripted chỉ khi được bật RÕ RÀNG (AI_PROVIDER_KEY=scripted); test có thể inject adapter trực tiếp.
 */

export const PROVIDER_KEYS = Object.freeze(["scripted", "live"]);

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

/**
 * @returns {{ ok:true, provider_key:string, model_key:string } | { ok:false, code:string, message:string }}
 */
export function resolveProviderConfig(env) {
  const providerKey = readEnv(env, "AI_PROVIDER_KEY");
  const modelKey = readEnv(env, "AI_MODEL_KEY");

  if (isProductionLikeRuntime(env)) {
    if (providerKey === "scripted") {
      return { ok: false, code: "AI_PROVIDER_DISABLED", message: "scripted provider bị cấm ngoài test/development" };
    }
    if (providerKey === null) {
      return { ok: false, code: "AI_CONFIG_REQUIRED", message: "thiếu AI_PROVIDER_KEY: production cần live provider đã duyệt (G4A)" };
    }
    if (providerKey === "live") {
      return { ok: false, code: "AI_PROVIDER_DISABLED", message: "live provider chưa được cấu hình/duyệt (W04A, chờ G4A)" };
    }
    return { ok: false, code: "AI_CONFIG_REQUIRED", message: "provider_key không được hỗ trợ" };
  }

  if (providerKey === "live") {
    return { ok: false, code: "AI_PROVIDER_DISABLED", message: "live provider chưa được bật (chờ G4A)" };
  }
  if (providerKey !== "scripted") {
    return { ok: false, code: "AI_CONFIG_REQUIRED", message: "thiếu AI_PROVIDER_KEY=scripted (chỉ cho test/development)" };
  }
  return { ok: true, provider_key: "scripted", model_key: modelKey ?? "scripted-deterministic-v1" };
}
