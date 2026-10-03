/**
 * Bridge StoreRead<ActiveConfigProjection> sang hợp đồng providerConfig.active() của gateway.
 * Không được bọc cả envelope `{ ok, config }` vào `config`, vì enqueue cần trực tiếp
 * `{ config_id, version, ... }` để đóng băng provider config vào job.
 */
export function activeProviderConfigForGateway(result) {
  if (!result || typeof result !== "object") {
    return { ok: false, code: "AI_INTERNAL", message: "không đọc được provider config active" };
  }
  if (result.ok !== true) {
    return {
      ok: false,
      code: typeof result.code === "string" && result.code !== "" ? result.code : "AI_INTERNAL",
      message: "không đọc được provider config active",
    };
  }
  if (!result.config) {
    return { ok: false, code: "AI_CONFIG_REQUIRED", message: "chưa có cấu hình provider active + verified" };
  }
  return { ok: true, config: result.config };
}
