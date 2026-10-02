import "server-only";

/**
 * P1.5-W04A — Store cấu hình provider (Supabase RPC, service-role, server boundary).
 *
 * - KHÔNG log/!trả secret, envelope hay URL đầy đủ ra ngoài server.
 * - Mọi mutation đi qua RPC `security definer` (mutation + audit CÙNG transaction).
 * - `material` giải mã envelope bằng keyring từ ENV; lỗi ⇒ `AI_CONFIG_REQUIRED`/`AI_DECRYPT_FAILED`.
 *
 * R1 (C) — READ TRUTHFULNESS: mọi hàm đọc trả kết quả PHÂN BIỆT được ba trạng thái:
 *   1. `{ ok:true, config: <giá trị> | null }`  — đọc thành công (null = KHÔNG có cấu hình);
 *   2. `{ ok:false, code }`                      — RPC từ chối hợp lệ (code do DB trả, đã sanitize);
 *   3. `{ ok:false, code:"AI_INTERNAL" }`         — lỗi DB/transport/malformed response.
 * Không bao giờ biến (2)/(3) thành `null` (không "not_configured" giả) và không trả raw Supabase error.
 */

import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { decryptSecret, tryKeyringFromEnvironment } from "../crypto-envelope.ts";
import { SecurityError } from "../errors.ts";
import {
  NO_ACTIVE_CONFIG_CODE,
  classifyRpcResponse,
  projectActiveConfig,
  sanitizeMessage,
} from "../read-result.ts";

function fail(code, message) {
  return { ok: false, code, message };
}

/**
 * Gọi RPC rồi CHUẨN HOÁ qua classifier chung (read-result.ts):
 * lỗi transport/DB & malformed ⇒ AI_INTERNAL; RPC từ chối hợp lệ ⇒ giữ code DB (sanitize).
 */
async function rpc(name, params, clientFactory = createServiceSupabaseClient) {
  let response;
  try {
    const client = clientFactory();
    response = await client.rpc(name, params);
  } catch {
    return fail("AI_INTERNAL", "rpc " + name + " không gọi được (transport)");
  }
  return classifyRpcResponse(name, response);
}

export { sanitizeMessage };

/** Row (jsonb từ Postgres) → domain ProviderConfig (envelope giữ nguyên dạng object). */
export function rowToConfig(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
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
      if (!result.ok) return result;
      const row = result.value.config;
      if (row === null || row === undefined) return { ok: true, config: null };
      const config = rowToConfig(row);
      if (!config) return fail("AI_INTERNAL", "rpc current trả config sai kiểu");
      return { ok: true, config };
    },

    async readVersion(id, version) {
      if (!Number.isSafeInteger(version) || version < 1) return fail("AI_INTERNAL", "version không hợp lệ");
      const result = await rpc("ai_provider_config_version", { p_config_id: id, p_version: version });
      if (!result.ok) return result;
      const row = result.value.config;
      if (row === null || row === undefined) return { ok: true, config: null };
      const config = rowToConfig(row);
      if (!config) return fail("AI_INTERNAL", "rpc version trả config sai kiểu");
      return { ok: true, config };
    },

    async readActiveProjection() {
      const result = await rpc("ai_provider_config_active", {});
      if (!result.ok) {
        // RPC từ chối "chưa có cấu hình active" là trạng thái HỢP LỆ (1); mọi lỗi khác là (3).
        if (result.code === NO_ACTIVE_CONFIG_CODE) return { ok: true, config: null };
        return result;
      }
      return projectActiveConfig(result.value);
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
      if (value.ok !== true) {
        return fail(
          typeof value.code === "string" && value.code !== "" ? value.code : "AI_INTERNAL",
          sanitizeMessage(value.message, "save thất bại")
        );
      }
      const saved = await this.readVersion(config.config_id, value.config?.version ?? config.version);
      if (!saved.ok) return saved;
      if (!saved.config) return fail("AI_INTERNAL", "không đọc lại được version vừa lưu");
      return { ok: true, config: saved.config };
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
      if (value.ok !== true) {
        return fail(
          typeof value.code === "string" && value.code !== "" ? value.code : "AI_INTERNAL",
          sanitizeMessage(value.message, "ghi kết quả test thất bại")
        );
      }
      const updated = await this.readVersion(config_id, version);
      if (!updated.ok) return updated;
      if (!updated.config) return fail("AI_INTERNAL", "không đọc lại được version sau test");
      return { ok: true, config: updated.config };
    },

    async activate({ config_id, version, actor }) {
      const result = await rpc("ai_provider_config_activate", {
        p_config_id: config_id,
        p_version: version,
        p_actor_ref: actor,
      });
      if (!result.ok) return result;
      const value = result.value;
      if (value.ok !== true) {
        return fail(
          typeof value.code === "string" && value.code !== "" ? value.code : "AI_INTERNAL",
          sanitizeMessage(value.message, "activate thất bại")
        );
      }
      const activated = await this.readVersion(config_id, version);
      if (!activated.ok) return activated;
      if (!activated.config) return fail("AI_INTERNAL", "không đọc lại được version sau activate");
      return { ok: true, config: activated.config };
    },

    async disable({ config_id, version, actor }) {
      const result = await rpc("ai_provider_config_disable", {
        p_config_id: config_id,
        p_version: version,
        p_actor_ref: actor,
      });
      if (!result.ok) return result;
      const value = result.value;
      if (value.ok !== true) {
        return fail(
          typeof value.code === "string" && value.code !== "" ? value.code : "AI_INTERNAL",
          sanitizeMessage(value.message, "disable thất bại")
        );
      }
      const disabled = await this.readVersion(config_id, version);
      if (!disabled.ok) return disabled;
      if (!disabled.config) return fail("AI_INTERNAL", "không đọc lại được version sau disable");
      return { ok: true, config: disabled.config };
    },

    async recordRejected({ config_id, version, actor, reason_code }) {
      // Audit-only: lỗi ở đây KHÔNG được che kết quả mutation chính (caller đã có code cụ thể).
      await rpc("ai_provider_config_rejected", {
        p_config_id: config_id,
        p_version: version,
        p_actor_ref: actor,
        p_reason_code: reason_code,
      });
      return { ok: true };
    },

    /**
     * Material cho WORKER: giải mã credential của ĐÚNG (config_id, version) đã đóng băng trong job.
     * Lỗi thiếu key ⇒ AI_CONFIG_REQUIRED (fail-closed); envelope hỏng/tamper ⇒ AI_DECRYPT_FAILED;
     * lỗi DB/transport ⇒ AI_INTERNAL (KHÔNG biến thành AI_CONFIG_REQUIRED).
     */
    async material(config_id, version) {
      const read = await this.readVersion(config_id, version);
      if (!read.ok) return read;
      if (!read.config) return fail("AI_CONFIG_REQUIRED", "không tìm thấy provider config đã đóng băng");
      const row = read.config;
      if (row.status === "disabled") return fail("AI_CONFIG_REQUIRED", "provider config đã bị tắt");
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
