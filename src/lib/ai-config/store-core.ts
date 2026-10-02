import "server-only";

/**
 * P1.5-W04A-R2 — CORE của provider-config store (thuần, DI): mọi logic đọc/ghi + validate nằm ở đây,
 * `server/store.mjs` chỉ bơm Supabase client + keyring từ env.
 *
 * Nhờ vậy Supabase thật và test double đi qua CÙNG một projection/validate rule, và core test được
 * bằng Node với một RPC giả (không cần DB).
 *
 * R2 (A): envelope success CHỈ hợp lệ khi `ok === true` tường minh.
 * R2 (B): `config` phải tường minh (null = chưa cấu hình); thiếu/undefined/malformed ⇒ AI_INTERNAL.
 * R2 (C): audit rejection phải trả ĐÚNG kết quả RPC (không nuốt lỗi).
 */

import type { ProviderConfig } from "./config-contract.ts";
import { decryptSecret, type Keyring } from "./crypto-envelope.ts";
import { SecurityError } from "./errors.ts";
import {
  NO_ACTIVE_CONFIG_CODE,
  classifyRpcResponse,
  internalFail,
  projectActiveConfig,
  sanitizeMessage,
  validateConfigRow,
  type ActiveConfigProjection,
  type RpcFail,
} from "./read-result.ts";

export type { ActiveConfigProjection, RpcFail } from "./read-result.ts";

export type StoreFail = RpcFail;
export type StoreOk<T> = { ok: true; config: T | null };
export type StoreRead<T> = StoreOk<T> | StoreFail;
export type StoreMutation = { ok: true; config: ProviderConfig } | StoreFail;

export type MaterialResult =
  | {
      ok: true;
      value: {
        config_id: string;
        version: number;
        provider_profile: string;
        model: string;
        status: string;
        verified_at: string | null;
        secret: string;
      };
    }
  | StoreFail;

/** Hợp đồng store mà settings-service/gateway dùng (cả Supabase thật và test double). */
export type ConfigStore = {
  readCurrent(configId: string): Promise<StoreRead<ProviderConfig>>;
  readVersion(configId: string, version: number): Promise<StoreRead<ProviderConfig>>;
  readActiveProjection(): Promise<StoreRead<ActiveConfigProjection>>;
  saveVersion(input: {
    expected_version: number | null;
    config: ProviderConfig;
    actor: string;
    action: "config_created" | "credential_rotated";
  }): Promise<StoreMutation>;
  recordTest(input: {
    config_id: string;
    version: number;
    success: boolean;
    actor: string;
    reason_code: string;
  }): Promise<StoreMutation>;
  activate(input: { config_id: string; version: number; actor: string }): Promise<StoreMutation>;
  disable(input: { config_id: string; version: number; actor: string }): Promise<StoreMutation>;
  /** Audit-only: PHẢI trả đúng kết quả RPC (R2-C) để caller không tuyên bố audit đã ghi khi thất bại. */
  recordRejected(input: {
    config_id: string;
    version: number;
    actor: string;
    reason_code: string;
  }): Promise<{ ok: true } | StoreFail>;
  /** Material cho WORKER: giải mã credential của ĐÚNG (config_id, version) đã đóng băng. */
  material(configId: string, version: number): Promise<MaterialResult>;
};

export type RawRpc = (name: string, params: Record<string, unknown>) => Promise<unknown>;
export type KeyringProvider = () => { ok: true; keyring: Keyring } | { ok: false; code: string; message: string };

/** Một mutation RPC chỉ thành công khi envelope `ok === true`; ngược lại giữ code DB đã sanitize. */
function mutationResult(name: string, value: Record<string, unknown>): { ok: true } | StoreFail {
  if (value.ok !== true) {
    return internalFail(name, "trả shape không hợp lệ");
  }
  return { ok: true };
}

function codeFrom(value: Record<string, unknown>): string {
  return typeof value.code === "string" && value.code !== "" ? value.code : "AI_INTERNAL";
}

export function createProviderConfigStoreCore(options: {
  rpc: RawRpc;
  keyring: KeyringProvider;
  config_id?: string;
}) {
  const configId = options.config_id ?? "pilot-provider";

  async function call(name: string, params: Record<string, unknown>) {
    let response: unknown;
    try {
      response = await options.rpc(name, params);
    } catch {
      return internalFail(name, "không gọi được (transport)");
    }
    return classifyRpcResponse(name, response);
  }

  async function readConfigRow(name: string, params: Record<string, unknown>) {
    const result = await call(name, params);
    if (!result.ok) return result;
    return validateConfigRow(name, result.value);
  }

  const store: ConfigStore = {
    async readCurrent(id = configId) {
      return readConfigRow("ai_provider_config_current", { p_config_id: id });
    },

    async readVersion(id, version) {
      if (!Number.isSafeInteger(version) || version < 1) return internalFail("ai_provider_config_version", "version không hợp lệ");
      return readConfigRow("ai_provider_config_version", { p_config_id: id, p_version: version });
    },

    async readActiveProjection() {
      const result = await call("ai_provider_config_active", {});
      if (!result.ok) {
        // RPC từ chối "chưa có cấu hình active" là trạng thái HỢP LỆ (không cấu hình); mọi lỗi khác là hạ tầng.
        if (result.code === NO_ACTIVE_CONFIG_CODE) return { ok: true, config: null };
        return result;
      }
      return projectActiveConfig(result.value);
    },

    async saveVersion({ expected_version, config, actor, action }) {
      const result = await call("ai_provider_config_save", {
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
        return { ok: false, code: codeFrom(value), message: sanitizeMessage(value.message, "save thất bại") };
      }
      const saved = await store.readVersion(config.config_id, typeof value.config === "object" && value.config !== null
        ? ((value.config as Record<string, unknown>).version as number)
        : config.version);
      if (!saved.ok) return saved;
      if (!saved.config) return internalFail("ai_provider_config_save", "không đọc lại được version vừa lưu");
      return { ok: true, config: saved.config };
    },

    async recordTest({ config_id, version, success, actor, reason_code }) {
      const result = await call("ai_provider_config_test_result", {
        p_config_id: config_id,
        p_version: version,
        p_success: success,
        p_reason_code: reason_code,
        p_actor_ref: actor,
      });
      if (!result.ok) return result;
      const value = result.value;
      if (value.ok !== true) {
        return { ok: false, code: codeFrom(value), message: sanitizeMessage(value.message, "ghi kết quả test thất bại") };
      }
      const updated = await store.readVersion(config_id, version);
      if (!updated.ok) return updated;
      if (!updated.config) return internalFail("ai_provider_config_test_result", "không đọc lại được version sau test");
      return { ok: true, config: updated.config };
    },

    async activate({ config_id, version, actor }) {
      const result = await call("ai_provider_config_activate", {
        p_config_id: config_id,
        p_version: version,
        p_actor_ref: actor,
      });
      if (!result.ok) return result;
      const value = result.value;
      if (value.ok !== true) {
        return { ok: false, code: codeFrom(value), message: sanitizeMessage(value.message, "activate thất bại") };
      }
      const activated = await store.readVersion(config_id, version);
      if (!activated.ok) return activated;
      if (!activated.config) return internalFail("ai_provider_config_activate", "không đọc lại được version sau activate");
      return { ok: true, config: activated.config };
    },

    async disable({ config_id, version, actor }) {
      const result = await call("ai_provider_config_disable", {
        p_config_id: config_id,
        p_version: version,
        p_actor_ref: actor,
      });
      if (!result.ok) return result;
      const value = result.value;
      if (value.ok !== true) {
        return { ok: false, code: codeFrom(value), message: sanitizeMessage(value.message, "disable thất bại") };
      }
      const disabled = await store.readVersion(config_id, version);
      if (!disabled.ok) return disabled;
      if (!disabled.config) return internalFail("ai_provider_config_disable", "không đọc lại được version sau disable");
      return { ok: true, config: disabled.config };
    },

    /** R2 (C): trả ĐÚNG kết quả RPC — không nuốt lỗi audit. */
    async recordRejected({ config_id, version, actor, reason_code }) {
      const result = await call("ai_provider_config_rejected", {
        p_config_id: config_id,
        p_version: version,
        p_actor_ref: actor,
        p_reason_code: reason_code,
      });
      if (!result.ok) return result;
      const checked = mutationResult("ai_provider_config_rejected", result.value);
      if (!checked.ok) return checked;
      if (result.value.ok !== true) {
        return { ok: false, code: codeFrom(result.value), message: sanitizeMessage(result.value.message, "ghi audit thất bại") };
      }
      return { ok: true };
    },

    async material(config_id, version) {
      const read = await store.readVersion(config_id, version);
      if (!read.ok) return read;
      if (!read.config) return { ok: false, code: "AI_CONFIG_REQUIRED", message: "không tìm thấy provider config đã đóng băng" };
      const row = read.config;
      if (row.status === "disabled") return { ok: false, code: "AI_CONFIG_REQUIRED", message: "provider config đã bị tắt" };
      const keyring = options.keyring();
      if (!keyring.ok) return { ok: false, code: keyring.code, message: keyring.message };
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
        return { ok: false, code, message: "không giải mã được provider credential" };
      }
    },
  };

  return store;
}
