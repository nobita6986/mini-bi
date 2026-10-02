/**
 * P1.5-W04A — Test double cho cổng provider config của gateway (mirror semantics store thật).
 *
 * - `active()`: version ACTIVE + VERIFIED cho enqueue gate; `active: null` ⇒ AI_CONFIG_REQUIRED.
 * - `material(id, version)`: trả credential ĐÃ giải mã của đúng (config_id, version); sai/tắt/lỗi ⇒ fail.
 * - `setVersion`: mô phỏng rotate (version mới) / disable (status) để test "job cũ không đổi config".
 */

export const FAKE_CONFIG_ID = "pilot-provider";
export const FAKE_CONFIG_VERSION = 1;

export function createMemoryProviderConfig(options = {}) {
  const configId = options.config_id ?? FAKE_CONFIG_ID;
  const defaultProfile = options.provider_profile ?? "scripted";
  const defaultModel = options.model ?? "scripted-deterministic-v1";
  const materials = options.materials ?? new Map([[FAKE_CONFIG_VERSION, {}]]);
  const calls = { active: 0, material: [] };
  const state = { active_version: options.active_version ?? FAKE_CONFIG_VERSION };

  function materialOf(version) {
    const stored = materials.get(version);
    if (!stored) return null;
    return {
      provider_profile: stored.provider_profile ?? defaultProfile,
      model: stored.model ?? defaultModel,
      status: stored.status ?? "active",
      secret: stored.secret ?? "test-secret",
      api_base_url: stored.api_base_url ?? "https://api.example.test/v1",
      sanitized_host: stored.sanitized_host ?? "api.example.test",
    };
  }

  return {
    calls,
    materials,
    setVersion(version, patch = {}) {
      materials.set(version, { ...(materials.get(version) ?? {}), ...patch });
    },
    /** Mô phỏng activate version mới: enqueue SAU đó sẽ đóng băng version mới, job cũ giữ version cũ. */
    setActiveVersion(version) {
      state.active_version = version;
    },
    async active() {
      calls.active += 1;
      if (options.activeFailure) {
        return { ok: false, code: options.activeFailure.code ?? "AI_CONFIG_REQUIRED", message: "không có config active (mô phỏng)" };
      }
      if (options.active === null) {
        return { ok: false, code: "AI_CONFIG_REQUIRED", message: "chưa có cấu hình provider active + verified" };
      }
      const material = materialOf(state.active_version);
      if (!material) return { ok: false, code: "AI_CONFIG_REQUIRED", message: "không có config active" };
      return {
        ok: true,
        config: {
          config_id: configId,
          version: state.active_version,
          provider_profile: material.provider_profile,
          model: material.model,
          sanitized_host: "api.example.test",
          verified_at: "2026-10-01T00:00:00.000Z",
        },
      };
    },
    async material(requestedId, requestedVersion) {
      calls.material.push({ config_id: requestedId, version: requestedVersion });
      if (options.materialFailure) {
        return { ok: false, code: options.materialFailure.code ?? "AI_CONFIG_REQUIRED", message: "không giải mã được credential (mô phỏng)" };
      }
      if (requestedId !== configId) return { ok: false, code: "AI_CONFIG_REQUIRED", message: "sai config_id đã đóng băng" };
      const material = materialOf(requestedVersion);
      if (!material) return { ok: false, code: "AI_CONFIG_REQUIRED", message: "không tìm thấy provider config đã đóng băng" };
      if (material.status === "disabled") return { ok: false, code: "AI_CONFIG_REQUIRED", message: "provider config đã bị tắt" };
      return {
        ok: true,
        value: {
          config_id: configId,
          version: requestedVersion,
          provider_profile: material.provider_profile,
          model: material.model,
          status: material.status,
          verified_at: "2026-10-01T00:00:00.000Z",
          secret: material.secret,
          api_base_url: material.api_base_url,
          sanitized_host: material.sanitized_host,
        },
      };
    },
  };
}
