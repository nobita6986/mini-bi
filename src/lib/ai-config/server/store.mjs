import "server-only";

/**
 * P1.5-W04A — Store cấu hình provider (Supabase RPC, service-role, server boundary).
 *
 * - KHÔNG log/!trả secret, envelope hay URL đầy đủ ra ngoài server.
 * - Mọi mutation đi qua RPC `security definer` (mutation + audit CÙNG transaction).
 * - `material` giải mã envelope bằng keyring từ ENV; lỗi ⇒ `AI_CONFIG_REQUIRED`/`AI_DECRYPT_FAILED`.
 */

import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { decryptSecret, tryKeyringFromEnvironment } from "../crypto-envelope.ts";
import { SecurityError } from "../errors.ts";

function fail(code, message) {
  return { ok: false, code, message };
}

async function rpc(name, params) {
  const client = createServiceSupabaseClient();
  const { data, error } = await client.rpc(name, params);
  if (error) {
    // Không bao giờ trả raw DB error ra ngoài.
    return { ok: false, code: "AI_INTERNAL", message: "rpc " + name + " thất bại" };
  }
  if (!data || typeof data !== "object") {
    return fail("AI_INTERNAL", "rpc " + name + " trả dữ liệu rỗng");
  }
  return { ok: true, value: data };
}

/** Row (jsonb từ Postgres) → domain ProviderConfig (envelope giữ nguyên dạng object). */
export function rowToConfig(row) {
  if (!row || typeof row !== "object") return null;
  return {
    config_id: row.config_id,
    provider_profile: row.provider_profile,
    api_base_url: row.api_base_url,
    model: row.model,
    encrypted_secret: row.envelope,
    version: row.version,
    status: row.status,
    verified_at: row.verified_at ?? null,
    updated_at: row.updated_at,
    sanitized_host: row.sanitized_host,
    key_fingerprint: row.key_fingerprint,
    optimistic_version: row.optimistic_version,
  };
}

export function createSupabaseProviderConfigStore(options = {}) {
  const configId = options.config_id ?? "pilot-provider";
  const env = options.env ?? process.env;

  return {
    async readCurrent(id = configId) {
      const result = await rpc("ai_provider_config_current", { p_config_id: id });
      if (!result.ok) return null;
      return rowToConfig(result.value.config);
    },

    async readVersion(id, version) {
      const result = await rpc("ai_provider_config_version", { p_config_id: id, p_version: version });
      if (!result.ok) return null;
      return rowToConfig(result.value.config);
    },

    async readActiveProjection() {
      const result = await rpc("ai_provider_config_active", {});
      if (!result.ok) return null;
      if (result.value.ok !== true) return null;
      return {
        config_id: result.value.config_id,
        provider_profile: result.value.provider_profile,
        model: result.value.model,
        version: result.value.version,
        status: "active",
        verified_at: result.value.verified_at ?? null,
        sanitized_host: result.value.sanitized_host,
      };
    },

    async saveVersion({ expected_version, config, actor, action }) {
      const result = await rpc("ai_provider_config_save", {
        p_config_id: config.config_id,
        p_expected_version: expected_version,
        p_provider_profile: config.provider_profile,
        p_api_base_url: config.api_base_url,
        p_sanitized_host: config.sanitized_host,
        p_model: config.model,
        p_envelope: config.encrypted_secret,
        p_key_fingerprint: config.key_fingerprint,
        p_actor_ref: actor,
        p_action: action,
      });
      if (!result.ok) return result;
      const value = result.value;
      if (value.ok !== true) return fail(value.code ?? "AI_INTERNAL", value.message ?? "save thất bại");
      const saved = await this.readVersion(config.config_id, value.config?.version ?? config.version);
      if (!saved) return fail("AI_INTERNAL", "không đọc lại được version vừa lưu");
      return { ok: true, config: saved };
    },

    async recordTest({ config_id, version, success, actor, reason_code }) {
      const result = await rpc("ai_provider_config_test_result", {
        p_config_id: config_id,
        p_version: version,
        p_success: success,
        p_reason_code: reason_code,
        p_actor_ref: actor,
      });
      if (!result.ok) return result;
      const value = result.value;
      if (value.ok !== true) return fail(value.code ?? "AI_INTERNAL", value.message ?? "ghi kết quả test thất bại");
      const updated = await this.readVersion(config_id, version);
      if (!updated) return fail("AI_INTERNAL", "không đọc lại được version sau test");
      return { ok: true, config: updated };
    },

    async activate({ config_id, version, actor }) {
      const result = await rpc("ai_provider_config_activate", {
        p_config_id: config_id,
        p_version: version,
        p_actor_ref: actor,
      });
      if (!result.ok) return result;
      const value = result.value;
      if (value.ok !== true) return fail(value.code ?? "AI_INTERNAL", value.message ?? "activate thất bại");
      const activated = await this.readVersion(config_id, version);
      if (!activated) return fail("AI_INTERNAL", "không đọc lại được version sau activate");
      return { ok: true, config: activated };
    },

    async disable({ config_id, version, actor }) {
      const result = await rpc("ai_provider_config_disable", {
        p_config_id: config_id,
        p_version: version,
        p_actor_ref: actor,
      });
      if (!result.ok) return result;
      const value = result.value;
      if (value.ok !== true) return fail(value.code ?? "AI_INTERNAL", value.message ?? "disable thất bại");
      const disabled = await this.readVersion(config_id, version);
      if (!disabled) return fail("AI_INTERNAL", "không đọc lại được version sau disable");
      return { ok: true, config: disabled };
    },

    async recordRejected({ config_id, version, actor, reason_code }) {
      await rpc("ai_provider_config_rejected", {
        p_config_id: config_id,
        p_version: version,
        p_actor_ref: actor,
        p_reason_code: reason_code,
      });
    },

    /**
     * Material cho WORKER: giải mã credential của ĐÚNG (config_id, version) đã đóng băng trong job.
     * Lỗi thiếu key ⇒ AI_CONFIG_REQUIRED; envelope hỏng/tamper ⇒ AI_DECRYPT_FAILED. KHÔNG fallback.
     */
    async material(config_id, version) {
      const row = await this.readVersion(config_id, version);
      if (!row) return fail("AI_CONFIG_REQUIRED", "không tìm thấy provider config đã đóng băng");
      if (row.status === "disabled") {
        return fail("AI_CONFIG_REQUIRED", "provider config đã bị tắt");
      }
      const keyring = tryKeyringFromEnvironment(env, options.previous_keys ?? new Map());
      if (!keyring.ok) return fail(keyring.code, keyring.message);
      try {
        const secret = decryptSecret(row.encrypted_secret, {
          config_id: row.config_id,
          provider_profile: row.provider_profile,
          config_version: row.version,
          api_base_url: row.api_base_url,
          model: row.model,
        }, keyring.keyring);
        return {
          ok: true,
          value: {
            config_id: row.config_id,
            version: row.version,
            provider_profile: row.provider_profile,
            model: row.model,
            status: row.status,
            verified_at: row.verified_at,
            secret,
          },
        };
      } catch (error) {
        const code = error instanceof SecurityError && error.code === "CONFIGURATION"
          ? "AI_CONFIG_REQUIRED"
          : "AI_DECRYPT_FAILED";
        return fail(code, "không giải mã được provider credential");
      }
    },
  };
}
